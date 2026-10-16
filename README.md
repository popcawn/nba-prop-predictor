# 🏀 NBA Prop Simulator

One HTML file (`nba-prop-predictor.html`) that projects NBA player props — points, rebounds, assists, 3-pointers and
points+rebounds+assists — prices them against the sportsbooks, and tells you what (if anything) to bet tonight and how
much. Sister app to the [NFL anytime-TD simulator](https://github.com/popcawn/nfl-td-predictor); same ideas, same
honesty rules.

## Using it
- **Games** — tonight's slate (ESPN, live). Click a game to see both teams; ⚡ on a game pulls just that game's prices.
- **Players** — for each player: projected minutes and the projection for the stat tab you're on, his season average,
  the book's line and the best over / under price among *your* books (tagged FD / DK …) with its EV.
  Set a player to **OUT** and his teammates' minutes and projections move (injuries from ESPN are pre-filled).
- **Odds** — ⚡ Pull tonight fetches every game still to tip (The Odds API key in *odds settings*; it reuses the NFL app's
  key when both run on the same site). A pull returns every US book for the same credits: pick **your sportsbooks**
  (FanDuel + DraftKings by default) and each price shown is the best among them; every other book is "the market".
  Nothing is pulled automatically — NBA slates are big (8 games × 5 markets = 40 credits) — and you choose which
  markets a pull fetches.
- **Tonight's card** — the best few bets across every pulled game: ¼-Kelly on the confidence-adjusted edge, one per
  player, at most 2 per team and 3 per game, the whole night capped at 12% of bankroll. Buttons log them or open them
  in each book's bet slip.
- **Bankroll** — type your balance; every stake is shown in dollars (1 unit = 1% of the bankroll now) and the bankroll
  grows or shrinks by itself as bets settle.
- **Bet log** — one summary line (record · P/L · ROI · CLV), then days → bets. Results settle themselves from ESPN's
  box scores (a player who didn't play is a void). **⚡ Closing prices** fills Close from your book before tip-off; after
  every pull each open bet shows a live CLV read (with ▼/▲ when the line moved).

## The model
`projection = expected minutes × per-minute production`
- **Per-minute rate** — recency-weighted over his played games (half-life 25 games; a game from last season counts
  40%), lightly shrunk toward his position's average.
- **Minutes** — a fast recency average (half-life 4 games); last season enters as its *season* average worth one game,
  not its last few games (April minutes are distorted by rest and tanking).
- **Who's in / out** — a regular who sits tonight hands minutes to the others; one who returns takes them back
  (20% of the vacated minutes move, fitted on the training season).
- **Game total** — points, rebounds and PRA scale a little with the Vegas total.
- **P(over a line)** — from the empirical spread of actual ÷ projection for projections of that size (quantile tables),
  not an assumed bell curve; points and PRA are squeezed slightly toward 50% (their extremes ran over-confident).

## Honesty & calibration
Leak-free backtest: every game of 2025-26 (1,235 games), using only what was known before tip-off; settings learned on
2024-25. Each bet is "over / under his season average" — a book-like line. Scored separately on the two halves of the
season (Brier, lower is better; 0.25 = a coin flip):

| Stat | Player-games | Simulator (half 1 / half 2) | Plain season average |
|---|---|---|---|
| Points | 14,845 | **0.2425 / 0.2419** | 0.2490 / 0.2494 |
| Rebounds | 13,172 | **0.2379 / 0.2409** | 0.2471 / 0.2468 |
| Assists | 9,561 | **0.2360 / 0.2433** | 0.2451 / 0.2470 |
| 3-pointers | 14,491 | **0.2302 / 0.2332** | 0.2348 / 0.2358 |
| Pts+Reb+Ast | 14,283 | **0.2414 / 0.2410** | 0.2504 / 0.2494 |

Every switch had to beat its "off" setting on **both** halves to stay (`BT_EXPERIMENTS=1`). Kept: minutes × rate
(over a recency average of the stat itself), the in/out minutes shift, the season-average minutes prior, the total for
pts / reb / PRA, the probability squeeze for pts / PRA. Dropped: the total for assists and threes, blending with the
season average, heavier shrinkage, slower minutes.

### Real prices (2025-26, tested Oct 2026)
`market-backtest.mjs` priced 192 games of 2025-26 with every US book's real lines ~20 minutes before tip (The Odds API
history, ~10,000 credits) and scored the same leak-free projections against them (Brier, half 1 / half 2):

| Stat | Lines | The other books | Simulator | Best model share (both halves) |
|---|---|---|---|---|
| Points | 3,237 | **.2491 / .2502** | .2562 / .2700 | 0 |
| Rebounds | 2,690 | **.2474 / .2471** | .2552 / .2547 | 0.1 |
| Assists | 1,942 | **.2489 / .2417** | .2563 / .2529 | 0 |
| 3-pointers | 2,103 | **.2475 / .2428** | .2546 / .2488 | 0 |
| Pts+Reb+Ast | 2,490 | **.2497 / .2507** | .2580 / .2710 | 0 |

**The books beat the simulator on every stat, in both halves** — at the books' own lines the simulator alone is worse than
a coin flip (it only beats a plain season average). Betting every over at the better of FanDuel / DraftKings lost ~6%,
every under ~4% (threes unders ~0%). Betting when the simulator saw +3% EV lost ~3%. The app's rule — your book better
than the other books' fair price by 3%+ — was about break-even (−1% to −5% on ~400–500 bets, ranges from −20% to +20%):
**not proven either way**. So the app now goes by the other books' price (the simulator has no say, except 10% on
rebounds), an **edge** means "your book is out of line with the others", and **CLV** in the bet log is the scoreboard.

*Not betting advice.*

## Files
| File | What it is |
|---|---|
| `nba-prop-predictor.html` | The deliverable. Open in any browser. |
| `nba-prop-predictor.template.html` | UI + live model source (the build injects the snapshot into it). |
| `build-nba-snapshot.mjs` | Node build: game logs → model → backtest → `nba-snapshot.json` + the HTML. |
| `fetch-gamelog.mjs` | Downloads ESPN box scores into `data/gamelog_<season>.json` (only games not on file). |
| `data/gamelog_*.json` | Compact box scores per season (ESPN names a season by the year it ends: 2026 = 2025-26). |
| `nba-snapshot.json` | Teams, rosters, each player's inputs, the outcome tables and the backtest. |

## Refreshing the data
```bash
node build-nba-snapshot.mjs                   # seasons 2025 2026 2027: fetches new box scores, rebuilds everything
BT_EXPERIMENTS=1 SKIP_LIVE=1 node build-nba-snapshot.mjs 2025 2026   # flip every model switch, print both halves
```
`.github/workflows/refresh.yml` runs the build every morning and commits the result, so the GitHub Pages copy stays
current without a PC being on.
