#!/usr/bin/env python3
"""Pure-function validation module for Hawks Scouting game data.

Parses play log markdown and provides cross-checks (PC1–PC5) that compare
emitted JSON rows against play-log ground truth. Imported by both
`ingest.py` (pre-write validation) and `validate.py` (retrospective audit).

No I/O here — pure functions only.
"""

import re
from dataclasses import dataclass, field
from typing import List, Dict, Set, Optional


# ─── Data classes ────────────────────────────────────────────────────────────

@dataclass
class Play:
    play_num: int
    inning: int
    half: str              # "Top" or "Bottom"
    batter: str
    outcome: str
    description: str
    outs_end: Optional[int]  # None if blank (not last out of half-inning)
    runs: str              # raw runs scored string (may be blank)
    notes: str


@dataclass
class PlayLog:
    plays: List[Play] = field(default_factory=list)
    innings_played: int = 0   # from game header if available
    away_team: str = ""
    home_team: str = ""
    away_h: int = 0           # reported in Section 2
    home_h: int = 0
    away_r: int = 0
    home_r: int = 0
    raw_md: str = ""          # original markdown for header lookups


@dataclass
class Discrepancy:
    check: str     # "PC1", "PC2", "PC3", etc.
    team: str
    expected: str
    actual: str
    details: str

    def __str__(self):
        return f"{self.check} {self.team}: expected {self.expected}, got {self.actual} ({self.details})"


@dataclass
class ValidationReport:
    ok: bool
    discrepancies: List[Discrepancy] = field(default_factory=list)
    summary: str = ""


# ─── Parse layer ─────────────────────────────────────────────────────────────

# Match a structured play-log row: | # | inning | half | batter | ...
PLAY_ROW_RE = re.compile(
    r'^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(Top|Bottom|T|B)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(\d*)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|?\s*$',
    re.MULTILINE
)


def parse_play_log(md_text: str, game_id: Optional[str] = None) -> PlayLog:
    """Parse the structured play log from a game markdown file.

    game_id: optional Game_ID (e.g. "2026-04-17_OKLN_at_RVRH") used to seed
    team codes when the markdown header doesn't have them. Typically derived
    from the filename.
    """
    log = PlayLog()
    log.raw_md = md_text

    # Parse team names from header (e.g., "Teams: RVRH / OKLN" or "Teams: Oakland Mills (away) / River Hill (home)")
    header = md_text[:3000]

    # 1. Try Game_ID pattern within the markdown text
    gid_m = re.search(r'(\d{4}-\d{2}-\d{2})_([A-Z]{3,5})_at_([A-Z]{3,5})', md_text)
    if gid_m:
        log.away_team = gid_m.group(2)
        log.home_team = gid_m.group(3)

    # 2. If no match, use the supplied game_id
    if not log.away_team and game_id:
        gid2 = re.match(r'\d{4}-\d{2}-\d{2}_([A-Z]{3,5})_at_([A-Z]{3,5})', game_id)
        if gid2:
            log.away_team = gid2.group(1)
            log.home_team = gid2.group(2)

    # Parse innings played from header
    # Matches "Innings Played: 5", "Innings: 5", "**Innings:** 5 (complete)", etc.
    innings_m = re.search(
        r'\*?\*?Innings(?:\s+Played)?\*?\*?\s*:\s*\*?\*?\s*(\d+)',
        header, re.IGNORECASE
    )
    if innings_m:
        log.innings_played = int(innings_m.group(1))

    # Parse reported H / R totals from header Section 2
    # "Away: R=X, H=Y" style or line score style
    # Try "Oakland Mills: R=0, H=3" style
    totals_re = re.finditer(
        r'R\s*=\s*(\d+)\s*,\s*H\s*=\s*(\d+)',
        header
    )
    rh_totals = [(int(m.group(1)), int(m.group(2))) for m in totals_re]
    if len(rh_totals) >= 2:
        log.away_r, log.away_h = rh_totals[0]
        log.home_r, log.home_h = rh_totals[1]
    else:
        # Fallback: "| RVRH | 17 | 17 | 0 |" from markdown line score table
        # or "AWAY 1 2 3 4 5 = R  H  E" format
        pass

    # Parse play log rows
    for m in PLAY_ROW_RE.finditer(md_text):
        try:
            play_num = int(m.group(1))
            inning = int(m.group(2))
        except ValueError:
            continue
        half_raw = m.group(3)
        half = "Top" if half_raw.startswith("T") else "Bottom"
        batter = m.group(4).strip()
        outcome = m.group(5).strip()
        description = m.group(6).strip()
        outs_end_s = m.group(7).strip()
        outs_end = int(outs_end_s) if outs_end_s.isdigit() else None
        runs = m.group(8).strip()
        notes = m.group(9).strip()

        # Skip the header row (batter == "Batter")
        if batter.lower() == "batter":
            continue

        log.plays.append(Play(
            play_num=play_num, inning=inning, half=half, batter=batter,
            outcome=outcome, description=description, outs_end=outs_end,
            runs=runs, notes=notes,
        ))

    return log


# ─── Pitcher appearance extraction ───────────────────────────────────────────

# Standard pitcher form: "F Lastname" (first initial + space + surname; surname may have ' or - or spaces)
# Case-SENSITIVE: require capital letter at start so we don't match lowercase leading chars (e.g. "her E Ogg")
PITCHER_IN_DESC_RE = re.compile(r'\b([A-Z]\s[A-Z][A-Za-z\'\-]+(?:\s[A-Z][A-Za-z\'\-]+)?)\s+pitching\b')
PITCHER_TRANSITION_RE = re.compile(r'\b([A-Z]\s[A-Z][A-Za-z\'\-]+(?:\s[A-Z][A-Za-z\'\-]+)?)\s+in\s+(?:for\s+pitcher|at\s+pitcher)\b')


def _normalize_pitcher(name: str) -> str:
    """Normalize pitcher name for comparison (strip team prefixes, extra spaces)."""
    name = name.strip()
    # Strip team code prefix: "GLFR_AA" → "AA", "SRVR_#11" → "#11"
    name = re.sub(r'^[A-Z]{3,5}_', '', name)
    # Collapse whitespace
    name = re.sub(r'\s+', ' ', name)
    return name


def _is_jersey_only_team(md_text: str, team_code: str) -> bool:
    """Detect if a team uses jersey numbers only (noted in game header per prompt v4.1+)."""
    header = md_text[:3000].lower()
    return ("jersey number" in header and team_code.lower() in header) or \
           bool(re.search(rf'#\d+.*\s+{re.escape(team_code)}', md_text[:500], re.IGNORECASE))

# Outcomes considered outs (in play log)
OUT_OUTCOMES = {
    "strikeout", "ground out", "fly out", "pop out", "line out", "force out",
    "sacrifice fly", "sacrifice bunt", "fielder's choice", "fielders choice",
    "double play", "triple play", "dropped 3rd strike", "runner out", "caught stealing",
}

# Outcomes considered hits
HIT_OUTCOMES = {"single", "double", "triple", "home run"}


@dataclass
class PitcherTally:
    pitcher: str
    outs: int = 0
    bf: int = 0
    h: int = 0       # hits allowed
    bb: int = 0
    hbp: int = 0
    k: int = 0
    r: int = 0       # runs allowed (approximation)


def extract_pitcher_appearances(play_log: PlayLog) -> Dict[str, Dict[str, PitcherTally]]:
    """Walk plays in order, track current pitcher per team, tally stats per pitcher.

    Returns: { team_code: { pitcher_name: PitcherTally } }

    - Top-half plays → Home team is pitching (attribute to home's pitcher)
    - Bottom-half plays → Away team is pitching (attribute to away's pitcher)
    """
    result: Dict[str, Dict[str, PitcherTally]] = {
        play_log.away_team: {},
        play_log.home_team: {},
    }

    # Track current pitcher per team
    current_pitcher: Dict[str, Optional[str]] = {
        play_log.away_team: None,
        play_log.home_team: None,
    }

    def get_tally(team: str, pitcher: str) -> PitcherTally:
        if pitcher not in result[team]:
            result[team][pitcher] = PitcherTally(pitcher=pitcher)
        return result[team][pitcher]

    for play in play_log.plays:
        # Pitching team = opposite of batting half
        pitching_team = play_log.home_team if play.half == "Top" else play_log.away_team
        if not pitching_team:
            continue

        # Check for pitcher transition in notes first
        transition = PITCHER_TRANSITION_RE.search(play.notes)
        if transition:
            new_pitcher = transition.group(1).strip()
            current_pitcher[pitching_team] = new_pitcher

        # Check for explicit pitcher name in description
        desc_match = PITCHER_IN_DESC_RE.search(play.description)
        if desc_match:
            explicit = desc_match.group(1).strip()
            # Don't overwrite if transition already set a newer pitcher
            if current_pitcher[pitching_team] is None:
                current_pitcher[pitching_team] = explicit
            # Trust the explicit mention in the description over transition
            # only if no transition happened on this play
            elif not transition:
                current_pitcher[pitching_team] = explicit

        pitcher = current_pitcher[pitching_team]
        if not pitcher:
            continue

        tally = get_tally(pitching_team, pitcher)
        tally.bf += 1

        # Count outs — each distinct out is a contribution to this pitcher's outs
        # Use outs_end if populated; otherwise infer from outcome.
        # Simpler: outs attributed = change in outs_end from previous play of same half
        # For simplicity, count by outcome type — gives approximate count
        outcome_lower = play.outcome.lower().strip()
        if any(oo in outcome_lower for oo in OUT_OUTCOMES):
            # Double play counts as 2 outs, triple play as 3
            if "triple play" in outcome_lower:
                tally.outs += 3
            elif "double play" in outcome_lower:
                tally.outs += 2
            else:
                tally.outs += 1

        if outcome_lower in HIT_OUTCOMES or outcome_lower == "home run":
            tally.h += 1

        if outcome_lower == "walk":
            tally.bb += 1

        if outcome_lower == "hit by pitch":
            tally.hbp += 1

        if "strikeout" in outcome_lower or "dropped 3rd strike" in outcome_lower:
            tally.k += 1

    return result


# ─── Batter appearance extraction ────────────────────────────────────────────

@dataclass
class BatterTally:
    batter: str
    pa: int = 0


def extract_batter_appearances(play_log: PlayLog) -> Dict[str, Dict[str, BatterTally]]:
    """Extract batter appearances per team.

    Top-half = Away batting, Bottom-half = Home batting.
    Returns: { team_code: { batter_name: BatterTally } }
    """
    result: Dict[str, Dict[str, BatterTally]] = {
        play_log.away_team: {},
        play_log.home_team: {},
    }

    for play in play_log.plays:
        batting_team = play_log.away_team if play.half == "Top" else play_log.home_team
        if not batting_team:
            continue
        # Skip "Runner Out" and similar non-PA events
        if "runner out" in play.outcome.lower() or "caught stealing" in play.outcome.lower():
            # These are base-running outs, not plate appearances; skip PA count
            continue
        batter_name = play.batter
        if batter_name not in result[batting_team]:
            result[batting_team][batter_name] = BatterTally(batter=batter_name)
        result[batting_team][batter_name].pa += 1

    return result


# ─── Cross-checks (PC1–PC5) ──────────────────────────────────────────────────

def _compute_expected_outs(innings_played: int, team_is_home: bool, home_r: int, away_r: int, last_inning_half_outs: int = 3) -> int:
    """Expected outs for a team based on innings played.

    Standard: innings × 3. Walk-off adjustment: if home team wins in final half,
    they don't bat (or don't complete the inning), reducing their batting outs.
    For PITCHING outs: opposite — home team pitches 3 outs in top of every inning,
    including the top of the final inning. Away team pitches 3 outs through the
    bottom of inning N-1, plus however many in bottom of final inning.

    For now, a simple heuristic: pitching outs = innings × 3 minus walk-off adjustments.
    """
    # Default: pitchers for BOTH teams record innings_played × 3 outs
    # Exceptions:
    # - Walk-off in bottom of final inning: away pitcher's last-inning outs reduced
    # - Home team leads after top of final inning (mercy rule): home team doesn't bat
    #   so home team's pitcher still recorded all 3 outs in top, but away pitcher
    #   has no bottom-of-inning outs to record
    return innings_played * 3


def cross_check_pitching_outs(data_json: Dict, play_log: PlayLog) -> List[Discrepancy]:
    """PC1 — Team pitching outs in JSON meet the minimum expected by innings played.

    The play log under-counts outs (misses base-running outs like caught-stealing
    during a hit, pickoffs, runners out advancing). So we flag only when JSON has
    CLEARLY FEWER outs than expected — not when JSON exceeds play log.

    Expected minimum per team: innings_played × 3 minus a walk-off allowance.
    If JSON sum is below (innings × 3) × 0.85, flag — likely missing pitcher.
    """
    discrepancies = []
    if not play_log.innings_played:
        return discrepancies

    pitching = data_json.get("pitching", [])
    innings = play_log.innings_played

    pitcher_segments = extract_pitcher_appearances(play_log)

    for team in [play_log.away_team, play_log.home_team]:
        if not team:
            continue

        json_outs = sum(int(p.get("Outs_Recorded", 0)) for p in pitching if p.get("Team") == team)
        playlog_outs = sum(t.outs for t in pitcher_segments.get(team, {}).values())

        # Expected floor: at least 85% of innings × 3 (allows walk-off / mercy early end)
        # AND at least the play-log-derived outs (since play log is a strict subset — base-running outs increase the real total)
        expected_floor = max(int(innings * 3 * 0.85), playlog_outs)

        # Only flag if JSON is CLEARLY below expected
        if json_outs < expected_floor:
            json_pitchers = {p.get("Pitcher"): int(p.get("Outs_Recorded", 0))
                             for p in pitching if p.get("Team") == team}
            playlog_pitchers = {name: t.outs for name, t in pitcher_segments.get(team, {}).items()}

            missing = [(n, o) for n, o in playlog_pitchers.items() if n not in json_pitchers]

            details_parts = [
                f"JSON sum={json_outs} (below expected floor={expected_floor} for {innings}-inning game)",
                f"JSON pitchers: {', '.join(f'{n}={o}' for n,o in json_pitchers.items())}",
                f"play log pitchers: {', '.join(f'{n}={o}' for n,o in playlog_pitchers.items())}",
            ]
            if missing:
                details_parts.append(f"missing pitcher(s): {', '.join(f'{n}={o}' for n,o in missing)}")

            discrepancies.append(Discrepancy(
                check="PC1", team=team,
                expected=f">={expected_floor}", actual=str(json_outs),
                details=" | ".join(details_parts),
            ))

    return discrepancies


def cross_check_pitching_hits_allowed(data_json: Dict, play_log: PlayLog) -> List[Discrepancy]:
    """PC2 — Sum of H_Allowed for team pitchers == opposing team's hits.

    Tolerates known-discrepancy scenarios (Section 5 flags documented in Notes).
    Only flag when the mismatch is > 1 AND not noted as a known discrepancy.
    """
    discrepancies = []
    game_log = data_json.get("game_log", {})
    pitching = data_json.get("pitching", [])

    away_h = game_log.get("Away_H")
    home_h = game_log.get("Home_H")
    if away_h is None or home_h is None:
        return discrepancies

    # Check if Notes documents a known H discrepancy
    notes = str(game_log.get("Notes", "")).lower()
    has_known_h_discrepancy = "h mismatch" in notes or "hit discrepancy" in notes or \
                              "known discrepanc" in notes or \
                              re.search(r'h\s*(?:count|total)?\s*(?:flag|discrepanc|mismatch)', notes) is not None

    for team, opposing_hits in [(play_log.away_team, home_h), (play_log.home_team, away_h)]:
        if not team:
            continue
        pitcher_rows = [p for p in pitching if p.get("Team") == team]
        if not pitcher_rows:
            continue
        sum_h = sum(int(p.get("H_Allowed", 0)) for p in pitcher_rows)
        try:
            expected = int(opposing_hits)
        except (TypeError, ValueError):
            continue
        diff = abs(sum_h - expected)
        # Tolerate ±1 always; tolerate more if notes document a known discrepancy
        threshold = 3 if has_known_h_discrepancy else 1
        if diff > threshold:
            discrepancies.append(Discrepancy(
                check="PC2", team=team,
                expected=str(expected), actual=str(sum_h),
                details=f"sum(H_Allowed)={sum_h} vs opposing team hits={expected} (diff={diff})",
            ))

    return discrepancies


def cross_check_pitcher_presence(data_json: Dict, play_log: PlayLog) -> List[Discrepancy]:
    """PC3 — Every pitcher named in play log must appear in Pitching rows.

    Uses normalized name comparison (strips team code prefixes like "GLFR_AA" → "AA").
    Skips teams that use jersey numbers only (flagged in game header).
    """
    discrepancies = []
    pitching = data_json.get("pitching", [])
    pitcher_segments = extract_pitcher_appearances(play_log)

    for team in [play_log.away_team, play_log.home_team]:
        if not team:
            continue

        # Skip jersey-only teams — their pitcher "names" are unreliable
        if _is_jersey_only_team(play_log.raw_md, team):
            continue

        json_names = {_normalize_pitcher(str(p.get("Pitcher") or "")) for p in pitching if p.get("Team") == team}
        json_names.discard("")
        playlog_names_raw = set(pitcher_segments.get(team, {}).keys())
        playlog_names = {_normalize_pitcher(n) for n in playlog_names_raw}

        missing = playlog_names - json_names
        if missing:
            # Map back to raw names for reporting, and require meaningful activity
            real_missing = []
            for norm in missing:
                for raw, tally in pitcher_segments[team].items():
                    if _normalize_pitcher(raw) == norm and (tally.outs > 0 or tally.bf > 2):
                        real_missing.append(raw)
                        break

            if real_missing:
                discrepancies.append(Discrepancy(
                    check="PC3", team=team,
                    expected=str(sorted(playlog_names)), actual=str(sorted(json_names)),
                    details=f"pitcher(s) in play log but not in Pitching rows: {', '.join(sorted(real_missing))}",
                ))

    return discrepancies


def cross_check_batter_presence(data_json: Dict, play_log: PlayLog) -> List[Discrepancy]:
    """PC4 — Every batter in Batter column must appear in Batting rows.

    Uses normalized name comparison. Skips jersey-only teams. Requires the
    name to look like a real name (capital letter + space + capitalized word).
    """
    discrepancies = []
    batting = data_json.get("batting", [])
    batter_appearances = extract_batter_appearances(play_log)

    # Proper-name filter: "F Lastname" shape
    name_re = re.compile(r'^[A-Z]\s[A-Z][A-Za-z\'\-]')

    for team in [play_log.away_team, play_log.home_team]:
        if not team:
            continue

        if _is_jersey_only_team(play_log.raw_md, team):
            continue

        json_names = {_normalize_pitcher(str(b.get("Player") or "")) for b in batting if b.get("Team") == team}
        json_names.discard("")
        playlog_raw = set(batter_appearances.get(team, {}).keys())
        # Only check names that look like proper names
        playlog_names = {_normalize_pitcher(n) for n in playlog_raw if name_re.match(n)}

        missing = playlog_names - json_names
        if missing:
            real_missing = []
            for norm in missing:
                for raw, tally in batter_appearances[team].items():
                    if _normalize_pitcher(raw) == norm and tally.pa > 0:
                        real_missing.append(raw)
                        break
            if real_missing:
                discrepancies.append(Discrepancy(
                    check="PC4", team=team,
                    expected=str(sorted(playlog_names)), actual=str(sorted(json_names)),
                    details=f"batter(s) in play log but not in Batting rows: {', '.join(sorted(real_missing))}",
                ))

    return discrepancies


def cross_check_batting_pa(data_json: Dict, play_log: PlayLog) -> List[Discrepancy]:
    """PC5 — Sum of team PAs in JSON vs batter appearances in play log.

    Parser may under- or over-count (courtesy runners, substitutions,
    "Runner Out" vs base-running outs). Only flag when JSON is clearly below
    the expected minimum — a signal of dropped batter rows.

    Expected minimum: innings_played × 3 per team (three outs per inning means
    at least 3 batters per inning, with more when runners reach base).
    """
    discrepancies = []
    batting = data_json.get("batting", [])
    if not play_log.innings_played:
        return discrepancies

    innings = play_log.innings_played
    batter_appearances = extract_batter_appearances(play_log)

    for team in [play_log.away_team, play_log.home_team]:
        if not team:
            continue
        json_pa = sum(int(b.get("PA", 0)) for b in batting if b.get("Team") == team)
        playlog_pa = sum(t.pa for t in batter_appearances.get(team, {}).values())
        if playlog_pa == 0:
            continue
        # Clearly-below threshold: JSON PA < 75% of play log count AND less than (innings × 2.5)
        # (allows for legitimate edge cases while still catching large drops)
        min_expected = max(int(playlog_pa * 0.75), int(innings * 2.5))
        if json_pa < min_expected:
            discrepancies.append(Discrepancy(
                check="PC5", team=team,
                expected=f">={min_expected}", actual=str(json_pa),
                details=f"sum(PA) in Batting rows below expected; play log shows {playlog_pa} batter appearances for {innings}-inning game",
            ))

    return discrepancies


# ─── Orchestrator ────────────────────────────────────────────────────────────

def run_all_checks(data_json: Dict, play_log: PlayLog) -> ValidationReport:
    """Run all cross-checks and return a report."""
    discrepancies = []
    discrepancies.extend(cross_check_pitching_outs(data_json, play_log))
    discrepancies.extend(cross_check_pitching_hits_allowed(data_json, play_log))
    discrepancies.extend(cross_check_pitcher_presence(data_json, play_log))
    discrepancies.extend(cross_check_batter_presence(data_json, play_log))
    discrepancies.extend(cross_check_batting_pa(data_json, play_log))

    ok = len(discrepancies) == 0
    if ok:
        summary = "All cross-checks passed."
    else:
        summary = f"{len(discrepancies)} cross-check discrepanc{'y' if len(discrepancies)==1 else 'ies'} found."

    return ValidationReport(ok=ok, discrepancies=discrepancies, summary=summary)
