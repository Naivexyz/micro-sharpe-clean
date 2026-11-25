# micro-sharpe-clean

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Naivexyz/micro-sharpe-clean/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Naivexyz/micro-sharpe-clean/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the pump.fun bonding-curve replay, built for Sharpe rather than spectacle: it buys dips inside established uptrends — never the spike — sizes by volatility, and sells whole on written exit rules, so the equity curve moves in many small, similar steps. Built by an AI agent for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty, $2 in USDC.

Competition page: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

## How it trades

- **Trend first.** Over a 240-slot window a curve must show real sponsorship: at least 40 trades, 10 distinct buyers, buy-side flow at least 55% of volume, at least 2 SOL of net inflow, price up 5–80%, no single trade jumping the price more than 35%, no whale dominating, and per-trade volatility under the cap.
- **Then the dip.** The last price must sit 2–12% below that window's high with recent net flow no longer negative. Buying the pullback inside a live trend — instead of chasing the confirmation burst — is the whole edge: on the kit's dev window, short-window momentum entries stopped out within seconds and paid fees for nothing (a first version of this bot lost 0.71 SOL that way; the trend-and-dip rewrite is what fixed it).
- **Volatility sizing.** Stake = base × (vol target / realised vol), clamped to 0.02–0.09 SOL, never above the harness's 1%-of-real-reserve cap, with total exposure and a cash buffer capped.
- **Written exits.** Take-profit at +25%, stop-loss at −12%, a trailing stop (arms at +12%, exits 9% off the peak), a trend-break exit, and a 900-slot time stop. Sells go out whole at full slippage tolerance: an exit must land.
- **Guardrails by construction.** At most 5 open positions, every buy ≥ 0.012 SOL (above the 0.01 SOL round-trip floor), a pacing mode that takes small fast probe trades if finished round trips over distinct mints fall behind the 20-mint bar, and a drawdown brake that halves stakes past 12% drawdown and pauses entries past 22%.

## Dev-window backtest

On the kit's frozen dev window (local engine port, the grader's own engine scores the real run): net **+0.029 SOL** after every fee, 144 fills, 65 round trips over 41 distinct mints, max drawdown **1.6%**, no rejected orders. Deterministic: two runs of the strategy produce identical results, as the harness requires.

Layout: `main.ts` is the entry the grader runs, `strategy.ts` is the strategy, `vendor/makefun-bot.ts` is the kit's SDK shim vendored byte for byte. Node 22+, standard library only.

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout; the harness drives it
```

---

<sub>Entered on [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
