#!/usr/bin/env python3
"""scrape_debug.py — diagnose play-log truncation.

Loads gc_session.json, scrapes ONE recent completed game's schedule entry,
opens the plays page, and captures multiple snapshots so we can tell
whether the truncation is happening:

  (a) at the inner_text() call (DOM virtualization stripping off-screen plays)
  (b) at the full-HTML level (page never loads more than ~16 plays at all)
  (c) somewhere downstream (transcribe/Claude truncation — would show full
      raw text here but partial markdown later)

Output goes to debug-output/ — designed to be uploaded as a workflow artifact.

Usage:
    python pipeline/scrape_debug.py [TEAM_CODE]

Requires pipeline/gc_session.json to exist (restored from Actions cache).
"""

import json
import sys
import time
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("playwright not installed")

REPO_ROOT    = Path(__file__).resolve().parent.parent
PIPELINE_DIR = REPO_ROOT / "pipeline"
SESSION_FILE = PIPELINE_DIR / "gc_session.json"
CONFIG_FILE  = PIPELINE_DIR / "config.json"
OUT_DIR      = REPO_ROOT / "debug-output"

# Reuse parse_schedule from scrape.py
sys.path.insert(0, str(PIPELINE_DIR))
from scrape import parse_schedule  # noqa: E402


def main():
    team_code = sys.argv[1] if len(sys.argv) > 1 else "FLLS"

    if not SESSION_FILE.exists():
        sys.exit(f"Session file not found: {SESSION_FILE}. "
                 f"Run the daily workflow first to seed the cache.")

    with open(CONFIG_FILE) as f:
        cfg = json.load(f)
    team = next((t for t in cfg["focal_teams"] if t["code"] == team_code), None)
    if not team:
        sys.exit(f"Team code '{team_code}' not in focal_teams")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Output directory: {OUT_DIR}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        version = browser.version
        print(f"Chromium version: {version}")
        (OUT_DIR / "chromium_version.txt").write_text(f"{version}\n")

        ctx = browser.new_context(
            storage_state=str(SESSION_FILE),
            viewport={"width": 1280, "height": 900},
            user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"),
        )
        page = ctx.new_page()

        # ── Find the most recent completed game on this team's schedule ────
        games = parse_schedule(page, team["gc_team_id"], team_code)
        if not games:
            sys.exit("parse_schedule returned no completed games")
        games.sort(key=lambda g: g["date"], reverse=True)
        target = games[0]
        print(f"Target game: {target['date']} {target['opponent_name']} "
              f"({target['uuid']})")
        (OUT_DIR / "target_game.json").write_text(json.dumps(target, indent=2))

        url = (f"https://web.gc.com/teams/{team['gc_team_id']}"
               f"/schedule/{target['uuid']}/plays")
        page.goto(url, wait_until="networkidle")
        time.sleep(3)

        # ── Snapshot A: initial state (no scroll) ──────────────────────────
        initial_text = page.inner_text("body")
        (OUT_DIR / "01_initial_inner_text.txt").write_text(initial_text)
        (OUT_DIR / "02_initial_full_html.html").write_text(page.content())
        page.screenshot(path=str(OUT_DIR / "03_initial_screenshot.png"),
                        full_page=False)
        initial_stats = page.evaluate("""() => ({
            scrollHeight: document.body.scrollHeight,
            innerHTMLLen: document.body.innerHTML.length,
            innerTextLen: document.body.innerText.length,
            allDivs:      document.querySelectorAll('div').length,
            allLis:       document.querySelectorAll('li').length,
            playClassEls: document.querySelectorAll('[class*="play" i]').length,
            playTestids:  document.querySelectorAll('[data-testid*="play"]').length,
        })""")

        # ── Snapshot B: scroll-to-bottom loop (mirrors scrape.py) ──────────
        prev_height = 0
        height_log = []
        for i in range(20):
            curr_height = page.evaluate("document.body.scrollHeight")
            height_log.append({
                "iter": i,
                "scroll_height": curr_height,
                "scroll_top": page.evaluate("window.scrollY"),
                "inner_text_len": page.evaluate("document.body.innerText.length"),
                "all_divs": page.evaluate("document.querySelectorAll('div').length"),
            })
            if curr_height == prev_height:
                break
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(0.5)
            prev_height = curr_height
        (OUT_DIR / "04_scroll_log.json").write_text(json.dumps(height_log, indent=2))

        # Reset to top and re-read (matches scrape.py extract_plays)
        page.evaluate("window.scrollTo(0, 0)")
        time.sleep(0.5)

        post_text = page.inner_text("body")
        (OUT_DIR / "05_post_scroll_inner_text.txt").write_text(post_text)
        (OUT_DIR / "06_post_scroll_full_html.html").write_text(page.content())
        page.screenshot(path=str(OUT_DIR / "07_post_scroll_screenshot.png"),
                        full_page=True)

        # ── Snapshot C: try alternative reads that BYPASS virtualization ────
        # Read each known play container by its data-testid if present
        alternatives = page.evaluate("""() => {
            const out = {};
            const playSelectors = [
                'div[data-testid*="play" i]',
                'li[data-testid*="play" i]',
                '[class*="PlayRow" i]',
                '[class*="play-row" i]',
                '[class*="play_row" i]',
                'div[class*="Play" i] > div',
                'main',
                'article',
            ];
            playSelectors.forEach(sel => {
                const els = document.querySelectorAll(sel);
                out[sel] = {
                    count: els.length,
                    first_text_sample: els[0] ? els[0].innerText.slice(0, 200) : null,
                };
            });
            return out;
        }""")
        (OUT_DIR / "08_selector_probe.json").write_text(json.dumps(alternatives, indent=2))

        # ── Snapshot D: scroll-and-collect (anti-virtualization workaround) ─
        # Scroll incrementally and accumulate inner_text at each step
        page.evaluate("window.scrollTo(0, 0)")
        time.sleep(0.5)
        snapshots = []
        seen_lines = set()
        accumulated_lines = []
        scroll_step = 400  # px
        max_iterations = 60
        last_y = -1
        for i in range(max_iterations):
            text = page.evaluate("document.body.innerText")
            for line in text.split("\n"):
                if line and line not in seen_lines:
                    seen_lines.add(line)
                    accumulated_lines.append(line)
            y = page.evaluate("window.scrollY")
            h = page.evaluate("document.body.scrollHeight")
            snapshots.append({
                "iter": i,
                "scroll_y": y,
                "scroll_height": h,
                "innerText_len": len(text),
                "accumulated_unique_lines": len(accumulated_lines),
            })
            if y == last_y and i > 0:
                break
            last_y = y
            page.evaluate(f"window.scrollBy(0, {scroll_step})")
            time.sleep(0.3)
            if y + scroll_step >= h:
                # Reached bottom; one more snapshot then exit
                if i > 1:
                    text = page.evaluate("document.body.innerText")
                    for line in text.split("\n"):
                        if line and line not in seen_lines:
                            seen_lines.add(line)
                            accumulated_lines.append(line)
                    break

        (OUT_DIR / "09_incremental_scroll_log.json").write_text(
            json.dumps(snapshots, indent=2))
        (OUT_DIR / "10_accumulated_inner_text.txt").write_text(
            "\n".join(accumulated_lines))

        # ── Summary ────────────────────────────────────────────────────────
        summary = {
            "chromium_version": version,
            "playwright_version": pw.chromium.executable_path,
            "target_game": target,
            "url": url,
            "initial": {
                "inner_text_len": len(initial_text),
                **initial_stats,
            },
            "post_scroll": {
                "inner_text_len": len(post_text),
            },
            "scroll_iterations": len(height_log),
            "final_scroll_height": height_log[-1]["scroll_height"] if height_log else None,
            "incremental_accumulated_chars": sum(len(l) for l in accumulated_lines),
            "incremental_accumulated_unique_lines": len(accumulated_lines),
        }
        (OUT_DIR / "00_summary.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary, indent=2))

        ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
