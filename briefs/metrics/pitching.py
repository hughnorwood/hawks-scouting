"""Pitch-level metrics + per-pitcher tells.

Walks the play log to attribute each PA to a specific pitcher (for the focal team only),
then computes FPS%, S%, 2K K%, Lead-off BB%, OPS by time-through-order.
"""
from __future__ import annotations
import re
from collections import defaultdict
from typing import Iterable

from ..data.canonicalize import canon_lookup
from ..data.games import pitching_halves


_NAME = r'[A-Z][\w]*\s+[A-Z][\w]+'
_PITCHER_PATTERNS = [
    re.compile(r'Lineup changed[^|]*?(' + _NAME + r')\s+in at pitcher'),
    re.compile(r'(?:^|[.,;]\s*|\|\s*)(' + _NAME + r')\s+in at pitcher'),
    re.compile(r'(' + _NAME + r')\s+in for pitcher'),
]
_DESC_PITCHING = re.compile(r'\b(' + _NAME + r')\s+pitching\b')


def _find_pitcher_change(text: str) -> str | None:
    for pat in _PITCHER_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1).strip()
    return None


def _find_pitcher_in_desc(text: str) -> str | None:
    m = _DESC_PITCHING.search(text)
    return m.group(1).strip() if m else None


def parse_pitches(seq: str) -> list[str]:
    """Tokenize a pitch-sequence string; filter bracketed events + 'no pitch'."""
    if not seq:
        return []
    tokens = [t.strip() for t in seq.split(',')]
    return [t for t in tokens if t and not t.startswith('[') and not t.lower().startswith('no pitch')]


def is_strike_token(t: str) -> bool:
    return t.startswith('Strike') or t.startswith('Foul') or t == 'In play'


def is_ball_token(t: str) -> bool:
    return t.startswith('Ball')


def attribute_pitchers(game: dict, pitch_canon: dict[str, str],
                       team_pitcher_set: set[str]) -> list[dict]:
    """Walk a single game's plays; tag PAs in our-pitching halves with the responsible pitcher.

    Returns list of dicts: original play dict + 'pitcher' (canonical name or None) + 'pitch_seq'.
    """
    halves = pitching_halves(game['side'])
    current = None
    out = []
    for p in game['plays']:
        in_team = p['half'] in halves
        text = (p.get('notes') or '') + ' || ' + (p.get('description') or '')
        change = _find_pitcher_change(text)
        if change:
            cn = canon_lookup(pitch_canon, change)
            if cn in team_pitcher_set or in_team:
                current = cn
        if in_team and current is None:
            d = _find_pitcher_in_desc(p.get('description') or '')
            if d:
                cn = canon_lookup(pitch_canon, d)
                if cn in team_pitcher_set:
                    current = cn
        if in_team:
            d = _find_pitcher_in_desc(p.get('description') or '')
            if d:
                cn = canon_lookup(pitch_canon, d)
                if cn in team_pitcher_set and cn != current:
                    current = cn
        out.append({
            **p,
            'pitcher': current if in_team else None,
            'pitch_seq': game['pitch_seq'].get(p['num'], ''),
        })
    return out


def per_pitcher_metrics(games: list[dict], pitch_canon: dict[str, str],
                        team_pitcher_set: set[str]) -> dict[str, dict]:
    """Compute pitch-level metrics per canonical pitcher across all games."""
    pitcher_pas: dict[str, list] = defaultdict(list)
    for g in games:
        for pa in attribute_pitchers(g, pitch_canon, team_pitcher_set):
            if pa['pitcher']:
                pitcher_pas[pa['pitcher']].append((g['date'], g['file'], pa))

    metrics = {}
    for pitcher, pa_list in pitcher_pas.items():
        first_pa_per_half = {}
        for _, file, pa in pa_list:
            key = (file, pa['inning'], pa['half'])
            if key not in first_pa_per_half:
                first_pa_per_half[key] = pa['num']
        leadoff = [
            pa for _, file, pa in pa_list
            if first_pa_per_half[(file, pa['inning'], pa['half'])] == pa['num']
        ]
        n_lo = len(leadoff)
        n_lo_bb = sum(1 for pa in leadoff if pa['outcome'] == 'Walk')

        n_pwp = fps = total = strikes = n_2k = n_2k_k = 0
        for _, _, pa in pa_list:
            pitches = parse_pitches(pa['pitch_seq'])
            if not pitches:
                continue
            n_pwp += 1
            total += len(pitches)
            strikes += sum(1 for p in pitches if is_strike_token(p))
            if is_strike_token(pitches[0]):
                fps += 1
            sc = bc = 0
            reached = False
            for tok in pitches:
                if is_strike_token(tok):
                    if not (tok.startswith('Foul') and sc >= 2):
                        sc = min(sc + 1, 3)
                elif is_ball_token(tok):
                    bc = min(bc + 1, 4)
                if sc == 2:
                    reached = True
            if reached:
                n_2k += 1
                if pa['outcome'] in ('Strikeout', 'Dropped 3rd Strike'):
                    n_2k_k += 1

        metrics[pitcher] = {
            'pa': len(pa_list),
            'pa_with_pitches': n_pwp,
            'fps_pct': fps / n_pwp if n_pwp else 0,
            's_pct': strikes / total if total else 0,
            'twok_k_pct': n_2k_k / n_2k if n_2k else 0,
            'lo_bb_pct': n_lo_bb / n_lo if n_lo else 0,
            'n_2k_pas': n_2k,
            'n_leadoff_pas': n_lo,
            'total_pitches': total,
        }
    return metrics


def _empty_stats() -> dict:
    return {'PA': 0, 'AB': 0, 'H': 0, '1B': 0, '2B': 0, '3B': 0, 'HR': 0, 'BB': 0, 'HBP': 0, 'SF': 0}


def _outcome_to_stats(outcome: str) -> dict:
    s = {'PA': 1, 'AB': 0, 'H': 0, '1B': 0, '2B': 0, '3B': 0, 'HR': 0, 'BB': 0, 'HBP': 0, 'SF': 0}
    o = (outcome or '').strip()
    if o == 'Single': s.update({'AB': 1, 'H': 1, '1B': 1})
    elif o == 'Double': s.update({'AB': 1, 'H': 1, '2B': 1})
    elif o == 'Triple': s.update({'AB': 1, 'H': 1, '3B': 1})
    elif o == 'Home Run': s.update({'AB': 1, 'H': 1, 'HR': 1})
    elif o == 'Walk': s.update({'BB': 1})
    elif o == 'Hit By Pitch': s.update({'HBP': 1})
    elif o in ('Strikeout', 'Dropped 3rd Strike', 'Ground Out', 'Fly Out',
               'Pop Out', 'Line Out', "Fielder's Choice", 'Fielders Choice', 'Error'):
        s.update({'AB': 1})
    elif o == 'Sacrifice Fly': s.update({'SF': 1})
    return s


def _add_stats(a: dict, b: dict) -> dict:
    return {k: a[k] + b[k] for k in a}


def ops_from(s: dict) -> float:
    pa, ab, h = s['PA'], s['AB'], s['H']
    h1, h2, h3, hr = s['1B'], s['2B'], s['3B'], s['HR']
    bb, hbp, sf = s['BB'], s['HBP'], s['SF']
    if pa == 0:
        return 0
    tb = h1 + 2 * h2 + 3 * h3 + 4 * hr
    obp_den = ab + bb + hbp + sf
    obp = (h + bb + hbp) / obp_den if obp_den else 0
    slg = tb / ab if ab else 0
    return obp + slg


def pitcher_table(repo: dict, team_code: str, games: list[dict],
                  bat_canon: dict[str, str], pitch_canon: dict[str, str],
                  team_pitcher_set: set[str], min_pa: int = 20,
                  logger=None) -> tuple[list[dict], dict[int, dict]]:
    """Build the Pitcher Insights table rows + team-level OPS-by-TTO summary.

    Returns (per_pitcher_rows, team_tto_dict). Team TTO dict keys: 1, 2, 3.
    """
    pmetrics = per_pitcher_metrics(games, pitch_canon, team_pitcher_set)

    tto: dict[str, dict[int, dict]] = defaultdict(lambda: defaultdict(_empty_stats))
    for g in games:
        plays = attribute_pitchers(g, pitch_canon, team_pitcher_set)
        seen: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for pa in plays:
            if not pa['pitcher']:
                continue
            b = canon_lookup(bat_canon, pa['batter'])
            seen[pa['pitcher']][b] += 1
            t = min(seen[pa['pitcher']][b], 3)
            tto[pa['pitcher']][t] = _add_stats(tto[pa['pitcher']][t], _outcome_to_stats(pa['outcome']))

    repo_pit: dict[str, dict] = defaultdict(lambda: {'outs': 0, 'r': 0, 'h': 0, 'bb': 0, 'k': 0, 'bf': 0})
    skipped = 0
    for p in repo.get('pitching', []):
        if p.get('Team') != team_code:
            continue
        name = p.get('Pitcher')
        outs = p.get('Outs_Recorded', 0) or 0
        if (not name or name == 'Unknown Player') and outs > 0:
            skipped += 1
            continue
        if not name or outs == 0:
            continue
        cn = canon_lookup(pitch_canon, name)
        a = repo_pit[cn]
        a['outs'] += outs
        a['r'] += p.get('R_Allowed', 0) or 0
        a['h'] += p.get('H_Allowed', 0) or 0
        a['bb'] += p.get('BB_Allowed', 0) or 0
        a['k'] += p.get('K', 0) or 0
        a['bf'] += p.get('BF', 0) or 0
    if skipped and logger:
        logger.warning("Skipped %d pitching rows with empty/Unknown pitcher but non-zero outs", skipped)

    rows = []
    for pit, m in pmetrics.items():
        if m['pa'] < min_pa:
            continue
        repo_row = repo_pit.get(pit, {})
        ip = repo_row.get('outs', 0) / 3 if repo_row else 0
        era = (repo_row.get('r', 0) * 9 / ip) if ip else 0
        s1 = tto[pit].get(1, _empty_stats())
        s2 = tto[pit].get(2, _empty_stats())
        s3 = tto[pit].get(3, _empty_stats())
        rows.append({
            'name': pit, 'ip': ip, 'era': era, 'pa': m['pa'],
            'fps_pct': m['fps_pct'], 's_pct': m['s_pct'],
            'twok_k_pct': m['twok_k_pct'], 'lo_bb_pct': m['lo_bb_pct'],
            'ops_1': ops_from(s1) if s1['PA'] else None, 'pa_1': s1['PA'],
            'ops_2': ops_from(s2) if s2['PA'] else None, 'pa_2': s2['PA'],
            'ops_3': ops_from(s3) if s3['PA'] else None, 'pa_3': s3['PA'],
        })
    rows.sort(key=lambda r: -r['ip'])

    team_tto = {1: _empty_stats(), 2: _empty_stats(), 3: _empty_stats()}
    for ts in tto.values():
        for t, s in ts.items():
            team_tto[t] = _add_stats(team_tto[t], s)
    return rows, team_tto
