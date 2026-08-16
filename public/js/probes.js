/**
 * Probes – price statistics at configurable short/medium/long periods.
 * In-market samples only (TRADEABLE live, IG dealing schedule for backfill/backtest).
 */
import {
  analyzeProbeCoverage,
  formatProbeSampleCount,
  isProbeEligibleSample,
  probeFilterOptsFromState
} from './probeSamples.js';

const MAX_SAMPLES = 100000;
const SAMPLE_INTERVAL_MS = 1000;
var lastSampleTs = 0;

export function initProbes(socket, state, log) {
  state.priceHistory = state.priceHistory || [];
  var shortInput = document.getElementById('probeShortPeriod');
  var mediumInput = document.getElementById('probeMediumPeriod');
  var longInput = document.getElementById('probeLongPeriod');
  var periodInputsWrap = document.getElementById('probesPeriodInputs');
  var sessionStopBtn = document.getElementById('probesSessionStopBtn');
  var coverageWarningEl = document.getElementById('probesCoverageWarning');
  var STOP_PROBE_TOOLTIP_DEFAULT = 'Stop price stream and probes';
  var STOP_PROBE_TOOLTIP_LOCKED = 'Stop rules trading first — probing cannot be stopped while rules are active';
  var shortTrend = document.getElementById('probeShortTrend');
  var shortMin = document.getElementById('probeShortMin');
  var shortMax = document.getElementById('probeShortMax');
  var shortAvg = document.getElementById('probeShortAvg');
  var shortRange = document.getElementById('probeShortRange');
  var shortStdDev = document.getElementById('probeShortStdDev');
  var shortSpread = document.getElementById('probeShortSpread');
  var shortSamples = document.getElementById('probeShortSamples');
  var mediumTrend = document.getElementById('probeMediumTrend');
  var mediumMin = document.getElementById('probeMediumMin');
  var mediumMax = document.getElementById('probeMediumMax');
  var mediumAvg = document.getElementById('probeMediumAvg');
  var mediumRange = document.getElementById('probeMediumRange');
  var mediumStdDev = document.getElementById('probeMediumStdDev');
  var mediumSpread = document.getElementById('probeMediumSpread');
  var mediumSamples = document.getElementById('probeMediumSamples');
  var longTrend = document.getElementById('probeLongTrend');
  var longMin = document.getElementById('probeLongMin');
  var longMax = document.getElementById('probeLongMax');
  var longAvg = document.getElementById('probeLongAvg');
  var longRange = document.getElementById('probeLongRange');
  var longStdDev = document.getElementById('probeLongStdDev');
  var longSpread = document.getElementById('probeLongSpread');
  var longSamples = document.getElementById('probeLongSamples');

  function getPeriods() {
    var short = parseInt(shortInput && shortInput.value, 10);
    var medium = parseInt(mediumInput && mediumInput.value, 10);
    var long = parseInt(longInput && longInput.value, 10);
    var shortMin = isNaN(short) || short < 1 ? 5 : Math.min(short, 1440);
    var mediumMin = isNaN(medium) || medium < 1 ? 60 : Math.min(Math.max(medium, 1), 10080);
    var longMin = (isNaN(long) || long < 1 ? 24 : Math.min(long, 720)) * 60;
    if (longMin <= mediumMin) longMin = Math.min(mediumMin * 24, 720 * 60);
    return { short: shortMin, medium: mediumMin, long: longMin };
  }

  function computeStats(samples) {
    if (!samples || samples.length === 0) {
      return { min: null, max: null, range: null, avg: null, stdDev: null, avgSpread: null, count: 0 };
    }
    var min = samples[0].mid;
    var max = samples[0].mid;
    var sum = 0;
    var spreadSum = 0;
    for (var i = 0; i < samples.length; i++) {
      var m = samples[i].mid;
      if (m < min) min = m;
      if (m > max) max = m;
      sum += m;
      spreadSum += samples[i].spread || 0;
    }
    var avg = sum / samples.length;
    var sqDiffSum = 0;
    for (var j = 0; j < samples.length; j++) {
      var d = samples[j].mid - avg;
      sqDiffSum += d * d;
    }
    var stdDev = samples.length > 1 ? Math.sqrt(sqDiffSum / (samples.length - 1)) : 0;
    return {
      min: min,
      max: max,
      range: max - min,
      avg: avg,
      stdDev: stdDev,
      avgSpread: spreadSum / samples.length,
      count: samples.length
    };
  }

  function formatVal(v) {
    if (v == null || (typeof v === 'number' && isNaN(v))) return '—';
    return typeof v === 'number' ? v.toFixed(2) : String(v);
  }

  var FLAT_THRESHOLD_PCT = 0.005;
  var lastShortTrend = { dir: 'flat', pct: null, text: '—' };
  var lastMediumTrend = { dir: 'flat', pct: null, text: '—' };
  var lastLongTrend = { dir: 'flat', pct: null, text: '—' };
  function computeTrend(samples) {
    if (!samples || samples.length < 2) return null;
    var first = samples[0].mid;
    var last = samples[samples.length - 1].mid;
    if (first <= 0 || isNaN(first) || isNaN(last)) return null;
    var pct = ((last - first) / first) * 100;
    var dir = Math.abs(pct) < FLAT_THRESHOLD_PCT ? 'flat' : (pct > 0 ? 'up' : 'down');
    var arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
    var sign = pct > 0 ? '+' : '';
    var text = arrow + ' ' + sign + pct.toFixed(2) + '%';
    return { dir: dir, pct: pct, text: text };
  }

  function setTrend(el, trend, lastValid) {
    if (!el) return;
    var t = trend || lastValid;
    el.textContent = t.text;
    el.className = 'font-mono text-xs';
    if (t.dir === 'up') el.classList.add('text-emerald-500');
    else if (t.dir === 'down') el.classList.add('text-red-500');
    else el.classList.add('text-slate-500');
  }

  function setSampleCountEl(el, row) {
    if (!el || !row) return;
    el.textContent = formatProbeSampleCount(row.count, row.expectedCount, row.coveragePct);
    el.classList.toggle('text-amber-400', row.lowCoverage);
    el.classList.toggle('text-slate-500', !row.lowCoverage);
    var tip = 'In-market samples in lookback (excludes closed/out-of-hours ticks)';
    if (row.expectedCount > 0) {
      tip += '. Expected ~' + row.expectedCount + ' at 1 Hz during open hours';
      if (row.coveragePct != null) tip += ' (' + row.coveragePct + '% coverage)';
    }
    if (row.lowCoverage) tip += '. Sparse — probe stats may be unreliable.';
    el.title = tip;
  }

  function render() {
    var history = state.priceHistory || [];
    var now = Date.now();
    var filterOpts = probeFilterOptsFromState(state);
    var p = getPeriods();
    var shortMs = p.short * 60 * 1000;
    var mediumMs = p.medium * 60 * 1000;
    var longMs = p.long * 60 * 1000;
    var shortSamp = history.filter(function (s) {
      return s.ts >= now - shortMs && s.ts <= now && isProbeEligibleSample(s, filterOpts);
    });
    var mediumSamp = history.filter(function (s) {
      return s.ts >= now - mediumMs && s.ts <= now && isProbeEligibleSample(s, filterOpts);
    });
    var longSamp = history.filter(function (s) {
      return s.ts >= now - longMs && s.ts <= now && isProbeEligibleSample(s, filterOpts);
    });
    var shortStats = computeStats(shortSamp);
    var mediumStats = computeStats(mediumSamp);
    var longStats = computeStats(longSamp);
    var coverage = analyzeProbeCoverage(history, now, p.short, p.medium, p.long, filterOpts);
    var coverageByProbe = {};
    for (var ci = 0; ci < coverage.rows.length; ci++) {
      coverageByProbe[coverage.rows[ci].probe] = coverage.rows[ci];
    }
    var shortTrendVal = computeTrend(shortSamp);
    var mediumTrendVal = computeTrend(mediumSamp);
    var longTrendVal = computeTrend(longSamp);
    if (shortTrendVal) lastShortTrend = shortTrendVal;
    if (mediumTrendVal) lastMediumTrend = mediumTrendVal;
    if (longTrendVal) lastLongTrend = longTrendVal;

    setTrend(shortTrend, shortTrendVal, lastShortTrend);
    setTrend(mediumTrend, mediumTrendVal, lastMediumTrend);
    setTrend(longTrend, longTrendVal, lastLongTrend);
    if (shortMin) shortMin.textContent = formatVal(shortStats.min);
    if (shortMax) shortMax.textContent = formatVal(shortStats.max);
    if (shortAvg) shortAvg.textContent = formatVal(shortStats.avg);
    if (shortRange) shortRange.textContent = formatVal(shortStats.range);
    if (shortStdDev) shortStdDev.textContent = formatVal(shortStats.stdDev);
    if (shortSpread) shortSpread.textContent = formatVal(shortStats.avgSpread);
    setSampleCountEl(shortSamples, coverageByProbe.short);
    if (mediumMin) mediumMin.textContent = formatVal(mediumStats.min);
    if (mediumMax) mediumMax.textContent = formatVal(mediumStats.max);
    if (mediumAvg) mediumAvg.textContent = formatVal(mediumStats.avg);
    if (mediumRange) mediumRange.textContent = formatVal(mediumStats.range);
    if (mediumStdDev) mediumStdDev.textContent = formatVal(mediumStats.stdDev);
    if (mediumSpread) mediumSpread.textContent = formatVal(mediumStats.avgSpread);
    setSampleCountEl(mediumSamples, coverageByProbe.medium);
    if (longMin) longMin.textContent = formatVal(longStats.min);
    if (longMax) longMax.textContent = formatVal(longStats.max);
    if (longAvg) longAvg.textContent = formatVal(longStats.avg);
    if (longRange) longRange.textContent = formatVal(longStats.range);
    if (longStdDev) longStdDev.textContent = formatVal(longStats.stdDev);
    if (longSpread) longSpread.textContent = formatVal(longStats.avgSpread);
    setSampleCountEl(longSamples, coverageByProbe.long);
    if (coverageWarningEl) {
      if (coverage.hasWarnings) {
        coverageWarningEl.textContent = coverage.warnings.join(' ');
        coverageWarningEl.classList.remove('hidden');
      } else {
        coverageWarningEl.textContent = '';
        coverageWarningEl.classList.add('hidden');
      }
    }
    var shortT = shortTrendVal || lastShortTrend;
    var mediumT = mediumTrendVal || lastMediumTrend;
    var longT = longTrendVal || lastLongTrend;
    lastProbeValues = {
      short: { min: shortStats.min, max: shortStats.max, avg: shortStats.avg, range: shortStats.range, stdDev: shortStats.stdDev, avgSpread: shortStats.avgSpread, count: shortStats.count, trendDir: shortT.dir, trendPct: shortT.pct },
      medium: { min: mediumStats.min, max: mediumStats.max, avg: mediumStats.avg, range: mediumStats.range, stdDev: mediumStats.stdDev, avgSpread: mediumStats.avgSpread, count: mediumStats.count, trendDir: mediumT.dir, trendPct: mediumT.pct },
      long: { min: longStats.min, max: longStats.max, avg: longStats.avg, range: longStats.range, stdDev: longStats.stdDev, avgSpread: longStats.avgSpread, count: longStats.count, trendDir: longT.dir, trendPct: longT.pct }
    };
    if (onProbeUpdateCallback) onProbeUpdateCallback();
  }

  function addSample(bid, offer, spread, marketState) {
    var bidNum = typeof bid === 'number' ? bid : parseFloat(bid);
    var offerNum = typeof offer === 'number' ? offer : parseFloat(offer);
    var spreadNum = typeof spread === 'number' ? spread : parseFloat(spread);
    if (isNaN(bidNum) || isNaN(offerNum)) return;
    var now = Date.now();
    if (now - lastSampleTs < SAMPLE_INTERVAL_MS) return;
    lastSampleTs = now;
    var mid = (bidNum + offerNum) / 2;
    if (isNaN(spreadNum)) spreadNum = 0;
    state.priceHistory.push({
      ts: now,
      mid: mid,
      spread: spreadNum,
      marketState: marketState != null ? String(marketState) : null
    });
    if (state.priceHistory.length > MAX_SAMPLES) {
      state.priceHistory = state.priceHistory.slice(-MAX_SAMPLES);
    }
    render();
  }

  socket.on('price_update', function (data) {
    if (!data) {
      state.priceHistory = [];
      state.currentEpic = null;
      lastShortTrend = lastMediumTrend = lastLongTrend = { dir: 'flat', pct: null, text: '—' };
      render();
      return;
    }
    addSample(data.bid, data.offer, data.spread, data.marketState);
  });

  socket.on('probes_backfill', function (payload) {
    if (!payload || !Array.isArray(payload.samples)) return;
    var existing = state.priceHistory || [];
    var merged = payload.samples.concat(existing);
    merged.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    var seen = {};
    merged = merged.filter(function (s) {
      var k = String(s.ts || 0);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
    if (merged.length > MAX_SAMPLES) merged = merged.slice(-MAX_SAMPLES);
    state.priceHistory = merged;
    setBackfillLoading(false);
    setBackfillStatus('', false);
    render();
  });

  socket.on('probes_backfill_error', function (msg) {
    setBackfillLoading(false);
    setBackfillStatus(msg || 'Backfill failed', true);
  });

  var backfillBtn = document.getElementById('probesBackfillBtn');
  var backfillStatusEl = document.getElementById('probesBackfillStatus');
  var backfillEnabled = true;

  function setBackfillLoading(loading) {
    if (backfillBtn) backfillBtn.disabled = loading || !backfillEnabled;
    if (backfillBtn) backfillBtn.textContent = loading ? 'Backfilling…' : 'Backfill';
  }

  function setBackfillStatus(text, isError) {
    if (!backfillStatusEl) return;
    backfillStatusEl.textContent = text;
    backfillStatusEl.classList.toggle('hidden', !text);
    backfillStatusEl.classList.toggle('text-amber-400', isError && !!text);
    backfillStatusEl.classList.toggle('text-slate-500', !isError && !!text);
  }

  function setBackfillEnabled(enabled) {
    backfillEnabled = !!enabled;
    if (backfillBtn) backfillBtn.disabled = !backfillEnabled;
    if (backfillBtn) backfillBtn.title = backfillEnabled ? 'Fetch historical prices from IG (uses allowance). Disabled when rules engine is running.' : 'Rules engine running – backfill disabled';
  }

  if (backfillBtn) {
    backfillBtn.addEventListener('click', function () {
      if (backfillBtn.disabled) return;
      setBackfillLoading(true);
      setBackfillStatus('', false);
      socket.emit('probes_backfill_request');
    });
  }

  socket.on('epic', function (newEpic) {
    if (newEpic !== state.currentEpic) {
      var wasSwitching = !!state.currentEpic;
      state.currentEpic = newEpic;
      state.priceHistory = [];
      lastShortTrend = lastMediumTrend = lastLongTrend = { dir: 'flat', pct: null, text: '—' };
      if (wasSwitching) setBackfillStatus('Probes cleared (instrument changed). Use Backfill for historical data.', false);
    }
    render();
  });

  function savePeriods() {
    var p = getPeriods();
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ui: {
          probesShortPeriod: p.short,
          probesMediumPeriod: p.medium,
          probesLongPeriod: p.long
        }
      })
    }).then(function (r) { return r.json(); }).catch(function () {});
  }

  if (shortInput) shortInput.addEventListener('change', function () { savePeriods(); render(); });
  if (mediumInput) mediumInput.addEventListener('change', function () { savePeriods(); render(); });
  if (longInput) longInput.addEventListener('change', function () { savePeriods(); render(); });

  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
    var ui = cfg.ui || {};
    if (shortInput && ui.probesShortPeriod != null) shortInput.value = ui.probesShortPeriod;
    var med = ui.probesMediumPeriod != null ? Math.min(Math.max(ui.probesMediumPeriod, 1), 10080) : 60;
    var lng = ui.probesLongPeriod != null ? Math.round(ui.probesLongPeriod / 60) : 24;
    var medHours = med / 60;
    if (lng <= medHours) lng = Math.min(Math.ceil(medHours) * 24, 720);
    if (mediumInput) mediumInput.value = med;
    if (longInput) longInput.value = lng;
    render();
  }).catch(function () { render(); });

  var onProbeUpdateCallback = null;
  var lastProbeValues = null;

  return {
    setProbesPanelEnabled: function (enabled) {
      var panel = document.getElementById('probesPanel');
      if (panel) panel.classList.toggle('hidden', !enabled);
    },
    setBackfillEnabled: setBackfillEnabled,
    setProbesSettingsLocked: function (locked) {
      if (shortInput) shortInput.disabled = !!locked;
      if (mediumInput) mediumInput.disabled = !!locked;
      if (longInput) longInput.disabled = !!locked;
      if (periodInputsWrap) periodInputsWrap.classList.toggle('probes-settings-locked', !!locked);
      if (sessionStopBtn) {
        var probing = state.engineStatus === 'running';
        var blocked = !!locked && probing;
        sessionStopBtn.disabled = !probing || blocked;
        sessionStopBtn.setAttribute(
          'data-tooltip',
          blocked ? STOP_PROBE_TOOLTIP_LOCKED : STOP_PROBE_TOOLTIP_DEFAULT
        );
      }
    },
    setOnProbeUpdate: function (fn) {
      onProbeUpdateCallback = fn;
    },
    getProbeValues: function () { return lastProbeValues; },
    refreshProbes: function () { render(); }
  };
}
