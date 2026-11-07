/**
 * Pair live deals log closes with backtest trades for the same epic and window.
 */
import type { Transaction } from '../transactionLog';
import type { BacktestTrade } from './rulesBacktest';

export interface ReconcilePair {
  live: Transaction;
  sim: BacktestTrade;
  entryDeltaSec: number;
  exitDeltaSec: number;
  plDelta: number;
}

export interface ReconcileReport {
  epic: string;
  fromTs: number;
  toTs: number;
  liveCount: number;
  simCount: number;
  pairedCount: number;
  onlyLive: Transaction[];
  onlySim: BacktestTrade[];
  pairs: ReconcilePair[];
  /** Max seconds between entry times to consider a match. */
  matchWindowSec: number;
}

const DEFAULT_MATCH_SEC = 180;

function txCloseTime(tx: Transaction): number {
  const t = Date.parse(tx.timestamp);
  return isNaN(t) ? 0 : t;
}

function txOpenTime(tx: Transaction): number {
  const raw = tx.openedAt || tx.timestamp;
  const t = Date.parse(raw);
  return isNaN(t) ? txCloseTime(tx) : t;
}

export function reconcileLiveWithBacktest(
  epic: string,
  liveClosed: Transaction[],
  simTrades: BacktestTrade[],
  opts?: { fromTs?: number; toTs?: number; matchWindowSec?: number }
): ReconcileReport {
  const fromTs = opts?.fromTs ?? 0;
  const toTs = opts?.toTs ?? Number.MAX_SAFE_INTEGER;
  const matchWindowSec = opts?.matchWindowSec ?? DEFAULT_MATCH_SEC;
  const matchMs = matchWindowSec * 1000;

  const live = liveClosed
    .filter((t) => (t.epic || '').trim() === epic.trim())
    .filter((t) => {
      const open = txOpenTime(t);
      return open >= fromTs && open <= toTs;
    })
    .sort((a, b) => txOpenTime(a) - txOpenTime(b));

  const sim = simTrades
    .filter((t) => t.entryTs >= fromTs && t.entryTs <= toTs)
    .sort((a, b) => a.entryTs - b.entryTs);

  const usedLive = new Set<string>();
  const usedSim = new Set<number>();
  const pairs: ReconcilePair[] = [];

  for (let si = 0; si < sim.length; si++) {
    const st = sim[si];
    let bestLi = -1;
    let bestDelta = matchMs + 1;
    for (let li = 0; li < live.length; li++) {
      const lt = live[li];
      const lid = (lt.dealId || lt.id || '').trim() || String(li);
      if (usedLive.has(lid)) continue;
      if (lt.direction !== st.direction) continue;
      const delta = Math.abs(txOpenTime(lt) - st.entryTs);
      if (delta <= matchMs && delta < bestDelta) {
        bestDelta = delta;
        bestLi = li;
      }
    }
    if (bestLi >= 0) {
      const lt = live[bestLi];
      const lid = (lt.dealId || lt.id || '').trim() || String(bestLi);
      usedLive.add(lid);
      usedSim.add(si);
      const livePl = typeof lt.profitLoss === 'number' ? lt.profitLoss : 0;
      const size = lt.size > 0 ? lt.size : 1;
      const simDealPl = st.profitLoss * size;
      pairs.push({
        live: lt,
        sim: st,
        entryDeltaSec: Math.round(bestDelta / 1000),
        exitDeltaSec: Math.round(Math.abs(txCloseTime(lt) - st.exitTs) / 1000),
        plDelta: livePl - simDealPl,
      });
    }
  }

  const onlyLive = live.filter((t, i) => {
    const lid = (t.dealId || t.id || '').trim() || String(i);
    return !usedLive.has(lid);
  });
  const onlySim = sim.filter((_, si) => !usedSim.has(si));

  return {
    epic: epic.trim(),
    fromTs,
    toTs,
    liveCount: live.length,
    simCount: sim.length,
    pairedCount: pairs.length,
    onlyLive,
    onlySim,
    pairs,
    matchWindowSec,
  };
}
