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

## Market-first (TESTED on real NBA prices, 2026-10-16)
- Chance = other books' de-vigged P(over) at the line (`consAt`: exact line, else their nearest line within
  max(1, 12%) moved by the model's distribution; else the book's own two-way price) blended with the model at
  `propW(s)` (fitted per stat on real prices: reb 0.1, rest 0) and capped at ±`MODEL_CAP` (3 points) — an extreme projection moved a chance 11 points before the cap.
- REAL-PRICE TEST (user upgraded to the 100K plan and asked for it): `market-backtest.mjs` (same file as the NHL repo) —
  `DUMP_BT=1 SKIP_LIVE=1 node build-nba-snapshot.mjs 2025 2026` writes bt_rows_2026.json (gitignored), then `--go` fetches
  192 games × 5 markets at start−20 min into market_hist/ (gitignored, ~9.7K credits), `analyze` scores + writes
  market_anchor.json (committed; the build ships its `.app` as S.marketAnchor). RESULT: other books beat the model on all
  5 stats both halves (model alone > .25 Brier at book lines). Model share must win BOTH halves -> reb 0.1, rest 0
  (`propW(s)` in the app reads byStat). ROI: every over −6%, every under −4%; model EV>3% −3%; app rule (market EV>3% at
  best FD/DK) ≈ −1..−5% on ~400-500 bets (CIs ±20%) = unproven. Don't raise model shares without a new test.
- Credits: the user's key is the NFL app's (upgraded to the 100K/month plan on 2026-10-16). The app never pulls
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

## One site, one pot (2026-10-16, user: "combine all into one sim … make them like the nfl sim … one pot")
- The NFL, NBA and NHL apps are separate repos on ONE site (popcawn.github.io), so they share one browser storage. Each
  page has a sport switcher (🏈 · 🏀 · 🏒, relative links ../<repo>/) and a 💰 pot chip.
- ONE POT: `nfltd_bank` {amt, at, mt} is the bankroll for all three; bankNow() = amt + the dollar P/L of EVERY sport's bets
  settled after `at` (`allBets()` reads nfltd_bets / nbap_bets / nhlp_bets). Typing a balance in any app writes nfltd_bank
  (with mt). A `storage` listener redraws when another tab changes it. The NBA / NHL apps' own *_bank keys are only a
  fallback for old data.
- ☁ SYNC: the NFL app owns the token + secret gist (`nfltd_sync` {token, gistId}); the NBA / NHL apps reuse them and
  write their OWN file in that gist (nba-sync.json / nhl-sync.json: bets + tombstones + the pot), merged like the NFL
  app's (mt newest wins, tombstones). If no token: "☁ Sync: set up in 🏈 NFL".
- NBA / NHL bet log = the NFL layout: weeks (Mon→Sun) with the money line (won/lost pill · spent · still riding) -> nights (collapsed; tonight's marked 📍) -> bets.

## Look (2026-10-19, user: "its a little dark. Modernize the site … markets in the background … just a pull odds and the bets across all games with click-to-open links" → "light default, apply it to all three")
- One look for all three apps (+ the front door): light theme by default, 🌙 dim (`sims_theme` in localStorage — one setting for the
  whole site; a head script sets it before first paint). Fonts: Inter (text), Space Grotesk (headings), JetBrains Mono (odds,
  money) from Google Fonts; base 16px. Colors are CSS variables redefined under `:root[data-theme="dim"]` — never hardcode a
  dark-only color (team names as text go through teamText(), which is theme-aware).
- Sticky top bar (`#topbar`): brand → popcawn.github.io, sport pills, the pot as stat boxes (renderPotChip: bankroll ·
  this week = every sport's bets settled since Monday · bets · open · this game), light/dim button, then the tabs (`#dtabs`).
  Phones keep the bottom bar (`#mtabbar`); showTab() keeps both in step. Sticky offsets use --navh = top bar height.
- Tabs at EVERY width now (sections carry data-m): card = ⚡ Bets (Pull tonight hero + tonight's card as cards), games = players by game, priced = ★ every priced bet, bets = 📓 Bet log (bankroll beside it ≥1200px).
- The first tab is a big pull button (.hero) and the bets as cards (betCard(): name, market, price + book, Bet $, chance bar
  vs the price's chance, EV, an Open-on-<book> link). The internals (pulls, card rules, staking, log) did not change.
- Same day the NBA app caught up with the NHL app: phone tabs, NEW / NO NEW BETS status, BetMGM + Caesars bet-slip links
  (your state; falls back to the NFL app's), Fanatics opens by hand, BetRivers removed (not in the user's state).
- Name: PROP SIM (tab title, brand, front door; user 2026-10-19). Switching sports must feel seamless: links go STRAIGHT to
  `<repo>/<repo>.html` — never the folder (its index.html is only a redirect for old links/bookmarks, and linking it
  flashed a page between sports). Cross-document view transitions (`@view-transition`, the top bar held by
  `view-transition-name`), a speculation-rules PREFETCH on hover (prefetch only — prerender would run the page's JS and
  could spend odds credits), and `sims_chip` (the last pot boxes, shown instantly before the live render).

## The user
- Bets FanDuel + DraftKings, wants a short answer ("what do I bet and how much, in dollars"), gets overwhelmed by
  options — keep the card short and the log simple. Be honest that an edge here means "out of line with the other
  books". Commits end with the Co-Authored-By line from the session's instructions.
