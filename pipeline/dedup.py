"""Alias-aware lookup for "is this focal team's game on this date already in games/?"

Both scrape.py (pre-download) and transcribe.py (pre-API-call) need the same
check. Plain substring matching on the focal team's canonical code misses games
filed under alias codes (e.g. NHRF games sometimes filed as NRTH because that's
how Claude transcribed the team name before registry resolution).

Some aliases collide with legitimate non-focal opponent codes — NRTH is both
North Harford's alias and the canonical code for "Northern". For those, we
disambiguate by reading the .md's "Teams:" line and confirming the focal team's
display_name appears.
"""

import json
import re
from pathlib import Path

_PIPELINE_DIR = Path(__file__).resolve().parent
_CONFIG_FILE = _PIPELINE_DIR / "config.json"
_GAMES_DIR = _PIPELINE_DIR.parent / "games"

_STEM_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_(\w+)_at_(\w+)$")
_TEAMS_LINE_RE = re.compile(r"\*\*Teams?:\*\*\s*([^\n]+)", re.I)


def load_focal_index():
    """Return (focal_by_code, known_opponent_codes) from config.json.

    focal_by_code: { code: {"display_name": ..., "aliases": [...]} }
    known_opponent_codes: set of codes used by non-focal opponents.
    """
    cfg = json.loads(_CONFIG_FILE.read_text())
    focal_by_code = {
        t["code"]: {
            "display_name": t.get("display_name", t.get("name", t["code"])),
            "aliases": t.get("aliases", []),
        }
        for t in cfg["focal_teams"]
    }
    known_opponent_codes = {t["code"] for t in cfg.get("known_opponents", [])}
    return focal_by_code, known_opponent_codes


def _md_mentions(md_path: Path, display_name: str) -> bool:
    """True if the .md's Teams: line contains display_name (case-insensitive)."""
    try:
        head = md_path.read_text()[:2500]
    except OSError:
        return False
    m = _TEAMS_LINE_RE.search(head)
    if not m:
        return False
    return display_name.lower() in m.group(1).lower()


def find_all_existing_games(date_str, focal_code, focal_aliases, focal_display_name,
                            known_opponent_codes, games_dir=_GAMES_DIR):
    """Return all games/*.md stems that represent this focal team's game(s) on
    `date_str`. Usually 0 or 1; can be 2 for doubleheaders.

    Match rules, in order:
      1. Date prefix matches AND focal_code is one side of the filename → match.
      2. Date prefix matches AND an alias is one side, and that alias is NOT
         also a known_opponent code → match (no collision possible).
      3. Date prefix matches AND a colliding alias (also a known_opponent code)
         is one side → only a match if the .md's Teams: line mentions the
         focal team's display_name. Otherwise the .md is the unrelated
         non-focal opponent's game and we skip it.
    """
    matches = []
    if not games_dir.exists():
        return matches

    for md in games_dir.glob(f"{date_str}_*.md"):
        m = _STEM_RE.match(md.stem)
        if not m:
            continue
        sides = {m.group(1), m.group(2)}

        if focal_code in sides:
            matches.append(md.stem)
            continue

        for alias in focal_aliases:
            if alias not in sides:
                continue
            if alias in known_opponent_codes:
                if _md_mentions(md, focal_display_name):
                    matches.append(md.stem)
            else:
                matches.append(md.stem)
            break
    return matches


def find_existing_game(date_str, focal_code, focal_aliases, focal_display_name,
                       known_opponent_codes, games_dir=_GAMES_DIR):
    """Return the first matching stem, or None. Thin wrapper over find_all_existing_games."""
    matches = find_all_existing_games(
        date_str, focal_code, focal_aliases, focal_display_name,
        known_opponent_codes, games_dir,
    )
    return matches[0] if matches else None
