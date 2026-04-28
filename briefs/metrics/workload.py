"""Per-pitcher IP across the L5 game window — feeds the workload calendar."""
from __future__ import annotations
from collections import defaultdict

from ..data.canonicalize import canon_lookup


def workload(repo: dict, team_code: str, l5_repo_games: list[dict],
             pitch_canon: dict[str, str], logger=None) -> dict:
    """Return {workload: {pitcher: {date: ip}}, l5_dates: [...], l5_opps: [...]}."""
    l5_dates = [g['Game_Date'] for g in l5_repo_games]
    l5_opps = []
    for g in l5_repo_games:
        if g['Home_Team'] == team_code:
            l5_opps.append(g['Away_Team'])
        else:
            l5_opps.append(g['Home_Team'])

    gid_to_date = {g['Game_ID']: g['Game_Date'] for g in l5_repo_games}
    work: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))

    skipped = 0
    for p in repo.get('pitching', []):
        if p.get('Team') != team_code:
            continue
        if p.get('Game_ID') not in gid_to_date:
            continue
        name = p.get('Pitcher')
        outs = p.get('Outs_Recorded', 0) or 0
        if (not name or name == 'Unknown Player') and outs > 0:
            skipped += 1
            continue
        if not name or outs == 0:
            continue
        cn = canon_lookup(pitch_canon, name)
        date = gid_to_date[p['Game_ID']]
        work[cn][date] += outs / 3.0
    if skipped and logger:
        logger.warning("Workload: skipped %d unattributed pitching rows in L5 window", skipped)

    return {
        'workload': {k: dict(v) for k, v in work.items()},
        'l5_dates': l5_dates,
        'l5_opps': l5_opps,
    }
