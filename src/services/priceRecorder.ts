/**
 * Price recording to SQLite for later replay/testdrive.
 * Samples at 1/sec per epic. Schema: epic, ts, bid, offer, spread, long_pct, short_pct.
 */

import path from 'path';
import Database from 'better-sqlite3';
import { getDealingFilterOptsForEpic } from './backtestMarketSnapshot';
import {
  DEFAULT_MAX_GAP_PRUNE_MS,
  coveragePctForSampleSpan,
  evaluateDayBacktestReadiness,
  evaluateDayForGapPrune,
  type GapPruneEvaluateOptions,
} from './sampleQuality';

// Resolve DB path from this module's location (works for both ts-node and compiled dist)
const _moduleDir = path.dirname(__dirname); // src/services -> src, or dist/services -> dist
const _projectRoot = path.resolve(_moduleDir, '..');
const DB_PATH = process.env.PRICE_RECORDS_DB || path.join(_projectRoot, 'price_records.db');
const SAMPLE_INTERVAL_MS = 1000;

let db: Database.Database | null = null;
let recording = false;
let lastSampleTsByEpic: Record<string, number> = {};
/** Throttle for auto-save while live streaming on Trade (when Research recording is off). */
let lastStreamSampleTsByEpic: Record<string, number> = {};
let sessionSampleCount = 0;
let sessionStartTs = 0;
let lastDbErrorLogTs = 0;
const DB_ERROR_LOG_INTERVAL_MS = 60000;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_samples (
        epic    TEXT    NOT NULL,
        ts      INTEGER NOT NULL,
        bid     REAL    NOT NULL,
        offer   REAL    NOT NULL,
        spread  REAL    NOT NULL,
        long_pct REAL,
        short_pct REAL,
        PRIMARY KEY (epic, ts)
      )
    `);
    try { db.exec('ALTER TABLE price_samples ADD COLUMN long_pct REAL'); } catch { /* exists */ }
    try { db.exec('ALTER TABLE price_samples ADD COLUMN short_pct REAL'); } catch { /* exists */ }
  }
  return db;
}

/** Local calendar day bounds (matches strftime localtime day keys). */
function dayLocalBoundsMs(day: string): { fromTs: number; toTsExclusive: number } {
  const fromTs = new Date(`${day}T00:00:00`).getTime();
  return { fromTs, toTsExclusive: fromTs + 86400000 };
}

function ensureClosed(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface RecordingStatus {
  recording: boolean;
  epic: string | null;
  sampleCount: number;
  durationMs: number;
}

export function isRecording(): boolean {
  return recording;
}

export function startRecording(): void {
  if (recording) return;
  recording = true;
  lastSampleTsByEpic = {};
  sessionSampleCount = 0;
  sessionStartTs = Date.now();
}

export function stopRecording(): void {
  recording = false;
}

export function getRecordingStatus(): RecordingStatus {
  return {
    recording,
    epic: null, // Caller provides epic from config
    sampleCount: sessionSampleCount,
    durationMs: sessionStartTs > 0 ? Date.now() - sessionStartTs : 0,
  };
}

export interface PriceData {
  bid: string;
  offer: string;
  spread: string;
}

export interface ClientSentiment {
  longPct: number;
  shortPct: number;
}

function insertPriceSample(
  epic: string,
  now: number,
  bid: number,
  offer: number,
  spread: number,
  sentiment?: ClientSentiment | null
): boolean {
  const longPct = sentiment && typeof sentiment.longPct === 'number' ? sentiment.longPct : null;
  const shortPct = sentiment && typeof sentiment.shortPct === 'number' ? sentiment.shortPct : null;
  try {
    const database = getDb();
    const stmt = database.prepare(
      'INSERT OR IGNORE INTO price_samples (epic, ts, bid, offer, spread, long_pct, short_pct) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(epic, now, bid, offer, spread, longPct, shortPct);
    return true;
  } catch (err) {
    const ts = Date.now();
    if (ts - lastDbErrorLogTs >= DB_ERROR_LOG_INTERVAL_MS) {
      lastDbErrorLogTs = ts;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[priceRecorder] DB write failed:', msg);
    }
    return false;
  }
}

export function recordPrice(epic: string, data: PriceData, sentiment?: ClientSentiment | null): boolean {
  if (!recording || !epic) return false;

  const bid = parseFloat(data.bid);
  const offer = parseFloat(data.offer);
  const spread = parseFloat(data.spread);
  if (isNaN(bid) || isNaN(offer)) return false;

  const now = Date.now();
  const last = lastSampleTsByEpic[epic] ?? 0;
  if (now - last < SAMPLE_INTERVAL_MS) return false;

  lastSampleTsByEpic[epic] = now;
  lastStreamSampleTsByEpic[epic] = now;
  if (!insertPriceSample(epic, now, bid, offer, isNaN(spread) ? 0 : spread, sentiment)) return false;
  sessionSampleCount++;
  return true;
}

/**
 * Persist live stream ticks for the Trade chart (same DB as Research recordings).
 * Skipped while Research recording is active — recordPrice already writes.
 */
export function recordStreamSample(epic: string, data: PriceData, sentiment?: ClientSentiment | null): boolean {
  if (!epic || recording) return false;
  const bid = parseFloat(data.bid);
  const offer = parseFloat(data.offer);
  const spread = parseFloat(data.spread);
  if (isNaN(bid) || isNaN(offer)) return false;
  const now = Date.now();
  const last = lastStreamSampleTsByEpic[epic] ?? 0;
  if (now - last < SAMPLE_INTERVAL_MS) return false;
  lastStreamSampleTsByEpic[epic] = now;
  return insertPriceSample(epic, now, bid, offer, isNaN(spread) ? 0 : spread, sentiment);
}

export function closePriceRecorder(): void {
  stopRecording();
  ensureClosed();
}

export interface RecordedSample {
  epic: string;
  ts: number;
  bid: number;
  offer: number;
  spread: number;
  longPct: number | null;
  shortPct: number | null;
}

export function getRecordedSamples(epic: string): RecordedSample[] {
  return getRecordedSamplesFiltered(epic);
}

/** Get samples with optional filter. Avoids loading entire DB when days/range specified. */
export function getRecordedSamplesFiltered(
  epic: string,
  opts?: { fromTs?: number; toTs?: number; days?: string[] }
): RecordedSample[] {
  try {
    const database = getDb();
    let sql = 'SELECT epic, ts, bid, offer, spread, long_pct, short_pct FROM price_samples WHERE epic = ?';
    const params: (string | number)[] = [epic];
    if (opts?.days && opts.days.length > 0) {
      const dayClauses: string[] = [];
      for (const day of opts.days) {
        const { fromTs, toTsExclusive } = dayLocalBoundsMs(day);
        dayClauses.push('(ts >= ? AND ts < ?)');
        params.push(fromTs, toTsExclusive);
      }
      sql += ` AND (${dayClauses.join(' OR ')})`;
    } else if (opts?.fromTs != null || opts?.toTs != null) {
      if (opts.fromTs != null) {
        sql += ' AND ts >= ?';
        params.push(opts.fromTs);
      }
      if (opts.toTs != null) {
        sql += ' AND ts <= ?';
        params.push(opts.toTs);
      }
    }
    sql += ' ORDER BY ts ASC';
    const rows = database.prepare(sql).all(...params) as Array<{ epic: string; ts: number; bid: number; offer: number; spread: number; long_pct: number | null; short_pct: number | null }>;
    return rows.map((r) => ({
      epic: r.epic,
      ts: r.ts,
      bid: r.bid,
      offer: r.offer,
      spread: r.spread,
      longPct: r.long_pct,
      shortPct: r.short_pct,
    }));
  } catch {
    return [];
  }
}

export function getRecordedSampleCount(epic: string): number {
  try {
    const database = getDb();
    const row = database.prepare('SELECT COUNT(*) as c FROM price_samples WHERE epic = ?').get(epic) as { c: number };
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Returns distinct epics that have recorded samples. */
export function getEpicsWithData(): string[] {
  try {
    const database = getDb();
    const rows = database.prepare('SELECT DISTINCT epic FROM price_samples ORDER BY epic').all() as Array<{ epic: string }>;
    return rows.map((r) => r.epic).filter(Boolean);
  } catch {
    return [];
  }
}

/** Exposed for debugging - DB path in use. */
export function getDbPath(): string {
  return DB_PATH;
}

/** Returns distinct dates (YYYY-MM-DD) that have recorded samples for the epic, sorted ascending. */
export function getRecordedDays(epic: string): string[] {
  try {
    const database = getDb();
    const rows = database.prepare(
      `SELECT DISTINCT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') as day
       FROM price_samples WHERE epic = ? ORDER BY day ASC`
    ).all(epic) as Array<{ day: string }>;
    return rows.map((r) => r.day).filter(Boolean);
  } catch {
    return [];
  }
}

/** Returns days with sample count for the epic, sorted ascending. */
export function getDayStats(epic: string): { day: string; count: number; epic?: string; coveragePct: number }[] {
  try {
    const database = getDb();
    const rows = database.prepare(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') as day,
              COUNT(*) as count, MIN(ts) as firstTs, MAX(ts) as lastTs
       FROM price_samples WHERE epic = ?
       GROUP BY 1 ORDER BY 1 ASC`
    ).all(epic) as Array<{ day: string; count: number; firstTs: number; lastTs: number }>;
    return rows.filter((r) => r.day).map((r) => ({
      day: r.day,
      count: Number(r.count),
      epic,
      coveragePct: coveragePctForSampleSpan(Number(r.count), Number(r.firstTs), Number(r.lastTs)),
    }));
  } catch {
    return [];
  }
}

export interface RecordedDayStat {
  day: string;
  count: number;
  epic: string;
  /** Coverage over first→last sample that day (legacy list metric). */
  coveragePct: number;
  /** Good for backtest: ≥90% samples during IG dealing hours, no gap >10 min while dealing. */
  backtestReady?: boolean;
  dealingCoveragePct?: number;
  maxGapMsInDealing?: number;
  backtestNotReadyReasons?: string[];
}

/** Returns days with count and epic for ALL epics in the DB, sorted by day then epic. */
export function getAllDayStats(): RecordedDayStat[] {
  try {
    const database = getDb();
    const rows = database.prepare(
      `SELECT epic, strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') as day,
              COUNT(*) as count, MIN(ts) as firstTs, MAX(ts) as lastTs
       FROM price_samples
       GROUP BY epic, day ORDER BY day ASC, epic ASC`
    ).all() as Array<{ epic: string; day: string; count: number; firstTs: number; lastTs: number }>;
    return rows.filter((r) => r.day && r.epic).map((r) => ({
      day: r.day,
      count: Number(r.count),
      epic: r.epic,
      coveragePct: coveragePctForSampleSpan(Number(r.count), Number(r.firstTs), Number(r.lastTs)),
    }));
  } catch {
    return [];
  }
}

/** Day list stats plus backtest readiness from saved dealing schedule per epic. */
export function getAllDayStatsWithBacktestReadiness(): RecordedDayStat[] {
  const base = getAllDayStats();
  if (base.length === 0) return base;

  const byEpic = new Map<string, RecordedDayStat[]>();
  for (const row of base) {
    const list = byEpic.get(row.epic);
    if (list) list.push(row);
    else byEpic.set(row.epic, [row]);
  }

  for (const [epic, rows] of byEpic) {
    const dealingOpts = getDealingFilterOptsForEpic(epic);
    const days = rows.map((r) => r.day);
    const samples = getRecordedSamplesFiltered(epic, { days });
    const byDay = new Map<string, typeof samples>();
    for (const s of samples) {
      const dayKey = dayKeyLocalFromTs(s.ts);
      const arr = byDay.get(dayKey);
      if (arr) arr.push(s);
      else byDay.set(dayKey, [s]);
    }
    for (const row of rows) {
      const daySamples = byDay.get(row.day) ?? [];
      const readiness = evaluateDayBacktestReadiness(row.day, daySamples, dealingOpts);
      row.backtestReady = readiness.backtestReady;
      row.dealingCoveragePct = readiness.dealingCoveragePct;
      row.maxGapMsInDealing = readiness.maxGapMsInDealing;
      row.backtestNotReadyReasons = readiness.reasons.length > 0 ? readiness.reasons : undefined;
    }
  }

  return base;
}

function dayKeyLocalFromTs(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

/** Delete samples for the given epic on the given days. Returns number of rows deleted. */
export function deleteSamplesByDays(epic: string, days: string[]): number {
  const valid = days.filter((d) => typeof d === 'string' && YYYY_MM_DD.test(d));
  if (!valid.length) return 0;
  try {
    const database = getDb();
    const placeholders = valid.map(() => '?').join(',');
    const stmt = database.prepare(
      `DELETE FROM price_samples WHERE epic = ? AND strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') IN (${placeholders})`
    );
    const result = stmt.run(epic, ...valid);
    return result.changes;
  } catch {
    return 0;
  }
}

/** Delete days that have fewer than minCount samples. Returns { deleted: number, daysRemoved: string[] }. */
export function deleteSparseDays(epic: string, minCount: number): { deleted: number; daysRemoved: string[] } {
  const stats = getDayStats(epic);
  const toRemove = stats.filter((s) => s.count < minCount).map((s) => s.day);
  if (toRemove.length === 0) return { deleted: 0, daysRemoved: [] };
  const deleted = deleteSamplesByDays(epic, toRemove);
  return { deleted, daysRemoved: toRemove };
}

export interface GapPruneDayDetail {
  day: string;
  reasons: string[];
}

function resolveGapPruneEvalOpts(options?: GapPruneEvaluateOptions): GapPruneEvaluateOptions {
  const maxGapMs =
    typeof options?.maxGapMs === 'number' && options.maxGapMs > 0
      ? options.maxGapMs
      : DEFAULT_MAX_GAP_PRUNE_MS;
  return { ...options, maxGapMs };
}

/** List days that would be removed by gap/coverage prune (no deletion). */
export function previewGapDays(
  epic: string,
  options?: GapPruneEvaluateOptions
): { daysRemoved: string[]; dayDetails: GapPruneDayDetail[]; samplesToDelete: number } {
  const evalOpts = resolveGapPruneEvalOpts(options);
  const days = getRecordedDays(epic);
  const toRemove: string[] = [];
  const dayDetails: GapPruneDayDetail[] = [];
  let samplesToDelete = 0;
  for (const day of days) {
    const samples = getRecordedSamplesFiltered(epic, { days: [day] });
    const verdict = evaluateDayForGapPrune(day, samples, evalOpts);
    if (verdict.prune) {
      toRemove.push(day);
      dayDetails.push({ day, reasons: verdict.reasons });
      samplesToDelete += samples.length;
    }
  }
  return { daysRemoved: toRemove, dayDetails, samplesToDelete };
}

/** Delete days with max gap over threshold and/or low coverage over the day's active span. */
export function deleteGapDays(
  epic: string,
  options?: GapPruneEvaluateOptions
): { deleted: number; daysRemoved: string[]; dayDetails: GapPruneDayDetail[] } {
  const { daysRemoved, dayDetails } = previewGapDays(epic, options);
  if (daysRemoved.length === 0) return { deleted: 0, daysRemoved: [], dayDetails: [] };
  const deleted = deleteSamplesByDays(epic, daysRemoved);
  return { deleted, daysRemoved, dayDetails };
}
