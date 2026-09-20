/**
 * Backtest rules against recorded price samples.
 * Ports rules evaluation logic from tradingRules.js for server-side analysis.
 */

import type { RecordedSample } from './priceRecorder';
import type { DynamicStopLossSettings } from './dynamicStopLoss';
import {
  type DealingDaySlotLondon,
  type DealingWeekLondon,
  DealingOpenLookup,
  defaultDealingWeekLondonMonFri,
  dealingWeekFromMarketTimes,
  isDealingOpenLondon,
  londonMinutesSinceMidnight,
  londonWeekdayIndexSun0,
  parseIgTimeToMinutes,
} from './dealingSchedule';
import {
  analyzeProbeCoverage,
  precomputeProbeEligibleFlags,
  type ProbeSampleFilterOpts,
} from './probeSamples';

export type { DealingDaySlotLondon, DealingWeekLondon };
export {
  defaultDealingWeekLondonMonFri,
  dealingWeekFromMarketTimes,
  isDealingOpenLondon,
  parseIgTimeToMinutes,
};
import {
  advanceTrailingStopSim,
  createTrailingStopSimState,
  isTrailingStopHit,
  type TrailingStopSimState,
} from './dynamicStopLoss';

const RIGHT_REF_KEYS = [
  'short.min', 'short.avg', 'short.max', 'short.range', 'short.trendPct', 'short.volume', 'short.period_start',
  'medium.min', 'medium.avg', 'medium.max', 'medium.range', 'medium.trendPct', 'medium.volume', 'medium.period_start',
  'long.min', 'long.avg', 'long.max', 'long.range', 'long.trendPct', 'long.volume', 'long.period_start',
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
  /** Halt for the rest of the close day after this many consecutive losing closes. 0 = disabled, 1 = first loss. */
  stopAfterConsecutiveLosses?: number;
  /** HH:MM — schedule window for new opens (see scheduleTimezone). Blank = no limit. */
  scheduleStartTime?: string;
  scheduleStopTime?: string;
  /** HH:MM (local) — flatten rules positions at this clock time during backtest. */
  forcedCloseTime?: string;
  scheduleRepeatDaily?: boolean;
  scheduleActiveDate?: string;
  scheduleTimezone?: string;
  /** Seconds to pause all new opens after a losing close. 0 = disabled. */
  pauseOnLossSecondsBuy?: number;
  pauseOnLossSecondsSell?: number;
  /** IG daily open mid by Europe/London YYYY-MM-DD (from pre-fetch). Falls back to first sample mid per London day. */
  dayStartByLondonDate?: Record<string, number>;
}

function parseScheduleTimeHHMM(s: string | undefined | null): number | null {
  if (!s || !s.trim()) return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesInTimezone(ts: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(new Date(ts));
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const min = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return h * 60 + min;
}

function dateKeyInTimezone(ts: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(ts));
}

/** True when schedule window blocks new entries at ts. Blank start/stop = never blocks. */
export function isScheduleBlockingOpens(ts: number, config: BacktestConfig): boolean {
  const startMin = parseScheduleTimeHHMM(config.scheduleStartTime);
  const stopMin = parseScheduleTimeHHMM(config.scheduleStopTime);
  if (startMin == null && stopMin == null) return false;
  const tz = config.scheduleTimezone || 'Europe/London';
  if (config.scheduleRepeatDaily === false && config.scheduleActiveDate) {
    if (dateKeyInTimezone(ts, tz) !== config.scheduleActiveDate) return false;
  }
  const nowMin = minutesInTimezone(ts, tz);
  let active: boolean;
  if (startMin != null && stopMin != null) {
    if (startMin <= stopMin) active = nowMin >= startMin && nowMin < stopMin;
    else active = nowMin >= startMin || nowMin < stopMin;
  } else if (startMin != null) active = nowMin >= startMin;
  else active = nowMin < stopMin!;
  return !active;
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

/** @deprecated Use isScheduleBlockingOpens */
export function isAutoStopBlockingOpens(ts: number, config: BacktestConfig): boolean {
  return isScheduleBlockingOpens(ts, config);
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
  periodStartBuy: number | null;
  periodStartSell: number | null;
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

function computeStats(samples: { mid: number; spread: number }[]): Omit<ProbeStats, 'trendDir' | 'trendPct' | 'periodStartBuy' | 'periodStartSell'> {
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

/** Bid/offer at the oldest eligible sample in the probe window. */
function computePeriodStart(samples: { mid: number; spread: number }[]): Pick<ProbeStats, 'periodStartBuy' | 'periodStartSell'> {
  if (!samples || samples.length === 0) {
    return { periodStartBuy: null, periodStartSell: null };
  }
  const first = samples[0];
  const spread = first.spread || 0;
  return {
    periodStartBuy: first.mid + spread / 2,
    periodStartSell: first.mid - spread / 2,
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

function probeFilterOpts(config: BacktestConfig): ProbeSampleFilterOpts {
  return { is24_7: config.is24_7, dealingWeekLondon: config.dealingWeekLondon };
}

type BacktestPriceSample = {
  ts: number;
  mid: number;
  spread: number;
  probeEligible: boolean;
  marketState?: string | null;
};

type ProbeWindowEntry = { mid: number; spread: number; ts: number };

/** Incremental short/medium/long probe windows — O(1) per tick instead of rescanning history. */
class ProbeWindowTracker {
  private readonly shortMs: number;
  private readonly mediumMs: number;
  private readonly longMs: number;
  private readonly short: ProbeWindowEntry[] = [];
  private readonly medium: ProbeWindowEntry[] = [];
  private readonly long: ProbeWindowEntry[] = [];

  constructor(config: BacktestConfig) {
    this.shortMs = config.probeShortMinutes * 60 * 1000;
    this.mediumMs = config.probeMediumMinutes * 60 * 1000;
    this.longMs = config.probeLongMinutes * 60 * 1000;
  }

  advance(sample: BacktestPriceSample, nowTs: number): { short: ProbeStats; medium: ProbeStats; long: ProbeStats } {
    if (sample.probeEligible) {
      const entry: ProbeWindowEntry = { mid: sample.mid, spread: sample.spread, ts: sample.ts };
      this.long.push(entry);
      if (sample.ts >= nowTs - this.mediumMs) this.medium.push(entry);
      if (sample.ts >= nowTs - this.shortMs) this.short.push(entry);
    }
    this.trimBefore(this.long, nowTs - this.longMs);
    this.trimBefore(this.medium, nowTs - this.mediumMs);
    this.trimBefore(this.short, nowTs - this.shortMs);
    return this.snapshot();
  }

  private trimBefore(arr: ProbeWindowEntry[], minTs: number): void {
    while (arr.length > 0 && arr[0].ts < minTs) arr.shift();
  }

  private snapshot(): { short: ProbeStats; medium: ProbeStats; long: ProbeStats } {
    const shortStats = computeStats(this.short);
    const mediumStats = computeStats(this.medium);
    const longStats = computeStats(this.long);
    const shortPeriodStart = computePeriodStart(this.short);
    const mediumPeriodStart = computePeriodStart(this.medium);
    const longPeriodStart = computePeriodStart(this.long);
    const shortTrend = computeTrend(this.short);
    const mediumTrend = computeTrend(this.medium);
    const longTrend = computeTrend(this.long);
    return {
      short: { ...shortStats, ...shortPeriodStart, trendDir: shortTrend?.dir ?? null, trendPct: shortTrend?.pct ?? null },
      medium: { ...mediumStats, ...mediumPeriodStart, trendDir: mediumTrend?.dir ?? null, trendPct: mediumTrend?.pct ?? null },
      long: { ...longStats, ...longPeriodStart, trendDir: longTrend?.dir ?? null, trendPct: longTrend?.pct ?? null },
    };
  }
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
    if (stat === 'period_start') {
      if (rule.left === 'Buy') return p.periodStartBuy;
      if (rule.left === 'Sell') return p.periodStartSell;
      return null;
    }
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

export type ExitReason = 'tp' | 'sl' | 'dsl' | 'rules' | 'forcedClose' | 'endOfPeriod';

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
  forcedClose: number;
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
  /** Per-rule missed-open episodes: rule alone blocked an open while flat, market open, schedule OK (rising edge ≈ extra trades if removed). */
  ruleBlockerCounts?: RuleBlockerCountRow[];
  /** True when backtest simulated dynamic stop loss for at least one direction. */
  dynamicStopLossApplied?: boolean;
  /** Human-readable note for the simulation report. */
  dynamicStopLossNote?: string;
  /** One row per calendar day included in this analysis run. */
  analysedDays?: BacktestDaySummary[];
  /** Warnings when in-market probe windows are empty or sparse (end-of-run snapshot). */
  probeCoverageWarnings?: string[];
}

/** One row in the missed-open report (legacy rules or a BUY/SELL rule set). */
export type RuleBlockerCountRow = {
  left: string;
  op: string;
  right: string;
  /** Times this rule alone blocked an open (flat, in-market, schedule OK) on a rising edge — ≈ max extra trades if removed. */
  missedOpenEpisodeCount: number;
  /** Present when using per-direction rule sets. */
  direction?: 'BUY' | 'SELL';
};

const BLOCKER_AGG_SEP = '\u0001';

function blockerRowKey(row: Pick<RuleBlockerCountRow, 'left' | 'op' | 'right'> & { direction?: 'BUY' | 'SELL' }): string {
  return row.direction
    ? `${row.direction}${BLOCKER_AGG_SEP}${row.left}${BLOCKER_AGG_SEP}${row.op}${BLOCKER_AGG_SEP}${row.right}`
    : `legacy${BLOCKER_AGG_SEP}${row.left}${BLOCKER_AGG_SEP}${row.op}${BLOCKER_AGG_SEP}${row.right}`;
}

function parseBlockerAggregateKey(key: string): Omit<RuleBlockerCountRow, 'missedOpenEpisodeCount'> | null {
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
    out.push({ ...parsed, missedOpenEpisodeCount: count });
  }
  out.sort((a, b) => b.missedOpenEpisodeCount - a.missedOpenEpisodeCount);
  return out;
}

function getDayKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function londonDateKeyFromTs(ts: number): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

/** First sample mid per Europe/London day — fallback when IG day open unavailable. */
function fallbackDayStartByLondonDate(samples: { ts: number; bid: number; offer: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples) {
    const key = londonDateKeyFromTs(s.ts);
    if (out[key] == null) out[key] = (s.bid + s.offer) / 2;
  }
  return out;
}

function resolveDayStartForTs(
  ts: number,
  config: BacktestConfig,
  fallbackByLondon: Record<string, number>
): number | null {
  const key = londonDateKeyFromTs(ts);
  const ig = config.dayStartByLondonDate?.[key];
  if (ig != null && !isNaN(ig)) return ig;
  const fb = fallbackByLondon[key];
  return fb != null && !isNaN(fb) ? fb : null;
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
          blockerAggregate.set(k, (blockerAggregate.get(k) ?? 0) + b.missedOpenEpisodeCount);
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
    forcedClose: allTrades.filter((t) => t.exitReason === 'forcedClose').length,
    endOfPeriod: allTrades.filter((t) => t.exitReason === 'endOfPeriod').length,
  };
  const dslMeta = buildDynamicSlReportMeta(config);

  const report: BacktestReport = {
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
  const probeHistory = buildProbeHistoryForCoverage(samples, config);
  return attachProbeCoverageWarnings(report, probeHistory, config, endTs);
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
  onDayProgress?: (processed: number, total: number) => void,
  onSampleProgress?: BacktestProgressCallback
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
  onDayProgress?.(0, totalDays);

  for (const blockDays of blocks) {
    const blockSamples: RecordedSample[] = [];
    for (const d of blockDays) {
      blockSamples.push(...(byDay.get(d) ?? []));
    }
    const blockDayCount = blockDays.length;
    const report = runBacktest(blockSamples, config, (samplesDone, blockTotal, stats) => {
      onSampleProgress?.(samplesDone, blockTotal, stats);
      const frac = blockTotal > 0 ? samplesDone / blockTotal : 1;
      const approxDays = daysProcessed + Math.floor(frac * blockDayCount);
      onDayProgress?.(Math.min(approxDays, totalDays), totalDays);
    });
    allTrades.push(...report.trades);
    totalGainLoss += report.totalGainLoss;
    totalSamples += report.sampleCount;
    openAtEndTotal += report.openAtEnd ?? 0;
    if (report.ruleBlockerCounts) {
      for (const b of report.ruleBlockerCounts) {
        const k = blockerRowKey(b);
        blockerAggregate.set(k, (blockerAggregate.get(k) ?? 0) + b.missedOpenEpisodeCount);
      }
    }
    if (blockSamples.length > 0) {
      if (startTs === 0 || blockSamples[0].ts < startTs) startTs = blockSamples[0].ts;
      if (blockSamples[blockSamples.length - 1].ts > endTs) endTs = blockSamples[blockSamples.length - 1].ts;
    }
    daysProcessed += blockDays.length;
    onDayProgress?.(daysProcessed, totalDays);
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
    forcedClose: allTrades.filter((t) => t.exitReason === 'forcedClose').length,
    endOfPeriod: allTrades.filter((t) => t.exitReason === 'endOfPeriod').length,
  };
  const dslMeta = buildDynamicSlReportMeta(config);

  const report: BacktestReport = {
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
  const probeHistory = buildProbeHistoryForCoverage(samples, config);
  return attachProbeCoverageWarnings(report, probeHistory, config, endTs);
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
      const asyncReport: BacktestReport = {
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
      };
      const probeHistory = buildProbeHistoryForCoverage(samples, config);
      done(attachProbeCoverageWarnings(asyncReport, probeHistory, config, endTs));
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
            blockerAggregate.set(k, (blockerAggregate.get(k) ?? 0) + b.missedOpenEpisodeCount);
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

function buildProbeHistoryForCoverage(samples: RecordedSample[], config: BacktestConfig): BacktestPriceSample[] {
  const flags = precomputeProbeEligibleFlags(samples, probeFilterOpts(config));
  return samples.map((s, i) => ({
    ts: s.ts,
    mid: (s.bid + s.offer) / 2,
    spread: s.spread,
    probeEligible: flags[i],
  }));
}

function attachProbeCoverageWarnings(
  report: BacktestReport,
  priceHistory: BacktestPriceSample[],
  config: BacktestConfig,
  atTs: number
): BacktestReport {
  if (priceHistory.length === 0) return report;
  const coverage = analyzeProbeCoverage(
    priceHistory,
    atTs,
    config.probeShortMinutes,
    config.probeMediumMinutes,
    config.probeLongMinutes,
    probeFilterOpts(config)
  );
  if (coverage.hasWarnings) report.probeCoverageWarnings = coverage.warnings;
  return report;
}

export interface BacktestProgressSnapshot {
  totalGainLoss: number;
  winningTrades: number;
  losingTrades: number;
  tradeCount: number;
}

export type BacktestProgressCallback = (
  processed: number,
  total: number,
  stats?: BacktestProgressSnapshot
) => void;

function progressSampleInterval(totalSamples: number): number {
  if (totalSamples <= 0) return 1;
  return Math.max(1, Math.min(5000, Math.floor(totalSamples / 200)));
}

function snapshotTradeStats(trades: BacktestTrade[]): BacktestProgressSnapshot {
  let totalGainLoss = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  for (const t of trades) {
    totalGainLoss += t.profitLoss;
    if (t.profitLoss > 0) winningTrades++;
    else if (t.profitLoss < 0) losingTrades++;
  }
  return { totalGainLoss, winningTrades, losingTrades, tradeCount: trades.length };
}

export function runBacktest(
  samples: RecordedSample[],
  config: BacktestConfig,
  onProgress?: BacktestProgressCallback
): BacktestReport {
  const trades: BacktestTrade[] = [];
  const filterOpts = probeFilterOpts(config);
  const probeEligibleFlags = precomputeProbeEligibleFlags(samples, filterOpts);
  const canOpenLookup = new DealingOpenLookup(config.dealingWeekLondon ?? null);
  const probeTracker = new ProbeWindowTracker(config);
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
  let pausedUntilTs: number | null = null;
  let consecutiveLossCount = 0;
  let lossStreakDayKey: string | null = null;
  let prevLoopDayKey: string | null = null;

  function resetLossHandlingForNewDay(): void {
    buyStoppedAfterLoss = false;
    sellStoppedAfterLoss = false;
    consecutiveLossCount = 0;
    lossStreakDayKey = null;
  }

  function isEnginePaused(ts: number): boolean {
    return pausedUntilTs != null && ts < pausedUntilTs;
  }

  function isDirectionActive(direction: 'BUY' | 'SELL', ts: number): boolean {
    if (isScheduleBlockingOpens(ts, config) || isEnginePaused(ts)) return false;
    if (direction === 'BUY' && buyStoppedAfterLoss) return false;
    if (direction === 'SELL' && sellStoppedAfterLoss) return false;
    return true;
  }

  /** True when consecutive-loss halt is active, flat, and the rest of the day cannot produce trades. */
  function isHaltedFlatForLossDay(): boolean {
    const streakLimit = config.stopAfterConsecutiveLosses ?? 0;
    return streakLimit > 0 && buyStoppedAfterLoss && sellStoppedAfterLoss && openPosition === null;
  }

  function onTradeClosed(trade: BacktestTrade): void {
    const closeDayKey = getDayKey(trade.exitTs);
    if (trade.profitLoss >= 0) {
      if (lossStreakDayKey === closeDayKey) consecutiveLossCount = 0;
      return;
    }
    if (lossStreakDayKey !== closeDayKey) {
      lossStreakDayKey = closeDayKey;
      consecutiveLossCount = 0;
    }
    const streakLimit = config.stopAfterConsecutiveLosses ?? 0;
    if (streakLimit > 0) {
      consecutiveLossCount += 1;
      if (consecutiveLossCount >= streakLimit) {
        buyStoppedAfterLoss = true;
        sellStoppedAfterLoss = true;
        return;
      }
    }
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
  const fallbackDayStartByLondon = fallbackDayStartByLondonDate(samples);

  const useRuleSets = config.ruleSets && config.ruleSets.length > 0 && config.backtestRuleSets && config.backtestRuleSets.length > 0;
  const activeRuleSets: RuleSetConfig[] = useRuleSets
    ? (config.ruleSets!.filter((rs) => config.backtestRuleSets!.includes(rs.direction)) as RuleSetConfig[])
    : [];
  const legacyRules = config.rules || [];
  const legacyDirection = inferDirection(config);
  const enabledLegacyRules = legacyRules.filter((r) => r.enabled !== false);
  const missedOpenEpisodeCounts = new Map<string, number>();
  let prevAlmostOpenKeys = new Set<string>();

  function resetEdgeDetectionState(): void {
    prevAlmostOpenKeys = new Set();
    prevRulesPass = false;
    prevBlocked = false;
    prevCanOpen = false;
    prevMid = null;
  }

  function reportSampleProgress(done: number): void {
    if (!onProgress) return;
    const clamped = Math.min(done, totalSamples);
    if (clamped % progressEvery === 0 || clamped === totalSamples) {
      onProgress(clamped, totalSamples, snapshotTradeStats(trades));
    }
  }

  const totalSamples = samples.length;
  const progressEvery = progressSampleInterval(totalSamples);
  if (onProgress) onProgress(0, totalSamples, snapshotTradeStats(trades));

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const loopDayKey = getDayKey(s.ts);
    if (prevLoopDayKey !== null && loopDayKey !== prevLoopDayKey) {
      resetLossHandlingForNewDay();
    }
    prevLoopDayKey = loopDayKey;

    // After consecutive-loss halt with no open position, skip remaining samples for this day.
    if (isHaltedFlatForLossDay()) {
      let nextDayIndex = i + 1;
      while (nextDayIndex < samples.length && getDayKey(samples[nextDayIndex].ts) === loopDayKey) {
        nextDayIndex++;
      }
      if (nextDayIndex > i + 1) {
        reportSampleProgress(nextDayIndex);
        if (nextDayIndex < samples.length) resetEdgeDetectionState();
        i = nextDayIndex - 1;
        continue;
      }
    }

    reportSampleProgress(i + 1);
    const mid = (s.bid + s.offer) / 2;
    const sample: BacktestPriceSample = { ts: s.ts, mid, spread: s.spread, probeEligible: probeEligibleFlags[i] };

    const currentTrend = prevMid != null
      ? (mid > prevMid ? 'up' : mid < prevMid ? 'down' : 'flat')
      : null;
    prevMid = mid;

    const probes = probeTracker.advance(sample, s.ts);
    const sentiment = sentimentFromLongShort(s.longPct, s.shortPct);
    const dayStart = resolveDayStartForTs(s.ts, config, fallbackDayStartByLondon);

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
    const dealingOpen = canOpenLookup.isOpen(s.ts);
    const canOpenHere = pass && dealingOpen && !isScheduleBlockingOpens(s.ts, config) && !isEnginePaused(s.ts);

    const openEnvReady =
      !blocked && dealingOpen && !isScheduleBlockingOpens(s.ts, config) && !isEnginePaused(s.ts);

    // Missed opens: flat, in-market, schedule OK, exactly one rule fails — count rising edges only (dedupes burst seconds).
    const almostOpenKeysThisSample = new Set<string>();
    if (openEnvReady && !pass) {
      if (!useRuleSets && enabledLegacyRules.length > 0) {
        const failing = getFailingRuleIndices(ctx, { ...config, rules: legacyRules });
        if (failing.length === 1) {
          const r = enabledLegacyRules[failing[0]];
          almostOpenKeysThisSample.add(blockerRowKey({ left: r.left, op: r.op, right: r.right }));
        }
      } else if (useRuleSets && activeRuleSets.length > 0) {
        for (const rs of activeRuleSets) {
          const enabledRs = rs.rules.filter((rule) => rule.enabled !== false);
          if (enabledRs.length === 0) continue;
          const failing = getFailingRuleIndices(ctx, { ...config, rules: rs.rules });
          if (failing.length === 1) {
            const r = enabledRs[failing[0]];
            almostOpenKeysThisSample.add(
              blockerRowKey({ left: r.left, op: r.op, right: r.right, direction: rs.direction })
            );
          }
        }
      }
    }
    for (const key of almostOpenKeysThisSample) {
      if (!prevAlmostOpenKeys.has(key)) {
        missedOpenEpisodeCounts.set(key, (missedOpenEpisodeCounts.get(key) ?? 0) + 1);
      }
    }
    prevAlmostOpenKeys = almostOpenKeysThisSample;

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

      // Forced intraday flatten at configured local clock time (after TP/SL).
      const fcMin = parseScheduleTimeHHMM(config.forcedCloseTime);
      if (fcMin != null && openPosition) {
        const tz = config.scheduleTimezone || 'Europe/London';
        const nowMin = minutesInTimezone(s.ts, tz);
        if (nowMin >= fcMin) {
          const pos = openPosition;
          const exitPrice = pos.direction === 'BUY' ? s.bid : s.offer;
          const pnl = pos.direction === 'BUY'
            ? (s.bid - pos.entryPrice)
            : (pos.entryPrice - s.offer);
          recordTrade({
            direction: pos.direction,
            entryTs: pos.entryTs,
            entryPrice: pos.entryPrice,
            exitTs: s.ts,
            exitPrice,
            profitLoss: pnl,
            exitReason: 'forcedClose',
            entryRules: er,
          });
          openPosition = null;
          prevRulesPass = false;
          prevBlocked = false;
          prevCanOpen = false;
          continue;
        }
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
    forcedClose: trades.filter((t) => t.exitReason === 'forcedClose').length,
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
  for (const [key, count] of missedOpenEpisodeCounts.entries()) {
    if (count <= 0) continue;
    const parsed = parseBlockerAggregateKey(key);
    if (!parsed) continue;
    ruleBlockerCounts.push({ ...parsed, missedOpenEpisodeCount: count });
  }
  ruleBlockerCounts.sort((a, b) => b.missedOpenEpisodeCount - a.missedOpenEpisodeCount);
  const dslMeta = buildDynamicSlReportMeta(config);

  const report: BacktestReport = {
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
  const lastTs = samples.length > 0 ? samples[samples.length - 1].ts : 0;
  return attachProbeCoverageWarnings(report, buildProbeHistoryForCoverage(samples, config), config, lastTs);
}
