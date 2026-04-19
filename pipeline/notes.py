#!/usr/bin/env python3
"""Query and resolve entries in pipeline/pipeline_notes.json.

Usage:
  python pipeline/notes.py                           # list all entries
  python pipeline/notes.py --team NHRF
  python pipeline/notes.py --game-id 2026-04-09_RVRH_at_GARG
  python pipeline/notes.py --flag-type PC2_TOLERANCE
  python pipeline/notes.py --severity soft
  python pipeline/notes.py --unresolved
  python pipeline/notes.py --team NHRF --unresolved
  python pipeline/notes.py --ingest-result gate_failure
  python pipeline/notes.py --json
  python pipeline/notes.py --resolve <game_id> --flag-type PC2_TOLERANCE \
                          --note "Scorer error confirmed"

Filters are combinable. --json prints the filtered entries as raw JSON.
Default output is human-readable, grouped by game.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import log_flag  # noqa: E402


# ─── Filtering ───────────────────────────────────────────────────────────────

def _entry_matches(entry: dict, *, team: Optional[str], game_id: Optional[str],
                   flag_type: Optional[str], severity: Optional[str],
                   unresolved: bool, ingest_result: Optional[str]) -> bool:
    if game_id and entry.get("game_id") != game_id:
        return False
    if ingest_result and entry.get("ingest_result") != ingest_result:
        return False

    teams = entry.get("teams") or []
    flags = entry.get("flags") or []

    # Team filter matches either the game's team list OR a flag's team attribution
    if team:
        team_u = team.upper()
        in_teams = any(str(t).upper() == team_u for t in teams)
        in_flags = any(str(f.get("team") or "").upper() == team_u for f in flags)
        if not (in_teams or in_flags):
            return False

    # Flag-level filters: entry must contain AT LEAST ONE matching flag
    if flag_type or severity or unresolved:
        def _flag_ok(f: dict) -> bool:
            if flag_type and f.get("flag_type") != flag_type:
                return False
            if severity and f.get("severity") != severity:
                return False
            if unresolved and f.get("resolved"):
                return False
            return True
        if not any(_flag_ok(f) for f in flags):
            # Allow an entry with zero flags if no flag-level filter was set
            # (already handled by the outer `if`), so here we must return False
            return False

    return True


def _filtered_entries(store: dict, args: argparse.Namespace) -> List[dict]:
    return [
        e for e in store.get("entries", [])
        if _entry_matches(
            e,
            team=args.team,
            game_id=args.game_id,
            flag_type=args.flag_type,
            severity=args.severity,
            unresolved=args.unresolved,
            ingest_result=args.ingest_result,
        )
    ]


# ─── Rendering ───────────────────────────────────────────────────────────────

_SEV_COLOR = {"hard": "❌", "soft": "⚠️ ", "info": "ℹ️ "}


def _render_entry(entry: dict, *, flag_filter) -> str:
    """Render one entry. `flag_filter` is a predicate over flag dicts so we
    only show flags that match the user's flag-level filters."""
    game_id = entry.get("game_id", "?")
    teams = entry.get("teams") or []
    result = entry.get("ingest_result", "?")
    logged = entry.get("logged_at", "?")

    header = f"{game_id}  [{result}]  teams={'/'.join(teams)}  logged={logged}"
    lines = [header]

    flags = [f for f in (entry.get("flags") or []) if flag_filter(f)]
    if not flags:
        lines.append("  (no flags)")
        return "\n".join(lines)

    for f in flags:
        sev = f.get("severity", "info")
        icon = _SEV_COLOR.get(sev, "•")
        resolved_mark = " ✅resolved" if f.get("resolved") else ""
        team = f.get("team")
        team_str = f" [{team}]" if team else ""
        lines.append(
            f"  {icon} {f.get('flag_type','?')}{team_str} ({sev}){resolved_mark}"
        )
        detail = f.get("detail", "")
        if detail:
            # Wrap long details for readability
            lines.append(f"      {detail}")
        note = f.get("resolution_note")
        if f.get("resolved") and note:
            lines.append(f"      resolution: {note}")
    return "\n".join(lines)


def _flag_passes_user_filter(args: argparse.Namespace):
    def _pred(f: dict) -> bool:
        if args.flag_type and f.get("flag_type") != args.flag_type:
            return False
        if args.severity and f.get("severity") != args.severity:
            return False
        if args.unresolved and f.get("resolved"):
            return False
        return True
    return _pred


def _render_summary(entries: List[dict], args: argparse.Namespace) -> str:
    if not entries:
        return "No entries match the filter."
    pred = _flag_passes_user_filter(args)
    blocks = [_render_entry(e, flag_filter=pred) for e in entries]
    total_flags = sum(
        sum(1 for f in (e.get("flags") or []) if pred(f))
        for e in entries
    )
    blocks.append(f"\n{len(entries)} game(s), {total_flags} matching flag(s).")
    return "\n\n".join(blocks)


# ─── Resolve action ──────────────────────────────────────────────────────────

def _do_resolve(game_id: str, flag_type: Optional[str], note: Optional[str]) -> int:
    if not flag_type:
        print("--resolve requires --flag-type to identify which flag to resolve.",
              file=sys.stderr)
        return 2
    if note is None:
        print("--resolve requires --note to record why the flag is resolved.",
              file=sys.stderr)
        return 2
    updated = log_flag.resolve_flag(game_id, flag_type, note)
    if updated:
        print(f"✅ Resolved: {game_id} / {flag_type}\n   note: {note}")
        return 0
    print(f"No matching unresolved flag found for {game_id} / {flag_type}",
          file=sys.stderr)
    return 1


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Query and resolve pipeline notes.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("--team", help="Filter to games involving this team code.")
    ap.add_argument("--game-id", help="Filter to one specific game_id.")
    ap.add_argument("--flag-type", help="Filter to a specific flag_type constant.")
    ap.add_argument("--severity", choices=("info", "soft", "hard"),
                    help="Filter flags by severity.")
    ap.add_argument("--unresolved", action="store_true",
                    help="Only show flags that are not yet resolved.")
    ap.add_argument("--ingest-result", choices=("success", "gate_failure", "skipped"),
                    help="Filter by game ingest_result.")
    ap.add_argument("--json", dest="as_json", action="store_true",
                    help="Emit filtered entries as raw JSON.")
    ap.add_argument("--resolve", metavar="GAME_ID",
                    help="Mark the matching flag as resolved. Requires --flag-type and --note.")
    ap.add_argument("--note", help="Resolution note (used with --resolve).")
    args = ap.parse_args(argv)

    if args.resolve:
        return _do_resolve(args.resolve, args.flag_type, args.note)

    store = log_flag.read_all()
    entries = _filtered_entries(store, args)

    if args.as_json:
        print(json.dumps({"entries": entries}, indent=2, ensure_ascii=False))
        return 0

    print(_render_summary(entries, args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
