// Entry for the "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty
// (harness pumpfun-replay/v2). The grader runs `node /bot/main.ts`; the
// strategy lives in strategy.ts and the SDK shim is vendored beside it
// (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts file).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
