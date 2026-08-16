/**
 * Probe sample eligibility and coverage — in-market ticks only; raw stream/recording unchanged.
 */
import {
  type DealingWeekLondon,
  DealingOpenLookup,
  isDealingOpenLondon,
  resolveDealingWeekForProbes,
} from './dealingSchedule';

export const PROBE_SAMPLE_INTERVAL_MS = 1000;
export const PROBE_LOW_COVERAGE_PCT = 85;

export interface ProbeSampleLike {
  ts: number;
  marketState?: string | null;
}

export interface ProbeSampleFilterOpts {
  is24_7: boolean;
  dealingWeekLondon?: DealingWeekLondon | null;
}

/**
 * Live: TRADEABLE when marketState is present. Otherwise IG dealing schedule (same as backtest on recordings).
 */
export function isProbeEligibleSample(sample: ProbeSampleLike, opts: ProbeSampleFilterOpts): boolean {
  if (opts.is24_7) return true;
  const ms = sample.marketState;
  if (ms != null && String(ms).trim() !== '') {
    return String(ms).trim().toUpperCase() === 'TRADEABLE';
  }
  const week = resolveDealingWeekForProbes(opts.is24_7, opts.dealingWeekLondon);
  return isDealingOpenLondon(sample.ts, week);
}

/** One pass over samples — avoids repeated Intl work in backtest probe windows. */
export function precomputeProbeEligibleFlags(
  samples: ProbeSampleLike[],
  opts: ProbeSampleFilterOpts
): boolean[] {
  if (opts.is24_7) return samples.map(() => true);
  const lookup = new DealingOpenLookup(resolveDealingWeekForProbes(opts.is24_7, opts.dealingWeekLondon));
  return samples.map((sample) => {
    const ms = sample.marketState;
    if (ms != null && String(ms).trim() !== '') {
      return String(ms).trim().toUpperCase() === 'TRADEABLE';
    }
    return lookup.isOpen(sample.ts);
  });
}

/** Milliseconds of dealing-open time within [windowStartTs, windowEndTs). */
export function computeOpenMsInWindow(
  windowStartTs: number,
  windowEndTs: number,
  opts: ProbeSampleFilterOpts
): number {
  if (windowEndTs <= windowStartTs) return 0;
  if (opts.is24_7) return windowEndTs - windowStartTs;
  const week = resolveDealingWeekForProbes(opts.is24_7, opts.dealingWeekLondon);
  const step = 60_000;
  let openMs = 0;
  for (let t = windowStartTs; t < windowEndTs; t += step) {
    const chunkEnd = Math.min(t + step, windowEndTs);
    if (isDealingOpenLondon(t, week)) openMs += chunkEnd - t;
  }
  return openMs;
}

export interface ProbeCoverageRow {
  probe: 'short' | 'medium' | 'long';
  label: string;
  count: number;
  expectedCount: number;
  coveragePct: number | null;
  lowCoverage: boolean;
}

export interface ProbeCoverageReport {
  rows: ProbeCoverageRow[];
  warnings: string[];
  hasWarnings: boolean;
}

function countEligibleInWindow<T extends ProbeSampleLike & { mid?: number; probeEligible?: boolean }>(
  samples: T[],
  windowStartTs: number,
  windowEndTs: number,
  opts: ProbeSampleFilterOpts
): number {
  let n = 0;
  for (const s of samples) {
    if (s.ts < windowStartTs || s.ts > windowEndTs) continue;
    if (s.probeEligible === true) {
      n++;
      continue;
    }
    if (s.probeEligible === false) continue;
    if (isProbeEligibleSample(s, opts)) n++;
  }
  return n;
}

function buildCoverageRow(
  probe: 'short' | 'medium' | 'long',
  label: string,
  count: number,
  expectedCount: number,
  lowCoveragePct: number
): ProbeCoverageRow {
  const coveragePct =
    expectedCount > 0 ? Math.min(100, Math.round((count / expectedCount) * 1000) / 10) : (count > 0 ? 100 : 0);
  const lowCoverage =
    expectedCount === 0
      ? count === 0
      : expectedCount >= 10 && (coveragePct ?? 0) < lowCoveragePct;
  return { probe, label, count, expectedCount, coveragePct, lowCoverage };
}

function warningForRow(row: ProbeCoverageRow): string | null {
  if (row.expectedCount === 0 && row.count === 0) {
    return `${row.label} probe: market was closed for the entire lookback — no in-market samples.`;
  }
  if (row.count === 0 && row.expectedCount > 0) {
    return `${row.label} probe: 0 in-market samples (expected ~${row.expectedCount} at 1 Hz).`;
  }
  if (row.lowCoverage && row.coveragePct != null) {
    return `${row.label} probe: sparse in-market data — ${row.count} samples (~${row.coveragePct}% of expected ~${row.expectedCount}).`;
  }
  return null;
}

export function analyzeProbeCoverage(
  samples: (ProbeSampleLike & { mid?: number })[],
  nowTs: number,
  probeShortMinutes: number,
  probeMediumMinutes: number,
  probeLongMinutes: number,
  opts: ProbeSampleFilterOpts,
  lowCoveragePct = PROBE_LOW_COVERAGE_PCT
): ProbeCoverageReport {
  const windows: { probe: 'short' | 'medium' | 'long'; label: string; ms: number }[] = [
    { probe: 'short', label: 'Short', ms: probeShortMinutes * 60 * 1000 },
    { probe: 'medium', label: 'Medium', ms: probeMediumMinutes * 60 * 1000 },
    { probe: 'long', label: 'Long', ms: probeLongMinutes * 60 * 1000 },
  ];
  const rows: ProbeCoverageRow[] = [];
  const warnings: string[] = [];
  for (const w of windows) {
    const windowStart = nowTs - w.ms;
    const count = countEligibleInWindow(samples, windowStart, nowTs, opts);
    const openMs = computeOpenMsInWindow(windowStart, nowTs, opts);
    const expectedCount = Math.max(0, Math.floor(openMs / PROBE_SAMPLE_INTERVAL_MS));
    const row = buildCoverageRow(w.probe, w.label, count, expectedCount, lowCoveragePct);
    rows.push(row);
    const msg = warningForRow(row);
    if (msg) warnings.push(msg);
  }
  return { rows, warnings, hasWarnings: warnings.length > 0 };
}

export function formatProbeSampleCount(count: number, expectedCount: number, coveragePct: number | null): string {
  if (expectedCount <= 0) return String(count);
  if (coveragePct != null && coveragePct < PROBE_LOW_COVERAGE_PCT) {
    return `${count} (~${coveragePct}%)`;
  }
  return String(count);
}
