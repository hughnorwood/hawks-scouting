import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";

// ─── helpers ──────────────────────────────────────────────────────────────────
const num  = v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
const safe = (a, b) => b > 0 ? a / b : 0;
const pct  = v => !isFinite(v) || isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`;
const avg3 = v => !isFinite(v) || isNaN(v) ? ".000" : v >= 1 ? v.toFixed(3) : "." + v.toFixed(3).slice(2);
const fix2 = v => !isFinite(v) || isNaN(v) || v > 99 ? "—" : v.toFixed(2);
const fix1 = v => !isFinite(v) || isNaN(v) || v > 99 ? "—" : v.toFixed(1);
const fmtIP = outs => `${Math.floor(outs / 3)}.${outs % 3}`;
const clamp = (v, max) => v > max ? max : v;

// ─── parsing ──────────────────────────────────────────────────────────────────
function parseWorkbook(wb) {
  const get = n => { const ws = wb.Sheets[n]; return ws ? XLSX.utils.sheet_to_json(ws, { defval: "" }) : []; };
  return { gameLog: get("Game_Log"), batting: get("Batting"), pitching: get("Pitching"), fielding: get("Fielding") };
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
    if (!m[p]) m[p] = { Player: p, G: new Set(), PA:0, AB:0, H:0, "1B":0, "2B":0, "3B":0, HR:0, BB:0, HBP:0, K:0, R:0, RBI:0, SB:0, CS:0 };
    if (r.Game_ID) m[p].G.add(r.Game_ID);
    ["PA","AB","H","1B","2B","3B","HR","BB","HBP","K","R","RBI","SB","CS"].forEach(k => m[p][k] += num(r[k]));
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
    if (!m[p]) m[p] = { Pitcher: p, G: new Set(), Outs:0, BF:0, H:0, BB:0, K:0, R:0, HR:0, WP:0 };
    if (r.Game_ID) m[p].G.add(r.Game_ID);
    m[p].Outs += num(r.Outs_Recorded); m[p].BF += num(r.BF);
    m[p].H += num(r.H_Allowed); m[p].BB += num(r.BB_Allowed);
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

// Hitter Threat: OBP×40% + SLG×30% + (RBI/H)×15% + Contact(1−K/PA)×15%
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

// Pitcher Impact: K/9 norm×30% + Control norm×25% + ERA norm×25% + WHIP norm×20%
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

// Playoff Threat Matrix — opponent teams only
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
  // Composite: winPct(30) + offense(25) + pitching(25) + defense(20)
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

// Defensive Targets — error-prone players on a team
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

// Matchup Exploits — auto-generated strategy bullets for focal vs opponent
function matchupExploits(sA, sB, teamAId, teamBId) {
  const exploits = [];
  // High ERA opponent = attack early
  if (sB.ERA >= 5) exploits.push({ cat: "offense", text: `${teamBId} team ERA ${fix2(sB.ERA)} — attack early in counts, force them to throw strikes` });
  else if (sB.ERA >= 3.5) exploits.push({ cat: "offense", text: `${teamBId} ERA ${fix2(sB.ERA)} — be selective, wait for mistakes` });
  // High WHIP = free baserunners
  if (sB.WHIP >= 1.8) exploits.push({ cat: "offense", text: `${teamBId} WHIP ${fix2(sB.WHIP)} — patience at the plate, high walk/HBP opportunity` });
  // Walk-prone pitching
  if (sB.BBPct >= 0.12) exploits.push({ cat: "offense", text: `${teamBId} BB% ${pct(sB.BBPct)} — take pitches, draw walks, extend innings` });
  // Stolen base opportunity vs errors
  if (sB.errors >= 3 && sA.teamSB >= 4) exploits.push({ cat: "baserunning", text: `${teamBId} ${sB.errors} errors — run aggressively, put pressure on defense` });
  else if (sB.errors >= 2) exploits.push({ cat: "baserunning", text: `${teamBId} error-prone (${sB.errors} E) — force plays, exploit defensive miscues` });
  // Pitching approach vs opponent lineup
  if (sB.teamAVG >= 0.300) exploits.push({ cat: "pitching", text: `${teamBId} AVG ${avg3(sB.teamAVG)} — pitch to weak contact, avoid middle of zone` });
  if ((sB.teamOBP + sB.teamSLG) >= 0.800) exploits.push({ cat: "pitching", text: `${teamBId} OPS ${avg3(sB.teamOBP + sB.teamSLG)} — change speeds, keep hitters off-balance` });
  // K-prone lineup
  const tPA = sB.batters.reduce((s,r) => s + r.PA, 0);
  const tK  = sB.batters.reduce((s,r) => s + r.K, 0);
  const oppKPct = safe(tK, tPA);
  if (oppKPct >= 0.22) exploits.push({ cat: "pitching", text: `${teamBId} K% ${pct(oppKPct)} — attack zone aggressively, use breaking stuff ahead in count` });
  // Our strengths to leverage
  if (sA.KBB >= 2.5) exploits.push({ cat: "advantage", text: `${teamAId} K/BB ${fix1(sA.KBB)} — elite command, trust pitching to control game` });
  if (sA.teamSB >= 6) exploits.push({ cat: "advantage", text: `${teamAId} ${sA.teamSB} SB — speed is a weapon, run at every opportunity` });
  if (sA.ERA <= 2.5) exploits.push({ cat: "advantage", text: `${teamAId} ERA ${fix2(sA.ERA)} — pitching will keep you in every game, play small ball` });
  return exploits;
}

// Opponent Rotations — identify starters and their patterns
function opponentRotation(data, teamId) {
  const games = data.gameLog.filter(g => g.Away_Team === teamId || g.Home_Team === teamId)
    .sort((a, b) => String(a.Game_Date).localeCompare(String(b.Game_Date)));
  const starters = [];
  for (const g of games) {
    const pRows = data.pitching.filter(r => r.Team === teamId && r.Game_ID === g.Game_ID)
      .sort((a, b) => num(b.Outs_Recorded) - num(a.Outs_Recorded));
    if (pRows.length > 0) {
      // First pitcher listed (or one with most outs) is likely starter
      const starter = pRows[0];
      starters.push({ pitcher: starter.Pitcher, gameId: g.Game_ID, date: g.Game_Date, outs: num(starter.Outs_Recorded), IP: fmtIP(num(starter.Outs_Recorded)) });
    }
  }
  // Aggregate per pitcher
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
async function callClaude(system, user, maxTokens = 1500, endpoint = "/api/ktg") {
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

function buildKTGSystem(data, teamA, teamB) {
  const focalCounts = {};
  data.gameLog.forEach(g => { if (g.Focal_Team) focalCounts[g.Focal_Team] = (focalCounts[g.Focal_Team] || 0) + 1; });
  const isFocal = id => (focalCounts[id] || 0) >= 4;

  const snap = id => {
    const s = teamSummary(data, id);
    const focal = isFocal(id);
    const tier = focal
      ? `FOCAL — ${s.G} games`
      : `OPPONENT INTEL — ${s.G} game${s.G !== 1 ? "s" : ""} — treat as limited sample`;

    const pp = [...s.pitchers].sort((a, b) => b.Outs - a.Outs).slice(0, 4).map(p => {
      const reliable = p.Outs >= 24;
      const imp = pitcherImpact(p);
      const tierTag = imp.tier !== "LIMITED" ? `,Impact=${imp.tier}` : "";
      return reliable
        ? `${p.Pitcher}[IP=${fmtIP(p.Outs)},ERA=${fix2(p.ERA)},WHIP=${fix2(p.WHIP)},K=${p.K},BB=${p.BB},K/BB=${fix1(clamp(p.KBB,20))},BB%=${pct(p.BBPct)}${tierTag}]`
        : `${p.Pitcher}[LIMITED,IP=${fmtIP(p.Outs)},K=${p.K},BB=${p.BB}]`;
    }).join(" ");

    const bp = [...s.batters].sort((a, b) => b.PA - a.PA).slice(0, 6).map(b => {
      const reliable = b.PA >= 12;
      const ht = hitterThreat(b);
      const tierTag = ht.tier !== "LIMITED" ? `,Threat=${ht.tier}` : "";
      return reliable
        ? `${b.Player}[PA=${b.PA},AVG=${avg3(b.AVG)},OPS=${avg3(b.OPS)},HR=${b.HR},SB=${b.SB},BB%=${pct(safe(b.BB,b.PA))},K%=${pct(safe(b.K,b.PA))}${tierTag}]`
        : `${b.Player}[LIMITED,PA=${b.PA},HR=${b.HR},SB=${b.SB}]`;
    }).join(" ");

    return `=== ${id} [${tier}] ===
Record: ${s.W}-${s.L} · ERA ${fix2(s.ERA)} · WHIP ${fix2(s.WHIP)} · K/BB ${fix1(clamp(s.KBB,20))} · TeamAVG ${avg3(s.teamAVG)} · TeamOPS ${avg3(s.teamOBP+s.teamSLG)} · SB ${s.teamSB} · HR ${s.teamHR} · Errors ${s.errors}
Pitchers: ${pp || "none"}
Batters: ${bp || "none"}`;
  };

  return `You are a HS baseball analyst. Produce "Keys to the Game" for ${teamA} vs ${teamB}.
Return ONLY valid JSON — no markdown, no backticks, no explanation.

${snap(teamA)}

${snap(teamB)}

SIGNAL RULES:
- [LIMITED] players: cite only counting stats (HR, SB, K). No rate stats.
- OPPONENT INTEL teams: qualify every claim with "in limited data".
- FOCAL teams with reliable players: strong, direct claims appropriate.
- Threat=ELITE or HIGH batters: call them out by name as key matchup dangers.
- Impact=ACE or QUALITY pitchers: emphasize their dominance or vulnerability.
- Team-level totals (ERA, WHIP, TeamAVG, SB, Errors) are always reliable.

OUTPUT: For each team, produce three sections from THAT TEAM'S perspective — what they must do to win:
- hitting: how this team should attack the opponent's pitching. Exactly 3 keys.
- pitching: how this team's pitchers should attack the opponent's lineup. Exactly 3 keys.
- strategy: baserunning, stolen bases, error tendencies, defensive edge. Exactly 2 keys.

CRITICAL — each key must be 10 words or fewer. Format: "[Evidence] — [Action]"
Good examples:
  "Walsh BB%=14% — draw walks, extend every AB"
  "Opp K%=28% — pound zone, make them earn hits"
  "12 team SBs — run early, exploit slow delivery"
  "3 errors/game — put ball in play, force chances"
Numbers first. One sharp action required. No filler words.

JSON format:
{"teamA":{"hitting":["","",""],"pitching":["","",""],"strategy":["",""]},"teamB":{"hitting":["","",""],"pitching":["","",""],"strategy":["",""]}}`;
}

function buildChatSystem(data) {
  const tab = (rows, cols) => [cols.join("\t"), ...rows.map(r => cols.map(c => r[c] ?? "").join("\t"))].join("\n");
  const teams = classifyTeams(data);

  // Pre-aggregate team summaries
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

  // Pre-aggregate batting — one row per player per team (season totals)
  const batters = teams.all.flatMap(id =>
    aggBatting(data.batting.filter(r => r.Team === id))
      .map(r => ({ Team: id, ...r,
        AVG: avg3(r.AVG), OBP: avg3(r.OBP), SLG: avg3(r.SLG), OPS: avg3(r.OPS) }))
  ).sort((a, b) => b.PA - a.PA);

  // Pre-aggregate pitching — one row per pitcher per team (season totals)
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

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `

@import url('https://fonts.googleapis.com/css2?family=Nunito+Sans:opsz,wght@6..12,300;6..12,400;6..12,500;6..12,600;6..12,700;6..12,800&display=swap');

:root {
  --bg:    #EEF2F8;
  --s1:    #FFFFFF;
  --s2:    #F3F6FB;
  --s3:    #E4ECF5;
  --bd:    #C8D5E8;
  --bd2:   #A8BDD8;
  --navy:  #002868;
  --navy2: #003DA6;
  --gold:  #E8A020;
  --gold-d:rgba(232,160,32,.12);
  --gold-t:#8B5008;
  --red:   #B83030;
  --red-d: rgba(184,48,48,.1);
  --green: #1A7040;
  --green-d:rgba(26,112,64,.1);
  --blue:  #4A90D4;
  --blue-d:rgba(74,144,212,.12);
  --amber: #B86010;
  --amber-d:rgba(184,96,16,.1);
  --muted: #6888A8;
  --text:  #0D2240;
  --text2: #3A5070;
  --radius:8px;
}
*, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--text); font-family:'Nunito Sans',sans-serif; font-size:15px; -webkit-font-smoothing:antialiased; }

/* layout */
.app { min-height:100vh; }
.topbar { height:56px; border-bottom:2px solid var(--navy); display:flex; align-items:center; padding:0 20px; gap:14px; position:sticky; top:0; background:var(--navy); z-index:100; }
.brand { font-size:18px; font-weight:800; color:#FFFFFF; letter-spacing:1.5px; white-space:nowrap; }
.brand span { color:var(--gold); }
.focal-select { background:rgba(255,255,255,.15); border:1px solid rgba(255,255,255,.3); border-radius:6px; color:#FFFFFF; font-family:'Nunito Sans'; font-size:13px; padding:5px 10px; outline:none; cursor:pointer; }
.focal-select option { background:var(--navy); color:#fff; }
.focal-select:focus { border-color:var(--gold); }
.spacer { flex:1; }
.load-btn { background:none; border:1px solid rgba(255,255,255,.4); border-radius:6px; color:rgba(255,255,255,.85); font-family:'Nunito Sans'; font-size:12px; padding:5px 12px; cursor:pointer; transition:all .15s; }
.load-btn:hover { border-color:#fff; color:#fff; }
.tabs { display:flex; border-bottom:1px solid var(--bd); padding:0 20px; background:var(--s1); }
.tab { font-family:'Nunito Sans'; font-weight:600; font-size:14px; padding:12px 18px; cursor:pointer; color:var(--muted); border-bottom:3px solid transparent; transition:all .15s; white-space:nowrap; letter-spacing:.3px; }
.tab:hover { color:var(--navy); }
.tab.on { color:var(--navy); border-bottom-color:var(--gold); font-weight:700; }
.main { padding:20px; max-width:1280px; margin:0 auto; }

/* upload */
.upload-wrap { max-width:480px; margin:4rem auto; }
.upload-zone { border:2px dashed var(--bd2); border-radius:var(--radius); padding:3rem 2rem; text-align:center; cursor:pointer; transition:all .15s; background:var(--s1); }
.upload-zone:hover, .upload-zone.drag { border-color:var(--navy); background:var(--s2); }
.upload-zone h2 { font-weight:800; font-size:22px; margin:12px 0 6px; color:var(--navy); }
.upload-zone p { font-size:13px; color:var(--muted); }
.upload-btn { background:var(--navy); color:#fff; border:none; border-radius:6px; font-family:'Nunito Sans'; font-weight:700; font-size:14px; padding:10px 22px; cursor:pointer; margin-top:16px; transition:opacity .15s; }
.upload-btn:hover { opacity:.88; }

/* cards / surfaces */
.card { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); box-shadow:0 1px 3px rgba(0,40,104,.06); }
.stat-card { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:16px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.stat-card-label { font-family:'Nunito Sans'; font-size:10px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
.stat-card-value { font-family:'Nunito Sans'; font-size:30px; font-weight:800; line-height:1; color:var(--navy); font-variant-numeric:tabular-nums; }
.stat-card-sub { font-size:12px; color:var(--muted); margin-top:4px; }
.g4 { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:18px; }
.g3 { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
.g2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
@media(max-width:800px) { .g4{grid-template-columns:repeat(2,1fr)} .g3{grid-template-columns:1fr 1fr} .g2{grid-template-columns:1fr} }

/* section headers */
.sec-title { font-family:'Nunito Sans'; font-size:10px; font-weight:800; color:var(--navy); text-transform:uppercase; letter-spacing:1.2px; padding-bottom:10px; border-bottom:2px solid var(--navy); margin-bottom:14px; }

/* tables */
.tbl-wrap { border:1px solid var(--bd); border-radius:var(--radius); overflow:hidden; box-shadow:0 1px 3px rgba(0,40,104,.06); }
table { width:100%; border-collapse:collapse; }
thead th { padding:10px 12px; text-align:left; font-size:11px; font-family:'Nunito Sans'; font-weight:700; color:var(--navy); text-transform:uppercase; letter-spacing:.8px; background:var(--s2); border-bottom:2px solid var(--bd); cursor:pointer; user-select:none; white-space:nowrap; }
thead th:hover, thead th.on { color:var(--gold-t); }
tbody td { padding:10px 12px; font-size:13px; border-bottom:1px solid var(--bd); font-variant-numeric:tabular-nums; }
tbody tr:last-child td { border-bottom:none; }
tbody tr:hover td { background:var(--s2); cursor:pointer; }
.mono { font-family:'Nunito Sans'; font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; }
.c-g { color:var(--green); } .c-r { color:var(--red); } .c-a { color:var(--gold-t); } .c-b { color:var(--blue); } .c-m { color:var(--muted); }
.td-r { text-align:right; }

/* badges */
.badge { display:inline-block; font-size:10px; font-family:'Nunito Sans'; font-weight:700; padding:2px 7px; border-radius:4px; white-space:nowrap; }
.b-gold   { background:rgba(232,160,32,.15); color:var(--gold-t);  border:1px solid rgba(232,160,32,.4); }
.b-green  { background:var(--green-d);        color:var(--green);   border:1px solid rgba(26,112,64,.3); }
.b-red    { background:var(--red-d);           color:var(--red);     border:1px solid rgba(184,48,48,.3); }
.b-blue   { background:var(--blue-d);          color:var(--blue);    border:1px solid rgba(74,144,212,.35); }
.b-amber  { background:var(--amber-d);         color:var(--amber);   border:1px solid rgba(184,96,16,.3); }
.b-muted  { background:var(--s3);              color:var(--muted);   border:1px solid var(--bd); }

/* focal indicator */
.focal-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--gold); margin-right:7px; flex-shrink:0; }
.opp-dot   { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--bd2); margin-right:7px; flex-shrink:0; }

/* back button */
.back-btn { background:var(--s1); border:1px solid var(--bd); border-radius:6px; color:var(--text2); font-family:'Nunito Sans'; font-size:13px; font-weight:600; padding:7px 14px; cursor:pointer; margin-bottom:14px; display:inline-flex; align-items:center; gap:6px; transition:all .15s; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.back-btn:hover { border-color:var(--navy); color:var(--navy); }

/* matchup */
.mu-selectors { display:grid; grid-template-columns:1fr 40px 1fr; gap:12px; align-items:center; margin-bottom:14px; }
.mu-team-card { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:14px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.mu-label { font-size:10px; font-family:'Nunito Sans'; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.8px; margin-bottom:8px; }
.mu-select { width:100%; background:var(--s1); border:1px solid var(--bd2); border-radius:6px; color:var(--text); font-family:'Nunito Sans'; font-size:14px; padding:9px 11px; outline:none; cursor:pointer; }
.mu-select:focus { border-color:var(--navy); box-shadow:0 0 0 3px rgba(0,40,104,.12); }
.vs-text { font-weight:800; font-size:18px; color:var(--muted); text-align:center; }
.gen-btn { background:var(--navy); color:#fff; border:none; border-radius:8px; font-family:'Nunito Sans'; font-weight:700; font-size:15px; padding:13px 24px; cursor:pointer; width:100%; transition:all .15s; margin-bottom:20px; display:flex; align-items:center; justify-content:center; gap:8px; letter-spacing:.3px; }
.gen-btn:hover { background:var(--navy2); }
.gen-btn:disabled { opacity:.4; cursor:not-allowed; }

/* H2H bars */
.h2h-wrap { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:20px 24px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.h2h-header { display:grid; grid-template-columns:1fr 110px 1fr; gap:8px; align-items:center; margin-bottom:16px; padding-bottom:12px; border-bottom:2px solid var(--navy); }
.h2h-team-name { font-weight:800; font-size:18px; color:var(--navy); letter-spacing:.5px; }
.h2h-team-name.right { text-align:right; }
.h2h-row { display:grid; grid-template-columns:1fr 110px 1fr; gap:8px; align-items:center; margin-bottom:10px; }
.h2h-val { font-family:'Nunito Sans'; font-size:14px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--text2); }
.h2h-val.right { text-align:right; }
.h2h-val.win  { color:var(--navy); font-weight:800; }
.h2h-val.lose { color:var(--muted); }
.h2h-metric-label { font-size:9px; font-family:'Nunito Sans'; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.8px; text-align:center; white-space:nowrap; }
.h2h-bar-a { height:6px; border-radius:3px 0 0 3px; }
.h2h-bar-b { height:6px; border-radius:0 3px 3px 0; }

/* Keys to the Game */
.ktg-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px; }
.ktg-panel { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); overflow:hidden; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.ktg-panel-hdr { padding:13px 16px; border-bottom:2px solid var(--navy); background:var(--navy); display:flex; align-items:center; gap:8px; }
.ktg-panel-name { font-weight:800; font-size:15px; color:#fff; letter-spacing:.5px; }
.ktg-panel-badge { font-size:10px; font-weight:700; background:rgba(255,255,255,.15); color:rgba(255,255,255,.85); border-radius:4px; padding:2px 7px; }
.ktg-section { padding:13px 16px; border-bottom:1px solid var(--bd); }
.ktg-section:last-child { border-bottom:none; }
.ktg-section-hdr { display:flex; align-items:center; gap:7px; margin-bottom:10px; }
.ktg-section-icon { font-size:13px; }
.ktg-section-label { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:1px; }
.ktg-section.hit  .ktg-section-label { color:var(--gold-t); }
.ktg-section.pit  .ktg-section-label { color:var(--blue); }
.ktg-section.str  .ktg-section-label { color:var(--green); }
.ktg-section.hit  { background:#FFFBF2; }
.ktg-section.pit  { background:#F2F6FD; }
.ktg-section.str  { background:#F2FAF5; }
.ktg-bullet { font-size:13px; color:var(--text); line-height:1.6; margin-bottom:7px; padding-left:14px; position:relative; font-weight:500; }
.ktg-bullet:last-child { margin-bottom:0; }
.ktg-bullet::before { content:'›'; position:absolute; left:0; font-size:15px; line-height:1.4; color:var(--bd2); }
.ktg-section.hit .ktg-bullet::before { color:var(--gold); }
.ktg-section.pit .ktg-bullet::before { color:var(--blue); }
.ktg-section.str .ktg-bullet::before { color:var(--green); }
.ktg-generating { display:flex; align-items:center; justify-content:center; gap:10px; height:180px; color:var(--muted); font-size:14px; background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); }
.ktg-placeholder { background:var(--s2); border:1px solid var(--bd); border-radius:var(--radius); height:180px; display:flex; align-items:center; justify-content:center; }
.ktg-placeholder p { font-size:13px; color:var(--muted); text-align:center; line-height:1.6; }
/* Key Players */
.kp-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px; }
.kp-panel { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); overflow:hidden; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.kp-panel-hdr { padding:10px 14px; background:var(--s2); border-bottom:1px solid var(--bd); font-size:11px; font-weight:800; color:var(--navy); text-transform:uppercase; letter-spacing:.8px; }
.kp-sub-hdr { padding:8px 14px; background:var(--s3); border-bottom:1px solid var(--bd); font-size:9px; font-weight:800; color:var(--muted); text-transform:uppercase; letter-spacing:1px; }
.kp-row { display:flex; align-items:center; gap:8px; padding:8px 14px; border-bottom:1px solid var(--bd); }
.kp-row:last-child { border-bottom:none; }
.kp-rank { font-size:11px; font-weight:800; color:var(--bd2); width:16px; flex-shrink:0; text-align:center; }
.kp-name { font-size:13px; font-weight:600; color:var(--navy); flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.kp-primary { font-size:13px; font-weight:800; font-variant-numeric:tabular-nums; flex-shrink:0; width:50px; text-align:right; }
.kp-secondary { font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--muted); flex-shrink:0; width:46px; text-align:right; }
.kp-tertiary { font-size:10px; color:var(--muted); flex-shrink:0; }
@media(max-width:700px) { .ktg-grid{grid-template-columns:1fr} .kp-grid{grid-template-columns:1fr} .g2{grid-template-columns:1fr} }

/* pitcher cards */
.pitcher-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:10px; margin-bottom:16px; }
.pc { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:14px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.pc-name { font-weight:700; font-size:14px; margin-bottom:3px; color:var(--navy); }
.pc-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:6px 8px; margin-top:10px; }
.pc-stat { }
.pc-stat-val { font-family:'Nunito Sans'; font-size:16px; font-weight:800; line-height:1; font-variant-numeric:tabular-nums; }
.pc-stat-lbl { font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; font-weight:700; margin-top:2px; }

/* lineup threats */
.threat-row { display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--bd); }
.threat-row:last-child { border-bottom:none; }
.threat-rank { font-weight:800; font-size:16px; color:var(--bd2); width:22px; text-align:center; flex-shrink:0; }
.threat-name { font-weight:600; flex:1; color:var(--navy); font-size:14px; }
.threat-ops { font-size:14px; font-weight:800; font-variant-numeric:tabular-nums; margin-right:4px; }

/* game situations */
.gsit-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(185px,1fr)); gap:10px; margin-bottom:16px; }
.gsit-card { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:13px 15px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.gsit-type { font-size:10px; font-family:'Nunito Sans'; font-weight:800; text-transform:uppercase; letter-spacing:.8px; margin-bottom:9px; }
.gsit-card.speed   .gsit-type { color:var(--blue); }
.gsit-card.power   .gsit-type { color:var(--gold-t); }
.gsit-card.patience .gsit-type { color:var(--amber); }
.gsit-card.walk-prone .gsit-type { color:var(--red); }
.gsit-item { font-size:13px; color:var(--text2); margin-bottom:5px; display:flex; justify-content:space-between; align-items:baseline; }
.gsit-item .name { font-weight:600; color:var(--text); }
.gsit-item .val  { font-size:12px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--muted); }

/* league charts — 4-across, above fold */
.league-charts { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-top:16px; margin-bottom:22px; }
.league-charts .stat-card { padding:13px 15px; }
.lc-row { display:flex; align-items:center; gap:7px; margin-bottom:7px; }
.lc-row:last-child { margin-bottom:0; }
.lc-label { width:34px; font-size:10px; font-weight:700; color:var(--text2); flex-shrink:0; letter-spacing:.3px; }
.lc-track { flex:1; height:8px; background:var(--s3); border-radius:4px; overflow:hidden; }
.lc-bar { height:100%; border-radius:4px; transition:width .5s cubic-bezier(.4,0,.2,1); }
.lc-val { width:38px; font-size:12px; font-weight:800; font-variant-numeric:tabular-nums; text-align:right; flex-shrink:0; }
/* RS/RA split bar */
.runs-row { margin-bottom:11px; }
.runs-row:last-child { margin-bottom:0; }
.runs-hdr { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px; }
.runs-team { font-size:10px; font-weight:700; color:var(--text2); letter-spacing:.3px; }
.runs-vals { font-size:10px; font-variant-numeric:tabular-nums; font-weight:600; }
.runs-bar { height:13px; border-radius:6px; overflow:hidden; display:flex; position:relative; box-shadow:0 1px 4px rgba(0,0,0,.14); }
.runs-seg-ra { height:100%; flex-shrink:0; }
.runs-seg-rs { height:100%; flex:1; }
.runs-pivot { position:absolute; left:50%; top:1px; bottom:1px; width:2px; background:rgba(255,255,255,.55); border-radius:1px; transform:translateX(-50%); pointer-events:none; }
.runs-legend { display:flex; justify-content:space-between; align-items:center; margin-top:10px; padding-top:8px; border-top:1px solid var(--bd); }
.runs-legend-item { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); display:flex; align-items:center; gap:4px; }
.runs-legend-dot { width:8px; height:8px; border-radius:2px; flex-shrink:0; }
@media(max-width:980px) { .league-charts{grid-template-columns:1fr 1fr} }
@media(max-width:540px)  { .league-charts{grid-template-columns:1fr} }

/* leaders accordion */
.leaders-acc { border:1px solid var(--bd); border-radius:var(--radius); margin-bottom:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.leaders-acc-hdr { display:flex; align-items:center; justify-content:space-between; padding:11px 16px; background:var(--s2); cursor:pointer; user-select:none; }
.leaders-acc-hdr:hover { background:var(--s3); }
.leaders-acc-title { font-size:11px; font-family:'Nunito Sans'; font-weight:700; color:var(--navy); text-transform:uppercase; letter-spacing:.7px; }
.leaders-acc-toggle { font-size:11px; color:var(--muted); }
.leaders-acc-body { background:var(--s1); border-top:1px solid var(--bd); }
.leaders-rank { font-size:13px; font-weight:800; color:var(--bd2); width:20px; text-align:center; flex-shrink:0; }
.leaders-row { display:flex; align-items:center; gap:10px; padding:9px 16px; border-bottom:1px solid var(--bd); }
.leaders-row:last-child { border-bottom:none; }
.leaders-name { font-weight:600; font-size:13px; color:var(--navy); flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.leaders-team { font-size:10px; font-weight:700; color:var(--muted); background:var(--s2); border:1px solid var(--bd); border-radius:4px; padding:1px 6px; flex-shrink:0; }
.leaders-stat { font-size:14px; font-weight:800; font-variant-numeric:tabular-nums; flex-shrink:0; width:52px; text-align:right; }
.leaders-stat2 { font-size:12px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--muted); flex-shrink:0; width:52px; text-align:right; }
.leaders-sub { font-size:10px; color:var(--muted); flex-shrink:0; }

/* opponent intel */
.opp-intel { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:14px; margin-top:8px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.opp-intel-header { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
.opp-intel-title { font-size:11px; font-family:'Nunito Sans'; font-weight:700; color:var(--navy); text-transform:uppercase; letter-spacing:.8px; }
.opp-intel-toggle { font-size:11px; color:var(--muted); margin-left:auto; }
.opp-grid { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.opp-chip { background:var(--s2); border:1px solid var(--bd); border-radius:6px; padding:7px 12px; font-size:12px; cursor:pointer; transition:all .15s; display:flex; align-items:center; gap:0; }
.opp-chip:hover { border-color:var(--navy); background:var(--s3); }
.opp-chip-name { font-weight:700; color:var(--text); }
.opp-chip-g { font-size:11px; font-weight:700; color:var(--navy); background:var(--blue-d); border-radius:3px; padding:1px 5px; margin-left:7px; font-variant-numeric:tabular-nums; }
.opp-chip-era { font-size:11px; font-weight:600; color:var(--muted); margin-left:6px; font-variant-numeric:tabular-nums; }

/* chat */
.chat-wrap { display:flex; flex-direction:column; height:calc(100vh - 180px); min-height:400px; border:1px solid var(--bd); border-radius:var(--radius); overflow:hidden; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.chat-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; background:var(--bg); }
.chat-empty { margin:auto; text-align:center; }
.chat-empty h3 { font-weight:800; font-size:20px; color:var(--navy); margin-bottom:6px; }
.chat-empty p { font-size:13px; color:var(--muted); }
.suggestions { display:flex; flex-wrap:wrap; gap:7px; justify-content:center; margin-top:14px; max-width:520px; }
.sug { background:var(--s1); border:1px solid var(--bd); border-radius:6px; padding:6px 12px; cursor:pointer; font-size:12px; font-weight:600; color:var(--text2); font-family:'Nunito Sans'; transition:all .15s; text-align:left; }
.sug:hover { border-color:var(--navy); color:var(--navy); }
.msg { display:flex; gap:10px; max-width:88%; }
.msg.user { align-self:flex-end; flex-direction:row-reverse; }
.msg-av { width:28px; height:28px; border-radius:50%; background:var(--s2); border:1px solid var(--bd); display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:var(--muted); flex-shrink:0; }
.msg.ai .msg-av { background:var(--navy); color:#fff; border-color:var(--navy); }
.msg-bbl { padding:10px 14px; border-radius:10px; font-size:14px; line-height:1.65; white-space:pre-wrap; }
.msg.user .msg-bbl { background:var(--navy); color:#fff; }
.msg.ai   .msg-bbl { background:var(--s1); color:var(--text); border:1px solid var(--bd); }
.chat-bar { display:flex; gap:8px; padding:12px 14px; border-top:1px solid var(--bd); background:var(--s1); }
.chat-inp { flex:1; background:var(--s2); border:1px solid var(--bd2); border-radius:6px; color:var(--text); font-family:'Nunito Sans'; font-size:14px; padding:9px 12px; outline:none; }
.chat-inp:focus { border-color:var(--navy); box-shadow:0 0 0 3px rgba(0,40,104,.1); }
.chat-inp::placeholder { color:var(--muted); }
.send-btn { background:var(--navy); color:#fff; border:none; border-radius:6px; font-family:'Nunito Sans'; font-weight:700; font-size:14px; padding:9px 18px; cursor:pointer; transition:all .15s; }
.send-btn:hover { background:var(--navy2); }
.send-btn:disabled { opacity:.4; cursor:not-allowed; }
.dots { display:flex; gap:4px; padding:3px 0; }
.dot { width:6px; height:6px; border-radius:50%; background:var(--muted); animation:bounce 1.2s infinite; }
.dot:nth-child(2){animation-delay:.2s} .dot:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}

/* spinner */
.spinner { width:14px; height:14px; border:2px solid rgba(255,255,255,.4); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; flex-shrink:0; }
@keyframes spin{to{transform:rotate(360deg)}}

/* section divider */
.sec-divider { border:none; border-top:1px solid var(--bd); margin:22px 0; }

/* playoff threat matrix */
.ptm-wrap { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); overflow:hidden; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.ptm-row { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--bd); cursor:pointer; transition:background .1s; }
.ptm-row:last-child { border-bottom:none; }
.ptm-row:hover { background:var(--s2); }
.ptm-team { font-weight:700; font-size:13px; color:var(--navy); flex:1; min-width:0; }
.ptm-tier { font-size:10px; font-weight:800; padding:3px 8px; border-radius:4px; white-space:nowrap; letter-spacing:.5px; }
.ptm-score { font-size:12px; font-weight:800; font-variant-numeric:tabular-nums; width:32px; text-align:right; color:var(--text2); }
.ptm-stat { font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--muted); white-space:nowrap; }
.ptm-bar { width:60px; height:6px; border-radius:3px; background:var(--s3); overflow:hidden; flex-shrink:0; }
.ptm-bar-fill { height:100%; border-radius:3px; transition:width .4s; }

/* tier badges inline */
.tier-badge { display:inline-block; font-size:9px; font-weight:800; padding:2px 6px; border-radius:3px; letter-spacing:.4px; white-space:nowrap; margin-left:6px; vertical-align:middle; }
.tier-ace     { background:rgba(184,48,48,.12); color:var(--red); border:1px solid rgba(184,48,48,.3); }
.tier-quality { background:rgba(232,160,32,.12); color:var(--gold-t); border:1px solid rgba(232,160,32,.3); }
.tier-average { background:rgba(74,144,212,.1); color:var(--blue); border:1px solid rgba(74,144,212,.3); }
.tier-below   { background:var(--s3); color:var(--muted); border:1px solid var(--bd); }
.tier-limited { background:var(--s3); color:var(--muted); border:1px solid var(--bd); font-style:italic; }
.tier-elite   { background:rgba(184,48,48,.12); color:var(--red); border:1px solid rgba(184,48,48,.3); }
.tier-high    { background:rgba(232,160,32,.12); color:var(--gold-t); border:1px solid rgba(232,160,32,.3); }
.tier-moderate{ background:rgba(74,144,212,.1); color:var(--blue); border:1px solid rgba(74,144,212,.3); }
.tier-low     { background:var(--s3); color:var(--muted); border:1px solid var(--bd); }

/* defensive targets */
.def-targets { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:8px; }
.def-card { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:10px 14px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.def-name { font-weight:700; font-size:13px; color:var(--navy); }
.def-stat { font-size:22px; font-weight:800; color:var(--red); line-height:1; margin:4px 0 2px; }
.def-sub { font-size:11px; color:var(--muted); }

/* matchup exploits */
.exploit-wrap { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.exploit-item { display:flex; align-items:flex-start; gap:10px; padding:8px 0; border-bottom:1px solid var(--s3); }
.exploit-item:last-child { border-bottom:none; }
.exploit-cat { font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:.7px; padding:3px 7px; border-radius:4px; white-space:nowrap; flex-shrink:0; margin-top:1px; }
.exploit-cat.offense    { background:rgba(26,112,64,.1); color:var(--green); }
.exploit-cat.pitching   { background:rgba(74,144,212,.1); color:var(--blue); }
.exploit-cat.baserunning{ background:rgba(232,160,32,.12); color:var(--gold-t); }
.exploit-cat.advantage  { background:rgba(0,40,104,.08); color:var(--navy); }
.exploit-text { font-size:13px; color:var(--text); line-height:1.5; font-weight:500; }

/* opponent rotation */
.rot-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:8px; margin-bottom:14px; }
.rot-card { background:var(--s1); border:1px solid var(--bd); border-radius:var(--radius); padding:12px 14px; box-shadow:0 1px 3px rgba(0,40,104,.06); }
.rot-name { font-weight:700; font-size:14px; color:var(--navy); margin-bottom:2px; }
.rot-detail { font-size:11px; color:var(--muted); line-height:1.7; }
`;

// ─── useSort ──────────────────────────────────────────────────────────────────
function useSort(data, def, defDir = "desc") {
  const [col, setCol] = useState(def);
  const [dir, setDir] = useState(defDir);
  const sorted = useMemo(() => [...data].sort((a, b) => {
    const va = a[col], vb = b[col];
    const na = parseFloat(va), nb = parseFloat(vb);
    const cmp = !isNaN(na) && !isNaN(nb) ? na - nb : String(va ?? "").localeCompare(String(vb ?? ""));
    return dir === "asc" ? cmp : -cmp;
  }), [data, col, dir]);
  const toggle = c => { if (c === col) setDir(d => d === "asc" ? "desc" : "asc"); else { setCol(c); setDir("desc"); } };
  return { sorted, col, dir, toggle };
}
function Th({ c, label, s, d, fn, left }) {
  return <th className={c === s ? "on" : ""} onClick={() => fn(c)} style={{ textAlign: left ? "left" : "right" }}>{label}{c === s ? (d === "asc" ? " ↑" : " ↓") : ""}</th>;
}

// ─── H2H BAR ROW ─────────────────────────────────────────────────────────────
function H2HRow({ label, a: aVal, b: bVal, fmt, lowerBetter }) {
  const av = parseFloat(aVal), bv = parseFloat(bVal);
  const aOk = Number.isFinite(av);
  const bOk = Number.isFinite(bv);
  const aWins = aOk && bOk && (lowerBetter ? av < bv : av > bv);
  const bWins = aOk && bOk && (lowerBetter ? bv < av : bv > av);
  const total = av + bv;
  const aShare = (aOk && bOk) ? (lowerBetter ? bv / total : av / total) : 0.5;
  const bShare = (aOk && bOk) ? (lowerBetter ? av / total : bv / total) : 0.5;
  const MAX = 100;
  const aDisplay = aOk ? fmt(aVal) : "—";
  const bDisplay = bOk ? fmt(bVal) : "—";
  return (
    <div className="h2h-row">
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
        <span className={`h2h-val right ${aWins ? "win" : bWins ? "lose" : ""}`}>{aDisplay}</span>
        <div className="h2h-bar-a" style={{ width: Math.round(aShare * MAX), background: aWins ? "var(--green)" : "var(--bd2)" }} />
      </div>
      <div className="h2h-metric-label">{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="h2h-bar-b" style={{ width: Math.round(bShare * MAX), background: bWins ? "var(--green)" : "var(--bd2)" }} />
        <span className={`h2h-val ${bWins ? "win" : aWins ? "lose" : ""}`}>{bDisplay}</span>
      </div>
    </div>
  );
}

// ─── LEAGUE CHART HELPERS ─────────────────────────────────────────────────────
function LeagueBarChart({ title, rows }) {
  const vals = rows.map(r => r.value).filter(v => isFinite(v));
  const max = vals.length ? Math.max(...vals) : 1;
  const min = vals.length ? Math.min(...vals) : 0;
  const range = max - min || 1;
  return (
    <div className="stat-card">
      <div className="stat-card-label">{title}</div>
      <div style={{ marginTop: 11 }}>
        {rows.map(r => {
          const barPct = Math.max(7, Math.round(((r.lowerBetter ? max - r.value : r.value - min) / range) * 100));
          return (
            <div key={r.label} className="lc-row">
              <div className="lc-label">{r.label}</div>
              <div className="lc-track">
                <div className="lc-bar" style={{ width: `${barPct}%`, background: r.gradient }} />
              </div>
              <div className="lc-val" style={{ color: r.valColor }}>{r.display}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RunsChart({ title, teams }) {
  // Sort best run differential first
  const sorted = [...teams].sort((a, b) => (b.RpG - b.RApG) - (a.RpG - a.RApG));
  const GRAD_RA  = "linear-gradient(90deg,#9B2020,#D94040)";
  const GRAD_WIN = "linear-gradient(90deg,#1A6035,#2DB860)";
  const GRAD_LOS = "linear-gradient(90deg,#002060,#2A52A8)";
  return (
    <div className="stat-card">
      <div className="stat-card-label">{title}</div>
      <div style={{ marginTop: 11 }}>
        {sorted.map(t => {
          const total  = t.RpG + t.RApG;
          const raPct  = total > 0 ? Math.round((t.RApG / total) * 100) : 50;
          const rsWins = t.RpG >= t.RApG;
          const diff   = t.RpG - t.RApG;
          return (
            <div key={t.teamId} className="runs-row">
              <div className="runs-hdr">
                <span className="runs-team">{t.teamId}</span>
                <span className="runs-vals">
                  <span style={{ color: "var(--red)" }}>{fix1(t.RApG)}</span>
                  <span style={{ color: "var(--muted)" }}> vs </span>
                  <span style={{ color: rsWins ? "var(--green)" : "var(--navy)", fontWeight: 800 }}>{fix1(t.RpG)}</span>
                  <span style={{ color: diff >= 0 ? "var(--green)" : "var(--red)", marginLeft: 5, fontSize: 9, fontWeight: 700 }}>
                    ({diff >= 0 ? "+" : ""}{fix1(diff)})
                  </span>
                </span>
              </div>
              <div className="runs-bar">
                <div className="runs-seg-ra" style={{ width: `${raPct}%`, background: GRAD_RA }} />
                <div className="runs-seg-rs"  style={{ background: rsWins ? GRAD_WIN : GRAD_LOS }} />
                <div className="runs-pivot" />
              </div>
            </div>
          );
        })}
        <div className="runs-legend">
          <div className="runs-legend-item">
            <div className="runs-legend-dot" style={{ background: GRAD_RA }} />
            <span>Runs Allowed</span>
          </div>
          <div className="runs-legend-item" style={{ fontSize: 8 }}>│ pivot = equal │</div>
          <div className="runs-legend-item">
            <span>Runs Scored</span>
            <div className="runs-legend-dot" style={{ background: GRAD_WIN }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── LEAGUE TAB ───────────────────────────────────────────────────────────────
function LeagueTab({ data, teams, onTeamClick }) {
  const [oppOpen,       setOppOpen]       = useState(true);
  const [pitchLeadOpen, setPitchLeadOpen] = useState(false);
  const [batLeadOpen,   setBatLeadOpen]   = useState(false);
  const [ptmOpen,       setPtmOpen]       = useState(true);
  const [defOpen,       setDefOpen]       = useState(false);

  const focalSummaries = useMemo(() =>
    teams.focal.map(t => teamSummary(data, t)), [data, teams]);

  const oppSummaries = useMemo(() =>
    teams.opponents.map(t => {
      const pRows = data.pitching.filter(r => r.Team === t);
      const agg   = aggPitching(pRows);
      const IP    = agg.reduce((s, r) => s + r.Outs, 0) / 3;
      const tK    = agg.reduce((s, r) => s + r.K,   0);
      const tBB   = agg.reduce((s, r) => s + r.BB,  0);
      const tH    = agg.reduce((s, r) => s + r.H,   0);
      const tR    = agg.reduce((s, r) => s + r.R,   0);
      // Count every appearance in the game log, not just focal-team rows
      const G = data.gameLog.filter(g => g.Away_Team === t || g.Home_Team === t).length;
      return { teamId: t, G,
        ERA:  safe(tR * 9, IP),
        WHIP: safe(tH + tBB, IP),
        KBB:  tBB > 0 ? tK / tBB : tK > 0 ? 99 : 0 };
    }).filter(s => s.G > 0 || data.pitching.some(r => r.Team === s.teamId)),
    [data, teams]
  );

  // Playoff Threat Matrix — focal teams only (4+ games = reliable data)
  const ptmRows = useMemo(() =>
    teams.focal.map(t => {
      const pt = playoffThreat(data, t);
      return pt ? { teamId: t, ...pt } : null;
    }).filter(Boolean).sort((a, b) => b.score - a.score),
    [data, teams]
  );

  // Defensive Targets — top error-prone opponent players across all opponents
  const defTargets = useMemo(() =>
    teams.opponents.flatMap(t =>
      defensiveTargets(data, t).map(d => ({ ...d, Team: t }))
    ).sort((a, b) => b.Errors - a.Errors).slice(0, 8),
    [data, teams]
  );

  // Cross-focal pitching leaders — min 8 IP (24 outs), sorted by ERA
  const pitchLeaders = useMemo(() =>
    teams.focal.flatMap(t =>
      aggPitching(data.pitching.filter(r => r.Team === t))
        .filter(p => p.Outs >= 24)
        .map(p => ({ ...p, Team: t }))
    ).sort((a, b) => a.ERA - b.ERA).slice(0, 5),
    [data, teams]
  );

  // Cross-focal batting leaders — min 12 PA, sorted by OPS
  const batLeaders = useMemo(() =>
    teams.focal.flatMap(t =>
      aggBatting(data.batting.filter(r => r.Team === t))
        .filter(b => b.PA >= 12)
        .map(b => ({ ...b, Team: t }))
    ).sort((a, b) => b.OPS - a.OPS).slice(0, 5),
    [data, teams]
  );

  const { sorted: fSorted, col: fCol, dir: fDir, toggle: fToggle } = useSort(focalSummaries, "ERA", "asc");

  const eraSorted = [...focalSummaries].filter(s => s.G > 0).sort((a, b) => a.ERA - b.ERA);
  const opsSorted = [...focalSummaries].filter(s => s.G > 0).sort((a, b) => (b.teamOBP + b.teamSLG) - (a.teamOBP + a.teamSLG));
  const runsSorted = [...focalSummaries].filter(s => s.G > 0).sort((a, b) => b.RpG - a.RpG);
  const kbbSorted  = [...focalSummaries].filter(s => s.G > 0).sort((a, b) => b.KBB - a.KBB);

  // Accordion header shared style
  const accHdr = open => ({
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "11px 16px",
    background: open ? "var(--s2)" : "var(--s2)",
    cursor: "pointer", userSelect: "none",
  });

  return (
    <div>

      {/* ── VISUAL SUMMARY CHARTS ─────────────────────────────── */}
      <div className="league-charts">
        <LeagueBarChart
          title="Team ERA — focal teams (lower is better)"
          rows={eraSorted.map(s => ({
            label: s.teamId, value: s.ERA, display: fix2(s.ERA), lowerBetter: true,
            gradient: s.ERA <= 2.5 ? "linear-gradient(90deg,#1A6035,#2DB860)"
                    : s.ERA >= 5   ? "linear-gradient(90deg,#9B2020,#D94040)"
                    : "linear-gradient(90deg,#002060,#2A52A8)",
            valColor: s.ERA <= 2.5 ? "var(--green)" : s.ERA >= 5 ? "var(--red)" : "var(--text)",
          }))}
        />
        <RunsChart
          title="Runs scored (RS) vs allowed (RA) per game"
          teams={runsSorted}
        />
        <LeagueBarChart
          title="Team OPS — focal teams"
          rows={opsSorted.map(s => ({
            label: s.teamId, value: s.teamOBP + s.teamSLG,
            display: avg3(s.teamOBP + s.teamSLG), lowerBetter: false,
            gradient: (s.teamOBP + s.teamSLG) >= 0.8
              ? "linear-gradient(90deg,#1A6035,#2DB860)"
              : "linear-gradient(90deg,#002060,#2A52A8)",
            valColor: (s.teamOBP + s.teamSLG) >= 0.8 ? "var(--green)" : "var(--text)",
          }))}
        />
        <LeagueBarChart
          title="K/BB ratio — focal teams (pitching command)"
          rows={kbbSorted.map(s => ({
            label: s.teamId, value: clamp(s.KBB, 20),
            display: fix1(clamp(s.KBB, 20)), lowerBetter: false,
            gradient: s.KBB >= 2 ? "linear-gradient(90deg,#1A6035,#2DB860)"
                    : s.KBB < 1  ? "linear-gradient(90deg,#9B2020,#D94040)"
                    : "linear-gradient(90deg,#002060,#2A52A8)",
            valColor: s.KBB >= 2 ? "var(--green)" : s.KBB < 1 ? "var(--red)" : "var(--text)",
          }))}
        />
      </div>

      {/* ── FOCAL TEAM TABLE ──────────────────────────────────── */}
      <div className="sec-title">Focal teams — click to view profile</div>
      <div className="tbl-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead><tr>
            <Th c="teamId"  label="Team"  s={fCol} d={fDir} fn={fToggle} left />
            <Th c="W"       label="W"     s={fCol} d={fDir} fn={fToggle} />
            <Th c="L"       label="L"     s={fCol} d={fDir} fn={fToggle} />
            <Th c="G"       label="G"     s={fCol} d={fDir} fn={fToggle} />
            <Th c="RpG"     label="R/G"   s={fCol} d={fDir} fn={fToggle} />
            <Th c="RApG"    label="RA/G"  s={fCol} d={fDir} fn={fToggle} />
            <Th c="ERA"     label="ERA"   s={fCol} d={fDir} fn={fToggle} />
            <Th c="WHIP"    label="WHIP"  s={fCol} d={fDir} fn={fToggle} />
            <Th c="KBB"     label="K/BB"  s={fCol} d={fDir} fn={fToggle} />
            <Th c="KPct"    label="K%"    s={fCol} d={fDir} fn={fToggle} />
            <Th c="BBPct"   label="BB%"   s={fCol} d={fDir} fn={fToggle} />
            <Th c="teamAVG" label="AVG"   s={fCol} d={fDir} fn={fToggle} />
            <Th c="teamOBP" label="OBP"   s={fCol} d={fDir} fn={fToggle} />
          </tr></thead>
          <tbody>
            {fSorted.map(s => (
              <tr key={s.teamId} onClick={() => onTeamClick(s.teamId)}>
                <td><span className="focal-dot" /><span style={{ fontWeight: 500 }}>{s.teamId}</span></td>
                <td className="td-r c-g mono">{s.W}</td>
                <td className={`td-r mono ${s.L > s.W ? "c-r" : ""}`}>{s.L}</td>
                <td className="td-r mono">{s.G}</td>
                <td className={`td-r mono ${s.RpG >= 8 ? "c-g" : ""}`}>{fix1(s.RpG)}</td>
                <td className={`td-r mono ${s.RApG <= 3 ? "c-g" : s.RApG >= 7 ? "c-r" : ""}`}>{fix1(s.RApG)}</td>
                <td className={`td-r mono ${s.ERA <= 2.5 ? "c-g" : s.ERA >= 5 ? "c-r" : ""}`}>{fix2(s.ERA)}</td>
                <td className={`td-r mono ${s.WHIP <= 1.2 ? "c-g" : s.WHIP >= 2 ? "c-r" : ""}`}>{fix2(s.WHIP)}</td>
                <td className={`td-r mono ${s.KBB >= 2 ? "c-g" : s.KBB < 1 ? "c-r" : ""}`}>{fix1(clamp(s.KBB, 20))}{s.KBB > 20 ? "+" : ""}</td>
                <td className="td-r mono">{pct(s.KPct)}</td>
                <td className={`td-r mono ${s.BBPct >= 0.12 ? "c-r" : ""}`}>{pct(s.BBPct)}</td>
                <td className={`td-r mono ${s.teamAVG >= 0.3 ? "c-g" : ""}`}>{avg3(s.teamAVG)}</td>
                <td className={`td-r mono ${s.teamOBP >= 0.35 ? "c-g" : ""}`}>{avg3(s.teamOBP)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── PITCHING LEADERS ACCORDION ────────────────────────── */}
      <div className="leaders-acc">
        <div className="leaders-acc-hdr" onClick={() => setPitchLeadOpen(o => !o)}>
          <span className="leaders-acc-title">⚾ Pitching leaders — top 5 ERA across focal teams (min 8 IP)</span>
          <span className="leaders-acc-toggle">{pitchLeadOpen ? "▲" : "▼"}</span>
        </div>
        {pitchLeadOpen && (
          <div className="leaders-acc-body">
            {pitchLeaders.length === 0 ? (
              <div style={{ padding: "14px 16px", fontSize: 13, color: "var(--muted)" }}>No pitchers with 8+ IP recorded yet.</div>
            ) : pitchLeaders.map((p, i) => (
              <div key={`${p.Team}-${p.Pitcher}`} className="leaders-row">
                <div className="leaders-rank">{i + 1}</div>
                <div className="leaders-name">{p.Pitcher}</div>
                <div className="leaders-team">{p.Team}</div>
                <div className={`leaders-stat ${p.ERA <= 2.5 ? "c-g" : p.ERA >= 5 ? "c-r" : ""}`}>{fix2(p.ERA)} ERA</div>
                <div className={`leaders-stat2 ${p.WHIP <= 1.2 ? "c-g" : p.WHIP >= 2 ? "c-r" : ""}`}>{fix2(p.WHIP)} WHIP</div>
                <div className="leaders-sub">{fmtIP(p.Outs)} IP</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── BATTING LEADERS ACCORDION ─────────────────────────── */}
      <div className="leaders-acc" style={{ marginBottom: 8 }}>
        <div className="leaders-acc-hdr" onClick={() => setBatLeadOpen(o => !o)}>
          <span className="leaders-acc-title">🏏 Batting leaders — top 5 OPS across focal teams (min 12 PA)</span>
          <span className="leaders-acc-toggle">{batLeadOpen ? "▲" : "▼"}</span>
        </div>
        {batLeadOpen && (
          <div className="leaders-acc-body">
            {batLeaders.length === 0 ? (
              <div style={{ padding: "14px 16px", fontSize: 13, color: "var(--muted)" }}>No batters with 12+ PA recorded yet.</div>
            ) : batLeaders.map((b, i) => (
              <div key={`${b.Team}-${b.Player}`} className="leaders-row">
                <div className="leaders-rank">{i + 1}</div>
                <div className="leaders-name">{b.Player}</div>
                <div className="leaders-team">{b.Team}</div>
                <div className={`leaders-stat ${b.OPS >= 0.9 ? "c-g" : b.OPS >= 0.75 ? "c-a" : ""}`}>{avg3(b.OPS)} OPS</div>
                <div className={`leaders-stat2 ${b.OBP >= 0.38 ? "c-g" : ""}`}>{avg3(b.OBP)} OBP</div>
                <div className="leaders-sub">{b.PA} PA</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── OPPONENT INTEL ────────────────────────────────────── */}
      <div className="opp-intel">
        <div className="opp-intel-header" onClick={() => setOppOpen(o => !o)}>
          <span className="opp-dot" />
          <span className="opp-intel-title">Opponent intel — {teams.opponents.length} teams</span>
          <span className="opp-intel-toggle">{oppOpen ? "▲ collapse" : "▼ expand"}</span>
        </div>
        {oppOpen && (
          <div>
            <p style={{ fontSize: 12, color: "var(--text2)", margin: "10px 0", lineHeight: 1.6 }}>
              Teams scouted as opponents. Click any chip to view profile or run a matchup.
            </p>
            <div className="opp-grid">
              {oppSummaries.map(s => (
                <div key={s.teamId} className="opp-chip" onClick={() => onTeamClick(s.teamId)}>
                  <span className="opp-chip-name">{s.teamId}</span>
                  <span className="opp-chip-g">{s.G}G</span>
                  {s.ERA > 0 && <span className="opp-chip-era">{fix2(s.ERA)} ERA</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── PLAYOFF THREAT MATRIX ────────────────────────────── */}
      {ptmRows.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="opp-intel" style={{ padding: 0 }}>
            <div className="opp-intel-header" onClick={() => setPtmOpen(o => !o)} style={{ padding: "12px 16px" }}>
              <span className="focal-dot" />
              <span className="opp-intel-title">Playoff Threat Matrix — {ptmRows.length} focal teams</span>
              <span className="opp-intel-toggle">{ptmOpen ? "▲ collapse" : "▼ expand"}</span>
            </div>
            {ptmOpen && (
              <div style={{ borderTop: "1px solid var(--bd)" }}>
                {ptmRows.map(t => {
                  const maxScore = ptmRows[0]?.score || 1;
                  return (
                    <div key={t.teamId} className="ptm-row" onClick={() => onTeamClick(t.teamId)}>
                      <span className="ptm-team">{t.teamId}</span>
                      <span className="ptm-tier" style={{ background: t.tierColor + "18", color: t.tierColor, border: `1px solid ${t.tierColor}40` }}>
                        {t.tier}
                      </span>
                      <div className="ptm-bar">
                        <div className="ptm-bar-fill" style={{ width: `${(t.score / maxScore) * 100}%`, background: t.tierColor }} />
                      </div>
                      <span className="ptm-stat">{t.W}-{t.L}</span>
                      <span className="ptm-stat">{fix2(t.teamERA)} ERA</span>
                      <span className="ptm-stat">{avg3(t.teamAVG)} AVG</span>
                      <span className="ptm-stat">{fix1(t.ePG)} E/G</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── DEFENSIVE TARGETS ────────────────────────────────── */}
      {defTargets.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="opp-intel">
            <div className="opp-intel-header" onClick={() => setDefOpen(o => !o)}>
              <span className="opp-dot" />
              <span className="opp-intel-title">Defensive Targets — error-prone opponents</span>
              <span className="opp-intel-toggle">{defOpen ? "▲ collapse" : "▼ expand"}</span>
            </div>
            {defOpen && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 12, color: "var(--text2)", marginBottom: 10, lineHeight: 1.6 }}>
                  Players with the most errors across scouted opponents. Exploit with aggressive baserunning and balls in play.
                </p>
                <div className="def-targets">
                  {defTargets.map(d => (
                    <div key={`${d.Team}-${d.Player}`} className="def-card">
                      <div className="def-name">{d.Player}</div>
                      <div className="def-stat">{d.Errors} E</div>
                      <div className="def-sub">{d.Team} · {fix1(d.ePG)} E/G</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TEAM PROFILE ─────────────────────────────────────────────────────────────
function TeamProfile({ data, teamId, teams, onBack, onMatchup }) {
  const s = useMemo(() => teamSummary(data, teamId), [data, teamId]);
  const isFocal = teams.focal.includes(teamId);
  const [rotOpen, setRotOpen] = useState(false);
  const [defTgtOpen, setDefTgtOpen] = useState(false);

  const pitchers = useMemo(() => [...s.pitchers].sort((a,b) => b.IP - a.IP), [s]);
  const { sorted: bSort, col: bCol, dir: bDir, toggle: bToggle } = useSort(
    s.batters.filter(r => r.PA >= 3), "OPS"
  );

  const rotation = useMemo(() => opponentRotation(data, teamId), [data, teamId]);
  const defTgts  = useMemo(() => defensiveTargets(data, teamId), [data, teamId]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button className="back-btn" onClick={onBack}>← League</button>
        <button className="back-btn" style={{ borderColor: "var(--gold)", color: "var(--gold)" }}
          onClick={() => onMatchup(teamId)}>
          Matchup →
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <span style={{ color: isFocal ? "var(--gold)" : "var(--muted)" }}>
          {isFocal ? <span className="focal-dot" /> : <span className="opp-dot" />}
        </span>
        <span style={{ fontFamily: "'Nunito Sans'", fontWeight: 800, fontSize: 24, letterSpacing: 1 }}>{teamId}</span>
        {isFocal
          ? <span className="badge b-gold">focal</span>
          : <span className="badge b-muted">opponent intel</span>}
        {s.G > 0 && <span className="mono c-m" style={{ fontSize: 12 }}>{s.W}–{s.L} · {s.G} games</span>}
      </div>

      {s.G > 0 && (
        <div className="g4" style={{ marginBottom: 18 }}>
          {[
            { l: "ERA",  v: fix2(s.ERA),  c: s.ERA <= 2.5 ? "c-g" : s.ERA >= 5 ? "c-r" : "" },
            { l: "WHIP", v: fix2(s.WHIP), c: s.WHIP <= 1.2 ? "c-g" : s.WHIP >= 2 ? "c-r" : "" },
            { l: "K/BB", v: fix1(clamp(s.KBB,20))+(s.KBB>20?"+":""), c: s.KBB >= 2 ? "c-g" : s.KBB < 1 ? "c-r" : "" },
            { l: "Team OPS", v: avg3(s.teamOBP + s.teamSLG), c: "" },
            { l: "Errors", v: s.errors, c: s.errors >= 5 ? "c-r" : s.errors <= 1 ? "c-g" : "", sub: `${s.G} games` },
          ].map(({ l, v, c, sub }) => (
            <div key={l} className="stat-card">
              <div className="stat-card-label">{l}</div>
              <div className={`stat-card-value ${c}`}>{v}</div>
              {sub && <div className="stat-card-sub">{sub}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="sec-title">Pitching staff</div>
      <div className="pitcher-cards" style={{ marginBottom: 18 }}>
        {pitchers.map(p => (
          <div key={p.Pitcher} className="pc">
            <div className="pc-name">
              {p.Pitcher}
              {(() => { const imp = pitcherImpact(p); return imp.tier !== "LIMITED" ? (
                <span className={`tier-badge tier-${imp.tier === "ACE" ? "ace" : imp.tier === "QUALITY" ? "quality" : imp.tier === "AVERAGE" ? "average" : "below"}`}>
                  {imp.emoji} {imp.tier}
                </span>
              ) : <span className="tier-badge tier-limited">LIMITED</span>; })()}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
              {p.G} app · {fmtIP(p.Outs)} IP · {p.BF} BF
            </div>
            <div className="pc-stats">
              {[
                { v: p.K,  l: "K",    c: p.K >= 8 ? "c-g" : "" },
                { v: p.BB, l: "BB",   c: p.BB >= 5 ? "c-r" : "" },
                { v: p.Outs > 0 ? fix2(p.ERA)  : "—", l: "ERA",  c: p.Outs > 0 && (p.ERA <= 2.5 ? "c-g" : p.ERA >= 5 ? "c-r" : "") },
                { v: p.Outs > 0 ? fix2(p.WHIP) : "—", l: "WHIP", c: p.Outs > 0 && (p.WHIP <= 1.2 ? "c-g" : p.WHIP >= 2 ? "c-r" : "") },
                { v: p.Outs > 0 ? fix1(clamp(p.KBB, 20))+(p.KBB>20?"+":"") : "—", l: "K/BB", c: p.Outs > 0 && p.KBB >= 2 ? "c-g" : "" },
                { v: p.Outs > 0 ? pct(p.BBPct) : "—", l: "BB%",  c: p.Outs > 0 && p.BBPct >= 0.12 ? "c-r" : "" },
              ].map(({ v, l, c }) => (
                <div key={l} className="pc-stat">
                  <div className={`pc-stat-val ${c}`}>{v}</div>
                  <div className="pc-stat-lbl">{l}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="sec-title">Batting leaders (min 3 PA)</div>
      <div className="tbl-wrap">
        <table>
          <thead><tr>
            {[["Player","Player",true],["G","G"],["PA","PA"],["H","H"],["HR","HR"],["RBI","RBI"],["SB","SB"],["K","K"],["BB","BB"],["AVG","AVG"],["OBP","OBP"],["SLG","SLG"],["OPS","OPS"]].map(([c,l,left]) => (
              <Th key={c} c={c} label={l} s={bCol} d={bDir} fn={bToggle} left={!!left} />
            ))}
            <th style={{ textAlign: "center", fontSize: 11, fontFamily: "'Nunito Sans'", fontWeight: 700, color: "var(--navy)", textTransform: "uppercase", letterSpacing: ".8px", background: "var(--s2)", borderBottom: "2px solid var(--bd)", padding: "10px 8px" }}>Threat</th>
          </tr></thead>
          <tbody>
            {bSort.map(r => (
              <tr key={r.Player}>
                <td style={{ fontWeight: 500 }}>{r.Player}</td>
                <td className="td-r mono">{r.G}</td><td className="td-r mono">{r.PA}</td>
                <td className="td-r mono">{r.H}</td>
                <td className={`td-r mono ${r.HR > 0 ? "c-g" : ""}`}>{r.HR}</td>
                <td className="td-r mono">{r.RBI}</td>
                <td className="td-r mono c-b">{r.SB}</td>
                <td className={`td-r mono ${r.K >= 5 ? "c-r" : ""}`}>{r.K}</td>
                <td className="td-r mono">{r.BB}</td>
                <td className={`td-r mono ${r.AVG >= 0.3 ? "c-g" : r.AVG < 0.2 ? "c-r" : ""}`}>{avg3(r.AVG)}</td>
                <td className={`td-r mono ${r.OBP >= 0.35 ? "c-g" : ""}`}>{avg3(r.OBP)}</td>
                <td className="td-r mono">{avg3(r.SLG)}</td>
                <td className={`td-r mono ${r.OPS >= 0.8 ? "c-g" : ""}`}>{avg3(r.OPS)}</td>
                <td style={{ textAlign: "center" }}>{(() => { const ht = hitterThreat(r); const cls = ht.tier === "ELITE" ? "tier-elite" : ht.tier === "HIGH" ? "tier-high" : ht.tier === "MODERATE" ? "tier-moderate" : ht.tier === "LIMITED" ? "tier-limited" : "tier-low"; return <span className={`tier-badge ${cls}`}>{ht.tier}</span>; })()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── OPPONENT ROTATION ─────────────────────────────────── */}
      {rotation.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="opp-intel">
            <div className="opp-intel-header" onClick={() => setRotOpen(o => !o)}>
              <span style={{ fontSize: 12 }}>⚾</span>
              <span className="opp-intel-title">Pitching Rotation — {rotation.length} pitchers tracked</span>
              <span className="opp-intel-toggle">{rotOpen ? "▲" : "▼"}</span>
            </div>
            {rotOpen && (
              <div style={{ marginTop: 12 }}>
                <div className="rot-grid">
                  {rotation.map(r => {
                    const imp = pitcherImpact(s.pitchers.find(p => p.Pitcher === r.pitcher) || { Outs: 0 });
                    return (
                      <div key={r.pitcher} className="rot-card">
                        <div className="rot-name">
                          {r.pitcher}
                          {imp.tier !== "LIMITED" && (
                            <span className={`tier-badge tier-${imp.tier === "ACE" ? "ace" : imp.tier === "QUALITY" ? "quality" : imp.tier === "AVERAGE" ? "average" : "below"}`}>
                              {imp.emoji} {imp.tier}
                            </span>
                          )}
                        </div>
                        <div className="rot-detail">
                          {r.starts} start{r.starts !== 1 ? "s" : ""} · {r.avgIP} avg IP<br />
                          Last: {r.lastStart ? String(r.lastStart).slice(0, 10) : "—"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── DEFENSIVE TARGETS (this team) ─────────────────────── */}
      {defTgts.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="opp-intel">
            <div className="opp-intel-header" onClick={() => setDefTgtOpen(o => !o)}>
              <span style={{ fontSize: 12 }}>🎯</span>
              <span className="opp-intel-title">Defensive Weakness Map — {defTgts.reduce((s, d) => s + d.Errors, 0)} total errors</span>
              <span className="opp-intel-toggle">{defTgtOpen ? "▲" : "▼"}</span>
            </div>
            {defTgtOpen && (
              <div style={{ marginTop: 12 }}>
                <div className="def-targets">
                  {defTgts.map(d => (
                    <div key={d.Player} className="def-card">
                      <div className="def-name">{d.Player}</div>
                      <div className="def-stat">{d.Errors} E</div>
                      <div className="def-sub">{fix1(d.ePG)} E/G</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MATCHUP TAB ──────────────────────────────────────────────────────────────
function MatchupTab({ data, teams, defaultTeamA, defaultTeamB }) {
  const [teamA, setTeamA] = useState(defaultTeamA || teams.focal[0] || teams.all[0] || "");
  const [teamB, setTeamB] = useState(defaultTeamB || teams.all.filter(t => t !== (defaultTeamA || teams.focal[0]))[0] || "");
  const [ktg, setKtg]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]     = useState(null);
  const [pitchOpen, setPitchOpen]   = useState(false);
  const [lineupOpen, setLineupOpen] = useState(false);

  useEffect(() => {
    if (defaultTeamA && defaultTeamA !== teamA) {
      setTeamA(defaultTeamA);
      setKtg(null);
    }
  }, [defaultTeamA]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (defaultTeamB && defaultTeamB !== teamB) {
      setTeamB(defaultTeamB);
      setKtg(null);
    }
  }, [defaultTeamB]); // eslint-disable-line react-hooks/exhaustive-deps

  // Computed data — always live
  const sA = useMemo(() => teamA ? teamSummary(data, teamA) : null, [data, teamA]);
  const sB = useMemo(() => teamB ? teamSummary(data, teamB) : null, [data, teamB]);

  const oppPitchers = useMemo(() =>
    teamB ? aggPitching(data.pitching.filter(r => r.Team === teamB)).sort((a,b) => b.IP - a.IP) : [],
    [data, teamB]
  );

  const oppBatters = useMemo(() =>
    teamB ? aggBatting(data.batting.filter(r => r.Team === teamB))
      .filter(r => r.PA >= 5).sort((a,b) => b.OPS - a.OPS) : [],
    [data, teamB]
  );

  // Key players — data-driven, both teams
  const keyBattersA  = useMemo(() => sA ? [...sA.batters].filter(b => b.PA >= 8).sort((a,b) => b.OPS - a.OPS).slice(0, 4) : [], [sA]);
  const keyPitchersA = useMemo(() => sA ? [...sA.pitchers].filter(p => p.Outs >= 3).sort((a,b) => b.Outs - a.Outs).slice(0, 3) : [], [sA]);
  const keyBattersB  = useMemo(() => sB ? [...sB.batters].filter(b => b.PA >= 8).sort((a,b) => b.OPS - a.OPS).slice(0, 4) : [], [sB]);
  const keyPitchersB = useMemo(() => sB ? [...sB.pitchers].filter(p => p.Outs >= 3).sort((a,b) => b.Outs - a.Outs).slice(0, 3) : [], [sB]);

  // Game situation analysis — sample-size-aware thresholds
  const gameSits = useMemo(() => {
    if (!oppBatters.length && !oppPitchers.length) return null;
    const speed = oppBatters
      .filter(r => r.SB >= 3 && r.PA >= 8 && safe(r.SB, r.PA) >= 0.08)
      .sort((a,b) => b.SB - a.SB).slice(0, 4);
    const power = oppBatters
      .filter(r => r.HR >= 2 || (r.HR >= 1 && r.PA >= 8 && r.SLG >= 0.500))
      .sort((a,b) => b.HR - a.HR).slice(0, 4);
    const patient = oppBatters
      .filter(r => r.PA >= 12 && safe(r.BB, r.PA) >= 0.12)
      .sort((a,b) => safe(b.BB, b.PA) - safe(a.BB, a.PA)).slice(0, 4);
    const walkProne = oppPitchers
      .filter(p => p.BF >= 25 && p.BBPct >= 0.12)
      .sort((a,b) => b.BBPct - a.BBPct).slice(0, 4);
    return { speed, power, patient, walkProne };
  }, [oppBatters, oppPitchers]);

  // Matchup Exploits — auto-generated strategy bullets
  const exploits = useMemo(() =>
    (sA && sB) ? matchupExploits(sA, sB, teamA, teamB) : [],
    [sA, sB, teamA, teamB]
  );

  const generateKTG = async () => {
    if (!teamA || !teamB || loading) return;
    setLoading(true); setErr(null); setKtg(null);
    try {
      const system = buildKTGSystem(data, teamA, teamB);

      const chipMsg = (focal, opp) =>
        `Keys to the Game for ${focal} vs ${opp}. ${focal}'s perspective only.
Return ONLY this JSON, nothing else:
{"hitting":["","",""],"pitching":["","",""],"strategy":["",""]}
HARD RULE: every string must be 8 words or fewer. Format: "[Stat/player] — [action]"
Examples: "Walsh BB%=14% — draw walks every AB" / "Opp K%=28% — attack zone early"`;

      const parseOne = raw => {
        const clean = raw.replace(/```json|```/g, "").trim();
        try { return JSON.parse(clean); }
        catch {
          const match = clean.match(/\{[\s\S]*\}/);
          if (!match) throw new Error(`No JSON found in response`);
          return JSON.parse(match[0]);
        }
      };

      // Two parallel calls — one per team — half the output each
      const [rawA, rawB] = await Promise.all([
        callClaude(system, chipMsg(teamA, teamB), 1000),
        callClaude(system, chipMsg(teamB, teamA), 1000),
      ]);

      setKtg({ teamA: parseOne(rawA), teamB: parseOne(rawB) });
    } catch (e) {
      setErr(`Analysis failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleTeamChange = (which, val) => {
    if (which === "a") { setTeamA(val); setKtg(null); }
    else { setTeamB(val); setKtg(null); }
  };

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* selectors */}
      <div className="mu-selectors" style={{ marginTop: 16 }}>
        <div className="mu-team-card">
          <div className="mu-label">Focal team</div>
          <select className="mu-select" value={teamA} onChange={e => handleTeamChange("a", e.target.value)}>
            <optgroup label="Focal Teams">
              {teams.focal.map(t => <option key={t} value={t}>{t}</option>)}
            </optgroup>
            <optgroup label="All Teams">
              {teams.opponents.map(t => <option key={t} value={t}>{t}</option>)}
            </optgroup>
          </select>
        </div>
        <div className="vs-text">VS</div>
        <div className="mu-team-card">
          <div className="mu-label">Opponent</div>
          <select className="mu-select" value={teamB} onChange={e => handleTeamChange("b", e.target.value)}>
            {teams.all.filter(t => t !== teamA).map(t => (
              <option key={t} value={t}>{t}{teams.focal.includes(t) ? " ★" : ""}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── INTELLIGENCE CARD: game sits + H2H in one surface ── */}
      {sA && sB && (
        <div className="h2h-wrap">

          {/* Game situation indicators — first, always visible */}
          {gameSits && (gameSits.speed.length > 0 || gameSits.power.length > 0 || gameSits.patient.length > 0 || gameSits.walkProne.length > 0) && (
            <>
              <div className="sec-title" style={{ margin: "0 0 12px", fontSize: 9 }}>Game situation indicators — {teamB}</div>
              <div className="gsit-grid" style={{ marginBottom: 16 }}>
                {gameSits.speed.length > 0 && (
                  <div className="gsit-card speed">
                    <div className="gsit-type">⚡ Speed threats</div>
                    {gameSits.speed.map(b => (
                      <div key={b.Player} className="gsit-item">
                        <span className="name">{b.Player}</span>
                        <span className="val">{b.SB} SB</span>
                      </div>
                    ))}
                  </div>
                )}
                {gameSits.power.length > 0 && (
                  <div className="gsit-card power">
                    <div className="gsit-type">💪 Power threats</div>
                    {gameSits.power.map(b => (
                      <div key={b.Player} className="gsit-item">
                        <span className="name">{b.Player}</span>
                        <span className="val">{b.HR} HR · {avg3(b.SLG)} SLG</span>
                      </div>
                    ))}
                  </div>
                )}
                {gameSits.patient.length > 0 && (
                  <div className="gsit-card patience">
                    <div className="gsit-type">👁 Patient hitters</div>
                    {gameSits.patient.map(b => (
                      <div key={b.Player} className="gsit-item">
                        <span className="name">{b.Player}</span>
                        <span className="val">{pct(safe(b.BB, b.PA))} BB%</span>
                      </div>
                    ))}
                  </div>
                )}
                {gameSits.walkProne.length > 0 && (
                  <div className="gsit-card walk-prone">
                    <div className="gsit-type">📋 Walk-prone pitchers</div>
                    {gameSits.walkProne.map(p => (
                      <div key={p.Pitcher} className="gsit-item">
                        <span className="name">{p.Pitcher}</span>
                        <span className="val">{pct(p.BBPct)} BB% · {p.BF} BF</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <hr style={{ border: "none", borderTop: "1px solid var(--bd)", margin: "0 0 14px" }} />
            </>
          )}

          {/* H2H stat bars */}
          <div className="h2h-header">
            <div className="h2h-team-name">{teamA}</div>
            <div className="h2h-metric-label">head to head</div>
            <div className="h2h-team-name right">{teamB}</div>
          </div>
          {[
            { label: "ERA",      a: sA.ERA,      b: sB.ERA,      fmt: fix2,  lowerBetter: true  },
            { label: "WHIP",     a: sA.WHIP,     b: sB.WHIP,     fmt: fix2,  lowerBetter: true  },
            { label: "K/BB",     a: clamp(sA.KBB,20), b: clamp(sB.KBB,20), fmt: fix1, lowerBetter: false },
            { label: "BB%",      a: sA.BBPct,    b: sB.BBPct,    fmt: pct,   lowerBetter: true  },
            { label: "Team AVG", a: sA.teamAVG,  b: sB.teamAVG,  fmt: avg3,  lowerBetter: false },
            { label: "Team OBP", a: sA.teamOBP,  b: sB.teamOBP,  fmt: avg3,  lowerBetter: false },
            { label: "Team OPS", a: sA.teamOBP + sA.teamSLG, b: sB.teamOBP + sB.teamSLG, fmt: avg3, lowerBetter: false },
            { label: "SB",       a: sA.teamSB,   b: sB.teamSB,   fmt: v => v, lowerBetter: false },
            { label: "HR",       a: sA.teamHR,   b: sB.teamHR,   fmt: v => v, lowerBetter: false },
          ].map(row => <H2HRow key={row.label} {...row} />)}
        </div>
      )}

      {/* ── ACCORDIONS ─────────────────────────────────────────── */}
      {oppPitchers.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div
            onClick={() => setPitchOpen(o => !o)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "var(--s2)", border: "1px solid var(--bd)", borderRadius: pitchOpen ? "var(--radius) var(--radius) 0 0" : "var(--radius)", cursor: "pointer", userSelect: "none" }}>
            <span style={{ fontSize: 11, fontFamily: "'Nunito Sans'", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".6px" }}>
              Opponent pitching — {teamB} · {oppPitchers.length} pitchers
            </span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{pitchOpen ? "▲" : "▼"}</span>
          </div>
          {pitchOpen && (
            <div style={{ border: "1px solid var(--bd)", borderTop: "none", borderRadius: "0 0 var(--radius) var(--radius)", padding: 14, background: "var(--s1)" }}>
              <div className="pitcher-cards">
                {oppPitchers.map(p => (
                  <div key={p.Pitcher} className="pc">
                    <div className="pc-name">{p.Pitcher}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                      {p.G} app · {fmtIP(p.Outs)} IP · {p.BF} BF
                    </div>
                    <div className="pc-stats">
                      {[
                        { v: p.K,  l: "K",    c: p.K >= 8 ? "c-g" : "" },
                        { v: p.BB, l: "BB",   c: p.BB >= 5 ? "c-r" : "" },
                        { v: p.Outs > 0 ? fix2(p.ERA)  : "—", l: "ERA",  c: p.Outs > 0 && (p.ERA <= 2.5 ? "c-g" : p.ERA >= 5 ? "c-r" : "") },
                        { v: p.Outs > 0 ? fix2(p.WHIP) : "—", l: "WHIP", c: p.Outs > 0 && (p.WHIP <= 1.2 ? "c-g" : p.WHIP >= 2 ? "c-r" : "") },
                        { v: p.Outs > 0 ? fix1(clamp(p.KBB,20))+(p.KBB>20?"+":"") : "—", l: "K/BB", c: p.Outs > 0 && p.KBB >= 2 ? "c-g" : "" },
                        { v: p.Outs > 0 ? pct(p.BBPct) : "—", l: "BB%",  c: p.Outs > 0 && p.BBPct >= 0.12 ? "c-r" : "" },
                      ].map(({ v, l, c }) => (
                        <div key={l} className="pc-stat">
                          <div className={`pc-stat-val ${c}`}>{v}</div>
                          <div className="pc-stat-lbl">{l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {oppBatters.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div
            onClick={() => setLineupOpen(o => !o)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "var(--s2)", border: "1px solid var(--bd)", borderRadius: lineupOpen ? "var(--radius) var(--radius) 0 0" : "var(--radius)", cursor: "pointer", userSelect: "none" }}>
            <span style={{ fontSize: 11, fontFamily: "'Nunito Sans'", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".6px" }}>
              Lineup threats — {teamB} · by OPS
            </span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{lineupOpen ? "▲" : "▼"}</span>
          </div>
          {lineupOpen && (
            <div style={{ border: "1px solid var(--bd)", borderTop: "none", borderRadius: "0 0 var(--radius) var(--radius)", padding: "4px 16px 8px", background: "var(--s1)" }}>
              {oppBatters.slice(0, 10).map((b, i) => {
                const isSpeed   = b.SB >= 2;
                const isPower   = b.HR >= 1;
                const isPatient = b.PA >= 5 && safe(b.BB, b.PA) >= 0.10;
                const isKProne  = b.PA >= 5 && safe(b.K, b.PA) >= 0.25;
                return (
                  <div key={b.Player} className="threat-row" style={{ opacity: b.PA < 12 ? 0.6 : 1 }}>
                    <div className="threat-rank">{i + 1}</div>
                    <div className="threat-name">{b.Player}
                      {(() => { const ht = hitterThreat(b); if (ht.tier === "LIMITED" || ht.tier === "LOW") return null; const cls = ht.tier === "ELITE" ? "tier-elite" : ht.tier === "HIGH" ? "tier-high" : "tier-moderate"; return <span className={`tier-badge ${cls}`}>{ht.tier}</span>; })()}
                    </div>
                    <div className="threat-ops c-a">{avg3(b.OPS)}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'Nunito Sans'", fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 80 }}>
                      {avg3(b.AVG)} AVG
                    </div>
                    <div className="threat-badges">
                      {isSpeed   && <span className="badge b-blue">⚡ {b.SB} SB</span>}
                      {isPower   && <span className="badge b-gold">💪 {b.HR} HR</span>}
                      {isPatient && <span className="badge b-amber">👁 {pct(safe(b.BB,b.PA))} BB</span>}
                      {isKProne  && <span className="badge b-muted">K {pct(safe(b.K,b.PA))}</span>}
                      {b.PA < 12 && <span className="badge b-muted">{b.PA} PA</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── MATCHUP EXPLOITS ─────────────────────────────────── */}
      {exploits.length > 0 && (
        <>
          <div className="sec-title">Matchup Exploits — {teamA} vs {teamB}</div>
          <div className="exploit-wrap">
            {exploits.map((e, i) => (
              <div key={i} className="exploit-item">
                <span className={`exploit-cat ${e.cat}`}>{e.cat}</span>
                <span className="exploit-text">{e.text}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── KEYS TO THE GAME ────────────────────────────────── */}
      <hr className="sec-divider" />
      <button className="gen-btn" onClick={generateKTG} disabled={loading || !teamA || !teamB}>
        {loading && <div className="spinner" />}
        {loading ? "Analyzing matchup…" : `Generate Keys to the Game — ${teamA} vs ${teamB}`}
      </button>

      {err && <div style={{ color: "var(--red)", fontSize: 13, marginBottom: 16, padding: "10px 14px", background: "var(--red-d)", borderRadius: 8, border: "1px solid rgba(224,85,85,.25)" }}>{err}</div>}

      <div className="sec-title">Keys to the Game</div>
      {!ktg && !loading && (
        <div className="g2" style={{ marginBottom: 16 }}>
          {[teamA, teamB].map(t => (
            <div key={t} className="ktg-placeholder">
              <p>Generate analysis<br />to see keys for {t}</p>
            </div>
          ))}
        </div>
      )}
      {loading && (
        <div className="ktg-generating">
          <div className="spinner" />
          <span>Building game plan analysis…</span>
        </div>
      )}
      {ktg && (
        <div className="ktg-grid">
          {[
            { key: "teamA", label: teamA, d: ktg.teamA },
            { key: "teamB", label: teamB, d: ktg.teamB },
          ].map(({ key, label, d }) => (
            <div key={key} className="ktg-panel">
              <div className="ktg-panel-hdr">
                <span className="ktg-panel-name">{label}</span>
                <span className="ktg-panel-badge">Keys to Win</span>
              </div>
              <div className="ktg-section hit">
                <div className="ktg-section-hdr">
                  <span className="ktg-section-icon">🏏</span>
                  <span className="ktg-section-label">Hitting</span>
                </div>
                {(d?.hitting || []).map((b, i) => <div key={i} className="ktg-bullet">{b}</div>)}
              </div>
              <div className="ktg-section pit">
                <div className="ktg-section-hdr">
                  <span className="ktg-section-icon">⚾</span>
                  <span className="ktg-section-label">Pitching</span>
                </div>
                {(d?.pitching || []).map((b, i) => <div key={i} className="ktg-bullet">{b}</div>)}
              </div>
              <div className="ktg-section str">
                <div className="ktg-section-hdr">
                  <span className="ktg-section-icon">⚡</span>
                  <span className="ktg-section-label">Strategy</span>
                </div>
                {(d?.strategy || []).map((b, i) => <div key={i} className="ktg-bullet">{b}</div>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── KEY PLAYERS ──────────────────────────────────────── */}
      <div className="sec-title">Key Players</div>
      <div className="kp-grid">
        {[
          { label: teamA, batters: keyBattersA, pitchers: keyPitchersA },
          { label: teamB, batters: keyBattersB, pitchers: keyPitchersB },
        ].map(({ label, batters, pitchers }) => (
          <div key={label} className="kp-panel">
            <div className="kp-panel-hdr">{label}</div>

            <div className="kp-sub-hdr">🏏 Hitting Leaders — by OPS</div>
            {batters.length === 0
              ? <div className="kp-row" style={{ color: "var(--muted)", fontSize: 12 }}>No batters with 8+ PA</div>
              : batters.map((b, i) => (
                <div key={b.Player} className="kp-row">
                  <div className="kp-rank">{i + 1}</div>
                  <div className="kp-name">{b.Player}
                    {(() => { const ht = hitterThreat(b); if (ht.tier === "LIMITED" || ht.tier === "LOW") return null; const cls = ht.tier === "ELITE" ? "tier-elite" : ht.tier === "HIGH" ? "tier-high" : "tier-moderate"; return <span className={`tier-badge ${cls}`}>{ht.tier}</span>; })()}
                  </div>
                  <div className={`kp-primary ${b.OPS >= 0.9 ? "c-g" : b.OPS >= 0.75 ? "c-a" : ""}`}>{avg3(b.OPS)}</div>
                  <div className="kp-secondary">{avg3(b.AVG)} AVG</div>
                  <div className="kp-tertiary">
                    {b.HR > 0 && <span className="badge b-gold" style={{ marginRight: 3 }}>💪{b.HR}</span>}
                    {b.SB > 0 && <span className="badge b-blue">⚡{b.SB}</span>}
                  </div>
                </div>
              ))
            }

            <div className="kp-sub-hdr">⚾ Pitching Leaders — by IP</div>
            {pitchers.length === 0
              ? <div className="kp-row" style={{ color: "var(--muted)", fontSize: 12 }}>No pitching data</div>
              : pitchers.map((p, i) => (
                <div key={p.Pitcher} className="kp-row">
                  <div className="kp-rank">{i + 1}</div>
                  <div className="kp-name">{p.Pitcher}
                    {(() => { const imp = pitcherImpact(p); if (imp.tier === "LIMITED" || imp.tier === "BELOW AVG") return null; const cls = imp.tier === "ACE" ? "tier-ace" : imp.tier === "QUALITY" ? "tier-quality" : "tier-average"; return <span className={`tier-badge ${cls}`}>{imp.emoji} {imp.tier}</span>; })()}
                  </div>
                  <div className={`kp-primary ${p.Outs > 0 && p.ERA <= 2.5 ? "c-g" : p.Outs > 0 && p.ERA >= 5 ? "c-r" : ""}`}>
                    {p.Outs > 0 ? fix2(p.ERA) : "—"}
                  </div>
                  <div className="kp-secondary">{p.Outs > 0 ? fix2(p.WHIP) : "—"} WHIP</div>
                  <div className="kp-tertiary">{fmtIP(p.Outs)} IP</div>
                </div>
              ))
            }
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CHAT TAB ─────────────────────────────────────────────────────────────────
function ChatTab({ data }) {
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
      setMsgs(prev => [...prev, { role: "ai", text: d.content?.find(b => b.type === "text")?.text || "No response." }]);
    } catch (e) {
      setMsgs(prev => [...prev, { role: "ai", text: `Error: ${e.message}` }]);
    } finally {
      setBusy(false);
      setTimeout(() => inpRef.current?.focus(), 50);
    }
  };

  return (
    <div className="chat-wrap" style={{ marginTop: 16 }}>
      <div className="chat-msgs">
        {msgs.length === 0 ? (
          <div className="chat-empty">
            <h3>Scout Assistant</h3>
            <p>Ask anything — any team, any player, any stat across the full repository.</p>
            <div className="suggestions">
              {SUGS.map(s => <button key={s} className="sug" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        ) : msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="msg-av">{m.role === "user" ? "you" : "AI"}</div>
            <div className="msg-bbl">{m.text}</div>
          </div>
        ))}
        {busy && (
          <div className="msg ai">
            <div className="msg-av">AI</div>
            <div className="msg-bbl"><div className="dots"><div className="dot"/><div className="dot"/><div className="dot"/></div></div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="chat-bar">
        <input ref={inpRef} className="chat-inp" placeholder="Ask about any team, player, or stat…"
          value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()} disabled={busy} />
        <button className="send-btn" onClick={() => send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [data,     setData]     = useState(null);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [tab,      setTab]      = useState("League");
  const [focalTeam, setFocalTeam] = useState("");
  const [drillTeam, setDrillTeam] = useState(null);   // League drill-down
  const [matchupForTeam, setMatchupForTeam] = useState(null); // cross-nav
  const fileRef = useRef(null);

  const teams = useMemo(() => data ? classifyTeams(data) : { focal: [], opponents: [], all: [] }, [data]);

  useEffect(() => {
    fetch("/data/RiverHill_Repository_Master.xlsx")
      .then(r => r.arrayBuffer())
      .then(buf => {
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const parsed = parseWorkbook(wb);
        setData(parsed);
        setFileName("RiverHill_Repository_Master.xlsx");
        const t = classifyTeams(parsed);
        setFocalTeam(t.focal.includes("RVRH") ? "RVRH" : t.focal[0] || "");
      })
      .catch(() => {});
  }, []);
useEffect(() => {
  fetch('/data/RiverHill_Repository_Master.xlsx')
    .then(r => r.arrayBuffer())
    .then(buf => {
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const parsed = parseWorkbook(wb);
      setData(parsed);
      setFileName('RiverHill_Repository_Master.xlsx');
      const t = classifyTeams(parsed);
      setFocalTeam(t.focal.includes('RVRH') ? 'RVRH' : t.focal[0] || '');
    })
    .catch(() => {}); // silently fall back to manual upload
}, []);


  const loadFile = useCallback(file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(e.target.result, { type: "array" });
      const parsed = parseWorkbook(wb);
      setData(parsed);
      setFileName(file.name);
      setDrillTeam(null);
      setMatchupForTeam(null);
      const t = classifyTeams(parsed);
      const first = t.focal.includes("RVRH") ? "RVRH" : t.focal[0] || "";
      setFocalTeam(first);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onDrop = e => { e.preventDefault(); setDragging(false); loadFile(e.dataTransfer.files[0]); };

  // Cross-tab navigation: from team profile → matchup
  const goToMatchup = useCallback(opponentId => {
    setMatchupForTeam(opponentId);
    setTab("Matchup");
  }, []);

  // When we switch to Matchup via goToMatchup, pass default team B
  const matchupDefaultB = tab === "Matchup" ? matchupForTeam : null;

  // Upload screen
  if (!data) return (
    <>
      <style>{CSS}</style>
      <div className="app" style={{ background: "var(--bg)" }}>
        <div className="upload-wrap">
          <div style={{ fontFamily: "'Nunito Sans'", fontWeight: 800, fontSize: 22, letterSpacing: 1, color: "var(--navy)", marginBottom: 4 }}>
            Hawks Scouting
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 24 }}>Load your master repository to get started.</div>
          <div
            className={`upload-zone ${dragging ? "drag" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="var(--muted)" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <h2>Drop Excel file here</h2>
            <p>or click to browse — accepts .xlsx</p>
            <button className="upload-btn" onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}>Choose file</button>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => loadFile(e.target.files[0])} />
        </div>
      </div>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => loadFile(e.target.files[0])} />

        <div className="topbar">
          <span className="brand">HAWKS <span>Scouting</span></span>
          <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'Nunito Sans'", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fileName}</span>
          {teams.focal.length > 0 && (
            <>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>focal team:</span>
              <select className="focal-select" value={focalTeam} onChange={e => { setFocalTeam(e.target.value); setDrillTeam(null); }}>
                {teams.focal.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </>
          )}
          <span className="spacer" />
          <button className="load-btn" onClick={() => fileRef.current?.click()}>↑ load new file</button>
        </div>

        <div className="tabs">
          {["League", "Matchup", "Chat"].map(t => (
            <div key={t} className={`tab ${tab === t ? "on" : ""}`}
              onClick={() => { setTab(t); if (t !== "League") setDrillTeam(null); }}>
              {t}
            </div>
          ))}
        </div>

        <div className="main">
          {tab === "League" && !drillTeam && (
            <LeagueTab data={data} teams={teams}
              onTeamClick={id => setDrillTeam(id)} />
          )}
          {tab === "League" && drillTeam && (
            <TeamProfile data={data} teamId={drillTeam} teams={teams}
              onBack={() => setDrillTeam(null)}
              onMatchup={id => goToMatchup(id)} />
          )}
          {tab === "Matchup" && (
            <MatchupTab data={data} teams={teams}
              defaultTeamA={focalTeam}
              defaultTeamB={matchupDefaultB} />
          )}
          {tab === "Chat" && <ChatTab data={data} />}
        </div>
      </div>
    </>
  );
}
