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
- Credits: the user's key is the NFL app's (upgraded to the 100K/month plan on 2026-10-16). The app only pulls on its
  own for closing prices (below); a slate pull is games × markets credits; `CFG.reserve` (300) asks before going below.

## App structure (template)
- State in localStorage, prefix `nbap_`: bets, bank, boards (3 days), status (per slate day), oddscfg, oddskey
  (falls back to the NFL app's `nfltd_oddskey` — same origin on GitHub Pages).
- `loadSlate()` = today's regular-season games, else the next day that has some (10 days ahead). `teamProj()` =
  minutes after absences + projection per stat. `parseBoard()` = an Odds API body → `offers` (box line + other-line
  offers from your books, each side with a ticket), `cons` (other books), `mine` (each of your books' own lines, for
  closes). `buildCands()` → `buildCard()` (¼ Kelly, every take, 1 per player per stat, night cap 12%, bet cap 3u).
- Bets carry `ev` (ESPN event id) → `autoSettle()` reads that game's box score (DNP = push). `closeView()` = the bet's
  book's price at the bet's line (translated when the line moved); every pull writes `b.cur` (live CLV).
- Not built yet (exists in the NFL app if the user asks): slip / parlays, fun picks. (Gist sync and automatic closes,
  incl. history-based ones, are built — see below.)

## ⚡ Automatic closing prices (2026-10-20 — the NHL log had 16 bets with NO Close on any, so no CLV)
- The NFL app's rule, ported (the NHL app has the same code). `autoCloses()` runs 8 s after opened() (after the first
  sync), every 2 min, and on `visibilitychange` (phones pause timers): `autoLiveCloses()` then `autoHistCloses()`.
- LIVE (AUTO.close, on by default): open bets whose tip (SLATE tip, else `b.ko`) is ≤15 min away → `pullGame(g, only the
  bets' markets)` → `applyBoard(g, board, true)` (b.cur) → `applyClose()` = `closeView()` (the bet's book at the bet's
  line; a moved line is translated → `closeEst`). 1 credit per market per game. Errors other than key/credits retry next check.
- HISTORY (AUTO.hist, OPT-IN, off by default): bets with no Close whose game tipped <14 days ago (pushes/voids skipped) →
  `histBoard()`: HIST_API `/events?date=tip−5min` (1 credit) + `/events/{id}/odds?date=…&bookmakers=myBooks()` (10 per
  market). Free plan → `nbap_histoff` pauses 3 days; offline / 401 / 429 → 30-min pause (memory); other errors mark the game 'fail'.
- Each game|tip|market is tried ONCE, live or history (`nbap_closed`, pruned after 21 days). Both stop at CFG.reserve
  (no confirm — a note in #autoMsg). `nbap_auto` {close, hist}; checkboxes #autoCloseChk / #autoHistChk under odds
  settings, #histCost = "N bets waiting · about C credits" (what ticking history would spend now). Filled bets carry
  `closeSrc` 'live' | 'hist' (title on the Close box); a typed close deletes it. `applyClose()` is shared with ⚡ Closing
  prices (`pullCloses`, still there for a close taken by hand). apiGet awaits opened() and the timers skip
  document.prerendering, so a page built in the background spends nothing.
- Two devices open at once can each pull the same close (`nbap_closed` is per browser; sync merges `closeOdds`) — 1 credit.
- TESTED 2026-10-20 with a mocked fetch only (no real credits): a throwaway copy of the built page with fetch mocked (fake
  ESPN scoreboard + Odds API events / odds / history, x-requests-remaining) and fresh localStorage on its own port. Tip in
  10 min → filled live (exact −115; a 24.5 bet vs the book's 23.5 → ≈ translated), 1 credit; tipped game untouched until
  history was ticked → filled from tip−5 min (11 credits); tip in 20 min → nothing; re-checks spend nothing;
  document.prerendering → nothing until activation (reserve pause tested on the NHL copy). The real historical endpoint
  was NOT called — it is the NFL app's (tested there on IND@WAS 2026-10-04).

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
  flashed a page between sports). How a switch works (recorded frame by frame in a throwaway headless Chrome, 2026-10-19 — the user still saw a flash
  NBA -> NFL): `@view-transition{navigation:auto}` with NO animation (a 160 ms cross-fade showed both pages at once) and
  no separate top-bar layer (its see-through background let the old tabs show for a frame), so the page you leave stays
  on screen until the next is fully drawn, then they swap in one frame (~100 ms into NFL). Speculation rules PRERENDER
  the other sports on hover; `opened()` holds everything that spends or writes (odds pulls — NFL fetchGameOdds, NBA/NHL
  apiGet — settling, closes, gist sync) until the page is actually opened. `sims_chip` = the last pot boxes, shown
  instantly. Fonts are self-hosted on popcawn.github.io/fonts (preloaded, `font-display: optional` — no late re-draw of
  the text). NBA / NHL also open with the last slate + injuries this browser saw (`*_slate`, `*_inj`), refreshed from
  ESPN a moment later, so the date line and tonight's bets don't pop in. Test harness idea: Chrome --headless=new +
  CDP Page.startScreencast, with a normal user agent (ESPN doesn't answer HeadlessChrome).
- First paint waits for the app to draw itself: `<link rel="expect" href="#sims-ready" blocking="render">` in the head and
  `<i id="sims-ready" hidden>` right AFTER the main script (keep it last in body), so a sport switch fades from one finished
  page to the next instead of showing a half-drawn one.
- The ⚡ Bets list draws ONLY new bets (user, 2026-10-21: "logged bets shouldnt be shown. Only new bets"); the status line
  still counts the logged ones ("· 1 already in your log") and the log has them. Your card (NFL game tab) still shows both.
- The ⚡ Bets list is grouped BY SPORTSBOOK (user, 2026-10-21: "doesnt need to stacked. or even seperated by game … if
  anything seperate by book"): FanDuel, DraftKings, BetMGM, Caesars, Fanatics; each section is one grid of cards with an
  "Open all N on <book>" button, and each card names its game and start time. Fanatics (no slip link) opens its home page.
- Tonight's card shows EVERY take (user, 2026-10-21: "remove show up to, show all take bets"): no bets-a-night select, no
  team or game limit — one bet per player per STAT (statOf(); a stat in your log holds it at any line; logBet refuses a
  second). NIGHT_CAP (12%) still scales the stakes down when there are many, so the night's total risk doesn't grow.
- ✕ Skip + "bet at X or better" (user, 2026-10-21: FanDuel showed +104 for a +114 card bet — "should it be a removed
  button … when i recheck for bets it doesnt pop up again"): each card has ✕ Skip (SKIP map in localStorage *_skip, key
  game|player|stat, kept 4 days NBA/NHL, 8 NFL) — the bet stays hidden through re-pulls; "↩ Bring back" under the list undoes
  it. floorPrice() = the worst price that still passes the card's rule (EV > 3%; NBA/NHL also 1.5 points of edge), shown
  as "bet at +110 or better" so the user can compare with the slip. NFL: Your card on the game tab ignores skips.
- GOTCHA (2026-10-21): many functions here are ONE line. Never add a // comment in the middle of a line — everything after it
  is commented out. A note added after logBet's first check hid `const k=unitUsd();` and every 📓 log button threw
  "k is not defined". Put notes on their own line above.
- Priced list: the ✓ on a logged bet takes it back OUT of the log (user, 2026-10-21: "i cant remove a logged bet") — hover
  reads "✕ remove", a confirm names the bet, then it is deleted like the bet log's ✕ (a sync tombstone, so other devices drop it).
- NO NIGHTLY CAP (user, 2026-10-21: "no cap on nhl or nba either"): NIGHT_CAP removed — each bet is sized on its own (¼ Kelly,
  ≤ BET_CAP 3u), so a big night adds up. Don't re-add a total cap unless the user asks.
- Bet log tables FIT their column — no sideways scroll bar (user, 2026-10-21: "remove the scroll bar"): table.logtbl lets the bet
  and the close / CLV cell wrap (odds, stake, result, P/L stay on one line). Don't put white-space:nowrap back on those cells.
- Bet log tidy (user, 2026-10-21): "52 bets · 52 open" reads "52 open bets" (cnt()); NBA/NHL bet lines drop the game (it is on
  hover); a TO WIN column (profit if it wins, to the cent) and "could win $X" on the week / night / game summaries. Stakes are
  LOGGED AS SHOWN (roundUsd(): whole $ from $20, half-dollars from $1, cents below) — before, the card showed $1.50 but the log
  kept e.g. $1.73, so P/L and To win didn't match the book. Bets logged before this keep their old amounts.
- One-time stake fix (2026-10-21, user: "a 2 bet at +100 wins $2 not 1.97"): bets logged before "logged as shown" are rounded to
  what the card showed (flag *_usdround; NFL only touches app-logged bets — book / legs / mktP / rawP / fun — never a hand-typed
  stake), stamped mt so Sync spreads it. The log's stake shows exactUsd(): the usual format for round amounts, else cents.

## The user
- Bets FanDuel + DraftKings, wants a short answer ("what do I bet and how much, in dollars"), gets overwhelmed by
  options — keep the card short and the log simple. Be honest that an edge here means "out of line with the other
  books". Commits end with the Co-Authored-By line from the session's instructions.
