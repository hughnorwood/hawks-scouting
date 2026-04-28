"""Load + filter public/repository.json and pipeline/config.json."""
from __future__ import annotations
import json
from pathlib import Path


def load_repo(repo_json_path: Path) -> dict:
    with open(repo_json_path) as f:
        return json.load(f)


def load_config(config_path: Path) -> dict:
    with open(config_path) as f:
        return json.load(f)


def focal_team_codes(config: dict) -> list[str]:
    """Return the list of focal team codes from config.json."""
    return [t['code'] for t in config.get('focal_teams', [])]


def name_patterns_for(config: dict, team_code: str) -> list[str]:
    """Return name_patterns list for a team code from focal_teams or known_opponents."""
    for entry in config.get('focal_teams', []) + config.get('known_opponents', []):
        if entry['code'] == team_code:
            return list(entry.get('name_patterns', []))
    return []


def display_name(repo: dict, team_code: str) -> str:
    """Resolve display name from repository.json teams dict; fall back to code."""
    return repo.get('teams', {}).get(team_code, team_code)


def unique_team_games(repo: dict, team_code: str) -> list[dict]:
    """Game_Log rows where team participated. Dedupes on Game_ID (focal-vs-focal duplicates)."""
    seen = set()
    out = []
    for g in sorted(repo['gameLog'], key=lambda x: x['Game_Date']):
        if g['Away_Team'] == team_code or g['Home_Team'] == team_code:
            if g['Game_ID'] in seen:
                continue
            seen.add(g['Game_ID'])
            out.append(g)
    return out


def filter_games_window(games: list[dict], window_days: int | None) -> list[dict]:
    """Trim games list to those within the last N days of the latest game date."""
    if not window_days or not games:
        return games
    from datetime import date, timedelta
    latest = max(date.fromisoformat(g['Game_Date']) for g in games)
    cutoff = latest - timedelta(days=window_days)
    return [g for g in games if date.fromisoformat(g['Game_Date']) >= cutoff]
