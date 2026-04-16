# RiverHill Hawks Scouting — Project Notes
*Knowledge base for chat-based planning, troubleshooting, and feature discussions.
For Claude Code build instructions, see CLAUDE.md.*

---

## What This Project Is

A fully automated baseball scouting pipeline and live dashboard for the RiverHill Hawks high school baseball program. It tracks River Hill and 12 other focal teams across a competitive Maryland high school league.

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
│   ├── config.json              ← all 13 focal teams with GC IDs and app codes
│   ├── scrape.py                ← Playwright scraper
│   ├── transcribe.py            ← transcription API call
│   ├── ingest.py                ← ingestion API call + Python Excel I/O
│   └── export.py                ← Excel → JSON exporter
├── prompts/
│   ├── transcribe.md            ← transcription prompt (v4.1)
│   └── ingest.md                ← ingestion prompt (v6)
├── games/                       ← all Game_ID.md files, git-tracked permanently
├── data/
│   └── RiverHill_Repository_Master.xlsx
├── public/
│   └── repository.json          ← fetched by app on mount
└── app/
    └── hawks.jsx                ← single-file React dashboard (no build step)
```

**No build step.** Vercel serves `app/hawks.jsx` directly. There is no bundler, no `package.json`, no `node_modules` in the repo.

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

## The 13 Focal Teams

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

RVRH is the primary focal team. The app classifies a team as "focal" if it appears ≥4 times as `Focal_Team` in Game_Log.

---

## The Two Prompts

These are the heart of the pipeline. They are mature and should not be modified without careful testing and a version bump.

### `prompts/transcribe.md` — v4.1
Converts raw GameChanger play-by-play text into a structured 5-section markdown document:
1. Game Header
2. Reported Team Totals
3. Structured Play Log (one row per plate appearance)
4. Pitch Sequences
5. Data Integrity Flags

**v4.1 addition:** Explicit rule that the active batter is always the player named in the play description, not any adjacent "next batter" header. GC logs show the next batter's name as a header immediately before the preceding batter's final play — Claude was misreading this.

### `prompts/ingest.md` — v6
Reads the structured markdown and extracts raw counting stats into JSON rows for each sheet. Runs 6 verification gates (G1-G6) comparing hit and run tallies against reported team totals. Enforces locked schema. Handles edge cases: courtesy runners, embedded SB/CS in pitch sequences, non-consecutive pitching stints, scorer corrections.

**Critical:** These prompts are read verbatim from disk by the pipeline scripts at runtime. Never inline their logic into Python.

---

## The App (hawks.jsx) — v5

Single-file React app (~1,800 lines), no build step, deployed to Vercel.

**Design principle:** "The app observes. The coach concludes." No interpretive text outside the Ask tab. Data labels and stat abbreviations only.

**Data flow:** `fetch("/repository.json")` on mount → `parseData(json)` → `classifyTeams()` → render

**Three tabs (v5 architecture, April 2026):**
- **League** — SVG scatter plot (OPS × ERA, interactive hover legend), sortable standings table (RVRH pinned), sortable heat map (gray→amber→red). Desktop: two-column layout at ≥1280px. All elements navigate to Teams State 2.
- **Teams** — 3-state progressive disclosure:
  - State 1: focal team card grid (threat-sorted, 13 hardcoded teams) + scouted opponents table (4+ games) + limited data accordion. Desktop: master-detail layout.
  - State 2: team briefing — sticky slim header (W-L · ERA · WHIP · last 3 results), 3 drawers (Pitching with outing strips / Lineup sortable table / Team Discipline with fielding, battery, baserunning, situational hitting). Player names tappable.
  - State 3: player intelligence — summary strip, Season/Last10/Last5 filters, sortable game log. Always full-page.
- **Ask** — Claude-powered chat via `/api/chat` Vercel serverless proxy. Only tab that makes API calls. Empty state with 5 coaching-oriented suggestion prompts.

**Key analytical functions (do not break):**
- `hitterThreat(b)` — OBP×40% + SLG×30% + (RBI/H)×15% + Contact×15%; min 8 PA
- `pitcherImpact(p)` — K/9×30% + Control×25% + ERA×25% + WHIP×20%; min 9 outs
- `playoffThreat(data, teamId)` — composite threat score; 4 internal tiers mapped to 3 UI tiers (THREAT ≥55, MID 25-54, WEAK <25)
- `defensiveTargets(data, teamId)` — error counts per fielder
- `teamRecord(data, teamId)` — W/L/RS/RA/streak/last5 from game log
- `buildChatSystem(data)` — pre-aggregates all data into tab-separated context for Ask tab

**Removed in v5:** Matchup tab, Players tab, `matchupExploits()`, `buildKTGSystem()`, file upload UI, Vite build scaffold

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

### API rate limits during backfill
The pipeline hit the output token rate limit (8,000 tokens/minute for claude-sonnet-4-20250514) during the initial backfill run processing multiple games in sequence. Fix: 60-second delay between API calls in multi-game runs. This only affects backfill — single daily game runs are well within limits. Rate limits increase automatically with account spend history over time.

### API Excel limitation
The Anthropic API document block only supports PDF. Attempting to pass the Excel file directly to the API fails. All Excel I/O must be handled by Python.

### GitHub PAT workflow scope
Pushing `.github/workflows/` files requires the `workflow` scope on the GitHub Personal Access Token, separate from general `repo` write access. If a push to the workflows directory fails with a permissions error, regenerate the PAT with `workflow` scope checked.

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

## Current Status (April 2026)

### Pipeline
- ✅ Full pipeline live and running (daily 6am ET cron + manual dispatch)
- ✅ All 6 build steps complete
- ✅ Backfill complete — all 13 focal teams backfilled; 5,171+ rows in repository
- ✅ Rate limit workaround in place (15-second delay between calls)
- ✅ Batter misattribution bug fixed in transcribe.md v4.1
- ✅ Verbatim team name preservation — transcribe.md v4.2
- ✅ Name-based team registry — replaced CODE_ALIASES (April 15); config.json is source of truth for team identity; 13 focal teams + 83 known opponents with name_patterns
- ✅ NRTH ambiguity resolved — 20 games disambiguated across 5 teams; all future games resolved per-game via name matching
- ⚠️ A few gate failures pending retry (`.md` exists but not in Excel Game_Log)
- ⚠️ Backfill games transcribed with v4.0 should be spot-checked for misattribution

### App (v5 redesign — completed April 13–14, 2026)
- ✅ 3-tab architecture live (League / Teams / Ask)
- ✅ Desktop two-column layouts at ≥1280px (master-detail on Teams tab)
- ✅ Interactive scatter plot with hover tooltips and team legend
- ✅ Sortable standings and heat map with full team names, expand/collapse for 6→13 rows
- ✅ 3-tier Teams tab (focal cards, scouted opponents table, limited data accordion)
- ✅ Team briefing with pitcher outing strips and 3 drawers
- ✅ Player intelligence with game log filters (Season/Last 10/Last 5)
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
