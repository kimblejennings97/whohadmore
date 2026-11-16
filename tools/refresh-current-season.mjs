// Refreshes the current season of NFL, NBA and MLB in data-<sport>.js from the stat-analysis data feed
// (https://github.com/kimblejennings97/stat-analysis, `data` branch), which is rebuilt daily in season.
// Older seasons in the data files are left exactly as they are.
//
//   node tools/refresh-current-season.mjs            (reads the published feed)
//   SA_DATA=../stat-analysis/public/data node tools/refresh-current-season.mjs   (reads a local build)
//
// Rules match the existing files:
//   NFL  season totals, regular season; each stat only listed if it clears a floor (scaled to games played so far)
//   MLB  hitters with enough PA get hr/h/rbi/r/sb/bb/dbl; pitchers with enough IP (or saves) get k/w/sv; zeros omitted
//   NBA  per-game averages (1 decimal) + gp for players with >= half their team's games; seasons keyed by start year
// Team = the player's last team that season. Names reuse the existing spelling (accents) so careers stay joined.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEED = process.env.SA_DATA || "https://raw.githubusercontent.com/kimblejennings97/stat-analysis/data";

async function load(rel) {
  if (!/^https?:/.test(FEED)) return JSON.parse(fs.readFileSync(path.join(FEED, rel), "utf8"));
  for (let i = 1; i <= 4; i++) {
    const r = await fetch(`${FEED}/${rel}?t=${Date.now()}`);
    if (r.ok) return r.json();
    if (i === 4) throw new Error(`${r.status} ${rel}`);
    await new Promise((res) => setTimeout(res, 2000 * i));
  }
}

// name keys: norm = no accents, punctuation or "(POS)" tag; loose = also no Jr./Sr./II-IV suffix
// (exact key first, so "Marvin Harrison Jr." never lands on his father "Marvin Harrison")
const norm = (s) => s.replace(/\s*\([^)]*\)\s*$/, "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const loose = (s) => norm(s).replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
const tagOf = (s) => (s.match(/\(([^)]*)\)\s*$/) || [])[1] || null;

// Reuse the existing spelling of each name so careers stay joined. In MLB, same-name players are told
// apart with a "(POS)" tag (e.g. "Max Muncy (3B)"); r[4] carries the new row's position for that.
function canonicalize(D, newRows) {
  const exact = new Map(), approx = new Map();
  const add = (m, k, n) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(n); };
  for (const r of D) { add(exact, norm(r[0]), r[0]); add(approx, loose(r[0]), r[0]); }
  const allNames = new Set(D.map((r) => r[0]));
  const dupNew = new Map();
  for (const r of newRows) dupNew.set(norm(r[0]), (dupNew.get(norm(r[0])) || 0) + 1);
  for (const r of newRows) {
    const k = norm(r[0]), pos = r[4];
    // 1) identical spelling (the data keeps e.g. "Luis Garcia" and "Luis García" as two players)
    if (allNames.has(r[0]) && !(pos && dupNew.get(k) > 1)) { r.length = 4; continue; }
    // 2) same name ignoring accents/punctuation, 3) also ignoring Jr./II
    let names = [...(exact.get(k) || [])];
    if (!names.length) {
      // suffix differs between sources ("Bobby Witt" vs "Bobby Witt Jr."): accept only an unambiguous match
      const cands = [...(approx.get(loose(r[0])) || [])];
      if (new Set(cands.map(norm)).size === 1) names = cands;
    }
    const tagged = names.filter((n) => tagOf(n));
    if (pos && (tagged.length || dupNew.get(k) > 1)) {
      const want = /^(SP|RP|P)$/.test(pos) ? "P" : pos;
      const plain = names.find((n) => !tagOf(n)) || r[0].replace(/\s*\([^)]*\)\s*$/, "");
      r[0] = tagged.find((n) => tagOf(n) === want) || `${plain} (${want})`;
    } else if (names.length) r[0] = names.find((n) => !tagOf(n)) || names[0];
    r.length = 4;
  }
}
const r1 = (x) => Math.round(x * 10) / 10;
// BACKTEST=1 rebuilds the previous season and reports how well it matches the existing rows (writes nothing).
const BACK = process.env.BACKTEST ? 1 : 0;

// ---- read/write the data-<sport>.js files without disturbing anything but D and ymax
function readGame(sport) {
  const file = path.join(ROOT, `data-${sport}.js`);
  const text = fs.readFileSync(file, "utf8");
  const ctx = { window: {} };
  ctx.window.SPORTS = {};
  ctx.SPORTS = ctx.window.SPORTS;
  vm.runInNewContext(text.replace(/window\.SPORTS=window\.SPORTS\|\|\{\};/, ""), ctx);
  return { file, text, data: ctx.SPORTS[sport] };
}
function findArray(text, start) {
  // start = index of "[" ; returns index after the matching "]" (skips strings)
  let depth = 0, q = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i + 1;
  }
  throw new Error("unbalanced D array");
}
function writeGame(g, rows, ymax) {
  const at = g.text.indexOf("D:[");
  if (at < 0) throw new Error(`${g.file}: no D array`);
  const end = findArray(g.text, at + 2);
  let out = g.text.slice(0, at) + "D:" + JSON.stringify(rows) + g.text.slice(end);
  out = out.replace(/ymax:\d+/, `ymax:${ymax}`);
  if (out !== g.text) { fs.writeFileSync(g.file, out); return true; }
  return false;
}

function merge(sport, year, newRows) {
  const g = readGame(sport);
  canonicalize(g.data.D, newRows);
  if (BACK) {
    const old = g.data.D.filter((r) => r[1] === year), key = (r) => r[0];
    const om = new Map(old.map((r) => [key(r), r])), nm = new Map(newRows.map((r) => [key(r), r]));
    let both = 0, sameTeam = 0, cells = 0, sameCells = 0;
    for (const [k, n] of nm) { const o = om.get(k); if (!o) continue; both++; if (o[2] === n[2]) sameTeam++;
      for (const st of new Set([...Object.keys(o[3]), ...Object.keys(n[3])])) { cells++; if (Math.abs((o[3][st] ?? -1) - (n[3][st] ?? -1)) < 0.051) sameCells++; } }
    console.log(`BACKTEST ${sport} ${year}: existing ${old.length}, rebuilt ${newRows.length}, both ${both}, same team ${sameTeam}, stat cells equal ${sameCells}/${cells}`);
    console.log("  only existing:", old.filter((r) => !nm.has(key(r))).slice(0, 6).map((r) => r[0] + JSON.stringify(r[3])).join(" | "));
    console.log("  only rebuilt:", newRows.filter((r) => !om.has(key(r))).slice(0, 6).map((r) => r[0] + JSON.stringify(r[3])).join(" | "));
    return false;
  }
  const rows = g.data.D.filter((r) => r[1] !== year).concat(newRows)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const ymax = Math.max(g.data.ymax, year);
  const before = g.data.D.filter((r) => r[1] === year).length;
  const changed = writeGame(g, rows, ymax);
  console.log(`${sport} ${year}: ${before} -> ${newRows.length} rows${changed ? "" : " (no change)"}`);
  return changed;
}

// season totals per player (regular season), last team, and team games so far
function totals(P, cols) {
  const I = Object.fromEntries(P.cols.map((c, i) => [c, i]));
  const t = I.date != null ? I.date : I.week;
  const by = new Map(), teamGames = new Map();
  for (const r of P.rows) {
    if (r[I.stype] !== "R") continue;
    let e = by.get(r[I.pid]);
    if (!e) by.set(r[I.pid], (e = { team: r[I.team], last: -1, s: Object.fromEntries(cols.map((c) => [c, 0])) }));
    if (r[t] >= e.last) { e.last = r[t]; e.team = r[I.team]; }
    for (const c of cols) e.s[c] += r[I[c]] || 0;
  }
  return { by, I };
}
async function teamGamesSoFar(sport, season) {
  const T = await load(`${sport}/teams_${season}.json`);
  const I = Object.fromEntries(T.cols.map((c, i) => [c, i]));
  const g = new Map();
  for (const r of T.rows) if (r[I.stype] === "R") g.set(r[I.team], (g.get(r[I.team]) || 0) + (r[I.games] || 1));
  return Math.max(...g.values());
}

// ---- NFL
async function nfl() {
  const meta = await load("nfl/meta.json");
  const season = meta.latestSeason - BACK;
  const P = await load(`nfl/players_${season}.json`);
  const cols = ["passing_tds", "passing_yards", "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "def_sacks"];
  const { by } = totals(P, cols);
  const frac = Math.min(1, (await teamGamesSoFar("nfl", season)) / 17);
  const FLOOR = { passTD: 8, passYds: 1500, rushYds: 400, rushTD: 3, rec: 30, recYds: 400, recTD: 3, sacks: 4 };
  const MAP = { passTD: "passing_tds", passYds: "passing_yards", rushYds: "rushing_yards", rushTD: "rushing_tds", rec: "receptions", recYds: "receiving_yards", recTD: "receiving_tds", sacks: "def_sacks" };
  const rows = [];
  for (const [pid, e] of by) {
    const s = {};
    for (const [k, c] of Object.entries(MAP)) if (e.s[c] > 0 && e.s[c] >= Math.max(1, Math.round(FLOOR[k] * frac))) s[k] = e.s[c];
    if (Object.keys(s).length) rows.push([P.people[pid][0], season, e.team, s]);
  }
  return merge("nfl", season, rows);
}

// ---- MLB
async function mlb() {
  const meta = await load("mlb/meta.json");
  const season = meta.latestSeason - BACK;
  const P = await load(`mlb/players_${season}.json`);
  const cols = ["pa", "hr", "h", "rbi", "r", "sb", "bb", "doubles", "p_outs", "p_so", "p_w", "p_sv"];
  const { by } = totals(P, cols);
  const tg = await teamGamesSoFar("mlb", season);
  const rows = [];
  for (const [pid, e] of by) {
    const s = {}, v = e.s;
    if (v.pa >= 1.3 * tg) {
      for (const [k, c] of [["hr", "hr"], ["h", "h"], ["rbi", "rbi"], ["r", "r"], ["sb", "sb"], ["bb", "bb"], ["dbl", "doubles"]]) if (v[c] > 0) s[k] = v[c];
    }
    if (v.p_outs / 3 >= 0.29 * tg || v.p_sv >= Math.max(1, Math.round(0.03 * tg))) {
      for (const [k, c] of [["k", "p_so"], ["w", "p_w"], ["sv", "p_sv"]]) if (v[c] > 0) s[k] = v[c];
    }
    if (Object.keys(s).length) rows.push([P.people[pid][0], season, e.team, s, P.people[pid][1]]);
  }
  return merge("mlb", season, rows);
}

// ---- NBA (game keys seasons by start year; the feed by end year)
const NBA_TEAM = { GS: "GSW", NO: "NOP", NY: "NYK", SA: "SAS", UTAH: "UTA", WSH: "WAS" };
async function nba() {
  const meta = await load("nba/meta.json");
  const season = meta.latestSeason - BACK;
  const P = await load(`nba/players_${season}.json`);
  const cols = ["points", "reb", "ast", "stl", "blk", "fg3m", "games"];
  const { by } = totals(P, cols);
  const tg = await teamGamesSoFar("nba", season);
  const rows = [];
  for (const [pid, e] of by) {
    const gp = e.s.games;
    if (!gp || gp < Math.max(1, Math.ceil(0.5 * tg))) continue;
    const s = {};
    for (const [k, c] of [["pts", "points"], ["reb", "reb"], ["ast", "ast"], ["stl", "stl"], ["blk", "blk"], ["fg3m", "fg3m"]]) {
      const v = r1(e.s[c] / gp);
      if (v > 0) s[k] = v;
    }
    s.gp = gp;
    rows.push([P.people[pid][0], season - 1, NBA_TEAM[e.team] || e.team, s]);
  }
  return merge("nba", season - 1, rows);
}

let changed = false;
for (const [name, fn] of [["nfl", nfl], ["nba", nba], ["mlb", mlb]]) {
  try { changed = (await fn()) || changed; } catch (e) { console.error(`${name}: ${e.message}`); process.exitCode = 1; }
}
console.log(changed ? "data files updated" : "no changes");
