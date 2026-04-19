"""Pipeline notes logging utility.

Captures soft events and margin-player flags that pass validation but are
worth preserving for later review. Audit layer only — never blocks writes
or changes any existing gate behavior.

Writes to pipeline/pipeline_notes.json (gitignored runtime artifact).

Public API:
    log_flag(game_id, game_date, teams, ingest_result, flags)
    resolve_flag(game_id, flag_type, resolution_note)

Flag type constants are defined below. Every call must use one of them;
bare strings are allowed but discouraged.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional, Sequence


NOTES_PATH = Path(__file__).resolve().parent / "pipeline_notes.json"


# ─── Flag type constants ─────────────────────────────────────────────────────
# Severity legend:
#   info — normal, expected behavior worth preserving for traceability
#   soft — write proceeded but the case is unusual; worth human review eventually
#   hard — no write occurred; the game is in a failed-ingest state

PC2_TOLERANCE           = "PC2_TOLERANCE"            # soft
PC2_SECTION5_MATCH      = "PC2_SECTION5_MATCH"       # info
NAME_NORMALIZATION      = "NAME_NORMALIZATION"       # soft
MARGIN_PLAYER_OMISSION  = "MARGIN_PLAYER_OMISSION"   # info
INCOMPLETE_PA_SKIPPED   = "INCOMPLETE_PA_SKIPPED"    # info
PHANTOM_PITCHER_SKIPPED = "PHANTOM_PITCHER_SKIPPED"  # info
REGISTRY_UNKNOWN_TEAM   = "REGISTRY_UNKNOWN_TEAM"    # soft
GATE_FAILURE            = "GATE_FAILURE"             # hard
INGEST_RETRY_SUCCESS    = "INGEST_RETRY_SUCCESS"     # info

# Maps each constant to its canonical severity. Callers may override via the
# `severity` field on an individual flag dict if a specific case warrants it,
# but the default below is what the spec calls for.
DEFAULT_SEVERITY = {
    PC2_TOLERANCE:           "soft",
    PC2_SECTION5_MATCH:      "info",
    NAME_NORMALIZATION:      "soft",
    MARGIN_PLAYER_OMISSION:  "info",
    INCOMPLETE_PA_SKIPPED:   "info",
    PHANTOM_PITCHER_SKIPPED: "info",
    REGISTRY_UNKNOWN_TEAM:   "soft",
    GATE_FAILURE:            "hard",
    INGEST_RETRY_SUCCESS:    "info",
}

VALID_SEVERITIES = {"info", "soft", "hard"}
VALID_INGEST_RESULTS = {"success", "gate_failure", "skipped"}


# ─── Internal I/O helpers ────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty_store() -> dict:
    return {"entries": []}


def _load_store() -> dict:
    """Load pipeline_notes.json. On missing or corrupt file, back up any
    existing file and return a fresh empty store. Never raises — the logging
    layer must not crash the pipeline.
    """
    if not NOTES_PATH.exists():
        return _empty_store()
    try:
        with open(NOTES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
            raise ValueError("unexpected schema")
        return data
    except (json.JSONDecodeError, ValueError, OSError):
        # Corrupt or unreadable — preserve the original for forensic review,
        # then start fresh. Never raise.
        try:
            backup = NOTES_PATH.with_suffix(
                f".corrupt-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
            )
            shutil.move(str(NOTES_PATH), str(backup))
        except OSError:
            pass
        return _empty_store()


def _atomic_write(data: dict) -> None:
    """Write the store atomically: tmp file on the same filesystem, then rename.
    Avoids half-written files on interrupted pipeline runs.
    """
    NOTES_PATH.parent.mkdir(parents=True, exist_ok=True)
    # delete=False so we can rename after closing; caller cleans up on failure
    fd, tmp_path = tempfile.mkstemp(
        prefix=".pipeline_notes.",
        suffix=".tmp",
        dir=str(NOTES_PATH.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, NOTES_PATH)  # atomic on POSIX
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _normalize_flag(flag: dict) -> dict:
    """Return a flag dict with all required fields present and types sane."""
    flag_type = str(flag.get("flag_type") or "").strip()
    severity = flag.get("severity") or DEFAULT_SEVERITY.get(flag_type, "info")
    if severity not in VALID_SEVERITIES:
        severity = "info"
    team = flag.get("team")
    if team is not None:
        team = str(team)
    return {
        "flag_type":       flag_type,
        "severity":        severity,
        "team":            team,
        "detail":          str(flag.get("detail") or ""),
        "resolved":        bool(flag.get("resolved", False)),
        "resolution_note": flag.get("resolution_note"),
    }


def _find_entry(entries: List[dict], game_id: str) -> Optional[int]:
    for i, e in enumerate(entries):
        if e.get("game_id") == game_id:
            return i
    return None


def _flags_are_equivalent(a: dict, b: dict) -> bool:
    """Two flags are 'the same flag' if type + team + detail match.
    Used for deduplication on retry: re-logging the same soft event should
    not append a duplicate, but a different detail string is a distinct event.
    """
    return (
        a.get("flag_type") == b.get("flag_type") and
        a.get("team") == b.get("team") and
        a.get("detail") == b.get("detail")
    )


# ─── Public API ──────────────────────────────────────────────────────────────

def log_flag(
    game_id: str,
    game_date: str,
    teams: Sequence[str],
    ingest_result: str,
    flags: Iterable[dict],
) -> None:
    """Append or update a game entry in pipeline_notes.json.

    If an entry already exists for game_id (e.g. from a retry), merge:
      - update ingest_result and logged_at
      - append new flags; skip any that are equivalent to an existing flag
        (same flag_type + team + detail)
      - never drop or overwrite a resolved flag

    Silently no-ops on any I/O failure. Pipeline correctness must never
    depend on this function succeeding.
    """
    try:
        if ingest_result not in VALID_INGEST_RESULTS:
            # Defensive: coerce rather than raise. Unknown results probably
            # indicate a caller bug but we still want the audit trail.
            ingest_result = "success" if ingest_result == "ok" else str(ingest_result)

        normalized_flags = [_normalize_flag(f) for f in (flags or []) if f]

        store = _load_store()
        entries: List[dict] = store["entries"]
        idx = _find_entry(entries, game_id)

        if idx is None:
            entries.append({
                "game_id":       game_id,
                "game_date":     game_date,
                "teams":         list(teams),
                "logged_at":     _now_iso(),
                "ingest_result": ingest_result,
                "flags":         normalized_flags,
            })
        else:
            existing = entries[idx]
            existing["logged_at"] = _now_iso()
            existing["ingest_result"] = ingest_result
            # Preserve teams/game_date if already set and caller passed None/""
            if teams:
                existing["teams"] = list(teams)
            if game_date:
                existing["game_date"] = game_date
            existing_flags: List[dict] = existing.setdefault("flags", [])
            for nf in normalized_flags:
                if not any(_flags_are_equivalent(nf, ef) for ef in existing_flags):
                    existing_flags.append(nf)

        _atomic_write(store)
    except Exception:
        # Audit layer must not crash the pipeline. Swallow everything.
        pass


def resolve_flag(
    game_id: str,
    flag_type: str,
    resolution_note: str,
) -> bool:
    """Mark the first matching flag on a game as resolved.

    Matches by game_id + flag_type. If multiple flags share the same flag_type
    on one game, only the first unresolved one is updated. Returns True if a
    flag was updated, False otherwise.
    """
    try:
        store = _load_store()
        entries: List[dict] = store["entries"]
        idx = _find_entry(entries, game_id)
        if idx is None:
            return False
        for flag in entries[idx].get("flags", []):
            if flag.get("flag_type") == flag_type and not flag.get("resolved"):
                flag["resolved"] = True
                flag["resolution_note"] = resolution_note
                _atomic_write(store)
                return True
        return False
    except Exception:
        return False


# ─── Read-only helpers (used by notes.py CLI) ────────────────────────────────

def read_all() -> dict:
    """Return the full store as a dict. Read-only; safe for the CLI."""
    return _load_store()
