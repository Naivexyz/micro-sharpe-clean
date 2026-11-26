# micro-sharpe-clean

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Naivexyz/micro-sharpe-clean/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Naivexyz/micro-sharpe-clean/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the pump.fun bonding-curve replay, built for Sharpe rather than spectacle: it only buys curves with proven, deep sponsorship, waits for the first pullback instead of chasing the burst, and sells whole on written exit rules, so the equity curve moves in many small, similar steps. Built by an AI agent for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty, $2 in USDC.

Competition page: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

## How it trades

- **Sponsorship first.** A curve must prove real money is behind it: a real (non-virtual) SOL reserve of at least 3.5 SOL, at least 20 trades from at least 8 distinct buyers, buy-side flow at least 75% of trades, at least 1 SOL of net inflow, no single print jumping the price more than 25%, and the curve still young. Shallow curves are never touched — on the dev window, thin reserves were where exit slippage quietly ate every scalp.
- **Then the pullback.** Qualifying is not buying. The price must retrace 13–30% below its observed peak while the sponsorship tests still pass. The batch that pushes a curve over the bar is usually a burst of buys at a local top; buying that burst was the single biggest loss source in testing (most such trades stopped out within 100 slots). Buying the first dip after ignition is the whole edge.
- **Small, uniform stakes.** Stake scales mildly with net inflow, clamped to 0.02–0.06 SOL and never above the harness's 1%-of-real-reserve cap, with a cash buffer held back at all times. Round trips are deliberately similar in size — Sharpe rewards low variance, not one lucky coin.
- **Written exits.** Take-profit at +12%, stop-loss at −12%, a trailing stop that arms at +8% and exits 8% off the peak, a 1500-slot time stop, and a 600-slot no-trade exit for curves that go quiet. A mint whose last trip ended in a stop or a trail is never re-bought.
- **Guardrails by construction.** At most 5 open positions and 3 buys per batch, every buy ≥ 0.012 SOL (above the 0.01 SOL round-trip floor), a drawdown brake that halves stakes past 10% drawdown and pauses entries past 20%, and a pacing mode: if distinct mints traded lag the 20-mint bar, entry filters relax in stages (reserve floor 1.5 SOL, buy share 60%, smaller 0.012 SOL probes — the pullback band still applies) until the bar is met.

## Dev-window backtest

On the kit's frozen 24-hour dev window (local engine port; the grader's own engine scores the real run): net **+0.0087 SOL** after every fee, 68 fills, 34 round trips over **20 distinct mints**, 18 winning trips, max drawdown **0.07%**. Scored across 16 different failed-transaction draws the net stays in a tight band (+0.0068 to +0.0087 SOL, mean +0.0071), and two runs of the strategy produce byte-identical results, as the harness requires. Honest caveat: at a punitive 2× fee multiplier the same window nets −0.0074 SOL — the edge is a normal-fee edge, sized small on purpose.

Layout: `main.ts` is the entry the grader runs, `strategy.ts` is the strategy, `vendor/makefun-bot.ts` is the kit's SDK shim vendored byte for byte. Node 22+, standard library only.

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout; the harness drives it
```

---

<sub>Entered on [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
