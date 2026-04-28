"""Detect most-common L5 lineup + per-batter season/L5 stats."""
from __future__ import annotations
from collections import Counter

from ..data.canonicalize import canon_lookup
from ..data.games import batting_halves


def detect_lineup(l5_games: list[dict], bat_canon: dict[str, str]) -> list[str | None]:
    """Per spot 1-9, the modal canonical batter across L5 games' first 9 unique PAs.

    Returns 9-element list; entries are canonical names or None if no data observed.
    """
    spot_counts = [Counter() for _ in range(9)]
    for g in l5_games:
        halves = batting_halves(g['side'])
        seen: list[str] = []
        for p in g['plays']:
            if p['half'] not in halves or not p.get('batter'):
                continue
            cn = canon_lookup(bat_canon, p['batter'])
            if cn not in seen:
                seen.append(cn)
            if len(seen) >= 9:
                break
        for i, name in enumerate(seen[:9]):
            spot_counts[i][name] += 1
    return [c.most_common(1)[0][0] if c else None for c in spot_counts]


def player_stats(rows: list[dict], canonical: str, bat_canon: dict[str, str]) -> dict | None:
    """Aggregate batting rows for a single canonical name."""
    matched = [r for r in rows if canon_lookup(bat_canon, r['Player']) == canonical]
    if not matched:
        return None
    pa = sum(r['PA'] for r in matched)
    ab = sum(r['AB'] for r in matched)
    h = sum(r['H'] for r in matched)
    h1 = sum(r['1B'] for r in matched)
    h2 = sum(r['2B'] for r in matched)
    h3 = sum(r['3B'] for r in matched)
    hr = sum(r['HR'] for r in matched)
    bb = sum(r['BB'] for r in matched)
    hbp = sum(r['HBP'] for r in matched)
    sf = sum(r['SAC'] for r in matched)
    k = sum(r['K'] for r in matched)
    r_scored = sum(r['R'] for r in matched)
    rbi = sum(r['RBI'] for r in matched)
    sb = sum(r['SB'] for r in matched)
    cs = sum(r['CS'] for r in matched)
    tb = h1 + 2 * h2 + 3 * h3 + 4 * hr
    obp_den = ab + bb + hbp + sf
    obp = (h + bb + hbp) / obp_den if obp_den else 0
    slg = tb / ab if ab else 0
    return {
        'pa': pa, 'ab': ab, 'h': h, 'hr': hr, 'r': r_scored, 'rbi': rbi,
        'bb': bb, 'k': k, 'sb': sb, 'cs': cs,
        'avg': h / ab if ab else 0,
        'obp': obp, 'slg': slg, 'ops': obp + slg,
        'bb_rate': bb / pa if pa else 0,
        'k_rate': k / pa if pa else 0,
    }


def lineup_table(repo: dict, team_code: str, l5_repo_games: list[dict],
                 l5_md_games: list[dict], bat_canon: dict[str, str]) -> list[dict]:
    """Return one row per detected lineup spot with season + L5 stats. Empty spots dropped.

    l5_repo_games — last 5 gameLog rows from repository.json (used to scope L5 batting rows)
    l5_md_games   — last 5 parsed .md game objects (used for lineup-spot detection)
    """
    lineup = detect_lineup(l5_md_games, bat_canon)
    bat_all = [b for b in repo['batting'] if b['Team'] == team_code]
    l5_gids = {g['Game_ID'] for g in l5_repo_games}
    bat_l5 = [b for b in bat_all if b['Game_ID'] in l5_gids]
    out = []
    for i, name in enumerate(lineup):
        if not name:
            continue
        s = player_stats(bat_all, name, bat_canon)
        if not s:
            continue
        s5 = player_stats(bat_l5, name, bat_canon)
        out.append({
            'spot': i + 1, 'name': name, **s,
            'ops_l5': s5['ops'] if s5 else None,
        })
    return out
