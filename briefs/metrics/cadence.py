"""Per-inning RS / RA / E aggregated across the L5 game window.

Errors are parsed from play-log text rather than gameLog totals because Home_E / Away_E
have been observed flipped relative to the play log in at least one game.
"""
from __future__ import annotations
import re

from ..data.games import batting_halves, pitching_halves


# Each error event is uniquely identified by an "error by [fielder]" attribution.
# "the same error" / "the same play" back-references lack "by", so this regex avoids
# double-counting when one error is mentioned multiple times in a single play.
_ERROR_BY = re.compile(r'\berror\s+by\b', re.I)


def _runs_in_play(runs_cell: str) -> int:
    s = (runs_cell or '').strip()
    try:
        return int(s)
    except ValueError:
        return 0


def cadence(games: list[dict]) -> list[dict]:
    """Return per-game inning breakdown: list of {date, opp, innings: {1..7: {rs, ra, e}}}."""
    out = []
    for g in games:
        bat_h = batting_halves(g['side'])
        pit_h = pitching_halves(g['side'])
        innings = {i: {'rs': 0, 'ra': 0, 'e': 0} for i in range(1, 8)}
        for p in g['plays']:
            inning = p['inning']
            if not isinstance(inning, int) or inning < 1 or inning > 7:
                continue
            runs = _runs_in_play(p.get('runs', ''))
            if p['half'] in bat_h:
                innings[inning]['rs'] += runs
            elif p['half'] in pit_h:
                innings[inning]['ra'] += runs
                text = (p.get('description') or '') + ' ' + (p.get('notes') or '')
                innings[inning]['e'] += len(_ERROR_BY.findall(text))
        out.append({'date': g['date'], 'opp': g['opp_full'], 'innings': innings})
    return out
