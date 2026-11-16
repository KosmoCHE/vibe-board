// The list: every task with its steps, and what waits for what, drawn the way a git
// graph draws history.
//
// One line per item, prerequisites above what waits for them. The rail on the left
// carries a dot per item and a lane per dependency: a lane leaves its prerequisite,
// runs down, and ends in the dot of the item that waits for it. A task's steps branch
// off a faint trunk below the task. Details stay in the inspector. Everything is
// positioned by arithmetic, so nothing is measured.

import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { ViewStyle } from "react-native";
import type { Item } from "./host";
import { graphFlows, graphLayers, projectPath, scopedChildren } from "./model";
import type { Model } from "./model";
import { Complete, doneStepsKey, DriverChip, Icon, Link, onRightClick, T, Tint, useBoard, useItemPress } from "./parts";
import type { Ui } from "./parts";

// --- what to draw ---------------------------------------------------------------

interface Fold {
  key: string; // in Ui.showDone
  count: number;
  open: boolean;
}
interface Row {
  key: string;
  item?: Item; // absent on a fold row and a heading
  fold?: Fold;
  heading?: string; // Global: the project of the tasks below
  parent?: string; // on a step, and on the fold of a task's done steps: the task's row
  steps?: { key: string; done: number; total: number; open: boolean }; // a task that has steps; key in Ui.open
  outside?: boolean; // waits for something the current scope does not show
}
interface Edge {
  source: string; // row keys
  target: string;
  links: [string, string][]; // the item pairs it stands for
  summary: boolean; // an end stands in for a hidden item: drawn dashed
}

function scopeKey(ui: Ui, m: Model): string {
  const f = m.focus;
  return ui.tab + ":" + (ui.tab === "global" ? ui.filter : (ui.tab === "project" ? f.projects : f.sessions).join("|"));
}

// Where the folds are kept. Ui.open: a task's steps, per scope. Ui.showDone: a level's
// finished items, the top level here and a task's steps under parts.doneStepsKey.
const stepsKey = (scope: string, task: Item) => scope + ":" + task.id;
const doneKey = (scope: string) => "root:" + scope;

/** Ui.open with the steps under these keys folded or shown. Steps show until folded, so only folds are kept. */
function folded(open: Ui["open"], keys: string[], fold: boolean): Ui["open"] {
  const next = { ...open };
  for (const key of keys) {
    if (fold) next[key] = false;
    else delete next[key];
  }
  return next;
}

/** Ui.open as it is worth remembering: without the folds of tasks that have left the board. */
export function lasting(open: Ui["open"], m: Model): Ui["open"] {
  // A key ends in its task's id: see stepsKey.
  return Object.fromEntries(Object.entries(open).filter(([key]) => key.slice(key.lastIndexOf(":") + 1) in m.byId));
}

/** The folds to open so that an item shows. `openTask` also unfolds a task's own steps. */
export function reveal(ui: Ui, m: Model, item: Item, openTask: boolean): Partial<Ui> {
  const task = m.scopeItems(ui).find((i) => i.id === item.parent) || item;
  const scope = scopeKey(ui, m);
  const out: Partial<Ui> = {};
  const steps = stepsKey(scope, task);
  if ((task !== item || openTask) && ui.open[steps] === false) out.open = folded(ui.open, [steps], false);
  const showDone = { ...ui.showDone };
  if (task.status === "done") showDone[doneKey(scope)] = true;
  if (task !== item && item.status === "done") showDone[doneStepsKey(ui, task)] = true;
  return { ...out, showDone };
}

function plan(items: Item[], ui: Ui, m: Model) {
  const kids = scopedChildren(items);
  const scope = scopeKey(ui, m);
  const { done, active } = m.levelItems(kids.root || []);
  const rootOpen = Boolean(ui.showDone[doneKey(scope)]);
  const tasks = rootOpen ? [...done, ...active] : active;
  const loop = graphLayers(items, new Map(items.map((item) => [item.id, new Set(item.depends_on)]))).unresolved.length > 0;

  // Project step links onto their tasks, only to put the tasks in order. Lanes keep the step ends.
  const taskDeps = new Map(tasks.map((task) => [task.id, new Set<string>()]));
  const owners = new Map(items.map((item) => [item.id, item.parent && taskDeps.has(item.parent) ? item.parent : item.id]));
  for (const item of items) {
    const target = owners.get(item.id)!;
    if (!taskDeps.has(target)) continue;
    for (const dep of item.depends_on) {
      const source = owners.get(dep);
      if (source && source !== target && taskDeps.has(source)) taskDeps.get(target)!.add(source);
    }
  }

  const rows: Row[] = [];
  const shownAt = new Map<string, string>(); // item id → key of the row that shows it
  if (done.length) {
    rows.push({ key: "f:root", fold: { key: doneKey(scope), count: done.length, open: rootOpen } });
    if (!rootOpen) for (const item of done) shownAt.set(item.id, "f:root");
  }
  let anyOpen = false;
  // Tasks that depend on each other stay together, each below what it waits for.
  const ordered = graphFlows(tasks, taskDeps).flatMap(({ layers, unresolved }) => [...layers.flat(), ...unresolved]);
  // Global names each project once, above its tasks, instead of on every task.
  const grouped = ui.tab === "global";
  let heading: string | null = null;
  for (const task of grouped ? byProject(ordered, taskDeps) : ordered) {
    if (grouped && task.project !== heading) {
      heading = task.project;
      rows.push({ key: "h:" + heading, heading });
    }
    const steps = kids[task.id] || [];
    const key = stepsKey(scope, task);
    const open = steps.length > 0 && ui.open[key] !== false; // rows are small: open until folded
    anyOpen = anyOpen || open;
    shownAt.set(task.id, "n:" + task.id);
    rows.push({
      key: "n:" + task.id,
      item: task,
      steps: steps.length ? { key, done: steps.filter((s) => s.status === "done").length, total: steps.length, open } : undefined,
    });
    if (!open) continue;
    const inside = m.levelItems(steps);
    const doneFold = doneStepsKey(ui, task);
    const foldOpen = Boolean(ui.showDone[doneFold]);
    if (inside.done.length) {
      rows.push({ key: "f:" + task.id, fold: { key: doneFold, count: inside.done.length, open: foldOpen }, parent: "n:" + task.id });
      if (!foldOpen) for (const step of inside.done) shownAt.set(step.id, "f:" + task.id);
    }
    for (const step of foldOpen ? [...inside.done, ...inside.active] : inside.active) {
      shownAt.set(step.id, "n:" + step.id);
      rows.push({ key: "n:" + step.id, item: step, parent: "n:" + task.id });
    }
  }

  // A hidden step is stood in for by the fold or the folded task that hides it.
  const endpoint = (item: Item) => shownAt.get(item.id) || (item.parent ? shownAt.get(item.parent) : undefined);
  const inScope = new Set(items.map((item) => item.id));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const edges = new Map<string, Edge>();
  for (const item of items) {
    const target = endpoint(item);
    if (!target) continue;
    for (const id of item.depends_on) {
      const dep = m.byId[id];
      const source = dep && inScope.has(id) ? endpoint(dep) : undefined;
      // A link that has been met holds nothing up: once either end is done it is not drawn.
      if (!dep || dep.status === "done" || item.status === "done" || source === target) continue;
      if (!source) {
        byKey.get(target)!.outside = true; // scope boundaries are marks, never extra rows
        continue;
      }
      const summary = source !== "n:" + id || target !== "n:" + item.id;
      const known = edges.get(source + ">" + target);
      if (known) {
        known.links.push([id, item.id]);
        known.summary = known.summary && summary;
      } else edges.set(source + ">" + target, { source, target, links: [[id, item.id]], summary });
    }
  }
  const ends = new Map(items.map((item) => [item.id, endpoint(item)]));
  return { rows, edges: [...edges.values()], ends, tasks, anyOpen, loop, scope };
}

type Plan = ReturnType<typeof plan>;

/** Tasks grouped by project: the groups in the order they first come, each after those it waits for. */
function byProject(tasks: Item[], taskDeps: Map<string, Set<string>>): Item[] {
  const projectOf = new Map(tasks.map((task) => [task.id, task.project]));
  const first = [...new Set(tasks.map((task) => task.project))];
  const waits = new Map(first.map((project) => [project, new Set<string>()]));
  for (const task of tasks) {
    for (const dep of taskDeps.get(task.id)!) if (projectOf.get(dep) !== task.project) waits.get(task.project)!.add(projectOf.get(dep)!);
  }
  const order: string[] = [];
  while (order.length < first.length) {
    const left = first.filter((project) => !order.includes(project));
    order.push(left.find((project) => [...waits.get(project)!].every((q) => order.includes(q))) ?? left[0]); // a loop: first come
  }
  return order.flatMap((project) => tasks.filter((task) => task.project === project));
}

// What the selection touches: everything upstream and downstream of it.
function trace(p: Plan, items: Item[], m: Model, selected: string | null) {
  const roots = new Set(selected ? [selected] : []);
  // Selecting a task traces its visible scope's steps as well.
  if (selected) for (const item of items) if (item.parent === selected) roots.add(item.id);
  const downstream = new Map<string, string[]>();
  for (const item of m.board.items) {
    for (const dep of item.depends_on) downstream.set(dep, [...(downstream.get(dep) || []), item.id]);
  }
  const follow = (neighbors: (id: string) => string[] | undefined) => {
    const ids = new Set(roots);
    for (const id of ids) for (const next of neighbors(id) || []) ids.add(next);
    return ids;
  };
  const before = follow((id) => m.byId[id]?.depends_on); // a prerequisite may have left the board
  const after = follow((id) => downstream.get(id));
  const related = new Set<string>();
  for (const id of [...before, ...after]) {
    const at = p.ends.get(id);
    if (at) related.add(at);
  }
  const onPath = (edge: Edge) =>
    edge.links.some(([from, to]) => (before.has(from) && before.has(to)) || (after.has(from) && after.has(to)));
  return { related, onPath };
}

// --- lanes ------------------------------------------------------------------------

/** One stroke inside a row's rail. Columns count from the left: the gutter's lanes, then the dots. */
type Stroke =
  | { kind: "line"; lane: number; from: number; to: number; paint: Paint } // fractions of the row's height
  | ({ kind: "turn"; up: boolean } & Sideways) // from the dot sideways, then along the lane
  | ({ kind: "tick" } & Sideways) // sideways from one column to another
  | { kind: "stem"; lane: number; down: boolean; paint: Paint; arrow?: boolean }; // in the dot's column, from the dot to the row's bottom or top
// arrow: the link ends here, at what waits; an arrowhead points into the dot.
// nudge: drawn a little above (-1) or below (1) the dot's centre.
type Sideways = { col: number; lane: number; paint: Paint; arrow?: boolean; nudge?: -1 | 1 };
type Paint = "tree" | "plain" | "dashed" | "lit" | "back";

/**
 * A task's dot sits in one column and its steps' one column to the right, tied to a faint
 * trunk below the task: that is the hierarchy, and links never move it. A link gets a lane
 * per item waited for, spanning it and its prerequisites. A link between neighbours in one
 * column, two tasks or two steps of a task, is just a short line from one dot to the next.
 * Of the rest, one that passes a task, or runs
 * from a task past its own steps, runs in a gutter left of the dots; the rest stay just
 * right of the dots, as in a git graph. Either way the longest lanes run furthest out.
 * Each of Global's project groups has a gutter of its own, none where no link needs one;
 * groups a link crosses share one.
 */
function lanes(p: Plan, lit: (edge: Edge) => boolean) {
  const index = new Map(p.rows.map((row, n) => [row.key, n]));
  const at = (key: string) => index.get(key)!; // every edge joins two rows
  type Group = { top: number; bottom: number; edges: Edge[] };
  const groups = new Map<string, Group>();
  const straight = (edge: Edge) => {
    const [a, b] = [at(edge.source), at(edge.target)];
    return Math.abs(a - b) === 1 && Boolean(p.rows[a].parent) === Boolean(p.rows[b].parent);
  };
  for (const edge of p.edges) {
    if (straight(edge)) continue;
    const group = groups.get(edge.target) ?? { top: at(edge.target), bottom: at(edge.target), edges: [] };
    group.top = Math.min(group.top, at(edge.source));
    group.bottom = Math.max(group.bottom, at(edge.source));
    group.edges.push(edge);
    groups.set(edge.target, group);
  }
  const inGutter = (g: Group) => {
    const passed = p.rows.slice(g.top + 1, g.bottom);
    return passed.some((row) => !row.parent) || (passed.length > 0 && !p.rows[g.top].parent);
  };
  // Sections start at Global's headings; a band is a run of sections that links join.
  const section: number[] = [];
  p.rows.forEach((row, n) => (section[n] = (n ? section[n - 1] : 0) + (row.heading && n ? 1 : 0)));
  const joined = new Set<number>(); // section s is in one band with section s + 1
  for (const g of groups.values()) if (inGutter(g)) for (let s = section[g.top]; s < section[g.bottom]; s++) joined.add(s);
  const bandOf: number[] = [];
  for (let s = 0; s <= section[p.rows.length - 1]; s++) bandOf[s] = s && !joined.has(s - 1) ? bandOf[s - 1] + 1 : (bandOf[s - 1] ?? 0);
  const band = (row: number) => bandOf[section[row]];
  /** The first lane from `from` on whose row spans miss this group's. */
  const pack = (lanes: [number, number][][], g: Group, from = 0) => {
    let lane = from;
    while (lanes[lane]?.some(([top, bottom]) => bottom >= g.top && top <= g.bottom)) lane++;
    (lanes[lane] ??= []).push([g.top, g.bottom]);
    return lane;
  };
  const longestFirst = [...groups].sort(([, a], [, b]) => b.bottom - b.top - (a.bottom - a.top));
  const gutter: [number, number][][][] = []; // band → lane → the row spans it carries
  const laneOf = new Map<string, number>(); // the column a group's lane runs in
  for (const [target, g] of longestFirst) if (inGutter(g)) laneOf.set(target, pack((gutter[band(g.top)] ??= []), g));
  const width = (row: number) => gutter[band(row)]?.length ?? 0;
  // Half a lane more between the dots and the nearest lane on either side, so a link's turn keeps
  // its rounded corner and a straight end for the arrowhead even next to the dot.
  const dots = (row: number) => width(row) + (width(row) ? 0.5 : 0);
  const beside: [number, number][][] = []; // columns right of the dots; their rows never cross a band
  for (const [target, g] of [...longestFirst].reverse()) {
    if (inGutter(g)) continue;
    const steps = p.rows.slice(g.top, g.bottom + 1).some((row) => row.parent);
    laneOf.set(target, pack(beside, g, width(g.top) + (steps ? 2 : 1)) + dots(g.top) - width(g.top) + 0.5);
  }
  const cols = p.rows.map((row, n) => dots(n) + (row.parent ? 1 : 0));

  const strokes = p.rows.map(() => new Map<string, Stroke>());
  const rank: Record<Paint, number> = { tree: 0, dashed: 1, plain: 2, back: 3, lit: 4 };
  const draw = (row: number, stroke: Stroke): void => {
    // A line through a row is kept as its halves above and below the dot, each in the strongest
    // paint given to it, so lines laid over each other never add up to a brighter patch.
    if (stroke.kind === "line" && stroke.from === 0 && stroke.to === 1) {
      draw(row, { ...stroke, to: 0.5 });
      return draw(row, { ...stroke, from: 0.5 });
    }
    let key: string;
    if (stroke.kind === "line") key = `l${stroke.lane}:${stroke.from}:${stroke.to}`;
    else if (stroke.kind === "stem") key = `s${stroke.lane}:${stroke.down}`;
    else key = `${stroke.kind}${stroke.col}:${stroke.lane}:${stroke.kind === "turn" && stroke.up}`;
    const known = strokes[row].get(key);
    if (!known || rank[stroke.paint] > rank[known.paint]) strokes[row].set(key, stroke);
  };
  let task = -1;
  p.rows.forEach((row, n) => {
    if (!row.parent) {
      task = n;
      return;
    }
    draw(n, { kind: "tick", col: cols[task], lane: cols[n], paint: "tree" });
    draw(task, { kind: "line", lane: cols[task], from: 0.5, to: 1, paint: "tree" });
    for (let k = task + 1; k < n; k++) draw(k, { kind: "line", lane: cols[task], from: 0, to: 1, paint: "tree" });
    draw(n, { kind: "line", lane: cols[task], from: 0, to: 0.5, paint: "tree" });
  });
  const paintOf = (edge: Edge): Paint => (lit(edge) ? "lit" : at(edge.source) > at(edge.target) ? "back" : edge.summary ? "dashed" : "plain");
  for (const edge of p.edges.filter(straight)) {
    const top = Math.min(at(edge.source), at(edge.target));
    const end = at(edge.target);
    draw(top, { kind: "stem", lane: cols[top], down: true, paint: paintOf(edge), arrow: top === end });
    draw(top + 1, { kind: "stem", lane: cols[top + 1], down: false, paint: paintOf(edge), arrow: top + 1 === end });
  }
  for (const [target, g] of groups) {
    const lane = laneOf.get(target)!;
    for (const edge of g.edges) {
      const paint = paintOf(edge);
      const top = Math.min(at(edge.source), at(edge.target));
      const bottom = Math.max(at(edge.source), at(edge.target));
      const end = at(edge.target);
      if (top === g.top) draw(top, { kind: "turn", col: cols[top], lane, up: false, paint, arrow: top === end });
      else {
        draw(top, { kind: "tick", col: cols[top], lane, paint, arrow: top === end });
        draw(top, { kind: "line", lane, from: 0.5, to: 1, paint });
      }
      for (let n = top + 1; n < bottom; n++) draw(n, { kind: "line", lane, from: 0, to: 1, paint });
      if (bottom === g.bottom) draw(bottom, { kind: "turn", col: cols[bottom], lane, up: true, paint, arrow: bottom === end });
      else {
        draw(bottom, { kind: "tick", col: cols[bottom], lane, paint, arrow: bottom === end });
        draw(bottom, { kind: "line", lane, from: 0, to: 0.5, paint });
      }
    }
  }
  for (const row of strokes) {
    for (const [key, line] of row) {
      if (line.kind !== "line" || line.from !== 0) continue;
      const below = `l${line.lane}:0.5:1`;
      if (row.get(below)?.paint !== line.paint) continue;
      row.set(key, { ...line, to: 1 }); // two halves in one paint: one line, with no seam
      row.delete(below);
    }
    // A row that waits along one link and is waited for along another on the same side of its
    // dot: the link it waits on comes in above the centre and the others leave below it, so
    // the two never run together.
    const sideways = [...row.values()].flatMap((stroke) => (stroke.kind === "line" || stroke.kind === "stem" || stroke.paint === "tree" ? [] : [stroke]));
    const into = sideways.find((stroke) => stroke.arrow);
    const out = sideways.filter((stroke) => into && stroke !== into && stroke.lane > stroke.col === into.lane > into.col);
    if (into && out.length) {
      into.nudge = -1;
      for (const stroke of out) stroke.nudge = 1;
    }
  }
  return p.rows.map((_, n) => ({ col: cols[n], strokes: [...strokes[n].values()] }));
}

// --- the view ---------------------------------------------------------------------

// Lengths at the default text size: the rail grows with the text beside it, its lines do not.
const LANE = 14; // distance between lanes
const LINE = 1.5;
const DOT = 18; // width of the slot a row's dot sits in
const DISC = 7; // radius of the disc behind a dot, and of a turn
const EDGE = 10; // space between a row and the sides of the panel, as around the legend
const AFTER_DOT = 4; // space between the rail and a row's words

export function List({ items }: { items: Item[] }) {
  const { c, m, ui, set } = useBoard();
  const p = plan(items, ui, m);
  if (!p.rows.length) return <Empty />;
  const t = trace(p, items, m, ui.selected);
  const rails = lanes(p, t.onPath);
  const hasSteps = p.rows.some((row) => row.steps);
  return (
    <View style={{ paddingVertical: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 3, marginHorizontal: EDGE, marginBottom: 6 }}>
        <T size={9} color={c.foregroundMuted}>
          ↓ Prerequisite above, next below
        </T>
        {p.edges.some((edge) => edge.summary) && (
          <T size={9} color={c.foregroundMuted}>
            Dashed: hidden items
          </T>
        )}
        {hasSteps && (
          <Link
            size={9}
            style={{ marginLeft: "auto" }}
            onPress={() => set((now) => ({ open: folded(now.open, p.tasks.map((task) => stepsKey(p.scope, task)), p.anyOpen) }))}
          >
            {p.anyOpen ? "Collapse tasks" : "Expand tasks"}
          </Link>
        )}
      </View>
      {p.loop && (
        <T size={10} color={c.statusDanger} style={{ marginHorizontal: EDGE, marginBottom: 6 }}>
          Dependency loop: check the task and step prerequisites.
        </T>
      )}
      {p.rows.map((row, n) => {
        const dim = ui.selected !== null && !t.related.has(row.key);
        if (row.heading) return <HeadingRow key={row.key} path={row.heading} rail={rails[n]} />;
        return row.item ? (
          <ItemRow key={row.key} row={row} item={row.item} rail={rails[n]} dim={dim} />
        ) : (
          <FoldRow key={row.key} row={row} fold={row.fold!} rail={rails[n]} dim={dim} />
        );
      })}
    </View>
  );
}

function Empty() {
  const { c, m, ui } = useBoard();
  let text: string;
  if (ui.tab === "global") {
    if (ui.filter) text = "Nothing here for this filter.";
    else {
      text = Object.keys(m.board.projects).length
        ? "Nothing on the board."
        : "No items yet. Start a session in a project, then add items here.";
    }
  } else if (ui.tab === "project") text = m.focus.projects.length ? "Nothing in this project yet." : "No session is running here.";
  else if (!m.focus.sessions.length) text = "No session is running here.";
  else text = m.focus.sessions.length > 1 && !ui.only ? "The sessions here push nothing yet." : "This session pushes nothing yet.";
  return (
    <T size={12} color={c.foregroundMuted} style={{ marginVertical: 12, marginHorizontal: 14 }}>
      {text}
    </T>
  );
}

type RailOf = ReturnType<typeof lanes>[number];

function Rail({ rail, height, children }: { rail: RailOf; height: number; children: ReactNode }) {
  const { c, scaled } = useBoard();
  const color: Record<Paint, string> = { tree: c.foregroundMuted, plain: c.foregroundMuted, dashed: c.foregroundMuted, lit: c.accent, back: c.statusDanger };
  const widest = Math.max(rail.col, ...rail.strokes.map((stroke) => stroke.lane));
  const mid = height / 2;
  const dot = scaled(DOT);
  const disc = scaled(DISC);
  const laneX = (lane: number) => dot / 2 + scaled(lane * LANE); // centre of a lane
  const level = (stroke: Sideways) => mid + (stroke.nudge ?? 0) * scaled(4); // where it meets the dot
  const head = scaled(6); // an arrowhead's length
  // Where a sideways stroke starts at the dot's end: past the arrowhead if it has one, so the line
  // never runs under it, else from the middle (a trunk tie from the trunk's edge).
  const start = (stroke: Sideways, gap: number) => laneX(stroke.col) + Math.sign(stroke.lane - stroke.col) * (stroke.arrow ? disc + head - 1 : gap);
  return (
    <View style={{ width: laneX(widest) + dot / 2, height }}>
      {rail.strokes.map((stroke, n) => {
        const paint = color[stroke.paint];
        const fade = stroke.paint === "lit" || stroke.paint === "back" ? 1 : stroke.paint === "tree" ? 0.3 : 0.7;
        if (stroke.kind === "tick") {
          const thick = stroke.paint === "tree" ? 1 : LINE;
          // It stops at the edges of the lines it meets, so they never overlap into a brighter spot.
          const from = start(stroke, thick / 2);
          const to = laneX(stroke.lane) - Math.sign(stroke.lane - stroke.col) * (thick / 2);
          return <View key={n} style={{ position: "absolute", left: Math.min(from, to), top: level(stroke) - thick / 2, width: Math.abs(to - from), height: thick, backgroundColor: paint, opacity: fade }} />;
        }
        if (stroke.kind === "line" || stroke.kind === "stem") {
          const wide = stroke.paint === "tree" ? 1 : LINE;
          let [top, bottom] = [0, height];
          if (stroke.kind === "line") [top, bottom] = [stroke.from * height, stroke.to * height];
          else if (stroke.down) top = mid + disc + (stroke.arrow ? head - 1 : 0); // from the disc, or the arrowhead's base
          else bottom = mid - disc - (stroke.arrow ? head - 1 : 0);
          const frame: ViewStyle = { position: "absolute", left: laneX(stroke.lane) - wide / 2, top, width: wide, height: bottom - top, opacity: fade };
          if (stroke.paint !== "dashed") return <View key={n} style={[frame, { backgroundColor: paint }]} />;
          return (
            <View key={n} style={[frame, { gap: 3, overflow: "hidden" }]}>
              {Array.from({ length: Math.ceil(height / 6) }).map((_, d) => (
                <View key={d} style={{ width: LINE, height: 3, backgroundColor: paint }} />
              ))}
            </View>
          );
        }
        // Sideways from the dot, then a rounded turn into the lane, tightened to leave an arrowhead
        // a straight end.
        const right = stroke.lane > stroke.col;
        const from = start(stroke, 0);
        const edge = laneX(stroke.lane) + (right ? LINE / 2 : -LINE / 2); // the lane line's outer edge
        const radius = Math.min(disc, Math.abs(edge - from) - LINE);
        const frame: ViewStyle = {
          position: "absolute",
          left: Math.min(from, edge),
          width: Math.abs(edge - from),
          top: stroke.up ? 0 : level(stroke) - LINE / 2,
          height: (stroke.up ? level(stroke) : height - level(stroke)) + LINE / 2,
          borderColor: paint,
          borderStyle: stroke.paint === "dashed" ? "dashed" : "solid",
          opacity: fade,
        };
        const corner: ViewStyle = stroke.up
          ? { borderBottomWidth: LINE, ...(right ? { borderRightWidth: LINE, borderBottomRightRadius: radius } : { borderLeftWidth: LINE, borderBottomLeftRadius: radius }) }
          : { borderTopWidth: LINE, ...(right ? { borderRightWidth: LINE, borderTopRightRadius: radius } : { borderLeftWidth: LINE, borderTopLeftRadius: radius }) };
        return <View key={n} style={[frame, corner]} />;
      })}
      {rail.strokes.map((stroke, n) => {
        if (stroke.kind === "line" || !stroke.arrow) return null;
        const opacity = stroke.paint === "lit" || stroke.paint === "back" ? 1 : 0.7;
        if (stroke.kind === "stem") {
          // Down into the dot from the row above, or up into it from the row below.
          const half = head * 0.65;
          const point: ViewStyle = stroke.down ? { borderBottomWidth: head, borderBottomColor: color[stroke.paint] } : { borderTopWidth: head, borderTopColor: color[stroke.paint] };
          const box: ViewStyle = { position: "absolute", left: laneX(stroke.lane) - half, top: stroke.down ? mid + disc - 1 : mid - disc + 1 - head, borderLeftWidth: half, borderRightWidth: half, borderLeftColor: "transparent", borderRightColor: "transparent", opacity };
          return <View key={"arrow" + n} style={[box, point]} />;
        }
        // The head sits on the side the lane comes in from, against the disc.
        const right = stroke.lane > stroke.col;
        const point: ViewStyle = right ? { borderRightWidth: head, borderRightColor: color[stroke.paint] } : { borderLeftWidth: head, borderLeftColor: color[stroke.paint] };
        return (
          <View
            key={"arrow" + n}
            style={[
              {
                position: "absolute",
                left: right ? laneX(stroke.col) + disc - 1 : laneX(stroke.col) - disc - head + 1,
                top: level(stroke) - head * 0.65,
                borderTopWidth: head * 0.65,
                borderBottomWidth: head * 0.65,
                borderTopColor: "transparent",
                borderBottomColor: "transparent",
                opacity,
              },
              point,
            ]}
          />
        );
      })}
      {/* The dot: a disc that hides the lines meeting behind it, in a slot as tall as the row. */}
      <View style={{ position: "absolute", left: laneX(rail.col) - dot / 2, top: 0, width: dot, height, alignItems: "center", justifyContent: "center" }}>
        <View style={{ position: "absolute", left: dot / 2 - disc, top: mid - disc, width: 2 * disc, height: 2 * disc, borderRadius: disc, backgroundColor: c.surface0 }} />
        {/* In a view of its own: on the web a bare icon would paint under the disc. */}
        <View>{children}</View>
      </View>
    </View>
  );
}

const ROW = 24;
const TASK = 28;
const HEADING = 30;

/** A project's name above its tasks on Global, in line with their dots, the lanes passing by. */
function HeadingRow({ path, rail }: { path: string; rail: RailOf }) {
  const { c, m, scaled } = useBoard();
  const height = scaled(HEADING);
  return (
    <View style={{ flexDirection: "row", height, paddingHorizontal: EDGE }}>
      <View style={{ position: "absolute", left: EDGE, top: 0 }}>
        <Rail rail={rail} height={height}>
          {null}
        </Rail>
      </View>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", alignSelf: "flex-end", gap: 6, paddingBottom: scaled(4), marginLeft: scaled(rail.col * LANE) }}>
        <T size={10} weight="600" color={c.foregroundMuted} lines={1}>
          {m.projectName(path)}
        </T>
        <T size={9} color={c.foregroundMuted} lines={1} style={{ flex: 1 }}>
          {projectPath(path)}
        </T>
      </View>
    </View>
  );
}

function ItemRow({ row, item, rail, dim }: { row: Row; item: Item; rail: RailOf; dim: boolean }) {
  const { c, m, ui, set, scaled, openMenu } = useBoard();
  const press = useItemPress(item);
  const done = item.status === "done";
  const quiet = done || item.status === "later" || m.blocked(item);
  const steps = row.steps;
  const step = Boolean(row.parent);
  const height = scaled(step ? ROW : TASK);
  // Who pushes it. A Session tab of one session already says (in Paseo it holds every agent of
  // the workspace), and a step its task's driver pushes adds nothing.
  const said = (ui.tab === "session" && (ui.only !== null || m.focus.sessions.length === 1)) || (item.parent && m.byId[item.parent]?.driver === item.driver);
  const driven = Boolean(item.driver) && !done && !said;
  // Who wrote it down, when that was another session than the one pushing it. Not the human:
  // what you add and hand to an agent is most of the board.
  const by = item.driver && !done && item.created_by !== m.board.me && m.whoName(item.created_by) !== m.whoName(item.driver) ? item.created_by : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title + ", " + m.board.labels[item.status]}
      onPress={press}
      {...onRightClick((x, y) => openMenu(item, x, y))}
      style={{ flexDirection: "row", alignItems: "center", height, paddingHorizontal: EDGE }}
    >
      {item.id === ui.selected && <Tint color={c.accent} opacity={0.16} />}
      <Rail rail={rail} height={height}>
        <Complete
          item={item}
          size={step ? 11 : 13}
          style={{ width: scaled(DOT), height, alignItems: "center", justifyContent: "center", opacity: dim ? 0.4 : 1 }}
        />
      </Rail>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5, marginLeft: AFTER_DOT, opacity: dim ? 0.4 : 1 }}>
        {steps && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={(steps.open ? "Collapse " : "Expand ") + item.title}
            accessibilityState={{ expanded: steps.open }}
            hitSlop={6}
            onPress={() => set((now) => ({ open: folded(now.open, [steps.key], steps.open) }))}
          >
            <Icon name={steps.open ? "ChevronDown" : "ChevronRight"} size={12} />
          </Pressable>
        )}
        <T
          size={step ? 11 : 12}
          weight={step ? undefined : "600"}
          lines={1}
          color={quiet ? c.foregroundMuted : c.foreground}
          style={[{ flex: 1 }, done && { textDecorationLine: "line-through" }]}
        >
          {item.title}
        </T>
        {/* Why it exists, when it was not in the plan. */}
        {item.origin !== "plan" && (
          <T size={9} weight="600" color={item.origin === "issue" ? c.statusDanger : c.statusWarning}>
            {item.origin}
          </T>
        )}
        {row.outside && <Icon name="ArrowUpRight" size={11} color={c.accent} />}
        {by && (
          <T size={9} lines={1} color={c.foregroundMuted} style={{ maxWidth: scaled(90) }}>
            {"by @" + m.whoName(by)}
          </T>
        )}
        {driven && (
          <View style={{ maxWidth: scaled(90) }}>
            <DriverChip item={item} />
          </View>
        )}
        {steps && (
          <T size={9} color={c.foregroundMuted}>
            {`${steps.done}/${steps.total}`}
          </T>
        )}
      </View>
    </Pressable>
  );
}

function FoldRow({ row, fold, rail, dim }: { row: Row; fold: Fold; rail: RailOf; dim: boolean }) {
  const { c, set, scaled } = useBoard();
  const height = scaled(ROW);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: fold.open }}
      onPress={() => set((now) => ({ showDone: { ...now.showDone, [fold.key]: !fold.open } }))}
      style={{ flexDirection: "row", alignItems: "center", height, paddingHorizontal: EDGE, opacity: dim && !fold.open ? 0.4 : 1 }}
    >
      <Rail rail={rail} height={height}>
        <Icon name="Check" size={11} color={c.statusSuccess} />
      </Rail>
      <T size={row.parent ? 10 : 11} color={c.foregroundMuted} style={{ marginLeft: AFTER_DOT }}>{`${fold.open ? "Hide" : "Show"} ${fold.count} done`}</T>
    </Pressable>
  );
}
