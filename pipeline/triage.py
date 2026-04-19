#!/usr/bin/env python3
"""Triage audit failures into action buckets A–H.

Read-only: never modifies Excel or markdown. Consumes validate.py's audit
results and produces a prioritized work order.

Buckets:
  A — Focal team missing specific pitcher (PC3 focal failure)
  B — Focal team missing specific batter (PC4 focal failure)
  C — Focal hit mismatch, fully documented in Section 5
  D — Focal hit mismatch, partially documented in Section 5
  E — Focal hit mismatch, unexplained (no Section 5 flag)
  F — Non-focal missing pitcher or batter (PC3/PC4 non-focal)
  G — Mixed / multiple failure types requiring individual review
  H — PC5 artifact only (known parser limitation, no action)

Each failing game is assigned exactly one bucket. Classification priority:
  1. If multiple focal issue types — G
  2. Single focal issue type — A, B, or PC2 → C/D/E based on Section 5
  3. Non-focal only — F
  4. PC5 only — H
  5. Otherwise — G

Usage:
  python pipeline/triage.py                  # full triage
  python pipeline/triage.py --bucket A,B     # filter to buckets
  python pipeline/triage.py --game-id GID    # single game
  python pipeline/triage.py --json           # machine-readable
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate import audit_game

REPO_ROOT = Path(__file__).resolve().parent.parent
GAMES_DIR = REPO_ROOT / "games"

FOCAL_TEAMS = {'RVRH', 'CNTN', 'GLNL', 'HNTN', 'PRKS', 'STHR', 'FLLS',
               'MDLT', 'HRFD', 'NHRF', 'CNTY', 'KTIS', 'LNRC'}

BUCKET_NAMES = {
    'A': 'Focal missing pitcher',
    'B': 'Focal missing batter',
    'C': 'Focal hit mismatch (documented)',
    'D': 'Focal hit mismatch (partial)',
    'E': 'Focal hit mismatch (unexplained)',
    'F': 'Non-focal missing pitcher/batter',
    'G': 'Mixed / review',
    'H': 'PC5 artifact only',
}


# ─── Section 5 parsing ───────────────────────────────────────────────────────

def parse_section5_h_discrepancy(md_text: str, team: str) -> dict:
    """Parse the Data Integrity Flags section for documented H (hit) discrepancies.

    Returns dict with:
      has_flag: True if any H-related flag mentions a discrepancy
      documented_gap: int — size of explicitly-documented gap (0 if not quantified)
      description: str — short summary for display
    """
    m = re.search(
        r'##\s*Data\s+Integrity\s+Flags(.+?)(?=##|\Z)',
        md_text, re.DOTALL | re.IGNORECASE,
    )
    if not m:
        return {'has_flag': False, 'documented_gap': 0, 'description': ''}
    section5 = m.group(1)

    # Pattern 0: "TEAM=X (conflicts with reported Y)" — common format in Mandatory Verification section
    p0 = re.search(
        rf'{re.escape(team)}\s*=\s*(\d+)\s*\(conflicts?\s+with\s+reported\s+(\d+)\)',
        section5, re.IGNORECASE,
    )
    if p0:
        a, b = int(p0.group(1)), int(p0.group(2))
        return {
            'has_flag': True,
            'documented_gap': abs(a - b),
            'description': f'{team}={a} conflicts with reported {b}',
        }

    # Pattern 1: "play-by-play shows X hits vs reported Y" (or "vs. reported Y")
    p1 = re.search(
        r'play[-\s]by[-\s]play\s+shows?\s+(\d+)\s+(?:hit|hits).*?(?:vs\.?|versus|reported)\s*(?:reported\s+)?(\d+)',
        section5, re.IGNORECASE | re.DOTALL,
    )
    if p1:
        a, b = int(p1.group(1)), int(p1.group(2))
        return {
            'has_flag': True,
            'documented_gap': abs(a - b),
            'description': f'play-by-play {a} vs reported {b}',
        }

    # Pattern 2: "Known hit total discrepancy: X vs Y"
    p2 = re.search(
        r'known\s+hit\s+total\s+discrepancy[:\s]*(\d+)\s+(?:vs\.?|versus)\s+(\d+)',
        section5, re.IGNORECASE,
    )
    if p2:
        a, b = int(p2.group(1)), int(p2.group(2))
        return {
            'has_flag': True,
            'documented_gap': abs(a - b),
            'description': f'known hit total discrepancy {a} vs {b}',
        }

    # Pattern 3: "reported X ... play-by-play Y" sequence
    p3 = re.search(
        r'reported[:\s]+(\d+)[^0-9]{1,200}?(?:play-by-play|derived|counted)[^0-9]{1,50}(\d+)',
        section5, re.IGNORECASE | re.DOTALL,
    )
    if p3:
        a, b = int(p3.group(1)), int(p3.group(2))
        return {
            'has_flag': True,
            'documented_gap': abs(a - b),
            'description': f'reported {a} vs derived {b}',
        }

    # Pattern 4: team-specific hit mention
    p4 = re.search(
        rf'{re.escape(team)}\s+(?:hit|hits|H)\s+(?:count|total)?.*?(\d+).+?(?:vs\.?|versus)\s*(\d+)',
        section5, re.IGNORECASE | re.DOTALL,
    )
    if p4:
        a, b = int(p4.group(1)), int(p4.group(2))
        return {
            'has_flag': True,
            'documented_gap': abs(a - b),
            'description': f'{team} hit flag {a} vs {b}',
        }

    # Pattern 5: generic "hit discrepancy" language without specific numbers
    if re.search(r'(?:hit|H)\s+(?:count|total)?\s*(?:discrepanc|mismatch|flag)',
                 section5, re.IGNORECASE):
        return {
            'has_flag': True,
            'documented_gap': 0,
            'description': 'hit discrepancy flagged (gap not quantified)',
        }

    return {'has_flag': False, 'documented_gap': 0, 'description': ''}


# ─── Classification ──────────────────────────────────────────────────────────

def classify(audit_result: dict) -> dict:
    """Assign one bucket to a failing audit result. Returns {bucket, details, discrepancies}."""
    gid = audit_result['game_id']
    discrepancies = audit_result.get('discrepancies', [])

    focal_pc3 = []  # focal missing pitcher
    focal_pc4 = []  # focal missing batter
    focal_pc2 = []  # focal hit mismatch
    focal_pc1_zero = []  # focal team has zero pitching
    nonfocal_presence = []  # non-focal PC3/PC4
    nonfocal_other = []  # non-focal PC1/PC2/PC5
    pc5_count = 0

    for d in discrepancies:
        team = d['team']
        is_focal = team in FOCAL_TEAMS
        check = d['check']
        if check == 'PC5':
            pc5_count += 1
            continue
        if check == 'PC3':
            (focal_pc3 if is_focal else nonfocal_presence).append(d)
        elif check == 'PC4':
            (focal_pc4 if is_focal else nonfocal_presence).append(d)
        elif check == 'PC2':
            (focal_pc2 if is_focal else nonfocal_other).append(d)
        elif check == 'PC1':
            actual = str(d.get('actual', ''))
            is_zero = actual.strip() == '0'
            if is_focal and is_zero:
                focal_pc1_zero.append(d)
            elif not is_focal:
                nonfocal_other.append(d)

    # Focal missing-pitcher is the union of PC3 and PC1-zero-focal (both indicate missing rows)
    has_focal_missing_pitcher = bool(focal_pc3 or focal_pc1_zero)
    has_focal_missing_batter = bool(focal_pc4)
    has_focal_hit_mismatch = bool(focal_pc2)
    focal_categories = sum([has_focal_missing_pitcher,
                            has_focal_missing_batter,
                            has_focal_hit_mismatch])

    non_pc5_count = len(discrepancies) - pc5_count

    # Decision tree
    if focal_categories > 1:
        return {
            'game_id': gid,
            'bucket': 'G',
            'details': {'reason': 'multiple focal issue types (PC3/PC4/PC2 coincident)',
                        'categories': focal_categories},
            'discrepancies': discrepancies,
        }

    if focal_categories == 1:
        if has_focal_missing_pitcher:
            d0 = focal_pc3[0] if focal_pc3 else focal_pc1_zero[0]
            return {
                'game_id': gid,
                'bucket': 'A',
                'details': {
                    'team': d0['team'],
                    'missing': d0.get('details', ''),
                },
                'discrepancies': discrepancies,
            }

        if has_focal_missing_batter:
            d0 = focal_pc4[0]
            return {
                'game_id': gid,
                'bucket': 'B',
                'details': {
                    'team': d0['team'],
                    'missing': d0.get('details', ''),
                },
                'discrepancies': discrepancies,
            }

        if has_focal_hit_mismatch:
            d0 = focal_pc2[0]
            team = d0['team']
            try:
                expected = int(d0['expected'])
                actual = int(d0['actual'])
                actual_gap = abs(expected - actual)
            except (ValueError, TypeError):
                actual_gap = 0

            md_path = GAMES_DIR / f'{gid}.md'
            md_text = md_path.read_text() if md_path.exists() else ''
            s5 = parse_section5_h_discrepancy(md_text, team)

            if not s5['has_flag']:
                bucket = 'E'
                reason = 'no Section 5 flag for hit discrepancy'
            elif s5['documented_gap'] >= actual_gap - 1:
                bucket = 'C'
                reason = 'Section 5 fully documents the gap'
            else:
                bucket = 'D'
                reason = f'Section 5 documents {s5["documented_gap"]} of {actual_gap}'

            return {
                'game_id': gid,
                'bucket': bucket,
                'details': {
                    'team': team,
                    'actual_gap': actual_gap,
                    'documented_gap': s5['documented_gap'],
                    'section5': s5['description'],
                    'reason': reason,
                },
                'discrepancies': discrepancies,
            }

    # No focal issues
    if nonfocal_presence:
        return {
            'game_id': gid,
            'bucket': 'F',
            'details': {'missing': nonfocal_presence[0].get('details', '')},
            'discrepancies': discrepancies,
        }

    if pc5_count > 0 and non_pc5_count == 0:
        return {
            'game_id': gid,
            'bucket': 'H',
            'details': {'reason': 'PC5 parser artifact only'},
            'discrepancies': discrepancies,
        }

    return {
        'game_id': gid,
        'bucket': 'G',
        'details': {'reason': 'unclassified / non-focal other'},
        'discrepancies': discrepancies,
    }


# ─── Output ──────────────────────────────────────────────────────────────────

def format_human(triage_results, total_audited):
    order = {b: i for i, b in enumerate('ABCDEFGH')}
    triage_results.sort(key=lambda r: (order.get(r['bucket'], 99), r['game_id']))

    print(f'Triage report — {len(triage_results)} failures across {total_audited} games\n')

    for r in triage_results:
        b = r['bucket']
        gid = r['game_id']
        d = r['details']
        print(f'[{b}] {gid}')
        if b == 'A':
            print(f'    Focal missing pitcher ({d.get("team", "?")}): {d.get("missing", "")}')
            print(f'    Action: re-ingest; manual patch if retry fails')
        elif b == 'B':
            print(f'    Focal missing batter ({d.get("team", "?")}): {d.get("missing", "")}')
            print(f'    Action: re-ingest; manual patch if retry fails')
        elif b == 'C':
            print(f'    Focal hit mismatch ({d.get("team", "?")}): gap={d.get("actual_gap", "?")} — fully documented')
            print(f'    Section 5: {d.get("section5", "")}')
            print(f'    Action: accept, mark known discrepancy')
        elif b == 'D':
            print(f'    Focal hit mismatch ({d.get("team", "?")}): gap={d.get("actual_gap", "?")}, documented={d.get("documented_gap", 0)}')
            print(f'    Section 5: {d.get("section5", "")}')
            print(f'    Action: review Section 5; patch residual gap if real')
        elif b == 'E':
            print(f'    Focal hit mismatch ({d.get("team", "?")}): gap={d.get("actual_gap", "?")} — no Section 5 flag')
            print(f'    Action: re-ingest; manual review if unresolved')
        elif b == 'F':
            print(f'    Non-focal missing: {d.get("missing", "?")}')
            print(f'    Action: optional re-ingest; low priority')
        elif b == 'G':
            print(f'    Mixed / review: {d.get("reason", "")}')
            print(f'    Action: individual review before automated action')
            for disc in r['discrepancies']:
                details_short = disc.get('details', '')[:80]
                print(f'      {disc["check"]} {disc["team"]}: {details_short}')
        elif b == 'H':
            print(f'    PC5 parser artifact only')
            print(f'    Action: no action needed')
        print()

    # Summary
    print('Summary by bucket:')
    counts = {}
    for r in triage_results:
        counts[r['bucket']] = counts.get(r['bucket'], 0) + 1
    for b in 'ABCDEFGH':
        name = BUCKET_NAMES[b]
        c = counts.get(b, 0)
        print(f'  {b} ({name}): {c} game{"s" if c != 1 else ""}')

    print()
    print('Recommended processing order: A → B → C → D → E → F → G → H')


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Triage audit failures into action buckets')
    parser.add_argument('--bucket', help='Filter to buckets (e.g., A,B)')
    parser.add_argument('--game-id', help='Single-game triage')
    parser.add_argument('--json', action='store_true', help='Machine-readable JSON output')
    args = parser.parse_args()

    if args.game_id:
        md_path = GAMES_DIR / f'{args.game_id}.md'
        if not md_path.exists():
            sys.exit(f'Markdown not found: {md_path}')
        audit_results = [audit_game(md_path)]
    else:
        paths = sorted(GAMES_DIR.glob('*.md'))
        paths = [p for p in paths if not p.stem.startswith('UNKNOWN_')]
        audit_results = [audit_game(p) for p in paths]

    total_audited = len(audit_results)
    failures = [r for r in audit_results if r['status'] == 'fail']
    triage_results = [classify(f) for f in failures]

    if args.bucket:
        allowed = set(args.bucket.upper().split(','))
        triage_results = [r for r in triage_results if r['bucket'] in allowed]

    if args.json:
        print(json.dumps(triage_results, indent=2))
    else:
        format_human(triage_results, total_audited)


if __name__ == '__main__':
    main()
