#!/usr/bin/env python3
"""Forward a minimal Codex hook event and return a valid no-op response."""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


MAX_INPUT_BYTES = 256 * 1024
MAX_SESSION_BYTES = 64 * 1024
MAX_PROCESS_ANCESTRY = 24
TOTAL_DEADLINE_SECONDS = 1.35
HTTP_TIMEOUT_SECONDS = 0.55
SUPPORTED_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PreToolUse",
    "PermissionRequest",
}


def _windows_parent_processes() -> dict[int, int]:
    if os.name != "nt":
        return {}

    from ctypes import wintypes

    class ProcessEntry32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        return {}
    parents: dict[int, int] = {}
    entry = ProcessEntry32()
    entry.dwSize = ctypes.sizeof(ProcessEntry32)
    try:
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return {}
        while True:
            parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return parents


def _linux_parent_process(process_id: int) -> int | None:
    try:
        stat = Path(f"/proc/{process_id}/stat").read_text(encoding="utf-8")
        fields = stat[stat.rfind(")") + 2 :].split()
        return int(fields[1]) if len(fields) > 1 else None
    except (OSError, ValueError):
        return None


def _posix_parent_processes() -> dict[int, int]:
    if os.name != "posix" or Path("/proc/self/stat").exists():
        return {}
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,ppid="],
            check=True,
            capture_output=True,
            text=True,
            timeout=0.35,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    parents: dict[int, int] = {}
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        try:
            parents[int(fields[0])] = int(fields[1])
        except ValueError:
            pass
    return parents


def _process_ancestry() -> list[int]:
    ancestry: list[int] = []
    process_id = os.getpid()
    seen = {process_id}
    windows_parents = _windows_parent_processes()
    posix_parents = _posix_parent_processes()
    for _ in range(MAX_PROCESS_ANCESTRY):
        if windows_parents:
            parent_id = windows_parents.get(process_id)
        elif posix_parents:
            parent_id = posix_parents.get(process_id)
        elif os.name == "posix":
            parent_id = _linux_parent_process(process_id)
        elif process_id == os.getpid():
            parent_id = os.getppid()
        else:
            parent_id = None
        if not parent_id or parent_id <= 1 or parent_id in seen:
            break
        ancestry.append(parent_id)
        seen.add(parent_id)
        process_id = parent_id
    return ancestry


def _read_small_json(path_value: str | None) -> dict[str, Any]:
    if not path_value:
        return {}
    try:
        with Path(path_value).expanduser().open("rb") as source:
            raw = source.read(MAX_SESSION_BYTES + 1)
        if len(raw) > MAX_SESSION_BYTES:
            return {}
        value = json.loads(raw.decode("utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _event_url(raw_url: str) -> str | None:
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
            return None
        return urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, "/codex/events", "", "")
        )
    except (TypeError, ValueError):
        return None


def _endpoints() -> list[tuple[str, str]]:
    endpoints: list[tuple[str, str]] = []
    session_paths = [
        os.environ.get("REMOTE_NOTIFIER_SESSION_FILE"),
        str(Path("~/.remote-notifier/session.json").expanduser()),
    ]
    for session_path in session_paths:
        session = _read_small_json(session_path)
        port = session.get("port")
        token = session.get("token")
        if isinstance(port, int) and port > 0 and isinstance(token, str) and token:
            endpoints.append((f"http://127.0.0.1:{port}/codex/events", token))
            break

    raw_url = os.environ.get("REMOTE_NOTIFIER_URL")
    token = os.environ.get("REMOTE_NOTIFIER_TOKEN")
    event_url = _event_url(raw_url) if raw_url else None
    if event_url and token and (event_url, token) not in endpoints:
        endpoints.append((event_url, token))
    return endpoints


def _bounded_string(value: Any, maximum: int) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value[:maximum]


def _minimal_event(event: dict[str, Any]) -> dict[str, Any] | None:
    event_name = event.get("hook_event_name")
    if event_name not in SUPPORTED_EVENTS:
        return None
    if event_name == "PreToolUse" and event.get("tool_name") != "request_user_input":
        return None

    body: dict[str, Any] = {
        "version": 1,
        "kind": "hook",
        "hook_event_name": event_name,
        "process_ancestry": _process_ancestry(),
    }
    fields = {
        "session_id": (event.get("session_id"), 200),
        "turn_id": (event.get("turn_id"), 200),
        "cwd": (event.get("cwd"), 4096),
        "transcript_path": (event.get("transcript_path"), 4096),
        "last_assistant_message": (event.get("last_assistant_message"), 4000),
        "tool_name": (event.get("tool_name"), 200),
    }
    for name, (value, maximum) in fields.items():
        bounded = _bounded_string(value, maximum)
        if bounded:
            body[name] = bounded

    request_id = (
        _bounded_string(event.get("request_id"), 200)
        or _bounded_string(event.get("tool_use_id"), 200)
        or _bounded_string(event.get("hook_id"), 200)
    )
    if request_id:
        body["request_id"] = request_id
    if os.environ.get("REMOTE_NOTIFIER_CODEX_PROTOCOL_SESSION") == "1":
        body["protocol_authoritative"] = True
    return body


def _send(body: dict[str, Any], deadline: float) -> None:
    data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    for url, token in _endpoints():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=min(HTTP_TIMEOUT_SECONDS, remaining)
            ) as response:
                if response.status == 202:
                    return
        except Exception:
            pass


def _write_noop_response() -> None:
    try:
        sys.stdout.write('{"continue":true}\n')
        sys.stdout.flush()
    except Exception:
        pass


def main() -> int:
    deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if not raw or len(raw) > MAX_INPUT_BYTES:
            return 0
        event = json.loads(raw.decode("utf-8"))
        if not isinstance(event, dict):
            return 0
        body = _minimal_event(event)
        if body:
            _send(body, deadline)
    except Exception:
        pass
    finally:
        _write_noop_response()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
