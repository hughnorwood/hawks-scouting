import { useState, useMemo, useRef, useEffect, useCallback } from "react";

// ─── helpers ──────────────────────────────────────────────────────────────────
const num  = v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
const safe = (a, b) => b > 0 ? a / b : 0;
const pct  = v => !isFinite(v) || isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`;
const avg3 = v => !isFinite(v) || isNaN(v) ? ".000" : v >= 1 ? v.toFixed(3) : "." + v.toFixed(3).slice(2);
const fix2 = v => !isFinite(v) || isNaN(v) || v > 99 ? "—" : v.toFixed(2);
const fix1 = v => !isFinite(v) || isNaN(v) || v > 99 ? "—" : v.toFixed(1);
const fmtIP = outs => `${Math.floor(outs / 3)}.${outs % 3}`;
const clamp = (v, max) => v > max ? max : v;

const TEAM_NAMES = {
  RVRH: 'River Hill', CNTN: 'Centennial', GLNL: 'Glenelg', HNTN: 'Huntingtown',
  PRKS: 'Parkside', STHR: 'Southern', FLLS: 'Fallston', MDLT: 'Middletown',
  HRFD: 'Hereford', NHRF: 'North Harford', CNTY: 'Century', KTIS: 'Kent Island',
  LNRC: 'Long Reach',
};
const teamName = id => TEAM_NAMES[id] || id;

const DESKTOP_BP = 1280;

function useWindowWidth() {
  const [width, setWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const handle = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handle);
    return () => window.removeEventListener("resize", handle);
  }, []);
  return width;
}

// ─── parsing ──────────────────────────────────────────────────────────────────
function parseData(json) {
  return { gameLog: json.gameLog || [], batting: json.batting || [], pitching: json.pitching || [], fielding: json.fielding || [], roster: json.roster || [] };
}

function classifyTeams(data) {
  const counts = {};
  data.gameLog.forEach(g => { if (g.Focal_Team) counts[g.Focal_Team] = (counts[g.Focal_Team] || 0) + 1; });
  const focal = Object.entries(counts).filter(([, c]) => c >= 4).map(([t]) => t).sort();
  const all   = [...new Set([...data.batting.map(r => r.Team), ...data.pitching.map(r => r.Team)].filter(Boolean))].sort();
  return { focal, opponents: all.filter(t => !focal.includes(t)), all };
}

// ─── aggregation ──────────────────────────────────────────────────────────────
function aggBatting(rows) {
  const m = {};
  for (const r of rows) {
    const p = r.Player || "?";
    if (!m[p]) m[p] = { Player: p, G: new Set(), PA:0, AB:0, H:0, "1B":0, "2B":0, "3B":0, HR:0, BB:0, HBP:0, K:0, R:0, RBI:0, SB:0, CS:0, GDP:0, SAC:0, FC:0 };
    if (r.Game_ID) m[p].G.add(r.Game_ID);
    ["PA","AB","H","1B","2B","3B","HR","BB","HBP","K","R","RBI","SB","CS","GDP","SAC","FC"].forEach(k => m[p][k] += num(r[k]));
  }
  return Object.values(m).map(r => {
    const AVG = safe(r.H, r.AB), OBP = safe(r.H + r.BB + r.HBP, r.PA);
    const TB = r["1B"] + 2*r["2B"] + 3*r["3B"] + 4*r.HR, SLG = safe(TB, r.AB);
    return { ...r, G: r.G.size, AVG, OBP, SLG, OPS: OBP + SLG, TB };
  });
}

function aggPitching(rows) {
  const m = {};
  for (const r of rows) {
    const p = r.Pitcher || "?";
    if (!m[p]) m[p] = { Pitcher: p, G: new Set(), Outs:0, BF:0, H:0, "1B":0, "2B":0, "3B":0, BB:0, HBP:0, K:0, R:0, HR:0, WP:0 };
    if (r.Game_ID) m[p].G.add(r.Game_ID);
    m[p].Outs += num(r.Outs_Recorded); m[p].BF += num(r.BF);
    m[p].H += num(r.H_Allowed); m[p]["1B"] += num(r["1B_Allowed"]); m[p]["2B"] += num(r["2B_Allowed"]); m[p]["3B"] += num(r["3B_Allowed"]);
    m[p].BB += num(r.BB_Allowed); m[p].HBP += num(r.HBP_Allowed);
    m[p].K += num(r.K); m[p].R += num(r.R_Allowed);
    m[p].HR += num(r.HR_Allowed); m[p].WP += num(r.WP);
  }
  return Object.values(m).map(r => {
    const IP = r.Outs / 3, WHIP = safe(r.H + r.BB, IP), ERA = safe(r.R * 9, IP);
    return { ...r, G: r.G.size, IP, WHIP, ERA,
      KBB: r.BB > 0 ? r.K / r.BB : r.K > 0 ? 99 : 0,
      KPct: safe(r.K, r.BF), BBPct: safe(r.BB, r.BF) };
  });
}

function teamSummary(data, teamId) {
  const pitchers = aggPitching(data.pitching.filter(r => r.Team === teamId));
  const batters  = aggBatting(data.batting.filter(r => r.Team === teamId));
  const gRows    = data.gameLog.filter(g => g.Focal_Team === teamId);
  const errors   = data.fielding.filter(r => r.Team === teamId).length;

  const tOuts = pitchers.reduce((s,r) => s + r.Outs, 0);
  const IP    = tOuts / 3;
  const tK    = pitchers.reduce((s,r) => s + r.K, 0);
  const tBB   = pitchers.reduce((s,r) => s + r.BB, 0);
  const tH    = pitchers.reduce((s,r) => s + r.H, 0);
  const tR    = pitchers.reduce((s,r) => s + r.R, 0);
  const tBF   = pitchers.reduce((s,r) => s + r.BF, 0);
  const tAB   = batters.reduce((s,r) => s + r.AB, 0);
  const tHit  = batters.reduce((s,r) => s + r.H, 0);
  const tPA   = batters.reduce((s,r) => s + r.PA, 0);
  const tBBat = batters.reduce((s,r) => s + r.BB, 0);
  const tHBP  = batters.reduce((s,r) => s + r.HBP, 0);
  const tTB   = batters.reduce((s,r) => s + r.TB, 0);

  let W = 0, L = 0, RS = 0, RA = 0;
  gRows.forEach(g => {
    const ar = num(g.Away_R), hr = num(g.Home_R);
    const tr = g.Away_Team === teamId ? ar : hr, or = g.Away_Team === teamId ? hr : ar;
    if (tr > or) W++; else if (tr < or) L++;
    RS += tr; RA += or;
  });

  return {
    teamId, G: gRows.length, W, L, RS, RA,
    RpG: safe(RS, gRows.length), RApG: safe(RA, gRows.length),
    ERA: safe(tR * 9, IP), WHIP: safe(tH + tBB, IP),
    KBB: tBB > 0 ? tK / tBB : tK > 0 ? 99 : 0,
    KPct: safe(tK, tBF), BBPct: safe(tBB, tBF),
    teamAVG: safe(tHit, tAB), teamOBP: safe(tHit + tBBat + tHBP, tPA),
    teamSLG: safe(tTB, tAB),
    teamSB: batters.reduce((s,r) => s + r.SB, 0),
    teamHR: batters.reduce((s,r) => s + r.HR, 0),
    errors, pitchers, batters,
  };
}

// ─── ANALYTICAL SCORING ──────────────────────────────────────────────────────

function hitterThreat(b) {
  if (b.PA < 8) return { score: 0, tier: "LIMITED", color: "var(--muted)" };
  const rbiPerH = b.H > 0 ? Math.min(b.RBI / b.H, 1) : 0;
  const contact = 1 - safe(b.K, b.PA);
  const score = b.OBP * 0.4 + b.SLG * 0.3 + rbiPerH * 0.15 + contact * 0.15;
  if (score >= 0.55) return { score, tier: "ELITE",    color: "var(--red)" };
  if (score >= 0.42) return { score, tier: "HIGH",     color: "var(--gold-t)" };
  if (score >= 0.30) return { score, tier: "MODERATE", color: "var(--blue)" };
  return { score, tier: "LOW", color: "var(--muted)" };
}

function pitcherImpact(p) {
  if (p.Outs < 9) return { score: 0, tier: "LIMITED", color: "var(--muted)", emoji: "⚪" };
  const IP = p.Outs / 3;
  const kNorm       = Math.min((p.K / IP) * 9 / 15, 1);
  const controlNorm = Math.max(1 - ((p.BB / IP) * 9) / 10, 0);
  const eraNorm     = Math.max(1 - p.ERA / 12, 0);
  const whipNorm    = Math.max(1 - p.WHIP / 3, 0);
  const score = kNorm * 0.3 + controlNorm * 0.25 + eraNorm * 0.25 + whipNorm * 0.2;
  if (score >= 0.72) return { score, tier: "ACE",      color: "var(--red)",    emoji: "🔴" };
  if (score >= 0.55) return { score, tier: "QUALITY",  color: "var(--gold-t)", emoji: "🟠" };
  if (score >= 0.38) return { score, tier: "AVERAGE",  color: "var(--blue)",   emoji: "🔵" };
  return { score, tier: "BELOW AVG", color: "var(--muted)", emoji: "⚪" };
}

function pitcherRole(p) {
  if (p.G === 0) return "—";
  const avgOuts = p.Outs / p.G;
  if (avgOuts >= 9) return "Starter";
  if (avgOuts >= 4.5) return "Reliever";
  return "Setup/Closer";
}

function playoffThreat(data, teamId) {
  const games = data.gameLog.filter(g => g.Away_Team === teamId || g.Home_Team === teamId);
  if (games.length === 0) return null;
  let W = 0, RS = 0, RA = 0;
  games.forEach(g => {
    const ar = num(g.Away_R), hr = num(g.Home_R);
    const isAway = g.Away_Team === teamId;
    const tr = isAway ? ar : hr, or = isAway ? hr : ar;
    if (tr > or) W++;
    RS += tr; RA += or;
  });
  const G = games.length, rpg = RS / G, rapg = RA / G, winPct = W / G;
  const batters  = aggBatting(data.batting.filter(r => r.Team === teamId));
  const pitchers = aggPitching(data.pitching.filter(r => r.Team === teamId));
  const tAB  = batters.reduce((s,r) => s + r.AB, 0);
  const tH   = batters.reduce((s,r) => s + r.H, 0);
  const tPA  = batters.reduce((s,r) => s + r.PA, 0);
  const tBBat = batters.reduce((s,r) => s + r.BB, 0);
  const tHBP = batters.reduce((s,r) => s + r.HBP, 0);
  const tTB  = batters.reduce((s,r) => s + r.TB, 0);
  const teamAVG = safe(tH, tAB);
  const teamOBP = safe(tH + tBBat + tHBP, tPA);
  const teamSLG = safe(tTB, tAB);
  const tOuts = pitchers.reduce((s,r) => s + r.Outs, 0);
  const tR    = pitchers.reduce((s,r) => s + r.R, 0);
  const tPH   = pitchers.reduce((s,r) => s + r.H, 0);
  const tBB   = pitchers.reduce((s,r) => s + r.BB, 0);
  const IP    = tOuts / 3;
  const teamERA  = safe(tR * 9, IP);
  const teamWHIP = safe(tPH + tBB, IP);
  const errors = data.fielding.filter(r => r.Team === teamId).length;
  const ePG = errors / G;
  const offScore  = Math.min((rpg / 10) * 25, 25);
  const pitScore  = Math.max((1 - teamERA / 15) * 25, 0);
  const defScore  = Math.max((1 - ePG / 4) * 20, 0);
  const score = winPct * 30 + offScore + pitScore + defScore;
  let tier, tierColor;
  if (score >= 55) { tier = "MAJOR THREAT"; tierColor = "var(--red)"; }
  else if (score >= 40) { tier = "CONTENDER";    tierColor = "var(--gold-t)"; }
  else if (score >= 25) { tier = "MID-TIER";     tierColor = "var(--blue)"; }
  else { tier = "LOW THREAT"; tierColor = "var(--muted)"; }
  return { score, tier, tierColor, G, W, L: G - W, rpg, rapg, teamAVG, teamOBP, teamSLG, teamERA, teamWHIP, ePG };
}

function defensiveTargets(data, teamId) {
  const errMap = {};
  const games = data.gameLog.filter(g => g.Away_Team === teamId || g.Home_Team === teamId);
  const G = games.length || 1;
  data.fielding.filter(r => r.Team === teamId).forEach(r => {
    const p = r.Player || "Unknown";
    if (!errMap[p]) errMap[p] = 0;
    errMap[p]++;
  });
  return Object.entries(errMap)
    .map(([Player, Errors]) => ({ Player, Errors, ePG: Errors / G }))
    .sort((a, b) => b.Errors - a.Errors);
}

function opponentRotation(data, teamId) {
  const games = data.gameLog.filter(g => g.Away_Team === teamId || g.Home_Team === teamId)
    .sort((a, b) => String(a.Game_Date).localeCompare(String(b.Game_Date)));
  const starters = [];
  for (const g of games) {
    const pRows = data.pitching.filter(r => r.Team === teamId && r.Game_ID === g.Game_ID)
      .sort((a, b) => num(b.Outs_Recorded) - num(a.Outs_Recorded));
    if (pRows.length > 0) {
      const starter = pRows[0];
      starters.push({ pitcher: starter.Pitcher, gameId: g.Game_ID, date: g.Game_Date, outs: num(starter.Outs_Recorded), IP: fmtIP(num(starter.Outs_Recorded)) });
    }
  }
  const pitcherMap = {};
  for (const s of starters) {
    if (!pitcherMap[s.pitcher]) pitcherMap[s.pitcher] = { pitcher: s.pitcher, starts: 0, totalOuts: 0, dates: [] };
    pitcherMap[s.pitcher].starts++;
    pitcherMap[s.pitcher].totalOuts += s.outs;
    pitcherMap[s.pitcher].dates.push(s.date);
  }
  return Object.values(pitcherMap)
    .map(p => ({ ...p, avgIP: fmtIP(Math.round(p.totalOuts / p.starts)), lastStart: p.dates[p.dates.length - 1] }))
    .sort((a, b) => b.starts - a.starts);
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function callClaude(system, user, maxTokens = 1500, endpoint = "/api/chat") {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return d.content?.find(b => b.type === "text")?.text || "";
}

function buildChatSystem(data) {
  const tab = (rows, cols) => [cols.join("\t"), ...rows.map(r => cols.map(c => r[c] ?? "").join("\t"))].join("\n");
  const teams = classifyTeams(data);

  const teamRows = teams.all.map(id => {
    const s = teamSummary(data, id);
    return {
      Team: id, Type: teams.focal.includes(id) ? "focal" : "opponent",
      W: s.W, L: s.L, G: s.G,
      ERA: fix2(s.ERA), WHIP: fix2(s.WHIP),
      KBB: fix1(clamp(s.KBB, 20)), KPct: pct(s.KPct), BBPct: pct(s.BBPct),
      AVG: avg3(s.teamAVG), OBP: avg3(s.teamOBP), SLG: avg3(s.teamSLG),
      OPS: avg3(s.teamOBP + s.teamSLG), SB: s.teamSB, HR: s.teamHR, Errors: s.errors,
    };
  });

  const batters = teams.all.flatMap(id =>
    aggBatting(data.batting.filter(r => r.Team === id))
      .map(r => ({ Team: id, ...r,
        AVG: avg3(r.AVG), OBP: avg3(r.OBP), SLG: avg3(r.SLG), OPS: avg3(r.OPS) }))
  ).sort((a, b) => b.PA - a.PA);

  const pitchers = teams.all.flatMap(id =>
    aggPitching(data.pitching.filter(r => r.Team === id))
      .map(r => ({ Team: id, ...r,
        IP: fmtIP(r.Outs), ERA: fix2(r.ERA), WHIP: fix2(r.WHIP),
        KBB: fix1(clamp(r.KBB, 20)), KPct: pct(r.KPct), BBPct: pct(r.BBPct) }))
  ).sort((a, b) => b.Outs - a.Outs);

  return `HS baseball analytics assistant. All batting and pitching stats are pre-aggregated season totals — answer directly from this data, do not re-derive from raw rows. Show brief reasoning only when calculating across multiple players.
Formulas if needed: AVG=H/AB OBP=(H+BB+HBP)/PA SLG=(1B+2×2B+3×3B+4×HR)/AB OPS=OBP+SLG IP=Outs/3 WHIP=(H+BB)/IP ERA=R×9/IP

=== TEAM SUMMARIES ===
${tab(teamRows, ["Team","Type","W","L","G","ERA","WHIP","KBB","KPct","BBPct","AVG","OBP","SLG","OPS","SB","HR","Errors"])}

=== BATTING TOTALS (season aggregated, all players) ===
${tab(batters, ["Team","Player","G","PA","AB","H","1B","2B","3B","HR","BB","HBP","K","R","RBI","SB","CS","AVG","OBP","SLG","OPS"])}

=== PITCHING TOTALS (season aggregated, all pitchers) ===
${tab(pitchers, ["Team","Pitcher","G","IP","BF","H","BB","K","R","HR","ERA","WHIP","KBB","KPct","BBPct"])}

=== GAME LOG ===
${tab(data.gameLog, ["Game_ID","Game_Date","Game_Type","Focal_Team","Away_Team","Home_Team","Away_R","Home_R","Away_H","Home_H","Away_E","Home_E"])}`;
}

// ─── NEW HELPERS ─────────────────────────────────────────────────────────────

function threatTierUI(score) {
  if (score >= 55) return { label: "THREAT", bg: "#B83030", textColor: "#fff" };
  if (score >= 25) return { label: "MID",    bg: "#B87010", textColor: "#fff" };
  return { label: "WEAK", bg: "#DDDAD2", textColor: "var(--text)" };
}

function teamRecord(data, teamId) {
  const games = data.gameLog
    .filter(g => g.Away_Team === teamId || g.Home_Team === teamId)
    .sort((a, b) => String(b.Game_Date).localeCompare(String(a.Game_Date)));

  const results = games.map(g => {
    const ar = num(g.Away_R), hr = num(g.Home_R);
    const tr = g.Away_Team === teamId ? ar : hr;
    const or = g.Away_Team === teamId ? hr : ar;
    return { W: tr > or, L: tr < or, rs: tr, ra: or, date: g.Game_Date };
  });

  const last5 = results.slice(0, 5);

  let streakType = results[0]?.W ? "W" : "L";
  let streakCount = 0;
  for (const r of results) {
    if ((streakType === "W" && r.W) || (streakType === "L" && r.L)) streakCount++;
    else break;
  }
  const streak = results.length > 0 ? `${streakType}${streakCount}` : "—";

  const W = results.filter(r => r.W).length;
  const L = results.filter(r => r.L).length;
  const RS = results.reduce((s, r) => s + r.rs, 0);
  const RA = results.reduce((s, r) => s + r.ra, 0);

  return { W, L, RS, RA, diff: RS - RA, streak, last5, results };
}

function heatColor(value, min, max, lowerIsBetter) {
  const t = max === min ? 0.5 : (value - min) / (max - min);
  const quality = lowerIsBetter ? 1 - t : t;
  const r = Math.round(184 * (1 - quality) + 59 * quality);
  const g = Math.round(48 * (1 - quality) + 109 * quality);
  const b = Math.round(48 * (1 - quality) + 17 * quality);
  return `rgba(${r}, ${g}, ${b}, 0.22)`;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `

@import url('https://fonts.googleapis.com/css2?family=Nunito+Sans:opsz,wght@6..12,300;6..12,400;6..12,500;6..12,600;6..12,700;6..12,800&display=swap');

:root {
  --bg:       #EEF2F8;
  --s1:       #FFFFFF;
  --s2:       #F3F6FB;
  --s3:       #E4ECF5;
  --bd:       #C8D5E8;
  --bd2:      #A8BDD8;
  --navy:     #001E50;
  --gold:     #D4900A;
  --gold-t:   #8B5010;
  --gold-d:   rgba(212,144,10,.12);
  --red:      #B83030;
  --red-d:    rgba(184,48,48,.10);
  --green:    #3B6D11;
  --green-d:  rgba(59,109,17,.10);
  --blue:     #1A5FA8;
  --blue-d:   rgba(26,95,168,.12);
  --amber:    #8B5010;
  --amber-d:  rgba(139,80,16,.10);
  --purple:   #5A4A8A;
  --purple-d: rgba(90,74,138,.10);
  --muted:    #6888A8;
  --text:     #0D2240;
  --text2:    #3A5070;
  --radius:   10px;
}
*, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--text); font-family:'Nunito Sans',sans-serif; font-size:15px; -webkit-font-smoothing:antialiased; }

/* layout */
.app { min-height:100vh; }
.topbar { height:56px; border-bottom:2px solid var(--navy); display:flex; align-items:center; padding:0 20px; gap:14px; position:sticky; top:0; background:var(--navy); z-index:100; }
.brand { font-size:18px; font-weight:800; color:#FFFFFF; letter-spacing:1.5px; white-space:nowrap; }
.brand span { color:var(--gold); }
.spacer { flex:1; }
.tabs { display:flex; border-bottom:1px solid var(--bd); padding:0 20px; background:var(--s1); }
.tab { font-family:'Nunito Sans'; font-weight:600; font-size:14px; padding:12px 18px; cursor:pointer; color:var(--muted); border-bottom:3px solid transparent; transition:all .15s; white-space:nowrap; letter-spacing:.3px; min-height:44px; display:flex; align-items:center; }
.tab:hover { color:var(--navy); }
.tab.on { color:var(--navy); border-bottom-color:var(--gold); font-weight:700; }
.main { padding:20px; max-width:1440px; margin:0 auto; }

/* loading */
.loading-wrap { display:flex; align-items:center; justify-content:center; height:60vh; }
.loading-wrap p { font-size:15px; color:var(--muted); font-weight:600; }

/* cards / surfaces */
.card { background:var(--s1); border:0.5px solid var(--bd); border-radius:var(--radius); box-shadow:0 1px 3px rgba(0,30,80,.06); }

/* tables */
.tbl-wrap { border:0.5px solid var(--bd); border-radius:var(--radius); overflow:hidden; box-shadow:0 1px 3px rgba(0,30,80,.06); }
table { width:100%; border-collapse:collapse; }
thead th { padding:10px 12px; text-align:left; font-size:11px; font-family:'Nunito Sans'; font-weight:700; color:var(--navy); text-transform:uppercase; letter-spacing:.8px; background:var(--s2); border-bottom:2px solid var(--bd); cursor:pointer; user-select:none; white-space:nowrap; min-height:44px; }
thead th:hover, thead th.on { color:var(--gold-t); }
tbody td { padding:10px 12px; font-size:13px; border-bottom:1px solid var(--bd); font-family:'Courier New',monospace; font-variant-numeric:tabular-nums; }
tbody tr:last-child td { border-bottom:none; }
.td-name { font-family:'Nunito Sans'; font-weight:600; }
.mono { font-family:'Courier New',monospace; font-variant-numeric:tabular-nums; }
.c-g { color:var(--green); } .c-r { color:var(--red); } .c-m { color:var(--muted); }
.td-r { text-align:right; }

/* section headers */
.sec-title { font-family:'Nunito Sans'; font-size:10px; font-weight:800; color:var(--navy); text-transform:uppercase; letter-spacing:1.2px; padding-bottom:10px; border-bottom:2px solid var(--navy); margin-bottom:14px; }

/* back button */
.back-btn { background:var(--s1); border:0.5px solid var(--bd); border-radius:6px; color:var(--text2); font-family:'Nunito Sans'; font-size:13px; font-weight:600; padding:7px 14px; cursor:pointer; margin-bottom:14px; display:inline-flex; align-items:center; gap:6px; transition:all .15s; box-shadow:0 1px 3px rgba(0,30,80,.06); min-height:44px; }
.back-btn:hover { border-color:var(--navy); color:var(--navy); }

/* ─── LEAGUE TAB ─── */
.scatter-wrap { background:var(--s1); border:0.5px solid var(--bd); border-radius:var(--radius); padding:16px; margin-bottom:18px; box-shadow:0 1px 3px rgba(0,30,80,.06); }
.scatter-legend { display:flex; gap:14px; justify-content:center; margin-top:10px; }
.scatter-legend-item { display:flex; align-items:center; gap:5px; font-size:11px; font-weight:700; color:var(--text2); }
.scatter-legend-dot { width:10px; height:10px; border-radius:50%; }

.standings-wrap { background:var(--s1); border:0.5px solid var(--bd); border-radius:var(--radius); overflow:hidden; margin-bottom:18px; box-shadow:0 1px 3px rgba(0,30,80,.06); }
.standings-wrap tbody tr { cursor:pointer; }
.standings-wrap tbody tr:hover td { background:var(--s2); }
.standings-rvrh td { font-weight:700; }
.standings-rvrh { border-left:3px solid var(--navy); }
.standings-sep td { border-bottom:2px solid var(--bd2) !important; }
.last5-dots { display:flex; gap:3px; }
.last5-dot { width:8px; height:8px; border-radius:50%; }
.last5-w { background:var(--green); }
.last5-l { background:var(--red); }

.heatmap-wrap { background:var(--s1); border:0.5px solid var(--bd); border-radius:var(--radius); overflow:hidden; margin-bottom:18px; box-shadow:0 1px 3px rgba(0,30,80,.06); }
.heatmap-wrap tbody tr { cursor:pointer; }
.heatmap-wrap tbody tr:hover td { opacity:.85; }
.heatmap-rvrh { border-left:3px solid var(--navy); }

/* ─── TEAMS TAB ─── */
.team-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; margin-bottom:18px; }
@media(min-width:800px) { .team-grid { grid-template-columns:repeat(3, 1fr); } }
@media(min-width:1100px) { .team-grid { grid-template-columns:repeat(4, 1fr); } }
.team-card { border-radius:var(--radius); border:0.5px solid rgba(0,0,0,.08); padding:16px; cursor:pointer; transition:transform .12s, box-shadow .12s; min-height:44px; }
.team-card:hover { transform:translateY(-2px); box-shadow:0 4px 12px rgba(0,0,0,.12); }
.team-card-name { font-size:16px; font-weight:800; margin-bottom:6px; }
.team-card-stats { display:flex; gap:10px; font-size:12px; font-weight:600; margin-bottom:8px; font-family:'Courier New',monospace; font-variant-numeric:tabular-nums; }
.team-card-last3 { display:flex; gap:4px; }
.wl-badge { width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:800; color:#fff; }
.wl-w { background:var(--green); }
.wl-l { background:var(--red); }

.limited-acc { border:0.5px solid var(--bd); border-radius:var(--radius); overflow:hidden; margin-bottom:18px; }
.limited-acc-hdr { padding:12px 16px; background:var(--s2); cursor:pointer; user-select:none; display:flex; align-items:center; justify-content:space-between; min-height:44px; }
.limited-acc-hdr:hover { background:var(--s3); }
.limited-acc-title { font-size:12px; font-weight:700; color:var(--muted); }
.limited-acc-toggle { font-size:12px; color:var(--muted); }
.limited-acc-body { padding:12px; background:var(--s1); border-top:1px solid var(--bd); }

.briefing-header { margin-bottom:4px; }
.briefing-name { font-size:22px; font-weight:800; color:var(--navy); }
.briefing-games { font-size:13px; color:var(--muted); font-weight:600; margin-bottom:14px; }
.slim-header { position:sticky; top:56px; z-index:50; background:var(--s1); border-bottom:1px solid var(--bd); padding:10px 16px; display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:13px; font-weight:600; margin:0 -20px; padding-left:20px; padding-right:20px; }
.slim-stat { font-family:'Courier New',monospace; font-variant-numeric:tabular-nums; color:var(--text2); }
.slim-sep { color:var(--bd2); }
.slim-pill { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700; color:#fff; }
.slim-pill-w { background:var(--green); }
.slim-pill-l { background:var(--red); }

.drawer { border:0.5px solid var(--bd); border-radius:var(--radius); margin-bottom:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,30,80,.06); }
.drawer-hdr { padding:13px 16px; cursor:pointer; user-select:none; display:flex; align-items:center; justify-content:space-between; background:var(--s2); min-height:44px; transition:background .12s; }
.drawer-hdr:hover { background:var(--s3); }
.drawer-label { font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:1px; }
.drawer-toggle { font-size:14px; color:var(--muted); transition:transform .2s; }
.drawer-toggle.open { transform:rotate(180deg); }
.drawer-body { border-top:1px solid var(--bd); background:var(--s1); }
.drawer-body.blue   { border-left:3px solid var(--blue); }
.drawer-body.amber  { border-left:3px solid var(--amber); }
.drawer-body.purple { border-left:3px solid var(--purple); }

.pitcher-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:10px; padding:14px; }
.pc { background:var(--s1); border:0.5px solid var(--bd); border-radius:var(--radius); padding:14px; }
.pc-name { font-weight:700; font-size:14px; color:var(--navy); cursor:pointer; margin-bottom:2px; }
.pc-name:hover { text-decoration:underline; }
.pc-role { font-size:11px; color:var(--muted); font-weight:600; margin-bottom:8px; }
.pc-stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
.pc-stat-val { font-family:'Courier New',monospace; font-size:15px; font-weight:800; font-variant-numeric:tabular-nums; }
.pc-stat-lbl { font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; font-weight:700; margin-top:1px; }

.outing-strip-wrap { display:flex; align-items:center; gap:6px; }
.outing-strip { display:flex; gap:3px; overflow-x:auto; flex:1; padding:4px 0; }
.outing-block { height:22px; min-width:22px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; color:#fff; flex-shrink:0; padding:0 4px; }
.outing-0r { background:var(--green); }
.outing-1r { background:#B87010; }
.outing-3r { background:var(--red); }
.outing-dir { font-size:10px; color:var(--muted); font-weight:700; white-space:nowrap; flex-shrink:0; }

.lineup-table { padding:0; }
.lineup-table table { font-size:13px; }
.lineup-table tbody td { padding:9px 10px; }
.lineup-table .td-name { cursor:pointer; color:var(--navy); font-weight:600; }
.lineup-table .td-name:hover { text-decoration:underline; }

.discipline-section { padding:14px 16px; border-bottom:1px solid var(--bd); }
.discipline-section:last-child { border-bottom:none; }
.discipline-title { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:1px; color:var(--purple); margin-bottom:10px; }
.sb-bar-wrap { display:flex; align-items:center; gap:10px; margin-top:6px; }
.sb-bar { flex:1; height:10px; background:var(--s3); border-radius:5px; overflow:hidden; }
.sb-bar-fill { height:100%; background:var(--green); border-radius:5px; }
.split-bar-wrap { display:flex; align-items:center; gap:6px; margin-top:6px; }
.split-bar { flex:1; height:10px; border-radius:5px; overflow:hidden; display:flex; }
.split-sac { height:100%; background:var(--blue); }
.split-gdp { height:100%; background:var(--red); }

/* ─── PLAYER INTELLIGENCE (State 3) ─── */
.pi-header { margin-bottom:14px; }
.pi-name { font-size:20px; font-weight:800; color:var(--navy); }
.pi-team { font-size:13px; color:var(--muted); font-weight:600; }
.pi-role { font-size:12px; font-weight:700; color:var(--blue); margin-top:2px; }
.pi-summary { display:flex; gap:16px; flex-wrap:wrap; padding:12px 16px; background:var(--s2); border:0.5px solid var(--bd); border-radius:var(--radius); margin-bottom:14px; }
.pi-sum-item { text-align:center; }
.pi-sum-val { font-family:'Courier New',monospace; font-size:16px; font-weight:800; font-variant-numeric:tabular-nums; color:var(--navy); }
.pi-sum-lbl { font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; font-weight:700; }
.pi-filters { display:flex; gap:6px; margin-bottom:14px; }
.pi-filter { font-family:'Nunito Sans'; font-size:12px; font-weight:700; padding:6px 14px; border-radius:6px; border:1px solid var(--bd); background:var(--s1); color:var(--text2); cursor:pointer; transition:all .12s; min-height:44px; display:flex; align-items:center; }
.pi-filter:hover { border-color:var(--navy); }
.pi-filter.on { background:var(--navy); color:#fff; border-color:var(--navy); }
.pi-toggle { display:flex; gap:0; margin-bottom:14px; }
.pi-toggle button { font-family:'Nunito Sans'; font-size:13px; font-weight:700; padding:8px 18px; border:1px solid var(--bd); background:var(--s1); color:var(--text2); cursor:pointer; min-height:44px; transition:all .12s; }
.pi-toggle button:first-child { border-radius:6px 0 0 6px; }
.pi-toggle button:last-child { border-radius:0 6px 6px 0; border-left:none; }
.pi-toggle button.on { background:var(--navy); color:#fff; border-color:var(--navy); }
.pi-table { margin-top:0; }
.pi-table tbody tr:hover td { background:var(--s2); cursor:default; }

/* ─── ASK TAB ─── */
.ask-wrap { display:flex; flex-direction:column; height:calc(100vh - 180px); min-height:400px;
  border:1px solid var(--bd); border-radius:var(--radius); overflow:hidden;
  box-shadow:0 1px 3px rgba(0,30,80,.06); }
.ask-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column;
  gap:12px; background:var(--bg); }
.ask-empty { margin:auto; text-align:center; }
.ask-empty h3 { font-weight:800; font-size:20px; color:var(--navy); margin-bottom:6px; }
.ask-empty p  { font-size:13px; color:var(--muted); }
.ask-sugs { display:flex; flex-wrap:wrap; gap:7px; justify-content:center;
  margin-top:14px; max-width:520px; }
.ask-sug { background:var(--s1); border:1px solid var(--bd); border-radius:6px;
  padding:6px 12px; cursor:pointer; font-size:12px; font-weight:600;
  color:var(--text2); font-family:'Nunito Sans'; transition:all .15s; text-align:left; min-height:44px; display:flex; align-items:center; }
.ask-sug:hover { border-color:var(--navy); color:var(--navy); }
.ask-msg { display:flex; gap:10px; max-width:88%; }
.ask-msg.user { align-self:flex-end; flex-direction:row-reverse; }
.ask-av { width:28px; height:28px; border-radius:50%; background:var(--s2);
  border:1px solid var(--bd); display:flex; align-items:center; justify-content:center;
  font-size:10px; font-weight:700; color:var(--muted); flex-shrink:0; }
.ask-msg.ai .ask-av { background:var(--navy); color:#fff; border-color:var(--navy); }
.ask-bbl { padding:10px 14px; border-radius:10px; font-size:14px;
  line-height:1.65; white-space:pre-wrap; }
.ask-msg.user .ask-bbl { background:var(--navy); color:#fff; }
.ask-msg.ai   .ask-bbl { background:var(--s1); color:var(--text); border:1px solid var(--bd); }
.ask-bar { display:flex; gap:8px; padding:12px 14px;
  border-top:1px solid var(--bd); background:var(--s1); }
.ask-inp { flex:1; background:var(--s2); border:1px solid var(--bd2); border-radius:6px;
  color:var(--text); font-family:'Nunito Sans'; font-size:14px; padding:9px 12px; outline:none; }
.ask-inp:focus { border-color:var(--navy); box-shadow:0 0 0 3px rgba(0,30,80,.10); }
.ask-inp::placeholder { color:var(--muted); }
.ask-send { background:var(--navy); color:#fff; border:none; border-radius:6px;
  font-family:'Nunito Sans'; font-weight:700; font-size:14px;
  padding:9px 18px; cursor:pointer; transition:all .15s; }
.ask-send:hover { opacity:.88; }
.ask-send:disabled { opacity:.4; cursor:not-allowed; }
.ask-dots { display:flex; gap:4px; padding:3px 0; }
.ask-dot  { width:6px; height:6px; border-radius:50%; background:var(--muted);
  animation:bounce 1.2s infinite; }
.ask-dot:nth-child(2){animation-delay:.2s}
.ask-dot:nth-child(3){animation-delay:.4s}

@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
.spinner { width:14px; height:14px; border:2px solid rgba(255,255,255,.4); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; flex-shrink:0; }
@keyframes spin{to{transform:rotate(360deg)}}

@media(max-width:700px) {
  .main { padding:12px; }
  .topbar { padding:0 12px; }
  .tabs { padding:0 12px; }
  .slim-header { margin:0 -12px; padding-left:12px; padding-right:12px; }
}

/* Desktop layouts */
.league-layout { display:flex; flex-direction:column; gap:16px; }
.teams-layout  { display:flex; flex-direction:column; gap:16px; }

@media(min-width:1280px) {
  .main { max-width:1440px; }
  .league-layout { flex-direction:row; align-items:flex-start; gap:24px; }
  .league-col-left { flex:0 0 55%; position:sticky; top:16px; }
  .league-col-right { flex:1; display:flex; flex-direction:column; gap:16px; max-height:calc(100vh - 120px); overflow-y:auto; }
  .teams-layout { flex-direction:row; align-items:flex-start; gap:24px; }
  .teams-col-left { flex:0 0 52%; }
  .teams-col-right { flex:1; min-height:400px; max-height:calc(100vh - 120px); overflow-y:auto; position:sticky; top:16px; }
}
.team-card.active { box-shadow:0 0 0 2px var(--navy); }
.scatter-flex { display:flex; gap:16px; align-items:flex-start; }
@media(max-width:900px) { .scatter-flex { flex-direction:column; } .scatter-flex > div:last-child { flex-direction:row; flex-wrap:wrap; padding-top:0; } }
`;

// ─── SORT HOOK ───────────────────────────────────────────────────────────────
function useSort(data, def, defDir = "desc") {
  const [col, setCol] = useState(def);
  const [dir, setDir] = useState(defDir);
  const toggle = c => { if (c === col) setDir(d => d === "asc" ? "desc" : "asc"); else { setCol(c); setDir("desc"); } };
  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data].sort((a, b) => {
      let va = a[col], vb = b[col];
      if (typeof va === "string") return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      va = num(va); vb = num(vb);
      return dir === "asc" ? va - vb : vb - va;
    });
  }, [data, col, dir]);
  return { sorted, col, dir, toggle };
}

function Th({ c, label, s, d, fn, left }) {
  const arrow = s === c ? (d === "asc" ? " ↑" : " ↓") : "";
  return <th className={s === c ? "on" : ""} style={left ? {} : { textAlign: "right" }} onClick={() => fn(c)}>{label}{arrow}</th>;
}

// ─── LEAGUE TAB ─────────────────────────────────────────────────────────────

function LeagueScatterPlot({ data, teams, onTeamClick }) {
  const FOCAL_TEAMS = ['RVRH','CNTN','GLNL','HNTN','PRKS','STHR','FLLS','MDLT','HRFD','NHRF','CNTY','KTIS','LNRC'];

  const plotTeams = useMemo(() => {
    return FOCAL_TEAMS.map(id => {
      const s = teamSummary(data, id);
      const pt = playoffThreat(data, id);
      return { id, ops: s.teamOBP + s.teamSLG, era: s.ERA, tier: pt?.tier ?? "WEAK", score: pt?.score ?? 0, W: s.W, L: s.L };
    }).filter(t => isFinite(t.ops) && isFinite(t.era) && t.era < 30);
  }, [data]);

  const [hoveredTeam, setHoveredTeam] = useState(null);

  if (plotTeams.length === 0) return null;

  const tierColor = t => threatTierUI(t.score).bg;

  // Dynamic axis bounds
  const opsValues = plotTeams.map(t => t.ops);
  const eraValues = plotTeams.map(t => t.era);
  const opsMin = Math.min(...opsValues), opsMax = Math.max(...opsValues);
  const eraMin = Math.min(...eraValues), eraMax = Math.max(...eraValues);
  const OPS_PAD = 0.080, ERA_PAD = 1.50;
  const X_MIN = opsMin - OPS_PAD, X_MAX = opsMax + OPS_PAD;
  const Y_MIN = eraMin - ERA_PAD, Y_MAX = eraMax + ERA_PAD;

  const SVG_W = 600, SVG_H = 400;
  const ML = 55, MT = 40, MR = 20, MB = 45, INSET = 20;
  const PL = ML + INSET, PR = SVG_W - MR - INSET;
  const PT = MT + INSET, PB = SVG_H - MB - INSET;
  const PW = PR - PL, PH = PB - PT;

  const toX = ops => PL + ((ops - X_MIN) / (X_MAX - X_MIN)) * PW;
  const toY = era => PT + ((era - Y_MIN) / (Y_MAX - Y_MIN)) * PH;

  const midXVal = (X_MIN + X_MAX) / 2, midYVal = (Y_MIN + Y_MAX) / 2;
  const xStep = (X_MAX - X_MIN) / 5;
  const xTicks = Array.from({ length: 6 }, (_, i) => X_MIN + i * xStep);
  const yStep = (Y_MAX - Y_MIN) / 5;
  const yTicks = Array.from({ length: 6 }, (_, i) => Y_MIN + i * yStep);

  // Legend sort: THREAT → MID → WEAK, alpha within tier
  const tierOrder = { "MAJOR THREAT": 0, CONTENDER: 1, "MID-TIER": 1, "LOW THREAT": 2 };
  const legendTeams = [...plotTeams].sort((a, b) => {
    const ta = tierOrder[a.tier] ?? 1, tb = tierOrder[b.tier] ?? 1;
    return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
  });

  return (
    <div className="scatter-wrap">
      <div className="scatter-flex">
        {/* SVG chart */}
        <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} style={{ flex: 1, height: "auto", maxHeight: 420 }}>
          {/* Zone backgrounds */}
          <rect x={toX(midXVal)} y={MT} width={SVG_W - MR - toX(midXVal)} height={toY(midYVal) - MT} fill="rgba(59,109,17,0.06)" rx="4" />
          <rect x={ML} y={MT} width={toX(midXVal) - ML} height={toY(midYVal) - MT} fill="rgba(26,95,168,0.04)" rx="4" />
          <rect x={toX(midXVal)} y={toY(midYVal)} width={SVG_W - MR - toX(midXVal)} height={SVG_H - MB - toY(midYVal)} fill="rgba(139,80,16,0.04)" rx="4" />

          {/* Axes */}
          <line x1={ML} y1={SVG_H - MB} x2={SVG_W - MR} y2={SVG_H - MB} stroke="#C8D5E8" strokeWidth="1" />
          <line x1={ML} y1={MT} x2={ML} y2={SVG_H - MB} stroke="#C8D5E8" strokeWidth="1" />

          {/* X ticks */}
          {xTicks.map((v, i) => (
            <g key={`xt${i}`}>
              <line x1={toX(v)} y1={SVG_H - MB} x2={toX(v)} y2={SVG_H - MB + 4} stroke="#A8BDD8" strokeWidth="1" />
              <text x={toX(v)} y={SVG_H - MB + 18} textAnchor="middle" fontSize={11} fontWeight={600} fill="#3A5070" fontFamily="Nunito Sans, sans-serif">{v.toFixed(3)}</text>
            </g>
          ))}
          <text x={ML + (SVG_W - ML - MR) / 2} y={SVG_H - 4} textAnchor="middle" fontSize={13} fontWeight={700} fill="#0D2240" fontFamily="Nunito Sans, sans-serif">OPS</text>

          {/* Y ticks */}
          {yTicks.map((v, i) => (
            <g key={`yt${i}`}>
              <line x1={ML - 4} y1={toY(v)} x2={ML} y2={toY(v)} stroke="#A8BDD8" strokeWidth="1" />
              <text x={ML - 8} y={toY(v) + 4} textAnchor="end" fontSize={11} fontWeight={600} fill="#3A5070" fontFamily="Nunito Sans, sans-serif">{v.toFixed(1)}</text>
            </g>
          ))}
          <text x={14} y={MT + (SVG_H - MT - MB) / 2} textAnchor="middle" fontSize={13} fontWeight={700} fill="#0D2240" fontFamily="Nunito Sans, sans-serif" transform={`rotate(-90, 14, ${MT + (SVG_H - MT - MB) / 2})`}>ERA</text>

          {/* Dots */}
          {plotTeams.map(t => {
            const cx = toX(t.ops), cy = toY(t.era);
            const isRVRH = t.id === "RVRH";
            const isHov = hoveredTeam === t.id;
            const anyHov = hoveredTeam !== null;
            return (
              <circle key={t.id} cx={cx} cy={cy}
                r={isHov ? 15 : 10}
                fill={isRVRH ? "#001E50" : tierColor(t)}
                stroke={isRVRH ? "#D4900A" : "none"} strokeWidth={isRVRH ? 2 : 0}
                opacity={anyHov && !isHov ? 0.3 : 1}
                style={{ cursor: "pointer", transition: "r 0.15s, opacity 0.15s" }}
                onMouseEnter={() => setHoveredTeam(t.id)}
                onMouseLeave={() => setHoveredTeam(null)}
                onClick={() => onTeamClick(t.id)}
              />
            );
          })}

          {/* Tooltip */}
          {hoveredTeam && (() => {
            const t = plotTeams.find(p => p.id === hoveredTeam);
            if (!t) return null;
            const x = toX(t.ops), y = toY(t.era);
            const tx = x > SVG_W * 0.7 ? x - 140 : x + 18;
            const ty = y < 60 ? y + 10 : y - 60;
            return (
              <g>
                <rect x={tx} y={ty} width={130} height={58} fill="white" stroke="#C8D5E8" strokeWidth={1} rx={6} filter="drop-shadow(0 2px 4px rgba(0,0,0,0.12))" />
                <text x={tx + 10} y={ty + 18} fontSize={12} fontWeight={700} fill="#001E50" fontFamily="Nunito Sans, sans-serif">{teamName(t.id)}</text>
                <text x={tx + 10} y={ty + 34} fontSize={11} fill="#3A5070" fontFamily="Nunito Sans, sans-serif">{`${t.W}\u2013${t.L} \u00b7 ERA ${fix2(t.era)}`}</text>
                <text x={tx + 10} y={ty + 50} fontSize={11} fill="#3A5070" fontFamily="Nunito Sans, sans-serif">{`OPS ${avg3(t.ops)}`}</text>
              </g>
            );
          })()}
        </svg>

        {/* Interactive legend */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 40, minWidth: 130 }}>
          {legendTeams.map(t => (
            <div key={t.id}
              onMouseEnter={() => setHoveredTeam(t.id)}
              onMouseLeave={() => setHoveredTeam(null)}
              onClick={() => onTeamClick(t.id)}
              style={{
                display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", borderRadius: 5,
                cursor: "pointer",
                borderLeft: hoveredTeam === t.id ? "3px solid var(--navy)" : "3px solid transparent",
                background: hoveredTeam === t.id ? "var(--s2)" : "transparent",
                opacity: hoveredTeam && hoveredTeam !== t.id ? 0.4 : 1,
                transition: "all 0.15s",
              }}>
              <div style={{
                width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                background: t.id === "RVRH" ? "#001E50" : tierColor(t),
                border: t.id === "RVRH" ? "2px solid #D4900A" : "none",
              }} />
              <span style={{
                fontSize: 12, fontWeight: t.id === "RVRH" ? 700 : 500,
                color: "var(--text)", fontFamily: "Nunito Sans, sans-serif", whiteSpace: "nowrap",
              }}>{teamName(t.id)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StandingsTable({ data, teams, onTeamClick }) {
  const FOCAL_TEAMS = ['RVRH','CNTN','GLNL','HNTN','PRKS','STHR','FLLS','MDLT','HRFD','NHRF','CNTY','KTIS','LNRC'];

  const allRecords = useMemo(() => {
    return FOCAL_TEAMS.map(id => {
      const rec = teamRecord(data, id);
      return { id, ...rec };
    });
  }, [data]);

  const rvrh = allRecords.find(r => r.id === "RVRH");
  const field = allRecords.filter(r => r.id !== "RVRH");

  const { sorted: sortedField, col, dir, toggle } = useSort(field, "W");

  const numStyle = { color: "var(--text)", fontFamily: "monospace", fontWeight: 600 };
  const diffStyle = d => ({ color: d > 0 ? "#1A7040" : d < 0 ? "#B83030" : "var(--text)", fontFamily: "monospace", fontWeight: 600 });
  const streakStyle = s => ({ color: s[0] === "W" ? "#1A7040" : "#B83030", fontFamily: "monospace", fontWeight: 700 });
  const thStyle = { color: "var(--navy)", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.7px" };

  const renderRow = (t, cls) => (
    <tr key={t.id} className={cls} onClick={() => onTeamClick(t.id)}>
      <td className="td-name">{teamName(t.id)}</td>
      <td className="td-r" style={numStyle}>{t.W}</td>
      <td className="td-r" style={numStyle}>{t.L}</td>
      <td className="td-r" style={numStyle}>{t.RS}</td>
      <td className="td-r" style={numStyle}>{t.RA}</td>
      <td className="td-r" style={diffStyle(t.diff)}>{t.diff > 0 ? "+" : ""}{t.diff}</td>
      <td className="td-r" style={streakStyle(t.streak)}>{t.streak}</td>
      <td>
        <div className="last5-dots" style={{ justifyContent: "center" }}>
          {t.last5.slice().reverse().map((g, i) => (
            <div key={i} className={`last5-dot ${g.W ? "last5-w" : "last5-l"}`} />
          ))}
        </div>
      </td>
    </tr>
  );

  return (
    <div className="standings-wrap" style={{ maxHeight: 480, overflowY: "auto" }}>
      <table>
        <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
          <tr>
            <th style={{ ...thStyle, textAlign: "left" }}>Team</th>
            <Th c="W" label="W" s={col} d={dir} fn={toggle} />
            <Th c="L" label="L" s={col} d={dir} fn={toggle} />
            <Th c="RS" label="RS" s={col} d={dir} fn={toggle} />
            <Th c="RA" label="RA" s={col} d={dir} fn={toggle} />
            <Th c="diff" label={"+/−"} s={col} d={dir} fn={toggle} />
            <th style={{ ...thStyle, textAlign: "right", cursor: "default" }}>Streak</th>
            <th style={{ ...thStyle, textAlign: "center", cursor: "default" }}>Last 5</th>
          </tr>
        </thead>
        <tbody>
          {rvrh && renderRow(rvrh, "standings-rvrh standings-sep")}
          {sortedField.map(t => renderRow(t, ""))}
        </tbody>
      </table>
    </div>
  );
}

function heatCell(value, min, max, lowerIsBetter) {
  if (!isFinite(value) || max === min) {
    return { bg: "#F3F6FB", color: "#3A5070" };
  }
  const t = (value - min) / (max - min);
  const q = lowerIsBetter ? 1 - t : t; // 1.0 = best, 0.0 = worst

  let r, g, b;
  if (q >= 0.5) {
    // amber → red (mid to best)
    const s = (q - 0.5) * 2;
    r = 184;
    g = Math.round(112 - s * 64);   // 112 → 48
    b = Math.round(16  + s * 0);    // stays ~16
  } else {
    // gray → amber (worst to mid)
    const s = q * 2;
    r = Math.round(221 - s * (221 - 184));  // 221 → 184
    g = Math.round(218 - s * (218 - 112));  // 218 → 112
    b = Math.round(213 - s * (213 - 16));   // 213 → 16
  }

  const bg = `rgba(${r}, ${g}, ${b}, 0.55)`;
  const color = q > 0.65 ? "#ffffff" : "#0D2240";
  return { bg, color };
}

function LeagueHeatMap({ data, teams, onTeamClick }) {
  const FOCAL_TEAMS = ['RVRH','CNTN','GLNL','HNTN','PRKS','STHR','FLLS','MDLT','HRFD','NHRF','CNTY','KTIS','LNRC'];

  const heatRows = useMemo(() => {
    const rows = FOCAL_TEAMS.map(id => {
      const s = teamSummary(data, id);
      const batters = aggBatting(data.batting.filter(r => r.Team === id));
      const totalSB = batters.reduce((sum, b) => sum + b.SB, 0);
      const totalCS = batters.reduce((sum, b) => sum + b.CS, 0);
      const sbPct = totalSB + totalCS > 0 ? totalSB / (totalSB + totalCS) : 0;
      const errG = s.errors / (s.G || 1);
      return { id, era: s.ERA, ops: s.teamOBP + s.teamSLG, errG, sbPct };
    });
    return rows;
  }, [data]);

  const ranges = useMemo(() => {
    const range = key => {
      const v = heatRows.map(r => r[key]);
      return { min: Math.min(...v), max: Math.max(...v) };
    };
    return { eraR: range("era"), opsR: range("ops"), errR: range("errG"), sbR: range("sbPct") };
  }, [heatRows]);

  const [sortCol, setSortCol] = useState("Team");
  const [sortDir, setSortDir] = useState("asc");

  const toggleSort = col => {
    if (col === sortCol) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const sortedHeatRows = useMemo(() => {
    return [...heatRows].sort((a, b) => {
      if (sortCol === "Team") {
        return sortDir === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
      }
      const lowerIsBetter = sortCol === "era" || sortCol === "errG";
      const av = a[sortCol], bv = b[sortCol];
      const cmp = lowerIsBetter ? av - bv : bv - av;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [heatRows, sortCol, sortDir]);

  const cellStyle = (value, min, max, lowerIsBetter) => {
    const c = heatCell(value, min, max, lowerIsBetter);
    return { background: c.bg, color: c.color, fontFamily: "monospace", fontWeight: 600, fontSize: 13 };
  };

  const cols = [
    { key: "Team",  label: "TEAM",  align: "left" },
    { key: "era",   label: "ERA",   align: "right" },
    { key: "ops",   label: "OPS",   align: "right" },
    { key: "errG",  label: "ERR/G", align: "right" },
    { key: "sbPct", label: "SB%",   align: "right" },
  ];

  return (
    <div className="heatmap-wrap" style={{ maxHeight: 480, overflowY: "auto" }}>
      <table>
        <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
          <tr>
            {cols.map(col => (
              <th key={col.key} onClick={() => toggleSort(col.key)}
                style={{
                  textAlign: col.align, cursor: "pointer", userSelect: "none",
                  color: sortCol === col.key ? "var(--navy)" : "var(--text2)",
                  fontWeight: 700, fontSize: 11, textTransform: "uppercase",
                  letterSpacing: "0.7px", padding: "10px 12px", whiteSpace: "nowrap",
                }}>
                {col.label}
                {sortCol === col.key ? (sortDir === "asc" ? " \u2191" : " \u2193") : " \u2195"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedHeatRows.map(t => (
            <tr key={t.id} className={t.id === "RVRH" ? "heatmap-rvrh" : ""} onClick={() => onTeamClick(t.id)}>
              <td className="td-name">{teamName(t.id)}</td>
              <td className="td-r" style={cellStyle(t.era, ranges.eraR.min, ranges.eraR.max, true)}>{fix2(t.era)}</td>
              <td className="td-r" style={cellStyle(t.ops, ranges.opsR.min, ranges.opsR.max, false)}>{avg3(t.ops)}</td>
              <td className="td-r" style={cellStyle(t.errG, ranges.errR.min, ranges.errR.max, true)}>{fix1(t.errG)}</td>
              <td className="td-r" style={cellStyle(t.sbPct, ranges.sbR.min, ranges.sbR.max, false)}>{t.sbPct > 0 ? pct(t.sbPct) : "\u2014"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function LeagueTab({ data, teams, onTeamClick }) {
  return (
    <div className="league-layout">
      <div className="league-col-left">
        <LeagueScatterPlot data={data} teams={teams} onTeamClick={onTeamClick} />
      </div>
      <div className="league-col-right">
        <StandingsTable data={data} teams={teams} onTeamClick={onTeamClick} />
        <LeagueHeatMap data={data} teams={teams} onTeamClick={onTeamClick} />
      </div>
    </div>
  );
}

// ─── TEAMS TAB ──────────────────────────────────────────────────────────────

function classifyTeamsForTab(data) {
  const FOCAL_TEAMS = ['RVRH','CNTN','GLNL','HNTN','PRKS','STHR','FLLS','MDLT','HRFD','NHRF','CNTY','KTIS','LNRC'];
  const allCodes = [...new Set([
    ...data.batting.map(r => r.Team),
    ...data.pitching.map(r => r.Team),
  ].filter(Boolean))];

  const gameCounts = {};
  data.gameLog.forEach(g => {
    [g.Away_Team, g.Home_Team].forEach(t => {
      if (t) gameCounts[t] = (gameCounts[t] || 0) + 1;
    });
  });

  const focal   = FOCAL_TEAMS.filter(id => allCodes.includes(id));
  const scouted = allCodes
    .filter(id => !FOCAL_TEAMS.includes(id) && (gameCounts[id] || 0) >= 4)
    .sort((a, b) => (gameCounts[b] || 0) - (gameCounts[a] || 0) || a.localeCompare(b));
  const limited = allCodes
    .filter(id => !FOCAL_TEAMS.includes(id) && (gameCounts[id] || 0) < 4)
    .sort((a, b) => a.localeCompare(b));

  return { focal, scouted, limited, gameCounts };
}

function TeamsCardGrid({ data, teams, onTeamClick, activeTeam, desktopMode, rightPanelOnly }) {
  const { focal, scouted, limited, gameCounts } = useMemo(() => classifyTeamsForTab(data), [data]);

  // Tier 1 — Focal team cards
  const focalCards = useMemo(() => {
    return focal.map(id => {
      const pt = playoffThreat(data, id);
      const rec = teamRecord(data, id);
      const s = teamSummary(data, id);
      return {
        id, score: pt ? pt.score : 0,
        W: rec.W, L: rec.L, ERA: s.ERA, AVG: s.teamAVG,
        last3: rec.results.slice(0, 3),
      };
    }).sort((a, b) => b.score - a.score);
  }, [data, focal]);

  // Tier 2 — Scouted opponents table data
  const scoutedRows = useMemo(() => {
    return scouted.map(id => {
      const rec = teamRecord(data, id);
      const s = teamSummary(data, id);
      const pitchers = aggPitching(data.pitching.filter(r => r.Team === id));
      const tOuts = pitchers.reduce((sum, p) => sum + p.Outs, 0);
      const tR = pitchers.reduce((sum, p) => sum + p.R, 0);
      const IP = tOuts / 3;
      const ERA = safe(tR * 9, IP);
      return {
        id, G: gameCounts[id] || 0, W: rec.W, L: rec.L,
        ERA, AVG: s.teamAVG, last3: rec.results.slice(0, 3),
      };
    });
  }, [data, scouted, gameCounts]);

  const { sorted: sortedScouted, col: sCol, dir: sDir, toggle: sToggle } = useSort(scoutedRows, "G");

  const [showLimited, setShowLimited] = useState(false);

  // Tier 1 — Focal team cards
  const renderFocalCards = () => (
    <>
      <div className="sec-title">Focal Teams</div>
      <div className="team-grid">
        {focalCards.map(c => {
          const tier = threatTierUI(c.score);
          return (
            <div key={c.id} className={`team-card${activeTeam === c.id ? " active" : ""}`}
              style={{ background: tier.bg, color: tier.textColor }}
              onClick={() => onTeamClick(c.id)}>
              <div className="team-card-name">{teamName(c.id)}</div>
              <div className="team-card-stats">
                <span>{c.W}-{c.L}</span>
                <span>{fix2(c.ERA)} ERA</span>
                <span>{avg3(c.AVG)} AVG</span>
              </div>
              <div className="team-card-last3">
                {c.last3.map((g, i) => (
                  <div key={i} className={`wl-badge ${g.W ? "wl-w" : "wl-l"}`}>
                    {g.W ? "W" : "L"}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  // Tier 2+3 — Scouted opponents + limited data
  const renderScoutedAndLimited = () => (
    <>
      {scoutedRows.length > 0 && (
        <>
          <div className="sec-title" style={{ marginTop: 22 }}>
            Scouted Opponents
            <span style={{ fontSize: 11, fontWeight: 400, color: "var(--muted)", marginLeft: 8 }}>
              {"4+ games \u00b7 tap any row to open briefing"}
            </span>
          </div>
          <div className="tbl-wrap" style={{ marginBottom: 18 }}>
            <table>
              <thead>
                <tr>
                  <Th c="id" label="Team" s={sCol} d={sDir} fn={sToggle} left />
                  <Th c="G" label="G" s={sCol} d={sDir} fn={sToggle} />
                  <Th c="W" label="W" s={sCol} d={sDir} fn={sToggle} />
                  <Th c="L" label="L" s={sCol} d={sDir} fn={sToggle} />
                  <Th c="ERA" label="ERA" s={sCol} d={sDir} fn={sToggle} />
                  <Th c="AVG" label="AVG" s={sCol} d={sDir} fn={sToggle} />
                  <th style={{ textAlign: "center", cursor: "default" }}>Last 3</th>
                </tr>
              </thead>
              <tbody>
                {sortedScouted.map(t => (
                  <tr key={t.id} onClick={() => onTeamClick(t.id)} style={{ cursor: "pointer" }}>
                    <td className="td-name" style={{ fontWeight: 600 }}>{teamName(t.id)}</td>
                    <td className="td-r">{t.G}</td>
                    <td className="td-r">{t.W}</td>
                    <td className="td-r">{t.L}</td>
                    <td className="td-r" style={{ color: t.ERA <= 4 ? "#1A7040" : t.ERA >= 8 ? "#B83030" : "var(--text)" }}>{fix2(t.ERA)}</td>
                    <td className="td-r">{avg3(t.AVG)}</td>
                    <td>
                      <div className="last5-dots" style={{ justifyContent: "center" }}>
                        {t.last3.map((g, i) => (
                          <div key={i} className={`last5-dot ${g.W ? "last5-w" : "last5-l"}`} />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {limited.length > 0 && (
        <div className="limited-acc">
          <div className="limited-acc-hdr" onClick={() => setShowLimited(v => !v)}>
            <span className="limited-acc-title">{"Other opponents \u00b7 fewer than 4 games scouted"} ({limited.length})</span>
            <span className="limited-acc-toggle">{showLimited ? "▲" : "▼"}</span>
          </div>
          {showLimited && (
            <div className="limited-acc-body">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {limited.map(id => (
                  <div key={id} onClick={() => onTeamClick(id)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      padding: "6px 12px", background: "var(--s2)", border: "1px solid var(--bd)",
                      borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--text)",
                      transition: "all .12s",
                    }}>
                    {teamName(id)}
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: "var(--muted)", background: "var(--s3)",
                      borderRadius: 3, padding: "1px 5px",
                    }}>
                      {gameCounts[id] || 0}G
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );

  // rightPanelOnly = only Tier 2+3 (desktop right column default)
  if (rightPanelOnly) return <div>{renderScoutedAndLimited()}</div>;

  // desktopMode = only Tier 1 focal cards (desktop left column)
  if (desktopMode) return <div>{renderFocalCards()}</div>;

  // Default (mobile) = all three tiers stacked
  return (
    <div>
      {renderFocalCards()}
      {renderScoutedAndLimited()}
    </div>
  );
}

function TeamBriefing({ data, teamId, drawerState, setDrawerState, onPlayerClick, onBack }) {
  const summary = useMemo(() => teamSummary(data, teamId), [data, teamId]);
  const rec = useMemo(() => teamRecord(data, teamId), [data, teamId]);
  const pitchers = useMemo(() =>
    aggPitching(data.pitching.filter(r => r.Team === teamId)).sort((a, b) => b.Outs - a.Outs),
    [data, teamId]);
  const batters = useMemo(() =>
    aggBatting(data.batting.filter(r => r.Team === teamId)).sort((a, b) => b.PA - a.PA),
    [data, teamId]);
  const targets = useMemo(() => defensiveTargets(data, teamId), [data, teamId]);

  const { sorted: sortedBatters, col: bCol, dir: bDir, toggle: bToggle } = useSort(batters, "PA");

  const last3 = rec.results.slice(0, 3);
  const gamesScouted = data.gameLog.filter(g => g.Away_Team === teamId || g.Home_Team === teamId).length;

  const batteryData = useMemo(() => {
    return pitchers.filter(p => p.WP > 0).map(p => ({
      Pitcher: p.Pitcher, WP: p.WP, WPG: p.G > 0 ? (p.WP / p.G) : 0
    })).sort((a, b) => b.WP - a.WP);
  }, [pitchers]);

  const brData = useMemo(() => {
    const sb = batters.reduce((s, b) => s + b.SB, 0);
    const cs = batters.reduce((s, b) => s + b.CS, 0);
    return { SB: sb, CS: cs, SBPct: sb + cs > 0 ? sb / (sb + cs) : 0 };
  }, [batters]);

  const sitData = useMemo(() => {
    const sac = batters.reduce((s, b) => s + b.SAC, 0);
    const gdp = batters.reduce((s, b) => s + b.GDP, 0);
    const G = gamesScouted || 1;
    return { SAC: sac, GDP: gdp, GDPG: gdp / G, total: sac + gdp };
  }, [batters, gamesScouted]);

  const toggleDrawer = key => setDrawerState(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div>
      <button className="back-btn" onClick={onBack}>{"← Back to Teams"}</button>

      <div className="briefing-header">
        <div className="briefing-name">{teamName(teamId)}</div>
        <div className="briefing-games">{gamesScouted} games scouted</div>
      </div>

      <div className="slim-header">
        <span className="slim-stat">{rec.W}-{rec.L}</span>
        <span className="slim-sep">{"\u00b7"}</span>
        <span className="slim-stat">{fix2(summary.ERA)} ERA</span>
        <span className="slim-sep">{"\u00b7"}</span>
        <span className="slim-stat">{fix2(summary.WHIP)} WHIP</span>
        {last3.map((g, i) => (
          <span key={i} className={`slim-pill ${g.W ? "slim-pill-w" : "slim-pill-l"}`}>
            {g.W ? "W" : "L"} {g.rs}-{g.ra}
          </span>
        ))}
      </div>

      {/* Pitching Drawer */}
      <div className="drawer" style={{ marginTop: 14 }}>
        <div className="drawer-hdr" onClick={() => toggleDrawer("pitching")}>
          <span className="drawer-label" style={{ color: "var(--blue)" }}>Pitching</span>
          <span className={`drawer-toggle ${drawerState.pitching ? "open" : ""}`}>{"▼"}</span>
        </div>
        {drawerState.pitching && (
          <div className="drawer-body blue">
            <div className="pitcher-grid">
              {pitchers.map(p => {
                const role = pitcherRole(p);
                const outings = data.pitching
                  .filter(r => r.Pitcher === p.Pitcher && r.Team === teamId)
                  .sort((a, b) => String(a.Game_Date).localeCompare(String(b.Game_Date)));

                return (
                  <div key={p.Pitcher} className="pc">
                    <div className="pc-name" onClick={() => onPlayerClick(teamId, p.Pitcher, "pitching")}>{p.Pitcher}</div>
                    <div className="pc-role">{role}</div>
                    <div className="pc-stats">
                      <div><div className="pc-stat-val">{fmtIP(p.Outs)}</div><div className="pc-stat-lbl">IP</div></div>
                      <div><div className="pc-stat-val">{fix2(p.ERA)}</div><div className="pc-stat-lbl">ERA</div></div>
                      <div><div className="pc-stat-val">{fix2(p.WHIP)}</div><div className="pc-stat-lbl">WHIP</div></div>
                      <div><div className="pc-stat-val">{p.K}</div><div className="pc-stat-lbl">K</div></div>
                      <div><div className="pc-stat-val">{p.BB}</div><div className="pc-stat-lbl">BB</div></div>
                    </div>
                    {outings.length > 0 && (
                      <div className="outing-strip-wrap">
                        <div className="outing-strip">
                          {outings.map((o, i) => {
                            const R = num(o.R_Allowed);
                            const cls = R === 0 ? "outing-0r" : R <= 2 ? "outing-1r" : "outing-3r";
                            return (
                              <div key={i} className={`outing-block ${cls}`} title={`${fmtIP(num(o.Outs_Recorded))} IP, ${R}R`}>
                                {fmtIP(num(o.Outs_Recorded))}
                              </div>
                            );
                          })}
                        </div>
                        <span className="outing-dir">{"Outings →"}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Lineup Drawer */}
      <div className="drawer">
        <div className="drawer-hdr" onClick={() => toggleDrawer("lineup")}>
          <span className="drawer-label" style={{ color: "var(--amber)" }}>Lineup</span>
          <span className={`drawer-toggle ${drawerState.lineup ? "open" : ""}`}>{"▼"}</span>
        </div>
        {drawerState.lineup && (
          <div className="drawer-body amber">
            <div className="lineup-table">
              <table>
                <thead>
                  <tr>
                    <Th c="Player" label="Player" s={bCol} d={bDir} fn={bToggle} left />
                    <Th c="G" label="G" s={bCol} d={bDir} fn={bToggle} />
                    <Th c="PA" label="PA" s={bCol} d={bDir} fn={bToggle} />
                    <Th c="AVG" label="AVG" s={bCol} d={bDir} fn={bToggle} />
                    <Th c="OBP" label="OBP" s={bCol} d={bDir} fn={bToggle} />
                    <Th c="SLG" label="SLG" s={bCol} d={bDir} fn={bToggle} />
                    <Th c="OPS" label="OPS" s={bCol} d={bDir} fn={bToggle} />
                    <Th c="HR" label="HR" s={bCol} d={bDir} fn={bToggle} />
                    <Th c="SB" label="SB" s={bCol} d={bDir} fn={bToggle} />
                    <Th c="KPct" label="K%" s={bCol} d={bDir} fn={bToggle} />
                  </tr>
                </thead>
                <tbody>
                  {sortedBatters.map(b => (
                    <tr key={b.Player}>
                      <td className="td-name" onClick={() => onPlayerClick(teamId, b.Player, "batting")}>{b.Player}</td>
                      <td className="td-r">{b.G}</td>
                      <td className="td-r">{b.PA}</td>
                      <td className="td-r">{avg3(b.AVG)}</td>
                      <td className="td-r">{avg3(b.OBP)}</td>
                      <td className="td-r">{avg3(b.SLG)}</td>
                      <td className="td-r">{avg3(b.OPS)}</td>
                      <td className="td-r">{b.HR}</td>
                      <td className="td-r">{b.SB}</td>
                      <td className="td-r">{pct(safe(b.K, b.PA))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Team Discipline Drawer */}
      <div className="drawer">
        <div className="drawer-hdr" onClick={() => toggleDrawer("discipline")}>
          <span className="drawer-label" style={{ color: "var(--purple)" }}>Team Discipline</span>
          <span className={`drawer-toggle ${drawerState.discipline ? "open" : ""}`}>{"▼"}</span>
        </div>
        {drawerState.discipline && (
          <div className="drawer-body purple">
            <div className="discipline-section">
              <div className="discipline-title">Fielding Errors</div>
              {targets.length > 0 ? (
                <table>
                  <thead>
                    <tr><th style={{ textAlign: "left" }}>Player</th><th style={{ textAlign: "right" }}>Errors</th><th style={{ textAlign: "right" }}>Games</th></tr>
                  </thead>
                  <tbody>
                    {targets.map(t => (
                      <tr key={t.Player}><td className="td-name">{t.Player}</td><td className="td-r">{t.Errors}</td><td className="td-r">{gamesScouted}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <div style={{ fontSize: 13, color: "var(--muted)" }}>No errors recorded</div>}
            </div>

            <div className="discipline-section">
              <div className="discipline-title">Battery</div>
              {batteryData.length > 0 ? (
                <table>
                  <thead>
                    <tr><th style={{ textAlign: "left" }}>Pitcher</th><th style={{ textAlign: "right" }}>WP</th><th style={{ textAlign: "right" }}>WP/G</th></tr>
                  </thead>
                  <tbody>
                    {batteryData.map(b => (
                      <tr key={b.Pitcher}><td className="td-name">{b.Pitcher}</td><td className="td-r">{b.WP}</td><td className="td-r">{fix1(b.WPG)}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <div style={{ fontSize: 13, color: "var(--muted)" }}>No wild pitches recorded</div>}
            </div>

            <div className="discipline-section">
              <div className="discipline-title">Baserunning</div>
              <div style={{ display: "flex", gap: 16, fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                <span>SB: <span className="mono">{brData.SB}</span></span>
                <span>CS: <span className="mono">{brData.CS}</span></span>
                <span>SB%: <span className="mono">{brData.SB + brData.CS > 0 ? pct(brData.SBPct) : "—"}</span></span>
              </div>
              <div className="sb-bar-wrap">
                <div className="sb-bar">
                  <div className="sb-bar-fill" style={{ width: `${brData.SBPct * 100}%` }} />
                </div>
              </div>
            </div>

            <div className="discipline-section">
              <div className="discipline-title">Situational Hitting</div>
              <div style={{ display: "flex", gap: 16, fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                <span>SAC: <span className="mono">{sitData.SAC}</span></span>
                <span>GDP: <span className="mono">{sitData.GDP}</span></span>
                <span>GDP/G: <span className="mono">{fix1(sitData.GDPG)}</span></span>
              </div>
              {sitData.total > 0 && (
                <div className="split-bar-wrap">
                  <span style={{ fontSize: 10, color: "var(--blue)", fontWeight: 700 }}>SAC</span>
                  <div className="split-bar">
                    <div className="split-sac" style={{ width: `${(sitData.SAC / sitData.total) * 100}%` }} />
                    <div className="split-gdp" style={{ width: `${(sitData.GDP / sitData.total) * 100}%` }} />
                  </div>
                  <span style={{ fontSize: 10, color: "var(--red)", fontWeight: 700 }}>GDP</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PlayerIntelligence({ data, playerName, teamId, defaultView, onBack }) {
  const [filterRange, setFilterRange] = useState("season");

  const hasBatting = data.batting.some(r => r.Player === playerName && r.Team === teamId);
  const hasPitching = data.pitching.some(r => r.Pitcher === playerName && r.Team === teamId);
  const isTwoWay = hasPitching && hasBatting;

  // Toggle defaults based on where the player was clicked from
  const [view, setView] = useState(
    isTwoWay ? (defaultView || "batting") : (hasPitching ? "pitching" : "batting")
  );

  const battingRows = useMemo(() =>
    data.batting.filter(r => r.Player === playerName && r.Team === teamId)
      .sort((a, b) => String(b.Game_Date).localeCompare(String(a.Game_Date))),
    [data, playerName, teamId]);

  const pitchingRows = useMemo(() =>
    data.pitching.filter(r => r.Pitcher === playerName && r.Team === teamId)
      .sort((a, b) => String(b.Game_Date).localeCompare(String(a.Game_Date))),
    [data, playerName, teamId]);

  const filterSlice = rows => {
    if (filterRange === "last10") return rows.slice(0, 10);
    if (filterRange === "last5") return rows.slice(0, 5);
    return rows;
  };

  const filteredBatting = filterSlice(battingRows);
  const filteredPitching = filterSlice(pitchingRows);

  const battingAgg = useMemo(() => hasBatting ? aggBatting(filteredBatting)[0] : null, [filteredBatting, hasBatting]);
  const pitchingAgg = useMemo(() => hasPitching ? aggPitching(filteredPitching)[0] : null, [filteredPitching, hasPitching]);

  const { sorted: sortedBattingLog, col: bCol, dir: bDir, toggle: bToggle } = useSort(filteredBatting, "Game_Date");
  const { sorted: sortedPitchingLog, col: pCol, dir: pDir, toggle: pToggle } = useSort(filteredPitching, "Game_Date");

  const role = view === "pitching" && pitchingAgg ? pitcherRole(pitchingAgg) : "Batter";

  const fmtDate = d => {
    const s = String(d);
    if (s.length >= 10 && s.includes("-")) return s.slice(5, 7) + "/" + s.slice(8, 10);
    const n = Number(d);
    if (n > 40000 && n < 60000) {
      const epoch = new Date(1899, 11, 30);
      const dt = new Date(epoch.getTime() + n * 86400000);
      return String(dt.getMonth() + 1).padStart(2, "0") + "/" + String(dt.getDate()).padStart(2, "0");
    }
    return s;
  };

  return (
    <div>
      <button className="back-btn" onClick={onBack}>{"← Back to "}{teamName(teamId)}</button>

      <div className="pi-header">
        <div className="pi-name">{playerName}</div>
        <div className="pi-team">{teamId}</div>
        <div className="pi-role">{role}</div>
      </div>

      {/* Pitching / Batting toggle — only for two-way players */}
      {isTwoWay && (
        <div className="pi-toggle">
          <button className={view === "pitching" ? "on" : ""} onClick={() => setView("pitching")}>Pitching</button>
          <button className={view === "batting" ? "on" : ""} onClick={() => setView("batting")}>Batting</button>
        </div>
      )}

      {/* Filter controls */}
      <div className="pi-filters">
        {["season", "last10", "last5"].map(f => (
          <button key={f} className={`pi-filter ${filterRange === f ? "on" : ""}`} onClick={() => setFilterRange(f)}>
            {f === "season" ? "Season" : f === "last10" ? "Last 10" : "Last 5"}
          </button>
        ))}
      </div>

      {/* Pitching view */}
      {view === "pitching" && pitchingAgg && (
        <>
          <div className="pi-summary">
            <div className="pi-sum-item"><div className="pi-sum-val">{fmtIP(pitchingAgg.Outs)}</div><div className="pi-sum-lbl">IP</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{fix2(pitchingAgg.ERA)}</div><div className="pi-sum-lbl">ERA</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{fix2(pitchingAgg.WHIP)}</div><div className="pi-sum-lbl">WHIP</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{pitchingAgg.K}</div><div className="pi-sum-lbl">K</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{pitchingAgg.BB}</div><div className="pi-sum-lbl">BB</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{fix1(pitchingAgg.Outs > 0 ? (pitchingAgg.K / (pitchingAgg.Outs / 3)) * 9 : 0)}</div><div className="pi-sum-lbl">K/9</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{pct(pitchingAgg.BBPct)}</div><div className="pi-sum-lbl">BB%</div></div>
          </div>
          <div className="tbl-wrap pi-table">
            <table>
              <thead>
                <tr>
                  <Th c="Game_Date" label="Date" s={pCol} d={pDir} fn={pToggle} left />
                  <Th c="Opponent" label="Opp" s={pCol} d={pDir} fn={pToggle} left />
                  <Th c="Outs_Recorded" label="IP" s={pCol} d={pDir} fn={pToggle} />
                  <Th c="R_Allowed" label="R" s={pCol} d={pDir} fn={pToggle} />
                  <Th c="H_Allowed" label="H" s={pCol} d={pDir} fn={pToggle} />
                  <Th c="BB_Allowed" label="BB" s={pCol} d={pDir} fn={pToggle} />
                  <Th c="K" label="K" s={pCol} d={pDir} fn={pToggle} />
                </tr>
              </thead>
              <tbody>
                {sortedPitchingLog.map((r, i) => (
                  <tr key={i}>
                    <td className="td-name">{fmtDate(r.Game_Date)}</td>
                    <td className="td-name">{r.Opponent}</td>
                    <td className="td-r">{fmtIP(num(r.Outs_Recorded))}</td>
                    <td className="td-r">{num(r.R_Allowed)}</td>
                    <td className="td-r">{num(r.H_Allowed)}</td>
                    <td className="td-r">{num(r.BB_Allowed)}</td>
                    <td className="td-r">{num(r.K)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Batting view */}
      {view === "batting" && battingAgg && (
        <>
          <div className="pi-summary">
            <div className="pi-sum-item"><div className="pi-sum-val">{battingAgg.G}</div><div className="pi-sum-lbl">G</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{battingAgg.PA}</div><div className="pi-sum-lbl">PA</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{avg3(battingAgg.AVG)}</div><div className="pi-sum-lbl">AVG</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{avg3(battingAgg.OBP)}</div><div className="pi-sum-lbl">OBP</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{avg3(battingAgg.SLG)}</div><div className="pi-sum-lbl">SLG</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{avg3(battingAgg.OPS)}</div><div className="pi-sum-lbl">OPS</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{battingAgg.HR}</div><div className="pi-sum-lbl">HR</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{battingAgg.SB}</div><div className="pi-sum-lbl">SB</div></div>
            <div className="pi-sum-item"><div className="pi-sum-val">{pct(safe(battingAgg.K, battingAgg.PA))}</div><div className="pi-sum-lbl">K%</div></div>
          </div>
          <div className="tbl-wrap pi-table">
            <table>
              <thead>
                <tr>
                  <Th c="Game_Date" label="Date" s={bCol} d={bDir} fn={bToggle} left />
                  <Th c="Opponent" label="Opp" s={bCol} d={bDir} fn={bToggle} left />
                  <Th c="PA" label="PA" s={bCol} d={bDir} fn={bToggle} />
                  <Th c="AB" label="AB" s={bCol} d={bDir} fn={bToggle} />
                  <Th c="H" label="H" s={bCol} d={bDir} fn={bToggle} />
                  <Th c="BB" label="BB" s={bCol} d={bDir} fn={bToggle} />
                  <Th c="K" label="K" s={bCol} d={bDir} fn={bToggle} />
                  <Th c="HR" label="HR" s={bCol} d={bDir} fn={bToggle} />
                  <Th c="RBI" label="RBI" s={bCol} d={bDir} fn={bToggle} />
                  <Th c="SB" label="SB" s={bCol} d={bDir} fn={bToggle} />
                  <Th c="CS" label="CS" s={bCol} d={bDir} fn={bToggle} />
                </tr>
              </thead>
              <tbody>
                {sortedBattingLog.map((r, i) => (
                  <tr key={i}>
                    <td className="td-name">{fmtDate(r.Game_Date)}</td>
                    <td className="td-name">{r.Opponent}</td>
                    <td className="td-r">{num(r.PA)}</td>
                    <td className="td-r">{num(r.AB)}</td>
                    <td className="td-r">{num(r.H)}</td>
                    <td className="td-r">{num(r.BB)}</td>
                    <td className="td-r">{num(r.K)}</td>
                    <td className="td-r">{num(r.HR)}</td>
                    <td className="td-r">{num(r.RBI)}</td>
                    <td className="td-r">{num(r.SB)}</td>
                    <td className="td-r">{num(r.CS)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function TeamsTab({ data, teams, teamsState, selectedTeam, selectedPlayer, defaultView, drawerState, setDrawerState, navigateToTeam, navigateToPlayer, navigateBack }) {
  const isDesktop = useWindowWidth() >= DESKTOP_BP;

  // State 3 (player intelligence) is always full-page
  if (teamsState === 3 && selectedPlayer && selectedTeam) {
    return (
      <PlayerIntelligence
        data={data}
        playerName={selectedPlayer}
        teamId={selectedTeam}
        defaultView={defaultView}
        onBack={() => navigateBack(2)}
      />
    );
  }

  // Mobile: existing full-page state machine
  if (!isDesktop) {
    if (teamsState === 2 && selectedTeam) {
      return (
        <TeamBriefing
          data={data}
          teamId={selectedTeam}
          drawerState={drawerState}
          setDrawerState={setDrawerState}
          onPlayerClick={(tid, name, dv) => navigateToPlayer(tid, name, dv)}
          onBack={() => navigateBack(1)}
        />
      );
    }
    return (
      <TeamsCardGrid
        data={data}
        teams={teams}
        onTeamClick={tid => navigateToTeam(tid)}
        activeTeam={null}
      />
    );
  }

  // Desktop: master-detail two-column layout
  return (
    <div className="teams-layout">
      <div className="teams-col-left">
        <TeamsCardGrid
          data={data}
          teams={teams}
          onTeamClick={tid => navigateToTeam(tid)}
          activeTeam={teamsState === 2 ? selectedTeam : null}
          desktopMode
        />
      </div>
      <div className="teams-col-right">
        {teamsState === 2 && selectedTeam ? (
          <TeamBriefing
            data={data}
            teamId={selectedTeam}
            drawerState={drawerState}
            setDrawerState={setDrawerState}
            onPlayerClick={(tid, name, dv) => navigateToPlayer(tid, name, dv)}
            onBack={() => navigateBack(1)}
          />
        ) : (
          <TeamsCardGrid
            data={data}
            teams={teams}
            onTeamClick={tid => navigateToTeam(tid)}
            activeTeam={null}
            rightPanelOnly
          />
        )}
      </div>
    </div>
  );
}

// ─── ASK TAB ─────────────────────────────────────────────────────────────────

function AskTab({ data }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const inpRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  const ctx = useMemo(() => buildChatSystem(data), [data]);

  const SUGS = [
    "How many players across all teams have hit a home run?",
    "Which team has the best ERA in the full repository?",
    "Who leads all scouted teams in batting average (min 10 PA)?",
    "Which pitcher has the best K/BB ratio (min 6 outs)?",
    "How does RVRH's walk rate compare to the teams they've faced?",
  ];

  const send = async text => {
    const q = (text || input).trim();
    if (!q || busy) return;
    setInput("");
    const next = [...msgs, { role: "user", text: q }];
    setMsgs(next);
    setBusy(true);
    try {
      const history = next.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1024, system: ctx, messages: history }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error.message);
      const reply = d.content?.find(b => b.type === "text")?.text || "No response.";
      setMsgs(prev => [...prev, { role: "ai", text: reply }]);
    } catch (e) {
      setMsgs(prev => [...prev, { role: "ai", text: `Error: ${e.message}` }]);
    } finally {
      setBusy(false);
      setTimeout(() => inpRef.current?.focus(), 50);
    }
  };

  return (
    <div className="ask-wrap" style={{ marginTop: 16 }}>
      <div className="ask-msgs">
        {msgs.length === 0 ? (
          <div className="ask-empty">
            <h3>Scout Assistant</h3>
            <p>{"Ask anything \u2014 any team, any player, any stat across the full repository."}</p>
            <div className="ask-sugs">
              {SUGS.map(s => <button key={s} className="ask-sug" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        ) : msgs.map((m, i) => (
          <div key={i} className={`ask-msg ${m.role === "user" ? "user" : "ai"}`}>
            <div className="ask-av">{m.role === "user" ? "you" : "AI"}</div>
            <div className="ask-bbl">{m.text}</div>
          </div>
        ))}
        {busy && (
          <div className="ask-msg ai">
            <div className="ask-av">AI</div>
            <div className="ask-bbl"><div className="ask-dots"><div className="ask-dot"/><div className="ask-dot"/><div className="ask-dot"/></div></div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="ask-bar">
        <input ref={inpRef} className="ask-inp" placeholder="Ask about any team, player, or stat..."
          value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()} disabled={busy} />
        <button className="ask-send" onClick={() => send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </div>
  );
}

// ─── REPORT TAB ──────────────────────────────────────────────────────────────

function buildMapPrompt(query) {
  return `You are a baseball data analyst. You will receive a full play-by-play game log in markdown format.

Your task: ${query}

Analyze the play-by-play data carefully. Extract the requested information from this single game.

Return ONLY valid JSON — no markdown fences, no explanation, no commentary. Use this exact structure:

{"game_id": "the Game_ID from the header",
 "date": "YYYY-MM-DD",
 "away_team": "4-letter code",
 "home_team": "4-letter code",
 "data": [
   ... array of extracted records, one per relevant unit (player, inning, team, etc.) ...
 ]}

Rules for the "data" array:
- Each record must be a FLAT object — no nested arrays, no nested objects
- One row per smallest unit of analysis (e.g., one row per plate appearance, not one row per batter with a nested array of PAs)
- Use consistent field names across all records
- Use numeric values for counts and rates (not strings)
- Include only fields relevant to the query
- If no data matches the query for this game, return an empty "data" array
- For percentages, return as decimal (0.667 not "66.7%")
- For player names, use exactly the name as it appears in the play log

CRITICAL: Never nest arrays or objects inside a record. Every value must be a string, number, or boolean. If you need to represent multiple events per player, create one row per event, not one row per player with a sub-array.`;
}

function ReportTab({ data }) {
  const [teamFilter, setTeamFilter] = useState("");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [homeAway, setHomeAway] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0, currentGame: "" });
  const [results, setResults] = useState([]);
  const [logs, setLogs] = useState([]);

  // All unique team codes from game log
  const allTeamCodes = useMemo(() => {
    const codes = new Set();
    (data.gameLog || []).forEach(g => {
      if (g.Away_Team) codes.add(g.Away_Team);
      if (g.Home_Team) codes.add(g.Home_Team);
    });
    return [...codes].sort();
  }, [data]);

  // Filter games
  const selectedGames = useMemo(() => {
    return (data.gameLog || []).filter(g => {
      const gid = g.Game_ID || "";
      const away = g.Away_Team || "";
      const home = g.Home_Team || "";
      const date = String(g.Game_Date || "");

      if (teamFilter) {
        if (homeAway === "home" && home !== teamFilter) return false;
        if (homeAway === "away" && away !== teamFilter) return false;
        if (homeAway === "all" && away !== teamFilter && home !== teamFilter) return false;
      }
      if (dateAfter && date < dateAfter) return false;
      if (dateBefore && date > dateBefore) return false;
      return true;
    }).sort((a, b) => String(a.Game_Date || "").localeCompare(String(b.Game_Date || "")));
  }, [data, teamFilter, dateAfter, dateBefore, homeAway]);

  const runReport = async () => {
    if (!query.trim() || selectedGames.length === 0) return;
    setStatus("running");
    setResults([]);
    setLogs([]);
    const systemPrompt = buildMapPrompt(query.trim());
    const allResults = [];
    const runLogs = [];

    for (let i = 0; i < selectedGames.length; i++) {
      const game = selectedGames[i];
      const gid = game.Game_ID;
      setProgress({ current: i + 1, total: selectedGames.length, currentGame: gid });

      try {
        // Fetch game markdown
        const mdResp = await fetch(`/games/${gid}.md`);
        if (!mdResp.ok) {
          runLogs.push({ gid, status: "skip", note: "file not found" });
          continue;
        }
        const mdText = await mdResp.text();

        // Call Claude via existing proxy
        const apiResp = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: mdText }],
          }),
        });
        const apiData = await apiResp.json();
        if (apiData.error) {
          runLogs.push({ gid, status: "error", note: apiData.error.message });
          continue;
        }
        const text = apiData.content?.find(b => b.type === "text")?.text || "";
        // Parse JSON — strip markdown fences if present
        const clean = text.replace(/^```json\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
        const parsed = JSON.parse(clean);
        const count = (parsed.data || []).length;
        allResults.push(parsed);
        runLogs.push({ gid, status: "ok", note: `${count} records` });
      } catch (e) {
        runLogs.push({ gid, status: "error", note: e.message });
      }

      // Rate limit delay (skip on last game)
      if (i < selectedGames.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Reduce: flatten per-game results into rows
    // Handles nested arrays/objects that Claude sometimes returns
    const rows = [];
    for (const r of allResults) {
      if (!r || !r.data) continue;
      const meta = {
        game_id: r.game_id || "", date: r.date || "",
        away_team: r.away_team || "", home_team: r.home_team || "",
      };
      for (const record of r.data) {
        // Check if any value is an array — if so, expand into multiple rows
        const arrayKey = Object.keys(record).find(k => Array.isArray(record[k]));
        if (arrayKey && record[arrayKey].length > 0 && typeof record[arrayKey][0] === "object") {
          // Nested array of objects: expand each sub-object into its own row
          const parentFields = {};
          for (const [k, v] of Object.entries(record)) {
            if (k !== arrayKey && !Array.isArray(v) && typeof v !== "object") parentFields[k] = v;
          }
          for (const sub of record[arrayKey]) {
            if (typeof sub === "object" && sub !== null) {
              rows.push({ ...meta, ...parentFields, ...sub });
            }
          }
        } else {
          // Flat record — stringify any remaining objects/arrays as fallback
          const flat = { ...meta };
          for (const [k, v] of Object.entries(record)) {
            flat[k] = (v !== null && typeof v === "object") ? JSON.stringify(v) : v;
          }
          rows.push(flat);
        }
      }
    }

    setResults(rows);
    setLogs(runLogs);
    setStatus("done");
  };

  const downloadCSV = () => {
    if (results.length === 0) return;
    const allKeys = [];
    const seen = new Set();
    for (const row of results) {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) { allKeys.push(k); seen.add(k); }
      }
    }
    const lines = [allKeys.join(",")];
    for (const row of results) {
      lines.push(allKeys.map(k => {
        const v = row[k] ?? "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const okCount = logs.filter(l => l.status === "ok").length;
  const errCount = logs.filter(l => l.status !== "ok").length;

  return (
    <div style={{ marginTop: 16 }}>
      {/* Filter form */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--navy)", textTransform: "uppercase", letterSpacing: "0.7px", display: "block", marginBottom: 4 }}>Team</label>
            <select className="ask-inp" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}
              style={{ width: "100%", padding: "9px 12px", cursor: "pointer" }}>
              <option value="">All teams</option>
              {allTeamCodes.map(c => <option key={c} value={c}>{teamName(c)} ({c})</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--navy)", textTransform: "uppercase", letterSpacing: "0.7px", display: "block", marginBottom: 4 }}>Home / Away</label>
            <select className="ask-inp" value={homeAway} onChange={e => setHomeAway(e.target.value)}
              style={{ width: "100%", padding: "9px 12px", cursor: "pointer" }}>
              <option value="all">All games</option>
              <option value="home">Home only</option>
              <option value="away">Away only</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--navy)", textTransform: "uppercase", letterSpacing: "0.7px", display: "block", marginBottom: 4 }}>After</label>
            <input type="date" className="ask-inp" value={dateAfter} onChange={e => setDateAfter(e.target.value)}
              style={{ width: "100%", padding: "9px 12px" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--navy)", textTransform: "uppercase", letterSpacing: "0.7px", display: "block", marginBottom: 4 }}>Before</label>
            <input type="date" className="ask-inp" value={dateBefore} onChange={e => setDateBefore(e.target.value)}
              style={{ width: "100%", padding: "9px 12px" }} />
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--navy)", textTransform: "uppercase", letterSpacing: "0.7px", display: "block", marginBottom: 4 }}>Query</label>
          <textarea className="ask-inp" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="e.g., first pitch strike percentage by pitcher"
            rows={2} style={{ width: "100%", padding: "9px 12px", resize: "vertical", fontFamily: "'Nunito Sans'" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button className="ask-send" onClick={runReport}
            disabled={status === "running" || !query.trim() || selectedGames.length === 0}
            style={{ padding: "10px 24px", minHeight: 44 }}>
            {status === "running" ? "Running..." : "Run Report"}
          </button>
          <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600 }}>
            {selectedGames.length} game{selectedGames.length !== 1 ? "s" : ""} selected
            {selectedGames.length > 0 && ` · ~$${(selectedGames.length * 0.01).toFixed(2)} est.`}
          </span>
        </div>
      </div>

      {/* Progress */}
      {status === "running" && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>
            <span>Processing {progress.current}/{progress.total}</span>
            <span className="mono" style={{ color: "var(--muted)" }}>{progress.currentGame}</span>
          </div>
          <div style={{ height: 8, background: "var(--s3)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(progress.current / progress.total) * 100}%`, background: "var(--navy)", borderRadius: 4, transition: "width 0.3s" }} />
          </div>
        </div>
      )}

      {/* Results */}
      {status === "done" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>
              {results.length} rows · {okCount} games processed{errCount > 0 ? ` · ${errCount} skipped` : ""}
            </span>
            {results.length > 0 && (
              <div style={{ display: "flex", gap: 8 }}>
                <button className="ask-send" onClick={() => {
                  const allKeys = [...new Set(results.flatMap(r => Object.keys(r)))];
                  const tsv = [allKeys.join("\t"), ...results.map(r => allKeys.map(k => r[k] ?? "").join("\t"))].join("\n");
                  navigator.clipboard.writeText(tsv).then(() => {
                    const btn = document.getElementById("copy-btn");
                    if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy for Sheets"; }, 2000); }
                  });
                }} id="copy-btn" style={{ padding: "8px 18px", fontSize: 13, background: "var(--s1)", color: "var(--navy)", border: "1px solid var(--bd)" }}>
                  Copy for Sheets
                </button>
                <button className="ask-send" onClick={downloadCSV} style={{ padding: "8px 18px", fontSize: 13 }}>
                  Download CSV
                </button>
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div className="tbl-wrap" style={{ maxHeight: 500, overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    {Object.keys(results[0]).map(k => (
                      <th key={k} style={{ textAlign: "left", position: "sticky", top: 0 }}>{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((row, i) => (
                    <tr key={i}>
                      {Object.values(row).map((v, j) => (
                        <td key={j}>{typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : String(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Processing log */}
          {logs.length > 0 && errCount > 0 && (
            <details style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Processing log ({errCount} issues)</summary>
              <div style={{ marginTop: 6, fontFamily: "monospace", fontSize: 11 }}>
                {logs.filter(l => l.status !== "ok").map((l, i) => (
                  <div key={i}>{l.gid}: {l.note}</div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("League");
  const [teamsState, setTeamsState] = useState(1);
  const [teamsSelectedTeam, setTeamsSelectedTeam] = useState(null);
  const [teamsSelectedPlayer, setTeamsSelectedPlayer] = useState(null);
  const [teamsPlayerDefaultView, setTeamsPlayerDefaultView] = useState("batting");
  const [teamsDrawerState, setTeamsDrawerState] = useState({ pitching: true, lineup: false, discipline: false });

  const teams = useMemo(() => data ? classifyTeams(data) : { focal: [], opponents: [], all: [] }, [data]);

  useEffect(() => {
    fetch("/repository.json")
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(json => {
        setData(parseData(json));
      })
      .catch(err => console.error("Failed to load data:", err));
  }, []);

  const navigateToTeam = useCallback(teamId => {
    setTab("Teams");
    setTeamsState(2);
    setTeamsSelectedTeam(teamId);
    setTeamsSelectedPlayer(null);
  }, []);

  const navigateToPlayer = useCallback((teamId, playerName, defaultView) => {
    setTeamsSelectedTeam(teamId);
    setTeamsSelectedPlayer(playerName);
    setTeamsPlayerDefaultView(defaultView || "batting");
    setTeamsState(3);
  }, []);

  const navigateBack = useCallback(toState => {
    if (toState === 1) {
      setTeamsState(1);
      setTeamsSelectedTeam(null);
      setTeamsSelectedPlayer(null);
      setTeamsDrawerState({ pitching: true, lineup: false, discipline: false });
    } else if (toState === 2) {
      setTeamsState(2);
      setTeamsSelectedPlayer(null);
    }
  }, []);

  if (!data) return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <div className="topbar">
          <span className="brand">HAWKS <span>Scouting</span></span>
        </div>
        <div className="loading-wrap"><p>{"Loading scouting data..."}</p></div>
      </div>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <div className="topbar">
          <span className="brand">HAWKS <span>Scouting</span></span>
          <span className="spacer" />
        </div>

        <div className="tabs">
          {["League", "Teams", "Ask", "Report"].map(t => (
            <div key={t} className={`tab ${tab === t ? "on" : ""}`}
              onClick={() => {
                setTab(t);
                if (t === "Teams") { setTeamsState(1); setTeamsSelectedTeam(null); setTeamsSelectedPlayer(null); }
              }}>
              {t}
            </div>
          ))}
        </div>

        <div className="main">
          {tab === "League" && (
            <LeagueTab data={data} teams={teams} onTeamClick={navigateToTeam} />
          )}
          {tab === "Teams" && (
            <TeamsTab
              data={data} teams={teams}
              teamsState={teamsState}
              selectedTeam={teamsSelectedTeam}
              selectedPlayer={teamsSelectedPlayer}
              defaultView={teamsPlayerDefaultView}
              drawerState={teamsDrawerState}
              setDrawerState={setTeamsDrawerState}
              navigateToTeam={tid => { setTeamsSelectedTeam(tid); setTeamsState(2); }}
              navigateToPlayer={navigateToPlayer}
              navigateBack={navigateBack}
            />
          )}
          {tab === "Ask" && <AskTab data={data} />}
          {tab === "Report" && <ReportTab data={data} />}
        </div>
      </div>
    </>
  );
}
