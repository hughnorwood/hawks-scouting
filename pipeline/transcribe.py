#!/usr/bin/env python3
"""Transcribe raw GC play-by-play text into structured markdown via Claude API.

Reads prompts/transcribe.md verbatim as the system prompt.
Reads a raw .txt file from pipeline/raw/.
Writes the resulting markdown to games/YYYY-MM-DD_AWAY_at_HOME.md.

Usage:
  export ANTHROPIC_API_KEY="sk-..."
  python pipeline/transcribe.py pipeline/raw/stub_game_raw.txt
"""

import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)
except ImportError:
    pass  # dotenv optional — env vars can be set directly

try:
    import anthropic
except ImportError:
    sys.exit("anthropic is required: pip install anthropic")

from dedup import find_all_existing_games, load_focal_index

REPO_ROOT = Path(__file__).resolve().parent.parent
PROMPTS_DIR = REPO_ROOT / "prompts"
GAMES_DIR = REPO_ROOT / "games"
PIPELINE_DIR = REPO_ROOT / "pipeline"
CONFIG_FILE = PIPELINE_DIR / "config.json"

MODEL = "claude-sonnet-4-20250514"
MAX_TOKENS = 16000

# Maximum allowed gap between a parsed Game_ID date and the raw filename's
# date. Larger gaps almost always mean the parser locked onto a stray 4-digit
# substring (the May-7 2026 → 2020/2024 incident).
MAX_DATE_DRIFT_DAYS = 3


def _parse_raw_filename(raw_filename):
    """Return (focal_team_code, date_str) parsed from a raw filename, or (None, None).

    Raw filenames are produced by scrape.py and follow the strict pattern
    `TEAM_YYYY-MM-DD_opponent_uuid.txt`.
    """
    m = re.match(r"([A-Z]{3,5})_(\d{4}-\d{2}-\d{2})_", raw_filename)
    if not m:
        return None, None
    return m.group(1), m.group(2)


def _date_diff_days(a, b):
    """Absolute day-difference between two YYYY-MM-DD strings, or None on parse failure."""
    try:
        ya, ma, da = (int(x) for x in a.split("-"))
        yb, mb, db = (int(x) for x in b.split("-"))
        return abs((date(ya, ma, da) - date(yb, mb, db)).days)
    except (ValueError, AttributeError):
        return None


def _load_team_registry():
    """Build (pattern, code) pairs from config.json, longest-pattern-first.

    Mirrors ingest.load_team_registry — duplicated here to keep transcribe.py
    free of import cycles with ingest.py.
    """
    try:
        config = json.loads(CONFIG_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    registry = []
    for team in config.get("focal_teams", []):
        for pattern in team.get("name_patterns", []):
            registry.append((pattern.lower(), team["code"]))
    for team in config.get("known_opponents", []):
        for pattern in team.get("name_patterns", []):
            registry.append((pattern.lower(), team["code"]))
    registry.sort(key=lambda x: -len(x[0]))
    return registry


def _resolve_name_to_code(full_name, registry):
    name_lower = (full_name or "").lower().strip()
    if not name_lower:
        return None
    for pattern, code in registry:
        if pattern in name_lower:
            return code
    return None


def _extract_teams_line(header):
    """Parse the markdown header's "Teams:" line and return [away_name, home_name] or []."""
    teams_match = re.search(r'Teams[:\*]*\s*(.+)', header)
    if not teams_match:
        return []
    line = teams_match.group(1).strip()
    parts = re.split(r'\s*(?:vs\.?|/|@)\s*', line, maxsplit=1)
    if len(parts) != 2:
        return []
    names = []
    for part in parts:
        name = re.sub(r'\s*\(?(away|home)\)?\s*$', '', part.strip(), flags=re.I)
        name = re.sub(r'\s*\(?[A-Z]{3,5}\)?\s*$', '', name).strip()
        name = re.sub(r'^[A-Z]{3,5}\s+', '', name).strip()
        names.append(name)
    return names


def load_prompt():
    """Load prompts/transcribe.md verbatim."""
    path = PROMPTS_DIR / "transcribe.md"
    if not path.exists():
        sys.exit(f"Transcription prompt not found: {path}")
    return path.read_text()


def extract_game_id(markdown_text, raw_filename=None):
    """Parse the Game_ID from the markdown output header.

    Constructs YYYY-MM-DD_AWAY_at_HOME from the header fields. When a
    `raw_filename` is provided, its date acts as a sanity-check anchor: any
    parsed date more than MAX_DATE_DRIFT_DAYS away from it is rejected
    (this catches the failure mode where the parser locks onto a stray
    4-digit substring like "(2020-2025)" and emits a Game_ID years off).
    The raw filename's date is also used as a final fallback when the
    markdown contains no parseable date.
    """
    header = markdown_text[:3000]
    raw_team, raw_date = (None, None)
    if raw_filename:
        raw_team, raw_date = _parse_raw_filename(raw_filename)

    def _date_ok(candidate):
        """Reject candidate dates that drift too far from the raw filename's date."""
        if not candidate or not raw_date:
            return True  # no anchor → accept
        diff = _date_diff_days(candidate, raw_date)
        return diff is not None and diff <= MAX_DATE_DRIFT_DAYS

    # 1. Try direct Game_ID pattern (e.g. in a filename or explicit mention)
    m = re.search(r'(\d{4}-\d{2}-\d{2})_([A-Z]{3,5})_at_([A-Z]{3,5})', header)
    if m and _date_ok(m.group(1)):
        return f"{m.group(1)}_{m.group(2)}_at_{m.group(3)}"

    # 2. Extract date
    date_str = None

    # YYYY-MM-DD format
    for cand in re.findall(r'(\d{4}-\d{2}-\d{2})', header):
        if _date_ok(cand):
            date_str = cand
            break

    if not date_str:
        # "Mon Apr 8" or "Wed Apr 8, 4:15 PM" — day-of-week + abbreviated month + day
        MONTHS = {'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
                  'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12}
        m = re.search(r'(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})', header)
        if m:
            month = MONTHS[m.group(1)]
            day = int(m.group(2))
            # Prefer the raw filename's year over the hardcoded fallback so
            # the pipeline doesn't silently rot when a new season starts.
            yr = re.search(r'(\d{4})', header[m.end():m.end()+20])
            if yr:
                year = int(yr.group(1))
            elif raw_date:
                year = int(raw_date.split("-")[0])
            else:
                year = 2026
            cand = f"{year}-{month:02d}-{day:02d}"
            if _date_ok(cand):
                date_str = cand

    if not date_str:
        # "April 8, 2026" or "March 10, 2026"
        MONTHS_FULL = {'January': 1, 'February': 2, 'March': 3, 'April': 4,
                       'May': 5, 'June': 6, 'July': 7, 'August': 8,
                       'September': 9, 'October': 10, 'November': 11, 'December': 12}
        m = re.search(r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})?', header)
        if m:
            month = MONTHS_FULL[m.group(1)]
            day = int(m.group(2))
            if m.group(3):
                year = int(m.group(3))
            elif raw_date:
                year = int(raw_date.split("-")[0])
            else:
                year = 2026
            cand = f"{year}-{month:02d}-{day:02d}"
            if _date_ok(cand):
                date_str = cand

    # Final date fallback: trust the raw filename when the markdown is silent.
    if not date_str and raw_date:
        date_str = raw_date

    if not date_str:
        return None

    # 3. Extract team codes (3-5 uppercase letters)

    # Try "Final Score: AWAY NN - HOME NN" or "AWAY NN, HOME NN"
    m = re.search(r'Final\s+Score.*?([A-Z]{3,5})\s+\d+\s*[-–,]\s*([A-Z]{3,5})\s+\d+', header)
    if m:
        return f"{date_str}_{m.group(1)}_at_{m.group(2)}"

    # Try line score table (pipe-delimited): first team code is away, second is home
    team_codes = re.findall(r'\|\s*([A-Z]{3,5})\s*\|', header)
    if len(team_codes) >= 2:
        return f"{date_str}_{team_codes[0]}_at_{team_codes[1]}"

    # Try line score in code-block format (no pipes): lines starting with team codes
    code_block_teams = re.findall(r'^\s*([A-Z]{3,5})\s+\d', header, re.MULTILINE)
    if len(code_block_teams) >= 2:
        return f"{date_str}_{code_block_teams[0]}_at_{code_block_teams[1]}"

    # Try "TEAM (CODE) @ TEAM (CODE)" pattern in header
    m = re.search(r'\(([A-Z]{3,5})\)\s*(?:@|at|vs\.?)\s*.*?\(([A-Z]{3,5})\)', header)
    if m:
        return f"{date_str}_{m.group(1)}_at_{m.group(2)}"

    # Try "AWAY at/vs HOME" bare codes
    m = re.search(r'([A-Z]{3,5})\s+(?:at|@|vs\.?)\s+([A-Z]{3,5})', header)
    if m:
        return f"{date_str}_{m.group(1)}_at_{m.group(2)}"

    # Last resort: resolve full team names from the "Teams:" line via the
    # config registry, slotting the raw filename's focal team into whichever
    # side (away/home) it matches. This rescues games where the model emitted
    # only full names (e.g. Mt. Hebron games where "MTHB" never appears as a
    # bare code in the header).
    team_names = _extract_teams_line(header)
    if len(team_names) == 2:
        registry = _load_team_registry()
        away_code = _resolve_name_to_code(team_names[0], registry)
        home_code = _resolve_name_to_code(team_names[1], registry)
        if away_code and home_code:
            return f"{date_str}_{away_code}_at_{home_code}"
        if raw_team and (away_code or home_code):
            # One side resolved, the other is unknown — slot raw_team into
            # whichever side matches it (it might be the unresolved side).
            if away_code and not home_code:
                return f"{date_str}_{away_code}_at_{raw_team}" if away_code != raw_team else None
            if home_code and not away_code:
                return f"{date_str}_{raw_team}_at_{home_code}" if home_code != raw_team else None

    return None


def transcribe(raw_text, system_prompt):
    """Call Claude API to transcribe raw play-by-play text."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("Set ANTHROPIC_API_KEY environment variable")

    client = anthropic.Anthropic(api_key=api_key)

    user_message = (
        "File naming prefix: RVRH_Game. "
        "This is a single game. Produce one markdown document.\n\n"
        + raw_text
    )

    print(f"Calling Claude API ({MODEL})...")
    print(f"  System prompt: {len(system_prompt):,} chars")
    print(f"  User message: {len(user_message):,} chars")

    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )

    text = response.content[0].text
    print(f"  Response: {len(text):,} chars, {response.usage.input_tokens} input / {response.usage.output_tokens} output tokens")

    # Rate-limit courtesy delay between API calls
    print("  Waiting 15s (rate-limit delay)...")
    time.sleep(15)

    return text


def pre_check_duplicate(raw_filename):
    """Check if a game for this team+date already exists in games/ BEFORE calling the API.

    Raw filenames follow the pattern: TEAM_YYYY-MM-DD_opponent_uuid.txt
    Existing game files follow: YYYY-MM-DD_AWAY_at_HOME.md, where the team
    code may be the focal team's canonical code OR an alias (HRFR for HRFD,
    NRTH for NHRF, etc.). Alias resolution is delegated to dedup.py.

    For doubleheaders (multiple games on the same date for the same team),
    only skip if we already have as many .md files as raw files for this date.
    """
    m = re.match(r"([A-Z]{3,5})_(\d{4}-\d{2}-\d{2})_", raw_filename)
    if not m:
        return False, None

    team_code = m.group(1)
    date_str = m.group(2)

    focal_by_code, known_opponent_codes = load_focal_index()
    focal_entry = focal_by_code.get(team_code)
    if not focal_entry:
        existing = [p.stem for p in GAMES_DIR.glob(f"{date_str}_*.md") if team_code in p.stem]
        return (bool(existing), existing[0] if existing else None)

    matches = find_all_existing_games(
        date_str=date_str,
        focal_code=team_code,
        focal_aliases=focal_entry.get("aliases", []),
        focal_display_name=focal_entry.get("display_name", team_code),
        known_opponent_codes=known_opponent_codes,
        games_dir=GAMES_DIR,
    )

    raw_dir = Path(__file__).resolve().parent / "raw"
    raw_count = len(list(raw_dir.glob(f"{team_code}_{date_str}_*.txt")))

    if matches and len(matches) >= raw_count:
        return True, matches[0]

    return False, None


def main():
    if len(sys.argv) < 2:
        sys.exit("Usage: python pipeline/transcribe.py <raw_text_file>")

    raw_path = Path(sys.argv[1])
    if not raw_path.exists():
        sys.exit(f"File not found: {raw_path}")

    # Pre-check: skip API call if a game for this team+date already exists
    already_exists, existing_id = pre_check_duplicate(raw_path.name)
    if already_exists:
        print(f"SKIP (pre-check): {raw_path.name} → {existing_id}.md already exists.")
        sys.exit(0)

    raw_text = raw_path.read_text()
    if len(raw_text.strip()) < 100:
        sys.exit(f"Raw text too short ({len(raw_text)} chars) — likely not a valid play-by-play")

    system_prompt = load_prompt()
    markdown = transcribe(raw_text, system_prompt)

    # Parse Game_ID from the output
    game_id = extract_game_id(markdown, raw_filename=raw_path.name)
    if not game_id:
        # Save with raw filename as fallback so pipeline can continue
        raw_stem = Path(sys.argv[1]).stem
        fallback = GAMES_DIR / f"UNKNOWN_{raw_stem}.md"
        GAMES_DIR.mkdir(parents=True, exist_ok=True)
        fallback.write_text(markdown)
        print(f"\nWARNING: Could not parse Game_ID from output.")
        print(f"Markdown saved to {fallback} for manual inspection.")
        print("First 500 chars of output:")
        print(markdown[:500])
        sys.exit(0)  # exit 0 so pipeline continues past this game

    # Check for duplicate
    out_file = GAMES_DIR / f"{game_id}.md"
    if out_file.exists():
        print(f"\nSKIP: {out_file} already exists. Not overwriting.")
        sys.exit(0)

    GAMES_DIR.mkdir(parents=True, exist_ok=True)
    out_file.write_text(markdown)
    print(f"\nTranscription complete.")
    print(f"  Game_ID: {game_id}")
    print(f"  Output:  {out_file}")
    print(f"  Size:    {len(markdown):,} chars")


if __name__ == "__main__":
    main()
