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
│   ├── config.json                    ← GC team IDs, focal team codes, display names, name patterns
│   ├── scrape.py                      ← Playwright: GC login → raw play-by-play text
│   ├── transcribe.py                  ← Claude API + transcribe prompt → Game_ID.md
│   ├── ingest.py                      ← Claude API + ingest prompt → updated Excel
│   ├── export.py                      ← Excel 4 data sheets + teams dict → public/repository.json
│   ├── validate_core.py               ← PC1-PC5 validation logic (shared library)
│   ├── validate.py                    ← CLI: retrospective audit of ingested games
│   ├── triage.py                      ← CLI: classify validator failures into buckets A-H
│   ├── reingest_batch.py              ← CLI: batch retry/repair for buckets A & B
│   └── normalize_opponents.py         ← CLI: maintenance tool to canonicalize Opponent field
├── prompts/
│   ├── transcribe.md                  ← GC transcription prompt (v4.2, source of truth)
│   └── ingest.md                      ← Excel ingestion prompt (v6, source of truth)
├── games/                             ← all Game_ID.md files, git-tracked permanently
├── data/
│   ├── RiverHill_Repository_Master.xlsx   ← master data file, updated in-place by ingest.py
│   └── backups/                       ← timestamped Excel backups (created by pipeline tools)
├── public/
│   ├── repository.json                ← auto-exported, fetched by app on mount
│   └── games/                         ← per-game .md files served to app (synced from games/)
└── app/
    └── hawks.jsx                      ← scouting dashboard (single-file React, source of truth)
```

### Vercel build chain
Vercel detects `package.json` and runs `npm install` + `vite build` on every deploy. The build chain:
`index.html` → `src/main.jsx` → `import App from "../app/hawks.jsx"` → Vite compiles → `dist/`

- **`app/hawks.jsx`** is the single source of truth for the app. All edits go here.
- **`src/main.jsx`** is plumbing only — mounts App and `<Analytics />`. Do not add logic here.
- **`package.json`**, **`vite.config.js`**, **`index.html`** are build scaffold. Do not delete them.
- **`node_modules/`** and **`dist/`** are gitignored — Vercel creates them on deploy.
- **`api/`** contains Vercel serverless functions that proxy Anthropic API calls server-side.

---

## Pipeline Flow

### Daily GitHub Actions Run

1. **scrape.py** — loads GC session, checks each focal team's schedule page, identifies games not already in `games/`, downloads raw play-by-play text to `pipeline/raw/`
2. **transcribe.py** — calls Claude API with `prompts/transcribe.md`, writes `games/YYYY-MM-DD_AWAY_at_HOME.md`
3. **ingest.py** — detects newly created (untracked) `.md` files via `git ls-files --others --exclude-standard -- games/*.md`, calls Claude API with `prompts/ingest.md`, writes Excel if all gates pass, calls `export.py`
4. **Commit + push** — stages `games/`, `data/`, `public/repository.json`, `public/games/`; commits only if new files exist; push → Vercel auto-deploys
5. **Any failure** → caught by `|| continue`; logged in Actions; pipeline continues to next game

### Pipeline Resilience — Failure Modes

| Failure | Exit | Behavior |
|---|---|---|
| Transcription parser can't extract Game_ID | 0 | Saved as `UNKNOWN_{raw_filename}.md`, never ingested |
| Ingest gate failure (G1–G6) | 1 | Caught by `\|\| continue`, nothing written, logged |
| Ingest focal team detection failure | 1 | Caught, logged, continues |
| Ingest duplicate guard fires | 0 | Logged, continues |
| API error | 1 | Caught, logged, continues |

---

## Game File Naming Convention

**Canonical format: `YYYY-MM-DD_AWAY_at_HOME.md`**

Matches the `Game_ID` field in Excel `Game_Log` exactly. No sequential counter. Game_ID is the unique key everywhere: filename, Excel `Game_ID` column, ingest prompt duplicate guard.

---

## Excel Schema — LOCKED, DO NOT MODIFY

The master file is `data/RiverHill_Repository_Master.xlsx`. Column order is fixed. Never add, remove, rename, or reorder columns. Never add new sheets.

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

The `Derivation_Rules` sheet must never be modified. All other sheets beyond the 5 listed are vestigial and ignored by the pipeline.

---

## Team Identity — Name-Based Registry

**`config.json` is the single source of truth for team identity.** Each entry:
```json
{
  "code": "ATHL",
  "display_name": "Atholton",
  "name_patterns": ["atholton"]
}
```

- `focal_teams` — 15 tracked teams
- `known_opponents` — 95 non-focal teams
- Total: 110 entries

**Resolution flow** (in `ingest.py`):
1. Parse markdown `Teams:` line for full team names
2. Match against `name_patterns` (longest pattern first)
3. Build per-game `code_map`; apply to all team-code fields before writing Excel

**Safety net patterns:** Some entries have short codes as patterns (`"knts"` under KTIS, `"mt.h"` under MTHB, etc.). These are intentional — do not remove them.

### Focal Teams

| Human Name | GC Team ID | App Code |
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

RVRH is the primary focal team. WLDL and HMMN promoted April 21, 2026.

### Adding a new team

```json
{ "code": "NWTM", "display_name": "New Team", "name_patterns": ["new team"] }
```

Add to `config.json` `known_opponents`, retry ingestion, then run `export.py` so the display name appears in the app.

---

## Architecture Notes

### Python owns all Excel I/O
Claude never sees the Excel file. Python reads it, passes Game_IDs to Claude for duplicate detection, Claude returns JSON, Python writes.

### JSON as deployment artifact
`export.py` converts Excel → `public/repository.json`. Includes a `teams` dict (110 entries, code → display_name) built from `config.json`. App fetches on mount; non-technical users never touch files.

### `public/games/` sync
`export.py` copies `games/*.md` to `public/games/` after each ingest. `daily.yml` stages `public/games/` in `git add`. Fixed April 24, 2026.

---

## JSON Export Format

```json
{
  "exported": "ISO-8601 timestamp",
  "teams":   { "RVRH": "River Hill", "ATHL": "Atholton", ... },
  "gameLog": [ ...Game_Log rows... ],
  "batting": [ ...Batting rows... ],
  "pitching":[ ...Pitching rows... ],
  "fielding":[ ...Fielding rows... ]
}
```

All numeric fields as numbers. Dates as `"YYYY-MM-DD"`.

---

## Opponent Field — Canonical Codes

`Opponent` in Batting and Pitching is display-only — canonical 4-letter codes. Normalized April 24, 2026. New ingests always produce canonical codes.

**`pipeline/normalize_opponents.py`** — maintenance tool (not in `daily.yml`):
- Pass 1: Mirroring fix (rows where `Team == Opponent` corrected via Game_Log)
- Pass 2: Name normalization (full names → codes via config.json)

```bash
python pipeline/normalize_opponents.py           # dry run
python pipeline/normalize_opponents.py --apply   # write + backup
```

After `--apply`, run `export.py`.

---

## Validator & Triage Tools

### PC1-PC5 (in `validate_core.py`)

| Check | Verifies |
|---|---|
| PC1 | Pitching outs ≥ innings × 3 × 0.85 |
| PC2 | H_Allowed sum matches opposing hits (±1; ±3 if Section 5 documented) |
| PC3 | Every pitcher in play log has a Pitching row |
| PC4 | Every batter in play log has a Batting row |
| PC5 | PA sum ≥ 75% of play-log appearances or innings × 2.5 |

### CLI tools

```bash
python pipeline/validate.py --all
python pipeline/validate.py --game-id YYYY-MM-DD_AWAY_at_HOME --verbose
python pipeline/triage.py --bucket A,B
python pipeline/reingest_batch.py --dry-run
python pipeline/reingest_batch.py --limit N --retries 3
```

### Bucket taxonomy

| Bucket | Scope | Signal | Auto-repair? |
|---|---|---|---|
| A | Focal | Missing pitcher (PC3 or PC1 zero-outs) | Yes |
| B | Focal | Missing batter (PC4) | Yes |
| C | Focal | Hit mismatch (PC2), Section 5 fully documents | `--force-bucket` |
| D | Focal | Hit mismatch (PC2), partially documents | `--force-bucket` |
| E | Focal | Hit mismatch (PC2), not documented | `--force-bucket` |
| F | Non-focal | Missing pitcher/batter on opponent | `--force-bucket` |
| G | Any | Multiple issues or unclassified | `--force-bucket` |
| H | Any | PC5 only | Not auto-repaired |

---

## App Architecture

**File:** `app/hawks.jsx` (~1,900 lines, single source of truth)
**Framework:** React (single file — Vercel handles build via `npm install` + `vite build`; no local build step required)
**Data source:** `fetch("/repository.json")` on mount
**Design principle:** "The app observes. The coach concludes."

### Key Constants
- `FOCAL_TEAMS` — hardcoded array of 15 team codes
- `TEAM_NAMES` — hardcoded map of 15 focal codes to display names; primary lookup, always correct even before data loads
- `DESKTOP_BP = 1280`

### Team Name Resolution
```js
const teamName = (id, teams = {}) => TEAM_NAMES[id] || teams[id] || id;
```
- Tier 1: `TEAM_NAMES` hardcoded map (focal teams)
- Tier 2: `data.teams` from `repository.json` (all 110 teams)
- Tier 3: raw code fallback

**Every `teamName()` call site passes `data.teams` as the second argument.** Omitting it means non-focal opponents display as raw codes.

### Key App Functions (do not break these)
- `parseData(json)` — returns `{ gameLog, batting, pitching, fielding, roster, teams }`
- `classifyTeams(data)` — dynamic focal/opponent split from Game_Log. **Ask tab context only.** Not used by UI.
- `classifyTeamsForTab(data)` — focal (hardcoded array) / scouted (4+ games) / limited. Drives all Teams tab UI.
- `aggBatting(rows)` / `aggPitching(rows)` — season aggregates
- `teamSummary(data, teamId)` — full stats object
- `teamRecord(data, teamId)` — W/L/RS/RA/streak/results; each result: `{ W, L, rs, ra, date, opp, home }`
- `fmtDate(d)` — **module-scope** MM/DD formatter; used by `PlayerIntelligence` and `TeamBriefing`
- `hitterThreat(b)` — OBP×40% + SLG×30% + (RBI/H)×15% + Contact×15%; min 8 PA
- `pitcherImpact(p)` — K/9×30% + Control×25% + ERA×25% + WHIP×20%; min 9 outs
- `pitcherRole(p)` — Starter / Reliever / Setup-Closer
- `playoffThreat(data, teamId)` — composite score; 3 UI tiers (THREAT ≥55, MID 25-54, WEAK <25)
- `defensiveTargets(data, teamId)` — errors per fielder
- `buildChatSystem(data)` — Ask tab context; uses `classifyTeams(data)`; prepends `=== TEAM NAMES ===` section
- `heatCell(value, min, max, lowerIsBetter)` — gray→amber→red
- `threatTierUI(score)` — 3-tier colors
- `useWindowWidth()` / `useSort()` — hooks

### Tabs (4-tab architecture, v5)
- **League** — SVG scatter plot, standings (RVRH pinned), heat map. Desktop two-column. All elements → Teams State 2.
- **Teams** — 3-state:
  - State 1: focal card grid + scouted opponents table + limited accordion
  - State 2: sticky header (W-L · ERA · WHIP · last-3 pills with hover/tap tooltips showing opponent+date) + Full Record accordion (all games, collapsed by default) + 3 drawers (Pitching / Lineup / Team Discipline)
  - State 3: player intelligence — summary strip, Season/Last10/Last5, game log. Two-way toggle defaults to navigation source.
- **Ask** — Claude chat via `/api/chat`. Context includes `=== TEAM NAMES ===`. 5 suggestion prompts.
- **Report** — dataset export. Team + date filters, natural-language extraction query, tabular results. "Copy for Sheets" + "Download CSV". Best for clean dataset exports, not analytical questions.

Tab labels: `["League", "Teams", "Ask", "Report"]` — **"Report"** singular.

### Removed in v5
Matchup tab, Players tab, `matchupExploits()`, `buildKTGSystem()`, file upload UI, `node_modules/`, `dist/` from repo.

---

## GC Scraper Details

**Site:** `https://web.gc.com` | **Tool:** Playwright (Python)
**Auth:** `GC_USERNAME` / `GC_PASSWORD` GitHub Actions secrets
**Session:** persisted to `pipeline/gc_session.json` (gitignored, Actions-cached)
**Dev:** always use `scrape.py --dry-run`

---

## Claude API Usage

- **Model:** `claude-sonnet-4-20250514`
- **Delay:** 15 seconds between calls
- **Key:** `ANTHROPIC_API_KEY` secret / local `.env`

---

## GitHub Actions Workflow (daily.yml)

- **Cron:** 6am ET + `workflow_dispatch` | **Timeout:** 90 min | **Permissions:** `contents: write`
- **git add:** `games/ data/ public/repository.json public/games/`
- Vercel auto-deploys on push — no additional step needed

---

## Prompt Version History

| File | Version | Change |
|---|---|---|
| `prompts/transcribe.md` | v4.0 | Original |
| `prompts/transcribe.md` | v4.1 | Active batter = player in play description, not adjacent "next batter" header |
| `prompts/transcribe.md` | v4.2 | Verbatim team name preservation for registry matching |
| `prompts/ingest.md` | v6.0 | Current — 6-gate verification |

---

## Key Constraints and Gotchas

- **Never re-ingest a game.** `git ls-files` detection first; ingest prompt duplicate guard second.
- **Never modify existing Excel rows.** Ingest appends only.
- **Never modify the Derivation_Rules sheet.**
- **Gate failures are hard stops.** `|| continue` skips to the next game — does not override.
- **Prompts are source of truth.** Never inline their logic into Python scripts.
- **Batter misattribution** is the primary transcription failure mode. v4.1 handles it. If suspected, check `pipeline/raw/` vs the markdown play log.
- **Team code resolution is name-based and per-game.** Never add global code-to-code aliases — they break on ambiguous codes (NRTH = 5 different teams).
- **Unknown teams produce `[REGISTRY] WARNING`.** Add to `config.json` with all three fields (`code`, `display_name`, `name_patterns`), retry, then run `export.py`.
- **Excel filename is `RiverHill_Repository_Master.xlsx`.**
- **FOCAL_TEAMS appears in 5 places in hawks.jsx:** (1) `TEAM_NAMES` map, (2) `LeagueScatterPlot`, (3) `StandingsTable`, (4) `LeagueHeatMap`, (5) `classifyTeamsForTab`. Update all five when adding a focal team.
- **Safety net patterns in config.json are intentional.** Do not remove short-code patterns like `"knts"`, `"mt.h"`, `"cml"`.
- **Opponent field is always canonical codes.** `normalize_opponents.py` exists if issues recur.
- **`teamName(id, teams)` requires both arguments.** Omitting `data.teams` means non-focal opponents show as codes.
- **`fmtDate()` is module-scope.** Do not move it inside a component.
- **`buildChatSystem` uses `classifyTeams(data)`** (dynamic) — correct and intentional for Ask tab.
- **Ingested Game_ID may differ from `.md` filename** when registry resolves aliases. Known: HRFR→HRFD, MDDL→MDLT, KNTS→KTIS, LNGR→LNRC, MTHB→MT.H, STMC→ST.M, CMLW→CML.
- **Vercel build failures are silent to production.** Check Vercel dashboard when changes don't appear. Run `npm run build` locally to reproduce esbuild errors.
- **`<Analytics />` mounted once in `src/main.jsx`.** Do not duplicate in `app/hawks.jsx`.
- **Known data-quality items:** (1) `2020-04-07_STHR_at_GLNB` misdated duplicate; (2) `2026-04-04_CNTY_at_NRTE` team order reversed; (3) `STMC` alias missing from config.json.

---

## Analytics Sessions

For the repo owner running ad-hoc deep analytics. Not coach-facing — this is a Claude Code workflow.

**When to use:** Pitch-level data, multi-player comparisons, time-window splits, anything beyond the Ask tab's pre-aggregated season totals.

**Start a session:**
> *"Read CLAUDE.md. I want to run analytics on the current database. [Question]."*

Claude Code can read `public/repository.json` for counting stats and parse `games/*.md` for pitch-level work. For multi-game questions, write a Python script rather than parsing files one by one.

---

### Data Sources

| Question type | Source |
|---|---|
| Season aggregates | `public/repository.json` — instant |
| Per-game counting stats | `repository.json` → `batting` / `pitching` arrays |
| Game outcomes, scores | `repository.json` → `gameLog` |
| Pitch sequences, first-pitch data | `games/*.md` → Section 4 |
| Play-by-play outcomes | `games/*.md` → Section 3 |
| Team display names | `repository.json` → `teams` dict |

**Rule of thumb:** PA-level or pitch-level → need `.md`. Counting stats → `repository.json` is faster.

---

### .md File Structure

#### Section 3 — Structured Play Log
One row per PA.

| Column | Content |
|---|---|
| `#` | PA number — joins to Section 4 |
| `Inning` / `Half` | Integer / `"Top"` or `"Bottom"` |
| `Batter` | Player name |
| `Outcome` | `Single`, `Double`, `Triple`, `Home Run`, `Walk`, `Strikeout`, `Hit By Pitch`, `Sacrifice`, `Sacrifice Fly`, `Ground Out`, `Fly Out`, `Pop Out`, `Line Out`, `Error`, `Fielder's Choice`, `Dropped 3rd Strike` |
| `Description` | Full GC narrative |
| `Outs (End of Play)` | 1–3 or blank |
| `Runs Scored` | Integer or blank |
| `Notes` | Lineup changes, courtesy runners, score |

#### Section 4 — Pitch Sequences
One row per PA, joined to Section 3 by `#`.

**Pitch sequence tokens** (comma-separated):
- `Strike 1/2/3 swinging` / `Strike 1/2/3 looking`
- `Ball 1` / `Ball 2` / `Ball 3` / `Ball 4`
- `Foul` — never advances count past 2 strikes
- `In play` — ball put in play; always the final token for non-strikeout PAs
- `[bracketed text]` — **non-pitch events** (pickoffs, steals, wild pitches, runner advances). A single pitch can generate multiple bracketed events. **Filter all `[...]` tokens before counting pitches.**
- `[No pitch sequence recorded]` — missing

**First pitch:** First non-bracketed token.
- First-pitch strike: starts with `Strike`, `Foul`, or is `In play`
- First-pitch ball: starts with `Ball`

**Pitch count per PA:** All non-bracketed tokens including `Foul` and `In play`.

#### Section 5 — Data Integrity Flags
Run totals, hit totals, error count verification. Documents discrepancies between play log and GC official scorer. **Check before using hit counts analytically.**

---

### Parsing Recipes

**First-pitch strike rate by pitcher:**
```python
# 1. Get pitcher's game_ids from repository.json pitching array
# 2. For each game, parse Section 4
# 3. Cross-ref Section 3 to confirm pitcher for each PA
# 4. First non-bracketed token: Strike*/Foul/In play = FPS, Ball* = ball
```

**Pitches per PA:**
```python
# Parse Section 4; count non-bracketed tokens per row
# Join to Section 3 by # for batter + outcome
```

**Time-window splits:**
```python
import json
data = json.load(open("public/repository.json"))
rows = [r for r in data["batting"]
        if r["Team"] == "RVRH" and r["Player"] == "R Walsh"]
rows.sort(key=lambda r: r["Game_Date"])
first_10 = rows[:10]
last_5   = rows[-5:]
# aggregate each slice independently
```

**Get game IDs for pitch-level work:**
```python
game_ids = sorted(set(r["Game_ID"] for r in rows))
for gid in game_ids:
    md = open(f"games/{gid}.md").read()
    # parse Section 4
```

---

### Coverage Notes

- Pitch sequences present in all transcribed games (v4.0+); ~95%+ PA coverage
- Bracketed events must be filtered — one pitch can embed multiple `[...]` events
- Section 5 documents known hit/error discrepancies; check before hit-count analytics
- Incomplete final PA (game ended mid-at-bat): Section 4 shows `[No pitch sequence recorded]`

---

## Current State (late April 2026)

### Pipeline
- ✅ Full pipeline live (daily 6am ET + manual dispatch)
- ✅ Backfill complete — 15 focal teams, 237 games, 7,400+ rows (April 24)
- ✅ WLDL + HMMN promoted to focal teams (April 21); backfill complete
- ✅ `public/games/` sync gap fixed (April 24)
- ✅ All gate-failed focal games ingested (April 24)
- ✅ Name-based team registry — 15 focal + 95 known opponents, all with `display_name`
- ✅ Opponent field canonicalized (April 24) — 554 cells rewritten, 22 file renames
- ✅ Validator (PC1-PC5), triage, batch re-ingest tooling all live
- 🚧 Triage worklist — buckets E/G/H have acceptable cross-check gaps
- ⚠️ Known data items: `2020-04-07_STHR_at_GLNB` misdated; `2026-04-04_CNTY_at_NRTE` reversed; `STMC` alias missing

### App (v5 — current)
- ✅ 4-tab: League / Teams / Ask / Report
- ✅ Full team names everywhere — `teamName(id, data.teams)` at all 13 call sites; 110-entry `teams` dict in `repository.json`; Ask tab context includes `=== TEAM NAMES ===`
- ✅ Teams State 2: last-3 pills with hover/tap tooltips (opponent + date); Full Record accordion (collapsed by default)
- ✅ `fmtDate()` at module scope; `teamRecord()` results include `opp` and `home`
- ✅ Desktop two-column layouts at ≥1280px
- ✅ Vercel Web Analytics in `src/main.jsx`
- ✅ Report tab — dataset export with "Copy for Sheets" + "Download CSV"

---

## How to Start a Session

**Claude Code — build/fix:**
> *"Read CLAUDE.md. [Describe what you want to build or fix.]"*

**Claude Code — analytics:**
> *"Read CLAUDE.md. I want to run analytics on the current database. [Question.]"*

**Planning or troubleshooting chat:**
> Upload `PROJECT_NOTES.md`: *"Read PROJECT_NOTES.md. [Describe the issue or feature.]"*
