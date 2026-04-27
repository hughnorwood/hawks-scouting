#!/usr/bin/env python3
"""Scrape play-by-play text from GameChanger for all focal teams.

Iterates over all focal teams in config.json, finds completed games on each
team's schedule page, checks games/ for existing transcriptions, and extracts
play-by-play text for any new games.

Session persistence:
  After a successful login the full browser state is saved to
  pipeline/gc_session.json.  Subsequent runs load from this file and only
  re-authenticate when the session has expired.

Dry-run mode (--dry-run):
  Skips login entirely.  Loads session from gc_session.json (must already
  exist), navigates and extracts as normal.

Usage:
  python pipeline/scrape.py              # normal mode
  python pipeline/scrape.py --dry-run    # use saved session, no login
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("playwright is required: pip install playwright && python -m playwright install chromium")

REPO_ROOT = Path(__file__).resolve().parent.parent
PIPELINE_DIR = REPO_ROOT / "pipeline"
SESSION_FILE = PIPELINE_DIR / "gc_session.json"
CONFIG_FILE = PIPELINE_DIR / "config.json"
RAW_DIR = PIPELINE_DIR / "raw"
GAMES_DIR = REPO_ROOT / "games"

POLITE_DELAY = 2.5  # seconds between navigations

MONTHS = {
    "January": 1, "February": 2, "March": 3, "April": 4,
    "May": 5, "June": 6, "July": 7, "August": 8,
    "September": 9, "October": 10, "November": 11, "December": 12,
}


# ── Config ────────────────────────────────────────────────────────────────────

def load_config():
    if not CONFIG_FILE.exists():
        sys.exit(f"Config not found: {CONFIG_FILE}")
    with open(CONFIG_FILE) as f:
        return json.load(f)


def get_existing_game_ids():
    """Return set of Game_IDs that already have .md files in games/."""
    if not GAMES_DIR.exists():
        return set()
    return {p.stem for p in GAMES_DIR.glob("*.md")}


# ── Auth ──────────────────────────────────────────────────────────────────────

def login(page):
    """Log in to GameChanger (email → code + password → submit)."""
    username = os.environ.get("GC_USERNAME")
    password = os.environ.get("GC_PASSWORD")
    if not username or not password:
        sys.exit("Set GC_USERNAME and GC_PASSWORD environment variables")

    print("Navigating to GC login...")
    page.goto("https://web.gc.com/login", wait_until="networkidle")
    time.sleep(2)

    print("Entering email...")
    page.fill('input[name="email"]', username)
    page.click('[data-testid="sign-in-button"]')

    page.wait_for_selector('input[type="password"]', timeout=15000)
    time.sleep(2)

    code_file = RAW_DIR / "code.txt"
    code_file.parent.mkdir(parents=True, exist_ok=True)
    if code_file.exists():
        code_file.unlink()

    print(f"\nGC sent a verification code to {username}")
    print(f"Write the code to: {code_file}")
    print("Waiting up to 120 seconds...")
    sys.stdout.flush()

    code = None
    for _ in range(120):
        if code_file.exists():
            code = code_file.read_text().strip()
            if code:
                break
        time.sleep(1)

    if not code:
        page.screenshot(path=str(RAW_DIR / "login_timeout.png"))
        sys.exit("Timeout waiting for verification code")

    print(f"Got code: {code}")

    page.fill('input[name="code"]', code)
    page.fill('input[name="password"]', password)
    time.sleep(0.5)
    page.click('[data-testid="sign-in-button"]')

    # Wait for post-submit navigation, then verify by probing /home for the
    # unauth markers. This is more reliable than the previous URL-string check
    # (which can miss successes if "/login" lingers in a redirect query
    # parameter or if the URL settles after our polling window).
    time.sleep(5)
    page.goto("https://web.gc.com/home", wait_until="networkidle")
    time.sleep(3)
    found_unauth = page.evaluate(PAYWALL_PROBE_JS)
    if found_unauth:
        page.screenshot(path=str(RAW_DIR / "login_fail.png"))
        sys.exit(f"Login failed — unauth markers on /home: {found_unauth}")

    print(f"Logged in successfully. URL: {page.url}")
    time.sleep(2)


def save_session(context):
    context.storage_state(path=str(SESSION_FILE))


UNAUTH_MARKERS = [
    '[data-testid="paywall"]',
    '[class*="Paywall__unauthenticated"]',
    '[data-testid="mobile-sign-in-button"]',
    '[data-testid="mobile-join-us-button"]',
]
# Note: NOT including '[data-testid="sign-in-button"]' or
# '[data-testid="join-us-button"]' (without the mobile- prefix).
# Those elements exist on /home even when authenticated (likely in a
# hidden account-menu drawer) and produced a false-positive
# unauthenticated detection on the GH Actions runner. The four markers
# above are the ones confirmed unauth-only via the scrape-debug HTML
# inspection on 2026-04-26.

PAYWALL_PROBE_JS = (
    "() => { const sels = "
    + json.dumps(UNAUTH_MARKERS)
    + "; return sels.filter(s => document.querySelector(s)); }"
)


def is_logged_in(page):
    """Check session validity.

    GC's plays page serves a Paywall__unauthenticated teaser to logged-out
    users WITHOUT redirecting to /login — so URL-based checks (the previous
    implementation) silently passed against an expired session and the
    scraper proceeded to extract paywall HTML for every game.

    This now (1) checks for /login redirect and (2) probes the DOM for any
    of the unauth-only markers GC renders (sign-in/join-us buttons, paywall
    container). Either signal returns False.
    """
    page.goto("https://web.gc.com/home", wait_until="networkidle")
    time.sleep(2)
    if "/login" in page.url:
        return False
    found = page.evaluate(PAYWALL_PROBE_JS)
    if found:
        print(f"  [AUTH] Unauthenticated DOM markers on /home: {found}")
        return False
    return True


def ensure_authenticated(page, context, dry_run):
    """Ensure the session is valid; re-authenticate if needed."""
    if is_logged_in(page):
        print("Session valid.")
        return True

    if dry_run:
        print("WARNING: Session expired but --dry-run prevents login.")
        print("Content will be extracted from the public (unauthenticated) view.")
        return False

    print("Session expired — re-authenticating...")
    login(page)
    save_session(context)
    return True


# ── Schedule parsing ──────────────────────────────────────────────────────────

def parse_schedule(page, team_id, team_code):
    """Navigate to a team's schedule page and return list of completed games.

    Returns list of dicts: {date, uuid, opponent_name, is_home, score}
    """
    url = f"https://web.gc.com/teams/{team_id}/schedule"
    print(f"  Navigating to schedule: {url}")
    page.goto(url, wait_until="networkidle")
    time.sleep(POLITE_DELAY)

    # Get all game links with UUIDs
    links = page.evaluate("""() => {
        const links = document.querySelectorAll('a[href*="/schedule/"]');
        return Array.from(links).map(a => ({
            uuid: (a.href.split('/schedule/')[1] || '').split('/')[0],
            text: a.innerText.replace(/\\n/g, '|').trim()
        })).filter(l => l.uuid.length > 10);
    }""")

    # Parse the schedule text for dates
    text = page.inner_text("body")
    lines = text.split("\n")

    # Build ordered list of games with dates from the text
    current_month = None
    current_year = None
    text_games = []  # list of {date, opponent_line, result}

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Month header: "March 2026"
        m = re.match(r"^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$", line)
        if m:
            current_month = MONTHS[m.group(1)]
            current_year = int(m.group(2))
            i += 1
            continue

        # Day-of-week starts a game block
        if line in ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"):
            day_str = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if day_str.isdigit() and current_month and current_year:
                day = int(day_str)
                date_str = f"{current_year}-{current_month:02d}-{day:02d}"
                # Collect game lines following this date until next DOW or month
                j = i + 2
                while j < len(lines):
                    game_line = lines[j].strip()
                    if not game_line:
                        j += 1
                        continue
                    # Check if this is a game entry (starts with vs. or @)
                    if game_line.startswith("vs.") or game_line.startswith("@"):
                        # Scan forward past optional location lines to find the result
                        # Results look like "W 5-2", "L 3-4", "T 4-4", or a time "4:15 PM"
                        result = ""
                        k = j + 1
                        while k < len(lines):
                            candidate = lines[k].strip()
                            if not candidate:
                                k += 1
                                continue
                            if re.match(r"^[WLT] \d+-\d+$", candidate) or re.match(r"^\d{1,2}:\d{2}\s*(AM|PM)$", candidate):
                                result = candidate
                                k += 1
                                break
                            if candidate.startswith("at ") or candidate.startswith("No location"):
                                # Location line — skip it
                                k += 1
                                continue
                            # Unknown line — treat as end of this game entry
                            break
                        text_games.append({
                            "date": date_str,
                            "opponent_line": game_line,
                            "result": result,
                        })
                        j = k
                    else:
                        break
            i += 1
            continue
        i += 1

    # Filter to completed games only (result matches "W N-N" or "L N-N")
    completed = [g for g in text_games if re.match(r"^[WLT] \d+-\d+$", g["result"])]

    # Correlate text_games with links (both are in schedule order)
    # Links correspond 1:1 with text_games in order
    games = []
    link_idx = 0
    for tg in text_games:
        if link_idx >= len(links):
            break
        uuid = links[link_idx]["uuid"]
        link_idx += 1

        # Skip if not completed
        if not re.match(r"^[WLT] \d+-\d+$", tg["result"]):
            continue

        is_home = tg["opponent_line"].startswith("vs.")
        opp_name = re.sub(r"^(vs\.\s*|@\s*)", "", tg["opponent_line"]).strip()

        games.append({
            "date": tg["date"],
            "uuid": uuid,
            "opponent_name": opp_name,
            "is_home": is_home,
            "score": tg["result"],
            "team_code": team_code,
        })

    print(f"  Found {len(text_games)} total games, {len(completed)} completed, {len(games)} with UUIDs")
    return games


# ── Extraction ────────────────────────────────────────────────────────────────

def extract_plays(page, team_id, game_uuid):
    """Navigate to a game's plays page and extract all visible text."""
    url = f"https://web.gc.com/teams/{team_id}/schedule/{game_uuid}/plays"
    page.goto(url, wait_until="networkidle")
    time.sleep(3)

    # Auth guard. GC serves a Paywall__unauthenticated teaser (~16 blurred
    # plays + sign-in CTA) to logged-out users with no URL change. Without
    # this guard, an expired session causes every game to scrape as garbage
    # and silently fail downstream gates. Hard-exit on detection so the
    # workflow stops cleanly instead of writing dozens of partial .md files.
    paywall_markers = page.evaluate(PAYWALL_PROBE_JS)
    if paywall_markers:
        sys.exit(
            "\n[FATAL] GC paywall detected on plays page — session expired.\n"
            f"  URL: {url}\n"
            f"  Markers: {paywall_markers}\n"
            "  Re-seed the session:\n"
            "    1. Run `python pipeline/scrape.py` locally and complete the\n"
            "       email-code login when prompted.\n"
            "    2. Temporarily commit the resulting pipeline/gc_session.json.\n"
            "    3. Run the 'Seed GC Session' workflow on GitHub.\n"
            "    4. Remove the temporary commit.\n"
            "  Then re-run the daily pipeline.\n"
        )

    # Scroll to load all content
    prev_height = 0
    for _ in range(20):
        curr_height = page.evaluate("document.body.scrollHeight")
        if curr_height == prev_height:
            break
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(0.5)
        prev_height = curr_height

    page.evaluate("window.scrollTo(0, 0)")
    time.sleep(0.5)

    return page.inner_text("body")


def game_already_scraped(game, existing_ids):
    """Check if this game likely already exists in games/ by date and team code.

    Since we don't know the exact Game_ID until transcription, we check if
    any existing .md file matches the date and team code.
    """
    date = game["date"]
    code = game["team_code"]
    for gid in existing_ids:
        if date in gid and code in gid:
            return True, gid
    return False, None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Scrape GC play-by-play for all focal teams")
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip login; load existing session from gc_session.json")
    args = parser.parse_args()

    config = load_config()
    existing_ids = get_existing_game_ids()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    GAMES_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Existing game files: {len(existing_ids)}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)

        ctx_opts = {
            "viewport": {"width": 1280, "height": 900},
            "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/120.0.0.0 Safari/537.36",
        }

        if args.dry_run:
            if not SESSION_FILE.exists():
                sys.exit(f"--dry-run requires {SESSION_FILE} to exist.")
            ctx_opts["storage_state"] = str(SESSION_FILE)
            print(f"[dry-run] Loading session from {SESSION_FILE}")
        elif SESSION_FILE.exists():
            ctx_opts["storage_state"] = str(SESSION_FILE)
            print("Loading saved session...")

        context = browser.new_context(**ctx_opts)
        page = context.new_page()

        # Verify session
        ensure_authenticated(page, context, args.dry_run)
        time.sleep(POLITE_DELAY)

        # Counters
        total_found = 0
        total_skipped = 0
        total_scraped = 0
        total_errors = 0

        # Iterate over all focal teams
        for team in config["focal_teams"]:
            team_id = team["gc_team_id"]
            team_code = team["code"]
            team_name = team["name"]

            print(f"\n{'='*60}")
            print(f"Team: {team_name} ({team_code}) — GC ID: {team_id}")
            print(f"{'='*60}")

            try:
                games = parse_schedule(page, team_id, team_code)
            except Exception as e:
                print(f"  ERROR parsing schedule: {e}")
                total_errors += 1
                time.sleep(POLITE_DELAY)
                continue

            total_found += len(games)

            for game in games:
                already_done, existing_id = game_already_scraped(game, existing_ids)
                if already_done:
                    print(f"  SKIP: {game['date']} {game['opponent_name'][:30]} — already in games/ as {existing_id}")
                    total_skipped += 1
                    continue

                # Extract play-by-play
                print(f"  SCRAPING: {game['date']} {'vs' if game['is_home'] else '@'} {game['opponent_name'][:30]} ({game['score']})")
                time.sleep(POLITE_DELAY)

                try:
                    text = extract_plays(page, team_id, game["uuid"])
                except Exception as e:
                    print(f"    ERROR extracting plays: {e}")
                    total_errors += 1
                    continue

                if len(text.strip()) < 200:
                    print(f"    WARNING: text too short ({len(text)} chars) — skipping")
                    total_errors += 1
                    continue

                # Save raw text
                safe_opp = re.sub(r"[^a-zA-Z0-9]", "_", game["opponent_name"][:20])
                filename = f"{team_code}_{game['date']}_{safe_opp}_{game['uuid'][:8]}.txt"
                out_file = RAW_DIR / filename
                out_file.write_text(text)

                lines = text.strip().splitlines()
                print(f"    Saved {len(text):,} chars ({len(lines)} lines) → {out_file.name}")
                total_scraped += 1

            time.sleep(POLITE_DELAY)

        # Re-save session after all navigation
        if not args.dry_run:
            save_session(context)

        browser.close()

    # Summary
    print(f"\n{'='*60}")
    print(f"SCRAPE COMPLETE")
    print(f"{'='*60}")
    print(f"  Teams checked:    {len(config['focal_teams'])}")
    print(f"  Completed games:  {total_found}")
    print(f"  Already ingested: {total_skipped}")
    print(f"  New raw files:    {total_scraped}")
    if total_errors:
        print(f"  Errors:           {total_errors}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
