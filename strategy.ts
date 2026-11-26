// Ignition-scalp bot for the Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
//
// Idea, built from the competition brief alone: most pump.fun curves die
// within minutes, but the minority that attract real money early keep
// drifting up for a while as new buyers pile in. This bot only buys curves
// that have already proven sponsorship — a deep real SOL reserve, a clear
// buy majority, several distinct buyers, real net inflow — and then scalps
// a small slice of the next leg up, exiting on written rules within
// minutes. It never chases a spike, never averages down, never holds a
// dead coin, and never touches a curve that has already completed.
//
// One lesson is baked into the entry path: the batch that pushes a curve
// over the sponsorship bar is usually a burst of buys at a local top, so
// the bot never buys the burst itself. It waits for the pullback — the
// price must retrace 13–30% below its observed peak while sponsorship
// still holds — and only then takes a position. (An optional confirmation
// watch — observe a qualifying curve for a while before buying — is kept
// in the code but disabled by default: in testing it let too many good
// entries run away.)
//
// Sharpe, not PnL, is the ranking metric, so the bot optimises for many
// small, similar, low-variance round trips: small stakes, tight exits, a
// pacing mode that guarantees the 20-distinct-mint bar, and a drawdown
// brake. Every decision is a pure function of the batches the harness
// delivers — no clock, no environment, no randomness — so the two grading
// executions agree byte for byte.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type Done,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

export interface Params {
  // Entry: a curve must look sponsored before we touch it.
  minTrades: number;
  minBuyShareBps: number;
  minBuyers: number;
  minRealReserveSol: number;
  minNetInflowSol: number;
  minRiseBps: number;
  maxRiseBps: number;
  maxJumpBps: number;
  maxAgeSlots: number;
  // Confirmation watch: a qualifying curve is observed before it is bought.
  // Negative delay disables the watch (buy on first qualifying touch).
  confirmDelaySlots: number;
  confirmMaxDropBps: number;
  confirmWindowSlots: number;
  // Dip entry: buy the pullback, not the burst — the price must have
  // retraced into a band below its observed peak while the overall rise
  // from the first print is still intact. dipMinBps 0 disables the band.
  dipMinBps: number;
  dipMaxBps: number;
  // Sizing (SOL).
  baseStakeSol: number;
  minStakeSol: number;
  maxStakeSol: number;
  // Exits (bps against the entry price, slots against the fill slot).
  takeProfitBps: number;
  stopLossBps: number;
  trailArmBps: number;
  trailGapBps: number;
  timeStopSlots: number;
  quietExitSlots: number;
  // Order tolerance.
  buySlippageBps: number;
  sellSlippageBps: number;
  // Risk.
  cashBufferSol: number;
  maxPositions: number;
  maxBuysPerBatch: number;
  // Pacing: relaxed entry once the 20-mint bar looks at risk.
  relaxedBuyShareBps: number;
  relaxedInflowSol: number;
  relaxedMinTrades: number;
  relaxedMinBuyers: number;
  relaxedMinReserveSol: number;
  relaxedDipMinBps: number;
  relaxedStakeSol: number;
  relaxAfterMints: number;
  relaxAfterSlots: number;
  // Drawdown brake (bps of equity off its peak).
  ddHalveBps: number;
  ddPauseBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minTrades: 20,
  minBuyShareBps: 7500,
  minBuyers: 8,
  minRealReserveSol: 3.5,
  minNetInflowSol: 1.0,
  minRiseBps: 300,
  maxRiseBps: 2500,
  maxJumpBps: 2500,
  maxAgeSlots: 3000,
  confirmDelaySlots: -1,
  confirmMaxDropBps: 500,
  confirmWindowSlots: 900,
  dipMinBps: 1300,
  dipMaxBps: 3000,
  baseStakeSol: 0.03,
  minStakeSol: 0.02,
  maxStakeSol: 0.06,
  takeProfitBps: 1200,
  stopLossBps: 1200,
  trailArmBps: 800,
  trailGapBps: 800,
  timeStopSlots: 1500,
  quietExitSlots: 600,
  buySlippageBps: 500,
  sellSlippageBps: 1000,
  cashBufferSol: 1.0,
  maxPositions: 5,
  maxBuysPerBatch: 3,
  relaxedBuyShareBps: 6000,
  relaxedInflowSol: 0.2,
  relaxedMinTrades: 12,
  relaxedMinBuyers: 5,
  relaxedMinReserveSol: 1.5,
  relaxedDipMinBps: 1300,
  relaxedStakeSol: 0.012,
  relaxAfterMints: 400,
  relaxAfterSlots: 150000,
  ddHalveBps: 1000,
  ddPauseBps: 2000,
};

// ---------------------------------------------------------------- helpers

const LAMPORTS_PER_SOL_NUM = 1_000_000_000;

/** SOL per token from virtual reserves (0 when the curve has no quote). */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n || virtualQuote <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** Change from `from` to `to` in basis points (0 when `from` is not positive). */
function changeBps(from: number, to: number): number {
  if (from <= 0 || to <= 0) return 0;
  return ((to - from) / from) * 10000;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

// ---------------------------------------------------------------- per-mint book

interface MintTrack {
  mint: string;
  createdSlot: number;
  firstSeenSlot: number;
  firstPrice: number;
  lastPrice: number;
  prevPrice: number;
  trades: number;
  buys: number;
  buyers: Set<string>;
  netInflowLamports: bigint;
  realReserveLamports: bigint;
  maxJumpBps: number;
  lastTradeSlot: number;
  complete: boolean;
  // Confirmation watch (meaningful only while not holding).
  confirmSlot: number;
  confirmPrice: number;
  // Highest price ever printed for this mint (drives the dip band).
  peakPriceSeen: number;
  // Position book (meaningful only while we hold the mint).
  holding: boolean;
  entryPrice: number;
  entrySlot: number;
  peakPrice: number;
  trailArmed: boolean;
  // Exit bookkeeping: how the last round trip on this mint ended.
  lastExit: '' | 'profit' | 'stop' | 'trail' | 'time' | 'quiet' | 'closed';
  trips: number;
}

function newTrack(mint: string, slot: number, price: number): MintTrack {
  return {
    mint,
    createdSlot: slot,
    firstSeenSlot: slot,
    firstPrice: price,
    lastPrice: price,
    prevPrice: price,
    trades: 0,
    buys: 0,
    buyers: new Set<string>(),
    netInflowLamports: 0n,
    realReserveLamports: 0n,
    maxJumpBps: 0,
    lastTradeSlot: slot,
    complete: false,
    confirmSlot: -1,
    confirmPrice: 0,
    peakPriceSeen: price,
    holding: false,
    entryPrice: 0,
    entrySlot: 0,
    peakPrice: 0,
    trailArmed: false,
    lastExit: '',
    trips: 0,
  };
}

// ---------------------------------------------------------------- strategy

export function createStrategy(params: Params): Bot {
  const p = params;
  const tracks = new Map<string, MintTrack>();
  let tripsDone = 0;
  const mintsTraded = new Set<string>();
  let freshSeen = 0;
  let firstSlot = -1;
  let batchesSeen = 0;
  let peakEquityLamports = 0n;
  let buysSent = 0;
  let sellsSent = 0;

  /** Mark-to-market equity: cash plus positions at their last known price. */
  function equityLamports(state: BotState): bigint {
    let equity = state.cash;
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const track = tracks.get(mint);
      const price = curve !== undefined
        ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves)
        : track !== undefined
          ? track.lastPrice
          : 0;
      if (price > 0) {
        // price is lamports per token; tokens * price is lamports.
        const value = BigInt(Math.floor(Number(holding.token_amount) * price));
        equity += value;
      }
    }
    return equity;
  }

  function relaxedMode(state: BotState): boolean {
    // The bar is 20 distinct mints traded, so pace against the distinct
    // count — repeat trips on the same mint do not advance the bar.
    if (mintsTraded.size >= 20) return false;
    if (freshSeen > p.relaxAfterMints) return true;
    if (firstSlot >= 0 && state.slot - firstSlot > p.relaxAfterSlots) return true;
    return false;
  }

  /** Does this curve qualify for a fresh buy right now? */
  function qualifies(track: MintTrack, relaxed: boolean): boolean {
    if (track.complete || track.holding) return false;
    if (track.lastExit === 'stop' || track.lastExit === 'trail') return false;
    const age = track.lastTradeSlot - track.createdSlot;
    if (age > p.maxAgeSlots && !relaxed) return false;
    const minTrades = relaxed ? p.relaxedMinTrades : p.minTrades;
    const minBuyers = relaxed ? p.relaxedMinBuyers : p.minBuyers;
    const minShare = relaxed ? p.relaxedBuyShareBps : p.minBuyShareBps;
    const minInflow = relaxed ? p.relaxedInflowSol : p.minNetInflowSol;
    if (track.trades < minTrades) return false;
    if (track.buyers.size < minBuyers) return false;
    if (track.trades > 0 && (track.buys * 10000) / track.trades < minShare) return false;
    if (Number(track.netInflowLamports) < minInflow * LAMPORTS_PER_SOL_NUM) return false;
    const minReserve = relaxed ? p.relaxedMinReserveSol : p.minRealReserveSol;
    if (Number(track.realReserveLamports) < minReserve * LAMPORTS_PER_SOL_NUM) return false;
    const rise = changeBps(track.firstPrice, track.lastPrice);
    if (rise < p.minRiseBps) return false;
    if (!relaxed && rise > p.maxRiseBps) return false;
    if (!relaxed && track.maxJumpBps > p.maxJumpBps) return false;
    // Dip band: the current print must sit below the observed peak — deep
    // enough that the burst is over, shallow enough that the curve is not
    // simply collapsing. Pacing mode uses its own (usually looser) band.
    const dipMin = relaxed ? p.relaxedDipMinBps : p.dipMinBps;
    if (dipMin > 0 && track.peakPriceSeen > 0) {
      const retrace = changeBps(track.peakPriceSeen, track.lastPrice);
      if (retrace > -dipMin) return false;
      if (retrace < -p.dipMaxBps) return false;
    }
    return true;
  }

  /** Stake for this curve in lamports, before the harness size cap. */
  function stakeLamports(track: MintTrack, relaxed: boolean, stakeScale: number): bigint {
    const inflowSol = Number(track.netInflowLamports) / LAMPORTS_PER_SOL_NUM;
    const base = relaxed ? p.relaxedStakeSol : p.baseStakeSol;
    const want = relaxed
      ? p.relaxedStakeSol
      : clamp(base * (0.5 + inflowSol), p.minStakeSol, p.maxStakeSol);
    return BigInt(Math.floor(want * stakeScale * LAMPORTS_PER_SOL_NUM));
  }

  return {
    onHello(state: BotState): void {
      peakEquityLamports = state.cash;
      firstSlot = -1;
      console.error(
        `[sharpe] hello seed=${state.hello.seed} capital=${state.cash} ` +
          `stake=${p.baseStakeSol} tp=${p.takeProfitBps}bps sl=${p.stopLossBps}bps`,
      );
    },

    onBatch(state: BotState, batch: Batch) {
      batchesSeen += 1;
      if (firstSlot < 0) firstSlot = state.slot;
      const orders: Array<{
        side: 'buy' | 'sell';
        mint: string;
        quote_lamports?: bigint;
        token_amount?: bigint;
        max_slippage_bps: number;
      }> = [];

      // --- 1. Fold this batch's fills into the books.
      for (const fill of batch.fills) {
        if (fill.status !== 'filled') continue;
        const track = tracks.get(fill.mint);
        if (fill.side === 'buy' && track !== undefined) {
          const tokens = BigInt(fill.token_amount);
          const paid = BigInt(fill.quote_lamports);
          track.holding = true;
          track.confirmSlot = -1;
          track.confirmPrice = 0;
          track.entryPrice = tokens > 0n ? Number(paid) / Number(tokens) : track.lastPrice;
          track.entrySlot = fill.slot;
          track.peakPrice = track.entryPrice;
          track.trailArmed = false;
        } else if (fill.side === 'sell' && track !== undefined) {
          if (track.holding) {
            track.holding = false;
            track.trips += 1;
            tripsDone += 1;
            mintsTraded.add(fill.mint);
          }
        }
      }

      // --- 2. Fold this batch's events into the per-mint tracks.
      const candidates: MintTrack[] = [];
      for (const event of batch.events) {
        if (event.event === 'CreateEvent') {
          freshSeen += 1;
          let track = tracks.get(event.mint);
          if (track === undefined) {
            track = newTrack(
              event.mint,
              event.slot,
              priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves)),
            );
            tracks.set(event.mint, track);
          }
          candidates.push(track);
        } else if (event.event === 'TradeEvent') {
          let track = tracks.get(event.mint);
          if (track === undefined) {
            track = newTrack(event.mint, event.slot, 0);
            tracks.set(event.mint, track);
          }
          const price = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
          if (track.firstPrice <= 0 && price > 0) track.firstPrice = price;
          if (track.lastPrice > 0 && price > 0) {
            const jump = Math.abs(changeBps(track.lastPrice, price));
            if (jump > track.maxJumpBps) track.maxJumpBps = jump;
          }
          track.prevPrice = track.lastPrice;
          if (price > 0) {
            track.lastPrice = price;
            if (price > track.peakPriceSeen) track.peakPriceSeen = price;
          }
          track.trades += 1;
          if (event.is_buy) {
            track.buys += 1;
            track.buyers.add(event.user);
            track.netInflowLamports += BigInt(event.sol_amount);
          } else {
            track.netInflowLamports -= BigInt(event.sol_amount);
          }
          track.realReserveLamports = BigInt(event.real_quote_reserves);
          track.lastTradeSlot = event.slot;
          candidates.push(track);
        } else {
          // CompleteEvent: the curve is done; the harness closes our position.
          const track = tracks.get(event.mint);
          if (track !== undefined) {
            track.complete = true;
            if (track.holding) {
              track.holding = false;
              track.lastExit = 'closed';
            }
          }
        }
      }

      // Marks refresh the price of mints we hold or have pending orders in.
      for (const mark of batch.marks) {
        const track = tracks.get(mark.mint);
        if (track === undefined) continue;
        const price = priceOf(BigInt(mark.virtual_quote_reserves), BigInt(mark.virtual_token_reserves));
        if (price > 0) {
          track.lastPrice = price;
          if (price > track.peakPriceSeen) track.peakPriceSeen = price;
        }
        track.realReserveLamports = BigInt(mark.real_quote_reserves);
      }

      // --- 3. Exits first: every held position is judged against written rules.
      const pendingSell = new Set<string>();
      for (const pending of state.pending.values()) {
        if (pending.order.side === 'sell') pendingSell.add(pending.order.mint);
      }
      for (const [mint, holding] of state.positions) {
        if (pendingSell.has(mint)) continue;
        const track = tracks.get(mint);
        const curve = state.curves.get(mint);
        const price = curve !== undefined
          ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves)
          : track !== undefined
            ? track.lastPrice
            : 0;
        if (price <= 0 || track === undefined) continue;
        if (!track.holding) {
          // Position exists but we missed its buy fill: adopt it at cost.
          track.holding = true;
          track.entryPrice = holding.token_amount > 0n
            ? Number(holding.cost_lamports) / Number(holding.token_amount)
            : price;
          track.entrySlot = state.slot;
          track.peakPrice = track.entryPrice;
          track.trailArmed = false;
        }
        if (price > track.peakPrice) track.peakPrice = price;
        const move = changeBps(track.entryPrice, price);
        let exitKind: '' | 'profit' | 'stop' | 'trail' | 'time' | 'quiet' = '';
        if (move >= p.takeProfitBps) exitKind = 'profit';
        else if (move <= -p.stopLossBps) exitKind = 'stop';
        else {
          if (move >= p.trailArmBps) track.trailArmed = true;
          if (track.trailArmed && changeBps(track.peakPrice, price) <= -p.trailGapBps) {
            exitKind = 'trail';
          } else if (state.slot - track.entrySlot > p.timeStopSlots) {
            exitKind = 'time';
          } else if (state.slot - track.lastTradeSlot > p.quietExitSlots) {
            exitKind = 'quiet';
          }
        }
        if (exitKind !== '') {
          track.lastExit = exitKind;
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: p.sellSlippageBps,
          });
          sellsSent += 1;
        }
      }

      // --- 4. Entries: buy sponsored curves, smallest-first, within the caps.
      const equity = equityLamports(state);
      if (equity > peakEquityLamports) peakEquityLamports = equity;
      const drawdownBps = peakEquityLamports > 0n
        ? Number(((peakEquityLamports - equity) * 10000n) / peakEquityLamports)
        : 0;
      const paused = drawdownBps >= p.ddPauseBps;
      const stakeScale = drawdownBps >= p.ddHalveBps ? 0.5 : 1;
      const relaxed = relaxedMode(state);
      if (!paused && state.committedPositionCount() < p.maxPositions) {
        const pendingBuy = new Set<string>();
        for (const pending of state.pending.values()) {
          if (pending.order.side === 'buy') pendingBuy.add(pending.order.mint);
        }
        let buysThisBatch = 0;
        // Candidates are the mints this batch touched, in event order; a
        // curve only gets one decision per batch.
        const seenThisBatch = new Set<string>();
        for (const track of candidates) {
          if (buysThisBatch >= p.maxBuysPerBatch) break;
          if (seenThisBatch.has(track.mint)) continue;
          seenThisBatch.add(track.mint);
          if (state.positions.has(track.mint)) continue;
          if (pendingBuy.has(track.mint)) continue;
          if (state.committedPositionCount() + buysThisBatch >= p.maxPositions) break;
          if (!qualifies(track, relaxed)) continue;
          // Confirmation watch (only when enabled): the first qualifying
          // touch starts the clock. Buy on a later touch once the delay has
          // passed, the price has held up, and the watch is still fresh.
          if (p.confirmDelaySlots >= 0) {
            if (track.confirmSlot < 0) {
              track.confirmSlot = state.slot;
              track.confirmPrice = track.lastPrice;
              continue;
            }
            if (state.slot - track.confirmSlot < p.confirmDelaySlots) continue;
            if (changeBps(track.confirmPrice, track.lastPrice) < -p.confirmMaxDropBps) {
              // Sagged while watched: it was a top, not an ignition. Reset
              // and make it qualify from scratch.
              track.confirmSlot = -1;
              track.confirmPrice = 0;
              continue;
            }
            if (state.slot - track.confirmSlot > p.confirmWindowSlots) {
              track.confirmSlot = state.slot;
              track.confirmPrice = track.lastPrice;
              continue;
            }
          }
          const cap = state.maxBuyLamports(track.mint);
          let stake = stakeLamports(track, relaxed, stakeScale);
          if (stake > cap) stake = cap;
          if (stake < 12_000_000n) continue;
          const txFee = state.txFeeLamports();
          const buffer = BigInt(Math.floor(p.cashBufferSol * LAMPORTS_PER_SOL_NUM));
          if (state.freeCashLamports() < buffer + stake + txFee) continue;
          orders.push({
            side: 'buy',
            mint: track.mint,
            quote_lamports: stake,
            max_slippage_bps: p.buySlippageBps,
          });
          buysSent += 1;
          buysThisBatch += 1;
        }
      }

      // --- 5. Light pruning: drop dead curves we never touched.
      if (batchesSeen % 2000 === 0) {
        for (const [mint, track] of tracks) {
          if (track.holding || state.positions.has(mint)) continue;
          if (track.complete || state.slot - track.lastTradeSlot > 10000) {
            tracks.delete(mint);
          }
        }
      }

      return orders;
    },

    onDone(state: BotState, done: Done): void {
      const net = state.cash - BigInt(state.hello.capital.lamports);
      console.error(
        `[sharpe] done reason=${done.reason} batches=${batchesSeen} ` +
          `trips=${tripsDone} mints=${mintsTraded.size} ` +
          `buys=${buysSent} sells=${sellsSent} net=${Number(net) / LAMPORTS_PER_SOL_NUM} SOL`,
      );
    },
  };
}
