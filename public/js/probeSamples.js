/**
 * Probe sample eligibility and coverage (browser mirror of src/services/probeSamples.ts).
 */
export var PROBE_SAMPLE_INTERVAL_MS = 1000;
export var PROBE_LOW_COVERAGE_PCT = 85;

var LONDON_WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
var londonWeekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', weekday: 'short' });
var londonHmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });

function londonWeekdayIndexSun0(ts) {
  var part = londonWeekdayFmt.formatToParts(new Date(ts)).find(function (p) { return p.type === 'weekday'; });
  return LONDON_WD[part && part.value ? part.value : ''] != null ? LONDON_WD[part.value] : 0;
}

function londonMinutesSinceMidnight(ts) {
  var parts = londonHmFmt.formatToParts(new Date(ts));
  var h = parseInt((parts.find(function (p) { return p.type === 'hour'; }) || {}).value || '0', 10);
  var m = parseInt((parts.find(function (p) { return p.type === 'minute'; }) || {}).value || '0', 10);
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}

export function defaultDealingWeekLondonMonFri() {
  var slot = { openMin: 8 * 60, closeMin: 21 * 60 + 59 };
  return [null, slot, slot, slot, slot, slot, null];
}

export function isDealingOpenLondon(ts, week) {
  if (!week || week.length !== 7) return true;
  var wd = londonWeekdayIndexSun0(ts);
  var min = londonMinutesSinceMidnight(ts);
  var prevWd = (wd + 6) % 7;
  var prev = week[prevWd];
  if (prev && prev.openMin > prev.closeMin && wd === (prevWd + 1) % 7 && min <= prev.closeMin) return true;
  var today = week[wd];
  if (!today) return false;
  var openMin = today.openMin;
  var closeMin = today.closeMin;
  if (openMin < closeMin) return min >= openMin && min <= closeMin;
  return min >= openMin || min <= closeMin;
}

export function resolveDealingWeekForProbes(is24_7, dealingWeekLondon) {
  if (is24_7) return null;
  if (dealingWeekLondon && dealingWeekLondon.length === 7) return dealingWeekLondon;
  return defaultDealingWeekLondonMonFri();
}

export function isProbeEligibleSample(sample, opts) {
  if (opts.is24_7) return true;
  var ms = sample.marketState;
  if (ms != null && String(ms).trim() !== '') {
    return String(ms).trim().toUpperCase() === 'TRADEABLE';
  }
  var week = resolveDealingWeekForProbes(opts.is24_7, opts.dealingWeekLondon);
  return isDealingOpenLondon(sample.ts, week);
}

export function computeOpenMsInWindow(windowStartTs, windowEndTs, opts) {
  if (windowEndTs <= windowStartTs) return 0;
  if (opts.is24_7) return windowEndTs - windowStartTs;
  var week = resolveDealingWeekForProbes(opts.is24_7, opts.dealingWeekLondon);
  var step = 60000;
  var openMs = 0;
  for (var t = windowStartTs; t < windowEndTs; t += step) {
    var chunkEnd = Math.min(t + step, windowEndTs);
    if (isDealingOpenLondon(t, week)) openMs += chunkEnd - t;
  }
  return openMs;
}

function buildCoverageRow(probe, label, count, expectedCount, lowCoveragePct) {
  var coveragePct = expectedCount > 0
    ? Math.min(100, Math.round((count / expectedCount) * 1000) / 10)
    : (count > 0 ? 100 : 0);
  var lowCoverage = expectedCount === 0
    ? count === 0
    : expectedCount >= 10 && coveragePct < lowCoveragePct;
  return { probe: probe, label: label, count: count, expectedCount: expectedCount, coveragePct: coveragePct, lowCoverage: lowCoverage };
}

function warningForRow(row) {
  if (row.expectedCount === 0 && row.count === 0) {
    return row.label + ' probe: market was closed for the entire lookback — no in-market samples.';
  }
  if (row.count === 0 && row.expectedCount > 0) {
    return row.label + ' probe: 0 in-market samples (expected ~' + row.expectedCount + ' at 1 Hz).';
  }
  if (row.lowCoverage && row.coveragePct != null) {
    return row.label + ' probe: sparse in-market data — ' + row.count + ' samples (~' + row.coveragePct + '% of expected ~' + row.expectedCount + ').';
  }
  return null;
}

export function analyzeProbeCoverage(samples, nowTs, probeShortMinutes, probeMediumMinutes, probeLongMinutes, opts, lowCoveragePct) {
  if (lowCoveragePct == null) lowCoveragePct = PROBE_LOW_COVERAGE_PCT;
  var windows = [
    { probe: 'short', label: 'Short', ms: probeShortMinutes * 60 * 1000 },
    { probe: 'medium', label: 'Medium', ms: probeMediumMinutes * 60 * 1000 },
    { probe: 'long', label: 'Long', ms: probeLongMinutes * 60 * 1000 }
  ];
  var rows = [];
  var warnings = [];
  for (var wi = 0; wi < windows.length; wi++) {
    var w = windows[wi];
    var windowStart = nowTs - w.ms;
    var count = 0;
    for (var si = 0; si < samples.length; si++) {
      var s = samples[si];
      if (s.ts >= windowStart && s.ts <= nowTs && isProbeEligibleSample(s, opts)) count++;
    }
    var openMs = computeOpenMsInWindow(windowStart, nowTs, opts);
    var expectedCount = Math.max(0, Math.floor(openMs / PROBE_SAMPLE_INTERVAL_MS));
    var row = buildCoverageRow(w.probe, w.label, count, expectedCount, lowCoveragePct);
    rows.push(row);
    var msg = warningForRow(row);
    if (msg) warnings.push(msg);
  }
  return { rows: rows, warnings: warnings, hasWarnings: warnings.length > 0 };
}

export function formatProbeSampleCount(count, expectedCount, coveragePct) {
  if (expectedCount <= 0) return String(count);
  if (coveragePct != null && coveragePct < PROBE_LOW_COVERAGE_PCT) {
    return count + ' (~' + coveragePct + '%)';
  }
  return String(count);
}

export function probeFilterOptsFromState(state) {
  return {
    is24_7: !!state.is24_7Market,
    dealingWeekLondon: state.dealingWeekLondon || null
  };
}
