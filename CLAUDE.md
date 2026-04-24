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
├── package.json                       ← Vite + React + XLSX + @vercel/analytics deps
├── vite.config.js                     ← Vite config (React plugin, publicDir)
├── src/
│   └── main.jsx                       ← React mount: imports App from ../app/hawks.jsx + mounts <Analytics />
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
│   ├── export.py                      ← Excel 4 data sheets → public/repository.json
│   ├── validate_core.py               ← PC1-PC5 validation logic (shared library)
│   ├── validate.py                    ← CLI: retrospective audit of ingested games
│   ├── triage.py                      ← CLI: classify validator failures into buckets A-H
│   └── reingest_batch.py              ← CLI: batch retry/repair for buckets A & B
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
- **`src/main.jsx`** is plumbing only — it imports and mounts the App component and mounts `<Analytics />` from `@vercel/analytics/react` at the root. Do not add logic here; do not duplicate the `<Analytics />` mount inside `app/hawks.jsx`.
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
- `focal_teams` — 15 tracked teams with `name_patterns` (lowercase substrings matched against full team names from markdown headers)
- `known_opponents` — 81 non-focal teams with their own `name_patterns`

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
| Wilde Lake | `HZBbh1Lf6XtW` | `WLDL` |
| Hammond | `vF8BfQGb71MV` | `HMMN` |

**Note:** `RVRH` is the primary focal team and the default `Focal_Team` value for River Hill home and away games. WLDL and HMMN were promoted from `known_opponents` to `focal_teams` on April 21, 2026.

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

## Validator & Triage Tools

Standalone dev/ops utilities for auditing and repairing already-ingested games. **Not currently wired into `daily.yml`** — they are manual tooling for post-ingest cleanup.

### The PC1-PC5 Checks (in `validate_core.py`)

All five checks live in `pipeline/validate_core.py` as pure functions and are called both by `ingest.py` at write-time and by the standalone `validate.py` auditor.

| Check | What it verifies |
|---|---|
| **PC1** | Pitching outs per team ≥ innings × 3 × 0.85 (catches missing pitcher rows) |
| **PC2** | Sum of H_Allowed matches opposing team's reported hits (±1 tolerance; ±3 if Section 5 flags a known discrepancy) |
| **PC3** | Every pitcher named in the play log appears in Pitching rows (normalized name comparison; skips jersey-only teams) |
| **PC4** | Every batter in the play log appears in Batting rows (normalized comparison; proper-name filter; skips jersey-only teams) |
| **PC5** | Sum of PA in Batting rows ≥ 75% of play-log batter appearances or innings × 2.5 (flags dropped rows) |

Team code resolution inside the validator goes through the same `config.json` `name_patterns` registry that `ingest.py` uses.

### `validate.py` — retrospective audit CLI

```
python pipeline/validate.py [game.md]
python pipeline/validate.py --game-id YYYY-MM-DD_AWAY_at_HOME
python pipeline/validate.py --all
python pipeline/validate.py --since YYYY-MM-DD --until YYYY-MM-DD
python pipeline/validate.py ... --verbose --json
```

Read-only. Loads markdown from `games/`, compares against Excel rows, runs PC1-PC5. Emits human-readable or JSON report. Exit codes: `0` all pass, `1` failures found, `2` parser error. Skips `UNKNOWN_*`-prefixed files.

### `triage.py` — failure classification CLI

```
python pipeline/triage.py
python pipeline/triage.py --bucket A,B
python pipeline/triage.py --game-id YYYY-MM-DD_AWAY_at_HOME
python pipeline/triage.py --json
```

Consumes `validate.py` output and assigns each failing game to one of 8 action buckets. Reads markdown Section 5 (Data Integrity Flags) to cross-check whether discrepancies are already documented.

| Bucket | Scope | Description |
|---|---|---|
| **A** | Focal | Missing specific pitcher (PC3 focal failure, or PC1 zero-outs) |
| **B** | Focal | Missing specific batter (PC4 focal failure) |
| **C** | Focal | Hit mismatch (PC2) — Section 5 **fully** documents the discrepancy |
| **D** | Focal | Hit mismatch (PC2) — Section 5 **partially** documents |
| **E** | Focal | Hit mismatch (PC2) — **not** documented in Section 5 |
| **F** | Non-focal | Missing pitcher/batter on opponent team |
| **G** | Any | Multiple issue types or unclassified |
| **H** | Any | PC5 only (known parser limitation — lower priority) |

Processing priority is fixed A → B → C → D → E → F → G → H.

### `reingest_batch.py` — batch retry CLI

```
python pipeline/reingest_batch.py --dry-run
python pipeline/reingest_batch.py --game-id YYYY-MM-DD_AWAY_at_HOME
python pipeline/reingest_batch.py --limit N
python pipeline/reingest_batch.py --force-bucket G,D
python pipeline/reingest_batch.py --retries N
```

**By default operates only on Buckets A & B.** Other buckets require `--force-bucket`. Per-game flow:
1. Snapshot the game's existing rows from each sheet
2. Delete those rows from Excel
3. Invoke `ingest.py` on the `.md`
4. Re-audit via `validate.py`
5. If still failing, retry up to N times; on final failure, restore snapshot

**Safety:** Creates a timestamped Excel backup in `data/backups/` before any writes. Logs every attempt to `pipeline/reingest_batch.log`. Snapshot/restore is per-game and atomic — a failed retry never leaves the sheet in a partial state.

### Why the validator is not in `daily.yml`

`ingest.py` already runs PC1-PC5 at write-time (same `validate_core.py` code path), so daily runs are pre-validated. The standalone tools exist for retrospective auditing against historical backfill games and for recovering from edge cases that the write-time gate caught too loosely (e.g., misattribution across players that balances at team level). Running `validate.py --all` after the backfill found the bucket workload that `reingest_batch.py` is now grinding through.

---

## App Architecture

**File:** `app/hawks.jsx` (~1,800 lines, single source of truth)
**Framework:** React (single file — build handled by Vercel on deploy via `npm install` + `vite build`; no local build step required)
**Data source:** `fetch("/repository.json")` on mount
**Design principle:** "The app observes. The coach concludes." No interpretive text outside the Ask tab.

### Key Constants
- `FOCAL_TEAMS` — hardcoded array of 15 team codes used by League visualizations and Teams card grid
- `TEAM_NAMES` — map of team codes to display names (e.g., `RVRH → "River Hill"`)
- `DESKTOP_BP = 1280` — breakpoint for two-column desktop layout

### Key App Functions (do not break these)
- `parseData(json)` — receives JSON object, returns `{ gameLog, batting, pitching, fielding }`
- `classifyTeams(data)` — dynamically derives focal/opponent split from Game_Log (≥4 appearances as `Focal_Team`). **Used only by `buildChatSystem` for Ask tab context.** Not used by any UI component.
- `classifyTeamsForTab(data)` — splits all teams into focal (hardcoded `FOCAL_TEAMS` array) / scouted (4+ game appearances) / limited (<4 games). Drives all Teams tab UI: focal card grid, Scouted Opponents table, and limited data accordion. Called internally by `TeamsCardGrid`; the `teams` prop passed from `App` is not used for UI rendering.
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
- `buildChatSystem(data)` — builds full data context string for Ask tab Claude calls; uses `classifyTeams(data)` to enumerate teams
- `heatCell(value, min, max, lowerIsBetter)` — heat map cell color (gray→amber→red scale)
- `threatTierUI(score)` — maps threat score to 3-tier display colors
- `useWindowWidth()` — hook for responsive desktop/mobile layout switching
- `useSort(data, defaultCol, defaultDir)` — reusable table sorting hook

### Tabs (4-tab architecture, v5)
- **League** — scatter plot (SVG), standings table, heat map. Desktop: two-column (scatter left, tables right). All elements navigate to Teams State 2.
- **Teams** — 3-state progressive disclosure:
  - State 1: focal team card grid (threat-sorted) + scouted opponents table + limited data accordion. Desktop: master-detail (cards left, content right).
  - State 2: team briefing with sticky header, 3 drawers (Pitching/Lineup/Team Discipline). Pitcher outing strips. Player names tappable → State 3.
  - State 3: player intelligence — summary strip, Season/Last10/Last5 filters, sortable game log. Always full-page. Two-way players get a Pitching/Batting toggle; default view depends on navigation source (Pitching drawer → pitching, Lineup drawer → batting). `defaultView` prop threaded through `navigateToPlayer(teamId, name, "pitching"|"batting")`.
- **Ask** — Claude-powered chat using `/api/chat` proxy. Only tab that makes API calls. Empty state with 5 suggestion prompts.
- **Report** — web-based batch query builder for game logs (added April 2026). Renders `ReportTab` component. Includes "Copy for Sheets" button for clipboard export of results.

Tab labels are hardcoded in the `["League", "Teams", "Ask", "Report"]` array at the bottom of `App()`. The tab label is **"Report"** (singular), not "Reports".

### Removed in v5 (April 2026)
- Matchup tab and `matchupExploits()`, `buildKTGSystem()` functions
- Players tab (absorbed into Teams State 3)
- File upload UI (data auto-loads from JSON)
- `node_modules/` and `dist/` from the repo — Vite build scaffold (`src/`, `package.json`, `vite.config.js`, `index.html`) is retained; Vercel runs `npm install` + `vite build` on each deploy

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
- **Focal team list is hardcoded** in the app as `FOCAL_TEAMS` (15 teams as of April 21, 2026). The League scatter plot, standings table, and heat map all filter to this list. The `classifyTeams()` function derives focal teams dynamically for the Ask tab's data context only; all UI components use the hardcoded array instead. The array appears in **5 places** in `app/hawks.jsx`: (1) `TEAM_NAMES` map at file top, (2) `LeagueScatterPlot`, (3) `StandingsTable`, (4) `LeagueHeatMap`, (5) `classifyTeamsForTab`. When adding a team, update all five (use `replace_all` in Edit).
- **`public/games/` must stay synced with `games/`.** The app fetches per-game markdowns from `/games/{id}.md` on the deployed site, which is served from `public/games/`. `export.py` copies games from `games/` to `public/games/` after each successful ingest, and `.github/workflows/daily.yml` stages `public/games/` in its `git add` (added April 24, 2026). Prior to that fix, 46 files accumulated untracked for weeks — games whose `.md` was present in Excel but missing from `public/games/` would 404 in the app.
- **Gate failures can stem from miscounted Section 5, not bad data.** When `ingest.py` gates fail on hit count discrepancy, check whether Section 5's verification hit list matches the Structured Play Log Outcome column. Claude sometimes miscounts Section 5 at transcription time (omitted plays, half-inning mix-ups, wrong team attribution) while the actual Outcome column is correct. Fixing the Section 5 hit list to match play log outcomes, then re-ingesting, is often enough to land the game. If play log Outcomes truly disagree with GC-confirmed totals, a play's Outcome column may need to be edited (e.g., reach-on-error that the official scorer credited as a single).
- **Ingested Game_ID may differ from `.md` filename** when aliases resolve at ingest time. The scraper names `.md` files with the raw GC code (e.g., `2026-04-13_PNTR_at_HRFR.md`), but the registry resolves HRFR→HRFD before writing Excel, so the Game_Log row becomes `2026-04-13_PNTR_at_HRFD`. When comparing `games/*.md` against Game_Log for missing ingestions, normalize through the alias map. Known aliases observed in the wild: HRFR→HRFD, MDDL→MDLT, KNTS→KTIS, LNGR→LNRC, MTHB→MT.H, STMC→ST.M, CMLW→CML.
- **Team display names** use the `TEAM_NAMES` map and `teamName()` helper. Add new teams there when expanding the focal list.
- **Vercel build failures are silent to production.** Production (`main`) only updates when a deploy succeeds. A failing build produces a red ❌ on the PR / commit and an "Error" in the Vercel dashboard, but production keeps serving the last green bundle. On April 18-19, 2026, commit `3e2ed79` shipped an unbalanced `</div>` in `LeagueHeatMap` that broke every subsequent deploy for a week before it was caught. When UI changes don't seem to be showing up, check the Vercel deployment status on the latest commit before assuming caching or client issues. Running `npm run build` locally reproduces the error.
- **`<Analytics />` is mounted once in `src/main.jsx`.** Do not add a second mount in `app/hawks.jsx`. Vercel Web Analytics uses `/_vercel/insights/script.js` and `/_vercel/insights/view` routes — these are independent of `/api/chat.js`.

---

## Current State (late April 2026)

### Pipeline
- ✅ **All 6 build steps complete** — full pipeline live
- ✅ **Backfill complete** — all 15 focal teams backfilled; 237 games / 7,400+ rows in repository as of April 24
- ✅ **WLDL + HMMN promoted to focal teams (April 21)** — added to `config.json` focal_teams and to `FOCAL_TEAMS` + `TEAM_NAMES` in `app/hawks.jsx`; initial backfill completed via combination of daily cron and manual ingest passes
- ✅ **`public/games/` sync gap fixed (April 24)** — workflow `git add` now includes `public/games/` path so per-game markdowns deploy alongside `repository.json`
- ✅ **All originally-gate-failed focal games ingested by April 24** — several stubborn games required Section 5 hit-list corrections or Outcome column edits (reach-on-error → single per GC scorer) to land in Excel
- ⚠️ **Known data-quality items flagged for later cleanup:** (1) `2020-04-07_STHR_at_GLNB` appears as a misdated duplicate of an April 2026 STHR game (both rows are 2026 data with wrong dates); (2) `2026-04-04_CNTY_at_NRTE` was ingested with team order reversed; (3) `STMC` alias for "Saint Michaels" is missing from `config.json` — games are ingesting as `ST.M`; (4) `2026-04-04_PRKS_at_PLYV` was ingested with the wrong opponent — Polytechnic's actual opponent was "Park School Varsity Bruins" (code `PARK`, a Baltimore-area independent school), not Parkside (`PRKS`, the Salisbury-area focal team). Game_ID, Game_Log, and Team column all incorrectly say `PRKS`; only the Opponent column has been normalized to `PARK` via `normalize_opponents.py`. Needs manual re-ingest to correct the Game_ID/Team attribution since the bad rows distort PRKS focal-team stats.
- ✅ **Batter misattribution bug fixed** — transcribe.md v4.1 in place
- ✅ **Verbatim team name preservation** — transcribe.md v4.2; full GC names preserved for registry matching
- ⚠️ **Backfill games transcribed with v4.0 should be spot-checked** — any game where a walk-off or late-inning play had a "next batter" header adjacent to the final play is a misattribution risk
- ✅ **Rate limit handling** — 15s delays between API calls; `|| continue` resilience in workflow
- ✅ **Session persistence** — `gc_session.json` cached in Actions; login only on expiry
- ✅ **Name-based team registry** — replaced CODE_ALIASES on April 15; resolves ambiguous codes (NRTH, etc.) per-game via full team name matching against config.json patterns
- ✅ **Validator system live (PC1-PC5)** — shared `validate_core.py` used by both `ingest.py` (write-time gate) and `validate.py` (retrospective audit). Team code resolution in the validator goes through `config.json` registry (Phase 1, April).
- ✅ **Triage + batch re-ingest tooling** — `triage.py` buckets validator failures A-H; `reingest_batch.py` auto-repairs Buckets A & B with snapshot/restore safety. Excel backups written to `data/backups/`; log at `pipeline/reingest_batch.log`.
- ✅ **Parser: skip incomplete PAs** — games that ended mid-at-bat no longer fail parsing.
- ✅ **Parser: skip phantom pitchers** — validator ignores pitcher entries with zero appearances in play log.
- 🚧 **Triage worklist in progress** — `validate.py --all` produces the current backlog; the owner is working through buckets. Buckets C/D/E (PC2 hit mismatches) and F (non-focal missing players) require manual judgment and are not auto-repaired.

### App (v5 redesign — completed April 13, 2026)
- ✅ **4-tab architecture** — League / Teams / Ask / Report (replaced 5-tab v4: League/Matchup/Teams/Players/Chat). Report tab added later in April as a batch query builder.
- ✅ **League tab** — SVG scatter plot with interactive hover legend, sortable standings table (RVRH pinned), sortable heat map (gray→amber→red color scale). Standings + heat map use sticky-thead single-table layout (fixed April 19 after the sticky refactor broke JSX balance).
- ✅ **Teams tab** — 3-tier card grid (focal / scouted opponents / limited data), 3-state drill-down (cards → briefing → player intelligence), pitcher outing strips, drawer-based briefing. Two-way players show a Pitching/Batting toggle defaulted by the drawer the player was tapped from.
- ✅ **Ask tab** — renamed from Chat, restyled, 5 suggestion prompts, same Claude API logic
- ✅ **Report tab** — web-based batch query builder for game logs with "Copy for Sheets" button
- ✅ **Desktop layout** — two-column at ≥1280px for both League and Teams tabs
- ✅ **Full team names** — TEAM_NAMES map applied to standings, heat map, cards, briefing headers
- ✅ **Design system** — updated colors (#001E50 navy, #D4900A gold), 10px radius, Courier New for stats, 44px touch targets
- ✅ **Repo cleanup** — node_modules/ and dist/ removed from repo (built by Vercel on deploy); Vite scaffold (package.json, vite.config.js, src/main.jsx, index.html) retained as build plumbing
- ✅ **Vercel Web Analytics wired** — `@vercel/analytics/react` mounted in `src/main.jsx`; dashboard enabled on Vercel (April 19, 2026). Beacons at `/_vercel/insights/script.js` and `/_vercel/insights/view`.

---

## How to Start a Session

**Claude Code session:**
> *"Read CLAUDE.md. [Describe what you want to build or fix.]"*

**Planning or troubleshooting chat:**
> Upload `PROJECT_NOTES.md` and say: *"Read PROJECT_NOTES.md. [Describe the issue or feature.]"*
