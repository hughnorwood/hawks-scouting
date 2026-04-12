#!/usr/bin/env python3
"""Transcribe raw GC play-by-play text into structured markdown via Claude API.

Reads prompts/transcribe.md verbatim as the system prompt.
Reads a raw .txt file from pipeline/raw/.
Writes the resulting markdown to games/YYYY-MM-DD_AWAY_at_HOME.md.

Usage:
  export ANTHROPIC_API_KEY="sk-..."
  python pipeline/transcribe.py pipeline/raw/stub_game_raw.txt
"""

import os
import re
import sys
import time
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

REPO_ROOT = Path(__file__).resolve().parent.parent
PROMPTS_DIR = REPO_ROOT / "prompts"
GAMES_DIR = REPO_ROOT / "games"

MODEL = "claude-sonnet-4-20250514"
MAX_TOKENS = 16000


def load_prompt():
    """Load prompts/transcribe.md verbatim."""
    path = PROMPTS_DIR / "transcribe.md"
    if not path.exists():
        sys.exit(f"Transcription prompt not found: {path}")
    return path.read_text()


def extract_game_id(markdown_text):
    """Parse the Game_ID from the markdown output header.

    Constructs YYYY-MM-DD_AWAY_at_HOME from the header fields.
    """
    header = markdown_text[:3000]

    # 1. Try direct Game_ID pattern (e.g. in a filename or explicit mention)
    m = re.search(r'(\d{4}-\d{2}-\d{2})_([A-Z]{3,5})_at_([A-Z]{3,5})', header)
    if m:
        return f"{m.group(1)}_{m.group(2)}_at_{m.group(3)}"

    # 2. Extract date
    date_str = None

    # YYYY-MM-DD format
    m = re.search(r'(\d{4}-\d{2}-\d{2})', header)
    if m:
        date_str = m.group(1)

    if not date_str:
        # "Mon Apr 8" or "Wed Apr 8, 4:15 PM" — day-of-week + abbreviated month + day
        MONTHS = {'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
                  'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12}
        m = re.search(r'(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})', header)
        if m:
            month = MONTHS[m.group(1)]
            day = int(m.group(2))
            # Look for a year nearby, otherwise assume current year
            yr = re.search(r'(\d{4})', header[m.end():m.end()+20])
            year = int(yr.group(1)) if yr else 2026
            date_str = f"{year}-{month:02d}-{day:02d}"

    if not date_str:
        # "April 8, 2026" or "March 10, 2026"
        MONTHS_FULL = {'January': 1, 'February': 2, 'March': 3, 'April': 4,
                       'May': 5, 'June': 6, 'July': 7, 'August': 8,
                       'September': 9, 'October': 10, 'November': 11, 'December': 12}
        m = re.search(r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})?', header)
        if m:
            month = MONTHS_FULL[m.group(1)]
            day = int(m.group(2))
            year = int(m.group(3)) if m.group(3) else 2026
            date_str = f"{year}-{month:02d}-{day:02d}"

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
    Existing game files follow: YYYY-MM-DD_AWAY_at_HOME.md

    For doubleheaders (multiple games on the same date for the same team),
    we count how many existing .md files match vs how many raw files exist
    for the same team+date. Only skip if all games for that date are covered.
    """
    m = re.match(r"([A-Z]{3,5})_(\d{4}-\d{2}-\d{2})_", raw_filename)
    if not m:
        return False, None

    team_code = m.group(1)
    date_str = m.group(2)

    if not GAMES_DIR.exists():
        return False, None

    # Count existing .md files for this team+date
    existing = [p.stem for p in GAMES_DIR.glob("*.md") if date_str in p.stem and team_code in p.stem]

    # Count raw files for this team+date (to detect doubleheaders)
    raw_dir = Path(__file__).resolve().parent / "raw"
    raw_count = len(list(raw_dir.glob(f"{team_code}_{date_str}_*.txt")))

    # Only skip if we already have as many .md files as raw files for this date
    if existing and len(existing) >= raw_count:
        return True, existing[0]

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
    game_id = extract_game_id(markdown)
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
