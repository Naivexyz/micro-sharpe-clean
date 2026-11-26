// Pump.fun Sharpe Sprint — entry point.
//
// The grader executes `node /bot/main.ts` on Node 22, which strips the
// types and runs this file as-is. This file does no trading itself: it only
// builds the strategy from strategy.ts and hands it to the replay shim in
// vendor/makefun-bot.ts (a byte-identical copy of the kit's sdk/ts file).
// All decisions live in strategy.ts and are pure functions of the batches
// the harness delivers, so the two grading executions agree byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onHello(state) {
    return strategy.onHello?.(state);
  },
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state, done) {
    return strategy.onDone?.(state, done);
  },
});
