# RiverHill Hawks Scouting — Project Notes
*Knowledge base for chat-based planning, troubleshooting, and feature discussions.
For Claude Code build instructions, see CLAUDE.md.*

---

## What This Project Is

A fully automated baseball scouting pipeline and live dashboard for the RiverHill Hawks high school baseball program. It tracks River Hill and 14 other focal teams across a competitive Maryland high school league.

**End users:** Coaches and scouts — non-technical. They access a live Vercel web app and expect current data after every game. They never touch files, uploads, or any part of the pipeline.

**Owner/operator:** One person (Duke) who manages the repo, monitors the pipeline, and handles any failures that require human attention.

---

## The Old Workflow (What We Replaced)

Everything was manual and human-in-the-loop (HITL):

1. Go to GameChanger website, find game play-by-play, Ctrl-A / Ctrl-C
2. Paste into Claude chat with a transcription prompt → get structured markdown back
3. Upload markdown + Excel to a new Claude chat with an ingestion prompt → Claude appends rows to Excel
4. Download updated Excel, push to GitHub manually
5. Vercel auto-deploys, users see updated data

The bottleneck was that the owner had to be physically present for every step. Batching was only a reality because a human was in the middle — multiple games would pile up between sessions.

---

## The New Automated Pipeline

```
GitHub Actions (cron 6am ET daily + manual trigger)
  ↓
scrape.py        — Playwright logs into GC, finds new games, extracts play-by-play text
  ↓
transcribe.py    — Claude API converts raw text → structured Game_ID.md
  ↓
ingest.py        — Claude API reads markdown, returns JSON rows; Python writes to Excel
  ↓
export.py        — Python converts Excel → public/repository.json
  ↓
git commit+push  — only if new files were written
  ↓
Vercel auto-deploy — live app updated within minutes
```

**On clean runs:** zero human involvement. New game played → pipeline runs next morning → coaches see updated stats.

**On failures:** pipeline exits nonzero → GitHub Actions sends failure email → owner investigates and fixes manually.

---

## Repository Structure

```
/
├── CLAUDE.md                    ← Claude Code instructions (not for chat use)
├── PROJECT_NOTES.md             ← this file
├── .gitignore                   ← node_modules, dist, .env, .DS_Store, .claude/
├── .github/workflows/daily.yml  ← cron + manual trigger
├── api/
│   ├── chat.js                  ← Vercel serverless proxy for Ask tab
│   └── ktg.js                   ← legacy proxy (unused by v5 app)
├── pipeline/
│   ├── config.json              ← all 15 focal teams with GC IDs and app codes
│   ├── scrape.py                ← Playwright scraper
│   ├── transcribe.py            ← transcription API call
│   ├── ingest.py                ← ingestion API call + Python Excel I/O (runs PC1-PC5 at write-time)
│   ├── export.py                ← Excel → JSON exporter
│   ├── validate_core.py         ← PC1-PC5 validation logic (shared by ingest.py and validate.py)
│   ├── validate.py              ← standalone CLI: retrospective audit of ingested games
│   ├── triage.py                ← standalone CLI: classify validator failures into buckets A-H
│   └── reingest_batch.py        ← standalone CLI: batch retry/repair for Buckets A & B
├── prompts/
│   ├── transcribe.md            ← transcription prompt (v4.2)
│   └── ingest.md                ← ingestion prompt (v6)
├── games/                       ← all Game_ID.md files, git-tracked permanently
├── data/
│   └── RiverHill_Repository_Master.xlsx
├── public/
│   └── repository.json          ← fetched by app on mount
└── app/
    └── hawks.jsx                ← single-file React dashboard
```

**Vite build on deploy.** Vercel runs `npm install` + `vite build` on every push to `main`, bundling `src/main.jsx` → `../app/hawks.jsx` into `dist/`. `node_modules/` and `dist/` are gitignored and only exist at build time. `src/main.jsx` also mounts `<Analytics />` from `@vercel/analytics/react` at the root (enabled April 19).

---

## The Data Model

**Source of truth:** `data/RiverHill_Repository_Master.xlsx` — 4 data sheets plus Roster.

**Read-only export:** `public/repository.json` — what the app actually loads.

### Excel Sheets (locked schema — never modify columns)

**Game_Log:** One row per game.
`Game_ID | Game_Date | Game_Type | Focal_Team | Away_Team | Home_Team | Innings_Played | Source_File | Away_R | Away_H | Away_E | Home_R | Home_H | Home_E | QA_Flag_Count | Notes`

**Batting:** One row per player per game.
`Game_ID | Game_Date | Opponent | Team | Player | PA | AB | H | 1B | 2B | 3B | HR | BB | HBP | K | K_L | K_S | R | RBI | SB | CS | GDP | SAC | FC | Notes`

**Pitching:** One row per pitcher per game.
`Game_ID | Game_Date | Opponent | Team | Pitcher | Outs_Recorded | BF | H_Allowed | 1B_Allowed | 2B_Allowed | 3B_Allowed | HR_Allowed | BB_Allowed | HBP_Allowed | K | R_Allowed | WP | Notes`

**Fielding:** One row per error event.
`Game_ID | Game_Date | Opponent | Team | Player | Inning | Play_Ref | Notes`

**Roster:** Player registry by team.
`Team_Code | Player | First_Seen | Notes | Order`

### Game_ID Convention
Format: `YYYY-MM-DD_AWAY_at_HOME` (e.g., `2026-04-08_GLNL_at_GLFR`)
This is the unique key everywhere: Excel Game_Log, markdown filename, and duplicate guard.

---

## The 15 Focal Teams

| Team | GC Team ID | App Code |
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

RVRH is the primary focal team. Wilde Lake and Hammond were promoted from `known_opponents` to `focal_teams` on April 21, 2026; their full season was backfilled via the daily cron plus targeted manual ingest passes.

---

## The Two Prompts

These are the heart of the pipeline. They are mature and should not be modified without careful testing and a version bump.

### `prompts/transcribe.md` — v4.2
Converts raw GameChanger play-by-play text into a structured 5-section markdown document:
1. Game Header
2. Reported Team Totals
3. Structured Play Log (one row per plate appearance)
4. Pitch Sequences
5. Data Integrity Flags

**v4.1 addition:** Explicit rule that the active batter is always the player named in the play description, not any adjacent "next batter" header. GC logs show the next batter's name as a header immediately before the preceding batter's final play — Claude was misreading this.

**v4.2 addition:** Verbatim team name preservation rule: full names must be copied exactly from GameChanger, not abbreviated. Required for name-based team registry.

### `prompts/ingest.md` — v6
Reads the structured markdown and extracts raw counting stats into JSON rows for each sheet. Runs 6 verification gates (G1-G6) comparing hit and run tallies against reported team totals. Enforces locked schema. Handles edge cases: courtesy runners, embedded SB/CS in pitch sequences, non-consecutive pitching stints, scorer corrections.

**Critical:** These prompts are read verbatim from disk by the pipeline scripts at runtime. Never inline their logic into Python.

---

## The App (hawks.jsx) — v5

Single-file React app (~1,800 lines); Vercel handles the build via `npm install` + `vite build` on each deploy.

**Design principle:** "The app observes. The coach concludes." No interpretive text outside the Ask tab. Data labels and stat abbreviations only.

**Data flow:** `fetch("/repository.json")` on mount → `parseData(json)` → render

### Team classification — two separate functions with different purposes

- **`classifyTeams(data)`** — dynamically derives focal/opponent split from Game_Log (≥4 appearances as `Focal_Team`). Used **only** by `buildChatSystem` to assemble the Ask tab's Claude context. Not used by any UI component.

- **`classifyTeamsForTab(data)`** — splits all teams into focal (hardcoded `FOCAL_TEAMS` array of 15 codes) / scouted (4+ game appearances) / limited (<4 games). Drives **all Teams tab UI**: the focal card grid, the Scouted Opponents table, and the limited data accordion. Called internally by `TeamsCardGrid`; the `teams` prop passed from `App` via `classifyTeams` is not used for UI rendering.

The hardcoded `FOCAL_TEAMS` array appears in 5 places in hawks.jsx: (1) `TEAM_NAMES` map at file top, (2) `LeagueScatterPlot`, (3) `StandingsTable`, (4) `LeagueHeatMap`, (5) `classifyTeamsForTab`. Update all five when adding a team.

**Four tabs (v5 architecture, April 2026):**
- **League** — SVG scatter plot (OPS × ERA, interactive hover legend), sortable standings table (RVRH pinned), sortable heat map (gray→amber→red). Desktop: two-column layout at ≥1280px. All elements navigate to Teams State 2.
- **Teams** — 3-state progressive disclosure:
  - State 1: focal team card grid (threat-sorted, 15 hardcoded teams) + scouted opponents table (4+ games, via `classifyTeamsForTab`) + limited data accordion. Desktop: master-detail layout.
  - State 2: team briefing — sticky slim header (W-L · ERA · WHIP · last 3 results), 3 drawers (Pitching with outing strips / Lineup sortable table / Team Discipline with fielding, battery, baserunning, situational hitting). Player names tappable.
  - State 3: player intelligence — summary strip, Season/Last10/Last5 filters, sortable game log. Always full-page. Two-way players (pitching + batting data) show a Pitching/Batting toggle; default view set by where the player was tapped (Pitching drawer → pitching view, Lineup drawer → batting view).
- **Ask** — Claude-powered chat via `/api/chat` Vercel serverless proxy. Only tab that makes API calls. Empty state with 5 coaching-oriented suggestion prompts.
- **Report** — batch query builder for game logs (added mid-April). Includes "Copy for Sheets" button for clipboard export. Tab label is "Report" singular — hardcoded in `["League", "Teams", "Ask", "Report"]` at the bottom of `App()` in `hawks.jsx`.

**Key analytical functions (do not break):**
- `hitterThreat(b)` — OBP×40% + SLG×30% + (RBI/H)×15% + Contact×15%; min 8 PA
- `pitcherImpact(p)` — K/9×30% + Control×25% + ERA×25% + WHIP×20%; min 9 outs
- `playoffThreat(data, teamId)` — composite threat score; 4 internal tiers mapped to 3 UI tiers (THREAT ≥55, MID 25-54, WEAK <25)
- `defensiveTargets(data, teamId)` — error counts per fielder
- `teamRecord(data, teamId)` — W/L/RS/RA/streak/last5 from game log
- `buildChatSystem(data)` — pre-aggregates all data into tab-separated context for Ask tab; uses `classifyTeams(data)` to enumerate teams

**Removed in v5:** Matchup tab, Players tab, `matchupExploits()`, `buildKTGSystem()`, file upload UI. (`node_modules/` and `dist/` removed from the repo too; the Vite scaffold in `src/` + `package.json` + `vite.config.js` + `index.html` is retained and built by Vercel on deploy.)

---

## The Validator (PC1-PC5) and Triage System

Built out through mid-to-late April 2026. Purpose: audit already-ingested games against their markdown source, surface discrepancies the write-time ingest gate missed, and repair what can be repaired automatically.

### PC1-PC5 checks (`pipeline/validate_core.py`)

One shared library called by both `ingest.py` (at write-time) and `validate.py` (retrospective). Team code resolution flows through the same `config.json` name-patterns registry used by `ingest.py`.

| Check | Verifies |
|---|---|
| **PC1** | Pitching outs per team ≥ innings × 3 × 0.85 (catches missing pitcher rows) |
| **PC2** | Sum of H_Allowed matches opposing team's reported hits (±1 tolerance, ±3 if Section 5 documents a discrepancy) |
| **PC3** | Every pitcher named in play log appears in Pitching rows |
| **PC4** | Every batter in play log appears in Batting rows |
| **PC5** | Sum of PA ≥ 75% of play-log batter appearances or innings × 2.5 (flags dropped rows) |

### Three CLI tools

- **`validate.py`** — retrospective audit. Flags: `[game.md] | --game-id | --all | --since | --until | --verbose | --json`. Read-only. Exits 0/1/2 for pass/fail/parse-error.
- **`triage.py`** — takes validate's output and buckets failures into categories A-H based on issue type, scope (focal vs opponent), and Section 5 documentation. Processing priority A → B → C → D → E → F → G → H.
- **`reingest_batch.py`** — auto-repair for Buckets A & B by default (focal team missing pitcher/batter). Snapshots, deletes, re-ingests, re-audits, retries up to N times, restores if still failing. Mandatory Excel backup at `data/backups/` and per-game log at `pipeline/reingest_batch.log`.

### Bucket taxonomy

| Bucket | Scope | Signal | Auto-repair? |
|---|---|---|---|
| A | Focal | Missing specific pitcher (PC3 or PC1 zero-outs) | Yes (default) |
| B | Focal | Missing specific batter (PC4) | Yes (default) |
| C | Focal | Hit mismatch (PC2), Section 5 **fully** documents | Needs `--force-bucket` |
| D | Focal | Hit mismatch (PC2), Section 5 **partially** documents | Needs `--force-bucket` |
| E | Focal | Hit mismatch (PC2), **not** documented | Needs `--force-bucket` |
| F | Non-focal | Missing pitcher/batter on opponent | Needs `--force-bucket` |
| G | Any | Multiple issue types or unclassified | Needs `--force-bucket` |
| H | Any | PC5 only (known parser limitation, low priority) | Not auto-repaired |

### Not in `daily.yml`

The validator is standalone dev/ops tooling. `ingest.py` already runs PC1-PC5 at write-time via `validate_core.py`, so daily runs are pre-validated. The retrospective tools exist because write-time gates catch only the narrowest failures — misattributions that balance at team level, historical backfill games transcribed under older prompt versions, and edge cases where parser limitations masked discrepancies.

### Related parser improvements

- **Skip incomplete PAs** — games that ended mid-at-bat no longer fail parsing; the incomplete PA is dropped, not a fatal error.
- **Skip phantom pitchers** — validator ignores Pitching rows for pitchers with no play-log appearances (an earlier ingest edge case).

---

## Key Architectural Decisions and Why

### Python owns all Excel I/O — Claude never touches the Excel file
The original design sent the Excel file to the Claude API directly. This doesn't work — the API document block only supports PDF, not Excel, and the file exceeds inline text limits. The correct architecture: Python reads Excel, passes existing Game_IDs as text to Claude for duplicate detection, Claude returns structured JSON with rows to append, Python validates and writes. Claude never sees the Excel file.

### JSON as the deployment artifact, not Excel
The app originally required someone to manually upload the Excel file — the "load new file" button. Excel is now the write target only. `export.py` converts it to `public/repository.json` which the app fetches on mount. Non-technical users never interact with files.

### Game_ID as the universal key
No sequential counter. `YYYY-MM-DD_AWAY_at_HOME` is the Game_ID everywhere: Excel Game_Log, markdown filename in `games/`, and duplicate guard. The scraper checks `games/` for existing files before any API work. The ingest prompt checks Game_Log before writing. Two layers of protection against double-ingestion.

### Session persistence for GC scraping
GameChanger has a login gate. Playwright saves authenticated session state to `pipeline/gc_session.json` after first login. Subsequent runs load the saved session — the login endpoint is only touched when the session expires. `gc_session.json` is in `.gitignore` and stored as a GitHub Actions cache artifact between runs. During development, `scrape.py --dry-run` uses the saved session without hitting the login endpoint at all. This was critical — aggressive login attempts during testing triggered GC rate-limiting.

---

## Known Issues and Lessons Learned

### Batter misattribution (transcription)
**What happened:** In one game, a J Norwood home run was attributed to H Zhang in the transcription. GC's format shows the next batter's name as a header immediately before the preceding batter's final play. Claude misread the header as the active batter.

**Fix:** Added explicit rule to `prompts/transcribe.md` v4.1. The active batter is always the player named in the play description itself, never an adjacent header.

**Detection:** The 6 ingestion gates check team-level totals only. A misattribution where the HR is credited to the wrong player can pass all gates if team hit and run totals still balance. Per-player PA reconciliation in `ingest.py` is the safeguard — Python independently counts each player's PAs from the markdown and compares against the JSON values.

### Team-level gates do not catch all errors
G1-G6 verify team hit and run totals. They cannot catch: stats correctly totaled but misattributed between players, dropped PAs that result in neither a hit nor a run, or errors in counting stats that happen to cancel out. The per-player PA check is the additional safeguard but is not exhaustive.

### CODE_ALIASES → Name-based team registry (evolved April 14–15, 2026)
**What happened (April 14):** `ingest.py` had a `CODE_ALIASES` map (LNGR→LNRC, MDDL→MDLT, etc.) but only used it for focal team detection, not data rows. This caused split data (e.g., Long Reach stats under both LNGR and LNRC).

**What happened next:** Applying aliases to data rows fixed the split data, but the `NRTH` alias was fundamentally broken — GameChanger uses `NRTH` for at least 5 different teams (North Harford, North Point, Northern, North County, Northwest). The global alias `NRTH→NHRF` silently corrupted data for 12 out of 15 NRTH games, attributing stats from other teams to North Harford.

**Fix (April 15):** Replaced the entire `CODE_ALIASES` system with a name-based team registry in `config.json`. Each team has `name_patterns` (lowercase substrings). At ingest time, the full team name from the markdown header (e.g., "North Harford Varsity Hawks") is matched against these patterns to determine the correct canonical code. Resolution is per-game, not global — the same raw code `NRTH` correctly resolves to different canonical codes depending on which team is actually playing.

**Lesson:** Static code-to-code aliases break when the upstream source (GameChanger) reuses codes across teams. Name-based resolution is the correct abstraction — it's stable across code changes and handles ambiguity naturally. Unknown teams now produce loud failures instead of silent corruption.

### Section 5 miscounts as gate failure cause (late April 2026)
**What happened:** Six focal-team games persistently failed ingest gates (G1/G3 hit mismatches) across multiple batch retries, even though `--skip-crosschecks` doesn't bypass gates. Investigation showed the Structured Play Log's Outcome column had correct hit counts in most cases — but Section 5's "Mandatory Verification — Hit Totals" section was miscounted by Claude at transcription time. When `ingest.py` ran, Claude deferred to Section 5's wrong number rather than counting fresh from the play log, failing the gate.

**Fix pattern:** For each stuck game, parse the Structured Play Log Outcome column (counting `Single`/`Double`/`Triple`/`Home Run`) and compare against Section 5's claim. When they diverge, correct Section 5 (usually by adding an omitted play, removing a mis-attributed one, or fixing half-inning assignments). Then re-ingest. In cases where the play log Outcome itself disagrees with GC's official box score (e.g., "Error" where GC credits a Single via reach-on-error), edit the Outcome column to match GC.

**Lesson:** When a gate failure seems persistent, don't assume bad data. Check Section 5 arithmetic first — it's often the parser artifact, not the source data. A small helper script scanning Outcome column counts per half reveals miscounts quickly.

**Scoring judgment caveat:** GameChanger's official scorer and Claude's transcription sometimes disagree on reach-on-error vs single. The official scorer's call is authoritative — if the user visually confirms from GC that a play is a hit, edit the Outcome column to `Single` and keep the error in the description for runner advancement.

### Pre-existing data-quality items flagged for future cleanup
- **`2020-04-07_STHR_at_GLNB` duplicate** — Both Game_Log entries under this ID actually contain 2026-era data with misparsed dates (likely from an old backfill and a more recent manual ingest). Roster players and pitcher names are current, not 2020.
- **`2026-04-04_CNTY_at_NRTE`** — Ingested with team order reversed (the .md file is NRTE_at_CNTY but Game_ID shows CNTY_at_NRTE).
- **`STMC` alias missing from `config.json`** — Saint Michaels games ingest as `ST.M` instead of being mapped to a canonical code. Add an entry to `known_opponents` with name patterns `["st. michaels", "saint michaels"]` to consolidate.

### API rate limits during backfill
The pipeline hit the output token rate limit (8,000 tokens/minute for claude-sonnet-4-20250514) during the initial backfill run processing multiple games in sequence. Fix: 60-second delay between API calls in multi-game runs. This only affects backfill — single daily game runs are well within limits. Rate limits increase automatically with account spend history over time.

### API Excel limitation
The Anthropic API document block only supports PDF. Attempting to pass the Excel file directly to the API fails. All Excel I/O must be handled by Python.

### GitHub PAT workflow scope
Pushing `.github/workflows/` files requires the `workflow` scope on the GitHub Personal Access Token, separate from general `repo` write access. If a push to the workflows directory fails with a permissions error, regenerate the PAT with `workflow` scope checked.

### Silent Vercel deploy failures (April 18-19, 2026)
**What happened:** A commit titled "Fix table column alignment in standings and heat map" (`3e2ed79`) refactored the `LeagueHeatMap` from a split-table pattern to a single sticky-thead table. The refactor removed an inner `<div>` wrapper but left its closing `</div>` tag behind, creating an unbalanced JSX tree. esbuild misreads the stray `</div>` as `<` (less-than) followed by a regex literal and dies with "Unterminated regular expression".

**Why it went unnoticed for a week:** Vercel auto-deploys on every push to `main`, but a failed build does not take down production — it just leaves production serving the last green bundle. The failure shows as a red ❌ on the PR/commit and "Error" in the Vercel dashboard, but is invisible to anyone who doesn't look. Every commit from April 18 onward queued up behind this broken build without any of them deploying.

**How it was caught:** An attempt to wire up Vercel Analytics showed the Vercel deployment failing. Running `npm run build` locally at the tip commit reproduced the esbuild error and pointed to the line with the stray `</div>`. Walking commits back with `npm run build` at each one pinpointed `3e2ed79` as the introduction point.

**Lesson:** When a UI change doesn't show up in production, check Vercel deployment status on the tip commit before assuming caching, CDN delays, or client-side issues. `npm run build` locally is a fast way to reproduce any esbuild failure. Going forward, consider wiring `npm run build` into a pre-push hook or GitHub Action check on PRs to main.

### Vercel Analytics setup (April 19, 2026)
**What works:** `@vercel/analytics/react` mounted once in `src/main.jsx` alongside `<App />`. Dashboard enabled in Vercel project settings. Beacons land at `/_vercel/insights/script.js` (tracker) and `/_vercel/insights/view` (page view). Verified in Incognito Network tab after the broken-build fix shipped.

**Gotchas observed:**
- The docs' Next.js quickstart uses `@vercel/analytics/next` — wrong for a Vite+React app. Use `@vercel/analytics/react`. `/next` pulls in Next.js router hooks that don't exist here.
- Do not mount `<Analytics />` twice. An interim attempt mounted it in both `src/main.jsx` and `app/hawks.jsx`; only `src/main.jsx` is canonical.
- Ad blockers and privacy extensions very commonly block `/_vercel/insights/*`. When verifying the install, use Incognito with extensions off.
- Preview deploys run in "development mode" and do not beacon to production Analytics — they log to the browser console instead. Production beacons only fire on the production domain.

---

## Infrastructure

| Component | Detail |
|---|---|
| Hosting | Vercel, connected to GitHub main, auto-deploys on push |
| CI/CD | GitHub Actions, cron 6am ET + `workflow_dispatch` |
| GC scraping | Playwright (Python) |
| API model | `claude-sonnet-4-20250514` for transcription and ingestion |
| Excel I/O | openpyxl (Python) |
| Secrets | `GC_USERNAME`, `GC_PASSWORD`, `ANTHROPIC_API_KEY` in GitHub Actions |
| Local dev | `.env` file with `ANTHROPIC_API_KEY`, loaded via python-dotenv |
| API billing | Separate from Claude.ai Max subscription — billed at console.anthropic.com |

---

## Current Status (late April 2026)

### Pipeline
- ✅ Full pipeline live and running (daily 6am ET cron + manual dispatch)
- ✅ All 6 build steps complete
- ✅ **Backfill complete — all 15 focal teams; 237 games / 7,400+ rows in repository (as of April 24)**
- ✅ **Wilde Lake + Hammond promoted to focal teams (April 21)** — full season backfilled via daily cron plus a multi-pass manual ingest session
- ✅ **`public/games/` sync gap fixed (April 24)** — `daily.yml` now stages `public/games/` so per-game markdowns deploy with `repository.json`; 46 previously-untracked files backfilled
- ✅ **All originally-gate-failed focal games ingested (April 24)** — several stubborn games required Section 5 hit-list corrections or play-log Outcome edits (reach-on-error → single per GC scorer) to land
- ✅ Rate limit workaround in place (15-second delay between calls)
- ✅ Batter misattribution bug fixed in transcribe.md v4.1
- ✅ Verbatim team name preservation — transcribe.md v4.2
- ✅ Name-based team registry — replaced CODE_ALIASES (April 15); config.json is source of truth for team identity; 15 focal teams + 81 known opponents with name_patterns
- ✅ NRTH ambiguity resolved — 20 games disambiguated across 5 teams; all future games resolved per-game via name matching
- ✅ Validator system live — `validate_core.py` shared between `ingest.py` (write-time) and `validate.py` (retrospective audit); PC1-PC5 checks; team code resolution through config.json registry
- ✅ Triage + batch re-ingest tooling — `triage.py` buckets A-H; `reingest_batch.py` auto-repairs Buckets A & B with Excel backup + per-game snapshot/restore
- ✅ Parser improvements — skip incomplete PAs (mid-at-bat game endings); skip phantom pitchers (zero-appearance entries)
- 🚧 Triage worklist — retrospective validator still flags games landed via `--skip-crosschecks` as PC failures (by design); these are acceptable cross-check gaps that live in buckets E/G/H
- ⚠️ Flagged for future cleanup: `2020-04-07_STHR_at_GLNB` duplicate, `CNTY_at_NRTE` team order reversed, missing `STMC` alias — details under Known Issues
- ⚠️ Backfill games transcribed with v4.0 should be spot-checked for misattribution

### App (v5 redesign — completed April 13–14, 2026)
- ✅ 4-tab architecture live (League / Teams / Ask / Report)
- ✅ Desktop two-column layouts at ≥1280px (master-detail on Teams tab)
- ✅ Interactive scatter plot with hover tooltips and team legend
- ✅ Sortable standings and heat map with full team names, expand/collapse for 6→15 rows (sticky-thead single-table layout; fixed April 19 after stray `</div>` broke deploys for a week)
- ✅ 3-tier Teams tab (focal cards, scouted opponents table, limited data accordion)
- ✅ Team briefing with pitcher outing strips and 3 drawers
- ✅ Player intelligence with game log filters (Season/Last 10/Last 5); Pitching/Batting toggle for two-way players
- ✅ Report tab — batch query builder for game logs with "Copy for Sheets" clipboard export
- ✅ Vercel Web Analytics enabled — `@vercel/analytics/react` mounted in `src/main.jsx`; dashboard enabled April 19
- ✅ Repo cleaned — node_modules/ and dist/ removed (built by Vercel on deploy)

---

## How to Start a Claude Code Session

Open Claude Code in the repo root and say:
> *"Read CLAUDE.md. [Then describe what you want to do.]"*

CLAUDE.md has the full schema, build order, file locations, and technical constraints.

## How to Start a Planning or Troubleshooting Chat

Upload this file (PROJECT_NOTES.md) and say:
> *"Read PROJECT_NOTES.md. [Then describe the issue or feature you want to discuss.]"*

For issues involving specific code, also share the relevant file from the repo.
