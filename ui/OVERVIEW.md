Vibe Board is a progress board for the work you hand to coding agents. The items on it are yours: tasks, their steps, what waits for what, and which agent is pushing each one. Agents read and update the same board through a command line tool, so the panel beside them shows what they are doing and what is waiting for you.

The panel draws the board as one list, the way a git graph draws history: prerequisites above what waits for them, a lane for each dependency, and a task's steps branching off below it. Every item records its status, the session pushing it, the next step, what it waits for, and why it exists: part of the plan, a problem found on the way, or scope added later.

The panel is only the view. The board, its local server and the agent integration come from the [vibe-board repository](https://github.com/KosmoCHE/vibe-board) and need to be set up first. On macOS with Python 3.9 or newer (the one in Xcode's command line tools is enough), clone the repository and run `./install.sh` from the clone. It sets up:

- the `vibeboard` command that agents use, in `~/.vibe-board/bin`, put on your PATH through `~/.zshrc` when zsh is your shell;
- the board server, kept running by launchd and listening only on 127.0.0.1:47431;
- a Claude Code skill with the board's rules, and `SessionStart` and `SessionEnd` hooks in `~/.claude/settings.json` that record which session each agent runs.

iTerm2 is optional. The installer also registers a panel for iTerm2's toolbelt, which shows the same board, but the server and this panel work without it. Run `./install.sh` again after updating the clone; `./install.sh --uninstall` removes all of it and keeps your items.

In the panel:

- Global shows everything, grouped by project, with the name of the project you are scrolling through kept at the top, and can be narrowed to one project or session. Project shows the items filed under the workspace's directory, and what its agents push wherever it is filed. Workspace shows what the workspace's agents are pushing; press an agent's name to see only its items.
- Press an item's dot to tick it off. Press an item for its details, and Edit to change its title, description, status, priority, driver, next step, what it waits for, or due date. The details also add a step, copy the title and delete; right-click a row to copy its title or ID, or to mark it high priority. The `+` adds an item, and Undo takes back the last change.
- High-priority items need a due date: marking one that has none opens its details on the date, and both are saved together. They come first in their level, below what they wait for, with a red wash, a red bar at the panel's edge and the due date, red once it has passed. A folded task that hides a high step shows a fainter one. Above the list, every tab keeps a box of all open high-priority items on the board, soonest due first, six at a time with the rest a scroll away; press one to show it in the list, on Global when the tab does not hold it.
- Selecting an item lights up everything upstream and downstream of it.
- Press an agent's badge to open that agent. When its session has ended, the badge greys out and pressing it lets you hand the item to another session.
- Two settings are shared with the iTerm2 panel: one text size for the whole panel, and how many days finished tasks stay before they are archived (seven by default, or never). They are on this plugin's page under Settings → Plugins, which the gear in the panel also opens.

Agents follow the skill's rules: they write their plan as steps before starting, register anything unplanned before handling it, and say which planned step comes next once a detour is done. An agent is recognised by the Claude Code session running in it. Other agents can still run `vibeboard`, but the board records their changes as yours.

What it reads and sends:

- The plugin reads the token in `~/.vibe-board/token` (or under `VIBEBOARD_HOME` when that is set) and sends every board request, with that token, to the server at 127.0.0.1:47431. It contacts nothing else.
- It lists Paseo's agents to tell which ones belong to this workspace, opens an agent when you press its badge, and remembers each panel's tab and folded tasks.
- The board server keeps one JSON file per item under `~/.vibe-board/projects/`, the settings in `~/.vibe-board/config.json`, and archived tasks beside the live ones. To show the names of live sessions it runs `paseo ls` and, when iTerm2 is installed, iTerm2's `it2` tool.

Known limits: the board runs on macOS only, and it is at version 0.1, so its data format may still change before 1.0. When you rewind an agent in Paseo, the agent continues in a new Claude Code session and its items stay with the old one until it takes them back with `vibeboard claim`.
