# RiverHill Hawks Scouting — Claude Code Project Memory

Read this file at the start of every session before touching any code or files.

---

## What This Project Is

A fully automated baseball scouting pipeline for the RiverHill Hawks program. It scrapes game play-by-play data from GameChanger, transcribes it into structured markdown, ingests it into a master Excel repository, exports that repository to JSON, and deploys a live scouting dashboard to Vercel — with zero human intervention on clean runs.

Non-technical users (coaches, scouts) access the live app at Vercel. They never touch files or uploads. The app auto-fetches fresh data on load.

The pipeline was previously a manual HITL workflow: copy-paste from GC → Claude chat (transcription) → Claude chat (ingestion) → manual GitHub push. Every part of that is now automated.

---

## Repository Structure

```
/
├── CLAUDE.md                          ← this file
├── .github/
│   └── workflows/
│       └── daily.yml                  ← cron job: runs pipeline, commits, pushes
├── pipeline/
│   ├── config.json                    ← GC team IDs, focal team codes, state
│   ├── scrape.py                      ← Playwright: GC login → raw play-by-play text
│   ├── transcribe.py                  ← Claude API + transcribe prompt → Game_ID.md
│   ├── ingest.py                      ← Claude API + ingest prompt → updated Excel
│   ├── export.py                      ← Excel 4 data sheets → public/repository.json
│   └── notify.py                      ← formats failure output for GitHub Actions email
├── prompts/
│   ├── transcribe.md                  ← GC transcription prompt (source of truth)
│   └── ingest.md                      ← Excel ingestion prompt (source of truth)
├── games/                             ← all Game_ID.md files, git-tracked permanently
├── data/
│   └── RiverHill_Repository.xlsx      ← master data file, updated in-place by ingest.py
├── public/
│   └── repository.json                ← auto-exported, fetched by app on mount
└── app/
    └── hawks.jsx                      ← scouting dashboard (React, deployed to Vercel)
```

---

## Pipeline Flow

### Daily GitHub Actions Run

1. **scrape.py** — logs into GC, checks each focal team's schedule page, identifies games not already in `games/` (by Game_ID filename match), downloads raw play-by-play text for each new game
2. **transcribe.py** — for each new raw text file, calls Claude API with `prompts/transcribe.md` as system prompt, writes output to `games/YYYY-MM-DD_AWAY_at_HOME.md`
3. **ingest.py** — for each new `.md` file, calls Claude API with `prompts/ingest.md`, passes the markdown and the current Excel, writes updated Excel back to `data/RiverHill_Repository.xlsx`
4. **export.py** — reads 4 data sheets from Excel, writes `public/repository.json`
5. **Commit + push** → Vercel auto-deploys → live app shows new data within minutes
6. **Any failure** → pipeline stops, GitHub Actions sends failure email with gate/step details

### Failure Behavior

- Gate failures in ingest: stop immediately, do not write to Excel, surface the failing gate, gate value, expected value, and the play causing the discrepancy
- Duplicate Game_ID detected: stop, report which row already exists, do not reprocess
- Scrape failure (auth, timeout, layout change): stop, report the step and URL
- All failures surface as GitHub Actions job failures → email notification to repo owner

---

## Game File Naming Convention

**Canonical format: `YYYY-MM-DD_AWAY_at_HOME.md`**

This matches the `Game_ID` field in the Excel `Game_Log` sheet exactly. Examples:
```
2026-03-10_RVRH_at_WSTF.md
2026-03-14_WTTN_at_RVRH.md
2026-04-09_RVRH_at_GARG.md
```

The scraper checks `games/` for existing files before doing any API work. If `YYYY-MM-DD_AWAY_at_HOME.md` already exists, skip that game entirely — do not re-transcribe or re-ingest.

There is no sequential counter. Game_ID is the unique key everywhere: filename, Excel `Game_ID` column, and the ingest prompt's duplicate guard.

---

## Excel Schema — LOCKED, DO NOT MODIFY

The repository has exactly 4 data sheets plus a Roster sheet. Column order is fixed. Never add, remove, rename, or reorder columns. Never add new sheets.

### Game_Log
`Game_ID` | `Game_Date` | `Game_Type` | `Focal_Team` | `Away_Team` | `Home_Team` | `Innings_Played` | `Source_File` | `Away_R` | `Away_H` | `Away_E` | `Home_R` | `Home_H` | `Home_E` | `QA_Flag_Count` | `Notes`

### Batting
`Game_ID` | `Game_Date` | `Opponent` | `Team` | `Player` | `PA` | `AB` | `H` | `1B` | `2B` | `3B` | `HR` | `BB` | `HBP` | `K` | `K_L` | `K_S` | `R` | `RBI` | `SB` | `CS` | `GDP` | `SAC` | `FC` | `Notes`

### Pitching
`Game_ID` | `Game_Date` | `Opponent` | `Team` | `Pitcher` | `Outs_Recorded` | `BF` | `H_Allowed` | `1B_Allowed` | `2B_Allowed` | `3B_Allowed` | `HR_Allowed` | `BB_Allowed` | `HBP_Allowed` | `K` | `R_Allowed` | `WP` | `Notes`

### Fielding
`Game_ID` | `Game_Date` | `Opponent` | `Team` | `Player` | `Inning` | `Play_Ref` | `Notes`

### Roster
`Team_Code` | `Player` | `First_Seen` | `Notes` | `Order`

The `Derivation_Rules` sheet exists in the file and must never be modified. All other sheets beyond the 5 listed above are vestigial analysis scaffolding and can be ignored — they are not read by the pipeline or the app.

---

## JSON Export Format

`export.py` reads the 4 data sheets from Excel and writes `public/repository.json` with this structure:

```json
{
  "exported": "ISO-8601 timestamp",
  "gameLog": [ ...rows from Game_Log sheet... ],
  "batting": [ ...rows from Batting sheet... ],
  "pitching": [ ...rows from Pitching sheet... ],
  "fielding": [ ...rows from Fielding sheet... ]
}
```

All numeric fields must be exported as numbers, not strings. Date fields export as `YYYY-MM-DD` strings. The app's `parseData()` function reads exactly these four keys.

---

## App Architecture

**File:** `app/hawks.jsx`
**Framework:** React (single file, no build step — deployed as-is to Vercel)
**Data source:** `fetch("/repository.json")` on mount — NOT a file upload

### Current Data Flow (target state)
```
component mounts
  → fetch("/repository.json")
  → parseData(json)              ← replaces parseWorkbook(wb)
  → classifyTeams(data)
  → render
```

### Key App Functions (do not break these)
- `parseData(json)` — replaces `parseWorkbook`. Receives the JSON object, returns `{ gameLog, batting, pitching, fielding }`. All downstream functions are unchanged.
- `classifyTeams(data)` — identifies focal teams (≥4 games as Focal_Team) vs. opponents
- `aggBatting(rows)` — aggregates raw batting rows into per-player season totals
- `aggPitching(rows)` — aggregates raw pitching rows into per-player season totals
- `teamSummary(data, teamId)` — full team stats object used by TeamProfile tab
- `hitterThreat(b)` — scoring: OBP×40% + SLG×30% + (RBI/H)×15% + Contact×15%; minimum 8 PA
- `pitcherImpact(p)` — scoring: K/9×30% + Control×25% + ERA×25% + WHIP×20%; minimum 9 outs
- `playoffThreat(data, teamId)` — composite threat score for opponent teams
- `defensiveTargets(data, teamId)` — error counts per fielder
- `matchupExploits(sA, sB, ...)` — auto-generated strategy bullets

### Tabs
- **League** — all teams, clickable → TeamProfile drill-down
- **Matchup** — head-to-head comparison, focal team vs. any opponent
- **Chat** — Claude-powered chat tab using Anthropic API (already in the app)

### The Load Button
The `"↑ load new file"` button and file `<input>` in the topbar are legacy. Remove them when converting to auto-fetch. The `XLSX` import can be removed entirely once the app reads JSON.

---

## GC Scraper Details

**Site:** `https://web.gc.com`
**Auth:** username/password login, credentials stored as GitHub Actions secrets `GC_USERNAME` and `GC_PASSWORD`
**Tool:** Playwright (Python)

### URL Pattern
Play-by-play for a specific game:
```
https://web.gc.com/teams/{TEAM_ID}/{TEAM_SLUG}/schedule/{GAME_UUID}/plays
```

Example:
```
https://web.gc.com/teams/sTcS0b1BQ27u/2026-spring-glenelg-varsity-gladiators/schedule/9f346f0a-124e-4542-82e7-457eef45322a/plays
```

### Focal Team GC IDs

These go in `pipeline/config.json`. Teams without an App_Code yet need codes confirmed by owner before they can be written to the repository — flag and skip them during ingestion until codes are assigned.

| Human Name | GC Team ID | App Team_Code | Status |
|---|---|---|---|
| River Hill | `L3KUEclXyQ8R` | `RVRH` | ✅ primary focal team |
| Centennial | `0leb6orf3scs` | `CNTN` | ✅ |
| Glenelg | `sTcS0b1BQ27u` | `GLNL` | ✅ |
| Huntingtown | `gB96NCUVyaZq` | `HNTN` | ✅ |
| Parkside | `zspMoWf0CixS` | `PRKS` | ✅ |
| Southern | `Y2KOgzm4DqF3` | `STHR` | ✅ |
| Fallston | `g6B8BXCbZuMF` | `FLLS` | ✅ |
| Middletown | `AadMAYNPwJg8` | `MDLT` | ✅ |
| Hereford | `f4s8oFycsPlF` | `HRFD` | ✅ |
| North Harford | `lwW88NNGvnAE` | `NHRF` | ✅ |
| Century | `67lmIIVaxWMx` | `CNTY` | ✅ |
| Kent Island | `HosNhxk1NroJ` | `KTIS` | ✅ |
| Long Reach | `6Q2VVSbv2fQQ` | `LNRC` | ✅ |

**Note:** `RVRH` is the primary focal team and the default `Focal_Team` value for River Hill home and away games.

### Session Persistence — Critical

Playwright must persist browser session state to `pipeline/gc_session.json` after every successful login. On subsequent runs it loads from this file instead of logging in again. Login only occurs if `gc_session.json` is missing or the session is found to be expired (detected by redirect to login page after navigation attempt).

This means the GC login endpoint is touched at most once per session expiry — not on every run. **This is the fix for rate-limiting during development and production.** During testing, Claude Code must never run the login flow repeatedly. Authenticate once, save the session, use `--dry-run` for all subsequent test runs.

`gc_session.json` must be in `.gitignore` — it contains authenticated session tokens and must never be committed to the repo. In GitHub Actions it is stored as a cached workflow artifact between runs and regenerated only when expired.

### Dry-Run Flag — Required for Development

`scrape.py` must accept a `--dry-run` flag. When set:
- Skip login entirely
- Load session from `gc_session.json` (must exist)
- Navigate and extract as normal
- Write raw text output as normal

This allows all navigation and extraction logic to be tested without touching the login endpoint. All development and debugging of scraper logic uses `--dry-run`. The login flow is only tested once when credentials are first confirmed.

### Scraper Logic
1. Check for `gc_session.json` — if present, load it; if not (or if session is expired), log in with `GC_USERNAME` / `GC_PASSWORD` and save fresh session
2. For each focal team in `config.json`: navigate to schedule page
3. For each game on the schedule: derive the candidate Game_ID (`YYYY-MM-DD_AWAY_at_HOME`)
4. If `games/YYYY-MM-DD_AWAY_at_HOME.md` already exists: skip entirely
5. If not: navigate to `/plays` page, extract all play-by-play text, save as raw text file in `pipeline/raw/`
6. Hand raw text files to `transcribe.py`

The play-by-play is rendered as selectable text on a single page (no pagination). Implement polite delays (2–3 seconds) between page navigations regardless of rate-limit status.

---

## Claude API Usage

Both `transcribe.py` and `ingest.py` call `https://api.anthropic.com/v1/messages`.

- **Model:** `claude-sonnet-4-20250514` for both transcription and ingestion (confirmed working in production)
- **API key:** stored as GitHub Actions secret `ANTHROPIC_API_KEY`
- **Transcription call:** system prompt = full contents of `prompts/transcribe.md`; user message = raw GC play-by-play text; declare naming prefix `RVRH_Game` and that it is a single game (not a numbered sequence — filename is derived from Game_ID in the output)
- **Ingestion call:** system prompt = full contents of `prompts/ingest.md`; user message includes the markdown game log text, the focal team declaration, and the list of existing Game_IDs (for duplicate detection). Claude returns structured JSON with rows to append and gate results. Python handles all Excel I/O — the Excel file is never sent to the API.

---

## GitHub Actions Secrets Required

| Secret | Value |
|---|---|
| `GC_USERNAME` | GameChanger login email |
| `GC_PASSWORD` | GameChanger login password |
| `ANTHROPIC_API_KEY` | Anthropic API key |

Vercel auto-deploys on push to `main` — no additional secret needed.

---

## Build Order

Complete each step and verify before starting the next.

**Step 1 — App: switch from file-upload to auto-fetch**
- Add `parseData(json)` function that accepts the JSON structure and returns `{ gameLog, batting, pitching, fielding }`
- Replace `parseWorkbook` call with `fetch("/repository.json")` in a `useEffect` on mount
- Remove the file `<input>`, `fileRef`, `loadFile`, and the `"↑ load new file"` button
- Remove the `XLSX` import
- Test against a manually exported `repository.json` before proceeding

**Step 2 — export.py**
- Reads `data/RiverHill_Repository.xlsx`
- Exports 4 data sheets to `public/repository.json` per the JSON format above
- Numeric fields as numbers, dates as `YYYY-MM-DD` strings
- Run once manually, confirm app loads correctly from it

**Step 3 — scrape.py (stub first)**
- Playwright login + navigate to one hardcoded game URL
- Extract raw play-by-play text
- Confirm extracted text matches what a manual Ctrl-A/Ctrl-C would produce
- Then generalize to full schedule scraping once stub is validated

**Step 4 — transcribe.py**
- Reads raw text file from scraper output
- Calls Claude API with `prompts/transcribe.md`
- Writes `games/YYYY-MM-DD_AWAY_at_HOME.md`
- Test on a game already ingested (so ingest duplicate guard catches it safely)

**Step 5 — ingest.py**
- Reads `games/YYYY-MM-DD_AWAY_at_HOME.md` and current Excel
- Calls Claude API with `prompts/ingest.md`
- Writes updated Excel back in place
- Calls export.py after successful gate pass

**Step 6 — daily.yml** ✅ complete
- Cron schedule: 6am ET daily + manual `workflow_dispatch`
- GC session restored from / saved to Actions cache — no login on each run
- Scrape → transcribe → ingest → export → commit chain confirmed working
- Duplicate guard fires cleanly — no commit, exit 0 when no new games
- All 3 secrets wired: `GC_USERNAME`, `GC_PASSWORD`, `ANTHROPIC_API_KEY`

---

## Prompt Version History

| File | Version | Change |
|---|---|---|
| `prompts/transcribe.md` | v4.0 | Original — full GC transcription engine |
| `prompts/transcribe.md` | v4.1 | Added batter ID rule: active batter is player named in play description, not adjacent "next batter" header. Fixes GC format misattribution (J Norwood HR attributed to H Zhang). |
| `prompts/ingest.md` | v6.0 | Current — full ingestion engine with 6-gate verification |

---

## Key Constraints and Gotchas

- **Never re-ingest a game.** The duplicate guard in the ingest prompt is the safety net, but the scraper should never even attempt it. Game_ID filename check is the first line of defense.
- **Never modify existing Excel rows.** Ingest only appends to the bottom of each sheet.
- **Never modify the Derivation_Rules sheet.**
- **Gate failures are hard stops.** Do not write partial data. Do not proceed to the next step.
- **The prompts are the source of truth.** `prompts/transcribe.md` and `prompts/ingest.md` are versioned files. Do not inline their logic into Python scripts — always read and pass them as prompts.
- **Batter misattribution is the primary transcription failure mode.** GC logs show a "next batter up" header immediately before the final play of the preceding batter. The transcription prompt (v4.1) explicitly handles this — the active batter is always the player named in the play description, never the adjacent header. If a misattribution is suspected, check the raw file in `pipeline/raw/` against the markdown play log before re-ingesting.
- **Team-level gates do not catch misattributions.** G1-G4 verify team hit and run totals — a HR misattributed to the wrong player can pass all gates if the totals still balance. Per-player PA reconciliation is the safeguard (see ingest.py).
- **Courtesy runner credits.** The ingestion prompt handles this correctly. Do not second-guess it.
- **K_L + K_S must always equal K** for every pitcher row. The ingestion prompt enforces this.
- **The `focal` team classification** in the app uses ≥4 appearances as `Focal_Team` in Game_Log. RVRH is the primary focal team. Do not hardcode team names — read from data.

---

## Current State

- ✅ **Step 1 complete** — app converted from file-upload to `fetch("/repository.json")` on mount; load button and XLSX import removed
- ✅ **Step 2 complete** — `export.py` written and tested; app loads correctly from JSON
- ✅ **Step 3 complete** — `scrape.py` fully working with session persistence (`gc_session.json`) and `--dry-run` flag; GC rate-limit resolved
- ✅ **Step 4 complete** — `transcribe.py` tested; produces full structured markdown from raw GC text (19,417 chars confirmed on Glenelg-Guilford game); Game_ID parsed from markdown output to construct filename
- ✅ **Step 5 complete** — `ingest.py` tested; duplicate guard fires correctly for existing games; full ingest of new game passes all 6 gates and writes correctly (28 batting + 7 pitching + 6 fielding rows confirmed); calls `export.py` automatically on success
- ✅ **Step 6 complete** — `daily.yml` live; cron 6am ET + manual `workflow_dispatch`; GC session cached in Actions; scrape → transcribe → ingest → export → commit chain confirmed; duplicate guard fires cleanly with exit 0; all 3 secrets wired
- All 13 GC team IDs and App Team_Codes confirmed (see table above)
- Prompts: transcribe at **v4.1**, ingest at **v6** — mature, do not modify without careful testing
- Model confirmed: `claude-sonnet-4-20250514` for both transcription and ingestion

## Architecture Note — Ingestion Redesign

The original design sent the Excel file to the Claude API directly. This does not work — the API document block only supports PDF, not Excel, and the file exceeds inline text limits.

**Actual architecture (confirmed working):**
- Python reads Excel, extracts existing Game_IDs, passes them as text to the API for duplicate detection
- Claude reads the markdown game log and returns **structured JSON** containing the exact rows to append to each sheet plus gate results
- Python validates the JSON against the locked schema, runs all 6 gate checks independently, and only then appends rows to Excel via openpyxl
- Gate failures and schema violations are hard stops — Python exits nonzero, nothing is written
- Python calls `export.py` automatically after a clean write

This means Claude never touches the Excel file. All file I/O is Python's responsibility.
