"""HTML assembly for the 2-page brief. f-strings only — no Jinja."""
from __future__ import annotations
from pathlib import Path

from ..metrics.pitching import ops_from


# Pitch-level league benchmarks (HS literature; not focal-team computed).
# TODO: replace with focal-team-actual averages once full corpus is parsed nightly.
LG_FPS = 0.58
LG_S = 0.60
LG_2K = 0.35
LG_LO_BB = 0.12

COLOR_RS = '#2c5fa8'
COLOR_RA = '#b03434'
COLOR_E = '#888888'

_STYLES_PATH = Path(__file__).parent / 'styles.css'


def _fmt_ops(v) -> str:
    if v is None or v == 0:
        return '—'
    return f"{v:.3f}".lstrip('0') if v < 1 else f"{v:.3f}"


def _fmt_avg(v) -> str:
    if v is None:
        return '—'
    return f".{int(v * 1000):03d}"


def _fmt_pct(v, decimals: int = 0) -> str:
    if v is None:
        return '—'
    return f"{v * 100:.{decimals}f}%"


def _shade(value, ref, thresholds=(0.10, 0.20), invert=False) -> str:
    if ref == 0 or value is None:
        return ''
    delta = (value - ref) / ref
    if invert:
        delta = -delta
    if delta > thresholds[1]:
        return 'good-strong'
    if delta > thresholds[0]:
        return 'good'
    if delta < -thresholds[1]:
        return 'bad-strong'
    if delta < -thresholds[0]:
        return 'bad'
    return ''


def _fmt_value(key: str, v) -> str:
    if key in ('bb_pct', 'k_pct'): return f"{v * 100:.1f}%"
    if key == 'ops': return _fmt_ops(v)
    if key in ('era', 'whip', 'errs_g'): return f"{v:.2f}"
    return f"{v:.2f}"


_RF_CARDS = [
    ('Runs / G',         'rs_g',   'Offense',  False),
    ('Runs Allowed / G', 'ra_g',   'Defense',  True),
    ('Team OPS',         'ops',    'Offense',  False),
    ('Team ERA',         'era',    'Pitching', True),
    ('WHIP',             'whip',   'Pitching', True),
    ('Errors / G',       'errs_g', 'Defense',  True),
    ('Walk Rate',        'bb_pct', 'Offense',  False),
    ('Strikeout Rate',   'k_pct',  'Offense',  True),
]


def _cover_html(cover: dict) -> str:
    return f'''
<div class="cover">
  <div class="cover-team">
    <div class="team-name">Team Detail: {cover['team_full']}</div>
    <div class="window">{cover['window_start']} → {cover['window_end']} · {cover['n_games']} games tracked</div>
  </div>
  <div class="cover-stats">
    <div class="cs"><span class="lbl">Record</span><span class="val">{cover['record']}</span></div>
    <div class="cs"><span class="lbl">RS / RA</span><span class="val">{cover['rs']}/{cover['ra']}</span></div>
    <div class="cs"><span class="lbl">Diff</span><span class="val">{cover['diff']:+d}</span></div>
    <div class="cs"><span class="lbl">L5</span><span class="val">{cover['l5_record']}</span></div>
    <div class="cs"><span class="lbl">Streak</span><span class="val">{cover['streak']}</span></div>
  </div>
</div>'''


def _recent_form_html(season, l10, l5, lg) -> str:
    cards = []
    for label, key, subtitle, invert in _RF_CARDS:
        sea_v, l10_v, l5_v, lg_v = season[key], l10[key], l5[key], lg[key]
        season_cls = _shade(sea_v, lg_v, invert=invert)
        l5_cls = _shade(l5_v, lg_v, invert=invert)
        trend = ''
        if l5_v > sea_v * 1.05:
            trend = '<span class="trend up">▲</span>' if not invert else '<span class="trend down">▲</span>'
        elif l5_v < sea_v * 0.95:
            trend = '<span class="trend down">▼</span>' if not invert else '<span class="trend up">▼</span>'
        cards.append(f'''
      <div class="rf-card">
        <div class="rf-card-header">
          <div class="rf-label">{label}</div>
          <div class="rf-subtitle">{subtitle}</div>
        </div>
        <div class="rf-season {season_cls}">{_fmt_value(key, sea_v)}</div>
        <div class="rf-mini-row">
          <div class="rf-mini">
            <span class="rf-mini-lbl">L10</span>
            <span class="rf-mini-val">{_fmt_value(key, l10_v)}</span>
          </div>
          <div class="rf-mini">
            <span class="rf-mini-lbl">L5</span>
            <span class="rf-mini-val {l5_cls}">{_fmt_value(key, l5_v)}{trend}</span>
          </div>
        </div>
        <div class="rf-lg">
          <span class="rf-lg-lbl">Lg avg</span>
          <span class="rf-lg-val">{_fmt_value(key, lg_v)}</span>
        </div>
      </div>''')
    return f'''
<div class="section recent-form-section">
  <h2>Recent Form</h2>
  <div class="rf-cards">{''.join(cards)}</div>
</div>'''


def _workload_html(work: dict, l5_chrono: list[dict]) -> str:
    l5_dates = work['l5_dates']
    l5_opp_codes = [g['opp'] for g in l5_chrono]
    l5_venues = [g['venue'] for g in l5_chrono]

    work_pitchers = sorted(work['workload'].keys(),
                           key=lambda p: -sum(work['workload'][p].values()))

    header_cells = ''
    for d, code, venue in zip(l5_dates, l5_opp_codes, l5_venues):
        header_cells += f'<th class="cal-date"><div class="d">{d[5:]}</div><div class="o">{venue}{code}</div></th>'

    rows = []
    for pit in work_pitchers:
        cells = [f'<td class="pit-name">{pit}</td>']
        for d in l5_dates:
            ip = work['workload'][pit].get(d)
            if ip is None:
                cells.append('<td class="cal-cell empty">—</td>')
            elif ip >= 4:
                cells.append(f'<td class="cal-cell starter">{ip:.1f}</td>')
            else:
                cells.append(f'<td class="cal-cell reliever">{ip:.1f}</td>')
        total = sum(work['workload'][pit].values())
        cells.append(f'<td class="cal-total">{total:.1f}</td>')
        rows.append('<tr>' + ''.join(cells) + '</tr>')

    if not rows:
        rows = ['<tr><td colspan="7" style="text-align:center;color:#999;padding:8px">No L5 pitching data</td></tr>']

    return f'''
<div class="workload">
  <h3>Pitcher usage — last 5 games</h3>
  <table class="cal">
    <thead>
      <tr>
        <th></th>
        {header_cells}
        <th class="cal-total">IP</th>
      </tr>
    </thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
  <div class="legend">
    <span class="leg-sw starter"></span> Started/4+ IP
    <span class="leg-sw reliever"></span> Relief/&lt;4 IP
  </div>
</div>'''


def _pitching_html(pitchers: list[dict], team_tto: dict, work: dict, l5_chrono: list[dict]) -> str:
    pit_rows = []
    for p in pitchers:
        fps_cls = _shade(p['fps_pct'], LG_FPS)
        s_cls = _shade(p['s_pct'], LG_S)
        twok_cls = _shade(p['twok_k_pct'], LG_2K)
        lo_cls = _shade(p['lo_bb_pct'], LG_LO_BB, invert=True)
        ops1_cls = _shade(p['ops_1'], 0.700, invert=True) if p['ops_1'] else ''
        ops2_cls = _shade(p['ops_2'], 0.700, invert=True) if p['ops_2'] else ''
        ops3_cls = _shade(p['ops_3'], 0.700, invert=True) if p['ops_3'] else ''
        pit_rows.append(f'''
    <tr>
      <td class="pit-name">{p['name']}</td>
      <td class="num">{p['ip']:.1f}</td>
      <td class="num">{p['era']:.2f}</td>
      <td class="num {fps_cls}">{_fmt_pct(p['fps_pct'])}</td>
      <td class="num {s_cls}">{_fmt_pct(p['s_pct'])}</td>
      <td class="num {twok_cls}">{_fmt_pct(p['twok_k_pct'])}</td>
      <td class="num {lo_cls}">{_fmt_pct(p['lo_bb_pct'])}</td>
      <td class="num {ops1_cls}">{_fmt_ops(p['ops_1'])}<span class="pa">({p['pa_1']})</span></td>
      <td class="num {ops2_cls}">{_fmt_ops(p['ops_2'])}<span class="pa">({p['pa_2']})</span></td>
      <td class="num {ops3_cls}">{_fmt_ops(p['ops_3'])}<span class="pa">({p['pa_3']})</span></td>
    </tr>''')

    if not pit_rows:
        pit_rows = ['<tr><td colspan="10" style="text-align:center;color:#999;padding:8px">No pitchers meet the 20-PA threshold</td></tr>']

    pit_rows.append(f'''
    <tr class="lg-row">
      <td class="pit-name">Benchmark</td>
      <td class="num">—</td>
      <td class="num">—</td>
      <td class="num lg-avg">{_fmt_pct(LG_FPS)}</td>
      <td class="num lg-avg">{_fmt_pct(LG_S)}</td>
      <td class="num lg-avg">{_fmt_pct(LG_2K)}</td>
      <td class="num lg-avg">{_fmt_pct(LG_LO_BB)}</td>
      <td class="num lg-avg">.700</td>
      <td class="num lg-avg">.700</td>
      <td class="num lg-avg">.700</td>
    </tr>''')

    return f'''
<div class="section">
  <h2>Pitching</h2>
  {_workload_html(work, l5_chrono)}
  <h3>Pitcher Insights</h3>
  <table class="data tight">
    <thead>
      <tr>
        <th>Name</th><th>IP</th><th>ERA</th>
        <th>FPS%</th><th>S%</th><th>2K K%</th><th>Lead BB%</th>
        <th>OPS 1st</th><th>OPS 2nd</th><th>OPS 3rd</th>
      </tr>
    </thead>
    <tbody>{''.join(pit_rows)}</tbody>
  </table>
  <div class="tto-strip-mini">
    <span class="tto-mini-label">Team OPS allowed by time-through-order:</span>
    <span class="tto-mini-cell">1st <strong>{_fmt_ops(ops_from(team_tto[1]))}</strong> <span class="pa-mini">({team_tto[1]['PA']} PA)</span></span>
    <span class="tto-mini-cell">2nd <strong>{_fmt_ops(ops_from(team_tto[2]))}</strong> <span class="pa-mini">({team_tto[2]['PA']} PA)</span></span>
    <span class="tto-mini-cell">3rd <strong>{_fmt_ops(ops_from(team_tto[3]))}</strong> <span class="pa-mini">({team_tto[3]['PA']} PA)</span></span>
  </div>
</div>'''


def _lineup_html(lineup: list[dict]) -> str:
    if not lineup:
        body = '<tr><td colspan="11" style="text-align:center;color:#999;padding:8px">No lineup data</td></tr>'
    else:
        rows = []
        for p in lineup:
            ops_l5_cls = _shade(p['ops_l5'], p['ops']) if p['ops_l5'] is not None else ''
            rows.append(f'''
    <tr>
      <td class="spot">{p['spot']}</td>
      <td class="pit-name">{p['name']}</td>
      <td class="num">{p['ab']}</td>
      <td class="num">{_fmt_avg(p['avg'])}</td>
      <td class="num">{_fmt_ops(p['ops'])}</td>
      <td class="num {ops_l5_cls}">{_fmt_ops(p['ops_l5']) if p['ops_l5'] else '—'}</td>
      <td class="num">{p['hr']}</td>
      <td class="num">{p['r']}</td>
      <td class="num">{p['rbi']}</td>
      <td class="num">{_fmt_pct(p['bb_rate'])}</td>
      <td class="num">{_fmt_pct(p['k_rate'])}</td>
    </tr>''')
        body = ''.join(rows)
    return f'''
<div class="section">
  <h2>Lineup — most-common L5 starters</h2>
  <table class="data">
    <thead>
      <tr>
        <th>#</th><th>Name</th>
        <th>AB</th><th>AVG</th>
        <th>OPS Sea</th><th>OPS L5</th>
        <th>HR</th><th>R</th><th>RBI</th>
        <th>BB%</th><th>K%</th>
      </tr>
    </thead>
    <tbody>{body}</tbody>
  </table>
</div>'''


def _baserunning_html(br: dict) -> str:
    t, lg = br['team'], br['league']
    sb_att_g = (t['sb_total'] + t['cs_total']) / t['games'] if t['games'] else 0
    team_strip = f'''
<div class="br-team">
  <div class="br-team-row">
    <div class="br-stat"><span class="lbl">SB att/G</span><span class="val">{sb_att_g:.2f}</span></div>
    <div class="br-stat"><span class="lbl">Success%</span><span class="val">{_fmt_pct(t['succ_pct'])}</span></div>
    <div class="br-stat"><span class="lbl">SB-3</span><span class="val">{t['sb_3']}</span></div>
    <div class="br-stat"><span class="lbl">SB-home</span><span class="val">{t['sb_h']}</span></div>
    <div class="br-stat"><span class="lbl">XB on errors</span><span class="val">{t['eb_err']}</span></div>
  </div>
  <div class="br-team-row lg">
    <div class="br-stat"><span class="lbl">Lg SB att/G</span><span class="val">{lg['sb_g'] + lg['cs_g']:.2f}</span></div>
    <div class="br-stat"><span class="lbl">Lg Succ%</span><span class="val">{_fmt_pct(lg['succ_pct'])}</span></div>
    <div class="br-stat"><span class="lbl"></span><span class="val"></span></div>
    <div class="br-stat"><span class="lbl"></span><span class="val"></span></div>
    <div class="br-stat"><span class="lbl"></span><span class="val"></span></div>
  </div>
</div>'''

    if not br['players']:
        body = '<tr><td colspan="7" style="text-align:center;color:#999;padding:8px">No SB/CS attempts in window</td></tr>'
    else:
        rows = []
        for p in br['players']:
            rows.append(f'''
    <tr>
      <td class="pit-name">{p['name']}</td>
      <td class="num">{p['att']}</td>
      <td class="num">{p['sb_2']}</td>
      <td class="num">{p['sb_3']}</td>
      <td class="num">{p['sb_h']}</td>
      <td class="num">{p['cs']}</td>
      <td class="num">{_fmt_pct(p['succ_pct'])}</td>
    </tr>''')
        body = ''.join(rows)

    return f'''
<div class="section">
  <h2>Base running</h2>
  {team_strip}
  <table class="data tight">
    <thead>
      <tr>
        <th>Player</th>
        <th>Att</th><th>SB-2</th><th>SB-3</th><th>SB-H</th><th>CS</th><th>Succ%</th>
      </tr>
    </thead>
    <tbody>{body}</tbody>
  </table>
</div>'''


def _cadence_svg(cadence: list[dict]) -> str:
    """Inline-attribute SVG (no CSS classes — WeasyPrint silently drops them on <rect>/<text>)."""
    agg = {'rs': [0] * 7, 'ra': [0] * 7, 'e': [0] * 7}
    for c in cadence:
        for i in range(1, 8):
            agg['rs'][i - 1] += c['innings'][i]['rs']
            agg['ra'][i - 1] += c['innings'][i]['ra']
            agg['e'][i - 1] += c['innings'][i]['e']

    runs_scale_max = max(max(agg['rs']), max(agg['ra']), 1)
    err_scale_max = max(max(agg['e']), 1)

    chart_w, chart_h = 880, 220
    margin_top, margin_bottom, margin_left = 26, 30, 50
    margin_right_runs = 90
    runs_panel_w, err_panel_w = 480, 200
    inning_h = (chart_h - margin_top - margin_bottom) / 7
    bar_h = inning_h * 0.30
    bar_gap = inning_h * 0.04

    parts = []
    parts.append(f'<text x="{margin_left}" y="14" font-size="9.5" font-weight="600" font-family="Helvetica" fill="#333" text-transform="uppercase">RUNS — Scored vs Allowed</text>')
    parts.append(f'<text x="{margin_left + runs_panel_w + margin_right_runs}" y="14" font-size="9.5" font-weight="600" font-family="Helvetica" fill="#333">ERRORS</text>')

    legend_x = margin_left + runs_panel_w - 100
    parts.append(f'<rect x="{legend_x}" y="6" width="10" height="8" fill="{COLOR_RS}"/>')
    parts.append(f'<text x="{legend_x + 14}" y="14" font-size="8" font-family="Helvetica" fill="#444">Scored</text>')
    parts.append(f'<rect x="{legend_x + 50}" y="6" width="10" height="8" fill="{COLOR_RA}"/>')
    parts.append(f'<text x="{legend_x + 64}" y="14" font-size="8" font-family="Helvetica" fill="#444">Allowed</text>')

    for i in range(7):
        inning = i + 1
        row_y = margin_top + i * inning_h + inning_h / 2
        parts.append(f'<text x="{margin_left - 8}" y="{row_y + 4}" font-size="9.5" font-weight="600" font-family="Helvetica" fill="#666" text-anchor="end">Inn {inning}</text>')

    runs_x0 = margin_left + 5
    runs_x1 = runs_x0 + runs_panel_w - 10
    def runs_x(v): return runs_x0 + (v / runs_scale_max) * (runs_x1 - runs_x0)

    for tick in range(0, runs_scale_max + 1, max(1, runs_scale_max // 5)):
        x = runs_x(tick)
        parts.append(f'<line x1="{x}" y1="{margin_top}" x2="{x}" y2="{chart_h - margin_bottom}" stroke="#e8e8e8" stroke-width="0.5"/>')
        parts.append(f'<text x="{x}" y="{chart_h - margin_bottom + 12}" font-size="7.5" font-family="Helvetica" fill="#999" text-anchor="middle">{tick}</text>')

    err_x0 = margin_left + runs_panel_w + margin_right_runs + 5
    err_x1 = err_x0 + err_panel_w - 10
    def err_x(v): return err_x0 + (v / err_scale_max) * (err_x1 - err_x0)

    for tick in range(0, err_scale_max + 1, max(1, err_scale_max // 3)):
        x = err_x(tick)
        parts.append(f'<line x1="{x}" y1="{margin_top}" x2="{x}" y2="{chart_h - margin_bottom}" stroke="#e8e8e8" stroke-width="0.5"/>')
        parts.append(f'<text x="{x}" y="{chart_h - margin_bottom + 12}" font-size="7.5" font-family="Helvetica" fill="#999" text-anchor="middle">{tick}</text>')

    for i in range(7):
        row_top = margin_top + i * inning_h
        row_mid = row_top + inning_h / 2
        rs_v, ra_v, e_v = agg['rs'][i], agg['ra'][i], agg['e'][i]

        rs_y = row_mid - bar_h - bar_gap / 2
        if rs_v > 0:
            rs_w = runs_x(rs_v) - runs_x0
            parts.append(f'<rect x="{runs_x0}" y="{rs_y}" width="{rs_w}" height="{bar_h}" fill="{COLOR_RS}" rx="1"/>')
            parts.append(f'<text x="{runs_x0 + rs_w + 4}" y="{rs_y + bar_h - 1}" font-size="9" font-family="Helvetica" font-weight="600" fill="#1a1a1a">{rs_v}</text>')
        else:
            parts.append(f'<line x1="{runs_x0}" y1="{rs_y + bar_h / 2}" x2="{runs_x0 + 4}" y2="{rs_y + bar_h / 2}" stroke="#ccc" stroke-width="1.5"/>')

        ra_y = row_mid + bar_gap / 2
        if ra_v > 0:
            ra_w = runs_x(ra_v) - runs_x0
            parts.append(f'<rect x="{runs_x0}" y="{ra_y}" width="{ra_w}" height="{bar_h}" fill="{COLOR_RA}" rx="1"/>')
            parts.append(f'<text x="{runs_x0 + ra_w + 4}" y="{ra_y + bar_h - 1}" font-size="9" font-family="Helvetica" font-weight="600" fill="#1a1a1a">{ra_v}</text>')
        else:
            parts.append(f'<line x1="{runs_x0}" y1="{ra_y + bar_h / 2}" x2="{runs_x0 + 4}" y2="{ra_y + bar_h / 2}" stroke="#ccc" stroke-width="1.5"/>')

        err_bar_h = bar_h * 1.6
        err_y = row_mid - err_bar_h / 2
        if e_v > 0:
            e_w = err_x(e_v) - err_x0
            parts.append(f'<rect x="{err_x0}" y="{err_y}" width="{e_w}" height="{err_bar_h}" fill="{COLOR_E}" rx="1"/>')
            parts.append(f'<text x="{err_x0 + e_w + 4}" y="{err_y + err_bar_h * 0.7}" font-size="9" font-family="Helvetica" font-weight="600" fill="#1a1a1a">{e_v}</text>')
        else:
            parts.append(f'<line x1="{err_x0}" y1="{err_y + err_bar_h / 2}" x2="{err_x0 + 4}" y2="{err_y + err_bar_h / 2}" stroke="#ccc" stroke-width="1.5"/>')

    for i in range(1, 7):
        y = margin_top + i * inning_h
        parts.append(f'<line x1="{margin_left + 5}" y1="{y}" x2="{margin_left + runs_panel_w - 5}" y2="{y}" stroke="#f0f0f0" stroke-width="0.5"/>')
        parts.append(f'<line x1="{err_x0}" y1="{y}" x2="{err_x1}" y2="{y}" stroke="#f0f0f0" stroke-width="0.5"/>')

    return f'''<svg width="{chart_w}" height="{chart_h}" viewBox="0 0 {chart_w} {chart_h}" xmlns="http://www.w3.org/2000/svg">
{''.join(parts)}
</svg>'''


def _cadence_html(cadence: list[dict]) -> str:
    return f'''
<div class="section">
  <h2>Game Cadence — last 5 games (aggregated by inning)</h2>
  <div class="cadence-chart">{_cadence_svg(cadence)}</div>
</div>'''


def _methodology_html(cover: dict, l5_chrono: list[dict]) -> str:
    listing = ', '.join(
        f"{g['date']} {g['venue']}{g['opp']} ({'W' if g['won'] else 'L'} {g['my_r']}-{g['opp_r']})"
        for g in l5_chrono
    ) or '—'
    return f'''
<div class="methodology">
  <h3>Methodology</h3>
  <div class="meth-grid">
    <div><strong>Window:</strong> {cover['window_start']} → {cover['window_end']} ({cover['n_games']} games)</div>
    <div><strong>L5 games:</strong> {listing}</div>
    <div><strong>League average:</strong> mean across the focal teams tracked by RVRH analytics</div>
    <div><strong>Pitch-level benchmarks (FPS%, S%, 2K K%, Lead BB%):</strong> HS literature norms, not focal-team computed</div>
    <div><strong>OPS by time-through-order:</strong> per-batter encounter count within a pitcher's outing</div>
    <div><strong>Shading:</strong> green = ≥10% better than benchmark, dark green = ≥20%, red/dark red same convention for worse</div>
    <div><strong>Errors in cadence chart:</strong> parsed from play-log text rather than gameLog totals (Home_E/Away_E observed flipped in at least one game)</div>
    <div><strong>1st-to-3rd metric:</strong> intentionally omitted — runner-state inference produced too many false positives</div>
    <div><strong>Generated:</strong> from RVRH repository.json + game files</div>
  </div>
</div>'''


def _load_styles() -> str:
    with open(_STYLES_PATH) as f:
        return f.read()


def render(data: dict) -> str:
    """Compose the full 2-page HTML document for a team brief."""
    cover = data['cover']
    page1 = (
        _cover_html(cover)
        + _recent_form_html(data['season'], data['l10'], data['l5'], data['league_avg'])
        + _pitching_html(data['pitchers'], data['team_tto'], data['workload'], data['l5_chrono'])
    )
    page2 = f'''
<div class="row">
  <div class="col-left" style="width: 56%;">{_lineup_html(data['lineup'])}</div>
  <div class="col-right" style="width: 44%;">{_baserunning_html(data['baserunning'])}</div>
</div>
{_cadence_html(data['cadence'])}
{_methodology_html(cover, data['l5_chrono'])}'''

    return f'''<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>{_load_styles()}</style></head>
<body>
<div class="page page-1">{page1}</div>
<div class="page page-2">{page2}</div>
</body>
</html>'''
