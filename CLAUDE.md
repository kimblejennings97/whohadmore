# Who Had More?

A "which player had more?" guessing game: one static page (`index.html`) plus one data file per league
(`data-<sport>.js`, each sets `SPORTS.<sport> = {ymin, ymax, D: [[player, season, team, {stat: value}]], TEAMS, CATS?}`).
Best streaks are saved in localStorage. Cloudflare Web Analytics beacon in index.html.

- Repo: https://github.com/kimblejennings97/whohadmore (public), branch `main`.
- Hosting: GitHub Pages via `.github/workflows/refresh-and-deploy.yml` (moved off Netlify 2026-11-16).
  **Every push to `main` deploys**, so commit/push only when asked.
- Daily 13:00 UTC the workflow runs `tools/refresh-current-season.mjs`, which rebuilds ONLY the current season
  of NFL, NBA and MLB from the stat-analysis data feed (github.com/kimblejennings97/stat-analysis, `data` branch),
  commits if anything changed, and redeploys. Older seasons and the other leagues (NHL, WNBA, soccer) are static.
- Refresh rules (backtested against the 2025 rows): NFL per-stat floors scaled to games played; MLB hitters
  PA >= 1.3 x team games, pitchers IP >= 0.29 x team games or saves; NBA per-game averages for >= half the team's
  games, seasons keyed by START year, ESPN team codes mapped to NBA.com (GS->GSW ...). Names reuse the existing
  spelling (exact, then accent-insensitive, then ignoring Jr./II) and MLB "(POS)" tags, so careers stay joined.
- Local test: `SA_DATA=../stat-analysis/public/data node tools/refresh-current-season.mjs`;
  `BACKTEST=1` rebuilds last season and compares without writing.
