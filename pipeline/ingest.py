#!/usr/bin/env python3
"""Ingest a transcribed game markdown into the master Excel repository via Claude API.

Architecture:
  - Python reads the Excel to check for duplicates and get existing Game_IDs
  - Claude API receives the ingest prompt + game markdown + focal team + existing Game_IDs
  - Claude returns structured JSON with rows to append to each sheet
  - Python validates gate results, appends rows to Excel, and calls export.py

Usage:
  export ANTHROPIC_API_KEY="sk-..."
  python pipeline/ingest.py games/2026-04-08_GLNL_at_GLFR.md
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)
except ImportError:
    pass

try:
    import anthropic
except ImportError:
    sys.exit("anthropic is required: pip install anthropic")

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required: pip install openpyxl")

REPO_ROOT = Path(__file__).resolve().parent.parent
PROMPTS_DIR = REPO_ROOT / "prompts"
PIPELINE_DIR = REPO_ROOT / "pipeline"
DATA_DIR = REPO_ROOT / "data"
EXCEL_FILE = DATA_DIR / "RiverHill_Repository_Master.xlsx"
CONFIG_FILE = PIPELINE_DIR / "config.json"

MODEL = "claude-sonnet-4-20250514"
MAX_TOKENS = 16000


def load_prompt():
    """Load prompts/ingest.md verbatim."""
    path = PROMPTS_DIR / "ingest.md"
    if not path.exists():
        sys.exit(f"Ingestion prompt not found: {path}")
    return path.read_text()


def load_config():
    if not CONFIG_FILE.exists():
        sys.exit(f"Config not found: {CONFIG_FILE}")
    with open(CONFIG_FILE) as f:
        return json.load(f)


def get_existing_game_ids():
    """Read all Game_IDs from the Game_Log sheet."""
    wb = openpyxl.load_workbook(EXCEL_FILE, read_only=True, data_only=True)
    ws = wb["Game_Log"]
    game_ids = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            continue
        if row and row[0]:
            game_ids.append(str(row[0]))
    wb.close()
    return game_ids


def determine_focal_team(game_md_text, config):
    """Determine the focal team based on which focal team codes appear in the header."""
    focal_codes = {t["code"] for t in config["focal_teams"]}
    primary_code = next((t["code"] for t in config["focal_teams"] if t.get("primary")), "RVRH")

    header = game_md_text[:2000]
    found_focal = [code for code in focal_codes if code in header]

    if not found_focal:
        sys.exit("Could not determine focal team — no focal team codes found in game header")

    return primary_code if primary_code in found_focal else found_focal[0]


def call_claude(system_prompt, game_md_text, focal_team, existing_game_ids):
    """Call Claude API to extract structured data from the game markdown."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("Set ANTHROPIC_API_KEY environment variable")

    # Build the user message with context Claude needs
    user_message = (
        f"Focal team: {focal_team}\n\n"
        f"Existing Game_IDs in repository (for duplicate check):\n"
        f"{json.dumps(existing_game_ids)}\n\n"
        f"IMPORTANT: You cannot read or write the Excel file directly. Instead, after completing "
        f"your full analysis per the ingestion prompt (Steps 0-4, all verification gates), output "
        f"your results as a JSON block that I will use to append rows to the Excel file.\n\n"
        f"After your confirmation block, output a JSON block fenced with ```json and ``` containing:\n"
        f'{{"game_log": {{...single row as dict...}},\n'
        f' "batting": [{{...row dicts...}}],\n'
        f' "pitching": [{{...row dicts...}}],\n'
        f' "fielding": [{{...row dicts...}}],\n'
        f' "gates": {{"G1": {{"pass": true/false, "value": N}}, ...}},\n'
        f' "duplicate": false,\n'
        f' "notes": "..."}}\n\n'
        f"Use the exact column names from the locked schema. All numeric fields must be numbers, not strings.\n\n"
        f"--- GAME LOG MARKDOWN ---\n\n"
        f"{game_md_text}"
    )

    client = anthropic.Anthropic(api_key=api_key)

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
    return text


def parse_json_from_response(response_text):
    """Extract the JSON block from the API response."""
    # Look for ```json ... ``` block
    m = re.search(r'```json\s*\n(.*?)\n```', response_text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError as e:
            print(f"JSON parse error: {e}")
            print(f"Raw JSON block:\n{m.group(1)[:500]}")
            return None

    # Try to find raw JSON object
    m = re.search(r'\{[\s\S]*"game_log"[\s\S]*"batting"[\s\S]*\}', response_text)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    return None


def append_to_excel(data):
    """Append the extracted rows to the Excel file."""
    wb = openpyxl.load_workbook(EXCEL_FILE)

    # Sheet column orders (must match locked schema exactly)
    SCHEMAS = {
        "Game_Log": ["Game_ID", "Game_Date", "Game_Type", "Focal_Team", "Away_Team", "Home_Team",
                     "Innings_Played", "Source_File", "Away_R", "Away_H", "Away_E",
                     "Home_R", "Home_H", "Home_E", "QA_Flag_Count", "Notes"],
        "Batting": ["Game_ID", "Game_Date", "Opponent", "Team", "Player", "PA", "AB", "H",
                    "1B", "2B", "3B", "HR", "BB", "HBP", "K", "K_L", "K_S",
                    "R", "RBI", "SB", "CS", "GDP", "SAC", "FC", "Notes"],
        "Pitching": ["Game_ID", "Game_Date", "Opponent", "Team", "Pitcher", "Outs_Recorded",
                     "BF", "H_Allowed", "1B_Allowed", "2B_Allowed", "3B_Allowed", "HR_Allowed",
                     "BB_Allowed", "HBP_Allowed", "K", "R_Allowed", "WP", "Notes"],
        "Fielding": ["Game_ID", "Game_Date", "Opponent", "Team", "Player", "Inning",
                     "Play_Ref", "Notes"],
    }

    counts = {}

    # Append Game_Log row
    ws = wb["Game_Log"]
    row_data = data["game_log"]
    ws.append([row_data.get(col, "") for col in SCHEMAS["Game_Log"]])
    counts["Game_Log"] = 1

    # Append Batting rows
    ws = wb["Batting"]
    for row_data in data["batting"]:
        ws.append([row_data.get(col, 0 if col not in ("Game_ID", "Game_Date", "Opponent", "Team", "Player", "Notes") else "") for col in SCHEMAS["Batting"]])
    counts["Batting"] = len(data["batting"])

    # Append Pitching rows
    ws = wb["Pitching"]
    for row_data in data["pitching"]:
        ws.append([row_data.get(col, 0 if col not in ("Game_ID", "Game_Date", "Opponent", "Team", "Pitcher", "Notes") else "") for col in SCHEMAS["Pitching"]])
    counts["Pitching"] = len(data["pitching"])

    # Append Fielding rows
    ws = wb["Fielding"]
    for row_data in data["fielding"]:
        ws.append([row_data.get(col, "") for col in SCHEMAS["Fielding"]])
    counts["Fielding"] = len(data["fielding"])

    wb.save(EXCEL_FILE)
    wb.close()

    return counts


def main():
    if len(sys.argv) < 2:
        sys.exit("Usage: python pipeline/ingest.py <game_markdown_file>")

    game_md_path = Path(sys.argv[1])
    if not game_md_path.exists():
        sys.exit(f"File not found: {game_md_path}")

    if not EXCEL_FILE.exists():
        sys.exit(f"Excel file not found: {EXCEL_FILE}")

    system_prompt = load_prompt()
    config = load_config()
    game_md_text = game_md_path.read_text()

    # Determine focal team
    focal_team = determine_focal_team(game_md_text, config)
    print(f"Ingesting: {game_md_path.name}")
    print(f"  Focal team: {focal_team}")

    # Check for duplicates in Python first (fast check)
    existing_ids = get_existing_game_ids()
    # Extract Game_ID from the markdown to check
    gid_match = re.search(r'(\d{4}-\d{2}-\d{2})_([A-Z]{3,5})_at_([A-Z]{3,5})', game_md_path.stem)
    if gid_match:
        candidate_id = game_md_path.stem
        if candidate_id in existing_ids:
            print(f"\nDUPLICATE DETECTED: {candidate_id} already exists in the repository.")
            print("No data written — duplicate guard fired correctly.")
            sys.exit(0)

    # Call Claude API
    response_text = call_claude(system_prompt, game_md_text, focal_team, existing_ids)

    # Check for duplicate detection in response
    if re.search(r"DUPLICATE\s+DETECTED", response_text, re.IGNORECASE):
        m = re.search(r"DUPLICATE\s+DETECTED.*?(?:\n|$)", response_text, re.IGNORECASE)
        print(f"\n{m.group(0).strip() if m else 'Duplicate detected by Claude'}")
        print("No data written — duplicate guard fired correctly.")
        sys.exit(0)

    # Parse JSON from response
    data = parse_json_from_response(response_text)
    if not data:
        print("\nERROR: Could not parse JSON from API response.")
        print("\n--- Full API Response ---")
        print(response_text)
        sys.exit(1)

    # Check gates
    gates = data.get("gates", {})
    all_passed = True
    for gate_name in ["G1", "G2", "G3", "G4", "G5", "G6"]:
        gate = gates.get(gate_name, {})
        passed = gate.get("pass", False)
        value = gate.get("value", "?")
        status = "✅" if passed else "❌"
        print(f"  {gate_name} {status} {value}")
        if not passed:
            all_passed = False

    if not all_passed:
        print("\nGATE FAILURE — not writing to Excel.")
        print(f"Notes: {data.get('notes', '')}")
        sys.exit(1)

    if data.get("duplicate", False):
        print("\nDuplicate flag set in response — not writing.")
        sys.exit(0)

    # Write to Excel
    print("\nAll gates passed — appending to Excel...")
    counts = append_to_excel(data)
    print(f"  Rows added — Game_Log: {counts['Game_Log']} | Batting: {counts['Batting']} | Pitching: {counts['Pitching']} | Fielding: {counts['Fielding']}")

    # Run export.py
    print("\nRunning export.py to regenerate repository.json...")
    result = subprocess.run(
        [sys.executable, str(PIPELINE_DIR / "export.py")],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(result.stdout.strip())
    else:
        print(f"export.py failed: {result.stderr}")
        sys.exit(1)

    print("\nIngestion complete.")


if __name__ == "__main__":
    main()
