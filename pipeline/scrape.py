#!/usr/bin/env python3
"""Scrape play-by-play text from GameChanger (stub — single hardcoded game).

Session persistence:
  After a successful login the full browser state (cookies + localStorage) is
  saved to pipeline/gc_session.json.  Subsequent runs load from this file and
  only re-authenticate when the session has expired.  gc_session.json must
  never be committed — it is in .gitignore.

Dry-run mode (--dry-run):
  Skips login entirely.  Loads session from gc_session.json (must already
  exist), navigates to the target page, extracts text, and writes output.
  Use this for all development / debugging of navigation and extraction logic.

Usage:
  # First run — authenticates and saves session:
  export GC_USERNAME="you@example.com"
  export GC_PASSWORD="yourpassword"
  python pipeline/scrape.py

  # Subsequent runs — reuses saved session, no login:
  python pipeline/scrape.py --dry-run
"""

import argparse
import json
import os
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
RAW_DIR = PIPELINE_DIR / "raw"

# ── Hardcoded stub URL (Step 3 validation) ────────────────────────────────────
STUB_URL = "https://web.gc.com/teams/sTcS0b1BQ27u/2026-spring-glenelg-varsity-gladiators/schedule/9f346f0a-124e-4542-82e7-457eef45322a/plays"


# ── Auth ──────────────────────────────────────────────────────────────────────

def login(page):
    """Log in to GameChanger (email → code + password → submit).

    GC uses a two-step flow: enter email, click Continue, then fill a
    verification code (emailed) plus password and click Sign In.

    The verification code is read from pipeline/raw/code.txt — write the code
    to that file within 120 seconds of the prompt appearing.
    """
    username = os.environ.get("GC_USERNAME")
    password = os.environ.get("GC_PASSWORD")
    if not username or not password:
        sys.exit("Set GC_USERNAME and GC_PASSWORD environment variables")

    print("Navigating to GC login...")
    page.goto("https://web.gc.com/login", wait_until="networkidle")
    time.sleep(2)

    # Step 1: enter email and click Continue
    print("Entering email...")
    page.fill('input[name="email"]', username)
    page.click('[data-testid="sign-in-button"]')

    # Step 2: wait for password + code fields
    page.wait_for_selector('input[type="password"]', timeout=15000)
    time.sleep(2)

    # Step 3: get verification code (sent to email)
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

    # Fill code and password, submit
    page.fill('input[name="code"]', code)
    page.fill('input[name="password"]', password)
    time.sleep(0.5)
    page.click('[data-testid="sign-in-button"]')

    # Wait for URL to leave /login.  GC's SPA redirect can take 30-60 seconds.
    logged_in = False
    for _ in range(60):
        time.sleep(1)
        if "/login" not in page.url:
            logged_in = True
            break

    if not logged_in:
        page.screenshot(path=str(RAW_DIR / "login_fail.png"))
        sys.exit(f"Login failed — still at {page.url}. Code may have expired or been rate-limited.")

    print(f"Logged in successfully. URL: {page.url}")
    time.sleep(2)  # polite delay


def save_session(context):
    """Persist full browser state to pipeline/gc_session.json."""
    context.storage_state(path=str(SESSION_FILE))
    print(f"Saved session to {SESSION_FILE}")


def is_logged_in(page):
    """Navigate to /home and check whether GC redirects to /login."""
    page.goto("https://web.gc.com/home", wait_until="networkidle")
    time.sleep(2)
    logged_in = "/login" not in page.url
    print(f"Session check: {'valid' if logged_in else 'expired'} (URL: {page.url})")
    return logged_in


# ── Extraction ────────────────────────────────────────────────────────────────

def extract_plays(page, url):
    """Navigate to a plays page and extract all visible text."""
    print(f"Navigating to plays page:\n  {url}")
    page.goto(url, wait_until="networkidle")
    time.sleep(3)  # let dynamic content render

    # Scroll to bottom to trigger any lazy-loaded content
    prev_height = 0
    for _ in range(20):
        curr_height = page.evaluate("document.body.scrollHeight")
        if curr_height == prev_height:
            break
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(0.5)
        prev_height = curr_height

    # Scroll back to top
    page.evaluate("window.scrollTo(0, 0)")
    time.sleep(0.5)

    # Extract all text from the page body
    text = page.inner_text("body")
    return text


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Scrape GC play-by-play (stub)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip login; load existing session from gc_session.json")
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    out_file = RAW_DIR / "stub_game_raw.txt"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)

        ctx_opts = {
            "viewport": {"width": 1280, "height": 900},
            "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/120.0.0.0 Safari/537.36",
        }

        if args.dry_run:
            # ── Dry-run: require existing session, no login ──
            if not SESSION_FILE.exists():
                sys.exit(f"--dry-run requires {SESSION_FILE} to exist. "
                         f"Run once without --dry-run to authenticate and save a session.")
            ctx_opts["storage_state"] = str(SESSION_FILE)
            print(f"[dry-run] Loading session from {SESSION_FILE}")
            context = browser.new_context(**ctx_opts)
            page = context.new_page()
        else:
            # ── Normal: try saved session, fall back to login ──
            if SESSION_FILE.exists():
                ctx_opts["storage_state"] = str(SESSION_FILE)
                print(f"Loading saved session...")

            context = browser.new_context(**ctx_opts)
            page = context.new_page()

            if SESSION_FILE.exists() and is_logged_in(page):
                print("Session restored from gc_session.json.")
            else:
                print("Session expired or missing — full login required.")
                login(page)
                save_session(context)

        text = extract_plays(page, STUB_URL)

        # Re-save session after successful navigation (refreshes expiry)
        if not args.dry_run:
            save_session(context)

        browser.close()

    if len(text.strip()) < 200:
        print(f"WARNING: extracted text is very short ({len(text)} chars) — "
              f"session may be expired or page load failed.")
        print("First 500 chars:")
        print(text[:500])
        sys.exit(1)

    with open(out_file, "w") as f:
        f.write(text)

    lines = text.strip().splitlines()
    print(f"\nSaved {len(text):,} chars ({len(lines)} lines) to {out_file}")
    print(f"First 3 lines: {lines[:3]}")
    print(f"Last 3 lines:  {lines[-3:]}")


if __name__ == "__main__":
    main()
