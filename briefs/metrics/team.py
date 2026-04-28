"""Team-level aggregates: recent form windows + league averages."""
from __future__ import annotations


def team_stats_window(team_code: str, games: list[dict], bat_rows: list[dict],
                      pit_rows: list[dict]) -> dict:
    """Aggregate offensive + pitching + run-scoring stats over the given games."""
    gids = {g['Game_ID'] for g in games}
    bat = [b for b in bat_rows if b['Game_ID'] in gids]
    pit = [p for p in pit_rows if p['Game_ID'] in gids]

    rs = ra = errs = wins = losses = 0
    for g in games:
        if g['Home_Team'] == team_code:
            my_r, opp_r, my_e = g['Home_R'], g['Away_R'], g['Home_E']
        else:
            my_r, opp_r, my_e = g['Away_R'], g['Home_R'], g['Away_E']
        rs += my_r
        ra += opp_r
        errs += my_e
        if my_r > opp_r:
            wins += 1
        else:
            losses += 1

    n = len(games)
    pa = sum(b['PA'] for b in bat)
    ab = sum(b['AB'] for b in bat)
    h = sum(b['H'] for b in bat)
    bb = sum(b['BB'] for b in bat)
    hbp = sum(b['HBP'] for b in bat)
    sf = sum(b['SAC'] for b in bat)
    k = sum(b['K'] for b in bat)
    h1 = sum(b['1B'] for b in bat)
    h2 = sum(b['2B'] for b in bat)
    h3 = sum(b['3B'] for b in bat)
    hr = sum(b['HR'] for b in bat)
    tb = h1 + 2 * h2 + 3 * h3 + 4 * hr
    obp_den = ab + bb + hbp + sf
    obp = (h + bb + hbp) / obp_den if obp_den else 0
    slg = tb / ab if ab else 0

    outs = sum(p['Outs_Recorded'] for p in pit)
    ip = outs / 3 if outs else 0
    h_a = sum(p['H_Allowed'] for p in pit)
    bb_a = sum(p['BB_Allowed'] for p in pit)
    r_a = sum(p['R_Allowed'] for p in pit)

    return {
        'n': n, 'wins': wins, 'losses': losses,
        'rs_g': rs / n if n else 0,
        'ra_g': ra / n if n else 0,
        'errs_g': errs / n if n else 0,
        'rs_total': rs, 'ra_total': ra,
        'ops': obp + slg,
        'era': (r_a * 9 / ip) if ip else 0,
        'whip': (h_a + bb_a) / ip if ip else 0,
        'bb_pct': bb / pa if pa else 0,
        'k_pct': k / pa if pa else 0,
    }


def league_averages(repo: dict, focal_codes: list[str]) -> dict:
    """Mean stats across the focal-team set. Skips teams with no games."""
    from .. data.repository import unique_team_games
    teams = []
    for code in focal_codes:
        games = unique_team_games(repo, code)
        if not games:
            continue
        bat = [b for b in repo['batting'] if b['Team'] == code]
        pit = [p for p in repo['pitching'] if p['Team'] == code]
        teams.append(team_stats_window(code, games, bat, pit))
    if not teams:
        return {k: 0 for k in ('rs_g', 'ra_g', 'ops', 'era', 'whip', 'errs_g', 'bb_pct', 'k_pct')}
    return {
        k: sum(t[k] for t in teams) / len(teams)
        for k in ('rs_g', 'ra_g', 'ops', 'era', 'whip', 'errs_g', 'bb_pct', 'k_pct')
    }


def chrono_results(team_code: str, games: list[dict]) -> list[dict]:
    """Per-game W/L/RS/RA/opp/venue, in chronological order. Used for streak + L5 listing."""
    out = []
    for g in games:
        if g['Home_Team'] == team_code:
            my_r, opp_r, opp = g['Home_R'], g['Away_R'], g['Away_Team']
            venue = 'vs'
        else:
            my_r, opp_r, opp = g['Away_R'], g['Home_R'], g['Home_Team']
            venue = '@'
        out.append({
            'date': g['Game_Date'], 'opp': opp, 'venue': venue,
            'my_r': my_r, 'opp_r': opp_r, 'won': my_r > opp_r,
            'gid': g['Game_ID'],
        })
    return out


def streak(chrono: list[dict]) -> str:
    """Return current win/loss streak as 'W3' / 'L2' / '—'."""
    if not chrono:
        return '—'
    last = chrono[-1]['won']
    n = 0
    for r in reversed(chrono):
        if r['won'] == last:
            n += 1
        else:
            break
    return f"{'W' if last else 'L'}{n}"
