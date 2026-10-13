#!/usr/bin/env node
// NBA player-prop projections + leak-free backtest -> nba-snapshot.json (+ nba-prop-predictor.html from the template).
//
//   node build-nba-snapshot.mjs                 seasons 2025 2026 2027 (ESPN names a season by the year it ends)
//   BT_EXPERIMENTS=1 node build-nba-snapshot.mjs   flip every model switch and print both halves
//   SKIP_LIVE=1 ...                             backtest only (no rosters, no files written)
//
// Model (one MODEL config drives the backtest AND the live numbers the app ships):
//   projection = expected minutes x per-minute production
//     per-minute rate: recency-weighted over his played games (this season; last season at wPrior), shrunk toward the
//       per-minute average of his position
//     minutes: a faster recency average of his played games, then moved by who is IN or OUT tonight compared with the
//       team's recent games (a regular who sits hands his minutes to the others; one who returns takes them back)
//     context: tonight's Vegas total against the league's usual total
//   P(over a line) comes from the empirical spread of actual / projection for projections of that size (quantile tables,
//   learned on the other half of the season), not an assumed bell curve.
// Every switch has to beat its "off" setting on BOTH halves of the test season to stay on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSeason } from './fetch-gamelog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);
const SEASONS = process.argv.slice(2).map(Number).filter(Boolean);
if (!SEASONS.length) SEASONS.push(2025, 2026, 2027);
const TRAIN = SEASONS[0], TEST = SEASONS[1] || SEASONS[0], CUR = SEASONS[SEASONS.length - 1];

export const MODEL = {
  wPrior: 0.4,        // a game from last season counts this much
  rateHL: 25,         // games: half-life of the per-minute rates
  minHL: 4,           // games: half-life of expected minutes
  minPrior: 'season', // what last season says about his minutes: 'season' = its full-season average, worth minPriorG games
                      // ('recent' = its last games, i.e. April, when stars rest and tanking teams shut players down)
  minPriorG: 1,
  shrinkMin: 25,      // pseudo-minutes at his position's per-minute rate
  vac: true,          // move minutes when regulars are out / back (beta fitted on the train season)
  vacWindow: 5,       // team games that define "recently playing"
  ctx: ['pts', 'reb', 'pra'],   // stats that scale with tonight's total (a cross-fitted on the test season); ast / tpm didn't win both halves
  calib: ['pts', 'pra'],        // stats whose probabilities are squeezed toward 50% by a fitted slope (cross-fit): their extremes ran over-confident
  method: 'minrate',  // 'minrate' | 'ewma' (recency average of the stat itself) | 'naive' (season average)
  lam: 1,             // weight on the projection; the rest goes to his plain season average
  minBlend: 0,        // share of expected minutes taken from his season minutes instead of the fast recency average
  stats: {
    pts: { label: 'Points', floor: 8 }, reb: { label: 'Rebounds', floor: 3.5 }, ast: { label: 'Assists', floor: 2.5 },
    tpm: { label: '3-pointers', floor: 1.0 }, pra: { label: 'Pts+Reb+Ast', floor: 14 },
  },
  buckets: 4, quantiles: 201, minGames: 5,
};
const STATS = Object.keys(MODEL.stats), BASE = ['pts', 'reb', 'ast', 'tpm'];
const POSG = p => /C/.test(p) && !/G/.test(p) ? 'C' : /F/.test(p) ? 'F' : 'G';
const val = (h, s) => s === 'pra' ? h.pts + h.reb + h.ast : h[s];

// ------------------------------------------------------------------ data
const GL = {};
for (const S of SEASONS) GL[S] = await ensureSeason(S, log);
const names = {}; for (const S of SEASONS) Object.assign(names, GL[S].players);
// per-player history of PLAYED games, and each team's game list (who played / who sat), in time order
const hist = new Map(), teamGames = new Map();   // pid -> [{S,t,team,min,pts,reb,ast,tpm,st}] ; S|team -> [{t, played:Set, listed:Set}]
for (const S of SEASONS) for (const g of GL[S].games) { const t = Date.parse(g.d);
  for (const tm of [g.h, g.a]) { const k = S + '|' + tm; if (!teamGames.has(k)) teamGames.set(k, []);
    const rows = g.p.filter(r => r[1] === tm); teamGames.get(k).push({ t, id: g.id, played: new Set(rows.filter(r => !r[8] && r[3] > 0).map(r => r[0])), listed: new Set(rows.map(r => r[0])) }); }
  for (const r of g.p) { if (r[8] || !(r[3] > 0)) continue; if (!hist.has(r[0])) hist.set(r[0], []);
    hist.get(r[0]).push({ S, t, team: r[1], min: r[3], pts: r[4], reb: r[5], ast: r[6], tpm: r[7], st: r[2] }); } }
const avgOU = {}; for (const S of SEASONS) { const xs = GL[S].games.map(g => g.ou).filter(x => x > 150); avgOU[S] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
// position priors: per-minute production of each position group in the train season
const prior = {}; { const acc = {};
  for (const [pid, H] of hist) { const pg = POSG((names[pid] || [])[1] || ''); const a = acc[pg] || (acc[pg] = { min: 0, pts: 0, reb: 0, ast: 0, tpm: 0 });
    for (const h of H) if (h.S === TRAIN) { a.min += h.min; for (const s of BASE) a[s] += h[s]; } }
  for (const [pg, a] of Object.entries(acc)) prior[pg] = Object.fromEntries(BASE.map(s => [s, a.min ? a[s] / a.min : 0])); }

// ------------------------------------------------------------------ model
// everything known about a player BEFORE time t of season S: weighted rates, expected minutes, season averages
function feat(pid, S, t, M = MODEL) {
  const all = hist.get(pid) || [], H = []; for (const h of all) if ((h.S === S && h.t < t) || h.S === S - 1) H.push(h);
  if (!H.length) return null;
  const cur = H.filter(h => h.S === S), pg = POSG((names[pid] || [])[1] || ''), pr = prior[pg] || prior.F;
  let wm = 0, sm = 0, wr = 0, smin = 0; const ss = { pts: 0, reb: 0, ast: 0, tpm: 0 }, ew = { w: 0, pts: 0, reb: 0, ast: 0, tpm: 0 };
  const nCur = cur.length, prev = H.length - nCur;
  for (let k = 0; k < H.length; k++) { const h = H[H.length - 1 - k], base = h.S === S ? 1 : M.wPrior;
    // minutes: this season's games decay by recency; last season counts as minPriorG games at its season average
    const a = h.S === S || M.minPrior !== 'season' ? base * Math.pow(0.5, k / M.minHL) : Math.pow(0.5, nCur / M.minHL) * M.minPriorG / prev;
    wm += a; sm += a * h.min;
    const b = base * Math.pow(0.5, k / M.rateHL); wr += b; smin += b * h.min; for (const s of BASE) ss[s] += b * h[s];
    ew.w += a; for (const s of BASE) ew[s] += a * h[s]; }
  const rate = {}; for (const s of BASE) rate[s] = (ss[s] + M.shrinkMin * pr[s]) / (smin + M.shrinkMin);
  const avg = {}; const src = src0(cur, H); for (const s of BASE) avg[s] = src.reduce((x, h) => x + h[s], 0) / src.length;
  const mpg0 = src0(cur, H).reduce((x, h) => x + h.min, 0) / src0(cur, H).length;
  return { g: H.length, gc: cur.length, min: (1 - M.minBlend) * sm / wm + M.minBlend * mpg0, rate, avg, ewma: Object.fromEntries(BASE.map(s => [s, ew[s] / ew.w])), mpg: src.reduce((x, h) => x + h.min, 0) / src.length };
}
const src0 = (cur, H) => cur.length >= 5 ? cur : H;   // season-to-date once there are 5 games, else last season too
// how often he played in the team's recent games (1 = a regular who has been playing, 0 = has been out)
function recentShare(pid, S, team, t, M = MODEL) {
  const G = teamGames.get(S + '|' + team) || []; let n = 0, p = 0;
  for (let i = G.length - 1; i >= 0 && n < M.vacWindow; i--) { if (G[i].t >= t) continue; n++; if (G[i].played.has(pid)) p++; }
  return n ? p / n : null;   // null: no team games yet this season
}
// minutes moved by tonight's absences / returns, shared out by expected minutes. roster = [{pid, min, share, active}]
function vacancyMinutes(roster, beta) {
  let V = 0, act = 0;
  for (const r of roster) { if (r.min == null || r.min < 8) continue; const sh = r.share == null ? 1 : r.share; V += r.min * (sh - (r.active ? 1 : 0)); if (r.active) act += r.min; }
  return { V: V * beta, act };
}
const base = (s, F, method) => { const b = s2 => method === 'naive' ? F.avg[s2] : method === 'ewma' ? F.ewma[s2] : F.min * F.rate[s2]; return s === 'pra' ? b('pts') + b('reb') + b('ast') : b(s); };
// the projection for one stat. vac = {V, act} for his team tonight (or null), ou = tonight's total (or null)
export function project(s, F, P, vac, ou, ouAvg, M = MODEL) {
  let mu = base(s, F, M.method);
  if (M.method === 'minrate' && M.vac && vac && vac.act > 0) { const m2 = Math.max(0, Math.min(42, F.min + vac.V * F.min / vac.act)); mu *= F.min > 0 ? m2 / F.min : 1; }
  if (M.lam < 1) mu = M.lam * mu + (1 - M.lam) * base(s, F, 'naive');
  if (M.ctx && M.ctx.includes(s) && ou > 150 && ouAvg) mu *= Math.exp(P.a[s] * (ou - ouAvg) / ouAvg);
  return mu;
}

// one row per player who PLAYED in each game of a season, with everything the model may know beforehand
function rowsOf(S, M = MODEL) {
  const out = [], games = GL[S].games;
  games.forEach((g, gi) => { const t = Date.parse(g.d);
    for (const tm of [g.h, g.a]) {
      const listed = g.p.filter(r => r[1] === tm), roster = [];
      for (const r of listed) { const F = feat(r[0], S, t, M); roster.push({ pid: r[0], F, min: F ? F.min : null, share: recentShare(r[0], S, tm, t, M), active: !r[8] && r[3] > 0, r }); }
      for (const x of roster) { if (!x.active || !x.F || x.F.g < M.minGames) continue;
        out.push({ gi, half: gi < games.length / 2 ? 1 : 2, pid: x.pid, F: x.F, roster, ou: g.ou, act: { pts: x.r[4], reb: x.r[5], ast: x.r[6], tpm: x.r[7], pra: x.r[4] + x.r[5] + x.r[6] }, mins: x.r[3] }); } } });
  return out;
}
const projRow = (s, r, P, M = MODEL) => project(s, r.F, P.aH ? { ...P, a: P.aH[r.half] } : P, M.vac ? vacancyMinutes(r.roster, P.beta) : null, r.ou, P.ouAvg, M);
// fit on the train season: beta (how much of the vacated minutes the others absorb) and a (total sensitivity) per stat
function fitParams(S, M = MODEL) {
  const rows = rowsOf(S, M), P = { beta: 0, a: Object.fromEntries(STATS.map(s => [s, 0])), ouAvg: avgOU[S] };
  const mse = (s, P2, f = r => projRow(s, r, P2, M)) => { let e = 0, n = 0; for (const r of rows) { const mu = f(r); e += (mu - r.act[s]) ** 2; n++; } return e / n; };
  if (M.method === 'minrate' && M.vac) { let best = null; for (const b of [0, 0.2, 0.4, 0.6, 0.8, 1]) { const e = mse('pra', { ...P, beta: b }); if (!best || e < best.e) best = { b, e }; } P.beta = best.b; }
  return P;
}
// total sensitivity a per stat, from a set of rows that have totals
function fitCtx(rows, P, M = MODEL) {
  const a = Object.fromEntries(STATS.map(s => [s, 0])), R = rows.filter(r => r.ou > 150); if (!M.ctx || !M.ctx.length || R.length < 500) return a;
  for (const s of M.ctx) { let best = null; for (const x of [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]) { let e = 0; const P2 = { ...P, aH: null, a: { ...a, [s]: x } };
      for (const r of R) e += (projRow(s, r, P2, M) - r.act[s]) ** 2; if (!best || e < best.e) best = { x, e }; } a[s] = best.x; }
  return a;
}
// the full parameter set for scoring the test season: beta from the train season, a learned on the OTHER half of the test season
function paramsFor(M, rows) { const P = fitParams(TRAIN, M); P.ouAvg = avgOU[TEST] || avgOU[TRAIN];
  P.aH = { 1: fitCtx(rows.filter(r => r.half === 2), P, M), 2: fitCtx(rows.filter(r => r.half === 1), P, M) }; P.a = fitCtx(rows, P, M); return P; }
// actual / projection ratios, bucketed by projection size, compressed to quantiles (what ships)
function ratioTable(pts, M = MODEL) {
  pts = pts.filter(p => p.mu > 0.05).sort((a, b) => a.mu - b.mu); const nb = M.buckets, nq = M.quantiles, edges = [], q = [];
  for (let i = 0; i < nb; i++) { const sl = pts.slice(Math.floor(i * pts.length / nb), Math.floor((i + 1) * pts.length / nb)), xs = sl.map(p => p.y / p.mu).sort((a, b) => a - b);
    if (i < nb - 1) edges.push(+sl[sl.length - 1].mu.toFixed(3)); q.push(Array.from({ length: nq }, (_, j) => +xs[Math.round(j * (xs.length - 1) / (nq - 1))].toFixed(4))); }
  return { edges, q };
}
// P(stat > line) — the app's propPOver() is a copy of this; keep them identical
export function propPOver(tab, mu, L) {
  if (!(mu > 0)) return 0;
  let bk = tab.edges.findIndex(e => mu <= e); if (bk < 0) bk = tab.q.length - 1;
  const q = tab.q[bk], n = q.length, x = L / mu;
  if (x < q[0]) return 1; if (x >= q[n - 1]) return 0;
  let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (q[m] <= x) lo = m; else hi = m - 1; }
  return 1 - (lo + (q[lo + 1] > q[lo] ? (x - q[lo]) / (q[lo + 1] - q[lo]) : 0)) / (n - 1);
}
const squeeze = (p, b) => b === 1 ? p : 1 / (1 + Math.exp(-b * Math.log(p / (1 - p))));
// score one configuration on the test season: MAE, and Brier at a book-like line (his season average, on the half point)
function score(M, P, rows) {
  const out = {};
  for (const s of STATS) {
    const pop = rows.filter(r => base(s, r.F, 'naive') >= M.stats[s].floor).map(r => ({ r, mu: projRow(s, r, P, M), y: r.act[s], line: Math.floor(base(s, r.F, 'naive')) + 0.5 }));
    const tabs = { 1: ratioTable(pop.filter(x => x.r.half === 2), M), 2: ratioTable(pop.filter(x => x.r.half === 1), M) };   // cross-fit
    const H = { 1: { b: 0, n: 0, ae: 0 }, 2: { b: 0, n: 0, ae: 0 } }, cal = Array.from({ length: 5 }, () => ({ n: 0, p: 0, y: 0 }));
    for (const x of pop) { x.p0 = Math.min(0.995, Math.max(0.005, propPOver(tabs[x.r.half], x.mu, x.line))); x.o = x.y > x.line ? 1 : 0; }
    const slopeOf = X => { let best = null; for (let b = 0.4; b <= 1.201; b += 0.05) { let e = 0; for (const x of X) e += (squeeze(x.p0, b) - x.o) ** 2; if (!best || e < best.e) best = { b: +b.toFixed(2), e }; } return best.b; };
    const slope = M.calib && M.calib.includes(s) ? { 1: slopeOf(pop.filter(x => x.r.half === 2)), 2: slopeOf(pop.filter(x => x.r.half === 1)), all: slopeOf(pop) } : { 1: 1, 2: 1, all: 1 };
    for (const x of pop) { const h = H[x.r.half], p = squeeze(x.p0, slope[x.r.half]), o = x.o; h.b += (p - o) ** 2; h.n++; h.ae += Math.abs(x.mu - x.y);
      const c = cal[Math.min(4, Math.floor(p * 5))]; c.n++; c.p += p; c.y += o; }
    out[s] = { n: pop.length, b1: H[1].b / H[1].n, b2: H[2].b / H[2].n, mae1: H[1].ae / H[1].n, mae2: H[2].ae / H[2].n,
      slope: slope.all, cal: cal.filter(c => c.n >= 60).map(c => ({ pred: +(c.p / c.n).toFixed(3), actual: +(c.y / c.n).toFixed(3), n: c.n })), table: ratioTable(pop, M) };
  }
  return out;
}

// ------------------------------------------------------------------ backtest
log(`\n== backtest: train ${TRAIN} (${GL[TRAIN].games.length} games) -> test ${TEST} (${GL[TEST].games.length} games); league total ${avgOU[TRAIN] && avgOU[TRAIN].toFixed(1)} / ${avgOU[TEST] && avgOU[TEST].toFixed(1)}`);
const testRows = rowsOf(TEST), P = paramsFor(MODEL, testRows);
log(`   vacated-minutes share beta=${P.beta} (fitted on ${TRAIN}); total sensitivity a=${STATS.map(s => s + ' ' + P.a[s]).join(', ')} (fitted on ${TEST}, cross-fit by half when scored)`);
const R = score(MODEL, P, testRows), NV = score({ ...MODEL, method: 'naive', vac: false, ctx: false }, P, testRows);
const f4 = x => x.toFixed(4), f2 = x => x.toFixed(2);
for (const s of STATS) log(`   ${s.padEnd(4)} n=${R[s].n}  Brier ${f4(R[s].b1)}/${f4(R[s].b2)} vs season-average ${f4(NV[s].b1)}/${f4(NV[s].b2)}   MAE ${f2(R[s].mae1)}/${f2(R[s].mae2)} vs ${f2(NV[s].mae1)}/${f2(NV[s].mae2)}   cal ${R[s].cal.map(c => `${(c.pred * 100).toFixed(0)}->${(c.actual * 100).toFixed(0)}% (${c.n})`).join(' ')}`);
if (process.env.BT_EXPERIMENTS) {
  log('\n== switches (Brier half1/half2, lower is better; a switch stays only if it wins BOTH halves) ==');
  const run = (name, M) => { const rw = rowsOf(TEST, M), P2 = paramsFor(M, rw), r = score(M, P2, rw); log(`   ${name.padEnd(26)} ` + STATS.map(s => `${s} ${f4(r[s].b1)}/${f4(r[s].b2)}`).join('  ') + (M.vac ? `  [beta ${P2.beta}]` : '')); };
  run('shipped', MODEL);
  run('method: ewma', { ...MODEL, method: 'ewma' }); run('method: naive', { ...MODEL, method: 'naive' });
  run('vacated minutes OFF', { ...MODEL, vac: false }); run('total context OFF', { ...MODEL, ctx: [] });
  run('minutes prior: recent', { ...MODEL, minPrior: 'recent' }); for (const g of [1, 6]) run(`minutes prior worth ${g} g`, { ...MODEL, minPriorG: g });
  run('calibration: none', { ...MODEL, calib: [] }); run('calibration: all stats', { ...MODEL, calib: STATS });
  run('context: all stats', { ...MODEL, ctx: STATS });
  for (const hl of [8, 25, 50]) run(`rate half-life ${hl}`, { ...MODEL, rateHL: hl });
  for (const hl of [2, 7, 12]) run(`minutes half-life ${hl}`, { ...MODEL, minHL: hl });
  for (const k of [0, 25, 50, 100, 500]) run(`shrink ${k} min`, { ...MODEL, shrinkMin: k });
  for (const w of [0.1, 0.2, 0.3, 0.4, 1]) run(`last season x${w}`, { ...MODEL, wPrior: w });
  for (const l of [0.5, 0.7, 0.85]) run(`blend with season avg ${l}`, { ...MODEL, lam: l });
  for (const w of [0.25, 0.5, 0.75]) run(`minutes from season ${w}`, { ...MODEL, minBlend: w });
  for (const w of [3, 10]) run(`vacancy window ${w}`, { ...MODEL, vacWindow: w });
}
export const BACKTEST = { train: TRAIN, test: TEST, params: P, stats: Object.fromEntries(STATS.map(s => [s, { n: R[s].n, brier: [+f4(R[s].b1), +f4(R[s].b2)], naive: [+f4(NV[s].b1), +f4(NV[s].b2)],
  mae: [+f2(R[s].mae1), +f2(R[s].mae2)], naiveMae: [+f2(NV[s].mae1), +f2(NV[s].mae2)], cal: R[s].cal, beatsNaive: R[s].b1 < NV[s].b1 && R[s].b2 < NV[s].b2 }])) };
if (process.env.SKIP_LIVE) process.exit(0);

// ------------------------------------------------------------------ live snapshot: teams, rosters, each player's inputs
const getJson = async url => { for (let t = 1; ; t++) { try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); } catch (e) { if (t >= 4) throw e; await new Promise(r => setTimeout(r, 700 * t)); } } };
const tj = await getJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=40');
const espnTeams = tj.sports[0].leagues[0].teams.map(x => x.team);
const teams = {}, rosters = {}, now = Date.now(); let missing = [];
for (const t of espnTeams) {
  teams[t.abbreviation] = { id: String(t.id), abbr: t.abbreviation, name: t.displayName, short: t.shortDisplayName || t.name, color: '#' + (t.color || '444444'), alt: '#' + (t.alternateColor || '888888'), logo: (t.logos && t.logos[0] && t.logos[0].href) || '' };
  let rj; try { rj = await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${t.id}/roster`); } catch (e) { missing.push(t.abbreviation); continue; }
  const list = [];
  for (const a of (rj.athletes || [])) { const id = String(a.id); if (!names[id]) names[id] = [a.displayName || a.fullName, (a.position && a.position.abbreviation) || ''];
    const F = feat(id, CUR, now + 864e5), sh = recentShare(id, CUR, t.abbreviation, now + 864e5);
    if (!F) { list.push({ id, name: a.displayName || a.fullName, pos: (a.position && a.position.abbreviation) || '', g: 0 }); continue; }
    list.push({ id, name: a.displayName || a.fullName, pos: (a.position && a.position.abbreviation) || '', g: F.g, gc: F.gc, min: +F.min.toFixed(1), mpg: +F.mpg.toFixed(1), sh: sh == null ? null : +sh.toFixed(2),
      rate: Object.fromEntries(BASE.map(s => [s, +F.rate[s].toFixed(4)])), avg: Object.fromEntries(BASE.map(s => [s, +F.avg[s].toFixed(1)])) }); }
  rosters[t.abbreviation] = list.sort((x, y) => (y.min || 0) - (x.min || 0));
}
if (missing.length) throw new Error('rosters missing for ' + missing.join(', ') + ' — nothing written');
// what ships is what was scored: the test season's tables with the shipped switches, and the train-fitted parameters
const snapshot = { builtAt: new Date().toISOString(), seasons: SEASONS, season: CUR, teams, teamList: Object.keys(teams).sort(), rosters,
  model: { method: MODEL.method, vac: MODEL.vac, ctx: MODEL.ctx, calib: MODEL.calib, minGames: MODEL.minGames, beta: P.beta, a: P.a, ouAvg: +(avgOU[CUR] || avgOU[TEST] || P.ouAvg).toFixed(1), stats: MODEL.stats,
    tables: Object.fromEntries(STATS.map(s => [s, R[s].table])), slope: Object.fromEntries(STATS.map(s => [s, R[s].slope])), backtest: BACKTEST.stats, train: TRAIN, test: TEST },
  marketAnchor: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'market_anchor.json'), 'utf8')).app || null; } catch { return null; } })() };
const snapFile = path.join(__dirname, 'nba-snapshot.json'); fs.writeFileSync(snapFile, JSON.stringify(snapshot));
log(`\n  wrote ${path.basename(snapFile)} (${(fs.statSync(snapFile).size / 1e6).toFixed(2)} MB): ${Object.keys(teams).length} teams, ${Object.values(rosters).reduce((a, r) => a + r.length, 0)} players`);
const tplFile = path.join(__dirname, 'nba-prop-predictor.template.html');
if (fs.existsSync(tplFile)) { const html = fs.readFileSync(tplFile, 'utf8').replace('/*__SNAPSHOT__*/', () => 'window.__SNAPSHOT__ = ' + JSON.stringify(snapshot) + ';');
  fs.writeFileSync(path.join(__dirname, 'nba-prop-predictor.html'), html); log(`  wrote nba-prop-predictor.html (${(html.length / 1e6).toFixed(2)} MB)`); }
log('=== done ===');
