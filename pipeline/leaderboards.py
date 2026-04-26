"""
leaderboards.py

Top-10 leaderboards across the entire RiverHill Hawks database, plus a
top-5 cross-reference of players appearing in the most leaderboards.

Hitting:  AVG, OPS, Total Hits, Quality At-Bats (QAB)
Pitching: ERA, WHIP, Total IP, First-Pitch Strike %, K/BB

QAB definition: a PA counts if it's a hit / walk / HBP / sac OR went
6+ pitches. Per-PA flagged (no double-counting).

Data sources:
    public/repository.json — counting stats (AVG / OPS / ERA / WHIP / IP / K/BB)
    games/*.md             — pitch sequences (FPS%, QAB long-PA detection)

Pitcher attribution per PA uses a queue-based heuristic: pitchers in
repository.json row order, decremented by inning outs from Section 3,
with mid-inning subs detected from "X pitching" mentions in play
descriptions.

Usage:
    python pipeline/leaderboards.py                 # defaults: PA > 35, IP > 14
    python pipeline/leaderboards.py --pa 40 --ip 18 # tighter thresholds
    python pipeline/leaderboards.py --pa 20 --ip 8  # looser thresholds
"""

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = REPO_ROOT / "public" / "repository.json"
GAMES_DIR = REPO_ROOT / "games"

_parser = argparse.ArgumentParser(description=__doc__.strip().split("\n")[0])
_parser.add_argument("--pa", type=int, default=35, help="Hitter min PA threshold (strictly greater than). Default 35.")
_parser.add_argument("--ip", type=float, default=14, help="Pitcher min IP threshold (strictly greater than). Default 14.")
_parser.add_argument("--markdown", action="store_true", help="Emit GitHub-flavored markdown instead of plain text tables.")
_args = _parser.parse_args()

PA_THRESHOLD   = _args.pa
OUTS_THRESHOLD = int(_args.ip * 3)
MARKDOWN       = _args.markdown

# ─── Load repository ──────────────────────────────────────────────────────────

data = json.load(open(JSON_PATH))
teams_lookup = data.get("teams", {})

def disp(code):
    return teams_lookup.get(code, code)

# ─── Aggregate batting per (team, player) ────────────────────────────────────

batters = defaultdict(lambda: {
    "PA": 0, "AB": 0, "H": 0, "1B": 0, "2B": 0, "3B": 0, "HR": 0,
    "BB": 0, "HBP": 0, "K": 0, "R": 0, "RBI": 0, "SB": 0, "CS": 0,
    "SAC": 0, "GDP": 0,
    "long_PA": 0,    # 6+ pitch PAs (filled later)
    "qab": 0,        # PA-level QAB (positive outcome OR 6+ pitches)
    "G": set(),
})

POSITIVE_OUTCOMES = {
    "single", "double", "triple", "home run",
    "walk", "hit by pitch",
    "sacrifice", "sacrifice fly",
}

def n(x):
    try:
        return int(x or 0)
    except (TypeError, ValueError):
        try:
            return int(float(x))
        except (TypeError, ValueError):
            return 0

for r in data["batting"]:
    team = r.get("Team")
    player = r.get("Player")
    if not team or not player:
        continue
    key = (team, player)
    b = batters[key]
    for f in ("PA","AB","H","1B","2B","3B","HR","BB","HBP","K","R","RBI","SB","CS","SAC","GDP"):
        b[f] += n(r.get(f))
    b["G"].add(r.get("Game_ID"))

# ─── Aggregate pitching per (team, pitcher) ──────────────────────────────────

pitchers = defaultdict(lambda: {
    "Outs": 0, "BF": 0, "H": 0, "BB": 0, "HBP": 0, "K": 0, "R": 0, "HR": 0,
    "G": set(),
    "FP_strike": 0, "FP_total": 0,  # first-pitch counters
})

for r in data["pitching"]:
    team = r.get("Team")
    p = r.get("Pitcher")
    if not team or not p:
        continue
    key = (team, p)
    pp = pitchers[key]
    pp["Outs"] += n(r.get("Outs_Recorded"))
    pp["BF"]   += n(r.get("BF"))
    pp["H"]    += n(r.get("H_Allowed"))
    pp["BB"]   += n(r.get("BB_Allowed"))
    pp["HBP"]  += n(r.get("HBP_Allowed"))
    pp["K"]    += n(r.get("K"))
    pp["R"]    += n(r.get("R_Allowed"))
    pp["HR"]   += n(r.get("HR_Allowed"))
    pp["G"].add(r.get("Game_ID"))

# ─── Parse markdowns for FPS% (pitchers) and long_PA (batters) ───────────────

# Build per-game pitcher order per team from the pitching rows in repository.json,
# in the order they appear in the data file (insertion order = mound order).
pitchers_by_game_team = defaultdict(list)  # (game_id, team) → [pitcher_name, ...]
pitcher_outs_by_game = defaultdict(dict)   # (game_id, team)[pitcher] = outs_recorded
for r in data["pitching"]:
    gid = r.get("Game_ID"); team = r.get("Team"); p = r.get("Pitcher")
    if not (gid and team and p):
        continue
    if p not in pitcher_outs_by_game[(gid, team)]:
        pitchers_by_game_team[(gid, team)].append(p)
    pitcher_outs_by_game[(gid, team)][p] = pitcher_outs_by_game[(gid, team)].get(p, 0) + n(r.get("Outs_Recorded"))

# Game_Log lookup for away/home codes
game_meta = {}
for g in data["gameLog"]:
    gid = g.get("Game_ID")
    if gid:
        game_meta[gid] = {"away": g.get("Away_Team"), "home": g.get("Home_Team")}


# Markdown parsing helpers
SEC3_HEAD = "## Structured Play Log"
SEC4_HEAD = "## Pitch Sequences"

PITCHER_NAME_RE = re.compile(r"\b([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)+)\s+pitching\b")
PITCHING_NO_NAME = re.compile(r"\bpitching\b")


def parse_md(md_text):
    """Return (section3_rows, section4_rows). Each row is a dict for the PA #."""
    # Find sections
    def _table_after(heading):
        idx = md_text.find(heading)
        if idx < 0:
            return []
        # Locate first table line after heading
        rest = md_text[idx + len(heading):]
        rows = []
        for line in rest.split("\n"):
            s = line.strip()
            if not s or not s.startswith("|"):
                # Stop at next section
                if rows and (s.startswith("##") or s.startswith("---")):
                    break
                # Skip non-table lines until table starts
                if not rows:
                    continue
                if s.startswith("##") or s.startswith("---"):
                    break
                continue
            # parse cells
            cells = [c.strip() for c in s.strip("|").split("|")]
            rows.append(cells)
        # First two rows are header + separator
        if len(rows) >= 2:
            header = rows[0]
            data_rows = rows[2:]
            return header, data_rows
        return [], []
    s3_h, s3_d = _table_after(SEC3_HEAD)
    s4_h, s4_d = _table_after(SEC4_HEAD)
    return (s3_h, s3_d), (s4_h, s4_d)


def section3_to_pa(s3):
    header, rows = s3
    if not header:
        return []
    # Map columns
    idx = {c.lower(): i for i, c in enumerate(header)}
    out = []
    for r in rows:
        if not r or not r[0].isdigit():
            continue
        try:
            pa = int(r[0])
        except ValueError:
            continue
        def get(name):
            i = idx.get(name)
            return r[i] if i is not None and i < len(r) else ""
        half = get("half") or ""
        outs_end = get("outs (end of play)") or ""
        desc = get("description") or ""
        out.append({
            "pa": pa,
            "half": half.strip().lower(),    # "top" or "bottom"
            "outs_end": outs_end.strip(),
            "desc": desc,
        })
    return out


def section4_to_pa(s4):
    header, rows = s4
    if not header:
        return {}
    idx = {c.lower(): i for i, c in enumerate(header)}
    pa_idx = idx.get("#") or 0
    seq_idx = idx.get("pitch sequence")
    out = {}
    for r in rows:
        if not r or not r[0].isdigit():
            continue
        try:
            pa = int(r[0])
        except ValueError:
            continue
        seq = r[seq_idx] if seq_idx is not None and seq_idx < len(r) else ""
        out[pa] = seq
    return out


def first_pitch_token(seq):
    """Return 'strike' / 'ball' / None for the first non-bracketed pitch."""
    if not seq or "[No pitch sequence recorded]" in seq:
        return None
    # Tokenize on commas, strip
    for tok in [t.strip() for t in seq.split(",")]:
        if not tok:
            continue
        if tok.startswith("[") and tok.endswith("]"):
            continue
        # Non-bracketed token
        low = tok.lower()
        if low.startswith("strike") or low.startswith("foul") or low.startswith("in play"):
            return "strike"
        if low.startswith("ball"):
            return "ball"
        return None
    return None


def pitch_count(seq):
    """Count non-bracketed pitch tokens in a sequence."""
    if not seq or "[No pitch sequence recorded]" in seq:
        return 0
    n = 0
    for tok in [t.strip() for t in seq.split(",")]:
        if not tok:
            continue
        if tok.startswith("[") and tok.endswith("]"):
            continue
        n += 1
    return n


def assign_pitcher_per_pa(game_id, pa_rows, s4_seqs):
    """
    For each PA in pa_rows, assign a pitcher.

    Strategy:
      - Determine pitching team per PA (Top→home, Bottom→away)
      - Use pitchers_by_game_team[(gid, team)] in order
      - For each new PA, current pitcher = front of queue.
      - When the pitcher's remaining outs reach 0, advance to the next.
      - Outs delta per PA computed from outs_end across half-inning resets.
      - If description contains "<Name> pitching" and the matched name is in the
        pitching team's roster, jump to that pitcher (handles non-trivial subs).
    Returns list of (pa_num, pitcher_or_none) parallel to pa_rows.
    """
    meta = game_meta.get(game_id)
    if not meta:
        return [None] * len(pa_rows)

    away, home = meta["away"], meta["home"]
    pitchers_per_team = {
        away: list(pitchers_by_game_team.get((game_id, away), [])),
        home: list(pitchers_by_game_team.get((game_id, home), [])),
    }
    outs_budget = {
        away: dict(pitcher_outs_by_game.get((game_id, away), {})),
        home: dict(pitcher_outs_by_game.get((game_id, home), {})),
    }
    queue = {team: list(pitchers_per_team[team]) for team in (away, home)}

    # Track current pitcher per team (front of queue)
    def current(team):
        while queue[team] and outs_budget[team].get(queue[team][0], 0) <= 0:
            queue[team].pop(0)
        return queue[team][0] if queue[team] else None

    # Outs delta tracker per (inning, half)
    last_outs_in_half = {}

    assigned = []
    for row in pa_rows:
        half = row["half"]
        pitching_team = home if half == "top" else (away if half == "bottom" else None)
        if not pitching_team:
            assigned.append(None)
            continue

        # Mid-inning pitcher sub detection
        m = PITCHER_NAME_RE.search(row["desc"])
        if m:
            name = m.group(1)
            # Is this pitcher in the pitching team's roster?
            if name in pitchers_per_team[pitching_team]:
                # Jump queue to this pitcher
                while queue[pitching_team] and queue[pitching_team][0] != name:
                    # The skipped pitcher is presumed done
                    skipped = queue[pitching_team].pop(0)
                    outs_budget[pitching_team][skipped] = 0

        pitcher = current(pitching_team)
        assigned.append(pitcher)

        # Compute outs delta and decrement budget
        try:
            outs_end_val = int(row["outs_end"])
        except (TypeError, ValueError):
            outs_end_val = None
        key = (row.get("inning"), half)  # half-inning key (we don't track inning explicitly)
        # Approximation: if outs_end is set and > last, delta = diff
        # Resetting on half changes is implicit because top/bottom alternate
        prev = last_outs_in_half.get(half, 0)
        delta = 0
        if outs_end_val is not None:
            if outs_end_val < prev:
                # Half-inning reset
                delta = outs_end_val
            else:
                delta = outs_end_val - prev
            last_outs_in_half[half] = outs_end_val
        if delta < 0:
            delta = 0
        if pitcher and delta:
            outs_budget[pitching_team][pitcher] = max(0, outs_budget[pitching_team].get(pitcher, 0) - delta)

    return assigned


# ─── Walk every markdown ─────────────────────────────────────────────────────

games_processed = 0
games_skipped = 0

for md_path in sorted(GAMES_DIR.glob("*.md")):
    if md_path.stem.startswith("UNKNOWN_"):
        continue
    game_id = md_path.stem
    if game_id not in game_meta:
        games_skipped += 1
        continue
    text = md_path.read_text(encoding="utf-8")
    s3, s4 = parse_md(text)
    pa_rows = section3_to_pa(s3)
    seqs = section4_to_pa(s4)
    if not pa_rows:
        games_skipped += 1
        continue

    meta = game_meta[game_id]
    away, home = meta["away"], meta["home"]

    pitcher_assigned = assign_pitcher_per_pa(game_id, pa_rows, seqs)

    for row, pitcher_name in zip(pa_rows, pitcher_assigned):
        pa = row["pa"]
        half = row["half"]
        seq = seqs.get(pa, "")
        n_pitches = pitch_count(seq)

        # Batter attribution: batting team is opposite of pitching team
        batting_team = away if half == "top" else (home if half == "bottom" else None)
        batter = ""
        # Section 3 batter is in the row; look up by re-reading the cell
        # The parser already stripped to dict; re-add if needed
        # We didn't capture batter in pa_rows — refactor: just look at desc isn't ideal
        # Instead we'll attribute long_PA to (batting_team, batter) via a post-pass

        # First-pitch contribution to pitcher
        if pitcher_name:
            ft = first_pitch_token(seq)
            pitching_team = home if half == "top" else away
            key = (pitching_team, pitcher_name)
            if key in pitchers and ft is not None:
                pitchers[key]["FP_total"] += 1
                if ft == "strike":
                    pitchers[key]["FP_strike"] += 1

    games_processed += 1

# Need to re-extract the batter from Section 3 to attribute long_PA. Re-walk.
for md_path in sorted(GAMES_DIR.glob("*.md")):
    if md_path.stem.startswith("UNKNOWN_"):
        continue
    game_id = md_path.stem
    if game_id not in game_meta:
        continue
    text = md_path.read_text(encoding="utf-8")
    s3, s4 = parse_md(text)
    seqs = section4_to_pa(s4)

    # Rebuild s3 with batter + outcome
    header, rows = s3
    if not header:
        continue
    idx = {c.lower(): i for i, c in enumerate(header)}
    pa_idx = idx.get("#")
    half_idx = idx.get("half")
    batter_idx = idx.get("batter")
    outcome_idx = idx.get("outcome")

    meta = game_meta[game_id]
    away, home = meta["away"], meta["home"]

    for r in rows:
        if not r or pa_idx is None or pa_idx >= len(r) or not r[pa_idx].isdigit():
            continue
        pa = int(r[pa_idx])
        half = r[half_idx].strip().lower() if half_idx is not None and half_idx < len(r) else ""
        batter = r[batter_idx].strip() if batter_idx is not None and batter_idx < len(r) else ""
        outcome = r[outcome_idx].strip().lower() if outcome_idx is not None and outcome_idx < len(r) else ""
        if not batter or batter.lower().startswith("[unnamed"):
            continue
        batting_team = away if half == "top" else (home if half == "bottom" else None)
        if not batting_team:
            continue
        seq = seqs.get(pa, "")
        npc = pitch_count(seq)
        is_long = npc >= 6
        is_pos = outcome in POSITIVE_OUTCOMES
        key = (batting_team, batter)
        if key not in batters:
            continue
        if is_long:
            batters[key]["long_PA"] += 1
        if is_pos or is_long:
            batters[key]["qab"] += 1


# ─── Build leaderboards ──────────────────────────────────────────────────────

def avg(b):
    return b["H"] / b["AB"] if b["AB"] else 0.0

def obp(b):
    den = b["AB"] + b["BB"] + b["HBP"] + b["SAC"]
    num = b["H"] + b["BB"] + b["HBP"]
    return num / den if den else 0.0

def slg(b):
    if not b["AB"]:
        return 0.0
    tb = b["1B"] + 2*b["2B"] + 3*b["3B"] + 4*b["HR"]
    return tb / b["AB"]

def ops(b):
    return obp(b) + slg(b)

def qab(b):
    # PA-level: positive outcome OR 6+ pitches. Tracked at PA-time during md walk.
    return b["qab"]

def era(p):
    ip = p["Outs"] / 3
    return p["R"] * 9 / ip if ip else 0.0

def whip(p):
    ip = p["Outs"] / 3
    return (p["H"] + p["BB"]) / ip if ip else 0.0

def ip_(p):
    return p["Outs"] / 3

def k_per_bb(p):
    return p["K"] / p["BB"] if p["BB"] else float("inf")

def fps(p):
    return p["FP_strike"] / p["FP_total"] if p["FP_total"] else 0.0


# Hitters above PA threshold
qual_b = [(team, name, b) for (team, name), b in batters.items() if b["PA"] > PA_THRESHOLD]
# Pitchers above outs threshold
qual_p = [(team, name, p) for (team, name), p in pitchers.items() if p["Outs"] > OUTS_THRESHOLD]


def top10(qualified, key, reverse=True, fmt=lambda v: f"{v}"):
    sorted_list = sorted(qualified, key=lambda t: key(t[2]), reverse=reverse)
    return sorted_list[:10]


def fmt_avg(v): return f"{v:.3f}".lstrip("0") if 0 < v < 1 else f"{v:.3f}"


if not MARKDOWN:
    print(f"Games processed: {games_processed}, skipped: {games_skipped}")
_IP_LABEL = f"{OUTS_THRESHOLD // 3}.{OUTS_THRESHOLD % 3}" if OUTS_THRESHOLD % 3 else f"{OUTS_THRESHOLD // 3}"
_PA_TAG = f"PA > {PA_THRESHOLD}"
_IP_TAG = f"IP > {_IP_LABEL}"

if MARKDOWN:
    from datetime import datetime, timezone
    print("# Top-10 Leaderboards")
    print()
    print(f"_Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}_  ")
    print(f"_Thresholds: hitters {_PA_TAG} \u00b7 pitchers {_IP_TAG}_  ")
    print(f"_Hitters qualified: {len(qual_b)} \u00b7 pitchers qualified: {len(qual_p)} \u00b7 games processed: {games_processed}_")
else:
    print(f"Hitters with {_PA_TAG}: {len(qual_b)}")
    print(f"Pitchers with {_IP_TAG} (Outs > {OUTS_THRESHOLD}): {len(qual_p)}")
    print()


def print_table(title, rows, columns):
    if MARKDOWN:
        print()
        print(f"### {title}")
        print()
        print("| " + " | ".join(columns) + " |")
        print("|" + "|".join("---" for _ in columns) + "|")
        for r in rows:
            print("| " + " | ".join(str(c) for c in r) + " |")
        return
    print(f"\n=== {title} ===")
    widths = [max(len(str(c)), max((len(str(r[i])) for r in rows), default=0)) for i, c in enumerate(columns)]
    print("  ".join(c.ljust(w) for c, w in zip(columns, widths)))
    for r in rows:
        print("  ".join(str(c).ljust(w) for c, w in zip(r, widths)))


# ── Hitting leaderboards ─────────────────────────────────────────────────────

# AVG
rows = []
for team, name, b in top10(qual_b, lambda x: avg(x)):
    rows.append([name, disp(team), b["G"].__len__(), b["PA"], b["AB"], b["H"], fmt_avg(avg(b))])
print_table(f"HITTING — Top 10 AVG ({_PA_TAG})", rows, ["Player","Team","G","PA","AB","H","AVG"])

# OPS
rows = []
for team, name, b in top10(qual_b, lambda x: ops(x)):
    rows.append([name, disp(team), b["G"].__len__(), b["PA"], fmt_avg(obp(b)), fmt_avg(slg(b)), fmt_avg(ops(b))])
print_table(f"HITTING — Top 10 OPS ({_PA_TAG})", rows, ["Player","Team","G","PA","OBP","SLG","OPS"])

# Total Hits (no threshold)
rows = []
all_b = sorted(batters.items(), key=lambda kv: kv[1]["H"], reverse=True)[:10]
for (team, name), b in all_b:
    rows.append([name, disp(team), b["G"].__len__(), b["PA"], b["AB"], b["H"], fmt_avg(avg(b))])
print_table("HITTING — Top 10 Total Hits (no threshold)", rows, ["Player","Team","G","PA","AB","H","AVG"])

# QAB
rows = []
for team, name, b in top10(qual_b, lambda x: qab(x)):
    qab_pct = (qab(b) / b["PA"]) if b["PA"] else 0
    rows.append([name, disp(team), b["PA"], b["long_PA"], qab(b), f"{qab_pct*100:.1f}%"])
print_table(f"HITTING — Top 10 Quality At-Bats ({_PA_TAG})", rows,
            ["Player","Team","PA","6+pitch PAs","QAB","QAB%"])

# ── Pitching leaderboards ────────────────────────────────────────────────────

def fmt_ip(o):
    return f"{o // 3}.{o % 3}"

# ERA — lower is better
rows = []
for team, name, p in top10(qual_p, lambda x: era(x), reverse=False):
    rows.append([name, disp(team), p["G"].__len__(), fmt_ip(p["Outs"]), p["BF"], p["R"], f"{era(p):.2f}"])
print_table(f"PITCHING — Top 10 ERA ({_IP_TAG}, lower better)", rows, ["Pitcher","Team","G","IP","BF","R","ERA"])

# WHIP — lower
rows = []
for team, name, p in top10(qual_p, lambda x: whip(x), reverse=False):
    rows.append([name, disp(team), p["G"].__len__(), fmt_ip(p["Outs"]), p["H"], p["BB"], f"{whip(p):.2f}"])
print_table(f"PITCHING — Top 10 WHIP ({_IP_TAG}, lower better)", rows, ["Pitcher","Team","G","IP","H","BB","WHIP"])

# Total IP — no threshold
rows = []
all_p = sorted(pitchers.items(), key=lambda kv: kv[1]["Outs"], reverse=True)[:10]
for (team, name), p in all_p:
    rows.append([name, disp(team), p["G"].__len__(), fmt_ip(p["Outs"]), p["BF"], p["K"], f"{era(p):.2f}"])
print_table("PITCHING — Top 10 Total IP (no threshold)", rows, ["Pitcher","Team","G","IP","BF","K","ERA"])

# FPS%
rows = []
fps_qual = [t for t in qual_p if t[2]["FP_total"] >= 30]
for team, name, p in top10(fps_qual, lambda x: fps(x)):
    rows.append([name, disp(team), fmt_ip(p["Outs"]), p["FP_total"], p["FP_strike"], f"{fps(p)*100:.1f}%"])
print_table(f"PITCHING — Top 10 First-Pitch Strike % ({_IP_TAG}, FP_total ≥ 30)", rows,
            ["Pitcher","Team","IP","First Pitches","FP Strikes","FPS%"])

# K/BB
rows = []
def kbb_safe(p):
    return p["K"] / p["BB"] if p["BB"] else 999.0
for team, name, p in top10(qual_p, kbb_safe):
    val = f"{p['K']/p['BB']:.2f}" if p["BB"] else f"{p['K']}/0 (∞)"
    rows.append([name, disp(team), fmt_ip(p["Outs"]), p["K"], p["BB"], val])
print_table(f"PITCHING — Top 10 K/BB ({_IP_TAG})", rows, ["Pitcher","Team","IP","K","BB","K/BB"])


# ── Cross-reference: Top 5 most-frequently-appearing in the other top 10s ───

def collect(rows, key_idx=(0, 1)):
    return [tuple(r[i] for i in key_idx) for r in rows]


# Re-run the four hitting top-10s and collect (Player, Team) keys
def top_keys(qualified_or_all, key_fn, reverse=True, n=10, threshold=True):
    pool = qual_b if threshold else list((t, name, b) for (t, name), b in batters.items())
    sorted_list = sorted(pool, key=lambda t: key_fn(t[2]), reverse=reverse)
    return [(t[1], disp(t[0])) for t in sorted_list[:n]]


h_top10s = {
    "AVG": top_keys(None, lambda b: avg(b)),
    "OPS": top_keys(None, lambda b: ops(b)),
    "Hits": [(name, disp(team)) for (team, name), b in
             sorted(batters.items(), key=lambda kv: kv[1]["H"], reverse=True)[:10]],
    "QAB": top_keys(None, lambda b: qab(b)),
}

# Pitching versions
def top_keys_p(key_fn, reverse=True, n=10, fps_filter=False):
    pool = [t for t in qual_p if (t[2]["FP_total"] >= 30 if fps_filter else True)]
    sorted_list = sorted(pool, key=lambda t: key_fn(t[2]), reverse=reverse)
    return [(t[1], disp(t[0])) for t in sorted_list[:n]]

p_top10s = {
    "ERA": top_keys_p(lambda p: era(p), reverse=False),
    "WHIP": top_keys_p(lambda p: whip(p), reverse=False),
    "IP": [(name, disp(team)) for (team, name), p in
           sorted(pitchers.items(), key=lambda kv: kv[1]["Outs"], reverse=True)[:10]],
    "FPS%": top_keys_p(lambda p: fps(p), reverse=True, fps_filter=True),
    "K/BB": top_keys_p(lambda p: kbb_safe(p), reverse=True),
}


def cross_ref(top10s, label):
    counts = defaultdict(lambda: {"count": 0, "lists": []})
    for cat, players in top10s.items():
        for player_team in players:
            counts[player_team]["count"] += 1
            counts[player_team]["lists"].append(cat)
    ranked = sorted(counts.items(), key=lambda kv: -kv[1]["count"])[:5]
    rows = []
    for i, ((player, team), info) in enumerate(ranked, 1):
        rows.append([i, player, team, info["count"], ", ".join(info["lists"])])
    print_table(f"{label} \u2014 TOP 5 most frequently in top-10s", rows,
                ["Rank","Player","Team","# Lists","Lists"])


cross_ref(h_top10s, "HITTERS")
cross_ref(p_top10s, "PITCHERS")
