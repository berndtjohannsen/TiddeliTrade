/**
 * Detect gaps, sparse coverage, and glitches in recorded price samples (1 Hz expected).
 */
import type { RecordedSample } from './priceRecorder';

export interface SampleQualityDayRow {
  day: string;
  count: number;
  spanMs: number;
  /** Samples expected over first→last span at 1/sec. */
  expectedInSpan: number;
  coveragePct: number;
  gapsOver5s: number;
  gapsOver30s: number;
  gapsOver60s: number;
  maxGapMs: number;
  estimatedMissingSamples: number;
  invalidSpreadCount: number;
  largeMidJumpCount: number;
  warnings: string[];
}

export interface SampleQualityReport {
  hasWarnings: boolean;
  summaryWarnings: string[];
  totalSamples: number;
  dayCount: number;
  gapsOver5s: number;
  gapsOver30s: number;
  gapsOver60s: number;
  maxGapMs: number;
  estimatedMissingSamples: number;
  largeMidJumpCount: number;
  invalidSpreadCount: number;
  days: SampleQualityDayRow[];
}

export interface SampleQualityOptions {
  /** Expected ms between samples (default 1000). */
  expectedIntervalMs?: number;
  /** Flag days with fewer samples than this (default 3600 ≈ 1 h). */
  sparseDayThreshold?: number;
  /** Coverage below this % of span triggers a warning (default 85). */
  lowCoveragePct?: number;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_SPARSE_THRESHOLD = 3600;
const DEFAULT_LOW_COVERAGE_PCT = 85;
const GAP_5S = 5000;
const GAP_30S = 30000;
const GAP_60S = 60000;

function dayKeyLocal(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatGapMs(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function analyzeDaySamples(
  day: string,
  samples: RecordedSample[],
  opts: Required<SampleQualityOptions>
): SampleQualityDayRow {
  const warnings: string[] = [];
  const count = samples.length;
  if (count === 0) {
    return {
      day,
      count: 0,
      spanMs: 0,
      expectedInSpan: 0,
      coveragePct: 0,
      gapsOver5s: 0,
      gapsOver30s: 0,
      gapsOver60s: 0,
      maxGapMs: 0,
      estimatedMissingSamples: 0,
      invalidSpreadCount: 0,
      largeMidJumpCount: 0,
      warnings: ['No samples'],
    };
  }

  const sorted = samples.slice().sort((a, b) => a.ts - b.ts);
  const firstTs = sorted[0].ts;
  const lastTs = sorted[sorted.length - 1].ts;
  const spanMs = Math.max(0, lastTs - firstTs);
  const expectedInSpan = spanMs > 0 ? Math.floor(spanMs / opts.expectedIntervalMs) + 1 : 1;
  const coveragePct = expectedInSpan > 0 ? Math.min(100, (count / expectedInSpan) * 100) : 100;

  let gapsOver5s = 0;
  let gapsOver30s = 0;
  let gapsOver60s = 0;
  let maxGapMs = 0;
  let estimatedMissingSamples = 0;
  let invalidSpreadCount = 0;
  const midDeltas: number[] = [];
  let largeMidJumpCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const mid = (s.bid + s.offer) / 2;
    if (s.offer <= s.bid || s.spread < 0) invalidSpreadCount++;

    if (i > 0) {
      const prev = sorted[i - 1];
      const delta = s.ts - prev.ts;
      if (delta > maxGapMs) maxGapMs = delta;
      if (delta > GAP_5S) gapsOver5s++;
      if (delta > GAP_30S) gapsOver30s++;
      if (delta > GAP_60S) gapsOver60s++;
      if (delta > opts.expectedIntervalMs * 1.5) {
        estimatedMissingSamples += Math.max(0, Math.floor(delta / opts.expectedIntervalMs) - 1);
      }
      const prevMid = (prev.bid + prev.offer) / 2;
      midDeltas.push(Math.abs(mid - prevMid));
    }
  }

  const medJump = median(midDeltas);
  const jumpThreshold = Math.max(medJump * 10, Math.abs((sorted[0].bid + sorted[0].offer) / 2) * 0.001, 0.01);
  for (const d of midDeltas) {
    if (d > jumpThreshold) largeMidJumpCount++;
  }

  if (count < opts.sparseDayThreshold) {
    warnings.push(`Only ${count.toLocaleString()} samples (sparse day — under ${opts.sparseDayThreshold.toLocaleString()})`);
  }
  if (spanMs > 60000 && coveragePct < opts.lowCoveragePct) {
    warnings.push(`~${coveragePct.toFixed(0)}% coverage over active span (${formatGapMs(spanMs)}) — many seconds missing`);
  }
  if (gapsOver60s > 0) {
    warnings.push(`${gapsOver60s} gap(s) over 1 min (longest ${formatGapMs(maxGapMs)})`);
  } else if (gapsOver30s > 0) {
    warnings.push(`${gapsOver30s} gap(s) over 30s (longest ${formatGapMs(maxGapMs)})`);
  } else if (gapsOver5s > 3) {
    warnings.push(`${gapsOver5s} gaps over 5s — probe averages may be distorted`);
  }
  if (largeMidJumpCount > 0) {
    warnings.push(`${largeMidJumpCount} large mid-price jump(s) — possible stream glitch`);
  }
  if (invalidSpreadCount > 0) {
    warnings.push(`${invalidSpreadCount} invalid bid/offer spread(s)`);
  }

  return {
    day,
    count,
    spanMs,
    expectedInSpan,
    coveragePct,
    gapsOver5s,
    gapsOver30s,
    gapsOver60s,
    maxGapMs,
    estimatedMissingSamples,
    invalidSpreadCount,
    largeMidJumpCount,
    warnings,
  };
}

/** Analyse recorded samples grouped by local calendar day. */
export function analyzeSampleQuality(
  samples: RecordedSample[],
  options?: SampleQualityOptions
): SampleQualityReport {
  const opts: Required<SampleQualityOptions> = {
    expectedIntervalMs: options?.expectedIntervalMs ?? DEFAULT_INTERVAL_MS,
    sparseDayThreshold: options?.sparseDayThreshold ?? DEFAULT_SPARSE_THRESHOLD,
    lowCoveragePct: options?.lowCoveragePct ?? DEFAULT_LOW_COVERAGE_PCT,
  };

  const byDay = new Map<string, RecordedSample[]>();
  for (const s of samples) {
    const day = dayKeyLocal(s.ts);
    const arr = byDay.get(day);
    if (arr) arr.push(s);
    else byDay.set(day, [s]);
  }

  const days: SampleQualityDayRow[] = [];
  for (const day of Array.from(byDay.keys()).sort()) {
    days.push(analyzeDaySamples(day, byDay.get(day)!, opts));
  }

  let gapsOver5s = 0;
  let gapsOver30s = 0;
  let gapsOver60s = 0;
  let maxGapMs = 0;
  let estimatedMissingSamples = 0;
  let largeMidJumpCount = 0;
  let invalidSpreadCount = 0;
  const summaryWarnings: string[] = [];

  for (const d of days) {
    gapsOver5s += d.gapsOver5s;
    gapsOver30s += d.gapsOver30s;
    gapsOver60s += d.gapsOver60s;
    if (d.maxGapMs > maxGapMs) maxGapMs = d.maxGapMs;
    estimatedMissingSamples += d.estimatedMissingSamples;
    largeMidJumpCount += d.largeMidJumpCount;
    invalidSpreadCount += d.invalidSpreadCount;
  }

  const sparseDays = days.filter((d) => d.count < opts.sparseDayThreshold);
  if (sparseDays.length > 0) {
    const names = sparseDays.map((d) => `${d.day} (${d.count.toLocaleString()})`).join(', ');
    summaryWarnings.push(
      `${sparseDays.length} sparse day(s) under ${opts.sparseDayThreshold.toLocaleString()} samples: ${names}`
    );
  }

  const lowCoverageDays = days.filter((d) => d.spanMs > 60000 && d.coveragePct < opts.lowCoveragePct);
  if (lowCoverageDays.length > 0 && lowCoverageDays.length !== sparseDays.length) {
    summaryWarnings.push(
      `${lowCoverageDays.length} day(s) with gaps in recording (under ${opts.lowCoveragePct}% of active time span)`
    );
  }

  if (gapsOver60s > 0) {
    summaryWarnings.push(
      `Recording interrupted: ${gapsOver60s} gap(s) over 1 minute (longest ${formatGapMs(maxGapMs)}). Rules using short/medium probes may behave differently across gaps.`
    );
  } else if (gapsOver30s > 0) {
    summaryWarnings.push(
      `${gapsOver30s} recording gap(s) over 30 seconds (longest ${formatGapMs(maxGapMs)})`
    );
  } else if (gapsOver5s > 5) {
    summaryWarnings.push(`${gapsOver5s} recording gap(s) over 5 seconds — chart may show visible jumps`);
  }

  if (estimatedMissingSamples > 100) {
    summaryWarnings.push(
      `~${estimatedMissingSamples.toLocaleString()} missing seconds estimated (expected 1 sample/sec)`
    );
  }

  if (largeMidJumpCount > 0) {
    summaryWarnings.push(`${largeMidJumpCount} unusually large price step(s) — treat with caution near those times`);
  }

  if (invalidSpreadCount > 0) {
    summaryWarnings.push(`${invalidSpreadCount} sample(s) with invalid bid/offer`);
  }

  const hasWarnings = summaryWarnings.length > 0 || days.some((d) => d.warnings.length > 0);

  if (!hasWarnings && samples.length > 0) {
    summaryWarnings.push('No major recording anomalies detected for the analysed period.');
  }

  return {
    hasWarnings,
    summaryWarnings,
    totalSamples: samples.length,
    dayCount: days.length,
    gapsOver5s,
    gapsOver30s,
    gapsOver60s,
    maxGapMs,
    estimatedMissingSamples,
    largeMidJumpCount,
    invalidSpreadCount,
    days,
  };
}
