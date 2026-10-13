# NBA Prop Simulator — working notes

Single-file HTML app (`nba-prop-predictor.html`) + a Node build (`build-nba-snapshot.mjs`) that turns ESPN box scores
into player-prop projections. Sister project of `C:\Users\User\nfl-td-predictor` (read its CLAUDE.md for the history
of the market anchor, line shopping, bankroll and bet-log decisions — this app starts from where that one ended).
See README.md for the model and its backtest.

## Where things happen
- **Edit** `nba-prop-predictor.template.html` (UI + live model) and `build-nba-snapshot.mjs` (data + model + backtest).
  Never hand-edit `nba-prop-predictor.html` / `nba-snapshot.json` — the build regenerates both (takes ~20 s).
- `fetch-gamelog.mjs` keeps `data/gamelog_<season>.json` (committed): ESPN scoreboard day by day (ESPN refuses date
  ranges) → `summary?event=` box scores; only games not on file are fetched. ESPN names a season by the year it ENDS.
- Once the repo is on GitHub: `.github/workflows/refresh.yml` rebuilds daily (11:17 UTC) and commits — `git pull` first.
- Test in a browser over http: preview config `nba-static` (port 8792, `%TEMP%/serve_nba.mjs`).

## Rules for model changes
- One `MODEL` config in the build drives the backtest AND what ships; the app's `teamProj()` / `propPOver()` /
  `propSides()` are copies of the build's math — keep them identical.
- Validate with `BT_EXPERIMENTS=1 SKIP_LIVE=1 node build-nba-snapshot.mjs 2025 2026`: a switch stays only if it wins
  BOTH halves of the test season. Differences under ~0.0003 Brier are noise — don't chase them.
- Leak-free: features use only games before tip-off (this season + last). "Who is out tonight" is treated as known
  (the inactive list is public before tip), exactly like the NFL backtest treats actives.
- Tested 2026-10-14 (train 2025, test 2026). KEPT: method minrate (vs ewma / naive), rateHL 25, minHL 4, shrinkMin 25,
  wPrior 0.4, vacated-minutes shift (beta 0.2), minutes prior = last season's SEASON average worth 1 game, total
  context for pts/reb/pra only, probability squeeze (slope 0.8) for pts/pra only. REJECTED: ctx for ast/tpm, blend with
  season average (mixed), minutes blended with season minutes (mixed), shrink ≥100, minHL 7/12, wPrior 0.1 or 1.
- The 2024-25 box scores carry no Vegas totals (ESPN dropped them); 2025-26 has them from late November. So the total
  sensitivity `a` is cross-fitted inside the test season (fit on the other half) and shipped from the whole season.
- Players with under `minGames` (5) games of history are `thin`: shown greyed, excluded from the team minutes math and
  never bet (the backtest never scored them).

## Market-first (borrowed from the NFL result, NOT yet tested on NBA prices)
- Chance = other books' de-vigged P(over) at the line (`consAt`: exact line, else their nearest line within
  max(1, 12%) moved by the model's distribution; else the book's own two-way price) blended with the model at
  `PROP_W` = 0.1 and capped at ±`MODEL_CAP` (3 points) — an extreme projection moved a chance 11 points before the cap.
- `S.marketAnchor.props.w` (from a future `market_anchor.json`) overrides 0.1. A real-price test needs historical
  odds: 10 credits per market per game — a few hundred games of two markets is ~4–6K credits. ASK before spending.
- Credits: the user's key is the NFL app's (20K/month plan, nearly spent in Oct 2026). The app never pulls
  automatically; a slate pull is games × markets credits; `CFG.reserve` (300) asks before going below.

## App structure (template)
- State in localStorage, prefix `nbap_`: bets, bank, boards (3 days), status (per slate day), oddscfg, oddskey
  (falls back to the NFL app's `nfltd_oddskey` — same origin on GitHub Pages).
- `loadSlate()` = today's regular-season games, else the next day that has some (10 days ahead). `teamProj()` =
  minutes after absences + projection per stat. `parseBoard()` = an Odds API body → `offers` (box line + other-line
  offers from your books, each side with a ticket), `cons` (other books), `mine` (each of your books' own lines, for
  closes). `buildCands()` → `buildCard()` (¼ Kelly, 1/player, 2/team, 3/game, night cap 12%, bet cap 3u).
- Bets carry `ev` (ESPN event id) → `autoSettle()` reads that game's box score (DNP = push). `closeView()` = the bet's
  book's price at the bet's line (translated when the line moved); every pull writes `b.cur` (live CLV).
- Not built yet (exists in the NFL app if the user asks): cross-PC sync via gist, slip / parlays, history-based
  closing lines, fun picks.

## The user
- Bets FanDuel + DraftKings, wants a short answer ("what do I bet and how much, in dollars"), gets overwhelmed by
  options — keep the card short and the log simple. Be honest that an edge here means "out of line with the other
  books". Commits end with the Co-Authored-By line from the session's instructions.
