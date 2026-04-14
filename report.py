#!/usr/bin/env python3
"""
Hawks Scouting Report Builder — batch query tool for full game logs.

Map-reduce architecture: processes each game's play-by-play markdown
individually through Claude, extracts structured data per the user's
natural language query, then aggregates results into a CSV.

Usage:
    python report.py --team RVRH -q "first pitch strike percentage by pitcher"
    python report.py --teams RVRH,LNRC --after 2026-03-20 -q "runs scored per inning"
    python report.py --all -q "stolen base attempts and success rate by team"
    python report.py   # interactive mode — prompts for filter and query
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import anthropic
except ImportError:
    sys.exit("anthropic is required: pip install anthropic")

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

# ─── Constants ────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent
REPOSITORY_JSON = REPO_ROOT / "public" / "repository.json"
GAMES_DIR = REPO_ROOT / "games"
REPORTS_DIR = REPO_ROOT / "reports"
MODEL = "claude-sonnet-4-20250514"
MAX_TOKENS = 4096
DELAY_BETWEEN_CALLS = 2  # seconds

TEAM_NAMES = {
    "RVRH": "River Hill", "CNTN": "Centennial", "GLNL": "Glenelg",
    "HNTN": "Huntingtown", "PRKS": "Parkside", "STHR": "Southern",
    "FLLS": "Fallston", "MDLT": "Middletown", "HRFD": "Hereford",
    "NHRF": "North Harford", "CNTY": "Century", "KTIS": "Kent Island",
    "LNRC": "Long Reach",
}

# Reverse lookup: full name → code
NAME_TO_CODE = {v.upper(): k for k, v in TEAM_NAMES.items()}


# ─── Data Loading ─────────────────────────────────────────────────────────────

def load_data():
    """Load repository.json."""
    if not REPOSITORY_JSON.exists():
        sys.exit(f"Data file not found: {REPOSITORY_JSON}")
    with open(REPOSITORY_JSON) as f:
        return json.load(f)


def resolve_team_code(name):
    """Resolve a team name or code to the canonical 4-letter code."""
    up = name.strip().upper()
    if up in TEAM_NAMES:
        return up
    if up in NAME_TO_CODE:
        return NAME_TO_CODE[up]
    # Partial match
    for full, code in NAME_TO_CODE.items():
        if up in full:
            return code
    return name.upper()


# ─── Game Selection ───────────────────────────────────────────────────────────

def select_games(data, args):
    """Filter game log by CLI parameters. Returns list of (game_id, game_row) tuples
    where a matching .md file exists."""
    games = data.get("gameLog", [])

    # Team filter
    team_codes = set()
    if args.team:
        team_codes.add(resolve_team_code(args.team))
    if args.teams:
        for t in args.teams.split(","):
            team_codes.add(resolve_team_code(t.strip()))

    filtered = []
    for g in games:
        gid = g.get("Game_ID", "")
        away = g.get("Away_Team", "")
        home = g.get("Home_Team", "")
        date = str(g.get("Game_Date", ""))

        # Team filter
        if team_codes:
            if args.home_only:
                if home not in team_codes:
                    continue
            elif args.away_only:
                if away not in team_codes:
                    continue
            else:
                if away not in team_codes and home not in team_codes:
                    continue

        # Date filters
        if args.after and date < args.after:
            continue
        if args.before and date > args.before:
            continue

        # Check .md file exists
        md_path = GAMES_DIR / f"{gid}.md"
        if not md_path.exists():
            continue

        filtered.append((gid, g, md_path))

    # Sort by date
    filtered.sort(key=lambda x: str(x[1].get("Game_Date", "")))
    return filtered


# ─── Map Phase ────────────────────────────────────────────────────────────────

def build_map_prompt(query):
    """Build the system prompt for the map phase."""
    return f"""You are a baseball data analyst. You will receive a full play-by-play game log in markdown format.

Your task: {query}

Analyze the play-by-play data carefully. Extract the requested information from this single game.

Return ONLY valid JSON — no markdown fences, no explanation, no commentary. Use this exact structure:

{{"game_id": "the Game_ID from the header",
 "date": "YYYY-MM-DD",
 "away_team": "4-letter code",
 "home_team": "4-letter code",
 "data": [
   ... array of extracted records, one per relevant unit (player, inning, team, etc.) ...
 ]}}

Rules for the "data" array:
- Use consistent field names across all records
- Use numeric values for counts and rates (not strings)
- Include only fields relevant to the query
- If no data matches the query for this game, return an empty "data" array
- For percentages, return as decimal (0.667 not "66.7%")
- For player names, use exactly the name as it appears in the play log"""


def map_game(client, system_prompt, md_path, game_id):
    """Process a single game through Claude. Returns parsed JSON dict or None."""
    game_text = md_path.read_text()

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=system_prompt,
            messages=[{"role": "user", "content": game_text}],
        )
        text = response.content[0].text

        # Try to parse JSON — strip any markdown fences if Claude included them
        clean = re.sub(r'^```json\s*\n?', '', text.strip())
        clean = re.sub(r'\n?```\s*$', '', clean)

        return json.loads(clean)

    except json.JSONDecodeError as e:
        print(f"    ⚠ JSON parse error: {e}")
        # Save raw response for debugging
        err_path = REPORTS_DIR / f"error_{game_id}.txt"
        err_path.write_text(text)
        print(f"    Raw response saved to {err_path}")
        return None

    except anthropic.APIError as e:
        print(f"    ⚠ API error: {e}")
        # Retry once after 5s
        print(f"    Retrying in 5s...")
        time.sleep(5)
        try:
            response = client.messages.create(
                model=MODEL, max_tokens=MAX_TOKENS,
                system=system_prompt,
                messages=[{"role": "user", "content": game_text}],
            )
            text = response.content[0].text
            clean = re.sub(r'^```json\s*\n?', '', text.strip())
            clean = re.sub(r'\n?```\s*$', '', clean)
            return json.loads(clean)
        except Exception as e2:
            print(f"    ⚠ Retry failed: {e2}")
            return None

    except Exception as e:
        print(f"    ⚠ Unexpected error: {e}")
        return None


# ─── Reduce Phase ─────────────────────────────────────────────────────────────

def reduce_results(results):
    """Flatten per-game results into a single list of CSV-ready dicts."""
    rows = []
    for r in results:
        if not r or not r.get("data"):
            continue
        meta = {
            "game_id": r.get("game_id", ""),
            "date": r.get("date", ""),
            "away_team": r.get("away_team", ""),
            "home_team": r.get("home_team", ""),
        }
        for record in r["data"]:
            row = {**meta, **record}
            rows.append(row)
    return rows


def write_csv(rows, output_path):
    """Write rows to CSV. Auto-detects columns from all rows."""
    if not rows:
        print("No data to write.")
        return

    # Collect all unique keys across all rows (preserving order)
    all_keys = []
    seen = set()
    for row in rows:
        for k in row:
            if k not in seen:
                all_keys.append(k)
                seen.add(k)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=all_keys, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    if load_dotenv:
        load_dotenv()

    parser = argparse.ArgumentParser(
        description="Hawks Scouting Report Builder — batch query tool for game logs"
    )
    parser.add_argument("--team", help="Single team code or name (e.g., RVRH or 'River Hill')")
    parser.add_argument("--teams", help="Comma-separated team codes (e.g., RVRH,LNRC,CNTN)")
    parser.add_argument("--all", action="store_true", help="Process all games")
    parser.add_argument("--home-only", action="store_true", help="Only home games for the team")
    parser.add_argument("--away-only", action="store_true", help="Only away games for the team")
    parser.add_argument("--after", help="Games on or after date (YYYY-MM-DD)")
    parser.add_argument("--before", help="Games on or before date (YYYY-MM-DD)")
    parser.add_argument("-q", "--query", help="Natural language query")
    parser.add_argument("-o", "--output", help="Output CSV filename")
    args = parser.parse_args()

    # Validate: need at least a team filter or --all
    if not args.team and not args.teams and not args.all:
        print("Hawks Scouting Report Builder")
        print("─" * 40)
        args.team = input("Team code or name (or 'all'): ").strip()
        if args.team.lower() == "all":
            args.all = True
            args.team = None

    if not args.query:
        args.query = input("Query: ").strip()
        if not args.query:
            sys.exit("No query provided.")

    # Check API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("Set ANTHROPIC_API_KEY in .env or environment")

    # Load data and select games
    data = load_data()
    selected = select_games(data, args)

    if not selected:
        sys.exit("No matching games found with available play-by-play files.")

    # Cost estimate
    est_cost = len(selected) * 0.01
    team_desc = args.team or args.teams or "all teams"

    print(f"\nHawks Scouting Report Builder")
    print(f"─" * 40)
    print(f'Query: "{args.query}"')
    print(f"Games: {len(selected)} ({team_desc})")
    print(f"Estimated cost: ~${est_cost:.2f}")
    print(f"Estimated time: ~{len(selected) * (DELAY_BETWEEN_CALLS + 3):.0f}s")

    confirm = input("\nProceed? [y/n] ").strip().lower()
    if confirm != "y":
        sys.exit("Cancelled.")

    # Initialize client
    client = anthropic.Anthropic(api_key=api_key)
    system_prompt = build_map_prompt(args.query)

    # Map phase
    print(f"\nProcessing {len(selected)} games...")
    results = []
    failures = 0

    for i, (gid, game_row, md_path) in enumerate(selected, 1):
        print(f"  [{i}/{len(selected)}] {gid}", end=" ", flush=True)
        result = map_game(client, system_prompt, md_path, gid)
        if result:
            results.append(result)
            data_count = len(result.get("data", []))
            print(f"✓ ({data_count} records)")
        else:
            failures += 1
            print("✗")

        if i < len(selected):
            time.sleep(DELAY_BETWEEN_CALLS)

    # Reduce phase
    rows = reduce_results(results)

    # Output
    if args.output:
        output_path = Path(args.output)
    else:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        output_path = REPORTS_DIR / f"report_{timestamp}.csv"

    write_csv(rows, output_path)

    print(f"\n{len(results)}/{len(selected)} games processed ({failures} failures)")
    if rows:
        print(f"Report written: {output_path} ({len(rows)} rows)")
    else:
        print("No data extracted — check your query or game selection.")


if __name__ == "__main__":
    main()
