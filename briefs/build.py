"""CLI entry point: python -m briefs.build --team LNRC | --all"""
from __future__ import annotations
import argparse
import logging
import sys
from pathlib import Path

from .data.canonicalize import (
    build_canon_map, collect_batter_names, collect_pitcher_names,
)
from .data.games import load_games_for_team
from .data.repository import (
    display_name, filter_games_window, focal_team_codes, load_config,
    load_repo, name_patterns_for, unique_team_games,
)
from .metrics.baserunning import baserunning
from .metrics.cadence import cadence
from .metrics.lineup import lineup_table
from .metrics.pitching import pitcher_table
from .metrics.team import chrono_results, league_averages, streak, team_stats_window
from .metrics.workload import workload
from .render.pdf import render_pdf


REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / 'pipeline' / 'config.json'

log = logging.getLogger('briefs')


def assemble(repo: dict, config: dict, team_code: str, games_dir: Path,
             window_days: int | None) -> dict | None:
    """Build the data dict consumed by render(); returns None on missing/empty data."""
    team_full = display_name(repo, team_code)
    if team_full == team_code:
        log.warning("No display name for %s in repository.json — using code as label", team_code)

    name_patterns = name_patterns_for(config, team_code)
    if not name_patterns:
        log.error("No name_patterns for %s in pipeline/config.json", team_code)
        return None

    repo_games_all = unique_team_games(repo, team_code)
    repo_games = filter_games_window(repo_games_all, window_days)
    if not repo_games:
        log.error("No games found for %s%s", team_code,
                  f' in last {window_days} days' if window_days else '')
        return None

    md_games_all = load_games_for_team(games_dir, name_patterns)
    if window_days:
        keep_dates = {g['Game_Date'] for g in repo_games}
        md_games = [g for g in md_games_all if g['date'] in keep_dates]
    else:
        md_games = md_games_all
    log.info("[%s] Loaded %d gameLog rows + %d parsed game files", team_code,
             len(repo_games), len(md_games))

    bat_canon = build_canon_map(collect_batter_names(repo, team_code, md_games))
    pit_canon = build_canon_map(collect_pitcher_names(repo, team_code, md_games))
    team_pitcher_set = set(pit_canon.values()) | set(pit_canon.keys())
    log.info("[%s] Canonical players: %d batters, %d pitchers", team_code,
             len(set(bat_canon.values())), len(set(pit_canon.values())))

    bat_rows = [b for b in repo['batting'] if b['Team'] == team_code]
    pit_rows = [p for p in repo['pitching'] if p['Team'] == team_code]
    season = team_stats_window(team_code, repo_games, bat_rows, pit_rows)
    l10 = team_stats_window(team_code, repo_games[-10:], bat_rows, pit_rows)
    l5 = team_stats_window(team_code, repo_games[-5:], bat_rows, pit_rows)
    league_avg = league_averages(repo, focal_team_codes(config))

    chrono = chrono_results(team_code, repo_games)
    l5_chrono = chrono[-5:]
    cover = {
        'team_full': team_full, 'team_code': team_code,
        'record': f"{season['wins']}-{season['losses']}",
        'rs': season['rs_total'], 'ra': season['ra_total'],
        'diff': season['rs_total'] - season['ra_total'],
        'l5_record': f"{l5['wins']}-{l5['losses']}",
        'streak': streak(chrono),
        'window_start': chrono[0]['date'], 'window_end': chrono[-1]['date'],
        'n_games': len(chrono),
    }

    pitchers, team_tto = pitcher_table(repo, team_code, md_games, bat_canon,
                                       pit_canon, team_pitcher_set, logger=log)
    work = workload(repo, team_code, repo_games[-5:], pit_canon, logger=log)
    lineup = lineup_table(repo, team_code, repo_games[-5:], md_games[-5:], bat_canon)
    br = baserunning(repo, team_code, focal_team_codes(config), md_games, bat_canon)
    cad = cadence(md_games[-5:])
    log.info("[%s] Computed metrics: %d pitchers, %d lineup spots, %d cadence games",
             team_code, len(pitchers), len(lineup), len(cad))

    return {
        'cover': cover,
        'season': season, 'l10': l10, 'l5': l5,
        'league_avg': league_avg,
        'lineup': lineup,
        'pitchers': pitchers, 'team_tto': team_tto,
        'workload': work,
        'baserunning': br,
        'cadence': cad,
        'l5_chrono': l5_chrono,
    }


def build_brief(repo: dict, config: dict, team_code: str, games_dir: Path,
                output_dir: Path, window_days: int | None) -> bool:
    data = assemble(repo, config, team_code, games_dir, window_days)
    if data is None:
        return False
    output_path = output_dir / f"{team_code}_brief.pdf"
    render_pdf(data, output_path)
    log.info("[%s] Wrote %s", team_code, output_path)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description='Generate a printable PDF scouting brief for one or all focal teams.',
    )
    parser.add_argument('--team', help='Team code (e.g., LNRC). Required unless --all.')
    parser.add_argument('--all', action='store_true', help='Generate briefs for all 15 focal teams.')
    parser.add_argument('--repo-json', default=str(REPO_ROOT / 'public' / 'repository.json'))
    parser.add_argument('--games-dir', default=str(REPO_ROOT / 'games'))
    parser.add_argument('--output-dir', default=str(REPO_ROOT / 'public' / 'briefs'))
    parser.add_argument('--window', type=int, help='Only consider games from last N days')
    parser.add_argument('--quiet', action='store_true', help='Log warnings only')
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format='%(levelname)s %(message)s',
    )

    if not args.team and not args.all:
        parser.error('Either --team or --all is required')
    if args.team and args.all:
        parser.error('Cannot combine --team and --all')

    repo = load_repo(Path(args.repo_json))
    config = load_config(CONFIG_PATH)
    games_dir = Path(args.games_dir)
    output_dir = Path(args.output_dir)

    if args.team:
        if args.team not in {t['code'] for t in config.get('focal_teams', [])}:
            log.error("Unknown focal team code: %s. Known: %s",
                      args.team, ', '.join(focal_team_codes(config)))
            return 1
        ok = build_brief(repo, config, args.team, games_dir, output_dir, args.window)
        return 0 if ok else 1

    teams = focal_team_codes(config)
    log.info("Generating briefs for %d focal teams", len(teams))
    success = 0
    for code in teams:
        try:
            if build_brief(repo, config, code, games_dir, output_dir, args.window):
                success += 1
        except Exception as e:
            log.error("[%s] Failed: %s", code, e, exc_info=not args.quiet)
    log.info("Done: %d/%d briefs generated", success, len(teams))
    return 0 if success > 0 else 1


if __name__ == '__main__':
    sys.exit(main())
