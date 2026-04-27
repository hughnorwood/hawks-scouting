# RVRH_Game_1.md

## Game Header

- **Teams:** Northeast Eagles Varsity Baseball (away) / Southern Varsity Bulldogs (home)
- **Date:** Sat Apr 25, 12:00 PM - 1:00 PM ET
- **Game Type:** Not labeled
- **Final Score:** Northeast Eagles Varsity Baseball 4, Southern Varsity Bulldogs 5
- **Innings Played:** 6 (incomplete - home team did not bat in 7th)
- **Source:** GameChanger Play Log

---

## Reported Team Totals (As Displayed in Log)

**Line Score:**
```
        1  2  3  4  5  6  7
NRTH    0  1  1  0  0  1  1
STHR    0  0  0  0  5  0  X
```

**Team Totals:**
- Northeast Eagles Varsity Baseball: R=4, H=6, E=4
- Southern Varsity Bulldogs: R=5, H=7, E=2

---

## Structured Play Log

| # | Inning | Half | Batter | Outcome | Description | Outs (End of Play) | Runs Scored | Notes |
|---|--------|------|--------|---------|-------------|--------------------|-------------|-------|
| 1 | 5 | Bottom | M Bolak | Single | singles on a line drive to left fielder J Gordon | | | |
| 2 | 5 | Bottom | A Brown | Sacrifice | sacrifices, first baseman S Tarantino to second baseman K Humphreys, M Kim out advancing to 1st, M Bolak advances to 2nd | 1 | | |
| 3 | 5 | Bottom | A Wilber | Strikeout | strikes out swinging, G decker pitching, M Bolak remains at 2nd | 2 | | |
| 4 | 5 | Bottom | T Calnon | Walk | is intentionally walked, G decker pitching, M Bolak remains at 2nd | 2 | | |
| 5 | 5 | Bottom | A Longo | Strikeout | strikes out swinging, G decker pitching | 3 | | |
| 6 | 6 | Top | J Curtis | Ground Out | grounds out, second baseman M Guard to first baseman T Calnon | 1 | | |
| 7 | 6 | Top | K Carlson | Ground Out | grounds out, second baseman M Guard to first baseman T Calnon | 2 | | |
| 8 | 6 | Top | S Tarantino | Ground Out | grounds out, catcher C England to first baseman T Calnon | 3 | | |
| 9 | 6 | Bottom | M Guard | Single | singles on a line drive to third baseman A DiCenzo | | | |
| 10 | 6 | Bottom | K Redmond | Pop Out | pops out to left fielder J Gordon, M Guard remains at 1st | 1 | | Lineup changed: A Davis in at pitcher |
| 11 | 6 | Bottom | C England | Double Play | grounds into a double play, shortstopH Lagasse to first baseman S Tarantino, M Guard out advancing to 2nd, C England doubled off at 1s | 3 | | |
| 12 | 7 | Top | K Flannery | Ground Out | grounds out, shortstop A Brown to first baseman T Calnon | 1 | | Lineup changed: K Flannery in for batter M Guard |
| 13 | 7 | Top | K Humphreys | Fly Out | flies out to third baseman A Logoleo | 2 | | |
| 14 | 7 | Top | V Wong | Single | singles on a line drive to pitcher V Cagle | 2 | | |
| 15 | 7 | Top | G decker | Home Run | homers on a line drive to left field | 2 | 1 | |
| 16 | 7 | Top | A DiCenzo | Strikeout | strikes out swinging, V Cagle pitching | 3 | | Lineup changed: Pinch runner R Legg in for extra hitter V Wong |

---

## Pitch Sequences

| # | Inning/Half | Batter | Pitch Sequence |
|---|-------------|--------|----------------|
| 1 | 5/Bottom | M Bolak | Foul, Foul, Foul, Ball 1, In Play |
| 2 | 5/Bottom | A Brown | In Play |
| 3 | 5/Bottom | A Wilber | Strike 1 looking, Foul, Ball 1, Ball 2, Strike 3 swinging |
| 4 | 5/Bottom | T Calnon | Ball 1 (intentional), Ball 2 (intentional), Ball 3 (intentional), Ball 4 (intentional) |
| 5 | 5/Bottom | A Longo | Ball 1, Strike 1 swinging, Strike 2 swinging, Strike 3 swinging |
| 6 | 6/Top | J Curtis | Ball 1, In play |
| 7 | 6/Top | K Carlson | Ball 1, In play |
| 8 | 6/Top | S Tarantino | Foul, Strike 2 swinging, Ball 1, Ball 2, In play |
| 9 | 6/Bottom | M Guard | Ball 1, Ball 2, Ball 3, Strike 1 looking, In Play |
| 10 | 6/Bottom | K Redmond | Ball 1, Ball 2, Strike 1 looking, In Play |
| 11 | 6/Bottom | C England | Ball 1, In Play |
| 12 | 7/Top | K Flannery | Strike 1 looking, Foul, Ball 1, Ball 2, In Play |
| 13 | 7/Top | K Humphreys | Foul bunt, Strike 2 looking, Foul, In Play |
| 14 | 7/Top | V Wong | Foul, Strike 2 looking, Ball 1, In Play |
| 15 | 7/Top | G decker | Strike 1 looking, Foul, Ball 1, Foul, In Play |
| 16 | 7/Top | A DiCenzo | Strike 1 looking, Strike 2 swinging, Ball 1, Strike 3 swinging |

---

## Data Integrity Flags

**Flag #1 — Undocumented pitching transition:** G decker first appears pitching in play #3 without a preceding "Lineup changed" entry. Recorded as logged.

**Flag #2 — Undocumented pitching transition:** V Cagle first appears pitching in play #14 without a preceding "Lineup changed" entry. Recorded as logged.

**Flag #3 — Line score vs. log contradiction:** The line score shows NRTH scoring 1 run in the 7th inning and STHR with "X" (indicating they did not bat), but the play log shows only NRTH batting in the 7th with 1 run scored. This is consistent, not a contradiction.

### Mandatory Verification — Run Totals

**Runs from play log by inning:**
- NRTH: Inning 7 = 1 run (play #15: G decker home run). Total from play log: 1 run
- STHR: No runs recorded in available play log entries. Total from play log: 0 runs

**Line score inning totals:**
- NRTH: 0+1+1+0+0+1+1 = 4 runs
- STHR: 0+0+0+0+5+0 = 5 runs

**Reported team R totals:**
- NRTH: 4 runs
- STHR: 5 runs

**Conflict:** The play log only contains entries for innings 5-7, showing 1 run for NRTH and 0 runs for STHR. The line score and team totals show NRTH with 4 runs total and STHR with 5 runs total. The missing innings 1-4 account for the discrepancy. This conflict is unresolved.

### Mandatory Verification — Hit Totals

**Hits from play log:**
- Play #1: M Bolak single
- Play #9: M Guard single
- Play #14: V Wong single
- Play #15: G decker home run
Total hits from play log: 4 hits

**Reported team H totals:**
- NRTH: 6 hits
- STHR: 7 hits

**Conflict:** The play log shows 4 total hits (3 for NRTH, 1 for STHR) but the reported totals are NRTH 6, STHR 7. This discrepancy is unresolved.

### Mandatory Verification — Errors

**Errors from play log:** No errors explicitly mentioned in the available play log entries.

**Reported team E totals:**
- NRTH: 4 errors
- STHR: 2 errors

**Conflict:** The play log shows 0 errors but the reported totals show NRTH 4, STHR 2. This discrepancy is unresolved.