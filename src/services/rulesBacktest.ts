/**
 * Backtest rules against recorded price samples.
 * Ports rules evaluation logic from tradingRules.js for server-side analysis.
 */

import type { RecordedSample } from './priceRecorder';
import type { DynamicStopLossSettings } from './dynamicStopLoss';
import {
  advanceTrailingStopSim,
  createTrailingStopSimState,
  isTrailingStopHit,
  type TrailingStopSimState,
} from './dynamicStopLoss';

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

export interface RuleSetConfig {
  direction: 'BUY' | 'SELL';
  rules: Rule[];
  takeProfit?: string | null;
  stopLoss?: string | null;
  tpSlMode?: 'value' | 'rate' | 'pct';
  dealSize?: string;
}

export interface BacktestConfig {
  /** Legacy: single rule set. When ruleSets is provided, this is ignored. */
  rules?: Rule[];
  /** Per-direction rule sets. Evaluation order: BUY first, then SELL. When provided, backtestRuleSets filters which to use. */
  ruleSets?: RuleSetConfig[];
  /** Which rule sets to include in backtest. Order: BUY first, then SELL. Default ['BUY','SELL'] when ruleSets provided. */
  backtestRuleSets?: ('BUY' | 'SELL')[];
  probeShortMinutes: number;
  probeMediumMinutes: number;
  probeLongMinutes: number;
  is24_7: boolean;
  /** Take profit: raw value. Interpretation depends on tpSlMode. (Legacy / fallback when no rule set TP/SL) */
  takeProfit?: string | null;
  /** Stop loss: raw value. Interpretation depends on tpSlMode. (Legacy / fallback) */
  stopLoss?: string | null;
  /** 'rate' = price levels, 'pct' = % from entry, 'value' = £ gain/loss. */
  tpSlMode?: 'value' | 'rate' | 'pct';
  dealSize?: string;
  contractSize?: number;
  /** Simulated trailing stop for BUY rules (no TP; optional initial SL from rule set). */
  dynamicStopLossBuy?: DynamicStopLossSettings | null;
  /** Simulated trailing stop for SELL rules. */
  dynamicStopLossSell?: DynamicStopLossSettings | null;
  /**
   * When set (non-24/7 markets from IG marketTimes), opens/closes/TP-SL only while dealing is open.
   * Slots use minutes since midnight in Europe/London (IG’s openTime/closeTime), 7 entries Sun=0 … Sat=6; null = closed that day.
   * Omitted/null = no dealing-hours gate.
   */
  dealingWeekLondon?: DealingWeekLondon | null;
  /** When true, a losing BUY close stops further BUY opens until the next backtest day/block. */
  stopAfterLossBuy?: boolean;
  /** When true, a losing SELL close stops further SELL opens until the next backtest day/block. */
  stopAfterLossSell?: boolean;
  /** Auto-stop BUY engine N minutes before session close (or UTC midnight when is24_7). Default true. */
  autoStopEnabledBuy?: boolean;
  autoStopEnabledSell?: boolean;
  autoStopBeforeMinutesBuy?: number;
  autoStopBeforeMinutesSell?: number;
  /** Seconds to pause all new opens after a losing close (BUY panel). 0 = disabled. */
  pauseOnLossSecondsBuy?: number;
  /** Seconds to pause all new opens after a losing close (SELL panel). Live uses max(buy, sell). */
  pauseOnLossSecondsSell?: number;
}

/** Minutes since London local midnight (IG openTime/closeTime). */
export interface DealingDaySlotLondon {
  openMin: number;
  closeMin: number;
}

/** Sunday=0 … Saturday=6 in Europe/London. */
export type DealingWeekLondon = (DealingDaySlotLondon | null)[];

/**
 * When IG does not return parsable marketTimes but the instrument is not 24/7, use typical UK cash-index
 * hours (Mon–Fri 08:00–21:59 London, Sat/Sun closed). Safer than allowing all times.
 */
export function defaultDealingWeekLondonMonFri(): DealingWeekLondon {
  const slot: DealingDaySlotLondon = { openMin: 8 * 60, closeMin: 21 * 60 + 59 };
  return [null, slot, slot, slot, slot, slot, null];
}

const LONDON_WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const londonWeekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', weekday: 'short' });
const londonHmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });

function londonWeekdayIndexSun0(ts: number): number {
  const part = londonWeekdayFmt.formatToParts(new Date(ts)).find((p) => p.type === 'weekday')?.value;
  return LONDON_WD[part ?? ''] ?? 0;
}

function londonMinutesSinceMidnight(ts: number): number {
  const parts = londonHmFmt.formatToParts(new Date(ts));
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
}

/** Parse IG openTime/closeTime (e.g. "22:02", "1970-01-01T21:59:00") to minutes since midnight. */
export function parseIgTimeToMinutes(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const iso = s.match(/T(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (iso) {
    const h = parseInt(iso[1], 10);
    const min = parseInt(iso[2], 10);
    if (!isNaN(h) && h >= 0 && h <= 23 && !isNaN(min) && min >= 0 && min <= 59) return h * 60 + min;
  }
  const parts = s.split(/[:\s]+/).filter(Boolean);
  const h = parseInt(parts[0] ?? '', 10);
  const min = parseInt(parts[1] ?? '0', 10);
  if (isNaN(h) || h < 0 || h > 23) return null;
  const mm = isNaN(min) || min < 0 || min > 59 ? 0 : min;
  return h * 60 + mm;
}

function normalizeMarketTimesToSevenSlots(
  marketTimes: Array<{ openTime?: string; closeTime?: string }>
): (typeof marketTimes[0] | null)[] {
  const out: (typeof marketTimes[0] | null)[] = [null, null, null, null, null, null, null];
  if (marketTimes.length === 7) {
    // IG lists Monday first; layout here is Sunday=0 … Saturday=6.
    for (let i = 0; i < 7; i++) out[(i + 1) % 7] = marketTimes[i] ?? null;
    return out;
  }
  if (marketTimes.length === 5) {
    for (let i = 0; i < 5; i++) out[i + 1] = marketTimes[i] ?? null;
    return out;
  }
  for (let i = 0; i < Math.min(marketTimes.length, 7); i++) out[i] = marketTimes[i] ?? null;
  return out;
}

function slotFromMarketTimeRow(row: { openTime?: string; closeTime?: string } | null): DealingDaySlotLondon | null {
  if (!row) return null;
  const openMin = parseIgTimeToMinutes(row.openTime);
  const closeMin = parseIgTimeToMinutes(row.closeTime);
  if (openMin == null || closeMin == null) return null;
  return { openMin, closeMin };
}

/**
 * Build weekly dealing slots from IG marketTimes (Europe/London wall times, same as computeDefaultCloseAt in ig.ts).
 * Returns null when 24/7 or no usable schedule (caller treats as no gate).
 */
export function dealingWeekFromMarketTimes(
  marketTimes: Array<{ openTime?: string; closeTime?: string }> | undefined | null,
  is24_7: boolean
): DealingWeekLondon | null {
  if (is24_7) return null;
  if (!marketTimes || marketTimes.length === 0) return null;
  const normalized = normalizeMarketTimesToSevenSlots(marketTimes);
  const week: DealingWeekLondon = [];
  for (let i = 0; i < 7; i++) {
    week.push(slotFromMarketTimeRow(normalized[i] ?? null));
  }
  const anyOpen = week.some((s) => s != null);
  return anyOpen ? week : null;
}

function resolveAutoStopBeforeMinutes(config: BacktestConfig): number | null {
  const buyOn = config.autoStopEnabledBuy !== false;
  const sellOn = config.autoStopEnabledSell !== false;
  if (!buyOn && !sellOn) return null;
  const buyMins = config.autoStopBeforeMinutesBuy ?? 60;
  const sellMins = config.autoStopBeforeMinutesSell ?? 60;
  if (buyOn && sellOn) return Math.min(buyMins, sellMins);
  return buyOn ? buyMins : sellMins;
}

/** Close minute (London) for the dealing session containing ts, or null if flat/unknown. */
function dealingSessionCloseMinLondon(ts: number, week: DealingWeekLondon): number | null {
  const wd = londonWeekdayIndexSun0(ts);
  const min = londonMinutesSinceMidnight(ts);
  const prevWd = (wd + 6) % 7;
  const prev = week[prevWd];
  if (prev && prev.openMin > prev.closeMin && wd === (prevWd + 1) % 7 && min <= prev.closeMin) {
    return prev.closeMin;
  }
  const today = week[wd];
  if (!today) return null;
  const { openMin, closeMin } = today;
  if (openMin < closeMin) {
    if (min >= openMin && min <= closeMin) return closeMin;
    return null;
  }
  if (min >= openMin || min <= closeMin) return closeMin;
  return null;
}

/** True when live auto-stop would block new entries at ts (last N minutes before close / UTC midnight). */
export function isAutoStopBlockingOpens(ts: number, config: BacktestConfig): boolean {
  const beforeMinutes = resolveAutoStopBeforeMinutes(config);
  if (beforeMinutes == null) return false;
  if (config.is24_7) {
    const d = new Date(ts);
    const nextMidnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
    return ts >= nextMidnightUtc - beforeMinutes * 60 * 1000;
  }
  const week = config.dealingWeekLondon;
  if (!week || week.length !== 7) return false;
  const closeMin = dealingSessionCloseMinLondon(ts, week);
  if (closeMin == null) return false;
  const min = londonMinutesSinceMidnight(ts);
  return min >= closeMin - beforeMinutes;
}

/** True if IG-style dealing is open at ts (London calendar day + overnight sessions). */
export function isDealingOpenLondon(ts: number, week: DealingWeekLondon | null | undefined): boolean {
  if (!week || week.length !== 7) return true;
  const wd = londonWeekdayIndexSun0(ts);
  const min = londonMinutesSinceMidnight(ts);
  const prevWd = (wd + 6) % 7;
  const prev = week[prevWd];
  // Overnight from prevWd ends on the *next* calendar day only (wd === prevWd+1 mod 7)
  if (prev && prev.openMin > prev.closeMin && wd === (prevWd + 1) % 7 && min <= prev.closeMin) return true;
  const today = week[wd];
  if (!today) return false;
  const { openMin, closeMin } = today;
  if (openMin < closeMin) return min >= openMin && min <= closeMin;
  return min >= openMin || min <= closeMin;
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

/** Human-readable operand for analysis reports (paired with configured left/op/right). */
function formatEvalValue(v: number | string | null | undefined): string {
  if (v == null) return '—';
  if (typeof v === 'number') {
    if (isNaN(v) || !isFinite(v)) return '—';
    if (Number.isInteger(v)) return String(v);
    const abs = Math.abs(v);
    const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
    let s = v.toFixed(decimals);
    s = s.replace(/\.?0+$/, '');
    return s;
  }
  return String(v);
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
  const rules = config.rules || [];
  const enabledRules = rules.filter((r) => r.enabled !== false);
  if (enabledRules.length === 0) return false;
  for (const rule of enabledRules) {
    if (!evaluateRule(rule, ctx)) return false;
  }
  return true;
}

/** Returns indices of rules that failed. */
function getFailingRuleIndices(ctx: Context, config: BacktestConfig): number[] {
  const rules = config.rules || [];
  const enabledRules = rules.filter((r) => r.enabled !== false);
  const failing: number[] = [];
  for (let i = 0; i < enabledRules.length; i++) {
    if (!evaluateRule(enabledRules[i], ctx)) failing.push(i);
  }
  return failing;
}

function inferDirection(config: BacktestConfig): 'BUY' | 'SELL' {
  const rules = config.rules || [];
  const enabled = rules.filter((r) => r.enabled !== false);
  for (const r of enabled) {
    if (r.left === 'Buy') return 'BUY';
    if (r.left === 'Sell') return 'SELL';
  }
  return 'BUY';
}

/** Build config-like object for getTpSlLevels from a rule set or legacy config. */
function getTpSlConfig(
  positionRuleSet: RuleSetConfig | null,
  fallbackConfig: BacktestConfig
): { takeProfit?: string | null; stopLoss?: string | null; tpSlMode?: 'value' | 'rate' | 'pct'; dealSize?: string } {
  if (positionRuleSet) {
    return {
      takeProfit: positionRuleSet.takeProfit ?? fallbackConfig.takeProfit,
      stopLoss: positionRuleSet.stopLoss ?? fallbackConfig.stopLoss,
      tpSlMode: (positionRuleSet.tpSlMode || fallbackConfig.tpSlMode) as 'value' | 'rate' | 'pct',
      dealSize: positionRuleSet.dealSize ?? fallbackConfig.dealSize,
    };
  }
  return {
    takeProfit: fallbackConfig.takeProfit,
    stopLoss: fallbackConfig.stopLoss,
    tpSlMode: (fallbackConfig.tpSlMode || undefined) as 'value' | 'rate' | 'pct' | undefined,
    dealSize: fallbackConfig.dealSize,
  };
}

function getTpSlLevels(
  entry: number,
  direction: 'BUY' | 'SELL',
  config: BacktestConfig
): { tpLevel: number | null; slLevel: number | null } {
  const mode = (config.tpSlMode || 'rate') as 'value' | 'rate' | 'pct';
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

function getDynamicSlSettings(
  config: BacktestConfig,
  direction: 'BUY' | 'SELL'
): DynamicStopLossSettings | null {
  return direction === 'BUY' ? config.dynamicStopLossBuy ?? null : config.dynamicStopLossSell ?? null;
}

export function buildDynamicSlReportMeta(config: BacktestConfig): {
  dynamicStopLossApplied: boolean;
  dynamicStopLossNote?: string;
} {
  const parts: string[] = [];
  if (config.dynamicStopLossBuy) parts.push('BUY');
  if (config.dynamicStopLossSell) parts.push('SELL');
  if (parts.length === 0) return { dynamicStopLossApplied: false };
  return {
    dynamicStopLossApplied: true,
    dynamicStopLossNote:
      parts.join(' + ') + ' — simulated trailing stop (1s samples; may differ from live IG)',
  };
}

export type ExitReason = 'tp' | 'sl' | 'dsl' | 'rules' | 'endOfPeriod';

/** One rule row as configured when the trade opened (AND with others in the set). */
export interface BacktestTradeRuleLine {
  left: string;
  op: string;
  right: string;
  /** Formatted left operand at entry (same sample as rule evaluation). */
  leftAtEntry?: string;
  /** Formatted right operand at entry. */
  rightAtEntry?: string;
}

export interface BacktestTrade {
  direction: 'BUY' | 'SELL';
  entryTs: number;
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  profitLoss: number;
  exitReason?: ExitReason;
  /** Rules that had to pass for this entry (snapshot at open). Omitted when empty/legacy edge cases. */
  entryRules?: BacktestTradeRuleLine[];
}

export interface CloseReasonCounts {
  tp: number;
  sl: number;
  dsl: number;
  rules: number;
  endOfPeriod: number;
}

export interface BacktestDaySummary {
  day: string;
  sampleCount: number;
  tradeCount: number;
  totalGainLoss: number;
  totalGainLossPounds?: number;
  /** Present when the day was in the selection but had no recorded samples. */
  status?: 'noSamples';
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
  /** Per-rule sole blocker counts: times that rule was the only one failing when no deal opened (flat, no position). */
  ruleBlockerCounts?: RuleBlockerCountRow[];
  /** True when backtest simulated dynamic stop loss for at least one direction. */
  dynamicStopLossApplied?: boolean;
  /** Human-readable note for the simulation report. */
  dynamicStopLossNote?: string;
  /** One row per calendar day included in this analysis run. */
  analysedDays?: BacktestDaySummary[];
}

/** One row in the sole-blocker report (legacy rules or a BUY/SELL rule set). */
export type RuleBlockerCountRow = {
  left: string;
  op: string;
  right: string;
  soleBlockerCount: number;
  /** Present when using per-direction rule sets. */
  direction?: 'BUY' | 'SELL';
};

const BLOCKER_AGG_SEP = '\u0001';

function blockerRowKey(row: Pick<RuleBlockerCountRow, 'left' | 'op' | 'right'> & { direction?: 'BUY' | 'SELL' }): string {
  return row.direction
    ? `${row.direction}${BLOCKER_AGG_SEP}${row.left}${BLOCKER_AGG_SEP}${row.op}${BLOCKER_AGG_SEP}${row.right}`
    : `legacy${BLOCKER_AGG_SEP}${row.left}${BLOCKER_AGG_SEP}${row.op}${BLOCKER_AGG_SEP}${row.right}`;
}

function parseBlockerAggregateKey(key: string): Omit<RuleBlockerCountRow, 'soleBlockerCount'> | null {
  const parts = key.split(BLOCKER_AGG_SEP);
  if (parts.length !== 4) return null;
  const [tag, left, op, right] = parts;
  if (tag === 'legacy') return { left, op, right };
  if (tag === 'BUY' || tag === 'SELL') return { left, op, right, direction: tag };
  return null;
}

function mergeBlockerAggregateMap(blockerAggregate: Map<string, number>): RuleBlockerCountRow[] {
  const out: RuleBlockerCountRow[] = [];
  for (const [key, count] of blockerAggregate.entries()) {
    if (count <= 0) continue;
    const parsed = parseBlockerAggregateKey(key);
    if (!parsed) continue;
    out.push({ ...parsed, soleBlockerCount: count });
  }
  out.sort((a, b) => b.soleBlockerCount - a.soleBlockerCount);
  return out;
}

function getDayKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Calendar day key (local) for a sample/trade timestamp. */
export function dayKeyFromTimestamp(ts: number): string {
  return getDayKey(ts);
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
          const k = blockerRowKey(b);
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

  const ruleBlockerCounts = mergeBlockerAggregateMap(blockerAggregate);

  const closeReasonCounts: CloseReasonCounts = {
    tp: allTrades.filter((t) => t.exitReason === 'tp').length,
    sl: allTrades.filter((t) => t.exitReason === 'sl').length,
    dsl: allTrades.filter((t) => t.exitReason === 'dsl').length,
    rules: allTrades.filter((t) => t.exitReason === 'rules').length,
    endOfPeriod: allTrades.filter((t) => t.exitReason === 'endOfPeriod').length,
  };
  const dslMeta = buildDynamicSlReportMeta(config);

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
    ...dslMeta,
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
        const k = blockerRowKey(b);
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

  const ruleBlockerCounts = mergeBlockerAggregateMap(blockerAggregate);

  const closeReasonCounts: CloseReasonCounts = {
    tp: allTrades.filter((t) => t.exitReason === 'tp').length,
    sl: allTrades.filter((t) => t.exitReason === 'sl').length,
    dsl: allTrades.filter((t) => t.exitReason === 'dsl').length,
    rules: allTrades.filter((t) => t.exitReason === 'rules').length,
    endOfPeriod: allTrades.filter((t) => t.exitReason === 'endOfPeriod').length,
  };
  const dslMeta = buildDynamicSlReportMeta(config);

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
    ...dslMeta,
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
      const ruleBlockerCounts = mergeBlockerAggregateMap(blockerAggregate);
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
            const k = blockerRowKey(b);
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
  type Position = {
    direction: 'BUY' | 'SELL';
    entryTs: number;
    entryPrice: number;
    ruleSet: RuleSetConfig | null;
    entryRulesSnapshot: BacktestTradeRuleLine[];
    trailing: TrailingStopSimState | null;
  };
  let openPosition: Position | null = null;
  let buyStoppedAfterLoss = false;
  let sellStoppedAfterLoss = false;
  let autoStopped = false;
  let pausedUntilTs: number | null = null;

  function isEnginePaused(ts: number): boolean {
    return pausedUntilTs != null && ts < pausedUntilTs;
  }

  function isDirectionActive(direction: 'BUY' | 'SELL', ts: number): boolean {
    if (autoStopped || isEnginePaused(ts)) return false;
    if (direction === 'BUY' && buyStoppedAfterLoss) return false;
    if (direction === 'SELL' && sellStoppedAfterLoss) return false;
    return true;
  }

  function onTradeClosed(trade: BacktestTrade): void {
    if (trade.profitLoss >= 0) return;
    const direction = trade.direction;
    const stopAfterLoss =
      (direction === 'BUY' && config.stopAfterLossBuy) ||
      (direction === 'SELL' && config.stopAfterLossSell);
    if (direction === 'BUY' && config.stopAfterLossBuy) buyStoppedAfterLoss = true;
    if (direction === 'SELL' && config.stopAfterLossSell) sellStoppedAfterLoss = true;
    if (stopAfterLoss) return;
    const buySec = config.pauseOnLossSecondsBuy ?? 0;
    const sellSec = config.pauseOnLossSecondsSell ?? 0;
    const seconds = Math.max(buySec, sellSec);
    if (seconds <= 0) return;
    pausedUntilTs = trade.exitTs + seconds * 1000;
  }

  function recordTrade(trade: BacktestTrade): void {
    trades.push(trade);
    onTradeClosed(trade);
  }

  function snapshotEntryRules(triggeredRuleSet: RuleSetConfig | null, ctx: Context): BacktestTradeRuleLine[] {
    const snap = (r: Rule): BacktestTradeRuleLine => ({
      left: r.left,
      op: r.op,
      right: r.right,
      leftAtEntry: formatEvalValue(getLeftValue(r, ctx)),
      rightAtEntry: formatEvalValue(getRightValue(r, ctx)),
    });
    if (useRuleSets && triggeredRuleSet) {
      return triggeredRuleSet.rules.filter((r) => r.enabled !== false).map(snap);
    }
    return enabledLegacyRules.map(snap);
  }
  let prevRulesPass = false;
  let prevBlocked = false;
  let prevCanOpen = false;
  let prevMid: number | null = null;
  const dayStart = samples.length > 0 ? samples[0].offer : null;

  const useRuleSets = config.ruleSets && config.ruleSets.length > 0 && config.backtestRuleSets && config.backtestRuleSets.length > 0;
  const activeRuleSets: RuleSetConfig[] = useRuleSets
    ? (config.ruleSets!.filter((rs) => config.backtestRuleSets!.includes(rs.direction)) as RuleSetConfig[])
    : [];
  const legacyRules = config.rules || [];
  const legacyDirection = inferDirection(config);
  const enabledLegacyRules = legacyRules.filter((r) => r.enabled !== false);
  const soleBlockerCounts = new Map<string, number>();

  const totalSamples = samples.length;

  for (let i = 0; i < samples.length; i++) {
    if (onProgress && (i + 1) % PROGRESS_SAMPLE_INTERVAL === 0) {
      onProgress(i + 1, totalSamples);
    }
    const s = samples[i];
    if (!autoStopped && isAutoStopBlockingOpens(s.ts, config)) {
      autoStopped = true;
    }
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

    let rulesPass: boolean;
    let triggeredRuleSet: RuleSetConfig | null = null;
    if (useRuleSets && activeRuleSets.length > 0) {
      rulesPass = false;
      for (const rs of activeRuleSets) {
        if (!isDirectionActive(rs.direction, s.ts)) continue;
        if (evaluateRules(ctx, { ...config, rules: rs.rules })) {
          rulesPass = true;
          triggeredRuleSet = rs;
          break;
        }
      }
    } else {
      rulesPass = isDirectionActive(legacyDirection, s.ts) && evaluateRules(ctx, { ...config, rules: legacyRules });
      if (rulesPass) triggeredRuleSet = null;
    }
    const blocked = openPosition !== null;
    const pass = rulesPass;
    const dealingOpen = isDealingOpenLondon(s.ts, config.dealingWeekLondon ?? null);
    const canOpenHere = pass && dealingOpen && !autoStopped && !isEnginePaused(s.ts);

    // Sole blockers: flat, no deal would open; exactly one rule fails (per legacy list or per BUY/SELL set).
    if (!blocked && !pass) {
      if (!useRuleSets && enabledLegacyRules.length > 0) {
        const failing = getFailingRuleIndices(ctx, { ...config, rules: legacyRules });
        if (failing.length === 1) {
          const r = enabledLegacyRules[failing[0]];
          const key = blockerRowKey({ left: r.left, op: r.op, right: r.right });
          soleBlockerCounts.set(key, (soleBlockerCounts.get(key) ?? 0) + 1);
        }
      } else if (useRuleSets && activeRuleSets.length > 0) {
        for (const rs of activeRuleSets) {
          const enabledRs = rs.rules.filter((rule) => rule.enabled !== false);
          if (enabledRs.length === 0) continue;
          const failing = getFailingRuleIndices(ctx, { ...config, rules: rs.rules });
          if (failing.length === 1) {
            const r = enabledRs[failing[0]];
            const key = blockerRowKey({ left: r.left, op: r.op, right: r.right, direction: rs.direction });
            soleBlockerCounts.set(key, (soleBlockerCounts.get(key) ?? 0) + 1);
          }
        }
      }
    }

    // Check TP/SL whenever we have a position (before rules-fail close). Use bid/offer on every sample — not gated by
    // dealing hours: otherwise after-hours ticks (e.g. last stamp 23:59) never evaluate TP/SL and EOD shows uncapped P/L.
    // Opens and rule-based exits still respect dealingOpen below.
    if (blocked && openPosition) {
      const dslSettings = getDynamicSlSettings(config, openPosition.direction);
      const tpSlCfg = { ...config, ...getTpSlConfig(openPosition.ruleSet, config) };
      if (dslSettings) tpSlCfg.takeProfit = null;
      const { tpLevel, slLevel } = getTpSlLevels(openPosition.entryPrice, openPosition.direction, tpSlCfg);
      const exitBid = s.bid;
      const exitOffer = s.offer;
      let closedByTpSl = false;

      const er = openPosition.entryRulesSnapshot.length > 0 ? openPosition.entryRulesSnapshot : undefined;

      if (dslSettings && openPosition.trailing) {
        advanceTrailingStopSim(openPosition.trailing, exitBid, exitOffer);
        const stop = openPosition.trailing.lastStopLevel;
        if (stop != null && isTrailingStopHit(openPosition.direction, stop, exitBid, exitOffer)) {
          const pnl =
            openPosition.direction === 'BUY'
              ? stop - openPosition.entryPrice
              : openPosition.entryPrice - stop;
          recordTrade({
            direction: openPosition.direction,
            entryTs: openPosition.entryTs,
            entryPrice: openPosition.entryPrice,
            exitTs: s.ts,
            exitPrice: stop,
            profitLoss: pnl,
            exitReason: openPosition.trailing.triggerReached ? 'dsl' : 'sl',
            entryRules: er,
          });
          openPosition = null;
          closedByTpSl = true;
        }
      } else if (tpLevel != null && openPosition.direction === 'BUY' && exitBid >= tpLevel) {
        const pnl = tpLevel - openPosition.entryPrice;
        recordTrade({
          direction: openPosition.direction,
          entryTs: openPosition.entryTs,
          entryPrice: openPosition.entryPrice,
          exitTs: s.ts,
          exitPrice: tpLevel,
          profitLoss: pnl,
          exitReason: 'tp',
          entryRules: er,
        });
        openPosition = null;
        closedByTpSl = true;
      } else if (tpLevel != null && openPosition.direction === 'SELL' && exitOffer <= tpLevel) {
        const pnl = openPosition.entryPrice - tpLevel;
        recordTrade({
          direction: openPosition.direction,
          entryTs: openPosition.entryTs,
          entryPrice: openPosition.entryPrice,
          exitTs: s.ts,
          exitPrice: tpLevel,
          profitLoss: pnl,
          exitReason: 'tp',
          entryRules: er,
        });
        openPosition = null;
        closedByTpSl = true;
      } else if (slLevel != null && openPosition.direction === 'BUY' && exitBid <= slLevel) {
        const pnl = slLevel - openPosition.entryPrice;
        recordTrade({
          direction: openPosition.direction,
          entryTs: openPosition.entryTs,
          entryPrice: openPosition.entryPrice,
          exitTs: s.ts,
          exitPrice: slLevel,
          profitLoss: pnl,
          exitReason: 'sl',
          entryRules: er,
        });
        openPosition = null;
        closedByTpSl = true;
      } else if (slLevel != null && openPosition.direction === 'SELL' && exitOffer >= slLevel) {
        const pnl = openPosition.entryPrice - slLevel;
        recordTrade({
          direction: openPosition.direction,
          entryTs: openPosition.entryTs,
          entryPrice: openPosition.entryPrice,
          exitTs: s.ts,
          exitPrice: slLevel,
          profitLoss: pnl,
          exitReason: 'sl',
          entryRules: er,
        });
        openPosition = null;
        closedByTpSl = true;
      }

      if (closedByTpSl) {
        prevRulesPass = false; // allow opening again on next pass
        prevBlocked = false;
        prevCanOpen = false;
        continue;
      }
    }

    // Close when rules stop passing – only if no TP/SL/dynamic SL; only while dealing is open.
    const tpSlMerged = openPosition ? getTpSlConfig(openPosition.ruleSet, config) : config;
    const dslForHold = openPosition ? getDynamicSlSettings(config, openPosition.direction) : null;
    const hasTpSl =
      !!dslForHold ||
      !!(tpSlMerged.takeProfit || tpSlMerged.stopLoss);
    if (!hasTpSl && !pass && blocked && openPosition && dealingOpen) {
      const exitPrice = openPosition.direction === 'BUY' ? s.bid : s.offer;
      const entryPrice = openPosition.entryPrice;
      const pnl = openPosition.direction === 'BUY'
        ? (s.bid - entryPrice)
        : (entryPrice - s.offer);
      recordTrade({
        direction: openPosition.direction,
        entryTs: openPosition.entryTs,
        entryPrice,
        exitTs: s.ts,
        exitPrice,
        profitLoss: pnl,
        exitReason: 'rules',
        entryRules: openPosition.entryRulesSnapshot.length > 0 ? openPosition.entryRulesSnapshot : undefined,
      });
      openPosition = null;
    }

    // Open when rules + dealing session allow (rising edge); closes still use pass / TP/SL above
    if (canOpenHere && !blocked && !prevCanOpen) {
      const direction = triggeredRuleSet ? triggeredRuleSet.direction : legacyDirection;
      const entryPrice = direction === 'BUY' ? s.offer : s.bid;
      const dslSettings = getDynamicSlSettings(config, direction);
      let trailing: TrailingStopSimState | null = null;
      if (dslSettings) {
        const tpSlOpen = { ...config, ...getTpSlConfig(triggeredRuleSet, config), takeProfit: null };
        const size = parseFloat(tpSlOpen.dealSize || config.dealSize || '1') || 1;
        const contractSize = (config.contractSize != null && config.contractSize > 0) ? config.contractSize : 1;
        const { slLevel } = getTpSlLevels(entryPrice, direction, tpSlOpen);
        trailing = createTrailingStopSimState(
          direction,
          entryPrice,
          size,
          contractSize,
          dslSettings,
          slLevel
        );
      }
      openPosition = {
        direction,
        entryTs: s.ts,
        entryPrice,
        ruleSet: triggeredRuleSet,
        entryRulesSnapshot: snapshotEntryRules(triggeredRuleSet, ctx),
        trailing,
      };
    }

    prevRulesPass = pass;
    prevBlocked = blocked;
    prevCanOpen = canOpenHere;
  }

  // Always close at end of period (intraday day-end or carry-over block-end)
  if (openPosition && samples.length > 0) {
    const last = samples[samples.length - 1];
    const exitPrice = openPosition.direction === 'BUY' ? last.bid : last.offer;
    const pnl = openPosition.direction === 'BUY'
      ? (last.bid - openPosition.entryPrice)
      : (openPosition.entryPrice - last.offer);
    recordTrade({
      direction: openPosition.direction,
      entryTs: openPosition.entryTs,
      entryPrice: openPosition.entryPrice,
      exitTs: last.ts,
      exitPrice,
      profitLoss: pnl,
      exitReason: 'endOfPeriod',
      entryRules: openPosition.entryRulesSnapshot.length > 0 ? openPosition.entryRulesSnapshot : undefined,
    });
    openPosition = null;
  }

  const totalGainLoss = trades.reduce((sum, t) => sum + t.profitLoss, 0);
  const openAtEnd = openPosition ? 1 : 0;

  const closeReasonCounts: CloseReasonCounts = {
    tp: trades.filter((t) => t.exitReason === 'tp').length,
    sl: trades.filter((t) => t.exitReason === 'sl').length,
    dsl: trades.filter((t) => t.exitReason === 'dsl').length,
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

  const ruleBlockerCounts: RuleBlockerCountRow[] = [];
  for (const [key, count] of soleBlockerCounts.entries()) {
    if (count <= 0) continue;
    const parsed = parseBlockerAggregateKey(key);
    if (!parsed) continue;
    ruleBlockerCounts.push({ ...parsed, soleBlockerCount: count });
  }
  ruleBlockerCounts.sort((a, b) => b.soleBlockerCount - a.soleBlockerCount);
  const dslMeta = buildDynamicSlReportMeta(config);

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
    ...dslMeta,
  };
}
