// One copy of the board for every panel in this window. Paseo keeps a panel open in each
// workspace, and they all show the same board: one of them asking each second, and one fetch
// per change, is enough. A panel that opens later starts from what is already here.

import type { BoardData, Host } from "./host";

export interface Feed {
  board: BoardData | null; // null until the first fetch
  down: boolean; // the last poll failed: what is shown is stale
  error: string; // why, while down
}

type Listener = (feed: Feed) => void;

let feed: Feed = { board: null, down: false, error: "" };
let answered: Date | null = null; // kept aside: a panel reads it while down, and a poll should not redraw every panel
const panels = new Map<Listener, Host["request"]>(); // each open panel, and how it reaches the server
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let again = false; // a change landed while a poll was under way
let version: string | null = null; // of the board held; null: fetch it whatever the server says

function publish(change: Partial<Feed>) {
  feed = { ...feed, ...change };
  for (const listener of panels.keys()) listener(feed);
}

/** The board as held now: a panel opening later draws this at once. */
export function current(): Feed {
  return feed;
}

/** Follow the board; returns the unsubscribe. The listener hears the board as it is now at once. */
export function subscribe(request: Host["request"], listener: Listener): () => void {
  panels.set(listener, request);
  listener(feed);
  if (!timer) {
    poll();
    timer = setInterval(() => poll(), 1000);
  }
  return () => {
    panels.delete(listener);
    if (!panels.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Ask now, after a change was written: a poll already under way may have missed it. */
export async function poll(changed = false): Promise<void> {
  const request = panels.values().next().value;
  if (!request) return;
  if (polling) {
    again = again || changed;
    return;
  }
  polling = true;
  try {
    // Nothing held yet, or what is held is not trusted: fetch the board straight away, as it
    // carries its own version. Otherwise ask the version first, which is cheap.
    const latest = version === null ? null : ((await request("GET", "/api/version")) as { version: string });
    if (!latest || latest.version !== version) {
      const board = (await request("GET", "/api/board")) as BoardData;
      version = board.version;
      publish({ board, down: false, error: "" });
    } else if (feed.down) publish({ down: false, error: "" });
    answered = new Date();
  } catch (e) {
    version = null;
    const error = e instanceof Error ? e.message : String(e);
    // While the server is away the same failure comes back every second: that is no news.
    if (!feed.down || feed.error !== error) publish({ down: true, error });
  } finally {
    polling = false;
    if (again) {
      again = false;
      poll();
    }
  }
}

/** When the server last answered. */
export function answeredAt(): Date | null {
  return answered;
}

/** Show an item as the server returned it after a change, before the refresh that follows. */
export function replaceItem(item: BoardData["items"][number]) {
  if (feed.board) publish({ board: { ...feed.board, items: feed.board.items.map((i) => (i.id === item.id ? item : i)) } });
}
