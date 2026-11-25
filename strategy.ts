// Trend-and-dip rotation strategy for the pump.fun bonding-curve replay
// (agent-fun/replay/v2), written for the "Pump.fun Sharpe Sprint" bounty.
//
// The contest ranks by HOURLY SHARPE, not by raw PnL, and only pays when net
// PnL beats holding cash. Local backtests on the kit's dev window taught the
// design its shape (see README): short-window momentum entries on pump.fun
// mostly buy the local top — the tape confirms the move only once it is
// already over, and the position stops out within seconds, paying the
// ~1.25% curve fees and the fixed transaction fee for nothing. What held up
// instead was patience: curves with a sustained, minutes-long grind of net
// inflow, entered on a small pullback rather than at the high.
//
// So the entry has two halves, both required:
//   1. An established trend over a long window: net SOL flowing in, buy-side
//      flow dominating, many distinct buyers, price up but not vertical,
//      realised volatility low enough that a round trip clears fees.
//   2. A short-term dip inside that trend: the price sits a few percent
//      below the trend window's high and the bleeding has stopped (recent
//      net flow no longer negative). We buy the dip in a live trend, never
//      the spike and never a falling knife.
//
// Positions are sized by volatility (wild tapes get probe size or none) and
// sold whole on a written rule: take-profit, stop-loss, a trailing stop once
// the position has earned it, a trend-break exit, and a hard time stop.
// Selling whole in many small, similar steps is what an hourly Sharpe ratio
// rewards. A pacing mode takes small, fast probe trades if the count of
// finished round trips over distinct mints falls behind the 20-mint
// guardrail bar, and a drawdown brake halves stakes — then pauses entries —
// when equity falls below its peak: protecting the Sharpe denominator is
// the strategy.
//
// Deterministic by construction: no clock, no randomness, no iteration
// over anything but insertion-ordered maps fed by the batch stream, so
// the grader's two executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000;

export interface Params {
  /** Long window the trend is judged over, in slots. */
  trendWindow: number;
  /** Short window the dip is judged over, in slots. */
  dipWindow: number;
  /** Slots after the CreateEvent before a curve may be entered. */
  minAgeSlots: number;
  /** Minimum trades inside the trend window. */
  minTrades: number;
  /** Minimum distinct buying wallets inside the trend window. */
  minBuyers: number;
  /** Buy SOL must be at least this share of trend-window volume. */
  minBuyShare: number;
  /** Net SOL inflow (buys minus sells) inside the trend window, in SOL. */
  minNetSol: number;
  /** Trend-window price change must sit inside [momMin, momMax]. */
  momMin: number;
  momMax: number;
  /** RMS per-trade log return inside the trend window may not exceed this. */
  maxVol: number;
  /** No single trade inside the trend window may move the price more than this. */
  maxJump: number;
  /** Largest single buy may not exceed this share of trend-window buy SOL. */
  maxWhaleShare: number;
  /** The dip: last price must sit [dipMin, dipMax] below the trend window's high ... */
  dipMin: number;
  dipMax: number;
  /** ... and net SOL flow over the dip window must be at least dipFlowMinSol (bleeding stopped). */
  dipFlowMinSol: number;
  /** Real SOL reserves at entry must sit inside [rqMinSol, rqMaxSol]. */
  rqMinSol: number;
  rqMaxSol: number;
  /** Stake sizing: base stake, volatility target and clamps, in SOL. */
  baseStakeSol: number;
  volTarget: number;
  minStakeSol: number;
  maxStakeSol: number;
  /** Buy slippage tolerance (bps). Sells always use 10_000: an exit must land. */
  buySlipBps: number;
  /** Exits: sell whole when value reaches cost * (1 + takeProfit) ... */
  takeProfit: number;
  /** ... or falls to cost * (1 - stopLoss) ... */
  stopLoss: number;
  /** ... or, once value has reached cost * (1 + trailArm), falls trailDrop below its peak ... */
  trailArm: number;
  trailDrop: number;
  /** ... or the trend breaks: net flow over the trend window turns below trendBreakNetSol while not clearly winning ... */
  trendBreakNetSol: number;
  /** ... or after maxHoldSlots, unless the position is up holdExtendIfUp or more (then only the trail applies). */
  maxHoldSlots: number;
  holdExtendIfUp: number;
  /** Slots before the same mint may be entered again, and the most entries per mint per run. */
  cooldownSlots: number;
  maxEntriesPerMint: number;
  /** Most SOL at cost across all open positions at once. */
  maxExposureSol: number;
  /** Cash (SOL) never spent: kept back for exit fees and late opportunities. */
  cashBufferSol: number;
  /** Drawdown brakes: past ddSoft stakes halve; past ddHard entries pause. */
  ddSoft: number;
  ddHard: number;
  /** Pacing: distinct mints that must finish a round trip; probe trades keep the count honest. */
  targetMints: number;
  probeStakeSol: number;
}

/** The settings main.ts trades with. Chosen on the dev window for flat, robust behaviour over a single best cell. */
export const DEFAULT_PARAMS: Params = {
  trendWindow: 240,
  dipWindow: 20,
  minAgeSlots: 120,
  minTrades: 40,
  minBuyers: 10,
  minBuyShare: 0.55,
  minNetSol: 2,
  momMin: 0.05,
  momMax: 0.8,
  maxVol: 0.06,
  maxJump: 0.35,
  maxWhaleShare: 0.4,
  dipMin: 0.02,
  dipMax: 0.12,
  dipFlowMinSol: -0.2,
  rqMinSol: 10,
  rqMaxSol: 90,
  baseStakeSol: 0.05,
  volTarget: 0.045,
  minStakeSol: 0.02,
  maxStakeSol: 0.09,
  buySlipBps: 1500,
  takeProfit: 0.25,
  stopLoss: 0.12,
  trailArm: 0.12,
  trailDrop: 0.09,
  trendBreakNetSol: -1,
  maxHoldSlots: 900,
  holdExtendIfUp: 0.3,
  cooldownSlots: 300,
  maxEntriesPerMint: 3,
  maxExposureSol: 1.2,
  cashBufferSol: 0.5,
  ddSoft: 0.12,
  ddHard: 0.22,
  targetMints: 20,
  probeStakeSol: 0.025,
};

/** One recorded trade on a curve's tape. Price is virtual quote per token after the trade. */
interface TapeTrade {
  slot: number;
  price: number;
  /** Signed SOL: positive for a buy, negative for a sell. */
  sol: number;
  buy: boolean;
  user: Pubkey;
}

/** Per-mint rolling state, fed only by the batch stream. */
interface MintBook {
  tape: TapeTrade[];
  entries: number;
  lastExitSlot: number;
  /** Highest estimated net value of the current position, in lamports. */
  peakValue: bigint;
  entrySlot: number;
}

interface WindowStats {
  trades: number;
  buyers: number;
  buyShare: number;
  netSol: number;
  momentum: number;
  vol: number;
  maxJump: number;
  whaleShare: number;
  lastPrice: number;
  highPrice: number;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const solToLamports = (sol: number) => BigInt(Math.round(sol * SOL));

export function createStrategy(params: Params): Bot {
  const books = new Map<Pubkey, MintBook>();
  /** Mints we have ever bought (a filled buy was seen). */
  const boughtMints = new Set<Pubkey>();
  /** Mints with a completed round trip (a filled sell after our buy). */
  const roundTrippedMints = new Set<Pubkey>();
  /** Mints with one of our sells already in flight: never send a second. */
  const sellPending = new Set<Pubkey>();
  let firstSlot = -1;
  let peakEquity = 0n;
  let entriesPausedUntil = -1;

  const bookFor = (mint: Pubkey): MintBook => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { tape: [], entries: 0, lastExitSlot: -1, peakValue: 0n, entrySlot: -1 };
      books.set(mint, b);
    }
    return b;
  };

  /** Estimated net SOL (lamports) a full sell of `tokens` on this curve returns now, fees estimated at the fallback rates. */
  const sellValueLamports = (state: BotState, mint: Pubkey, tokens: bigint): bigint => {
    const c = state.curves.get(mint);
    if (c === undefined || tokens <= 0n) return 0n;
    const gross = (tokens * c.virtual_quote_reserves) / (c.virtual_token_reserves + tokens);
    const feeBps = BigInt(state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback);
    return gross - (gross * feeBps) / 10_000n;
  };

  /** Window statistics for one mint, or null when the tape is too thin to judge. */
  const windowStats = (book: MintBook, slot: number, windowSlots: number): WindowStats | null => {
    const from = slot - windowSlots;
    const tape = book.tape.filter((t) => t.slot > from);
    if (tape.length < 2) return null;
    let buySol = 0;
    let sellSol = 0;
    let maxBuy = 0;
    let sqReturns = 0;
    let maxJump = 0;
    let highPrice = 0;
    const buyers = new Set<Pubkey>();
    for (let i = 0; i < tape.length; i++) {
      const t = tape[i];
      if (t.price > highPrice) highPrice = t.price;
      if (t.buy) {
        buySol += t.sol;
        if (t.sol > maxBuy) maxBuy = t.sol;
        buyers.add(t.user);
      } else {
        sellSol -= t.sol;
      }
      if (i > 0) {
        const r = Math.log(t.price / tape[i - 1].price);
        sqReturns += r * r;
        const j = Math.abs(Math.exp(r) - 1);
        if (j > maxJump) maxJump = j;
      }
    }
    const total = buySol + sellSol;
    if (total <= 0) return null;
    return {
      trades: tape.length,
      buyers: buyers.size,
      buyShare: buySol / total,
      netSol: buySol - sellSol,
      momentum: tape[tape.length - 1].price / tape[0].price - 1,
      vol: Math.sqrt(sqReturns / (tape.length - 1)),
      maxJump,
      whaleShare: buySol > 0 ? maxBuy / buySol : 1,
      lastPrice: tape[tape.length - 1].price,
      highPrice,
    };
  };

  /** How far behind the 20-mint pace we are: 0 = on pace, 1..3 = progressively more permissive probes. */
  const paceLevel = (slot: number): number => {
    if (roundTrippedMints.size >= params.targetMints || firstSlot < 0) return 0;
    const elapsed = slot - firstSlot;
    // A 6-hour window is roughly 54k slots. Every ~9k slots without the bar
    // in sight, the probe bar drops a notch; probes stay small and exit fast.
    return clamp(Math.floor(elapsed / 9000), 0, 3);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      const caps = state.hello.caps;
      const txFee = state.txFeeLamports();

      // ---- fold the batch into the books ----------------------------------
      for (const f of batch.fills) {
        if (f.side === 'sell') sellPending.delete(f.mint);
        if (f.status !== 'filled') continue;
        if (f.side === 'buy') boughtMints.add(f.mint);
        if (f.side === 'sell') {
          if (boughtMints.has(f.mint)) roundTrippedMints.add(f.mint);
          const b = books.get(f.mint);
          if (b !== undefined) {
            b.lastExitSlot = slot;
            b.peakValue = 0n;
            b.entrySlot = -1;
          }
        }
      }
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const book = bookFor(e.mint);
        const vq = Number(e.virtual_quote_reserves);
        const vt = Number(e.virtual_token_reserves);
        if (vt <= 0) continue;
        const sol = Number(e.sol_amount) / SOL;
        book.tape.push({ slot: e.slot, price: vq / vt, sol: e.is_buy ? sol : -sol, buy: e.is_buy, user: e.user });
        // Keep the tape bounded: drop trades far outside any window we read.
        const horizon = slot - params.trendWindow - 5;
        let cut = 0;
        while (cut < book.tape.length && book.tape[cut].slot <= horizon) cut++;
        if (cut > 0) book.tape.splice(0, cut);
      }

      const orders: OrderInput[] = [];
      let free = state.freeCashLamports();
      const spend = (amount: bigint) => {
        free -= amount + txFee;
      };

      // ---- equity and the drawdown brake ----------------------------------
      let equity = state.cash;
      let openCost = 0n;
      for (const [mint, h] of state.positions) {
        equity += sellValueLamports(state, mint, h.token_amount);
        openCost += h.cost_lamports;
      }
      if (equity > peakEquity) peakEquity = equity;
      const drawdown = peakEquity > 0n ? Number(peakEquity - equity) / Number(peakEquity) : 0;
      if (drawdown > params.ddHard && entriesPausedUntil < slot) entriesPausedUntil = slot + 600;
      const stakeScale = drawdown > params.ddSoft ? 0.5 : 1;

      // ---- exits first: they free slots and lock in the equity steps ------
      for (const [mint, h] of state.positions) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (sellPending.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue; // the replay closes completed curves itself
        const book = bookFor(mint);
        if (book.entrySlot < 0) book.entrySlot = slot;
        const value = sellValueLamports(state, mint, h.token_amount);
        if (value > book.peakValue) book.peakValue = value;
        const cost = h.cost_lamports;
        const ratio = cost > 0n ? Number(value) / Number(cost) : 1;
        const peakRatio = cost > 0n ? Number(book.peakValue) / Number(cost) : 1;
        let exit = false;
        if (ratio >= 1 + params.takeProfit) exit = true;
        else if (ratio <= 1 - params.stopLoss) exit = true;
        else if (peakRatio >= 1 + params.trailArm && Number(value) <= Number(book.peakValue) * (1 - params.trailDrop)) exit = true;
        else if (slot - book.entrySlot >= params.maxHoldSlots && ratio < 1 + params.holdExtendIfUp) exit = true;
        else {
          const trend = windowStats(book, slot, params.trendWindow);
          if (trend !== null && trend.netSol < params.trendBreakNetSol && ratio < 1.02) exit = true;
        }
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: 10_000 });
          sellPending.add(mint);
          spend(0n);
        }
      }

      // ---- entries ---------------------------------------------------------
      const pace = paceLevel(slot);
      const paused = slot < entriesPausedUntil;
      if (!paused && state.committedPositionCount() < caps.max_open_positions) {
        // Candidates: mints with fresh tape activity, best trend inflow first.
        const active = new Set<Pubkey>();
        for (const e of batch.events) active.add(e.mint);
        const scored: { mint: Pubkey; stats: WindowStats; probe: boolean }[] = [];
        for (const mint of active) {
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (state.positions.has(mint)) continue;
          if (curve.created_slot === null || slot - curve.created_slot < params.minAgeSlots) continue;
          const rqSol = Number(curve.real_quote_reserves) / SOL;
          if (rqSol < params.rqMinSol || rqSol > params.rqMaxSol) continue;
          const book = bookFor(mint);
          if (book.entries >= params.maxEntriesPerMint) continue;
          if (book.lastExitSlot >= 0 && slot - book.lastExitSlot < params.cooldownSlots) continue;
          const trend = windowStats(book, slot, params.trendWindow);
          if (trend === null) continue;
          const dip = windowStats(book, slot, params.dipWindow);
          if (dip === null) continue;
          const dipDepth = trend.highPrice > 0 ? 1 - trend.lastPrice / trend.highPrice : 0;
          const relax = pace > 0;
          const trendOk =
            trend.trades >= (relax ? 12 : params.minTrades) &&
            trend.buyers >= (relax ? 5 : params.minBuyers) &&
            trend.buyShare >= (relax ? 0.52 : params.minBuyShare) &&
            trend.netSol >= (relax ? 0.6 : params.minNetSol) &&
            trend.momentum >= (relax ? 0.01 : params.momMin) &&
            trend.momentum <= (relax ? 1.2 : params.momMax) &&
            trend.vol <= (relax ? 0.1 : params.maxVol) &&
            trend.maxJump <= params.maxJump &&
            trend.whaleShare <= params.maxWhaleShare;
          if (!trendOk) continue;
          // The dip half: below the trend high, bleeding stopped. Probes may
          // skip the dip once pacing is desperate (level >= 2): they exist to
          // bank round trips, sized small and exited by the same rules.
          const dipOk = (dipDepth >= params.dipMin && dipDepth <= params.dipMax && dip.netSol >= params.dipFlowMinSol) || pace >= 2;
          if (!dipOk) continue;
          scored.push({ mint, stats: trend, probe: relax });
        }
        scored.sort((a, b) => b.stats.netSol - a.stats.netSol || (a.mint < b.mint ? -1 : 1));

        let slots = caps.max_open_positions - state.committedPositionCount();
        for (const { mint, stats, probe } of scored) {
          if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
          const cap = state.maxBuyLamports(mint);
          const stakeSol = probe
            ? params.probeStakeSol
            : clamp(params.baseStakeSol * (params.volTarget / Math.max(stats.vol, 0.01)), params.minStakeSol, params.maxStakeSol) * stakeScale;
          let stake = solToLamports(stakeSol);
          if (stake > cap) stake = cap;
          if (stake < solToLamports(0.012)) continue; // under the round-trip floor: not worth a slot
          if (openCost + stake > solToLamports(params.maxExposureSol)) continue;
          if (free < stake + txFee + solToLamports(params.cashBufferSol)) continue;
          orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: params.buySlipBps });
          spend(stake);
          openCost += stake;
          slots -= 1;
          const book = bookFor(mint);
          book.entries += 1;
          book.entrySlot = slot;
          book.peakValue = 0n;
        }
      }

      return orders;
    },
  };
}
