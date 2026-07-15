#!/usr/bin/env python3
"""Turn Codex lifecycle hook events into Remote Notifier messages.

This hook is deliberately best-effort: every failure exits successfully so it
can never block a Codex turn or influence an approval decision.
"""

from __future__ import annotations

import glob
import json
import os
import re
import socket
import sqlite3
import sys
import unicodedata
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_PREVIEW_LENGTH = 16
MAX_INPUT_BYTES = 1024 * 1024
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()


def _clean_visible_text(value: str) -> str:
    value = ANSI_ESCAPE.sub("", value)
    cleaned: list[str] = []
    pending_space = False
    for char in value.strip():
        category = unicodedata.category(char)
        if char.isspace():
            pending_space = bool(cleaned)
            continue
        if category.startswith("C") and char != "\u200d":
            continue
        if pending_space:
            cleaned.append(" ")
            pending_space = False
        cleaned.append(char)
    return "".join(cleaned)


def _truncate_visible(value: str, limit: int) -> str:
    value = _clean_visible_text(value)
    if limit < 1:
        limit = DEFAULT_PREVIEW_LENGTH

    result: list[str] = []
    visible = 0
    for char in value:
        category = unicodedata.category(char)
        increments = not (
            unicodedata.combining(char)
            or category in {"Cf", "Mn", "Me"}
            or char in {"\ufe0e", "\ufe0f"}
        )
        if increments and visible >= limit:
            break
        result.append(char)
        if increments:
            visible += 1
    return "".join(result).rstrip()


def _title_from_sqlite(codex_home: Path, session_id: str) -> str | None:
    paths = glob.glob(str(codex_home / "state_*.sqlite"))
    def modified_at(item: str) -> float:
        try:
            return os.path.getmtime(item)
        except OSError:
            return 0

    paths.sort(key=modified_at, reverse=True)
    for db_path in paths:
        connection: sqlite3.Connection | None = None
        try:
            uri = Path(db_path).resolve().as_uri() + "?mode=ro"
            connection = sqlite3.connect(uri, uri=True, timeout=0.1)
            row = connection.execute(
                "SELECT title FROM threads WHERE id = ? AND title <> '' LIMIT 1",
                (session_id,),
            ).fetchone()
            if row and isinstance(row[0], str) and row[0].strip():
                return row[0]
        except (OSError, sqlite3.Error):
            continue
        finally:
            if connection is not None:
                connection.close()
    return None


def _title_from_session_index(codex_home: Path, session_id: str) -> str | None:
    try:
        lines = (codex_home / "session_index.jsonl").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None

    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            continue
        if entry.get("id") != session_id:
            continue
        title = entry.get("thread_name")
        if isinstance(title, str) and title.strip():
            return title
    return None


def _answer_preview(event: dict[str, Any], transcript_message: str | None = None) -> str | None:
    message = event.get("last_assistant_message")
    if not isinstance(message, str) or not message.strip():
        message = transcript_message
    if isinstance(message, str) and message.strip():
        without_plan_tags = re.sub(
            r"</?proposed_plan\s*>", "", message, flags=re.IGNORECASE
        ).strip()
        if without_plan_tags:
            return without_plan_tags
    return None


def _notification_preview_parts(
    event: dict[str, Any], transcript_message: str | None = None
) -> list[str]:
    session_id = str(event.get("session_id") or "")
    renamed_title: str | None = None
    if session_id:
        codex_home = _codex_home()
        renamed_title = _title_from_session_index(codex_home, session_id)

    answer = _answer_preview(event, transcript_message)
    if renamed_title:
        return [renamed_title, answer] if answer else [renamed_title]
    if answer:
        return [answer]

    if session_id:
        title = _title_from_sqlite(codex_home, session_id)
        if title:
            return [title]

    cwd = event.get("cwd")
    if isinstance(cwd, str) and cwd.strip():
        return [Path(cwd).name or cwd]
    return ["Codex"]


def _transcript_turn_info(event: dict[str, Any]) -> tuple[bool, bool, str | None]:
    transcript_path = event.get("transcript_path")
    turn_id = event.get("turn_id")
    if not isinstance(transcript_path, str) or not transcript_path.strip():
        return False, False, None
    if not isinstance(turn_id, str) or not turn_id.strip():
        return False, False, None

    try:
        with Path(transcript_path).expanduser().open("rb") as transcript:
            transcript.seek(0, os.SEEK_END)
            size = transcript.tell()
            offset = max(0, size - MAX_TRANSCRIPT_BYTES)
            transcript.seek(max(0, offset - 1))
            data = transcript.read(MAX_TRANSCRIPT_BYTES + (1 if offset else 0))
    except OSError:
        return False, False, None

    if offset:
        if data[:1] == b"\n":
            data = data[1:]
        else:
            newline = data.find(b"\n")
            if newline < 0:
                return False, False, None
            data = data[newline + 1 :]

    is_plan_mode = False
    has_plan_item = False
    plan_text: str | None = None
    for raw_line in data.splitlines():
        try:
            record = json.loads(raw_line)
        except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict):
            continue
        payload = record.get("payload")
        if not isinstance(payload, dict) or payload.get("turn_id") != turn_id:
            continue

        if record.get("type") == "turn_context":
            collaboration_mode = payload.get("collaboration_mode")
            if (
                isinstance(collaboration_mode, dict)
                and collaboration_mode.get("mode") == "plan"
            ):
                is_plan_mode = True
        elif record.get("type") == "event_msg" and payload.get("type") == "item_completed":
            item = payload.get("item")
            if isinstance(item, dict) and str(item.get("type") or "").lower() == "plan":
                has_plan_item = True
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    plan_text = text

    return is_plan_mode, has_plan_item, plan_text


def _notification_kind(
    event: dict[str, Any], transcript_info: tuple[bool, bool, str | None] | None = None
) -> tuple[str, str] | None:
    event_name = event.get("hook_event_name")
    if event_name == "Stop":
        message = event.get("last_assistant_message")
        if transcript_info is None:
            transcript_info = _transcript_turn_info(event)
        is_plan_mode, has_plan_item, _ = transcript_info
        has_plan_tag = isinstance(message, str) and re.search(
            r"<proposed_plan\s*>", message, re.IGNORECASE
        )
        if has_plan_item or has_plan_tag:
            return "[计划完成]", "plan-complete"
        if is_plan_mode:
            return "[计划继续]", "plan-continue"
        return "[任务完成]", "task-complete"
    if event_name == "PreToolUse" and event.get("tool_name") == "request_user_input":
        return "[等待回答]", "waiting-answer"
    if event_name == "PermissionRequest":
        return "[等待授权]", "waiting-permission"
    return None


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError, TypeError):
        return {}


def _normalized_path(value: str) -> str | None:
    try:
        return os.path.normcase(os.path.abspath(os.path.normpath(value)))
    except (OSError, TypeError, ValueError):
        return None


def _workspace_match_length(session_info: dict[str, Any], cwd: str) -> int:
    normalized_cwd = _normalized_path(cwd)
    if not normalized_cwd:
        return -1

    folders = session_info.get("workspaceFolders")
    if not isinstance(folders, list):
        folders = [session_info.get("workspaceFolder")]

    best = -1
    for folder in folders:
        if not isinstance(folder, str) or not folder:
            continue
        normalized_folder = _normalized_path(folder)
        if not normalized_folder:
            continue
        try:
            if os.path.commonpath([normalized_cwd, normalized_folder]) == normalized_folder:
                best = max(best, len(normalized_folder))
        except ValueError:
            continue
    return best


def _read_session_info(event: dict[str, Any]) -> dict[str, Any]:
    env_session_file = os.environ.get("REMOTE_NOTIFIER_SESSION_FILE")
    if env_session_file:
        env_info = _read_json_object(Path(env_session_file).expanduser())
        if env_info:
            return env_info

    session_directory = Path("~/.remote-notifier").expanduser()
    cwd = event.get("cwd")
    if isinstance(cwd, str) and cwd:
        matches: list[tuple[int, str, dict[str, Any]]] = []
        for session_path in (session_directory / "sessions").glob("*.json"):
            session_info = _read_json_object(session_path)
            match_length = _workspace_match_length(session_info, cwd)
            if match_length >= 0:
                created_at = session_info.get("createdAt")
                matches.append(
                    (
                        match_length,
                        created_at if isinstance(created_at, str) else "",
                        session_info,
                    )
                )
        if matches:
            return max(matches, key=lambda match: (match[0], match[1]))[2]

    return _read_json_object(session_directory / "session.json")


def _preview_length(session_info: dict[str, Any]) -> int:
    raw = session_info.get(
        "codexPreviewLength", os.environ.get("REMOTE_NOTIFIER_CODEX_PREVIEW_LENGTH")
    )
    try:
        return max(1, min(100, int(raw)))
    except (TypeError, ValueError):
        return DEFAULT_PREVIEW_LENGTH


def _send(
    event: dict[str, Any],
    title: str,
    event_key: str,
    transcript_message: str | None = None,
) -> None:
    session_info = _read_session_info(event)
    endpoints: list[tuple[str, str]] = []
    env_url = os.environ.get("REMOTE_NOTIFIER_URL")
    env_token = os.environ.get("REMOTE_NOTIFIER_TOKEN")
    if env_url and env_token:
        endpoints.append((env_url, env_token))

    session_port = session_info.get("port")
    session_token = session_info.get("token")
    if session_port and isinstance(session_token, str) and session_token:
        session_endpoint = (f"http://127.0.0.1:{session_port}/notify", session_token)
        if session_endpoint not in endpoints:
            endpoints.append(session_endpoint)

    if not endpoints:
        return

    preview_length = _preview_length(session_info)
    preview_parts = [
        _truncate_visible(part, preview_length)
        for part in _notification_preview_parts(event, transcript_message)
    ]
    preview = " · ".join(part for part in preview_parts if part) or "Codex"
    body = {
        "title": title,
        "message": f"{socket.gethostname()} · {preview}",
        "level": "information",
        "display_hint": "system",
        "icon": "ICON_CODEX",
        "source": "codex",
        "session_id": str(event.get("session_id") or ""),
        "turn_id": str(event.get("turn_id") or ""),
        "event_key": event_key,
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    for url, token in endpoints:
        async_url = f"{url}/async" if url.endswith("/notify") else url
        request = urllib.request.Request(
            async_url,
            data=data,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=0.6) as response:
                response.read(1024)
            return
        except Exception:
            continue


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if not raw or len(raw) > MAX_INPUT_BYTES:
            return 0
        event = json.loads(raw.decode("utf-8"))
        if not isinstance(event, dict):
            return 0
        transcript_info = (
            _transcript_turn_info(event)
            if event.get("hook_event_name") == "Stop"
            else (False, False, None)
        )
        kind = _notification_kind(event, transcript_info)
        if kind:
            _send(event, *kind, transcript_message=transcript_info[2])
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
