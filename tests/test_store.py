import io
import json
from datetime import datetime, timedelta, timezone

import pytest

from vibeboard import cli, store


@pytest.fixture(autouse=True)
def tmp_home(tmp_path, monkeypatch):
    monkeypatch.setenv("VIBEBOARD_HOME", str(tmp_path))
    monkeypatch.delenv("PASEO_AGENT_ID", raising=False)
    monkeypatch.delenv("CLAUDE_JOB_DIR", raising=False)
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    return tmp_path


def test_project_key_matches_claude_code():
    assert store.project_key("/Users/x/Desktop/Dots_work") == "-Users-x-Desktop-Dots-work"


def test_create_writes_one_file_per_item(tmp_home):
    item = store.create("Ship v1.1", "/tmp/proj", origin="plan")
    path = tmp_home / "projects" / store.project_key("/tmp/proj") / "items" / f"{item['id']}.json"
    assert json.loads(path.read_text())["title"] == "Ship v1.1"
    assert store.get(item["id"])["status"] == "todo"
    assert store.projects()[store.project_key("/tmp/proj")]["path"] == "/tmp/proj"


def test_update_moves_file_when_project_changes(tmp_home):
    item = store.create("x", "/tmp/a")
    store.update(item["id"], project="/tmp/b")
    assert not list((tmp_home / "projects" / store.project_key("/tmp/a") / "items").iterdir())
    assert store.get(item["id"])["project"] == "/tmp/b"


def test_validation():
    item = store.create("x", "/tmp/a")
    with pytest.raises(ValueError):
        store.update(item["id"], status="nope")
    with pytest.raises(ValueError):
        store.update(item["id"], origin="issue")  # history, not editable
    with pytest.raises(ValueError):
        store.update(item["id"], driver=store.ME)  # the driver is a session or nothing
    with pytest.raises(ValueError):
        store.update(item["id"], parent=item["id"])
    with pytest.raises(KeyError):
        store.update(item["id"], depends_on=["missing"])
    with pytest.raises(ValueError):
        store.update(item["id"], due="tomorrow")


def test_done_sets_done_at_and_archive_moves_file(tmp_home):
    item = store.create("x", "/tmp/a")
    step = store.create("step", "/tmp/a", parent=item["id"])
    store.update(step["id"], status="done")
    assert store.update(item["id"], status="done")["done_at"]
    assert [i["id"] for i in store.archive(item["id"])] == [item["id"], step["id"]]
    assert not store.load_all()
    assert item["id"] in store.load_all(archived=True)
    store.archive(item["id"], restore=True)
    assert set(store.load_all()) == {item["id"], step["id"]}


def test_finished_tasks_leave_the_board_after_the_set_days(monkeypatch):
    def finish(item, days_ago):
        moment = datetime.now(timezone.utc) - timedelta(days=days_ago)
        with monkeypatch.context() as clock:
            clock.setattr(store, "now", lambda: store._iso(moment))
            return store.update(item["id"], status="done")

    old = store.create("Shipped long ago", "/tmp/proj")
    old_step = finish(store.create("Its step", "/tmp/proj", parent=old["id"]), 9)
    old = finish(old, 8)
    recent = finish(store.create("Shipped yesterday", "/tmp/proj"), 1)
    open_task = store.create("Still going", "/tmp/proj")
    done_step = finish(store.create("Its finished step", "/tmp/proj", parent=open_task["id"]), 30)

    moved = store.archive_finished()
    assert {i["id"] for i in moved} == {old["id"], old_step["id"]}
    assert set(store.load_all()) == {recent["id"], open_task["id"], done_step["id"]}
    kept = store.load_all(archived=True)
    assert kept[old["id"]]["done_at"] == old["done_at"]  # the archive records what got done
    assert store.archive(old["id"], restore=True)[0]["id"] == old["id"]

    store.set_archive_after_days(None)
    assert store.archive_finished() == []
    store.set_archive_after_days(60)
    assert store.archive_finished() == []
    store.set_archive_after_days(3)
    assert {i["id"] for i in store.archive_finished()} == {old["id"], old_step["id"]}
    for bad in (0, -1, 1.5, "7", True):
        with pytest.raises(ValueError):
            store.set_archive_after_days(bad)
    assert store.archive_after_days() == 3


def test_identity_follows_the_pane(monkeypatch):
    assert store.identity() == (store.ME, None)
    monkeypatch.setenv("PASEO_AGENT_ID", "abc-123")
    store.set_pane("ABC-123", session="s1", project="/tmp/a")
    assert store.identity() == ("s1", "/tmp/a")
    store.set_pane("ABC-123", ended_at=store.now())
    assert store.identity() == (store.ME, None)


def test_resolve_by_id_prefix_title_or_old_number():
    a = store.create("Fix the flaky login test", "/tmp/a")
    b = store.create("Write the design doc", "/tmp/a")
    items = store.load_all()
    assert store.resolve(a["id"]) == a["id"]
    assert store.resolve(store.short(a["id"], items)) == a["id"]
    assert store.resolve("flaky") == a["id"]
    assert store.resolve("DESIGN doc") == b["id"]
    with pytest.raises(ValueError):
        store.resolve("the")  # in both titles
    with pytest.raises(KeyError):
        store.resolve("nothing like this")
    old = store.load_all()[b["id"]]
    old["num"] = 7  # written by 0.1
    store._write_json(store._item_path(old), old)
    assert store.resolve("#7") == b["id"]


def test_a_project_sees_items_filed_under_its_subdirectories():
    assert store.within("/w/a", "/w")
    assert store.within("/w", "/w")
    assert not store.within("/wx", "/w")
    assert not store.within("/w", "/w/a")


def test_an_item_is_done_only_when_its_steps_are():
    item = store.create("item", "/tmp/a")
    step = store.create("step", "/tmp/a", parent=item["id"])
    with pytest.raises(ValueError):
        store.update(item["id"], status="done")  # a step is still open
    store.update(step["id"], status="done")
    store.update(item["id"], status="done")
    with pytest.raises(ValueError):
        store.create("afterthought", "/tmp/a", parent=item["id"])  # reopen it first
    store.update(item["id"], status="doing")
    store.create("afterthought", "/tmp/a", parent=item["id"])


def test_two_levels_only_and_migrate_flattens():
    item = store.create("item", "/tmp/a")
    step = store.create("step", "/tmp/a", parent=item["id"])
    with pytest.raises(ValueError):
        store.create("sub-step", "/tmp/a", parent=step["id"])
    with pytest.raises(ValueError):
        store.update(item["id"], parent=step["id"])  # it has steps, it stays an item
    deep = store.load_all()[step["id"]]
    deep["parent"] = step["id"]  # a 0.1 file nested three deep
    deep["id"] = "deadbe"
    store._write_json(store._item_path(deep), deep)
    assert store.migrate() == {"flattened": 1}
    assert store.load_all()["deadbe"]["parent"] == item["id"]


def test_corrupt_item_file_loses_only_that_item(tmp_home):
    keep = store.create("keep", "/tmp/a")
    bad = tmp_home / "projects" / store.project_key("/tmp/a") / "items" / "bad.json"
    bad.write_text("{not json")
    assert set(store.load_all()) == {keep["id"]}


def test_hooks_record_the_session_in_its_paseo_agent(monkeypatch):
    monkeypatch.setenv("PASEO_AGENT_ID", "41deff53-1a3e")

    def feed(e):
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(e)))

    feed({"hook_event_name": "SessionStart", "session_id": "agent", "cwd": "/tmp/a"})
    cli.main(["hook"])
    assert store.get_pane("41DEFF53-1A3E")["session"] == "agent"
    assert store.identity() == ("agent", "/tmp/a")
    feed({"hook_event_name": "SessionEnd", "session_id": "agent"})
    cli.main(["hook"])
    assert store.identity() == (store.ME, None)


def test_nested_session_hands_the_pane_back(monkeypatch):
    monkeypatch.setenv("PASEO_AGENT_ID", "abc-123")

    def feed(e):
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(e)))

    feed({"hook_event_name": "SessionStart", "session_id": "outer", "cwd": "/tmp/a"})
    cli.main(["hook"])
    feed({"hook_event_name": "SessionStart", "session_id": "inner", "cwd": "/tmp/a/scratch"})
    cli.main(["hook"])
    assert store.identity() == ("inner", "/tmp/a/scratch")
    feed({"hook_event_name": "SessionEnd", "session_id": "inner"})
    cli.main(["hook"])
    assert store.identity() == ("outer", "/tmp/a")  # the agent's own `claude -p` came and went
    feed({"hook_event_name": "SessionEnd", "session_id": "outer"})
    cli.main(["hook"])
    assert store.identity() == (store.ME, None)


def test_background_job_leaves_the_launching_pane_alone(monkeypatch):
    monkeypatch.setenv("PASEO_AGENT_ID", "abc-123")
    store.set_pane("ABC-123", session="fg", project="/tmp/a")
    monkeypatch.setenv("CLAUDE_JOB_DIR", "/tmp/jobs/bg")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "bg")
    assert store.identity() == ("bg", None)
    for name in ("SessionStart", "SessionEnd"):
        event = {"hook_event_name": name, "session_id": "bg", "cwd": "/tmp/b"}
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
        assert cli.main(["hook"]) == 0
        assert store.get_pane("ABC-123")["session"] == "fg"
    monkeypatch.delenv("CLAUDE_JOB_DIR")
    assert store.identity() == ("fg", "/tmp/a")


def test_out_of_order_session_end_does_not_restore_finished_session(monkeypatch):
    monkeypatch.setenv("PASEO_AGENT_ID", "abc-123")
    for session in ["root", "first", "second"]:
        cli._pane_start(session, "/tmp/" + session)
    cli._pane_end("first")
    assert store.identity() == ("second", "/tmp/second")
    cli._pane_end("second")
    assert store.identity() == ("root", "/tmp/root")
    assert store.get_pane("ABC-123")["outer"] == []


def test_resuming_outer_session_discards_stale_inner_chain(monkeypatch):
    monkeypatch.setenv("PASEO_AGENT_ID", "abc-123")
    cli._pane_start("root", "/tmp/root")
    started = store.get_pane("ABC-123")["started_at"]
    for session in ["first", "second"]:
        cli._pane_start(session, "/tmp/" + session)
    cli._pane_start("root", "/tmp/root")
    assert store.identity() == ("root", "/tmp/root")
    assert store.get_pane("ABC-123")["started_at"] == started
    assert store.get_pane("ABC-123")["outer"] == []
    before = store.get_pane("ABC-123")
    cli._pane_end("second")  # a late hook from the discarded session
    assert store.get_pane("ABC-123") == before
    cli._pane_end("root")
    assert store.identity() == (store.ME, None)


def test_start_and_done_times_come_from_the_clock():
    item = store.create("a", "/tmp/a")
    assert item["started_at"] is None
    started = store.update(item["id"], status="doing")["started_at"]
    assert started
    assert store.update(item["id"], status="waiting")["started_at"] == started  # first start sticks
    assert store.update(item["id"], status="done")["done_at"]
    with pytest.raises(ValueError):
        store.update(item["id"], started_at="2026-01-01")


def test_priority_is_normal_unless_set(tmp_home):
    item = store.create("x", "/tmp/a")
    assert item["priority"] == "normal"
    assert store.update(item["id"], priority="high", due="2026-12-01")["priority"] == "high"
    with pytest.raises(ValueError):
        store.update(item["id"], priority="urgent")
    # An item written before there were priorities reads as normal.
    path = next((tmp_home / "projects").glob(f"*/items/{item['id']}.json"))
    data = json.loads(path.read_text())
    del data["priority"]
    path.write_text(json.dumps(data))
    assert store.get(item["id"])["priority"] == "normal"


def test_high_priority_needs_a_due_date():
    with pytest.raises(ValueError, match="due date"):
        store.create("x", "/tmp/a", priority="high")
    task = store.create("x", "/tmp/a")
    with pytest.raises(ValueError, match="due date"):
        store.update(task["id"], priority="high")
    step = store.create("y", "/tmp/a", parent=task["id"])
    with pytest.raises(ValueError, match="due date"):
        store.update(step["id"], priority="high")
    store.update(step["id"], priority="high", due="2026-12-01")
    # The date can move but not go away while the item is high.
    assert store.update(step["id"], due="2026-12-05")["due"] == "2026-12-05"
    with pytest.raises(ValueError, match="due date"):
        store.update(step["id"], due=None)
    assert store.update(step["id"], priority="normal")["priority"] == "normal"
    assert store.update(step["id"], due=None)["due"] is None
    # Normal items never need one.
    assert store.update(task["id"], title="x2")["due"] is None


def test_cli_sets_priority_and_list_marks_high_items(capsys):
    def line(title):
        cli.main(["list", "--project", "/tmp/a"])
        return next(row for row in capsys.readouterr().out.splitlines() if title in row)

    assert cli.main(["add", "Fix the login", "--project", "/tmp/a", "--priority", "high"]) == 1
    assert "due date" in capsys.readouterr().err
    cli.main(
        ["add", "Fix the login", "--project", "/tmp/a", "--priority", "high", "--due", "2026-12-01"]
    )
    cli.main(["add", "Tidy the docs", "--project", "/tmp/a"])
    capsys.readouterr()
    assert line("Fix the login").endswith("Fix the login  [high, due 2026-12-01]")
    assert line("Tidy the docs").endswith("Tidy the docs")
    cli.main(["set", "Fix the login", "--priority", "normal"])
    capsys.readouterr()
    assert line("Fix the login").endswith("Fix the login")


def test_description_is_free_text():
    item = store.create("a", "/tmp/a", description="why\nand how")
    assert item["description"] == "why\nand how"
    assert store.update(item["id"], description=None)["description"] == ""


def test_hook_records_the_pane(monkeypatch, tmp_path):
    monkeypatch.setenv("PASEO_AGENT_ID", "abc-123")
    event = {"hook_event_name": "SessionStart", "session_id": "s1", "cwd": "/tmp/a"}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
    assert cli.main(["hook"]) == 0
    assert store.identity() == ("s1", "/tmp/a")
    # started again (resume, compaction) after a cd in the shell: the project is the
    # directory Claude Code files the transcript under, decoded from the transcript
    proj = tmp_path / "proj"
    (proj / "sub").mkdir(parents=True)
    transcript = tmp_path / store.project_key(str(proj)) / "s1.jsonl"
    transcript.parent.mkdir()
    records = [{"cwd": "/tmp/elsewhere"}, {"cwd": f"{proj}/sub"}, {"cwd": str(proj)}]
    transcript.write_text("".join(json.dumps(r) + "\n" for r in records))
    again = {**event, "cwd": f"{proj}/sub", "transcript_path": str(transcript)}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(again)))
    assert cli.main(["hook"]) == 0
    assert store.identity() == ("s1", str(proj))
    monkeypatch.setattr(
        "sys.stdin", io.StringIO(json.dumps({**event, "hook_event_name": "SessionEnd"}))
    )
    assert cli.main(["hook"]) == 0
    assert store.identity() == (store.ME, None)
    monkeypatch.setattr("sys.stdin", io.StringIO("not json"))
    assert cli.main(["hook"]) == 0
