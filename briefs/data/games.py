"""Parse games/*.md files: header, Section 3 (Structured Play Log), Section 4 (Pitch Sequences)."""
from __future__ import annotations
import os
import re
from pathlib import Path
from typing import Iterable

# Header regex variants — keep both patterns; the .md corpus has all four shapes
# documented in CLAUDE_CODE_PROMPT.md (away/home, vs, at, mixed case).
_HEADER_AW_HM = re.compile(
    r'\*\*Teams:\*\*\s*(.+?)\s*\([Aa]way\)\s*(?:[/v]s?|at|@)?\s*(.+?)\s*\([Hh]ome\)'
)
_HEADER_CODES = re.compile(
    r'\*\*Teams:\*\*\s*(.+?)\s*\([A-Z]+\)\s*(?:at|vs|@|/)\s*(.+?)\s*\([A-Z]+\)'
)
_DATE_FROM_NAME = re.compile(r'(\d{4}-\d{2}-\d{2})')


def parse_header(content: str) -> tuple[str, str] | None:
    """Return (away_full_name, home_full_name) or None if header can't be parsed."""
    m = _HEADER_AW_HM.search(content)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m = _HEADER_CODES.search(content)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return None


def parse_play_log(content: str) -> list[dict]:
    """Parse Section 3 markdown table to list of PA dicts."""
    m = re.search(r'## Structured Play Log\s*\n(.+?)(?=\n##\s|\Z)', content, re.DOTALL)
    if not m:
        return []
    rows = []
    for line in m.group(1).split('\n'):
        line = line.strip()
        if not line.startswith('|') or '---' in line[:5]:
            continue
        cells = [c.strip() for c in line.split('|')[1:-1]]
        if len(cells) < 6 or cells[0] == '#':
            continue
        try:
            num = int(cells[0])
        except ValueError:
            continue
        rows.append({
            'num': num,
            'inning': int(cells[1]) if cells[1].isdigit() else cells[1],
            'half': cells[2],
            'batter': cells[3],
            'outcome': cells[4],
            'description': cells[5],
            'outs': cells[6] if len(cells) > 6 else '',
            'runs': cells[7] if len(cells) > 7 else '',
            'notes': cells[8] if len(cells) > 8 else '',
        })
    return rows


def parse_pitch_seq(content: str) -> dict[int, str]:
    """Parse Section 4 markdown table to dict {pa_num: pitch_seq_string}."""
    m = re.search(r'## Pitch Sequences\s*\n(.+?)(?=\n##\s|\Z)', content, re.DOTALL)
    if not m:
        return {}
    out = {}
    for line in m.group(1).split('\n'):
        line = line.strip()
        if not line.startswith('|') or '---' in line[:5]:
            continue
        cells = [c.strip() for c in line.split('|')[1:-1]]
        if len(cells) < 4 or cells[0] == '#':
            continue
        try:
            num = int(cells[0])
        except ValueError:
            continue
        out[num] = cells[3] if len(cells) > 3 else ''
    return out


def _matches_team(team_text: str, name_patterns: Iterable[str]) -> bool:
    txt = team_text.lower()
    return any(p.lower() in txt for p in name_patterns)


def load_games_for_team(games_dir: Path, name_patterns: list[str]) -> list[dict]:
    """Load all parsed games for a focal team identified by config.json name_patterns.

    Returns list of dicts with keys: file, date, away_full, home_full, side ('home'/'away'),
    opp_full, plays, pitch_seq.
    """
    out = []
    for f in sorted(os.listdir(games_dir)):
        if f.startswith('._') or f.startswith('UNKNOWN') or not f.endswith('.md'):
            continue
        path = Path(games_dir) / f
        with open(path) as fh:
            content = fh.read()
        h = parse_header(content)
        if not h:
            continue
        away_full, home_full = h
        if _matches_team(home_full, name_patterns):
            side, opp_full = 'home', away_full
        elif _matches_team(away_full, name_patterns):
            side, opp_full = 'away', home_full
        else:
            continue
        date_m = _DATE_FROM_NAME.match(f)
        if not date_m:
            continue
        out.append({
            'file': f,
            'date': date_m.group(1),
            'away_full': away_full,
            'home_full': home_full,
            'side': side,
            'opp_full': opp_full,
            'plays': parse_play_log(content),
            'pitch_seq': parse_pitch_seq(content),
        })
    out.sort(key=lambda x: x['date'])
    return out


def batting_halves(side: str) -> set[str]:
    """Half-inning labels in which the given side bats. Both 'Top'/'T' and 'Bottom'/'B' supported."""
    return {'Bottom', 'B'} if side == 'home' else {'Top', 'T'}


def pitching_halves(side: str) -> set[str]:
    return {'Top', 'T'} if side == 'home' else {'Bottom', 'B'}
