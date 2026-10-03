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
import {
  drawLiveProbeChart,
  drawChartCrosshair,
  prepareChartCanvas,
  nearestSampleIndex
} from './priceChartCore.js';
import { formatTimeWithTz } from './utils.js';

const MAX_SAMPLES = 100000;
const SAMPLE_INTERVAL_MS = 1000;
var lastSampleTs = 0;

export function initProbes(socket, state, log) {
  state.priceHistory = state.priceHistory || [];
  var shortInput = document.getElementById('probeShortPeriod');
  var mediumInput = document.getElementById('probeMediumPeriod');
  var longInput = document.getElementById('probeLongPeriod');
  var periodInputsWrap = document.getElementById('probesPeriodInputs');
  var sessionStopBtn = null;
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
  var shortPeriodStartBuy = document.getElementById('probeShortPeriodStartBuy');
  var shortPeriodStartSell = document.getElementById('probeShortPeriodStartSell');
  var shortSamples = document.getElementById('probeShortSamples');
  var mediumTrend = document.getElementById('probeMediumTrend');
  var mediumMin = document.getElementById('probeMediumMin');
  var mediumMax = document.getElementById('probeMediumMax');
  var mediumAvg = document.getElementById('probeMediumAvg');
  var mediumRange = document.getElementById('probeMediumRange');
  var mediumStdDev = document.getElementById('probeMediumStdDev');
  var mediumSpread = document.getElementById('probeMediumSpread');
  var mediumPeriodStartBuy = document.getElementById('probeMediumPeriodStartBuy');
  var mediumPeriodStartSell = document.getElementById('probeMediumPeriodStartSell');
  var mediumSamples = document.getElementById('probeMediumSamples');
  var longTrend = document.getElementById('probeLongTrend');
  var longMin = document.getElementById('probeLongMin');
  var longMax = document.getElementById('probeLongMax');
  var longAvg = document.getElementById('probeLongAvg');
  var longRange = document.getElementById('probeLongRange');
  var longStdDev = document.getElementById('probeLongStdDev');
  var longSpread = document.getElementById('probeLongSpread');
  var longPeriodStartBuy = document.getElementById('probeLongPeriodStartBuy');
  var longPeriodStartSell = document.getElementById('probeLongPeriodStartSell');
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

  /** Bid/offer at the oldest eligible sample in the probe window. */
  function computePeriodStart(samples) {
    if (!samples || samples.length === 0) {
      return { periodStartBuy: null, periodStartSell: null };
    }
    var first = samples[0];
    var spread = first.spread || 0;
    return {
      periodStartBuy: first.mid + spread / 2,
      periodStartSell: first.mid - spread / 2
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

  var streamCanvas = document.getElementById('probeStreamCanvas');
  var streamCanvasOverlay = document.getElementById('probeStreamCanvasOverlay');
  var streamCanvasWrap = document.getElementById('probeStreamCanvasWrap');
  var streamMeta = document.getElementById('probeStreamMeta');
  var streamHoverBar = document.getElementById('probeStreamHoverBar');
  var streamHint = document.getElementById('probeStreamDiagramHint');
  var streamChartState = {
    layout: null,
    samples: [],
    probeSeries: null,
    probeMs: null,
    hoverIdx: null
  };
  var streamResizeObserver = null;

  function streamWrapSize() {
    if (!streamCanvasWrap) return { w: 0, h: 0 };
    var rect = streamCanvasWrap.getBoundingClientRect();
    return { w: Math.max(0, Math.floor(rect.width)), h: Math.max(0, Math.floor(rect.height)) };
  }

  function formatProbePeriodMinutes(minutes) {
    if (minutes >= 1440 && minutes % 1440 === 0) return minutes / 1440 + 'd';
    if (minutes >= 60 && minutes % 60 === 0) return minutes / 60 + 'h';
    return minutes + 'm';
  }

  function probeMsFromPeriods(p) {
    return {
      short: p.short * 60 * 1000,
      medium: p.medium * 60 * 1000,
      long: p.long * 60 * 1000,
      shortMin: p.short,
      mediumMin: p.medium,
      longMin: p.long
    };
  }

  function updateStreamHoverBar(idx) {
    if (!streamHoverBar) return;
    var samples = streamChartState.samples;
    var probeMs = streamChartState.probeMs;
    var series = streamChartState.probeSeries;
    if (idx == null || idx < 0 || !samples || !samples[idx]) {
      streamHoverBar.classList.add('hidden');
      streamHoverBar.textContent = '';
      return;
    }
    var s = samples[idx];
    var parts = [formatTimeWithTz(new Date(s.ts).toISOString()), 'Mid ' + Number(s.mid).toFixed(2)];
    if (s.bid != null && s.offer != null) {
      parts.push('Buy ' + Number(s.offer).toFixed(2));
      parts.push('Sell ' + Number(s.bid).toFixed(2));
    }
    if (series && probeMs) {
      if (series.short[idx] != null) parts.push('S(' + probeMs.shortMin + 'm) ' + series.short[idx].toFixed(2));
      if (series.medium[idx] != null) parts.push('M(' + probeMs.mediumMin + 'm) ' + series.medium[idx].toFixed(2));
      if (series.long[idx] != null) parts.push('L(' + formatProbePeriodMinutes(probeMs.longMin) + ') ' + series.long[idx].toFixed(2));
    }
    streamHoverBar.textContent = parts.join('  ·  ');
    streamHoverBar.classList.remove('hidden');
  }

  function clearStreamCrosshair() {
    if (!streamCanvasOverlay || !streamCanvasWrap) return;
    var size = streamWrapSize();
    if (size.w > 0 && size.h > 0) prepareChartCanvas(streamCanvasOverlay, size.w, size.h, false);
  }

  function onStreamChartMouseMove(e) {
    var layout = streamChartState.layout;
    var samples = streamChartState.samples;
    if (!layout || !samples.length || !streamCanvasOverlay) return;
    var rect = streamCanvasOverlay.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var plotRight = layout.padL + layout.plotW;
    var plotBottom = layout.padT + layout.plotH;
    if (x < layout.padL || x > plotRight || y < layout.padT || y > plotBottom) {
      if (streamChartState.hoverIdx != null) {
        streamChartState.hoverIdx = null;
        updateStreamHoverBar(null);
        clearStreamCrosshair();
      }
      return;
    }
    var ts = layout.t0 + ((x - layout.padL) / layout.plotW) * layout.tSpan;
    var idx = nearestSampleIndex(samples, ts);
    if (streamChartState.hoverIdx === idx) return;
    streamChartState.hoverIdx = idx;
    updateStreamHoverBar(idx);
    drawChartCrosshair(streamCanvasOverlay, layout, samples[idx]);
  }

  function onStreamChartMouseLeave() {
    streamChartState.hoverIdx = null;
    updateStreamHoverBar(null);
    clearStreamCrosshair();
  }

  function paintStreamChart(p, longSamp, shortStats, mediumStats, longStats, shortT, mediumT, longT) {
    if (!streamCanvas || !streamCanvasWrap) return;
    var now = Date.now();
    var probeMs = probeMsFromPeriods(p);
    var bid = state.currentBid;
    var offer = state.currentOffer;
    var st = state.engineStatus || 'ready';
    var statusText = 'Collecting samples…';
    if (st === 'connecting') statusText = 'Connecting to IG and price stream…';
    else if (st === 'connected') statusText = 'Starting price stream…';
    else if (st !== 'running') statusText = 'Waiting for live prices — open Trade to start the stream.';

    if (streamMeta) {
      var bidStr = bid != null && !isNaN(bid) ? formatVal(bid) : '—';
      var offerStr = offer != null && !isNaN(offer) ? formatVal(offer) : '—';
      streamMeta.innerHTML =
        '<span class="text-slate-500">Buy / Sell</span> ' + offerStr + ' / ' + bidStr +
        ' &nbsp;|&nbsp; <span class="text-slate-500">S</span> ' + (shortT.text || '—') +
        ' &nbsp;|&nbsp; <span class="text-slate-500">M</span> ' + (mediumT.text || '—') +
        ' &nbsp;|&nbsp; <span class="text-slate-500">L</span> ' + (longT.text || '—');
    }

    var size = streamWrapSize();
    var result = drawLiveProbeChart(streamCanvas, {
      width: size.w,
      height: size.h,
      samples: longSamp,
      probeMs: probeMs,
      refTs: now,
      probeStats: { short: shortStats, medium: mediumStats, long: longStats },
      statusText: statusText
    });
    streamChartState.layout = result.layout;
    streamChartState.samples = result.samples;
    streamChartState.probeSeries = result.probeSeries;
    streamChartState.probeMs = probeMs;
    if (streamChartState.hoverIdx != null) {
      var hi = streamChartState.hoverIdx;
      if (hi >= result.samples.length) {
        streamChartState.hoverIdx = null;
        updateStreamHoverBar(null);
        clearStreamCrosshair();
      } else {
        updateStreamHoverBar(hi);
        drawChartCrosshair(streamCanvasOverlay, result.layout, result.samples[hi]);
      }
    }
  }

  function updateStreamDiagram(p, shortSamp, mediumSamp, longSamp, shortStats, mediumStats, longStats, shortT, mediumT, longT) {
    paintStreamChart(p, longSamp, shortStats, mediumStats, longStats, shortT, mediumT, longT);
    if (streamHint) {
      var hasData = longSamp.length >= 2;
      var eng = state.engineStatus || 'ready';
      streamHint.classList.toggle('hidden', hasData);
      if (!hasData && eng !== 'running' && eng !== 'connecting') {
        streamHint.textContent =
          eng === 'connected'
            ? 'Starting price stream…'
            : 'Live chart starts automatically on Trade (independent of rules).';
      }
    }
  }

  if (streamCanvasOverlay) {
    streamCanvasOverlay.addEventListener('mousemove', onStreamChartMouseMove);
    streamCanvasOverlay.addEventListener('mouseleave', onStreamChartMouseLeave);
  }
  if (streamCanvasWrap && typeof ResizeObserver !== 'undefined') {
    streamResizeObserver = new ResizeObserver(function () {
      render();
    });
    streamResizeObserver.observe(streamCanvasWrap);
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
    var shortPeriodStart = computePeriodStart(shortSamp);
    var mediumPeriodStart = computePeriodStart(mediumSamp);
    var longPeriodStart = computePeriodStart(longSamp);
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
    if (shortPeriodStartBuy) shortPeriodStartBuy.textContent = formatVal(shortPeriodStart.periodStartBuy);
    if (shortPeriodStartSell) shortPeriodStartSell.textContent = formatVal(shortPeriodStart.periodStartSell);
    if (shortMin) shortMin.textContent = formatVal(shortStats.min);
    if (shortMax) shortMax.textContent = formatVal(shortStats.max);
    if (shortAvg) shortAvg.textContent = formatVal(shortStats.avg);
    if (shortRange) shortRange.textContent = formatVal(shortStats.range);
    if (shortStdDev) shortStdDev.textContent = formatVal(shortStats.stdDev);
    if (shortSpread) shortSpread.textContent = formatVal(shortStats.avgSpread);
    setSampleCountEl(shortSamples, coverageByProbe.short);
    if (mediumPeriodStartBuy) mediumPeriodStartBuy.textContent = formatVal(mediumPeriodStart.periodStartBuy);
    if (mediumPeriodStartSell) mediumPeriodStartSell.textContent = formatVal(mediumPeriodStart.periodStartSell);
    if (mediumMin) mediumMin.textContent = formatVal(mediumStats.min);
    if (mediumMax) mediumMax.textContent = formatVal(mediumStats.max);
    if (mediumAvg) mediumAvg.textContent = formatVal(mediumStats.avg);
    if (mediumRange) mediumRange.textContent = formatVal(mediumStats.range);
    if (mediumStdDev) mediumStdDev.textContent = formatVal(mediumStats.stdDev);
    if (mediumSpread) mediumSpread.textContent = formatVal(mediumStats.avgSpread);
    setSampleCountEl(mediumSamples, coverageByProbe.medium);
    if (longPeriodStartBuy) longPeriodStartBuy.textContent = formatVal(longPeriodStart.periodStartBuy);
    if (longPeriodStartSell) longPeriodStartSell.textContent = formatVal(longPeriodStart.periodStartSell);
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
      short: { min: shortStats.min, max: shortStats.max, avg: shortStats.avg, range: shortStats.range, stdDev: shortStats.stdDev, avgSpread: shortStats.avgSpread, count: shortStats.count, trendDir: shortT.dir, trendPct: shortT.pct, periodStartBuy: shortPeriodStart.periodStartBuy, periodStartSell: shortPeriodStart.periodStartSell },
      medium: { min: mediumStats.min, max: mediumStats.max, avg: mediumStats.avg, range: mediumStats.range, stdDev: mediumStats.stdDev, avgSpread: mediumStats.avgSpread, count: mediumStats.count, trendDir: mediumT.dir, trendPct: mediumT.pct, periodStartBuy: mediumPeriodStart.periodStartBuy, periodStartSell: mediumPeriodStart.periodStartSell },
      long: { min: longStats.min, max: longStats.max, avg: longStats.avg, range: longStats.range, stdDev: longStats.stdDev, avgSpread: longStats.avgSpread, count: longStats.count, trendDir: longT.dir, trendPct: longT.pct, periodStartBuy: longPeriodStart.periodStartBuy, periodStartSell: longPeriodStart.periodStartSell }
    };
    updateStreamDiagram(p, shortSamp, mediumSamp, longSamp, shortStats, mediumStats, longStats, shortT, mediumT, longT);
    if (onProbeUpdateCallback) onProbeUpdateCallback();
  }

  /** Merge IG/recorded seed points with live history; live bid/offer wins on duplicate timestamps. */
  function mergePriceHistoryFromSeed(incoming) {
    if (!incoming || !incoming.length) return;
    var existing = state.priceHistory || [];
    var map = {};
    function norm(s) {
      var bid = s.bid;
      var offer = s.offer;
      var mid = s.mid;
      if (mid == null && bid != null && offer != null && !isNaN(bid) && !isNaN(offer)) {
        mid = (Number(bid) + Number(offer)) / 2;
      }
      return {
        ts: s.ts,
        mid: mid,
        spread: s.spread || 0,
        marketState: s.marketState != null ? s.marketState : null,
        bid: bid,
        offer: offer
      };
    }
    function add(s) {
      if (!s || s.ts == null) return;
      var k = String(s.ts);
      var next = norm(s);
      var prev = map[k];
      if (!prev) {
        map[k] = next;
        return;
      }
      if (next.bid != null && next.offer != null) map[k] = next;
    }
    for (var i = 0; i < incoming.length; i++) add(incoming[i]);
    for (var j = 0; j < existing.length; j++) add(existing[j]);
    var merged = Object.keys(map).map(function (k) { return map[k]; });
    merged.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    if (merged.length > MAX_SAMPLES) merged = merged.slice(-MAX_SAMPLES);
    state.priceHistory = merged;
    render();
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
      // Stream stopped — keep today's samples for chart when stream restarts (server re-seeds from DB).
      lastShortTrend = lastMediumTrend = lastLongTrend = { dir: 'flat', pct: null, text: '—' };
      render();
      return;
    }
    addSample(data.bid, data.offer, data.spread, data.marketState);
  });

  socket.on('live_chart_day_seed', function (payload) {
    if (!payload || !Array.isArray(payload.samples)) return;
    if (payload.epic && state.currentEpic && payload.epic !== state.currentEpic) return;
    mergePriceHistoryFromSeed(payload.samples);
  });

  socket.on('probes_backfill', function (payload) {
    if (!payload || !Array.isArray(payload.samples)) return;
    mergePriceHistoryFromSeed(payload.samples);
    setBackfillLoading(false);
    setBackfillStatus('', false);
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
