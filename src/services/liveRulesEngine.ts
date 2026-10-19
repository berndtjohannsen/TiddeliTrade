/**
 * Server-side live rules engine — probes + evaluation on the stream (headless-safe).
 * Browser UI remains for config; deals are placed here when enabled.
 */
import type { Server } from 'socket.io';
import type { IgSession } from './ig';
import { loadConfig, type InstrumentSettings, type UserConfig } from '../config';
import {
  analyzeProbeCoverage,
  isProbeEligibleSample,
  PROBE_SAMPLE_INTERVAL_MS,
  type ProbeSampleFilterOpts,
} from './probeSamples';
import {
  dateKeyInTimezone,
  evaluateRules,
  getTpSlLevels,
  isWithinScheduleWindow,
  minutesInTimezone,
  parseScheduleTimeHHMM,
  ProbeWindowTracker,
  type BacktestConfig,
  type LiveRulesEvalContext,
  type ProbeStats,
  type Rule,
  type RuleSetConfig,
} from './rulesBacktest';
import { resolveDynamicStopLossSettings, shouldOmitTakeProfitForDeal } from './dynamicStopLoss';
import { getInstrumentSettings } from './backtestMarketSnapshot';
import type { ClientSentiment } from './priceRecorder';

const RULE_GROUP_ORDER = ['long', 'medium', 'short', 'other'] as const;
const DEAL_ATTEMPT_COOLDOWN_MS = 8000;
const MAX_STREAM_SAMPLES = 120000;

export type LiveRulesStreamTick = {
  bid: number;
  offer: number;
  spread: number;
  updateTime?: string;
  marketState?: string | null;
};

export type PlaceRulesDealParams = {
  epic: string;
  direction: 'BUY' | 'SELL';
  size: string;
  takeProfit?: string;
  stopLoss?: string;
  closeAt?: string;
  bid?: number;
  offer?: number;
};

export type LiveRulesEngineDeps = {
  getSession: () => IgSession | null;
  getStreamEpic: () => string | null;
  getSentiment: (epic: string) => ClientSentiment | null;
  getProbeFilterOpts: (epic: string) => ProbeSampleFilterOpts;
  getContractSize: (epic: string) => number;
  countOpenSlots: (epic: string) => Promise<number>;
  placeRulesDeal: (params: PlaceRulesDealParams) => Promise<boolean>;
  /** Flatten open rules positions at configured forced-close time. */
  runForcedCloseSweep: (epic: string) => Promise<void>;
  log: (msg: string) => void;
  emitStatus: (payload: LiveRulesStatusPayload) => void;
};

export type LiveProbeStatsPayload = {
  epic: string;
  dayStart: number | null;
  probes: { short: ProbeStats; medium: ProbeStats; long: ProbeStats };
};

export type LiveRulesStatusPayload = {
  epic: string;
  running: boolean;
  host: 'server';
  probesReady: boolean;
  probesDetail: string;
  uiMode: string;
  pauseRemainingSec?: number;
  haltedForLoss?: boolean;
  dayStart?: number | null;
  probes?: LiveProbeStatsPayload['probes'];
};

type EpicRuntime = {
  tracker: ProbeWindowTracker | null;
  configKey: string;
  lastSampleTs: number;
  prevMid: number | null;
  prevRulesPass: boolean;
  prevBlocked: boolean;
  lastDealAttemptMs: number;
  dealInProgress: boolean;
  samplesForCoverage: Array<{ ts: number; marketState?: string | null }>;
  dayStartBuy: number | null;
  forcedCloseLastRunDate: string | null;
  pausedUntil: number | null;
  consecutiveLossCount: number;
  lossStreakDayKey: string | null;
  lossHaltedDayKey: string | null;
  lossHandlingWatchDayKey: string | null;
  /** Raw ~1 Hz stream samples — survives tracker rebuilds and stream stop/start. */
  streamSamples: Array<{ ts: number; mid: number; spread: number; marketState?: string | null }>;
};

const runtimeByEpic = new Map<string, EpicRuntime>();
/** dealId → buy|sell for server-placed rules deals (loss handling). */
const serverRulesPlacedDealIds = new Map<string, 'buy' | 'sell'>();
/** Injected by socket handlers (used for reconnect status snapshots). */
let liveRulesDepsRef: LiveRulesEngineDeps | null = null;

export function setLiveRulesEngineDeps(deps: LiveRulesEngineDeps | null): void {
  liveRulesDepsRef = deps;
}

export function getLiveRulesEngineDeps(): LiveRulesEngineDeps | null {
  return liveRulesDepsRef;
}

/** Live rules always evaluate on the server while rules are running for this epic. */
export function isServerRulesEngineEnabled(cfg: UserConfig, epic: string): boolean {
  const inst = epic && cfg.ui?.instruments?.[epic] ? cfg.ui.instruments[epic] : null;
  const running = inst?.tradingRulesRunning ?? cfg.ui?.tradingRulesRunning;
  return !!running;
}

type RuleSideSaved = {
  rules?: Rule[];
  ruleGroups?: Partial<Record<(typeof RULE_GROUP_ORDER)[number], Rule[]>>;
  dealSize?: string;
  takeProfit?: string | null;
  stopLoss?: string | null;
  tpSlMode?: string;
};

function flattenRulesFromSide(side: RuleSideSaved | undefined): Rule[] {
  if (!side) return [];
  if (Array.isArray(side.rules) && side.rules.length > 0) return side.rules;
  const groups = side.ruleGroups;
  if (!groups) return [];
  const out: Rule[] = [];
  for (const g of RULE_GROUP_ORDER) {
    const list = groups[g];
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}

function buildRuleSets(inst: InstrumentSettings | null, ui: UserConfig['ui']): RuleSetConfig[] {
  const rs = inst?.ruleSets ?? ui?.ruleSets;
  if (!rs) return [];
  const buyRules = flattenRulesFromSide(rs.buy as RuleSideSaved | undefined);
  const sellRules = flattenRulesFromSide(rs.sell as RuleSideSaved | undefined);
  const sets: RuleSetConfig[] = [];
  if (buyRules.length > 0 || rs.buy) {
    sets.push({
      direction: 'BUY',
      rules: buyRules,
      dealSize: rs.buy?.dealSize ?? '1',
      takeProfit: rs.buy?.takeProfit ?? null,
      stopLoss: rs.buy?.stopLoss ?? null,
      tpSlMode: (rs.buy?.tpSlMode as 'value' | 'rate' | 'pct') ?? 'rate',
    });
  }
  if (sellRules.length > 0 || rs.sell) {
    sets.push({
      direction: 'SELL',
      rules: sellRules,
      dealSize: rs.sell?.dealSize ?? '1',
      takeProfit: rs.sell?.takeProfit ?? null,
      stopLoss: rs.sell?.stopLoss ?? null,
      tpSlMode: (rs.sell?.tpSlMode as 'value' | 'rate' | 'pct') ?? 'rate',
    });
  }
  return sets;
}

function probeMinutes(cfg: UserConfig): { short: number; medium: number; long: number } {
  const ui = cfg.ui || {};
  const short = ui.probesShortPeriod != null ? ui.probesShortPeriod : 5;
  const medium = ui.probesMediumPeriod != null ? Math.min(Math.max(ui.probesMediumPeriod, 1), 10080) : 60;
  let long = ui.probesLongPeriod != null ? ui.probesLongPeriod : 1440;
  if (long <= medium) long = Math.min(medium * 24, 720 * 60);
  return { short, medium, long };
}

function scheduleTimezone(cfg: UserConfig, inst: InstrumentSettings | null): string {
  return (inst?.tradingRulesScheduleTimezone as string | undefined)?.trim() || 'Europe/London';
}

function forcedCloseTime(cfg: UserConfig, inst: InstrumentSettings | null): string {
  return (inst?.tradingRulesForcedCloseTime ?? cfg.ui?.tradingRulesForcedCloseTime ?? '').trim();
}

function buildLiveBacktestConfig(cfg: UserConfig, epic: string, filterOpts: ProbeSampleFilterOpts, contractSize: number): BacktestConfig {
  const ui = cfg.ui || {};
  const inst = getInstrumentSettings(epic);
  const pm = probeMinutes(cfg);
  const scheduleTz = scheduleTimezone(cfg, inst);
  return {
    ruleSets: buildRuleSets(inst, ui),
    probeShortMinutes: pm.short,
    probeMediumMinutes: pm.medium,
    probeLongMinutes: pm.long,
    is24_7: !!filterOpts.is24_7,
    dealingWeekLondon: filterOpts.dealingWeekLondon ?? null,
    scheduleStartTime: (inst?.tradingRulesScheduleStartTime ?? ui.tradingRulesScheduleStartTime ?? '').trim(),
    scheduleStopTime: (inst?.tradingRulesScheduleStopTime ?? ui.tradingRulesScheduleStopTime ?? '').trim(),
    scheduleRepeatDaily: inst?.tradingRulesScheduleRepeatDaily ?? ui.tradingRulesScheduleRepeatDaily !== false,
    scheduleActiveDate: inst?.tradingRulesScheduleActiveDate ?? ui.tradingRulesScheduleActiveDate,
    scheduleTimezone: scheduleTz,
    forcedCloseTime: forcedCloseTime(cfg, inst),
    dealSize: '1',
    contractSize,
  };
}

function pauseOnLossSeconds(cfg: UserConfig, inst: InstrumentSettings | null): number {
  const pick =
    inst?.tradingRulesPauseOnLossSeconds
    ?? inst?.tradingRulesPauseOnLossSecondsBuy
    ?? inst?.tradingRulesPauseOnLossSecondsSell
    ?? cfg.ui?.tradingRulesPauseOnLossSeconds;
  if (typeof pick !== 'number' || isNaN(pick) || pick < 0) return 0;
  return Math.min(pick, 86400);
}

function stopAfterConsecutiveLosses(cfg: UserConfig, inst: InstrumentSettings | null): number {
  const pick = inst?.tradingRulesStopAfterConsecutiveLosses ?? cfg.ui?.tradingRulesStopAfterConsecutiveLosses;
  if (typeof pick === 'number' && !isNaN(pick) && pick >= 1) return Math.min(pick, 20);
  const legacy =
    inst?.tradingRulesStopAfterLoss === true
    || inst?.tradingRulesStopAfterLossBuy === true
    || inst?.tradingRulesStopAfterLossSell === true
    || cfg.ui?.tradingRulesStopAfterLossBuy === true
    || cfg.ui?.tradingRulesStopAfterLossSell === true;
  return legacy ? 1 : 0;
}

function syncLossHandlingDayRollover(rt: EpicRuntime, nowMs: number, tz: string): void {
  const today = dateKeyInTimezone(nowMs, tz);
  if (rt.lossHandlingWatchDayKey != null && rt.lossHandlingWatchDayKey !== today) {
    rt.consecutiveLossCount = 0;
    rt.lossStreakDayKey = null;
    if (rt.lossHaltedDayKey != null && rt.lossHaltedDayKey !== today) {
      rt.lossHaltedDayKey = null;
    }
  }
  rt.lossHandlingWatchDayKey = today;
}

function isPausedOnLoss(rt: EpicRuntime, nowMs: number): boolean {
  return rt.pausedUntil != null && rt.pausedUntil > nowMs;
}

function pauseRemainingSec(rt: EpicRuntime, nowMs: number): number {
  if (!isPausedOnLoss(rt, nowMs)) return 0;
  return Math.ceil((rt.pausedUntil! - nowMs) / 1000);
}

function isLossHaltedToday(rt: EpicRuntime, nowMs: number, tz: string): boolean {
  return rt.lossHaltedDayKey != null && rt.lossHaltedDayKey === dateKeyInTimezone(nowMs, tz);
}

function startPauseOnLoss(rt: EpicRuntime, seconds: number, log: (msg: string) => void): void {
  if (seconds <= 0) return;
  rt.pausedUntil = Date.now() + seconds * 1000;
  log(`Server rules: paused on loss for ${seconds}s`);
}

function haltRulesForLossDay(rt: EpicRuntime, closeDayKey: string, message: string, log: (msg: string) => void): void {
  rt.lossHaltedDayKey = closeDayKey;
  log(`${message} Resumes next calendar day (${closeDayKey}).`);
}

function isPastForcedClose(nowMs: number, fcTime: string, tz: string): boolean {
  const fcMin = parseScheduleTimeHHMM(fcTime);
  if (fcMin == null) return false;
  return minutesInTimezone(nowMs, tz) >= fcMin;
}

async function runForcedCloseIfNeeded(
  deps: LiveRulesEngineDeps,
  epic: string,
  rt: EpicRuntime,
  cfg: UserConfig,
  nowMs: number
): Promise<void> {
  const inst = getInstrumentSettings(epic);
  const fc = forcedCloseTime(cfg, inst);
  const tz = scheduleTimezone(cfg, inst);
  if (!fc || !isPastForcedClose(nowMs, fc, tz)) return;
  const today = dateKeyInTimezone(nowMs, tz);
  if (rt.forcedCloseLastRunDate === today) return;
  rt.forcedCloseLastRunDate = today;
  deps.log(`Server rules forced close at ${fc} — flattening open positions`);
  await deps.runForcedCloseSweep(epic);
}

/** Next forced-close instant as ISO (schedule timezone). */
function getNextForcedCloseIso(nowMs: number, fcTime: string, tz: string): string | null {
  const fcMin = parseScheduleTimeHHMM(fcTime);
  if (fcMin == null) return null;
  const nowMin = minutesInTimezone(nowMs, tz);
  let scanStart = nowMs;
  if (nowMin >= fcMin) scanStart += 86400000;
  const end = scanStart + 48 * 3600000;
  for (let t = scanStart; t <= end; t += 60000) {
    if (minutesInTimezone(t, tz) === fcMin) return new Date(t).toISOString();
  }
  return null;
}

export function registerServerRulesPlacedDeal(dealId: string, direction: 'BUY' | 'SELL'): void {
  if (!dealId) return;
  serverRulesPlacedDealIds.set(dealId, direction === 'SELL' ? 'sell' : 'buy');
}

export function clearServerRulesPlacedDeal(dealId: string): void {
  serverRulesPlacedDealIds.delete(dealId);
}

/** Called when a closed transaction is logged (server-side loss handling). */
export function onLiveRulesTransactionClosed(
  deps: LiveRulesEngineDeps,
  epic: string,
  tx: { dealId?: string; profitLoss?: number; timestamp?: string }
): void {
  const cfg = loadConfig();
  if (!isServerRulesEngineEnabled(cfg, epic)) return;
  if (!tx.dealId) return;
  const panel = serverRulesPlacedDealIds.get(tx.dealId);
  clearServerRulesPlacedDeal(tx.dealId);
  const inst = getInstrumentSettings(epic);
  const tz = scheduleTimezone(cfg, inst);
  const rt = getRuntime(epic);
  const ts = tx.timestamp ? Date.parse(tx.timestamp) : NaN;
  const nowMs = isNaN(ts) ? Date.now() : ts;
  const closeDayKey = dateKeyInTimezone(nowMs, tz);
  if (panel != null && typeof tx.profitLoss === 'number' && tx.profitLoss >= 0) {
    if (rt.lossStreakDayKey !== closeDayKey) {
      rt.lossStreakDayKey = closeDayKey;
      rt.consecutiveLossCount = 0;
    }
    return;
  }
  if (typeof tx.profitLoss !== 'number' || tx.profitLoss >= 0) return;
  if (rt.lossStreakDayKey !== closeDayKey) {
    rt.lossStreakDayKey = closeDayKey;
    rt.consecutiveLossCount = 0;
  }
  let skipPause = false;
  if (panel != null) {
    const streakLimit = stopAfterConsecutiveLosses(cfg, inst);
    if (streakLimit > 0) {
      rt.consecutiveLossCount += 1;
      if (rt.consecutiveLossCount >= streakLimit) {
        skipPause = true;
        haltRulesForLossDay(
          rt,
          closeDayKey,
          `Server rules halted for today (${rt.consecutiveLossCount} consecutive losses).`,
          deps.log
        );
      }
    }
  }
  if (!skipPause) {
    const seconds = pauseOnLossSeconds(cfg, inst);
    if (seconds > 0) startPauseOnLoss(rt, seconds, deps.log);
  }
}

/** Clock-driven tasks (forced close) — call ~every 30s while stream/rules active. */
export async function runLiveRulesScheduledTasks(deps: LiveRulesEngineDeps, epic: string): Promise<void> {
  const cfg = loadConfig();
  if (!isServerRulesEngineEnabled(cfg, epic)) return;
  const rt = getRuntime(epic);
  const tz = scheduleTimezone(cfg, getInstrumentSettings(epic));
  const now = Date.now();
  syncLossHandlingDayRollover(rt, now, tz);
  await runForcedCloseIfNeeded(deps, epic, rt, cfg, now);
}

function configCacheKey(cfg: UserConfig, epic: string, filterOpts: ProbeSampleFilterOpts): string {
  const inst = getInstrumentSettings(epic);
  const ui = cfg.ui || {};
  const pm = probeMinutes(cfg);
  const ruleSets = buildRuleSets(inst, ui);
  const allRules = ruleSets.flatMap((rs) => rs.rules.filter((r) => r.enabled !== false));
  return JSON.stringify({
    probes: pm,
    filterOpts,
    probeHorizons: requiredProbeHorizons(allRules),
    requireWarmup: inst?.tradingRulesRequireProbeWarmup ?? ui.tradingRulesRequireProbeWarmup,
  });
}

function getRuntime(epic: string): EpicRuntime {
  let rt = runtimeByEpic.get(epic);
  if (!rt) {
    rt = {
      tracker: null,
      configKey: '',
      lastSampleTs: 0,
      prevMid: null,
      prevRulesPass: false,
      prevBlocked: true,
      lastDealAttemptMs: 0,
      dealInProgress: false,
      samplesForCoverage: [],
      dayStartBuy: null,
      forcedCloseLastRunDate: null,
      pausedUntil: null,
      consecutiveLossCount: 0,
      lossStreakDayKey: null,
      lossHaltedDayKey: null,
      lossHandlingWatchDayKey: null,
      streamSamples: [],
    };
    runtimeByEpic.set(epic, rt);
  }
  return rt;
}

function rebuildTrackerFromStreamSamples(
  rt: EpicRuntime,
  cfg: UserConfig,
  epic: string,
  filterOpts: ProbeSampleFilterOpts,
  contractSize: number,
  cacheKey: string
): void {
  rt.configKey = cacheKey;
  rt.tracker = new ProbeWindowTracker(buildLiveBacktestConfig(cfg, epic, filterOpts, contractSize));
  rt.prevRulesPass = false;
  rt.prevBlocked = true;
  rt.samplesForCoverage = [];
  for (const row of rt.streamSamples) {
    const sample = {
      ts: row.ts,
      mid: row.mid,
      spread: row.spread,
      probeEligible: isProbeEligibleSample({ ts: row.ts, marketState: row.marketState }, filterOpts),
      marketState: row.marketState,
    };
    rt.samplesForCoverage.push({ ts: row.ts, marketState: row.marketState ?? null });
    rt.tracker.advance(sample, row.ts);
  }
  if (rt.samplesForCoverage.length > MAX_STREAM_SAMPLES) {
    rt.samplesForCoverage = rt.samplesForCoverage.slice(-MAX_STREAM_SAMPLES);
  }
}

function sentimentLabel(s: ClientSentiment | null): string | null {
  if (!s || (s.longPct === 0 && s.shortPct === 0)) return null;
  const diff = s.longPct - s.shortPct;
  return diff > 5 ? 'Bull' : diff < -5 ? 'Bear' : 'Neutral';
}

function ruleNeedsProbeStats(rules: Rule[]): boolean {
  for (const r of rules) {
    if (r.enabled === false) continue;
    const left = r.left || '';
    if (left.startsWith('short.') || left.startsWith('medium.') || left.startsWith('long.')) return true;
    if (['short.min', 'medium.min', 'long.min', 'short.avg', 'medium.avg', 'long.avg'].some((k) => r.right === k || r.right?.startsWith('short.') || r.right?.startsWith('medium.') || r.right?.startsWith('long.'))) {
      return true;
    }
    if (typeof r.right === 'string' && (r.right.startsWith('short.') || r.right.startsWith('medium.') || r.right.startsWith('long.') || r.right === 'dayStart')) {
      return true;
    }
  }
  return false;
}

function requiredProbeHorizons(rules: Rule[]): { short: boolean; medium: boolean; long: boolean } {
  const need = { short: false, medium: false, long: false };
  for (const r of rules) {
    if (r.enabled === false) continue;
    const tokens = [r.left, r.right].filter(Boolean) as string[];
    for (const t of tokens) {
      if (t.startsWith('short.') || t === 'short') need.short = true;
      if (t.startsWith('medium.') || t === 'medium') need.medium = true;
      if (t.startsWith('long.') || t === 'long') need.long = true;
    }
  }
  return need;
}

function probesReadyForRules(
  cfg: UserConfig,
  inst: InstrumentSettings | null,
  allRules: Rule[],
  rt: EpicRuntime,
  filterOpts: ProbeSampleFilterOpts,
  pm: { short: number; medium: number; long: number }
): { ready: boolean; detail: string } {
  const requireWarmup = inst?.tradingRulesRequireProbeWarmup ?? cfg.ui?.tradingRulesRequireProbeWarmup;
  if (requireWarmup === false) return { ready: true, detail: '' };
  if (!ruleNeedsProbeStats(allRules)) return { ready: true, detail: '' };
  const need = requiredProbeHorizons(allRules);
  const now = Date.now();
  const cov = analyzeProbeCoverage(rt.samplesForCoverage, now, pm.short, pm.medium, pm.long, filterOpts);
  const waiting: string[] = [];
  for (const row of cov.rows) {
    if (!need[row.probe as keyof typeof need]) continue;
    if (row.lowCoverage) {
      waiting.push(`${row.label} (${row.coveragePct ?? 0}%)`);
    }
  }
  if (waiting.length > 0) return { ready: false, detail: waiting.join('; ') };
  return { ready: true, detail: '' };
}

function isBuyEnabled(inst: InstrumentSettings | null, ui: UserConfig['ui']): boolean {
  if (inst?.rulesBuyEnabled != null) return inst.rulesBuyEnabled !== false;
  if (inst?.rulesRunningBuy != null && inst?.rulesRunningSell != null && inst.rulesRunningBuy !== inst.rulesRunningSell) {
    return inst.rulesRunningBuy === true;
  }
  return true;
}

function isSellEnabled(inst: InstrumentSettings | null, ui: UserConfig['ui']): boolean {
  if (inst?.rulesSellEnabled != null) return inst.rulesSellEnabled !== false;
  if (inst?.rulesRunningBuy != null && inst?.rulesRunningSell != null && inst.rulesRunningBuy !== inst.rulesRunningSell) {
    return inst.rulesRunningSell === true;
  }
  return true;
}

function maxParallelDeals(cfg: UserConfig, inst: InstrumentSettings | null): number {
  const pick = inst?.tradingRulesMaxParallelDeals ?? cfg.ui?.tradingRulesMaxParallelDeals;
  const n = typeof pick === 'number' && !isNaN(pick) ? pick : 1;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

function confirmBeforePlace(cfg: UserConfig, inst: InstrumentSettings | null): boolean {
  if (inst?.tradingRulesConfirmBeforePlace != null) return inst.tradingRulesConfirmBeforePlace !== false;
  return cfg.ui?.tradingRulesConfirmBeforePlace !== false;
}

/** Advance server probe windows on every stream tick (independent of rules running). */
function advanceServerProbesFromTick(
  deps: LiveRulesEngineDeps,
  epic: string,
  tick: LiveRulesStreamTick,
  cfg: UserConfig,
  now: number
): { rt: EpicRuntime; probes: ReturnType<ProbeWindowTracker['advance']>; trend: string | null } | null {
  const rt = getRuntime(epic);
  if (now - rt.lastSampleTs < PROBE_SAMPLE_INTERVAL_MS) return null;
  rt.lastSampleTs = now;

  const filterOpts = deps.getProbeFilterOpts(epic);
  const contractSize = deps.getContractSize(epic);
  const cacheKey = configCacheKey(cfg, epic, filterOpts);
  if (rt.configKey !== cacheKey || !rt.tracker) {
    rebuildTrackerFromStreamSamples(rt, cfg, epic, filterOpts, contractSize, cacheKey);
  }

  const mid = (tick.bid + tick.offer) / 2;
  const spread = tick.spread;
  const sample = {
    ts: now,
    mid,
    spread,
    probeEligible: isProbeEligibleSample({ ts: now, marketState: tick.marketState }, filterOpts),
    marketState: tick.marketState,
  };
  rt.streamSamples.push({
    ts: now,
    mid,
    spread: spread,
    marketState: tick.marketState,
  });
  if (rt.streamSamples.length > MAX_STREAM_SAMPLES) {
    rt.streamSamples = rt.streamSamples.slice(-MAX_STREAM_SAMPLES);
  }
  rt.samplesForCoverage.push({ ts: now, marketState: tick.marketState });
  if (rt.samplesForCoverage.length > MAX_STREAM_SAMPLES) {
    rt.samplesForCoverage = rt.samplesForCoverage.slice(-MAX_STREAM_SAMPLES);
  }

  if (!rt.tracker) return null;
  const probes = rt.tracker.advance(sample, now);
  let trend: string | null = null;
  if (rt.prevMid != null) {
    trend = mid > rt.prevMid ? 'up' : mid < rt.prevMid ? 'down' : 'flat';
  }
  rt.prevMid = mid;
  if (rt.dayStartBuy == null && sample.probeEligible) {
    rt.dayStartBuy = tick.offer;
  }
  return { rt, probes, trend };
}

/** Advance server probe windows (sync); returns null when throttled to 1 Hz. */
export function advanceLiveStreamProbes(
  deps: LiveRulesEngineDeps,
  epic: string,
  tick: LiveRulesStreamTick
): ReturnType<typeof advanceServerProbesFromTick> {
  const now = Date.now();
  const rt = getRuntime(epic);
  if (now - rt.lastSampleTs < PROBE_SAMPLE_INTERVAL_MS) return null;
  return advanceServerProbesFromTick(deps, epic, tick, loadConfig(), now);
}

/** Rules evaluation + deals after probes advanced (async). */
export async function onLiveRulesStreamTick(
  deps: LiveRulesEngineDeps,
  epic: string,
  tick: LiveRulesStreamTick,
  sentiment: ClientSentiment | null,
  advancedIn?: ReturnType<typeof advanceServerProbesFromTick>
): Promise<void> {
  const cfg = loadConfig();
  const now = Date.now();
  const advanced = advancedIn ?? advanceServerProbesFromTick(deps, epic, tick, cfg, now);
  if (!advanced) return;

  const { rt, probes, trend } = advanced;
  if (!isServerRulesEngineEnabled(cfg, epic)) return;

  const instEarly = getInstrumentSettings(epic);
  const tz = scheduleTimezone(cfg, instEarly);
  syncLossHandlingDayRollover(rt, now, tz);
  await runForcedCloseIfNeeded(deps, epic, rt, cfg, now);

  const inst = getInstrumentSettings(epic);
  const filterOpts = deps.getProbeFilterOpts(epic);
  const contractSize = deps.getContractSize(epic);
  const pm = probeMinutes(cfg);
  const baseConfig = buildLiveBacktestConfig(cfg, epic, filterOpts, contractSize);
  const ruleSets = baseConfig.ruleSets || [];
  const allRules = ruleSets.flatMap((rs) => rs.rules.filter((r) => r.enabled !== false));
  const probeReady = probesReadyForRules(cfg, inst, allRules, rt, filterOpts, pm);

  const ctx: LiveRulesEvalContext = {
    offer: tick.offer,
    bid: tick.bid,
    dayStart: rt.dayStartBuy,
    currentTime: tick.updateTime?.trim() || '',
    currentTrend: trend,
    sentiment: sentimentLabel(sentiment),
    probes,
  };

  const runBuy = isBuyEnabled(inst, cfg.ui);
  const runSell = isSellEnabled(inst, cfg.ui);
  let buyPass = false;
  let sellPass = false;
  for (const rs of ruleSets) {
    if (rs.direction === 'BUY' && runBuy && rs.rules.length > 0) {
      buyPass = evaluateRules(ctx, { ...baseConfig, rules: rs.rules });
    }
    if (rs.direction === 'SELL' && runSell && rs.rules.length > 0) {
      sellPass = evaluateRules(ctx, { ...baseConfig, rules: rs.rules });
    }
  }
  const triggered = buyPass ? 'BUY' : sellPass ? 'SELL' : null;
  const pass = !!triggered;
  const scheduleBlocked = !isWithinScheduleWindow(now, baseConfig);
  const lossPaused = isPausedOnLoss(rt, now);
  const lossHalted = isLossHaltedToday(rt, now, tz);
  const openSlots = await deps.countOpenSlots(epic);
  const maxPar = maxParallelDeals(cfg, inst);
  const slotsBlocked = openSlots >= maxPar || rt.dealInProgress;
  const probesBlocked = !probeReady.ready;
  const blocked = slotsBlocked || scheduleBlocked || probesBlocked || lossPaused || lossHalted;

  let uiMode = probesBlocked ? 'armed-warmup' : pass ? 'active' : 'armed';
  if (lossPaused) uiMode = 'paused';
  else if (lossHalted) uiMode = 'halted-loss';

  deps.emitStatus({
    epic,
    running: true,
    host: 'server',
    probesReady: probeReady.ready,
    probesDetail: probeReady.detail,
    uiMode,
    pauseRemainingSec: pauseRemainingSec(rt, now),
    haltedForLoss: lossHalted,
    dayStart: rt.dayStartBuy,
    probes,
  });

  if (pass && !blocked && (!rt.prevRulesPass || rt.prevBlocked)) {
    if (now - rt.lastDealAttemptMs < DEAL_ATTEMPT_COOLDOWN_MS) {
      rt.prevRulesPass = pass;
      rt.prevBlocked = blocked;
      return;
    }
    if (confirmBeforePlace(cfg, inst)) {
      deps.log('Server rules: deal skipped — enable auto-place (uncheck Confirm before placing) for headless trading');
      rt.prevRulesPass = pass;
      rt.prevBlocked = blocked;
      return;
    }
    const rs = ruleSets.find((s) => s.direction === triggered);
    if (!rs) {
      rt.prevRulesPass = pass;
      rt.prevBlocked = blocked;
      return;
    }
    const entry = triggered === 'BUY' ? tick.offer : tick.bid;
    const tpSlCfg = {
      ...baseConfig,
      takeProfit: rs.takeProfit,
      stopLoss: rs.stopLoss,
      tpSlMode: rs.tpSlMode,
      dealSize: rs.dealSize || '1',
      contractSize,
    };
    const { tpLevel, slLevel } = getTpSlLevels(entry, triggered, tpSlCfg);
    const dslScope = triggered === 'SELL' ? 'rules-sell' : 'rules-buy';
    const omitTp = shouldOmitTakeProfitForDeal(epic, cfg, dslScope);
    const fc = forcedCloseTime(cfg, inst);
    const closeAtIso = fc ? getNextForcedCloseIso(now, fc, tz) : null;
    rt.lastDealAttemptMs = now;
    rt.dealInProgress = true;
    try {
      const placed = await deps.placeRulesDeal({
        epic,
        direction: triggered,
        size: rs.dealSize || '1',
        takeProfit: !omitTp && tpLevel != null ? String(tpLevel) : undefined,
        stopLoss: slLevel != null ? String(slLevel) : undefined,
        closeAt: closeAtIso ?? undefined,
        bid: tick.bid,
        offer: tick.offer,
      });
      if (placed) deps.log(`Server rules: ${triggered} deal placed`);
    } finally {
      rt.dealInProgress = false;
    }
  }

  rt.prevRulesPass = pass;
  rt.prevBlocked = blocked;
}

/** Load disk buffer and rebuild tracker when stream samples exist but tracker is missing. */
export function ensureRuntimeProbeState(epic: string): EpicRuntime | null {
  if (!epic.trim()) return null;
  const rt = getRuntime(epic);
  const deps = liveRulesDepsRef;
  if (!deps || rt.streamSamples.length === 0) return rt;
  const cfg = loadConfig();
  const filterOpts = deps.getProbeFilterOpts(epic);
  const contractSize = deps.getContractSize(epic);
  const cacheKey = configCacheKey(cfg, epic, filterOpts);
  if (rt.configKey !== cacheKey || !rt.tracker) {
    rebuildTrackerFromStreamSamples(rt, cfg, epic, filterOpts, contractSize, cacheKey);
  }
  return rt;
}

export function countStreamSampleCount(epic: string): number {
  return runtimeByEpic.get(epic)?.streamSamples.length ?? 0;
}

/** In-memory probe samples for reconnect (browser chart + coverage display). */
export function getLiveProbeSeedForEpic(epic: string): Array<{ ts: number; mid: number; spread: number }> {
  const rt = ensureRuntimeProbeState(epic);
  if (rt?.tracker) return rt.tracker.exportSeedSamples();
  if (rt && rt.streamSamples.length > 0) {
    return rt.streamSamples.map((row) => ({ ts: row.ts, mid: row.mid, spread: row.spread }));
  }
  return [];
}

/** Server probe stats for rules UI (matches deal engine, not browser buffer). */
export function getLiveProbeStatsSnapshot(epic: string): Omit<LiveProbeStatsPayload, 'epic'> | null {
  const rt = ensureRuntimeProbeState(epic);
  if (!rt?.tracker) return null;
  return {
    dayStart: rt.dayStartBuy,
    probes: rt.tracker.exportSnapshot(),
  };
}

export function resetLiveRulesRuntime(epic?: string): void {
  if (epic) runtimeByEpic.delete(epic);
  else {
    runtimeByEpic.clear();
    serverRulesPlacedDealIds.clear();
  }
}

/** Full rules/probe snapshot for reconnect (server runtime survives tab reload). */
export function buildLiveRulesStatusPayload(
  deps: LiveRulesEngineDeps,
  epic: string
): LiveRulesStatusPayload {
  const cfg = loadConfig();
  const inst = getInstrumentSettings(epic);
  const running = !!(inst?.tradingRulesRunning ?? cfg.ui?.tradingRulesRunning);
  if (!running) {
    return {
      epic,
      running: false,
      host: 'server',
      probesReady: true,
      probesDetail: '',
      uiMode: 'stopped',
    };
  }

  const now = Date.now();
  const rt = ensureRuntimeProbeState(epic);
  const tz = scheduleTimezone(cfg, inst);
  if (rt) syncLossHandlingDayRollover(rt, now, tz);

  const filterOpts = deps.getProbeFilterOpts(epic);
  const contractSize = deps.getContractSize(epic);
  const pm = probeMinutes(cfg);
  const baseConfig = buildLiveBacktestConfig(cfg, epic, filterOpts, contractSize);
  const allRules = (baseConfig.ruleSets || []).flatMap((rs) => rs.rules.filter((r) => r.enabled !== false));

  if (!rt || !rt.tracker || rt.samplesForCoverage.length === 0) {
    const lossHalted = rt ? isLossHaltedToday(rt, now, tz) : false;
    const lossPaused = rt ? isPausedOnLoss(rt, now) : false;
    let uiMode = 'armed-warmup';
    if (lossPaused) uiMode = 'paused';
    else if (lossHalted) uiMode = 'halted-loss';
    return {
      epic,
      running: true,
      host: 'server',
      probesReady: false,
      probesDetail: 'Waiting for price stream samples',
      uiMode,
      pauseRemainingSec: rt ? pauseRemainingSec(rt, now) : 0,
      haltedForLoss: lossHalted,
    };
  }

  const probeReady = probesReadyForRules(cfg, inst, allRules, rt, filterOpts, pm);
  const lossPaused = isPausedOnLoss(rt, now);
  const lossHalted = isLossHaltedToday(rt, now, tz);
  const scheduleBlocked = !isWithinScheduleWindow(now, baseConfig);
  const probesBlocked = !probeReady.ready;
  let uiMode = probesBlocked ? 'armed-warmup' : 'armed';
  if (lossPaused) uiMode = 'paused';
  else if (lossHalted) uiMode = 'halted-loss';
  else if (scheduleBlocked) uiMode = 'armed-schedule';

  return {
    epic,
    running: true,
    host: 'server',
    probesReady: probeReady.ready,
    probesDetail: probeReady.detail,
    uiMode,
    pauseRemainingSec: pauseRemainingSec(rt, now),
    haltedForLoss: lossHalted,
    dayStart: rt.dayStartBuy,
    probes: rt.tracker.exportSnapshot(),
  };
}

export function emitLiveRulesHostStatus(io: Server, epic: string, socket?: { emit: (ev: string, payload: unknown) => void }): void {
  const deps = liveRulesDepsRef;
  const payload = deps
    ? buildLiveRulesStatusPayload(deps, epic)
    : {
        epic,
        running: false,
        host: 'server' as const,
        probesReady: true,
        probesDetail: '',
        uiMode: 'stopped',
      };
  if (socket) socket.emit('live_rules_status', payload);
  else io.emit('live_rules_status', payload);
}
