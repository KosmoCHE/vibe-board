// The board: keeps the data fresh, owns what is shown, and lays out the panel.

import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { BoardData, Host, Item, Settings, Tab } from "./host";
import { Inspector } from "./Inspector";
import { lasting, List, reveal, StuckHeading } from "./List";
import type { Stuck } from "./List";
import { dueDay, model, projectPath } from "./model";
import type { Model } from "./model";
import { BoardContext, closesOnLeave, controlStyle, Icon, Link, onRightClick, Select, StatusIcon, T, Tint, useBoard } from "./parts";
import type { Ctx, Option, Ui } from "./parts";
import { SettingsDialog } from "./Settings";

const UNDO_DEPTH = 20;
const TABS: [Tab, string][] = [
  ["global", "Global"],
  ["project", "Project"],
  ["session", "Session"],
];

type Undo = { id: string; title: string } & ({ fields: Partial<Item> } | { restore: true });
/** An item's menu: where it was asked for, and the board's own size, both in the board's frame. */
type MenuAt = { item: Item; x: number; y: number; width: number; height: number };

export function Board({ host }: { host: Host }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [ui, setUi] = useState<Ui>(() => ({
    ...host.prefs,
    showDone: {},
    filter: "",
    only: null,
    selected: null,
    editing: false,
    adding: false,
    addParent: null,
    settings: false,
    needsDue: null,
  }));
  const [down, setDown] = useState(false); // the server is unreachable; what is shown is stale
  const [message, setMessage] = useState({ text: "", error: false });
  const [undos, setUndos] = useState<Undo[]>([]);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const root = useRef<View>(null);
  // Scrolling the list to a row: the rows on screen, the list's content, how tall its window is,
  // and the item to bring into view once the change that shows it has rendered.
  const rows = useRef(new Map<string, View>());
  const scroller = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const seen = useRef(0);
  const scrollTo = useRef<string | null>(null);
  const stuck = useRef<Stuck>({ heads: [], y: 0, redraw: null });
  const sync = useRef({
    host,
    polling: false,
    again: false, // a change landed while a poll was under way
    version: null as string | null, // of the board that is shown; null: fetch it whatever the server says
    focus: undefined as string | null | undefined,
    at: null as Date | null,
  });
  sync.current.host = host;

  const notice = (text: string) => setMessage({ text, error: false });
  const showError = (e: unknown) => {
    const text = e instanceof Error ? e.message : String(e);
    // While the server is away the same failure comes back every second: that is no news.
    setMessage((now) => (now.error && now.text === text ? now : { text, error: true }));
  };

  // `changed`: something was just written, so a poll already under way may have missed it.
  async function poll(changed = false) {
    const s = sync.current;
    if (s.polling) {
      s.again = s.again || changed;
      return;
    }
    s.polling = true;
    try {
      // Nothing shown yet, or what is shown is not trusted: fetch the board straight away, as it
      // carries its own version. Otherwise ask the version first, which is cheap.
      const latest = s.version === null ? null : ((await s.host.request("GET", "/api/version")) as { version: string; focus: string | null });
      if (!latest || latest.version !== s.version) {
        const fresh = (await s.host.request("GET", "/api/board")) as BoardData;
        setBoard(fresh);
        s.version = fresh.version;
        s.focus = fresh.focus.pane;
        setMessage((now) => (now.error ? { text: "", error: false } : now));
      } else if (latest.focus !== s.focus) {
        // Only the pane being looked at changed: nothing to fetch.
        setBoard((now) => now && { ...now, focus: { pane: latest.focus } });
        s.focus = latest.focus;
      }
      s.at = new Date();
      setDown(false);
    } catch (e) {
      s.version = null;
      setDown(true);
      showError(e);
    } finally {
      s.polling = false;
      if (s.again) {
        s.again = false;
        poll();
      }
    }
  }

  useEffect(() => {
    poll();
    const timer = setInterval(() => poll(), 1000);
    return () => clearInterval(timer);
  }, []);

  const m = useMemo(() => board && model(board, host), [board, host.beside, host.project]);
  const filters = useMemo(() => (m ? filterOptions(m) : []), [m]);

  const remembered = useRef(false);
  useEffect(() => {
    if (remembered.current) host.savePrefs({ tab: ui.tab, open: m ? lasting(ui.open, m) : ui.open });
    remembered.current = true;
  }, [ui.tab, ui.open]);

  // Every change goes through here: refused while the server is away, followed by a
  // refresh, and a failure is shown rather than thrown. `done` gets the server's reply.
  // Resolves to whether the change went through.
  async function write(method: "POST" | "PATCH", path: string, body?: unknown, done?: (reply: unknown) => void) {
    try {
      if (down) throw new Error("看板已断线，请等待重新连接后再修改任务");
      const reply = await host.request(method, path, body);
      done?.(reply);
    } catch (e) {
      showError(e);
      return false;
    }
    await poll(true);
    return true;
  }

  function remember(undo: Undo) {
    setUndos((stack) => [...stack, undo].slice(-UNDO_DEPTH));
  }

  function patch(id: string, fields: Partial<Item>, undoable = true) {
    const before = m!.byId[id];
    return write("PATCH", "/api/items/" + id, fields, (reply) => {
      const item = reply as Item;
      // Show it at once; the refresh that follows brings whatever else the change touched.
      setBoard((now) => now && { ...now, items: now.items.map((i) => (i.id === id ? item : i)) });
      if (undoable && before) {
        const previous: Record<string, unknown> = {};
        for (const key of Object.keys(fields) as (keyof Item)[]) previous[key] = before[key];
        remember({ id, fields: previous, title: before.title });
        notice(`Changed “${before.title}”`);
      }
    });
  }

  // Delete is archive: the files move aside, and Undo brings them back.
  function remove(item: Item) {
    return write("POST", `/api/items/${item.id}/archive`, undefined, (reply) => {
      const ids = reply as string[];
      remember({ id: item.id, restore: true, title: item.title });
      setUi((now) => (now.selected === item.id ? { ...now, selected: null, editing: false } : now));
      notice(`Deleted “${item.title}”` + (ids.length > 1 ? ` and ${ids.length - 1} steps` : "") + " — Undo brings it back");
    });
  }

  async function undo() {
    const last = undos[undos.length - 1];
    if (!last) return;
    setUndos((stack) => stack.slice(0, -1));
    const restore = "restore" in last;
    const went = restore ? await write("POST", `/api/items/${last.id}/restore`) : await patch(last.id, last.fields, false);
    if (went) notice(restore ? `Restored “${last.title}”` : `Undid the change to “${last.title}”`);
    else remember(last); // refused, or lost on the way: the reason stays shown and it can be tried again
  }

  function add(title: string, project: string) {
    const parent = ui.addParent;
    const fields = {
      title,
      project,
      parent,
      origin: "plan",
      created_by: board!.me,
      driver: ui.tab === "session" ? m!.focus.sessions[0] : null, // the newest session here
    };
    return write("POST", "/api/items", fields, () => {
      if (parent) set((now) => reveal(now, m!, m!.byId[parent], true)); // show what was just added
      notice(`Added “${title}”`);
    });
  }

  function changeSetting(change: Partial<Settings>, said: string) {
    return write("PATCH", "/api/settings", change, () => notice(said));
  }

  const set: Ctx["set"] = (changeOf) => setUi((now) => ({ ...now, ...changeOf(now) }));

  function select(id: string | null, edit = false) {
    set((now) => {
      const item = id ? m!.byId[id] : null;
      return { ...(item ? reveal(now, m!, item, false) : {}), selected: id, editing: Boolean(id) && edit, needsDue: null };
    });
  }

  // High priority needs a due date. Without one, the editor opens on the date and
  // saves the date and the priority together; until then nothing is written.
  function markHigh(item: Item) {
    if (item.due) patch(item.id, { priority: "high" });
    else set((now) => ({ ...reveal(now, m!, item, false), selected: item.id, editing: true, needsDue: item.id }));
  }

  // Show an item wherever it is: switch to Global if the current tab cannot see it,
  // unfold what hides it, then select it.
  function jumpTo(item: Item) {
    set((now) => {
      const seen = m!.scopeItems(now).some((i) => i.id === item.id);
      const next: Ui = seen ? now : { ...now, tab: "global", filter: "" };
      return { ...next, ...reveal(next, m!, item, true), selected: item.id, editing: false, needsDue: null };
    });
  }

  // Selects the item and scrolls the list to it, a third of the way down.
  function showInList(item: Item) {
    scrollTo.current = item.id;
    jumpTo(item);
  }
  useEffect(() => {
    const id = scrollTo.current;
    scrollTo.current = null;
    const row = id && rows.current.get(id);
    if (row && content.current) row.measureLayout(content.current, (_x, y) => scroller.current?.scrollTo({ y: Math.max(0, y - seen.current / 3), animated: true }));
    placeHeadings();
  });

  // Where Global's headings are, for the one kept at the top: after every change, and when the
  // list's width changes and lines may wrap. Scrolling moves none of them.
  function placeHeadings() {
    const box = content.current;
    if (!box) return;
    const heads = [...rows.current].filter(([key]) => key.startsWith("h:"));
    const placed = heads.map(
      ([key, view]) => new Promise<Stuck["heads"][number]>((done) => view.measureLayout(box, (x, y, _w, h) => done({ path: key.slice(2), x, bottom: y + h }))),
    );
    Promise.all(placed).then((at) => {
      stuck.current.heads = at.sort((a, b) => a.bottom - b.bottom);
      stuck.current.redraw?.();
    });
  }

  function jumpToDriver(item: Item) {
    const where = m!.paneOf(item.driver!);
    if (where && where.alive) host.jump(where).catch(showError);
    else select(item.id, true); // the session is gone: pick another driver in the editor
  }

  function copy(text: string, said: string) {
    host.copyText(text).then(() => notice(said), showError);
  }
  const copyTitle = (item: Item) => copy(item.title, "Copied the title");

  function openMenu(item: Item, x: number, y: number) {
    root.current?.measureInWindow((left, top, width, height) => setMenu({ item, x: x - left, y: y - top, width, height }));
  }

  const commands = useRef({ undo, escape() {} });
  commands.current = {
    undo,
    escape() {
      if (ui.selected) select(ui.editing ? ui.selected : null);
    },
  };
  useEffect(
    () => host.shortcuts?.({ undo: () => commands.current.undo(), escape: () => commands.current.escape() }),
    [],
  );

  const c = host.colors;
  if (!board || !m) {
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0, padding: 9 }}>
        {/* Nothing has arrived yet: say why. */}
        {message.error && <Text style={{ fontSize: 11, color: c.statusDanger }}>{message.text}</Text>}
      </View>
    );
  }

  // What the remembered state points at may be gone.
  const filter = filters.some((o) => o.value === ui.filter) ? ui.filter : "";
  const only = ui.only && m.focus.sessions.includes(ui.only) ? ui.only : null;
  const items = m.scopeItems({ tab: ui.tab, filter, only });
  const selected = items.some((i) => i.id === ui.selected) ? ui.selected : null;
  const editing = Boolean(selected) && ui.editing;
  const shown: Ui = { ...ui, filter, only, selected, editing, needsDue: editing && ui.needsDue === selected ? ui.needsDue : null };
  const scale = (board.settings?.text_size ?? 100) / 100; // a server from before the setting does not report it
  const scaled = (n: number) => Math.round(n * scale);
  const trackRow = (id: string, row: View | null) => (row ? rows.current.set(id, row) : rows.current.delete(id));
  const ctx: Ctx = { host, c, m, ui: shown, scaled, set, patch, remove, select, jumpTo, jumpToDriver, markHigh, trackRow, copyTitle, openMenu };
  const canAdd = ui.tab === "global" ? Object.keys(board.projects).length > 0 : m.focus.projects.length > 0;

  return (
    <BoardContext.Provider value={ctx}>
      <View ref={root} style={{ flex: 1, backgroundColor: c.surface0 }}>
        {down && (
          <View accessibilityRole="alert" style={{ padding: 9, backgroundColor: c.statusWarning }}>
            <T weight="600" color={c.surface0}>
              {"看板连接已断开，正在重连。当前显示的是旧数据" +
                (sync.current.at ? `（最后同步 ${sync.current.at.toLocaleTimeString()}）` : "") +
                "。"}
            </T>
          </View>
        )}
        <Header canAdd={canAdd && !down} filters={filters} />
        <View style={{ flex: 1, pointerEvents: down ? "none" : "auto" }}>
          {ui.adding && canAdd && <AddForm onAdd={add} />}
          <View style={{ flex: 1, opacity: down ? 0.5 : 1 }}>
            <HighPriority onPick={showInList} />
            <View style={{ flex: 1, overflow: "hidden" }}>
              <ScrollView
                ref={scroller}
                onLayout={(e) => {
                  seen.current = e.nativeEvent.layout.height;
                  placeHeadings();
                }}
                onScroll={(e) => {
                  stuck.current.y = e.nativeEvent.contentOffset.y;
                  stuck.current.redraw?.();
                }}
                scrollEventThrottle={16}
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 8 }}
              >
                <View ref={content}>
                  <List items={items} />
                </View>
              </ScrollView>
              <StuckHeading at={stuck} />
            </View>
          </View>
          <Inspector />
          {(message.text !== "" || undos.length > 0) && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: c.border }}>
              <T lines={1} color={message.error ? c.statusDanger : c.foregroundMuted} style={{ flex: 1 }}>
                {message.text}
              </T>
              {undos.length > 0 && <Link onPress={undo}>Undo</Link>}
            </View>
          )}
        </View>
        {ui.settings && board.settings && <SettingsDialog settings={board.settings} onChange={changeSetting} />}
        {menu && (
          <Menu
            at={menu}
            onClose={() => setMenu(null)}
            actions={[
              ["Copy title", () => copyTitle(menu.item)],
              ["Copy ID", () => copy(menu.item.id, `Copied the ID ${menu.item.id}`)],
              menu.item.priority === "high"
                ? ["Mark normal priority", () => patch(menu.item.id, { priority: "normal" })]
                : ["Mark high priority", () => markHigh(menu.item)],
            ]}
          />
        )}
      </View>
    </BoardContext.Provider>
  );
}

function filterOptions(m: Model): Option[] {
  const options: Option[] = [{ value: "", label: "everything" }];
  for (const p of Object.values(m.board.projects).sort((x, y) => x.name.localeCompare(y.name))) {
    options.push({ value: "project:" + p.path, label: `${p.name} — ${projectPath(p.path)}`, group: "Projects" });
  }
  const sessions = Object.values(m.board.panes)
    .filter((p) => p.session)
    .map((p) => ({ id: p.session!, alive: p.alive, name: m.whoName(p.session!) }))
    .sort((x, y) => Number(y.alive) - Number(x.alive) || x.name.localeCompare(y.name));
  const listed = new Set<string>();
  for (const s of sessions) {
    if (listed.has(s.id)) continue; // a resumed session leaves several pane records
    listed.add(s.id);
    options.push({ value: "who:" + s.id, label: "@" + s.name + (s.alive ? "" : " (gone)"), group: "Sessions" });
  }
  return options;
}

function Header({ canAdd, filters }: { canAdd: boolean; filters: Option[] }) {
  const { host, c, m, ui, set } = useBoard();
  const f = m.focus;
  return (
    <View style={{ paddingTop: 6, paddingHorizontal: 8, paddingBottom: 5, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View accessibilityRole="tablist" style={{ flex: 1, flexDirection: "row", gap: 2, padding: 2, borderRadius: 7, backgroundColor: c.surface2 }}>
          {TABS.map(([tab, label]) => (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityState={{ selected: ui.tab === tab }}
              onPress={() => set(() => ({ tab, selected: null, editing: false }))}
              style={{ flex: 1, alignItems: "center", paddingVertical: 2, borderRadius: 5, backgroundColor: ui.tab === tab ? c.surface0 : undefined }}
            >
              <T size={12} weight="500" color={ui.tab === tab ? c.foreground : c.foregroundMuted}>
                {tab === "session" ? (host.sessionTab ?? label) : label}
              </T>
            </Pressable>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add an item"
          disabled={!canAdd}
          onPress={() => set((now) => ({ adding: !now.adding, addParent: null }))}
          style={{ opacity: canAdd ? 1 : 0.4 }}
        >
          <Icon name="Plus" size={15} />
        </Pressable>
        {m.board.settings && (
          <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => (host.openSettings ? host.openSettings() : set(() => ({ settings: true })))}>
            <Icon name="Settings" size={14} />
          </Pressable>
        )}
      </View>
      {/* Project and Session follow the sessions beside the board; Global sees everything
          and can be narrowed to one project or one driver. */}
      <View style={{ flexDirection: "row", marginTop: 5, minHeight: 18 }}>
        {ui.tab === "global" && (
          <Select value={ui.filter} options={filters} onChange={(filter) => set(() => ({ filter }))} />
        )}
        {ui.tab === "project" && (
          <T size={12} lines={1} color={c.foregroundMuted}>
            {f.projects.length ? f.projects.map(projectPath).join(", ") : "no project here"}
          </T>
        )}
        {ui.tab === "session" && f.sessions.length > 1 && <SessionChips />}
        {ui.tab === "session" && f.sessions.length <= 1 && (
          <T size={12} lines={1} color={c.foregroundMuted}>
            {f.sessions.length ? "@" + m.whoName(f.sessions[0]) : "no session here"}
          </T>
        )}
      </View>
    </View>
  );
}

const HIGH_ROW = 20;
const HIGH_SHOWN = 6; // the rest scroll inside the box, so the list keeps its room

/**
 * Above the list on every tab, staying put: every open high priority item on the board, whatever
 * the tab shows, soonest due first. A press shows one in the list, on Global when the tab cannot.
 */
function HighPriority({ onPick }: { onPick: (item: Item) => void }) {
  const { c, m, scaled } = useBoard();
  const high = m.board.items.filter(m.high).sort((x, y) => (x.due || "").localeCompare(y.due || "") || x.created_at.localeCompare(y.created_at));
  if (!high.length) return null;
  return (
    <View style={{ marginTop: 8, marginHorizontal: 8, paddingVertical: 4, paddingLeft: scaled(10), paddingRight: 8, borderRadius: 6, overflow: "hidden" }}>
      <Tint color={c.statusDanger} opacity={0.08} />
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: scaled(3), backgroundColor: c.statusDanger }} />
      <T size={10} weight="600" color={c.statusDanger} style={{ marginBottom: 2 }}>
        {`High priority · ${high.length}`}
      </T>
      <ScrollView style={{ maxHeight: scaled(HIGH_ROW) * HIGH_SHOWN }}>
        {high.map((item) => {
          const task = item.parent ? m.byId[item.parent] : null;
          const due = item.due ? dueDay(item.due) : null;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={"Show “" + item.title + "” in the list"}
              onPress={() => onPick(item)}
              style={{ flexDirection: "row", alignItems: "center", gap: 5, height: scaled(HIGH_ROW) }}
            >
              <StatusIcon item={item} size={11} />
              <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: 5 }}>
                <T size={11} lines={1} style={{ flexShrink: 1 }}>
                  {item.title}
                </T>
                {task && (
                  <T size={10} lines={1} color={c.foregroundMuted} style={{ flexShrink: 2 }}>
                    {task.title}
                  </T>
                )}
              </View>
              {due && (
                <T size={10} color={due.overdue ? c.statusDanger : c.foregroundMuted}>
                  {due.label}
                </T>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const FILL = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } as const;

/** A small menu where it was asked for, kept inside the board; a press anywhere else closes it. */
function Menu({ at, actions, onClose }: { at: MenuAt; actions: [string, () => void][]; onClose: () => void }) {
  const { c, scaled } = useBoard();
  const box = useRef<View>(null);
  useEffect(() => box.current?.focus(), []);
  const line = scaled(24);
  const width = scaled(120);
  const height = actions.length * line + 8;
  const left = Math.max(4, Math.min(at.x, at.width - width - 4));
  const top = at.y + height > at.height - 4 ? Math.max(4, at.y - height) : at.y; // opens upwards near the bottom
  return (
    <View style={FILL}>
      <Pressable accessibilityLabel="Close the menu" onPress={onClose} {...onRightClick(onClose)} style={FILL} />
      <View
        ref={box}
        role="menu"
        {...closesOnLeave(onClose)}
        style={{ position: "absolute", left, top, width, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, boxShadow: "0 4px 14px rgba(0, 0, 0, 0.3)" }}
      >
        {actions.map(([label, run]) => (
          <MenuItem key={label} label={label} height={line} onPress={() => {
              onClose();
              run();
            }} />
        ))}
      </View>
    </View>
  );
}

function MenuItem({ label, height, onPress }: { label: string; height: number; onPress: () => void }) {
  const { c } = useBoard();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable role="menuitem" onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={{ height, justifyContent: "center", paddingHorizontal: 8 }}>
      {hovered && <Tint color={c.accent} opacity={0.2} />}
      <T lines={1}>{label}</T>
    </Pressable>
  );
}

/** The sessions beside the board, each a press away from being the only one shown. */
function SessionChips() {
  const { c, m, ui, set } = useBoard();
  return (
    <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
      {m.focus.sessions.map((s) => {
        const on = ui.only === s;
        return (
          <Pressable
            key={s}
            accessibilityRole="button"
            accessibilityLabel={on ? "Show every session" : `Show only @${m.whoName(s)}`}
            accessibilityState={{ selected: on }}
            onPress={() => set((now) => ({ only: now.only === s ? null : s }))}
            style={{ borderRadius: 4, paddingVertical: 1, paddingHorizontal: 5, borderWidth: 1, borderColor: on ? c.accent : c.border }}
          >
            {on && <Tint color={c.accent} opacity={0.2} radius={4} />}
            <T lines={1} color={on ? c.foreground : c.foregroundMuted}>
              {"@" + m.whoName(s)}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

function AddForm({ onAdd }: { onAdd: (title: string, project: string) => void }) {
  const { c, m, ui, set, scaled } = useBoard();
  const parent = ui.addParent ? m.byId[ui.addParent] : null;
  const projects = Object.values(m.board.projects);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState(
    () => m.focus.projects.find((path) => projects.some((p) => p.path === path)) ?? projects[0].path,
  );
  const project = parent ? parent.project : ui.tab === "global" ? picked : m.focus.projects[0];
  const close = () => set(() => ({ adding: false, addParent: null }));
  return (
    <View style={{ gap: 6, padding: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Tint color={c.foreground} opacity={0.04} />
      {parent && (
        <T lines={1} color={c.foregroundMuted}>
          {"under: " + parent.title}
        </T>
      )}
      <TextInput
        autoFocus
        value={title}
        onChangeText={setTitle}
        placeholder={parent ? "New step, Enter to add, Esc to close" : "New item, Enter to add, Esc to close"}
        placeholderTextColor={c.foregroundMuted}
        submitBehavior="submit"
        onSubmitEditing={() => {
          if (!title.trim()) return;
          onAdd(title.trim(), project);
          setTitle("");
        }}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Escape") close();
        }}
        style={[controlStyle(c), { fontSize: scaled(11), color: c.foreground }]}
      />
      {ui.tab === "global" && !parent && (
        <View style={{ flexDirection: "row" }}>
          <Select value={picked} options={projects.map((p) => ({ value: p.path, label: p.name }))} onChange={setPicked} />
        </View>
      )}
    </View>
  );
}
