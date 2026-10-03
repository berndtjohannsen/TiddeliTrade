/**
 * Persisted dealing schedule + day-start prices for reproducible backtests.
 * Snapshots are stored per instrument; analyse reuses them instead of refetching IG.
 */

import { loadConfig, updateConfig, type InstrumentSettings } from '../config';
import type { IgSession } from './ig';
import { getMarketTradingInfo, getDayStartPricesInRange, type MarketTradingInfo } from './ig';
import {
  type DealingWeekLondon,
  dealingWeekFromMarketTimes,
  defaultDealingWeekLondonMonFri,
} from './dealingSchedule';
import type { ProbeSampleFilterOpts } from './probeSamples';

export type StoredDealingScheduleSource = 'ig' | 'default' | 'off';

export interface BacktestDealingSnapshot {
  is24_7: boolean;
  dealingWeekLondon: DealingWeekLondon | null;
  dealingScheduleSource: StoredDealingScheduleSource;
  savedAt: number;
}

export interface ResolvedBacktestDealing {
  is24_7: boolean;
  dealingWeekLondon: DealingWeekLondon | null;
  /** ig/default/off = freshly resolved; snapshot = loaded from saved instrument settings */
  dealingScheduleSource: StoredDealingScheduleSource | 'snapshot';
  usedSnapshot: boolean;
  snapshotSavedAt: number | null;
}

function isValidDealingWeek(week: unknown): week is DealingWeekLondon {
  return Array.isArray(week) && week.length === 7;
}

function readStoredDealingSnapshot(inst: InstrumentSettings | null | undefined): BacktestDealingSnapshot | null {
  if (!inst || inst.backtestDealingSnapshotAt == null) return null;
  const source = inst.backtestDealingScheduleSource;
  if (source !== 'ig' && source !== 'default' && source !== 'off') return null;
  return {
    is24_7: !!inst.backtestIs24_7,
    dealingWeekLondon: isValidDealingWeek(inst.backtestDealingWeekLondon) ? inst.backtestDealingWeekLondon : null,
    dealingScheduleSource: source,
    savedAt: inst.backtestDealingSnapshotAt,
  };
}

export function buildDealingSnapshotFromMarketInfo(info: MarketTradingInfo): BacktestDealingSnapshot {
  const savedAt = Date.now();
  if (info.is24_7) {
    return { is24_7: true, dealingWeekLondon: null, dealingScheduleSource: 'off', savedAt };
  }
  const week = dealingWeekFromMarketTimes(info.marketTimes, info.is24_7);
  if (week) {
    return { is24_7: false, dealingWeekLondon: week, dealingScheduleSource: 'ig', savedAt };
  }
  return {
    is24_7: false,
    dealingWeekLondon: defaultDealingWeekLondonMonFri(),
    dealingScheduleSource: 'default',
    savedAt,
  };
}

export function dealingSnapshotToInstrumentPatch(snapshot: BacktestDealingSnapshot): Partial<InstrumentSettings> {
  return {
    backtestIs24_7: snapshot.is24_7,
    backtestDealingWeekLondon: snapshot.dealingWeekLondon,
    backtestDealingScheduleSource: snapshot.dealingScheduleSource,
    backtestDealingSnapshotAt: snapshot.savedAt,
  };
}

export function persistBacktestMarketSnapshot(epic: string, patch: Partial<InstrumentSettings>): void {
  if (!epic || !patch || Object.keys(patch).length === 0) return;
  updateConfig({ ui: { instruments: { [epic]: patch } } });
}

export function saveDealingSnapshot(epic: string, snapshot: BacktestDealingSnapshot): void {
  persistBacktestMarketSnapshot(epic, dealingSnapshotToInstrumentPatch(snapshot));
}

async function fetchDealingSnapshotFromIg(
  session: IgSession | null,
  epic: string,
  fallbackIs24_7: boolean
): Promise<BacktestDealingSnapshot> {
  if (!session) {
    if (fallbackIs24_7) {
      return { is24_7: true, dealingWeekLondon: null, dealingScheduleSource: 'off', savedAt: Date.now() };
    }
    return {
      is24_7: false,
      dealingWeekLondon: defaultDealingWeekLondonMonFri(),
      dealingScheduleSource: 'default',
      savedAt: Date.now(),
    };
  }
  try {
    const info = await getMarketTradingInfo(session, epic);
    return buildDealingSnapshotFromMarketInfo(info);
  } catch {
    if (fallbackIs24_7) {
      return { is24_7: true, dealingWeekLondon: null, dealingScheduleSource: 'off', savedAt: Date.now() };
    }
    return {
      is24_7: false,
      dealingWeekLondon: defaultDealingWeekLondonMonFri(),
      dealingScheduleSource: 'default',
      savedAt: Date.now(),
    };
  }
}

function resolvedFromSnapshot(stored: BacktestDealingSnapshot): ResolvedBacktestDealing {
  return {
    is24_7: stored.is24_7,
    dealingWeekLondon: stored.is24_7 ? null : stored.dealingWeekLondon,
    dealingScheduleSource: 'snapshot',
    usedSnapshot: true,
    snapshotSavedAt: stored.savedAt,
  };
}

function resolvedFromFresh(snapshot: BacktestDealingSnapshot): ResolvedBacktestDealing {
  return {
    is24_7: snapshot.is24_7,
    dealingWeekLondon: snapshot.is24_7 ? null : snapshot.dealingWeekLondon,
    dealingScheduleSource: snapshot.dealingScheduleSource,
    usedSnapshot: false,
    snapshotSavedAt: snapshot.savedAt,
  };
}

/**
 * Use saved dealing schedule when present; otherwise fetch once from IG (or default), persist, then use.
 */
export async function resolveDealingForBacktest(
  epic: string,
  inst: InstrumentSettings | null | undefined,
  session: IgSession | null,
  fallbackIs24_7: boolean
): Promise<ResolvedBacktestDealing> {
  const stored = readStoredDealingSnapshot(inst);
  if (stored) return resolvedFromSnapshot(stored);

  const fresh = await fetchDealingSnapshotFromIg(session, epic, fallbackIs24_7);
  saveDealingSnapshot(epic, fresh);
  return resolvedFromFresh(fresh);
}

/**
 * Live scheduler: prefer a fresh IG dealing schedule when logged in (not stale backtest snapshot).
 */
export async function resolveDealingForLiveSchedule(
  epic: string,
  inst: InstrumentSettings | null | undefined,
  session: IgSession | null
): Promise<ResolvedBacktestDealing> {
  if (session) {
    const fresh = await fetchDealingSnapshotFromIg(session, epic, false);
    saveDealingSnapshot(epic, fresh);
    return resolvedFromFresh(fresh);
  }
  const stored = readStoredDealingSnapshot(inst);
  if (stored) return resolvedFromSnapshot(stored);
  const fresh = await fetchDealingSnapshotFromIg(null, epic, false);
  return resolvedFromFresh(fresh);
}

function mergeDayStartCache(
  inst: InstrumentSettings | null | undefined
): Record<string, number> {
  const raw = inst?.backtestDayStartByLondonDate;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [day, val] of Object.entries(raw)) {
    if (typeof val === 'number' && !isNaN(val)) out[day] = val;
  }
  return out;
}

/**
 * Day-start mids for backtest days. Uses cached values when present; fetches missing days once, then caches.
 * Days still missing after fetch rely on first-sample fallback inside the simulator (deterministic).
 */
export async function resolveDayStartsForBacktest(
  epic: string,
  days: string[],
  inst: InstrumentSettings | null | undefined,
  session: IgSession | null,
  logFn: (msg: string) => void
): Promise<{ dayStarts: Record<string, number>; cachedDayCount: number; missingDayCount: number }> {
  const needed = Array.from(new Set(days.filter(Boolean))).sort();
  if (needed.length === 0) {
    return { dayStarts: {}, cachedDayCount: 0, missingDayCount: 0 };
  }

  let cached = mergeDayStartCache(inst);
  const pickCached = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const day of needed) {
      if (cached[day] != null) out[day] = cached[day];
    }
    return out;
  };

  let missing = needed.filter((d) => cached[d] == null);

  if (missing.length > 0 && session) {
    try {
      const sorted = needed;
      const fromMs = new Date(sorted[0] + 'T00:00:00').getTime() - 3 * 86400000;
      const toMs = new Date(sorted[sorted.length - 1] + 'T23:59:59').getTime() + 3 * 86400000;
      const fetched = await getDayStartPricesInRange(session, epic, fromMs, toMs);
      if (Object.keys(fetched).length > 0) {
        cached = { ...cached, ...fetched };
        persistBacktestMarketSnapshot(epic, { backtestDayStartByLondonDate: cached });
        logFn(
          `[Backtest] Day start: cached ${Object.keys(fetched).length} IG daily open(s) for reproducible backtests`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logFn('[Backtest] Day start: IG fetch failed – ' + msg + ' (using first sample mid where uncached)');
    }
    missing = needed.filter((d) => cached[d] == null);
  }

  const dayStarts = pickCached();
  const cachedDayCount = Object.keys(dayStarts).length;
  const missingDayCount = needed.length - cachedDayCount;

  if (cachedDayCount > 0 && missingDayCount === 0) {
    logFn(`[Backtest] Day start: ${cachedDayCount} cached IG open(s) (reproducible snapshot)`);
  } else if (cachedDayCount > 0 && missingDayCount > 0) {
    logFn(
      `[Backtest] Day start: ${cachedDayCount} cached; ${missingDayCount} day(s) use first sample mid (reproducible)`
    );
  } else if (missingDayCount > 0) {
    logFn(`[Backtest] Day start: no IG cache — first sample mid per London day (reproducible)`);
  }

  return { dayStarts, cachedDayCount, missingDayCount };
}

/** Reload instrument row after persist (same epic). */
export function getInstrumentSettings(epic: string): InstrumentSettings | null {
  const cfg = loadConfig();
  return cfg.ui?.instruments?.[epic] ?? null;
}

/** Dealing filter for recorded samples (saved IG snapshot, else default Mon–Fri London). */
export function getDealingFilterOptsForEpic(epic: string): ProbeSampleFilterOpts {
  const stored = readStoredDealingSnapshot(getInstrumentSettings(epic));
  if (stored?.is24_7) return { is24_7: true, dealingWeekLondon: null };
  if (stored?.dealingWeekLondon) {
    return { is24_7: false, dealingWeekLondon: stored.dealingWeekLondon };
  }
  return { is24_7: false, dealingWeekLondon: defaultDealingWeekLondonMonFri() };
}
