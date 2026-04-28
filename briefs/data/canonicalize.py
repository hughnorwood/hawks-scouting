"""Per-team batter / pitcher name canonicalization.

Players appear in two forms across batting rows, pitching rows, and play-log narratives:
  - Short:  "B Yates", "J McFarling"
  - Full:   "Bobby Yates", "Jacob McFarling"

Two players can share a last name (Bobby Yates + Ryan Yates) — match by first INITIAL,
not by last name alone, to avoid collapsing distinct players.
"""
from __future__ import annotations
import re
from typing import Iterable

from .games import batting_halves, pitching_halves


_NAME_RE = re.compile(r'[A-Z][\w]*\s+[A-Z][\w]+')
_PITCHER_TRANSITION_PATTERNS = [
    re.compile(r'Lineup changed[^|]*?(' + _NAME_RE.pattern + r')\s+in at pitcher'),
    re.compile(r'(?:^|[.,;]\s*|\|\s*)(' + _NAME_RE.pattern + r')\s+in at pitcher'),
    re.compile(r'(' + _NAME_RE.pattern + r')\s+in for pitcher'),
]
_PITCHING_DESC = re.compile(r'\b(' + _NAME_RE.pattern + r')\s+pitching\b')


def _split_first_last(name: str) -> tuple[str, str] | None:
    parts = name.strip().split()
    if len(parts) < 2:
        return None
    first, last = parts[0], ' '.join(parts[1:])
    return first, last


def build_canon_map(names: Iterable[str]) -> dict[str, str]:
    """Build {observed_form: canonical_form} mapping.

    Canonical = full first name when available; falls back to the short form if no full
    is observed. Matching keys on (last_name, first_initial) so two players sharing a
    last name remain distinct.
    """
    fulls: dict[tuple[str, str], str] = {}     # (last, initial) -> full name
    shorts: set[tuple[str, str]] = set()        # (last, initial)
    raw_seen: dict[tuple[str, str], set[str]] = {}  # (last, initial) -> raw forms

    for name in names:
        if not name:
            continue
        name = name.strip()
        parts = _split_first_last(name)
        if not parts:
            continue
        first, last = parts
        first_clean = first.rstrip('.')
        initial = first_clean[0].upper()
        key = (last, initial)
        raw_seen.setdefault(key, set()).add(name)
        if len(first_clean) == 1:
            shorts.add(key)
        else:
            # Prefer the longest full first name observed (handles "Bob" vs "Bobby")
            existing = fulls.get(key)
            if not existing or len(name) > len(existing):
                fulls[key] = name

    canon: dict[str, str] = {}
    for key, raws in raw_seen.items():
        canonical = fulls.get(key) or next(iter(raws))
        for raw in raws:
            canon[raw] = canonical
    return canon


def collect_batter_names(repo: dict, team_code: str, games: list[dict]) -> set[str]:
    """All names that should be canonicalized as batters for this team."""
    out: set[str] = set()
    for b in repo.get('batting', []):
        if b.get('Team') == team_code and b.get('Player'):
            out.add(b['Player'])
    for g in games:
        halves = batting_halves(g['side'])
        for p in g['plays']:
            if p['half'] in halves and p.get('batter'):
                out.add(p['batter'])
    return out


def collect_pitcher_names(repo: dict, team_code: str, games: list[dict]) -> set[str]:
    """All names that should be canonicalized as pitchers for this team."""
    out: set[str] = set()
    for p in repo.get('pitching', []):
        name = p.get('Pitcher')
        if p.get('Team') == team_code and name and name != 'Unknown Player':
            out.add(name)
    for g in games:
        halves = pitching_halves(g['side'])
        for play in g['plays']:
            if play['half'] not in halves:
                continue
            text = (play.get('notes') or '') + ' || ' + (play.get('description') or '')
            for pat in _PITCHER_TRANSITION_PATTERNS:
                for m in pat.finditer(text):
                    out.add(m.group(1).strip())
            for m in _PITCHING_DESC.finditer(play.get('description') or ''):
                out.add(m.group(1).strip())
    return out


def canon_lookup(canon: dict[str, str], name: str) -> str:
    """Resolve a name through the canon map, returning original if not found."""
    return canon.get(name.strip(), name.strip())
