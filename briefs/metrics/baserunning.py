"""Team + per-player base-running: SB by base, CS, extra base on errors. League comparison."""
from __future__ import annotations
import re
from collections import defaultdict

from ..data.canonicalize import canon_lookup
from ..data.games import batting_halves
from ..data.repository import unique_team_games


_NAME = r'[A-Z][\w]*\s+[A-Z][\w]+'
_STEAL_2 = re.compile(r'(' + _NAME + r')\s+steals\s+2nd\b', re.I)
_STEAL_3 = re.compile(r'(' + _NAME + r')\s+steals\s+3rd\b', re.I)
_STEAL_H = re.compile(r'(' + _NAME + r')\s+steals\s+home\b', re.I)
_CS_PAT = re.compile(r'(' + _NAME + r')\s+caught\s+stealing', re.I)
_EB_ON_ERR = re.compile(r'\b(advances?\s+to\s+\w+\s+on\s+(?:the\s+)?error|scores\s+on\s+(?:the\s+)?error)', re.I)


def baserunning(repo: dict, team_code: str, focal_codes: list[str], games: list[dict],
                bat_canon: dict[str, str]) -> dict:
    """Compute team SB/CS/XB-on-error and per-player attempts. League rates from focal teams."""
    team = {'sb_2': 0, 'sb_3': 0, 'sb_h': 0, 'cs': 0, 'eb_err': 0}
    by_p: dict[str, dict[str, int]] = defaultdict(lambda: {'sb_2': 0, 'sb_3': 0, 'sb_h': 0, 'cs': 0})

    for g in games:
        halves = batting_halves(g['side'])
        for play in g['plays']:
            if play['half'] not in halves:
                continue
            text = (play.get('description') or '') + ' ' + (play.get('notes') or '')
            for n in _STEAL_2.findall(text):
                cn = canon_lookup(bat_canon, n); by_p[cn]['sb_2'] += 1; team['sb_2'] += 1
            for n in _STEAL_3.findall(text):
                cn = canon_lookup(bat_canon, n); by_p[cn]['sb_3'] += 1; team['sb_3'] += 1
            for n in _STEAL_H.findall(text):
                cn = canon_lookup(bat_canon, n); by_p[cn]['sb_h'] += 1; team['sb_h'] += 1
            for n in _CS_PAT.findall(text):
                cn = canon_lookup(bat_canon, n); by_p[cn]['cs'] += 1; team['cs'] += 1
            team['eb_err'] += len(_EB_ON_ERR.findall(text))

    lg_sb = lg_cs = lg_g = 0
    for code in focal_codes:
        games_c = unique_team_games(repo, code)
        bat = [b for b in repo['batting'] if b['Team'] == code]
        lg_sb += sum(b['SB'] for b in bat)
        lg_cs += sum(b['CS'] for b in bat)
        lg_g += len(games_c)

    sb_total = team['sb_2'] + team['sb_3'] + team['sb_h']
    cs_total = team['cs']
    n = len(games)

    players = []
    for p, s in by_p.items():
        att = s['sb_2'] + s['sb_3'] + s['sb_h'] + s['cs']
        if att >= 1:
            succ = s['sb_2'] + s['sb_3'] + s['sb_h']
            players.append({
                'name': p, 'att': att, **s,
                'succ': succ,
                'succ_pct': succ / att if att else 0,
            })
    players.sort(key=lambda r: -r['att'])

    return {
        'team': {
            **team,
            'sb_total': sb_total, 'cs_total': cs_total, 'games': n,
            'sb_g': sb_total / n if n else 0,
            'succ_pct': sb_total / (sb_total + cs_total) if (sb_total + cs_total) else 0,
            'eb_err_g': team['eb_err'] / n if n else 0,
        },
        'league': {
            'sb_g': lg_sb / lg_g if lg_g else 0,
            'cs_g': lg_cs / lg_g if lg_g else 0,
            'succ_pct': lg_sb / (lg_sb + lg_cs) if (lg_sb + lg_cs) else 0,
        },
        'players': players,
    }
