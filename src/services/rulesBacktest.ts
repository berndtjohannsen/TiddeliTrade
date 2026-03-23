/**
 * Backtest rules against recorded price samples.
 * Ports rules evaluation logic from tradingRules.js for server-side analysis.
 */

import type { RecordedSample } from './priceRecorder';

const RIGHT_REF_KEYS = [
  'short.min', 'short.avg', 'short.max', 'short.range', 'short.trendPct', 'short.volume',
  'medium.min', 'medium.avg', 'medium.max', 'medium.range', 'medium.trendPct', 'medium.volume',
  'long.min', 'long.avg', 'long.max', 'long.range', 'long.trendPct', 'long.volume',
  'dayStart',
];

const FLAT_THRESHOLD_PCT = 0.005;

export interface Rule {
  left: string;
  op: string;
  right: string;
  enabled?: boolean;
}

export interface BacktestConfig {
  rules: Rule[];
  probeShortMinutes: number;
  probeMediumMinutes: number;
  probeLongMinutes: number;
  is24_7: boolean;
  /** Take profit: raw value. Interpretation depends on tpSlMode. */
  takeProfit?: string | null;
  /** Stop loss: raw value. Interpretation depends on tpSlMode. */
  stopLoss?: string | null;
  /** 'rate' = price levels, 'pct' = % from entry, 'value' = £ gain/loss. */
  tpSlMode?: 'value' | 'rate' | 'pct';
    dealSize?: string;
  contractSize?: number;
}

interface ProbeStats {
  min: number | null;
  max: number | null;
  range: number | null;
  avg: number | null;
  stdDev: number | null;
  avgSpread: number | null;
  count: number;
  trendDir: string | null;
  trendPct: number | null;
}

interface Context {
  offer: number | null;
  bid: number | null;
  dayStart: number | null;
  currentTime: string;
  currentTrend: string | null;
  sentiment: string | null;
  probes: { short: ProbeStats; medium: ProbeStats; long: ProbeStats };
}

function isTradingSample(ts: number, now: number, is24_7: boolean): boolean {
  if (is24_7) return true;
  const ageMs = now - ts;
  if (ageMs < 2 * 60 * 60 * 1000) return true;
  const d = new Date(ts).getUTCDay();
  return d >= 1 && d <= 5;
}

function extendWindowOverWeekends(periodMs: number, is24_7: boolean): number {
  if (is24_7) return periodMs;
  if (periodMs < 24 * 60 * 60 * 1000) return periodMs;
  const days = Math.ceil(periodMs / (24 * 60 * 60 * 1000));
  const weekendDays = Math.floor((days + 5) / 7) * 2;
  return periodMs + weekendDays * 24 * 60 * 60 * 1000;
}

function computeStats(samples: { mid: number; spread: number }[]): Omit<ProbeStats, 'trendDir' | 'trendPct'> {
  if (!samples || samples.length === 0) {
    return { min: null, max: null, range: null, avg: null, stdDev: null, avgSpread: null, count: 0 };
  }
  let min = samples[0].mid;
  let max = samples[0].mid;
  let sum = 0;
  let spreadSum = 0;
  for (const s of samples) {
    if (s.mid < min) min = s.mid;
    if (s.mid > max) max = s.mid;
    sum += s.mid;
    spreadSum += s.spread || 0;
  }
  const avg = sum / samples.length;
  let sqDiffSum = 0;
  for (const s of samples) {
    const d = s.mid - avg;
    sqDiffSum += d * d;
  }
  const stdDev = samples.length > 1 ? Math.sqrt(sqDiffSum / (samples.length - 1)) : 0;
  return {
    min, max, range: max - min, avg, stdDev,
    avgSpread: spreadSum / samples.length,
    count: samples.length,
  };
}

function computeTrend(samples: { mid: number }[]): { dir: string; pct: number } | null {
  if (!samples || samples.length < 2) return null;
  const first = samples[0].mid;
  const last = samples[samples.length - 1].mid;
  if (first <= 0 || isNaN(first) || isNaN(last)) return null;
  const pct = ((last - first) / first) * 100;
  const dir = Math.abs(pct) < FLAT_THRESHOLD_PCT ? 'flat' : (pct > 0 ? 'up' : 'down');
  return { dir, pct };
}

/** Binary search: first index where arr[i].ts >= minTs. Assumes arr sorted by ts. */
function findWindowStart(arr: { ts: number }[], minTs: number): number {
  if (arr.length === 0 || arr[arr.length - 1].ts < minTs) return arr.length;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < minTs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function getProbes(
  priceHistory: { ts: number; mid: number; spread: number }[],
  nowTs: number,
  config: BacktestConfig
): { short: ProbeStats; medium: ProbeStats; long: ProbeStats } {
  const shortMs = config.probeShortMinutes * 60 * 1000;
  const mediumMs = config.probeMediumMinutes * 60 * 1000;
  const longMs = config.probeLongMinutes * 60 * 1000;
  const shortWindow = extendWindowOverWeekends(shortMs, config.is24_7);
  const mediumWindow = extendWindowOverWeekends(mediumMs, config.is24_7);
  const longWindow = extendWindowOverWeekends(longMs, config.is24_7);

  const startIdx = findWindowStart(priceHistory, nowTs - longWindow);
  const shortSamp: { mid: number; spread: number }[] = [];
  const mediumSamp: { mid: number; spread: number }[] = [];
  const longSamp: { mid: number; spread: number }[] = [];
  for (let j = startIdx; j < priceHistory.length; j++) {
    const s = priceHistory[j];
    if (s.ts >= nowTs - longWindow && isTradingSample(s.ts, nowTs, config.is24_7)) {
      const e = { mid: s.mid, spread: s.spread };
      longSamp.push(e);
      if (s.ts >= nowTs - mediumWindow) mediumSamp.push(e);
      if (s.ts >= nowTs - shortWindow) shortSamp.push(e);
    }
  }

  const shortStats = computeStats(shortSamp);
  const mediumStats = computeStats(mediumSamp);
  const longStats = computeStats(longSamp);
  const shortTrend = computeTrend(shortSamp);
  const mediumTrend = computeTrend(mediumSamp);
  const longTrend = computeTrend(longSamp);

  return {
    short: { ...shortStats, trendDir: shortTrend?.dir ?? null, trendPct: shortTrend?.pct ?? null },
    medium: { ...mediumStats, trendDir: mediumTrend?.dir ?? null, trendPct: mediumTrend?.pct ?? null },
    long: { ...longStats, trendDir: longTrend?.dir ?? null, trendPct: longTrend?.pct ?? null },
  };
}

function sentimentFromLongShort(longPct: number | null, shortPct: number | null): string | null {
  if (longPct == null || shortPct == null) return null;
  if (longPct === 0 && shortPct === 0) return null;
  const diff = longPct - shortPct;
  return diff > 5 ? 'Bull' : diff < -5 ? 'Bear' : 'Neutral';
}

function formatTimeFromTs(ts: number): string {
  const d = new Date(ts);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function getLeftValue(rule: Rule, ctx: Context): number | string | null {
  if (rule.left === 'Buy') return ctx.offer;
  if (rule.left === 'Sell') return ctx.bid;
  if (rule.left === 'currentTime') return ctx.currentTime;
  if (rule.left === 'now.sentiment') return ctx.sentiment;
  if (rule.left === 'now.trend') return ctx.currentTrend;
  const probeKeys = ['short.volume', 'medium.volume', 'long.volume', 'short.trend', 'medium.trend', 'long.trend',
    'short.trendPct', 'medium.trendPct', 'long.trendPct', 'short.range', 'medium.range', 'long.range'];
  for (const k of probeKeys) {
    if (rule.left === k) {
      const [probe, stat] = k.split('.');
      const p = ctx.probes[probe as keyof typeof ctx.probes];
      if (!p) return null;
      if (stat === 'volume') return p.count;
      if (stat === 'trend') return p.trendDir;
      if (stat === 'trendPct') return p.trendPct;
      if (stat === 'range') return p.range;
      return null;
    }
  }
  return null;
}

function getRightValue(rule: Rule, ctx: Context): number | string | null {
  if (rule.left === 'currentTime') return rule.right;
  if (rule.left === 'now.sentiment') return rule.right;
  if (rule.left === 'now.trend' || rule.left === 'short.trend' || rule.left === 'medium.trend' || rule.left === 'long.trend') return rule.right;
  const r = rule.right;
  if (RIGHT_REF_KEYS.includes(r)) {
    if (r === 'dayStart') return ctx.dayStart;
    const [probe, stat] = r.split('.');
    const p = ctx.probes[probe as keyof typeof ctx.probes];
    if (!p) return null;
    const key = stat === 'avg' ? 'avg' : stat === 'min' ? 'min' : stat === 'max' ? 'max' : stat === 'volume' ? 'count' : stat === 'range' ? 'range' : stat === 'trendPct' ? 'trendPct' : null;
    return key != null ? (p as unknown as Record<string, number>)[key] ?? null : null;
  }
  const n = parseFloat(r);
  return isNaN(n) ? null : n;
}

function evaluateRule(rule: Rule, ctx: Context): boolean {
  const leftVal = getLeftValue(rule, ctx);
  const rightVal = getRightValue(rule, ctx);
  if (rule.left === 'currentTime') {
    const lStr = String(leftVal ?? '').trim();
    const rStr = String(rightVal ?? '').trim();
    if (!lStr || !rStr) return false;
    const c = lStr.localeCompare(rStr);
    switch (rule.op) {
      case 'lte': return c <= 0;
      case 'gte': return c >= 0;
      case 'lt': return c < 0;
      case 'gt': return c > 0;
      case 'eq': return c === 0;
      default: return false;
    }
  }
  if (rule.left === 'now.sentiment') {
    if (leftVal == null) return true;
    if (rightVal == null) return false;
    const r = String(rightVal);
    if (r === 'any') return true;
    if (!['Bull', 'Bear', 'Neutral'].includes(r)) return false;
    const l = String(leftVal);
    return rule.op === 'eq' ? l === r : false;
  }
  if (rule.left === 'now.trend' || rule.left === 'short.trend' || rule.left === 'medium.trend' || rule.left === 'long.trend') {
    const l = String(leftVal);
    if (leftVal == null || rightVal == null) return false;
    const r = String(rightVal);
    if (!['up', 'down', 'flat'].includes(r)) return false;
    const trendOrd = (x: string) => x === 'down' ? 0 : x === 'flat' ? 1 : x === 'up' ? 2 : -1;
    const leftOrd = trendOrd(l);
    const rightOrd = trendOrd(r);
    if (leftOrd < 0) return false;
    switch (rule.op) {
      case 'eq': return leftOrd === rightOrd;
      case 'lte': return leftOrd <= rightOrd;
      case 'gte': return leftOrd >= rightOrd;
      case 'lt': return leftOrd < rightOrd;
      case 'gt': return leftOrd > rightOrd;
      default: return false;
    }
  }
  if (typeof leftVal !== 'number' || typeof rightVal !== 'number') return false;
  switch (rule.op) {
    case 'lte': return leftVal <= rightVal;
    case 'gte': return leftVal >= rightVal;
    case 'lt': return leftVal < rightVal;
    case 'gt': return leftVal > rightVal;
    case 'eq': return leftVal === rightVal;
    default: return false;
  }
}

function evaluateRules(ctx: Context, config: BacktestConfig): boolean {
  const enabledRules = config.rules.filter((r) => r.enabled !== false);
  if (enabledRules.length === 0) return false;
  for (const rule of enabledRules) {
    if (!evaluateRule(rule, ctx)) return false;
  }
  return true;
}

/** Returns indices of rules that failed. */
function getFailingRuleIndices(ctx: Context, config: BacktestConfig): number[] {
  const enabledRules = config.rules.filter((r) => r.enabled !== false);
  const failing: number[] = [];
  for (let i = 0; i < enabledRules.length; i++) {
    if (!evaluateRule(enabledRules[i], ctx)) failing.push(i);
  }
  return failing;
}

function inferDirection(config: BacktestConfig): 'BUY' | 'SELL' {
  const enabled = config.rules.filter((r) => r.enabled !== false);
  for (const r of enabled) {
    if (r.left === 'Buy') return 'BUY';
    if (r.left === 'Sell') return 'SELL';
  }
  return 'BUY';
}

function getTpSlLevels(
  entry: number,
  direction: 'BUY' | 'SELL',
  config: BacktestConfig
): { tpLevel: number | null; slLevel: number | null } {
  const mode = config.tpSlMode || 'rate';
  const tpRaw = config.takeProfit?.trim();
  const slRaw = config.stopLoss?.trim();
  if (!tpRaw && !slRaw) return { tpLevel: null, slLevel: null };

  const tpVal = tpRaw ? parseFloat(tpRaw) : NaN;
  const slVal = slRaw ? parseFloat(slRaw) : NaN;
  const size = parseFloat(config.dealSize || '1') || 1;
  const contractSize = (config.contractSize != null && config.contractSize > 0) ? config.contractSize : 1;
  const denom = size * contractSize;

  let tpLevel: number | null = null;
  let slLevel: number | null = null;

  if (mode === 'rate') {
    if (!isNaN(tpVal)) tpLevel = tpVal;
    if (!isNaN(slVal)) slLevel = slVal;
  } else if (mode === 'pct') {
    if (!isNaN(tpVal)) tpLevel = direction === 'BUY' ? entry * (1 + tpVal / 100) : entry * (1 - tpVal / 100);
    if (!isNaN(slVal)) slLevel = direction === 'BUY' ? entry * (1 - slVal / 100) : entry * (1 + slVal / 100);
  } else if (mode === 'value' && denom > 0) {
    if (!isNaN(tpVal) && tpVal > 0) tpLevel = direction === 'BUY' ? entry + tpVal / denom : entry - tpVal / denom;
    if (!isNaN(slVal) && slVal > 0) slLevel = direction === 'BUY' ? entry - slVal / denom : entry + slVal / denom;
  }

  return { tpLevel, slLevel };
}

export type ExitReason = 'tp' | 'sl' | 'rules' | 'endOfPeriod';

export interface BacktestTrade {
  direction: 'BUY' | 'SELL';
  entryTs: number;
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  profitLoss: number;
  exitReason?: ExitReason;
}

export interface CloseReasonCounts {
  tp: number;
  sl: number;
  rules: number;
  endOfPeriod: number;
}

export interface BacktestReport {
  trades: BacktestTrade[];
  totalGainLoss: number;
  /** Total P/L in currency (£) when dealSize/contractSize available. Same as totalGainLoss for 1:1 instruments. */
  totalGainLossPounds?: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgTradePnl: number;
  avgTradePnlPounds?: number;
  sampleCount: number;
  startTs: number;
  endTs: number;
  /** Number of positions still open at end of recording (not closed by TP/SL). */
  openAtEnd?: number;
  /** Number of days analysed (when run per-day, no interday positions). */
  daysAnalysed?: number;
  /** How positions were closed: TP, SL, rules stopped, end of period. */
  closeReasonCounts?: CloseReasonCounts;
  /** When carry-over and days were non-consecutive, we split into blocks and closed at each block end. */
  nonConsecutiveWarning?: string;
  /** Per-rule sole blocker counts: times this rule was the only one failing when we could have opened. */
  ruleBlockerCounts?: Array<{ left: string; op: string; right: string; soleBlockerCount: number }>;
}

function getDayKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Run backtest per day (no interday positions), then aggregate. Each day is independent. */
export function runBacktestPerDay(
  samples: RecordedSample[],
  config: BacktestConfig,
  onProgress?: (processed: number, total: number) => void
): BacktestReport {
  const byDay = new Map<string, RecordedSample[]>();
  for (const s of samples) {
    const key = getDayKey(s.ts);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }
  const days = Array.from(byDay.keys()).sort();
  const totalDays = days.length;
  const allTrades: BacktestTrade[] = [];
  let totalGainLoss = 0;
  let totalSamples = 0;
  let openAtEndTotal = 0;
  let startTs = 0;
  let endTs = 0;
  const blockerAggregate = new Map<string, number>();

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const daySamples = byDay.get(day)!;
    try {
      const report = runBacktest(daySamples, config);
      allTrades.push(...report.trades);
      totalGainLoss += report.totalGainLoss;
      totalSamples += report.sampleCount;
      openAtEndTotal += report.openAtEnd ?? 0;
      if (report.ruleBlockerCounts) {
        for (const b of report.ruleBlockerCounts) {
          const k = `${b.left}|${b.op}|${b.right}`;
          blockerAggregate.set(k, (blockerAggregate.get(k) ?? 0) + b.soleBlockerCount);
        }
      }
      if (daySamples.length > 0) {
        if (startTs === 0 || daySamples[0].ts < startTs) startTs = daySamples[0].ts;
        if (daySamples[daySamples.length - 1].ts > endTs) endTs = daySamples[daySamples.length - 1].ts;
      }
    } catch (err) {
      throw new Error(`Backtest failed for day ${day}: ${err instanceof Error ? err.message : String(err)}`);
    }
    onProgress?.(i + 1, totalDays);
  }

  const winningTrades = allTrades.filter((t) => t.profitLoss > 0).length;
  const losingTrades = allTrades.filter((t) => t.profitLoss < 0).length;
  const size = parseFloat(config.dealSize || '1') || 1;
  const contractSize = (config.contractSize != null && config.contractSize > 0) ? config.contractSize : 1;
  const denom = size * contractSize;
  const totalGainLossPounds = denom > 0 ? totalGainLoss * denom : undefined;
  const avgTradePnlPounds = (denom > 0 && allTrades.length > 0) ? (totalGainLoss / allTrades.length) * denom : undefined;

  const ruleBlockerCounts: Array<{ left: string; op: string; right: string; soleBlockerCount: number }> = [];
  for (const [key, count] of blockerAggregate.entries()) {
    if (count > 0) {
      const [left, op, right] = key.split('|');
      ruleBlockerCounts.push({ left, op, right, soleBlockerCount: count });
    }
  }
  ruleBlockerCounts.sort((a, b) => b.soleBlockerCount - a.soleBlockerCount);

  const closeReasonCounts: CloseReasonCounts = {
    tp: allTrades.filter((t) => t.exitReason === 'tp').length,
    sl: allTrades.filter((t) => t.exitReason === 'sl').length,
    rules: allTrades.filter((t) => t.exitReason === 'rules').length,
    endOfPeriod: allTrades.filter((t) => t.exitReason === 'endOfPeriod').length,
  };

  return {
    trades: allTrades,
    totalGainLoss,
    totalGainLossPounds,
    tradeCount: allTrades.length,
    winningTrades,
    losingTrades,
    winRate: allTrades.length > 0 ? (winningTrades / allTrades.length) * 100 : 0,
    avgTradePnl: allTrades.length > 0 ? totalGainLoss / allTrades.length : 0,
    avgTradePnlPounds,
    sampleCount: totalSamples,
    startTs,
    endTs,
    openAtEnd: openAtEndTotal,
    daysAnalysed: days.length,
    closeReasonCounts,
    ruleBlockerCounts: ruleBlockerCounts.length > 0 ? ruleBlockerCounts : undefined,
  };
}

/** Group sorted days into consecutive blocks. Returns array of day arrays. */
function groupConsecutiveDays(days: string[]): string[][] {
  if (days.length === 0) return [];
  const blocks: string[][] = [];
  let current: string[] = [days[0]];
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(current[current.length - 1]);
    const next = new Date(days[i]);
    const prevNext = new Date(prev);
    prevNext.setDate(prevNext.getDate() + 1);
    if (next.getTime() === prevNext.getTime()) {
      current.push(days[i]);
    } else {
      blocks.push(current);
      current = [days[i]];
    }
  }
  blocks.push(current);
  return blocks;
}

/** Carry-over mode: group days into consecutive blocks, run backtest per block, aggregate. */
export function runBacktestCarryOver(
  samples: RecordedSample[],
  config: BacktestConfig,
  onProgress?: (processed: number, total: number) => void
): BacktestReport {
  const byDay = new Map<string, RecordedSample[]>();
  for (const s of samples) {
    const key = getDayKey(s.ts);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }
  const days = Array.from(byDay.keys()).sort();
  const totalDays = days.length;
  const blocks = groupConsecutiveDays(days);
  const nonConsecutiveWarning =
    blocks.length > 1
      ? `Days were not consecutive. Split into ${blocks.length} block(s); positions closed at end of each block.`
      : undefined;

  const allTrades: BacktestTrade[] = [];
  let totalGainLoss = 0;
  let totalSamples = 0;
  let openAtEndTotal = 0;
  let startTs = 0;
  let endTs = 0;
  const blockerAggregate = new Map<string, number>();
  let daysProcessed = 0;
  onProgress?.(0, totalDays);

  for (const blockDays of blocks) {
    const blockSamples: RecordedSample[] = [];
    for (const d of blockDays) {
      blockSamples.push(...(byDay.get(d) ?? []));
    }
    const blockDayCount = blockDays.length;
    const report = runBacktest(blockSamples, config, (samplesDone, blockTotal) => {
      const frac = blockTotal > 0 ? samplesDone / blockTotal : 1;
      const approxDays = daysProcessed + Math.floor(frac * blockDayCount);
      onProgress?.(Math.min(approxDays, totalDays), totalDays);
    });
    allTrades.push(...report.trades);
    totalGainLoss += report.totalGainLoss;
    totalSamples += report.sampleCount;
    openAtEndTotal += report.openAtEnd ?? 0;
    if (report.ruleBlockerCounts) {
      for (const b of report.ruleBlockerCounts) {
        const k = `${b.left}|${b.op}|${b.right}`;
        blockerAggregate.set(k, (blockerAggregate.get(k) ?? 0) + b.soleBlockerCount);
      }
    }
    if (blockSamples.length > 0) {
      if (startTs === 0 || blockSamples[0].ts < startTs) startTs = blockSamples[0].ts;
      if (blockSamples[blockSamples.length - 1].ts > endTs) endTs = blockSamples[blockSamples.length - 1].ts;
    }
    daysProcessed += blockDays.length;
    onProgress?.(daysProcessed, totalDays);
  }

  const winningTrades = allTrades.filter((t) => t.profitLoss > 0).length;
  const losingTrades = allTrades.filter((t) => t.profitLoss < 0).length;
  const size = parseFloat(config.dealSize || '1') || 1;
  const contractSize = (config.contractSize != null && config.contractSize > 0) ? config.contractSize : 1;
  const denom = size * contractSize;
  const totalGainLossPounds = denom > 0 ? totalGainLoss * denom : undefined;
  const avgTradePnlPounds = (denom > 0 && allTrades.length > 0) ? (totalGainLoss / allTrades.length) * denom : undefined;

  const ruleBlockerCounts: Array<{ left: string; op: string; right: string; soleBlockerCount: number }> = [];
  for (const [key, count] of blockerAggregate.entries()) {
    if (count > 0) {
      const [left, op, right] = key.split('|');
      ruleBlockerCounts.push({ left, op, right, soleBlockerCount: count });
    }
  }
  ruleBlockerCounts.sort((a, b) => b.soleBlockerCount - a.soleBlockerCount);

  const closeReasonCounts: CloseReasonCounts = {
    tp: allTrades.filter((t) => t.exitReason === 'tp').length,
    sl: allTrades.filter((t) => t.exitReason === 'sl').length,
    rules: allTrades.filter((t) => t.exitReason === 'rules').length,
    endOfPeriod: allTrades.filter((t) => t.exitReason === 'endOfPeriod').length,
  };

  return {
    trades: allTrades,
    totalGainLoss,
    totalGainLossPounds,
    tradeCount: allTrades.length,
    winningTrades,
    losingTrades,
    winRate: allTrades.length > 0 ? (winningTrades / allTrades.length) * 100 : 0,
    avgTradePnl: allTrades.length > 0 ? totalGainLoss / allTrades.length : 0,
    avgTradePnlPounds,
    sampleCount: totalSamples,
    startTs,
    endTs,
    openAtEnd: openAtEndTotal,
    daysAnalysed: days.length,
    closeReasonCounts,
    nonConsecutiveWarning,
    ruleBlockerCounts: ruleBlockerCounts.length > 0 ? ruleBlockerCounts : undefined,
  };
}

/** Async version: yields between days to prevent event-loop blocking and allow GC. */
export function runBacktestPerDayAsync(
  samples: RecordedSample[],
  config: BacktestConfig,
  done: (report: BacktestReport) => void,
  onError?: (err: Error) => void
): void {
  const byDay = new Map<string, RecordedSample[]>();
  for (const s of samples) {
    const key = getDayKey(s.ts);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }
  const days = Array.from(byDay.keys()).sort();
  const allTrades: BacktestTrade[] = [];
  let totalGainLoss = 0;
  let totalSamples = 0;
  let openAtEndTotal = 0;
  let startTs = 0;
  let endTs = 0;
  const blockerAggregate = new Map<string, number>();

  function processDay(index: number): void {
    if (index >= days.length) {
      const winningTrades = allTrades.filter((t) => t.profitLoss > 0).length;
      const losingTrades = allTrades.filter((t) => t.profitLoss < 0).length;
      const size = parseFloat(config.dealSize || '1') || 1;
      const contractSize = (config.contractSize != null && config.contractSize > 0) ? config.contractSize : 1;
      const denom = size * contractSize;
      const totalGainLossPounds = denom > 0 ? totalGainLoss * denom : undefined;
      const avgTradePnlPounds = (denom > 0 && allTrades.length > 0) ? (totalGainLoss / allTrades.length) * denom : undefined;
      const ruleBlockerCounts: Array<{ left: string; op: string; right: string; soleBlockerCount: number }> = [];
      for (const [key, count] of blockerAggregate.entries()) {
        if (count > 0) {
          const [left, op, right] = key.split('|');
          ruleBlockerCounts.push({ left, op, right, soleBlockerCount: count });
        }
      }
      ruleBlockerCounts.sort((a, b) => b.soleBlockerCount - a.soleBlockerCount);
      done({
        trades: allTrades,
        totalGainLoss,
        totalGainLossPounds,
        tradeCount: allTrades.length,
        winningTrades,
        losingTrades,
        winRate: allTrades.length > 0 ? (winningTrades / allTrades.length) * 100 : 0,
        avgTradePnl: allTrades.length > 0 ? totalGainLoss / allTrades.length : 0,
        avgTradePnlPounds,
        sampleCount: totalSamples,
        startTs,
        endTs,
        openAtEnd: openAtEndTotal,
        daysAnalysed: days.length,
        ruleBlockerCounts: ruleBlockerCounts.length > 0 ? ruleBlockerCounts : undefined,
      });
      return;
    }
    const day = days[index];
    const daySamples = byDay.get(day)!;
    setImmediate(() => {
      try {
        const report = runBacktest(daySamples, config);
        allTrades.push(...report.trades);
        totalGainLoss += report.totalGainLoss;
        totalSamples += report.sampleCount;
        openAtEndTotal += report.openAtEnd ?? 0;
        if (report.ruleBlockerCounts) {
          for (const b of report.ruleBlockerCounts) {
            const k = `${b.left}|${b.op}|${b.right}`;
            blockerAggregate.set(k, (blockerAggregate.get(k) ?? 0) + b.soleBlockerCount);
          }
        }
        if (daySamples.length > 0) {
          if (startTs === 0 || daySamples[0].ts < startTs) startTs = daySamples[0].ts;
          if (daySamples[daySamples.length - 1].ts > endTs) endTs = daySamples[daySamples.length - 1].ts;
        }
        processDay(index + 1);
      } catch (err) {
        if (onError) onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  processDay(0);
}

function getLongWindowMs(config: BacktestConfig): number {
  const longMs = config.probeLongMinutes * 60 * 1000;
  return extendWindowOverWeekends(longMs, config.is24_7);
}

const PROGRESS_SAMPLE_INTERVAL = 50000;

export function runBacktest(
  samples: RecordedSample[],
  config: BacktestConfig,
  onProgress?: (samplesProcessed: number, totalSamples: number) => void
): BacktestReport {
  const trades: BacktestTrade[] = [];
  const priceHistory: { ts: number; mid: number; spread: number }[] = [];
  const longWindowMs = getLongWindowMs(config);
  let openPosition: { direction: 'BUY' | 'SELL'; entryTs: number; entryPrice: number } | null = null;
  let prevRulesPass = false;
  let prevBlocked = false;
  let prevMid: number | null = null;
  const direction = inferDirection(config);
  const dayStart = samples.length > 0 ? samples[0].offer : null;
  const enabledRules = config.rules.filter((r) => r.enabled !== false);
  const soleBlockerCounts = new Map<number, number>();
  for (let i = 0; i < enabledRules.length; i++) soleBlockerCounts.set(i, 0);
  const totalSamples = samples.length;

  for (let i = 0; i < samples.length; i++) {
    if (onProgress && (i + 1) % PROGRESS_SAMPLE_INTERVAL === 0) {
      onProgress(i + 1, totalSamples);
    }
    const s = samples[i];
    const mid = (s.bid + s.offer) / 2;
    priceHistory.push({ ts: s.ts, mid, spread: s.spread });

    const trimFrom = findWindowStart(priceHistory, s.ts - longWindowMs);
    if (trimFrom > 0) {
      priceHistory.splice(0, trimFrom);
    }

    const currentTrend = prevMid != null
      ? (mid > prevMid ? 'up' : mid < prevMid ? 'down' : 'flat')
      : null;
    prevMid = mid;

    const probes = getProbes(priceHistory, s.ts, config);
    const sentiment = sentimentFromLongShort(s.longPct, s.shortPct);

    const ctx: Context = {
      offer: s.offer,
      bid: s.bid,
      dayStart,
      currentTime: formatTimeFromTs(s.ts),
      currentTrend,
      sentiment,
      probes,
    };

    const rulesPass = evaluateRules(ctx, config);
    const blocked = openPosition !== null;
    const pass = rulesPass;

    // Sole blocker: when no position and rules don't all pass, count which rule was the only failure
    if (!blocked && !pass && enabledRules.length > 0) {
      const failing = getFailingRuleIndices(ctx, config);
      if (failing.length === 1) {
        const idx = failing[0];
        soleBlockerCounts.set(idx, (soleBlockerCounts.get(idx) ?? 0) + 1);
      }
    }

    // Check TP/SL when we have a position (before rules-fail close)
    if (blocked && openPosition) {
      const { tpLevel, slLevel } = getTpSlLevels(openPosition.entryPrice, openPosition.direction, config);
      const exitBid = s.bid;
      const exitOffer = s.offer;
      let closedByTpSl = false;

      if (tpLevel != null && openPosition.direction === 'BUY' && exitBid >= tpLevel) {
        const pnl = tpLevel - openPosition.entryPrice;
        trades.push({ direction: openPosition.direction, entryTs: openPosition.entryTs, entryPrice: openPosition.entryPrice, exitTs: s.ts, exitPrice: tpLevel, profitLoss: pnl, exitReason: 'tp' });
        openPosition = null;
        closedByTpSl = true;
      } else if (tpLevel != null && openPosition.direction === 'SELL' && exitOffer <= tpLevel) {
        const pnl = openPosition.entryPrice - tpLevel;
        trades.push({ direction: openPosition.direction, entryTs: openPosition.entryTs, entryPrice: openPosition.entryPrice, exitTs: s.ts, exitPrice: tpLevel, profitLoss: pnl, exitReason: 'tp' });
        openPosition = null;
        closedByTpSl = true;
      } else if (slLevel != null && openPosition.direction === 'BUY' && exitBid <= slLevel) {
        const pnl = slLevel - openPosition.entryPrice;
        trades.push({ direction: openPosition.direction, entryTs: openPosition.entryTs, entryPrice: openPosition.entryPrice, exitTs: s.ts, exitPrice: slLevel, profitLoss: pnl, exitReason: 'sl' });
        openPosition = null;
        closedByTpSl = true;
      } else if (slLevel != null && openPosition.direction === 'SELL' && exitOffer >= slLevel) {
        const pnl = openPosition.entryPrice - slLevel;
        trades.push({ direction: openPosition.direction, entryTs: openPosition.entryTs, entryPrice: openPosition.entryPrice, exitTs: s.ts, exitPrice: slLevel, profitLoss: pnl, exitReason: 'sl' });
        openPosition = null;
        closedByTpSl = true;
      }

      if (closedByTpSl) {
        prevRulesPass = false; // allow opening again on next pass
        prevBlocked = false;
        continue;
      }
    }

    // Close when rules stop passing – only if no TP/SL (with TP/SL we hold until TP or SL hits)
    const hasTpSl = !!(config.takeProfit || config.stopLoss);
    if (!hasTpSl && !pass && blocked && openPosition) {
      const exitPrice = openPosition.direction === 'BUY' ? s.bid : s.offer;
      const entryPrice = openPosition.entryPrice;
      const pnl = openPosition.direction === 'BUY'
        ? (s.bid - entryPrice)
        : (entryPrice - s.offer);
      trades.push({
        direction: openPosition.direction,
        entryTs: openPosition.entryTs,
        entryPrice,
        exitTs: s.ts,
        exitPrice,
        profitLoss: pnl,
        exitReason: 'rules',
      });
      openPosition = null;
    }

    // Open when rules start passing and we don't have a position
    if (pass && !blocked && !prevRulesPass) {
      openPosition = { direction, entryTs: s.ts, entryPrice: direction === 'BUY' ? s.offer : s.bid };
    }

    prevRulesPass = pass;
    prevBlocked = blocked;
  }

  // Always close at end of period (intraday day-end or carry-over block-end)
  if (openPosition && samples.length > 0) {
    const last = samples[samples.length - 1];
    const exitPrice = openPosition.direction === 'BUY' ? last.bid : last.offer;
    const pnl = openPosition.direction === 'BUY'
      ? (last.bid - openPosition.entryPrice)
      : (openPosition.entryPrice - last.offer);
    trades.push({
      direction: openPosition.direction,
      entryTs: openPosition.entryTs,
      entryPrice: openPosition.entryPrice,
      exitTs: last.ts,
      exitPrice,
      profitLoss: pnl,
      exitReason: 'endOfPeriod',
    });
    openPosition = null;
  }

  const totalGainLoss = trades.reduce((sum, t) => sum + t.profitLoss, 0);
  const openAtEnd = openPosition ? 1 : 0;

  const closeReasonCounts: CloseReasonCounts = {
    tp: trades.filter((t) => t.exitReason === 'tp').length,
    sl: trades.filter((t) => t.exitReason === 'sl').length,
    rules: trades.filter((t) => t.exitReason === 'rules').length,
    endOfPeriod: trades.filter((t) => t.exitReason === 'endOfPeriod').length,
  };
  const winningTrades = trades.filter((t) => t.profitLoss > 0).length;
  const losingTrades = trades.filter((t) => t.profitLoss < 0).length;

  const size = parseFloat(config.dealSize || '1') || 1;
  const contractSize = (config.contractSize != null && config.contractSize > 0) ? config.contractSize : 1;
  const denom = size * contractSize;
  const totalGainLossPounds = denom > 0 ? totalGainLoss * denom : undefined;
  const avgTradePnlPounds = (denom > 0 && trades.length > 0) ? (totalGainLoss / trades.length) * denom : undefined;

  const ruleBlockerCounts: Array<{ left: string; op: string; right: string; soleBlockerCount: number }> = [];
  for (let i = 0; i < enabledRules.length; i++) {
    const count = soleBlockerCounts.get(i) ?? 0;
    if (count > 0) {
      const r = enabledRules[i];
      ruleBlockerCounts.push({ left: r.left, op: r.op, right: r.right, soleBlockerCount: count });
    }
  }
  ruleBlockerCounts.sort((a, b) => b.soleBlockerCount - a.soleBlockerCount);

  return {
    trades,
    totalGainLoss,
    totalGainLossPounds,
    tradeCount: trades.length,
    winningTrades,
    losingTrades,
    winRate: trades.length > 0 ? (winningTrades / trades.length) * 100 : 0,
    avgTradePnl: trades.length > 0 ? totalGainLoss / trades.length : 0,
    avgTradePnlPounds,
    sampleCount: samples.length,
    startTs: samples.length > 0 ? samples[0].ts : 0,
    endTs: samples.length > 0 ? samples[samples.length - 1].ts : 0,
    openAtEnd,
    closeReasonCounts,
    ruleBlockerCounts: ruleBlockerCounts.length > 0 ? ruleBlockerCounts : undefined,
  };
}
