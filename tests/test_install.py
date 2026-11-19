"""Check the installer's cleanup without modifying the user's installation."""

import subprocess
from pathlib import Path

INSTALL = Path(__file__).resolve().parents[1] / "install.sh"
SETUP = INSTALL.read_text().split('case "${1:-}" in')[0]


def test_removes_only_our_old_iterm2_panel(tmp_path):
    autolaunch = "Scripts/AutoLaunch/vibeboard_panel.py"
    ours = tmp_path / ".config/iterm2/AppSupport" / autolaunch
    legacy = tmp_path / "Library/Application Support/iTerm2" / autolaunch
    other = tmp_path / ".iterm2/AppSupport" / autolaunch
    for link, target in (
        (ours, "/x/.vibe-board/runtime/current/iterm/vibeboard_panel.py"),
        (legacy, "/x/vibe-board/iterm/vibeboard_panel.py"),
        (other, "/x/someone-else/vibeboard_panel.py"),
    ):
        link.parent.mkdir(parents=True)
        link.symlink_to(target)
    # Stand-ins for the commands that would reach the real iTerm2.
    stubs = "pkill() { :; }\nforget_tool() { :; }\n"
    subprocess.run(
        ["sh", "-c", SETUP + stubs + "remove_iterm_panel"],
        env={"HOME": str(tmp_path), "PATH": "/usr/bin:/bin"},
        check=True,
    )
    assert not ours.is_symlink()
    assert not legacy.is_symlink()
    assert other.is_symlink()
