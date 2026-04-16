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
├── PROJECT_NOTES.md                   ← chat-context knowledge base (not for Claude Code)
├── .gitignore                         ← node_modules, dist, .env, .DS_Store, .claude/
├── index.html                         ← Vite entry point (loads src/main.jsx)
├── package.json                       ← Vite + React + XLSX deps (build scaffold only)
├── vite.config.js                     ← Vite config (React plugin, publicDir)
├── src/
│   └── main.jsx                       ← React mount: imports App from ../app/hawks.jsx
├── .github/
│   └── workflows/
│       └── daily.yml                  ← cron job: runs pipeline, commits, pushes
├── api/
│   ├── chat.js                        ← Vercel serverless proxy for Ask tab (Anthropic API)
│   └── ktg.js                         ← legacy Keys-to-the-Game proxy (unused by v5 app)
├── pipeline/
│   ├── config.json                    ← GC team IDs, focal team codes, state
│   ├── scrape.py                      ← Playwright: GC login → raw play-by-play text
│   ├── transcribe.py                  ← Claude API + transcribe prompt → Game_ID.md
│   ├── ingest.py                      ← Claude API + ingest prompt → updated Excel
│   └── export.py                      ← Excel 4 data sheets → public/repository.json
├── prompts/
│   ├── transcribe.md                  ← GC transcription prompt (v4.1, source of truth)
│   └── ingest.md                      ← Excel ingestion prompt (v6, source of truth)
├── games/                             ← all Game_ID.md files, git-tracked permanently
├── data/
│   └── RiverHill_Repository_Master.xlsx   ← master data file, updated in-place by ingest.py
├── public/
│   └── repository.json                ← auto-exported, fetched by app on mount
└── app/
    └── hawks.jsx                      ← scouting dashboard (single-file React, source of truth)
```

### Vercel build chain
Vercel detects `package.json` and runs `npm install` + `vite build` on every deploy. The build chain:
`index.html` → `src/main.jsx` → `import App from "../app/hawks.jsx"` → Vite compiles → `dist/`

- **`app/hawks.jsx`** is the single source of truth for the app. All edits go here.
- **`src/main.jsx`** is plumbing only — it imports and mounts the App component. Do not add logic here.
- **`package.json`**, **`vite.config.js`**, **`index.html`** are build scaffold. Do not delete them.
- **`node_modules/`** and **`dist/`** are in `.gitignore` — Vercel creates them on deploy.
- **`api/`** contains Vercel serverless functions that proxy Anthropic API calls server-side.

---

## Pipeline Flow

### Daily GitHub Actions Run

1. **scrape.py** — loads GC session, checks each focal team's schedule page, identifies games not already in `games/` (by Game_ID filename match), downloads raw play-by-play text for each new game to `pipeline/raw/`
2. **transcribe.py** — for each new raw text file, calls Claude API with `prompts/transcribe.md` as system prompt, writes output to `games/YYYY-MM-DD_AWAY_at_HOME.md`
3. **ingest.py** — detects newly created (untracked) `.md` files using `git ls-files --others --exclude-standard -- games/*.md`, calls Claude API with `prompts/ingest.md` for each, writes updated Excel if all gates pass, calls `export.py` after successful write
4. **Commit + push** — stages `games/`, `data/`, `public/repository.json`; commits only if new files exist; push → Vercel auto-deploys → live app updated within minutes
5. **Any failure** → caught by `|| continue`; logged in Actions output; pipeline continues to next game

### Pipeline Resilience — Failure Modes

Individual game failures do not stop the pipeline. The workflow uses `|| continue` on both transcribe and ingest loops.

| Failure | Exit | Behavior |
|---|---|---|
| Transcription parser can't extract Game_ID | 0 | Saved as `UNKNOWN_{raw_filename}.md`, committed, never ingested (skipped — doesn't match Game_ID pattern) |
| Ingest gate failure (G1–G6) | 1 | Caught by `\|\| continue`, nothing written to Excel, logged in Actions output |
| Ingest focal team detection failure | 1 | Caught by `\|\| continue`, logged, continues |
| Ingest duplicate guard fires | 0 | Logged, continues |
| API error (rate limit, credits) | 1 | Caught by `\|\| continue`, logged, continues |

**Gate failures pending retry:** No dedicated tracking file exists. To find un-ingested games, compare `games/*.md` filenames against `Game_ID` values in the Excel `Game_Log` sheet — any `.md` with no matching `Game_ID` in the log was not successfully ingested. Retry by running `python pipeline/ingest.py games/{game_file}.md` directly. Claude's stat extraction is non-deterministic; retries sometimes pass when the initial run failed.

---

## Game File Naming Convention

**Canonical format: `YYYY-MM-DD_AWAY_at_HOME.md`**

This matches the `Game_ID` field in the Excel `Game_Log` sheet exactly. Examples:
```
2026-03-10_RVRH_at_WSTF.md
2026-03-14_WTTN_at_RVRH.md
2026-04-09_RVRH_at_GARG.md
```

The scraper checks `games/` for existing files before doing any API work. If `YYYY-MM-DD_AWAY_at_HOME.md` already exists, skip that game entirely.

There is no sequential counter. Game_ID is the unique key everywhere: filename, Excel `Game_ID` column, and the ingest prompt's duplicate guard.

---

## Excel Schema — LOCKED, DO NOT MODIFY

The master file is `data/RiverHill_Repository_Master.xlsx`.

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

## Team Identity — Name-Based Registry

### How team codes are resolved

Team codes in the repository (RVRH, NHRF, etc.) are canonical — they never change. But GameChanger and Claude's transcription generate non-canonical codes (NRTH, MDDL, KNTS, etc.) that must be mapped to canonical codes before writing to Excel.

**`config.json` is the single source of truth for team identity.** It contains:
- `focal_teams` — 13 tracked teams with `name_patterns` (lowercase substrings matched against full team names from markdown headers)
- `known_opponents` — 83 non-focal teams with their own `name_patterns`

**Resolution flow** (in `ingest.py`):
1. Parse the markdown `Teams:` line for full team names (e.g., "North Harford Varsity Hawks")
2. Match each name against `name_patterns` in config.json (longest pattern first)
3. Build a per-game `code_map` (e.g., `NRTH → NHRF` for this specific game)
4. Apply `code_map` to all team-code fields in the data rows before writing to Excel

This replaced the old `CODE_ALIASES` dict (retired April 15, 2026) which was a global static map that couldn't handle ambiguous codes like `NRTH` (used for North Harford, North Point, Northern, North County, and Northwest).

### Focal Teams (in config.json)

| Human Name | GC Team ID | App Team_Code |
|---|---|---|
| River Hill | `L3KUEclXyQ8R` | `RVRH` |
| Centennial | `0leb6orf3scs` | `CNTN` |
| Glenelg | `sTcS0b1BQ27u` | `GLNL` |
| Huntingtown | `gB96NCUVyaZq` | `HNTN` |
| Parkside | `zspMoWf0CixS` | `PRKS` |
| Southern | `Y2KOgzm4DqF3` | `STHR` |
| Fallston | `g6B8BXCbZuMF` | `FLLS` |
| Middletown | `AadMAYNPwJg8` | `MDLT` |
| Hereford | `f4s8oFycsPlF` | `HRFD` |
| North Harford | `lwW88NNGvnAE` | `NHRF` |
| Century | `67lmIIVaxWMx` | `CNTY` |
| Kent Island | `HosNhxk1NroJ` | `KTIS` |
| Long Reach | `6Q2VVSbv2fQQ` | `LNRC` |

**Note:** `RVRH` is the primary focal team and the default `Focal_Team` value for River Hill home and away games.

### Adding a new team to the registry

When a new opponent appears that the pipeline hasn't seen before, `ingest.py` will print:
```
[REGISTRY] WARNING: Could not resolve 'New Team Name' (code: NWTM). Add to config.json known_opponents before retry.
```

To fix: add an entry to `known_opponents` in `config.json`:
```json
{ "code": "NWTM", "name_patterns": ["new team"] }
```

Then retry the ingestion. The game will ingest with the correct code.

---

## Architecture Notes

### Python owns all Excel I/O — Claude never touches the Excel file
The API document block only supports PDF, not Excel. The correct architecture: Python reads Excel, passes existing Game_IDs as text to Claude for duplicate detection, Claude returns structured JSON with rows to append, Python validates and writes. Claude never sees the Excel file.

### JSON as the deployment artifact, not Excel
`export.py` converts Excel to `public/repository.json` which the app fetches on mount. Non-technical users never interact with files.

### New game detection in workflow
The ingest step uses `git ls-files --others --exclude-standard -- games/*.md` to find only newly created (untracked) game files from the current run. Only those files are passed to `ingest.py`. This prevents re-ingesting previously committed games.

---

## JSON Export Format

`export.py` reads the 4 data sheets from Excel and writes `public/repository.json`:

```json
{
  "exported": "ISO-8601 timestamp",
  "gameLog": [ ...rows from Game_Log sheet... ],
  "batting": [ ...rows from Batting sheet... ],
  "pitching": [ ...rows from Pitching sheet... ],
  "fielding": [ ...rows from Fielding sheet... ]
}
```

All numeric fields must be exported as numbers, not strings. Date fields export as `YYYY-MM-DD` strings.

---

## App Architecture

**File:** `app/hawks.jsx` (~1,800 lines, single source of truth)
**Framework:** React (single file, no build step — deployed as-is to Vercel)
**Data source:** `fetch("/repository.json")` on mount
**Design principle:** "The app observes. The coach concludes." No interpretive text outside the Ask tab.

### Key Constants
- `FOCAL_TEAMS` — hardcoded array of 13 team codes used by League visualizations and Teams card grid
- `TEAM_NAMES` — map of team codes to display names (e.g., `RVRH → "River Hill"`)
- `DESKTOP_BP = 1280` — breakpoint for two-column desktop layout

### Key App Functions (do not break these)
- `parseData(json)` — receives JSON object, returns `{ gameLog, batting, pitching, fielding }`
- `classifyTeams(data)` — identifies focal teams (≥4 games as Focal_Team) vs. opponents
- `classifyTeamsForTab(data)` — splits all teams into focal / scouted (4+ games) / limited (<4 games) for Teams tab
- `aggBatting(rows)` — aggregates raw batting rows into per-player season totals
- `aggPitching(rows)` — aggregates raw pitching rows into per-player season totals
- `teamSummary(data, teamId)` — full team stats object
- `teamRecord(data, teamId)` — W/L/RS/RA/streak/last5 derived from game log appearances
- `hitterThreat(b)` — scoring: OBP×40% + SLG×30% + (RBI/H)×15% + Contact×15%; minimum 8 PA
- `pitcherImpact(p)` — scoring: K/9×30% + Control×25% + ERA×25% + WHIP×20%; minimum 9 outs
- `pitcherRole(p)` — Starter (≥9 avg outs) / Reliever (≥4.5) / Setup-Closer
- `playoffThreat(data, teamId)` — composite threat score; returns 4 internal tiers mapped to 3 UI tiers (THREAT ≥55, MID 25-54, WEAK <25)
- `defensiveTargets(data, teamId)` — error counts per fielder
- `opponentRotation(data, teamId)` — starting pitcher patterns
- `buildChatSystem(data)` — builds full data context string for Ask tab Claude calls
- `heatCell(value, min, max, lowerIsBetter)` — heat map cell color (gray→amber→red scale)
- `threatTierUI(score)` — maps threat score to 3-tier display colors
- `useWindowWidth()` — hook for responsive desktop/mobile layout switching
- `useSort(data, defaultCol, defaultDir)` — reusable table sorting hook

### Tabs (3-tab architecture, v5)
- **League** — scatter plot (SVG), standings table, heat map. Desktop: two-column (scatter left, tables right). All elements navigate to Teams State 2.
- **Teams** — 3-state progressive disclosure:
  - State 1: focal team card grid (threat-sorted) + scouted opponents table + limited data accordion. Desktop: master-detail (cards left, content right).
  - State 2: team briefing with sticky header, 3 drawers (Pitching/Lineup/Team Discipline). Pitcher outing strips. Player names tappable → State 3.
  - State 3: player intelligence — summary strip, Season/Last10/Last5 filters, sortable game log. Always full-page.
- **Ask** — Claude-powered chat using `/api/chat` proxy. Only tab that makes API calls. Empty state with 5 suggestion prompts.

### Removed in v5 (April 2026)
- Matchup tab and `matchupExploits()`, `buildKTGSystem()` functions
- Players tab (absorbed into Teams State 3)
- File upload UI (data auto-loads from JSON)
- Vite build scaffold (`src/`, `package.json`, `node_modules/`)

---

## GC Scraper Details

**Site:** `https://web.gc.com`
**Auth:** username/password login, credentials stored as GitHub Actions secrets `GC_USERNAME` and `GC_PASSWORD`
**Tool:** Playwright (Python)

### URL Pattern
```
https://web.gc.com/teams/{TEAM_ID}/{TEAM_SLUG}/schedule/{GAME_UUID}/plays
```

### Session Persistence — Critical

Playwright persists browser session state to `pipeline/gc_session.json` after every successful login. Subsequent runs load from this file — the login endpoint is only touched when the session is expired or missing.

`gc_session.json` is in `.gitignore` and stored as a GitHub Actions cache artifact between runs.

### Dry-Run Flag

`scrape.py --dry-run` skips login entirely and uses the saved session. All development and debugging uses `--dry-run`. The live login flow is only triggered when the session has expired.

### Scraper Logic
1. Check for `gc_session.json` — load if present; if missing or expired, authenticate and save fresh session
2. For each focal team in `config.json`: navigate to schedule page
3. For each completed game: derive candidate Game_ID (`YYYY-MM-DD_AWAY_at_HOME`)
4. If `games/YYYY-MM-DD_AWAY_at_HOME.md` already exists: skip entirely
5. If not: navigate to `/plays` page, extract play-by-play text, save to `pipeline/raw/`
6. Hand raw text files to `transcribe.py`

Play-by-play is rendered as selectable text on a single page (no pagination). 15-second delays between page navigations.

---

## Claude API Usage

Both `transcribe.py` and `ingest.py` call the Anthropic API with a **15-second delay** between calls to avoid rate limiting.

- **Model:** `claude-sonnet-4-20250514` for both transcription and ingestion
- **API key:** stored as GitHub Actions secret `ANTHROPIC_API_KEY`; locally in `.env` via python-dotenv
- **Transcription call:** system prompt = full contents of `prompts/transcribe.md`; user message = raw GC play-by-play text prefixed with `"File naming prefix: RVRH_Game. This is a single game."`
- **Ingestion call:** system prompt = full contents of `prompts/ingest.md`; user message = markdown game log text + focal team declaration + list of existing Game_IDs. Claude returns structured JSON. Python handles all Excel I/O.

**Rate limits:** `claude-sonnet-4-20250514` has an 8,000 output tokens/minute limit at current tier. The 15-second delay between calls keeps the pipeline within limits for typical daily runs. Limits increase automatically with account spend history over time.

---

## GitHub Actions Workflow (daily.yml)

### Key Settings
- **Cron:** 6am ET daily + `workflow_dispatch` for manual runs
- **Permissions:** `contents: write` (required for `git push` from Actions)
- **Timeout:** 90 minutes
- **Secrets:** `GC_USERNAME`, `GC_PASSWORD`, `ANTHROPIC_API_KEY`

### Workflow Steps
1. Checkout repo
2. Restore `gc_session.json` from Actions cache
3. Run `scrape.py`
4. Run `transcribe.py` loop with `|| continue`
5. Detect new untracked game files: `git ls-files --others --exclude-standard -- games/*.md`
6. Run `ingest.py` on each new file with `|| continue`
7. Save updated `gc_session.json` to Actions cache
8. `git add -A games/ data/ public/repository.json`
9. Commit and push only if new files exist
10. On any hard failure: exit nonzero → GitHub Actions sends failure email to repo owner

Vercel auto-deploys on push to main — no additional step needed.

---

## Prompt Version History

| File | Version | Change |
|---|---|---|
| `prompts/transcribe.md` | v4.0 | Original — full GC transcription engine |
| `prompts/transcribe.md` | v4.1 | Added batter ID rule: active batter is player named in play description, not adjacent "next batter" header. Fixes GC format misattribution (J Norwood HR attributed to H Zhang). |
| `prompts/transcribe.md` | v4.2 | Added verbatim team name preservation rule: full names must be copied exactly from GameChanger, not abbreviated. Required for name-based team registry. |
| `prompts/ingest.md` | v6.0 | Current — full ingestion engine with 6-gate verification |

---

## Key Constraints and Gotchas

- **Never re-ingest a game.** The duplicate guard in the ingest prompt is the safety net, but `git ls-files` new-file detection is the first line of defense.
- **Never modify existing Excel rows.** Ingest only appends to the bottom of each sheet.
- **Never modify the Derivation_Rules sheet.**
- **Gate failures are hard stops for that game.** Do not write partial data. The `|| continue` in the workflow moves to the next game — it does not override the gate failure.
- **The prompts are the source of truth.** `prompts/transcribe.md` and `prompts/ingest.md` are versioned files. Do not inline their logic into Python scripts — always read and pass them as prompts.
- **Batter misattribution is the primary transcription failure mode.** GC logs show a "next batter" header immediately before the final play of the preceding batter. The v4.1 prompt handles this — the active batter is always the player named in the play description. If misattribution is suspected, check the raw file in `pipeline/raw/` against the markdown play log.
- **Team-level gates do not catch misattributions.** G1-G4 verify team hit and run totals — a stat misattributed to the wrong player can pass all gates if team totals still balance. Per-player PA reconciliation in `ingest.py` is the additional safeguard.
- **Team code resolution is name-based.** `ingest.py` resolves raw team codes (NRTH, MDDL, etc.) to canonical codes (NHRF, MDLT, etc.) by matching full team names from the markdown header against `name_patterns` in `config.json`. This replaced the old `CODE_ALIASES` dict on April 15, 2026. The old system couldn't handle ambiguous codes like NRTH (5 different teams). The new system resolves per-game based on the actual team name.
- **Unknown teams produce loud warnings.** If `ingest.py` encounters a team name not in the registry, it prints `[REGISTRY] WARNING` and preserves the raw code. Add the team to `config.json` `known_opponents` and retry.
- **The Excel filename is `RiverHill_Repository_Master.xlsx`** — not `RiverHill_Repository.xlsx`.
- **Focal team list is hardcoded** in the app as `FOCAL_TEAMS` (13 teams). The League scatter plot, standings table, and heat map all filter to this list. The `classifyTeams()` function still derives focal teams dynamically for the Ask tab's data context, but the UI components use the hardcoded array.
- **Team display names** use the `TEAM_NAMES` map and `teamName()` helper. Add new teams there when expanding the focal list.

---

## Current State (April 2026)

### Pipeline
- ✅ **All 6 build steps complete** — full pipeline live
- ✅ **Backfill complete** — all 13 focal teams backfilled; 5,171+ rows in repository
- ⚠️ **A few gate failures pending retry** — `.md` files exist in `games/` but no matching rows in Excel `Game_Log`. To find: compare `games/*.md` filenames against Game_Log Game_IDs. To retry: `python pipeline/ingest.py games/{game_file}.md`
- ✅ **Batter misattribution bug fixed** — transcribe.md v4.1 in place
- ✅ **Verbatim team name preservation** — transcribe.md v4.2; full GC names preserved for registry matching
- ⚠️ **Backfill games transcribed with v4.0 should be spot-checked** — any game where a walk-off or late-inning play had a "next batter" header adjacent to the final play is a misattribution risk
- ✅ **Rate limit handling** — 15s delays between API calls; `|| continue` resilience in workflow
- ✅ **Session persistence** — `gc_session.json` cached in Actions; login only on expiry
- ✅ **Name-based team registry** — replaced CODE_ALIASES on April 15; resolves ambiguous codes (NRTH, etc.) per-game via full team name matching against config.json patterns

### App (v5 redesign — completed April 13, 2026)
- ✅ **3-tab architecture** — League / Teams / Ask (replaced 5-tab v4: League/Matchup/Teams/Players/Chat)
- ✅ **League tab** — SVG scatter plot with interactive hover legend, sortable standings table (RVRH pinned), sortable heat map (gray→amber→red color scale)
- ✅ **Teams tab** — 3-tier card grid (focal / scouted opponents / limited data), 3-state drill-down (cards → briefing → player intelligence), pitcher outing strips, drawer-based briefing
- ✅ **Ask tab** — renamed from Chat, restyled, 5 suggestion prompts, same Claude API logic
- ✅ **Desktop layout** — two-column at ≥1280px for both League and Teams tabs
- ✅ **Full team names** — TEAM_NAMES map applied to standings, heat map, cards, briefing headers
- ✅ **Design system** — updated colors (#001E50 navy, #D4900A gold), 10px radius, Courier New for stats, 44px touch targets
- ✅ **Repo cleanup** — node_modules/ and dist/ removed from repo (built by Vercel on deploy); Vite scaffold (package.json, vite.config.js, src/main.jsx, index.html) retained as build plumbing

---

## How to Start a Session

**Claude Code session:**
> *"Read CLAUDE.md. [Describe what you want to build or fix.]"*

**Planning or troubleshooting chat:**
> Upload `PROJECT_NOTES.md` and say: *"Read PROJECT_NOTES.md. [Describe the issue or feature.]"*
