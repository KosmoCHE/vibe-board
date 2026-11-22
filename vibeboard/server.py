"""Local HTTP server: a small JSON API over the store, for the Paseo plugin.

Binds to 127.0.0.1 only. Every /api request must carry the token stored in the data
directory, where the plugin reads it.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from vibeboard import store

PASEO = shutil.which("paseo") or "/Applications/Paseo.app/Contents/Resources/bin/paseo"
LABELS = {
    "todo": "To do",
    "doing": "In progress",
    "waiting": "Waiting",
    "later": "Later",
    "done": "Done",
}
ARCHIVE_EVERY = 3600  # seconds between two looks for finished tasks to archive
SETTINGS = {"archive_after_days": store.set_archive_after_days, "text_size": store.set_text_size}


def note(text: str) -> None:
    """A line on stderr, which launchd sends to server.log.

    Started by hand, the server can outlive the terminal it prints to, leaving nobody to
    read stderr. The line is lost then; the request it came from is not.
    """
    try:
        print(text, file=sys.stderr, flush=True)
    except OSError:
        pass


class BoardServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, token: str | None):
        super().__init__(("127.0.0.1", port), Handler)
        self.token = token or secrets.token_urlsafe(24)
        self._names: tuple[dict, float] = ({}, 0.0)  # stamped 0: never listed
        self._listing = threading.Lock()  # held while a listing runs
        self._items: tuple[float, list] = (-1.0, [])  # the store's version, and its items then
        self._reading = threading.Lock()  # panels that ask together read the files once
        self._silent: set[str] = set()  # listing commands whose failure was already reported
        self.settings_changed = threading.Event()

    def _listed(self, command: list[str]) -> list[dict]:
        """What a host's own CLI lists, or nothing when it cannot be asked."""
        try:
            out = subprocess.run(command, capture_output=True, text=True, timeout=3)
            listed = json.loads(out.stdout)
        except (OSError, ValueError, subprocess.TimeoutExpired) as e:
            if command[0] not in self._silent:  # say it once, not every refresh
                note(f"vibeboard: {' '.join(command)} failed: {e!r}")
            self._silent.add(command[0])
            return []
        self._silent.discard(command[0])
        return listed

    def pane_names(self) -> dict[str, str]:
        """Names of the live Paseo agents, as Paseo shows them.

        Asking Paseo takes the better part of a second, and every open panel asks each
        second. So a request gets the last listing at once, and one more than 3 seconds old
        is renewed in the background, by one listing however many ask. Only the very first
        listing is waited for."""
        names, stamp = self._names
        if not stamp:
            with self._listing:
                if not self._names[1]:
                    self._names = (self._list_names(), time.time())
            return self._names[0]
        if time.time() - stamp >= 3 and self._listing.acquire(blocking=False):
            threading.Thread(target=self._relist, daemon=True).start()
        return names

    def _relist(self) -> None:
        try:
            self._names = (self._list_names(), time.time())
        finally:
            self._listing.release()

    def _list_names(self) -> dict[str, str]:
        return {
            a["id"].upper(): a.get("name") or ""
            for a in self._listed([PASEO, "ls", "--global", "--json"])
            if a.get("status") != "closed"
        }

    def items(self) -> list[dict]:
        """The store's items, read again only once its version has moved: reading every file
        takes a tenth of a second, and panels fetch the board whenever the version moves."""
        version = store.version()
        with self._reading:
            if self._items[0] != version:
                self._items = (version, list(store.load_all().values()))
            return self._items[1]

    def keep_archiving(self) -> None:
        """Take long-finished tasks off the board: now, hourly, and when the setting changes."""
        while True:
            try:
                store.archive_finished()
            except ValueError as e:  # config.json does not parse: look again once it is mended
                note(f"vibeboard: nothing archived: {e}")
            self.settings_changed.wait(ARCHIVE_EVERY)
            self.settings_changed.clear()

    def version(self) -> str:
        # Renaming a live session does not touch the task store.
        names = json.dumps(self.pane_names(), sort_keys=True).encode()
        return f"{store.version()}:{hashlib.sha256(names).hexdigest()}"

    def board(self) -> dict:
        names = self.pane_names()
        panes = {}
        for pane, info in store.panes().items():
            name = names.get(pane) or info.get("name", "")  # a stored name outlives the pane
            panes[pane] = dict(info, name=name, alive=pane in names)
        return {
            "version": self.version(),
            "projects": store.projects(),
            "panes": panes,
            "items": self.items(),
            "statuses": store.STATUSES,
            "labels": {**LABELS, **store.config().get("labels", {})},
            "settings": {
                "archive_after_days": store.archive_after_days(),
                "text_size": store.text_size(),
            },
            "me": store.ME,
        }


class Handler(BaseHTTPRequestHandler):
    server: BoardServer

    def log_message(self, fmt, *args) -> None:
        if os.environ.get("VIBEBOARD_DEBUG"):  # request log on stderr, for diagnosing the panel
            sys.stderr.write(f"{self.address_string()} {fmt % args}\n")

    # -- helpers ---------------------------------------------------------------

    def _send(self, status: int, body: bytes = b"", ctype: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, status: int = HTTPStatus.OK) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status)

    def _authorized(self, query: dict) -> bool:
        token = query.get("token", [None])[0] or self.headers.get("X-Vibeboard-Token")
        return token is not None and secrets.compare_digest(token, self.server.token)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    # -- routes ----------------------------------------------------------------

    def do_GET(self) -> None:
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if not self._authorized(query):
            self._error(HTTPStatus.UNAUTHORIZED, "bad token")
        elif url.path == "/api/version":
            self._json({"version": self.server.version()})
        elif url.path == "/api/board":
            try:
                self._json(self.server.board())
            except ValueError as e:  # the user's config.json does not parse
                self._error(HTTPStatus.BAD_REQUEST, str(e))
        else:
            self._error(HTTPStatus.NOT_FOUND, "not found")

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if not self._authorized(parse_qs(url.query)):
            self._error(HTTPStatus.UNAUTHORIZED, "bad token")
            return
        try:
            body = self._body()
            if url.path == "/api/items":
                title = body.pop("title", "")
                project = body.pop("project", None)
                if not project:
                    raise ValueError("project is required")
                self._json(store.create(title, project, **body), HTTPStatus.CREATED)
            elif url.path.startswith("/api/items/") and url.path.endswith("/archive"):
                self._json([i["id"] for i in store.archive(url.path.split("/")[3])])
            elif url.path.startswith("/api/items/") and url.path.endswith("/restore"):
                self._json([i["id"] for i in store.archive(url.path.split("/")[3], restore=True)])
            else:
                self._error(HTTPStatus.NOT_FOUND, "not found")
        except KeyError as e:
            self._error(HTTPStatus.NOT_FOUND, f"no such item {e}")
        except (ValueError, OSError) as e:
            self._error(HTTPStatus.BAD_REQUEST, str(e))

    def do_PATCH(self) -> None:
        url = urlparse(self.path)
        if not self._authorized(parse_qs(url.query)):
            self._error(HTTPStatus.UNAUTHORIZED, "bad token")
            return
        parts = url.path.split("/")
        try:
            if url.path == "/api/settings":
                body = self._body()
                if len(body) != 1 or not body.keys() <= SETTINGS.keys():
                    raise ValueError("settings: set one of " + ", ".join(SETTINGS))
                [(name, value)] = body.items()
                SETTINGS[name](value)
                self.server.settings_changed.set()  # a new archive rule applies right away
                self._json(body)
            elif len(parts) == 4 and parts[1:3] == ["api", "items"]:
                self._json(store.update(parts[3], **self._body()))
            else:
                self._error(HTTPStatus.NOT_FOUND, "not found")
        except KeyError as e:
            self._error(HTTPStatus.NOT_FOUND, f"no such item {e}")
        except ValueError as e:
            self._error(HTTPStatus.BAD_REQUEST, str(e))


DEFAULT_PORT = 47431


def stored_token() -> str:
    """One token per machine, kept on disk where the plugin reads it."""
    path = store.home() / "token"
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(24)
    path.write_text(token, encoding="utf-8")
    path.chmod(0o600)
    return token


def serve(
    port: int = DEFAULT_PORT, token: str | None = None, strict_port: bool = False
) -> BoardServer:
    token = token or stored_token()
    try:
        return BoardServer(port, token)
    except OSError:
        if port == 0 or strict_port:
            raise
        return BoardServer(0, token)  # the usual port is taken: any free one
