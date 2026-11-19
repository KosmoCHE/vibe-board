# Claude Code adapter

Two pieces, nothing else:

- **A skill** (`skills/vibeboard/SKILL.md`) that tells the agent how to use the
  board: plan first, register the unplanned before handling it, say what comes
  next after a detour. `vibeboard instructions` prints the same text, so the
  skill is the single source.
- **Two hooks** (`settings.json`) that record which Paseo agent a session runs
  in. `vibeboard hook` reads the hook event from stdin: `SessionStart` maps the
  agent to the session and its launch directory, `SessionEnd` marks it ended.
  It never prints and never fails the session.

The agent is taken from `PASEO_AGENT_ID`, which Paseo sets for every process an
agent starts. Outside Paseo the hook records nothing, and the board records
that session's changes as yours. A background job (`CLAUDE_JOB_DIR` set)
inherits the variable from the agent that launched it, so the hook records
nothing for it either; the board knows it by `CLAUDE_CODE_SESSION_ID`.

## Install

`./install.sh` at the top of the clone links the skill into `~/.claude/skills/`
and adds the two hooks to `~/.claude/settings.json`, pointing at the launcher
in `~/.vibe-board/bin/`. By hand, it is the same two steps:

```sh
ln -s "$PWD/adapters/claude-code/skills/vibeboard" ~/.claude/skills/vibeboard
# merge settings.json into ~/.claude/settings.json, with `vibeboard` on the hook shell's PATH
```

Start a new Claude Code agent in a Paseo workspace; the Workspace tab of the
panel there follows it.
