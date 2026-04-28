# Team Brief Generator

A CLI that produces a 2-page PDF scouting brief for any focal team, written to
`public/briefs/{TEAM_CODE}_brief.pdf` so it auto-deploys via Vercel and is shareable
by direct URL.

## Install

```bash
pip install -r briefs/requirements.txt
```

WeasyPrint has a small set of native dependencies (Pango, Cairo, GDK-PixBuf). On macOS:

```bash
brew install pango
```

See https://doc.courtbouillon.org/weasyprint/stable/first_steps.html for other platforms.

**Apple Silicon note.** Python's `ctypes` does not search `/opt/homebrew/lib` by default,
so even after `brew install pango`, WeasyPrint will fail with `cannot load library
'libgobject-2.0-0'`. Either prefix every run with `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`
or set it permanently in your shell profile:

```bash
echo 'export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib' >> ~/.zshrc
```

## Run

```bash
# from the repo root
python -m briefs.build --team LNRC
python -m briefs.build --team RVRH --window 14    # only last 14 days
python -m briefs.build --all                       # all 15 focal teams
python -m briefs.build --team CNTN --output-dir /tmp/briefs
```

Output: `public/briefs/{TEAM_CODE}_brief.pdf`. Files are overwritten in place — no
timestamping. Commit the PDF if you want it published; Vercel serves the latest.

## Brief structure

**Page 1**: cover header, 8 Recent Form cards (Season / L10 / L5 vs league avg),
Pitching section (workload calendar across L5, Pitcher Insights table, team OPS-by-TTO).

**Page 2**: most-common L5 lineup (left), Base Running team strip + per-player table
(right), aggregated per-inning Runs/Errors cadence chart, Methodology footer.

## Adding a new section

1. Add a metric module under `briefs/metrics/`
2. Wire it into `assemble()` in `briefs/build.py`
3. Add a render function in `briefs/render/template.py` and include it in `render()`
4. Style classes go in `briefs/render/styles.css`. **SVG elements need inline `fill` /
   `font-size` attrs — WeasyPrint does not honor CSS classes on raw `<rect>` / `<text>`.**

## Known data-quality flags (handled, do not need fixing)

- **Duplicate `gameLog` entries** when two focal teams play each other → deduped on `Game_ID`
- **`._*` macOS metadata files** in `games/` → filtered
- **Empty / `Unknown Player` pitcher rows** with non-zero outs → skipped, logged as WARNING
- **`Top`/`Bottom` and `T`/`B` half-inning labels** both supported
- **4 header format variants** in `.md` files → all parsed
- **4 pitcher-transition patterns** (`Lineup changed: X in at pitcher`, `X in at pitcher`,
  `X in for pitcher`, `X pitching` in description) → all walked
- **`gameLog` `Home_E` / `Away_E` may be flipped** relative to play log → cadence chart
  uses errors parsed from play-log text, not gameLog totals (documented in methodology)

## Intentional omissions

- **1st-to-3rd metric** — runner-state inference produced too many false positives
- **Focal-team-actual pitch-level league averages** — would require parsing all 15 teams'
  `.md` files. Currently uses HS literature benchmarks (FPS 58%, S 60%, 2K K 35%,
  Lead BB 12%). Documented in methodology footer. Replace if/when nightly parse is added.
