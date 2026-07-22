/**
 * Test rules panel – recording, recorded log, and backtest analysis.
 */
import { formatTimeWithTz } from './utils.js';
import { getRulesForBacktest } from './tradingRules.js';
import { initBacktestProfiles } from './backtestProfiles.js';

export function initTestRules(socket, state, log, profileOpts) {
  var recordBtn = document.getElementById('testRulesRecordBtn');
  var logBody = document.getElementById('testRulesLogBody');
  var logEl = document.getElementById('testRulesLog');
  var recordingActive = false;
  var engineStatus = 'stopped';

  function appendLog(msg) {
    if (!logBody) return;
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.textContent = msg;
    td.colSpan = 5;
    td.className = 'px-2 py-0.5 text-slate-400';
    tr.appendChild(td);
    logBody.appendChild(tr);
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    while (logBody.children.length > 100) logBody.removeChild(logBody.firstChild);
  }

  function updateRecordButton() {
    if (!recordBtn) return;
    var canRecord = engineStatus === 'running' && state.savedEpic;
    if (recordingActive) {
      recordBtn.textContent = 'Stop recording';
      recordBtn.classList.add('bg-amber-600', 'hover:bg-amber-500');
      recordBtn.classList.remove('bg-slate-700', 'hover:bg-slate-600');
      recordBtn.disabled = false;
    } else {
      recordBtn.textContent = 'Record';
      recordBtn.classList.remove('bg-amber-600', 'hover:bg-amber-500');
      recordBtn.classList.add('bg-slate-700', 'hover:bg-slate-600');
      recordBtn.disabled = !canRecord;
    }
    recordBtn.title = recordingActive
      ? 'Stop recording price data to database'
      : canRecord
        ? 'Record price data to database at 1/sec for later replay. Requires streaming and instrument selected.'
        : 'Need to be connected and have an instrument selected to record.';
  }

  socket.on('recorded_sample', function (msg) {
    if (!logBody || !msg) return;
    var ts = msg.ts != null ? formatTimeWithTz(new Date(msg.ts).toISOString()) : '—';
    var bid = msg.bid != null ? parseFloat(msg.bid) : NaN;
    var offer = msg.offer != null ? parseFloat(msg.offer) : NaN;
    var spread = msg.spread != null ? parseFloat(msg.spread) : 0;
    var mid = !isNaN(bid) && !isNaN(offer) ? ((bid + offer) / 2).toFixed(2) : '—';
    var buy = !isNaN(offer) ? offer.toFixed(2) : '—';
    var sell = !isNaN(bid) ? bid.toFixed(2) : '—';
    var s = !isNaN(spread) ? spread.toFixed(2) : '—';
    var tr = document.createElement('tr');
    tr.innerHTML = '<td class="px-2 py-0.5">' + ts + '</td><td class="px-2 py-0.5">' + buy + '</td><td class="px-2 py-0.5">' + sell + '</td><td class="px-2 py-0.5">' + mid + '</td><td class="px-2 py-0.5">' + s + '</td>';
    logBody.appendChild(tr);
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    while (logBody.children.length > 100) logBody.removeChild(logBody.firstChild);
  });

  var recordedCountEl = document.getElementById('testRulesRecordedCount');
  var recordingPollTimer = null;

  function updateRecordedCount(count) {
    if (recordedCountEl) recordedCountEl.textContent = count != null ? count.toLocaleString() + ' recorded' : '—';
  }

  socket.on('recording_status', function (msg) {
    var wasRecording = recordingActive;
    recordingActive = !!(msg && msg.recording);
    if (wasRecording && !recordingActive && logEl) {
      appendLog('Recording stopped');
    }
    if (recordingPollTimer) {
      clearInterval(recordingPollTimer);
      recordingPollTimer = null;
    }
    if (recordingActive) {
      recordingPollTimer = setInterval(function () { socket.emit('recording_status_request'); }, 1000);
    }
    updateRecordButton();
    var count = msg && msg.recordedCount != null ? msg.recordedCount : (msg && msg.recording && msg.sampleCount != null ? msg.sampleCount : null);
    updateRecordedCount(count);
  });

  socket.on('status', function (status) {
    engineStatus = status || 'stopped';
    updateRecordButton();
  });

  if (recordBtn) {
    recordBtn.addEventListener('click', function () {
      if (recordBtn.disabled) return;
      if (recordingActive) {
        socket.emit('recording_stop');
        appendLog('Stopping…');
      } else {
        socket.emit('recording_start');
        appendLog('Recording started');
      }
    });
  }

  var button2 = document.getElementById('testRulesButton2');
  var reportEl = document.getElementById('testRulesReport');
  var reportBody = document.getElementById('testRulesReportBody');
  var epicSelect = document.getElementById('epicSelect');
  var analyseProgressModal = document.getElementById('analyseProgressModal');
  var analyseProgressText = document.getElementById('analyseProgressText');
  var analyseProgressStop = document.getElementById('analyseProgressStop');
  var tradeChartModal = document.getElementById('tradeChartModal');
  var tradeChartModalBackdrop = document.getElementById('tradeChartModalBackdrop');
  var tradeChartModalClose = document.getElementById('tradeChartModalClose');
  var tradeChartModalHeader = document.getElementById('tradeChartModalHeader');
  var tradeChartModalTitle = document.getElementById('tradeChartModalTitle');
  var tradeChartModalMeta = document.getElementById('tradeChartModalMeta');
  var tradeChartCanvas = document.getElementById('tradeChartCanvas');
  var tradeChartCanvasOverlay = document.getElementById('tradeChartCanvasOverlay');
  var tradeChartCanvasWrap = document.getElementById('tradeChartCanvasWrap');
  var tradeChartModalHint = document.getElementById('tradeChartModalHint');
  var tradeChartModalPanel = document.getElementById('tradeChartModalPanel');
  var tradeChartModalRules = document.getElementById('tradeChartModalRules');
  var tradeChartModalOverlays = document.getElementById('tradeChartModalOverlays');
  var tradeChartOverlayChecks = document.getElementById('tradeChartOverlayChecks');
  var tradeChartHoverBar = document.getElementById('tradeChartHoverBar');
  var tradeChartResizeGrip = document.getElementById('tradeChartResizeGrip');
  var tradeChartSizeUp = document.getElementById('tradeChartSizeUp');
  var tradeChartSizeDown = document.getElementById('tradeChartSizeDown');
  var testRulesTradeList = document.getElementById('testRulesTradeList');
  var testRulesTradeListCount = document.getElementById('testRulesTradeListCount');
  var testRulesTradeListHint = document.getElementById('testRulesTradeListHint');
  var lastTrades = [];
  var lastTradePlMult = 1;
  var lastTradeUsePounds = false;
  var lastAnalysedDays = [];
  var lastAnalyseEpic = '';
  var lastAnalyseSelectedDays = [];
  var lastAnalyseDayKeys = [];
  var lastBacktestReport = null;
  var profilesApi = initBacktestProfiles(
    Object.assign({}, profileOpts || {}, {
      getEpic: function () {
        return (epicSelect && epicSelect.value) || state.savedEpic || '';
      },
      onLoadProfile: function (profile) {
        appendLog('Loaded profile: ' + profile.name + ' (embedded rules — re-run Analyse recording for trade list)');
      },
      onClearProfile: function () {
        appendLog('Using Trade tab rules for analyse');
      }
    })
  );
  var lastChartReqSeq = 0;
  var chartResizeObserver = null;
  var chartResizeDebounce = null;
  var chartPanelSavedLeft = null;
  var chartPanelSavedTop = null;
  var chartLayoutRetries = 0;

  function chartWrapSize() {
    if (!tradeChartCanvasWrap) return { w: 0, h: 0 };
    syncChartWrapHeight();
    var rect = tradeChartCanvasWrap.getBoundingClientRect();
    var w = Math.max(0, Math.round(rect.width));
    var h = Math.max(0, Math.round(rect.height));
    return { w: w, h: h };
  }

  /** Flex + absolute canvases can leave wrap at 0px until height is set explicitly. */
  function syncChartWrapHeight() {
    if (!tradeChartCanvasWrap || !tradeChartModalPanel) return;
    var panelH = tradeChartModalPanel.clientHeight;
    if (panelH < 120) return;
    var chrome = 0;
    var kids = tradeChartModalPanel.children;
    for (var i = 0; i < kids.length; i++) {
      var ch = kids[i];
      if (ch === tradeChartCanvasWrap || ch.id === 'tradeChartResizeGrip') continue;
      var st = window.getComputedStyle(ch);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      chrome += ch.offsetHeight;
    }
    var plotH = Math.max(180, panelH - chrome);
    tradeChartCanvasWrap.style.minHeight = plotH + 'px';
    tradeChartCanvasWrap.style.height = plotH + 'px';
  }

  function scheduleChartLayoutRedraw() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!tradeChartCanvasWrap || tradeChartCanvasWrap._chartSamples === null) return;
        redrawChart();
      });
    });
  }

  function minMaxMids(mids) {
    if (!mids || mids.length === 0) return { min: 0, max: 0 };
    var min = Number(mids[0]);
    var max = Number(mids[0]);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    for (var i = 1; i < mids.length; i++) {
      var v = Number(mids[i]);
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) {
      min -= 0.01;
      max += 0.01;
    }
    return { min: min, max: max };
  }

  function normalizeChartSamples(samples) {
    if (!samples || samples.length === 0) return [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (s.mid == null || !Number.isFinite(Number(s.mid))) {
        if (s.bid != null && s.offer != null) s.mid = (Number(s.bid) + Number(s.offer)) / 2;
      } else {
        s.mid = Number(s.mid);
      }
    }
    return samples;
  }

  /** Debounced — only repaints after resize drag stops (avoids clearing mid-layout). */
  function scheduleChartResizeRedraw() {
    if (chartResizeDebounce != null) clearTimeout(chartResizeDebounce);
    chartResizeDebounce = setTimeout(function () {
      chartResizeDebounce = null;
      redrawChart();
    }, 200);
  }

  function chartPanelSizeLimits() {
    return {
      minW: 420,
      minH: 320,
      maxW: Math.max(420, Math.min(window.innerWidth * 0.96, window.innerWidth - 24)),
      maxH: Math.max(320, Math.min(window.innerHeight * 0.94, window.innerHeight - 24))
    };
  }

  function clampChartPanelToViewport() {
    if (!tradeChartModalPanel) return;
    var rect = tradeChartModalPanel.getBoundingClientRect();
    var left = rect.left;
    var top = rect.top;
    var maxL = Math.max(8, window.innerWidth - rect.width - 8);
    var maxT = Math.max(8, window.innerHeight - rect.height - 8);
    left = Math.min(maxL, Math.max(8, left));
    top = Math.min(maxT, Math.max(8, top));
    tradeChartModalPanel.style.left = left + 'px';
    tradeChartModalPanel.style.top = top + 'px';
    chartPanelSavedLeft = left;
    chartPanelSavedTop = top;
  }

  function layoutChartPanelOnOpen() {
    if (!tradeChartModalPanel) return;
    tradeChartModalPanel.style.position = 'fixed';
    tradeChartModalPanel.style.margin = '0';
    tradeChartModalPanel.style.transform = 'none';
    if (chartPanelSavedLeft != null && chartPanelSavedTop != null) {
      tradeChartModalPanel.style.left = chartPanelSavedLeft + 'px';
      tradeChartModalPanel.style.top = chartPanelSavedTop + 'px';
      clampChartPanelToViewport();
      return;
    }
    var w = tradeChartModalPanel.offsetWidth;
    var h = tradeChartModalPanel.offsetHeight;
    chartPanelSavedLeft = Math.max(8, (window.innerWidth - w) / 2);
    chartPanelSavedTop = Math.max(8, (window.innerHeight - h) / 2);
    tradeChartModalPanel.style.left = chartPanelSavedLeft + 'px';
    tradeChartModalPanel.style.top = chartPanelSavedTop + 'px';
  }

  function setChartPanelSize(w, h, redrawNow) {
    if (!tradeChartModalPanel) return;
    var lim = chartPanelSizeLimits();
    var nw = Math.max(lim.minW, Math.min(lim.maxW, Math.round(w)));
    var nh = Math.max(lim.minH, Math.min(lim.maxH, Math.round(h)));
    tradeChartModalPanel.style.width = nw + 'px';
    tradeChartModalPanel.style.height = nh + 'px';
    clampChartPanelToViewport();
    syncChartWrapHeight();
    if (redrawNow) scheduleChartResizeRedraw();
  }

  function bumpChartPanelSize(dw, dh) {
    if (!tradeChartModalPanel) return;
    setChartPanelSize(tradeChartModalPanel.offsetWidth + dw, tradeChartModalPanel.offsetHeight + dh, true);
  }

  function tradeBoundsLocalDays(entryTs, exitTs) {
    var t0 = Math.min(entryTs, exitTs);
    var t1 = Math.max(entryTs, exitTs);
    var d0 = new Date(t0);
    var start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0, 0, 0, 0).getTime();
    var d1 = new Date(t1);
    var end = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate(), 23, 59, 59, 999).getTime();
    var PAD_MS = 3 * 60 * 60 * 1000;
    return { start: start - PAD_MS, end: end + PAD_MS };
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ruleOpSymbol(op) {
    var syms = { lte: '\u2264', gte: '\u2265', lt: '<', gt: '>', eq: '=' };
    return syms[op] || String(op || '');
  }

  /** Configured rule + evaluated operands at entry (from backtest snapshot). */
  function formatEntryRuleLineHtml(r) {
    var head =
      '<span class="font-mono text-[11px]">' +
      escapeHtml(r.left) +
      ' <span class="text-slate-500">' +
      escapeHtml(r.op) +
      '</span> ' +
      escapeHtml(r.right) +
      '</span>';
    var hasSnap = (r.leftAtEntry != null && r.leftAtEntry !== '') || (r.rightAtEntry != null && r.rightAtEntry !== '');
    if (hasSnap) {
      var lv = escapeHtml(r.leftAtEntry != null && r.leftAtEntry !== '' ? String(r.leftAtEntry) : '\u2014');
      var rv = escapeHtml(r.rightAtEntry != null && r.rightAtEntry !== '' ? String(r.rightAtEntry) : '\u2014');
      head +=
        '<span class="font-mono text-[11px] text-slate-400">: ' +
        lv +
        ' ' +
        escapeHtml(ruleOpSymbol(r.op)) +
        ' ' +
        rv +
        '</span>';
    }
    return head;
  }

  function formatDurationMs(ms) {
    if (ms < 1000) return ms + ' ms';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    var rs = s % 60;
    if (m < 60) return m + 'm ' + rs + 's';
    var h = Math.floor(m / 60);
    var rm = m % 60;
    return h + 'h ' + rm + 'm';
  }

  function exitReasonLabel(er) {
    if (er === 'tp') return 'TP';
    if (er === 'sl') return 'SL';
    if (er === 'dsl') return 'DynSL';
    if (er === 'rules') return 'Rules';
    if (er === 'endOfPeriod') return 'EOD';
    return er || '—';
  }

  function dayChartTimeRange(dayStr) {
    var parts = (dayStr || '').split('-');
    if (parts.length !== 3) return null;
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
    var start = new Date(y, m, d, 0, 0, 0, 0).getTime();
    var end = new Date(y, m, d, 23, 59, 59, 999).getTime();
    return { start: start, end: end };
  }

  var CHART_GAP_MS = 5000;

  function medianNum(nums) {
    if (!nums || nums.length === 0) return 0;
    var sorted = nums.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  /** Typical spacing between displayed samples (robust to downsampling). */
  function medianSampleDeltaMs(samples) {
    if (!samples || samples.length < 2) return 1000;
    var deltas = [];
    var stride = samples.length > 4000 ? Math.ceil(samples.length / 2000) : 1;
    for (var i = stride; i < samples.length; i += stride) {
      var d = samples[i].ts - samples[i - stride].ts;
      if (d > 0) deltas.push(d / stride);
    }
    if (deltas.length === 0) return 1000;
    return Math.max(1, medianNum(deltas));
  }

  /** Break price lines only on gaps larger than normal sample spacing (not thinning artifacts). */
  function chartGapBreakMs(samples) {
    return Math.max(CHART_GAP_MS, medianSampleDeltaMs(samples) * 3);
  }

  /** Gaps, jumps, and missing-day edges for chart overlays. */
  function computeChartAnomalies(samples, chartCtx) {
    var gaps = [];
    var jumps = [];
    var noDataBefore = null;
    var noDataAfter = null;
    if (!samples || samples.length < 2) {
      return { gaps: gaps, jumps: jumps, noDataBefore: noDataBefore, noDataAfter: noDataAfter };
    }
    var gapBreakMs = chartGapBreakMs(samples);
    var midDeltas = [];
    var refMid = Math.abs(Number(samples[0].mid) || 1);
    for (var i = 1; i < samples.length; i++) {
      var delta = samples[i].ts - samples[i - 1].ts;
      if (delta > gapBreakMs) {
        gaps.push({
          fromTs: samples[i - 1].ts,
          toTs: samples[i].ts,
          deltaMs: delta,
          severity: delta >= 60000 ? 'high' : delta >= 30000 ? 'med' : 'low',
          afterIndex: i
        });
      }
      var dm = Math.abs(Number(samples[i].mid) - Number(samples[i - 1].mid));
      midDeltas.push(dm);
    }
    var medJump = medianNum(midDeltas);
    var jumpThreshold = Math.max(medJump * 10, refMid * 0.001, 0.01);
    for (var j = 1; j < samples.length; j++) {
      var dMid = Math.abs(Number(samples[j].mid) - Number(samples[j - 1].mid));
      if (dMid > jumpThreshold && (samples[j].ts - samples[j - 1].ts) <= gapBreakMs) {
        jumps.push({ ts: samples[j].ts, mid: samples[j].mid, delta: dMid, index: j });
      }
    }
    if (chartCtx && chartCtx.mode === 'day' && chartCtx.day) {
      var range = dayChartTimeRange(chartCtx.day);
      if (range) {
        if (samples[0].ts > range.start + 60000) {
          noDataBefore = { fromTs: range.start, toTs: samples[0].ts };
        }
        if (samples[samples.length - 1].ts < range.end - 60000) {
          noDataAfter = { fromTs: samples[samples.length - 1].ts, toTs: range.end };
        }
      }
    }
    return { gaps: gaps, jumps: jumps, noDataBefore: noDataBefore, noDataAfter: noDataAfter };
  }

  function formatChartQualitySummary(anomalies) {
    if (!anomalies) return '';
    var parts = [];
    if (anomalies.gaps.length > 0) parts.push(anomalies.gaps.length + ' gap(s)');
    if (anomalies.jumps.length > 0) parts.push(anomalies.jumps.length + ' jump(s)');
    if (anomalies.noDataBefore || anomalies.noDataAfter) parts.push('partial day coverage');
    if (parts.length === 0) return '';
    return 'Recording issues: ' + parts.join(', ') + '.';
  }

  function updateChartModalQualityNote() {
    if (!tradeChartModalHint || !tradeChartCanvasWrap) return;
    var a = tradeChartCanvasWrap._chartAnomalies;
    var base = 'Drag title bar to move. +/− or ↘ to resize. Hover chart for values.';
    var q = formatChartQualitySummary(a);
    if (q) {
      tradeChartModalHint.innerHTML =
        '<span class="text-amber-400/90">' +
        escapeHtml(q) +
        '</span> Amber band = gap in recording; gray = no samples; yellow dot = unusual price step. ' +
        base;
    } else {
      tradeChartModalHint.textContent = base;
    }
  }

  var CHART_OVERLAY_DEFS = [
    { key: 'avg', label: 'Range avg', color: '#60a5fa', modes: ['day', 'trade'] },
    { key: 'min', label: 'Range min', color: '#34d399', modes: ['day', 'trade'] },
    { key: 'max', label: 'Range max', color: '#f87171', modes: ['day', 'trade'] },
    { key: 'shortCurve', label: 'Short avg', color: '#22d3ee', modes: ['day', 'trade'] },
    { key: 'mediumCurve', label: 'Medium avg', color: '#a78bfa', modes: ['day', 'trade'] },
    { key: 'longCurve', label: 'Long avg', color: '#f472b6', modes: ['day', 'trade'] },
    { key: 'gaps', label: 'Rec. gaps', color: '#fb923c', modes: ['day', 'trade'] },
    { key: 'noData', label: 'No data', color: '#64748b', modes: ['day'] },
    { key: 'jumps', label: 'Price jumps', color: '#facc15', modes: ['day', 'trade'] },
    { key: 'entry', label: 'Entry', color: '#34d399', modes: ['trade'] },
    { key: 'exit', label: 'Exit', color: '#fbbf24', modes: ['trade'] },
    { key: 'tradeMid', label: 'Trade mid', color: '#f59e0b', modes: ['trade'] }
  ];

  var chartOverlayDefaults = {
    avg: true,
    min: false,
    max: false,
    shortCurve: false,
    mediumCurve: false,
    longCurve: false,
    gaps: true,
    noData: true,
    jumps: true,
    entry: true,
    exit: true,
    tradeMid: false
  };

  function readProbeMsFromDom() {
    var shortEl = document.getElementById('probeShortPeriod');
    var mediumEl = document.getElementById('probeMediumPeriod');
    var longEl = document.getElementById('probeLongPeriod');
    var short = parseInt(shortEl && shortEl.value, 10);
    var medium = parseInt(mediumEl && mediumEl.value, 10);
    var longH = parseInt(longEl && longEl.value, 10);
    var shortMin = isNaN(short) || short < 1 ? 5 : Math.min(short, 1440);
    var mediumMin = isNaN(medium) || medium < 1 ? 60 : Math.min(Math.max(medium, 1), 10080);
    var longMin = (isNaN(longH) || longH < 1 ? 24 : Math.min(longH, 720)) * 60;
    if (longMin <= mediumMin) longMin = Math.min(mediumMin * 24, 720 * 60);
    return {
      short: shortMin * 60 * 1000,
      medium: mediumMin * 60 * 1000,
      long: longMin * 60 * 1000,
      shortMin: shortMin,
      mediumMin: mediumMin,
      longMin: longMin
    };
  }

  function computeProbeSeries(samples, probeMs) {
    var n = samples.length;
    if (n === 0) return { short: [], medium: [], long: [] };
    var shortMs = probeMs.short;
    var mediumMs = probeMs.medium;
    var longMs = probeMs.long;
    var shortArr = new Array(n);
    var medArr = new Array(n);
    var longArr = new Array(n);
    var si = 0;
    var mi = 0;
    var li = 0;
    var ss = 0;
    var sm = 0;
    var sl = 0;
    for (var i = 0; i < n; i++) {
      var mid = samples[i].mid;
      var ts = samples[i].ts;
      ss += mid;
      sm += mid;
      sl += mid;
      while (si <= i && samples[si].ts < ts - shortMs) {
        ss -= samples[si].mid;
        si++;
      }
      while (mi <= i && samples[mi].ts < ts - mediumMs) {
        sm -= samples[mi].mid;
        mi++;
      }
      while (li <= i && samples[li].ts < ts - longMs) {
        sl -= samples[li].mid;
        li++;
      }
      shortArr[i] = i >= si ? ss / (i - si + 1) : mid;
      medArr[i] = i >= mi ? sm / (i - mi + 1) : mid;
      longArr[i] = i >= li ? sl / (i - li + 1) : mid;
    }
    return { short: shortArr, medium: medArr, long: longArr };
  }

  function pickAxisTimeStep(spanMs, maxTicks) {
    var steps = [
      1000, 2000, 5000, 10000, 15000, 30000, 60000, 2 * 60000, 5 * 60000, 10 * 60000, 15 * 60000,
      30 * 60000, 3600000, 2 * 3600000, 3 * 3600000, 4 * 3600000, 6 * 3600000, 12 * 3600000, 86400000
    ];
    var target = spanMs / Math.max(2, maxTicks);
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] >= target) return steps[i];
    }
    return steps[steps.length - 1];
  }

  function formatChartAxisTime(ts, t0, t1) {
    var span = t1 - t0;
    var d = new Date(ts);
    if (span > 86400000 * 1.5) {
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    if (span > 3600000 * 2) {
      return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    if (span > 120000) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function nearestSampleIndex(samples, ts) {
    if (!samples || samples.length === 0) return -1;
    if (ts <= samples[0].ts) return 0;
    if (ts >= samples[samples.length - 1].ts) return samples.length - 1;
    var lo = 0;
    var hi = samples.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (samples[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) {
      var d0 = Math.abs(samples[lo - 1].ts - ts);
      var d1 = Math.abs(samples[lo].ts - ts);
      if (d0 <= d1) return lo - 1;
    }
    return lo;
  }

  function getChartOverlays(wrap) {
    if (!wrap) return Object.assign({}, chartOverlayDefaults);
    if (!wrap._chartOverlays) wrap._chartOverlays = Object.assign({}, chartOverlayDefaults);
    else {
      var o = wrap._chartOverlays;
      for (var k in chartOverlayDefaults) {
        if (o[k] === undefined) o[k] = chartOverlayDefaults[k];
      }
    }
    return wrap._chartOverlays;
  }

  function buildChartOverlayUi(chartCtx) {
    if (!tradeChartModalOverlays || !tradeChartOverlayChecks) return;
    var mode = chartCtx && chartCtx.mode === 'trade' ? 'trade' : 'day';
    var overlays = getChartOverlays(tradeChartCanvasWrap);
    tradeChartOverlayChecks.innerHTML = '';
    for (var i = 0; i < CHART_OVERLAY_DEFS.length; i++) {
      var def = CHART_OVERLAY_DEFS[i];
      if (def.modes.indexOf(mode) < 0) continue;
      var lbl = document.createElement('label');
      lbl.className = 'inline-flex items-center gap-1 cursor-pointer text-slate-400 hover:text-slate-300';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'rounded bg-slate-800 border-slate-600';
      cb.checked = !!overlays[def.key];
      cb.setAttribute('data-overlay-key', def.key);
      cb.addEventListener('change', function () {
        var key = this.getAttribute('data-overlay-key');
        getChartOverlays(tradeChartCanvasWrap)[key] = this.checked;
        redrawChart();
      });
      lbl.appendChild(cb);
      var sw = document.createElement('span');
      sw.className = 'inline-block w-2 h-2 rounded-sm shrink-0';
      sw.style.backgroundColor = def.color;
      lbl.appendChild(sw);
      lbl.appendChild(document.createTextNode(def.label));
      tradeChartOverlayChecks.appendChild(lbl);
    }
    tradeChartModalOverlays.classList.remove('hidden');
  }

  function updateChartHoverBar(hoverIdx) {
    if (!tradeChartHoverBar || !tradeChartCanvasWrap) return;
    var samples = tradeChartCanvasWrap._chartSamples;
    if (hoverIdx == null || hoverIdx < 0 || !samples || !samples[hoverIdx]) {
      tradeChartHoverBar.classList.add('hidden');
      tradeChartHoverBar.textContent = '';
      return;
    }
    var s = samples[hoverIdx];
    var probeMs = tradeChartCanvasWrap._chartProbeMs;
    var series = tradeChartCanvasWrap._chartProbeSeries;
    var parts = [formatTimeWithTz(new Date(s.ts).toISOString()), 'Mid ' + Number(s.mid).toFixed(2)];
    if (s.bid != null && s.offer != null) {
      parts.push('Bid ' + Number(s.bid).toFixed(2));
      parts.push('Ask ' + Number(s.offer).toFixed(2));
      parts.push('Spr ' + (Number(s.offer) - Number(s.bid)).toFixed(2));
    }
    if (series && probeMs) {
      if (series.short[hoverIdx] != null) parts.push('S(' + probeMs.shortMin + 'm) ' + series.short[hoverIdx].toFixed(2));
      if (series.medium[hoverIdx] != null) parts.push('M(' + probeMs.mediumMin + 'm) ' + series.medium[hoverIdx].toFixed(2));
      if (series.long[hoverIdx] != null) parts.push('L(' + probeMs.longMin + 'm) ' + series.long[hoverIdx].toFixed(2));
    }
    var anomalies = tradeChartCanvasWrap._chartAnomalies;
    if (anomalies && hoverIdx > 0) {
      var gapMs = samples[hoverIdx].ts - samples[hoverIdx - 1].ts;
      if (gapMs > chartGapBreakMs(samples)) parts.push('After ' + formatDurationMs(gapMs) + ' gap');
    }
    if (anomalies && anomalies.jumps) {
      for (var ji = 0; ji < anomalies.jumps.length; ji++) {
        if (anomalies.jumps[ji].index === hoverIdx) {
          parts.push('Price jump +' + anomalies.jumps[ji].delta.toFixed(2));
          break;
        }
      }
    }
    tradeChartHoverBar.textContent = parts.join('  ·  ');
    tradeChartHoverBar.classList.remove('hidden');
  }

  function redrawChart() {
    if (!tradeChartCanvasWrap) return;
    syncChartWrapHeight();
    var ctx = tradeChartCanvasWrap._chartContext;
    if (!ctx) return;
    var samples = tradeChartCanvasWrap._chartSamples;
    if (samples === null) return;
    drawTradeChartCanvas(Array.isArray(samples) ? samples : [], ctx);
    drawChartCrosshair();
  }

  function prepareChartCanvas(canvas, w, h, fillBg) {
    if (!canvas) return null;
    var dpr = window.devicePixelRatio || 1;
    var bw = Math.max(1, Math.round(w * dpr));
    var bh = Math.max(1, Math.round(h * dpr));
    var ctx = canvas.getContext('2d');
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    canvas.style.width = '';
    canvas.style.height = '';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (fillBg) {
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, w, h);
    }
    return ctx;
  }

  function drawChartCrosshair() {
    if (!tradeChartCanvasOverlay || !tradeChartCanvasWrap) return;
    var layout = tradeChartCanvasWrap._chartLayout;
    var hover = tradeChartCanvasWrap._chartHover;
    var samples = tradeChartCanvasWrap._chartSamples;
    var size = chartWrapSize();
    var w = size.w;
    var h = size.h;
    if (w < 10 || h < 10) return;
    var ctx = prepareChartCanvas(tradeChartCanvasOverlay, w, h, false);
    if (!ctx || !layout || !hover || !samples || !samples[hover.idx]) return;
    var hs = samples[hover.idx];
    var padL = layout.padL;
    var padT = layout.padT;
    var plotW = layout.plotW;
    var plotH = layout.plotH;
    var t0 = layout.t0;
    var tSpan = layout.tSpan;
    var yMin = layout.yMin;
    var yMax = layout.yMax;
    var ySpan = yMax - yMin || 1;
    var hx = padL + ((hs.ts - t0) / tSpan) * plotW;
    var hy = padT + ((yMax - hs.mid) / ySpan) * plotH;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, padT);
    ctx.lineTo(hx, padT + plotH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(padL, hy);
    ctx.lineTo(padL + plotW, hy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function clearChartCrosshair() {
    if (!tradeChartCanvasOverlay || !tradeChartCanvasWrap) return;
    var size = chartWrapSize();
    if (size.w < 1 || size.h < 1) return;
    prepareChartCanvas(tradeChartCanvasOverlay, size.w, size.h, false);
  }

  function onChartMouseMove(e) {
    if (!tradeChartCanvasOverlay || !tradeChartCanvasWrap) return;
    var layout = tradeChartCanvasWrap._chartLayout;
    var samples = tradeChartCanvasWrap._chartSamples;
    if (!layout || !samples || samples.length < 1) return;
    var rect = tradeChartCanvasOverlay.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var plotRight = layout.padL + layout.plotW;
    var plotBottom = layout.padT + layout.plotH;
    if (x < layout.padL || x > plotRight || y < layout.padT || y > plotBottom) {
      if (tradeChartCanvasWrap._chartHover) {
        tradeChartCanvasWrap._chartHover = null;
        updateChartHoverBar(null);
        clearChartCrosshair();
      }
      return;
    }
    var ts = layout.t0 + ((x - layout.padL) / layout.plotW) * layout.tSpan;
    var idx = nearestSampleIndex(samples, ts);
    var nextHover = { idx: idx };
    var prev = tradeChartCanvasWrap._chartHover;
    if (prev && prev.idx === nextHover.idx) return;
    tradeChartCanvasWrap._chartHover = nextHover;
    updateChartHoverBar(idx);
    drawChartCrosshair();
  }

  function onChartMouseLeave() {
    if (tradeChartCanvasWrap) tradeChartCanvasWrap._chartHover = null;
    updateChartHoverBar(null);
    clearChartCrosshair();
  }

  /** @param {{ mode: 'trade'|'day', trade?: object, day?: string, sampleCount?: number }} chartCtx */
  function drawTradeChartCanvas(samples, chartCtx) {
    var canvas = tradeChartCanvas;
    var wrapEl = tradeChartCanvasWrap;
    if (!canvas || !wrapEl || !chartCtx) return;
    samples = normalizeChartSamples(Array.isArray(samples) ? samples : []);
    var padL = 58;
    var padR = 14;
    var padT = 22;
    var padB = 44;
    var minPlotW = 24;
    var minPlotH = 24;
    var minTotalW = padL + padR + minPlotW;
    var minTotalH = padT + padB + minPlotH;
    var size = chartWrapSize();
    var w = size.w;
    var h = size.h;
    if (w < minTotalW || h < minTotalH) {
      if (wrapEl._chartSamples !== null && samples.length >= 1) {
        if (chartLayoutRetries < 12) {
          chartLayoutRetries += 1;
          requestAnimationFrame(function () {
            redrawChart();
          });
        }
      }
      return;
    }
    if (wrapEl._chartSamples === null) {
      var loadCtx = prepareChartCanvas(tradeChartCanvas, w, h, true);
      if (!loadCtx) return;
      loadCtx.fillStyle = '#94a3b8';
      loadCtx.font = '13px system-ui,sans-serif';
      loadCtx.fillText('Loading samples…', 16, 36);
      wrapEl._chartLayout = null;
      return;
    }
    if (samples.length < 1) {
      var emptyCtx = prepareChartCanvas(tradeChartCanvas, w, h, true);
      if (!emptyCtx) return;
      emptyCtx.fillStyle = '#94a3b8';
      emptyCtx.font = '13px system-ui,sans-serif';
      emptyCtx.fillText('No recorded samples in this time range.', 16, 36);
      wrapEl._chartLayout = null;
      return;
    }
    if (samples.length === 1) {
      var oneCtx = prepareChartCanvas(tradeChartCanvas, w, h, true);
      if (!oneCtx) return;
      var onePadL = padL;
      var onePlotW = w - padL - padR;
      var onePlotH = h - padT - padB;
      var oneMid = Number(samples[0].mid);
      var oneY = padT + onePlotH / 2;
      oneCtx.strokeStyle = '#334155';
      oneCtx.beginPath();
      oneCtx.moveTo(onePadL, oneY);
      oneCtx.lineTo(onePadL + onePlotW, oneY);
      oneCtx.stroke();
      oneCtx.fillStyle = '#0ea5e9';
      oneCtx.beginPath();
      oneCtx.arc(onePadL + onePlotW / 2, oneY, 5, 0, Math.PI * 2);
      oneCtx.fill();
      oneCtx.fillStyle = '#94a3b8';
      oneCtx.font = '12px system-ui,sans-serif';
      oneCtx.fillText('Only 1 sample in range — mid ' + oneMid.toFixed(2), 16, h - 16);
      wrapEl._chartLayout = null;
      return;
    }
    try {
    var ctx = prepareChartCanvas(tradeChartCanvas, w, h, true);
    if (!ctx) return;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;
    var dayRange = chartCtx.mode === 'day' && chartCtx.day ? dayChartTimeRange(chartCtx.day) : null;
    var sampleT0 = samples[0].ts;
    var sampleT1 = samples[samples.length - 1].ts;
    var t0 = sampleT0;
    var t1 = sampleT1;
    if (dayRange) {
      var daySpan = dayRange.end - dayRange.start;
      var sampleSpan = Math.max(1, sampleT1 - sampleT0);
      if (sampleSpan >= daySpan * 0.25) {
        t0 = dayRange.start;
        t1 = dayRange.end;
      } else {
        var pad = Math.max(120000, sampleSpan * 0.12);
        t0 = Math.max(dayRange.start, sampleT0 - pad);
        t1 = Math.min(dayRange.end, sampleT1 + pad);
      }
    }
    var tSpan = t1 - t0 || 1;
    var mids = [];
    for (var si = 0; si < samples.length; si++) mids.push(samples[si].mid);
    var mm = minMaxMids(mids);
    var yMin = mm.min;
    var yMax = mm.max;
    var yPad = (yMax - yMin) * 0.08 || 0.01;
    yMin -= yPad;
    yMax += yPad;
    var ySpan = yMax - yMin || 1;
    var anomalies = computeChartAnomalies(samples, chartCtx);
    wrapEl._chartAnomalies = anomalies;
    wrapEl._chartLayout = { padL: padL, padR: padR, padT: padT, padB: padB, plotW: plotW, plotH: plotH, t0: t0, t1: t1, tSpan: tSpan, yMin: yMin, yMax: yMax, w: w, h: h };
    var overlays = getChartOverlays(wrapEl);
    var probeMs = readProbeMsFromDom();
    wrapEl._chartProbeMs = probeMs;
    if (!wrapEl._chartProbeSeries || wrapEl._chartProbeSeriesForLength !== samples.length) {
      wrapEl._chartProbeSeries = computeProbeSeries(samples, probeMs);
      wrapEl._chartProbeSeriesForLength = samples.length;
    }
    var probeSeries = wrapEl._chartProbeSeries;
    function xAt(ts) {
      return padL + ((ts - t0) / tSpan) * plotW;
    }
    function yAt(price) {
      return padT + ((yMax - price) / ySpan) * plotH;
    }
    function drawMarker(ts, color, label) {
      if (ts < t0 || ts > t1) return;
      var x = xAt(ts);
      ctx.strokeStyle = color;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '10px system-ui,sans-serif';
      ctx.fillText(label, Math.min(x + 3, w - padR - 48), padT + 12);
    }
    function drawHLine(price, color, label, dash) {
      if (price == null || isNaN(price)) return;
      var y = yAt(price);
      ctx.strokeStyle = color;
      ctx.setLineDash(dash || [4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = color;
        ctx.font = '10px ui-monospace,monospace';
        ctx.textAlign = 'right';
        ctx.fillText(label + ' ' + price.toFixed(2), padL - 4, Math.max(padT + 10, Math.min(y - 4, padT + plotH - 4)));
        ctx.textAlign = 'left';
      }
    }
    function drawCurve(values, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([]);
      ctx.beginPath();
      var started = false;
      for (var ci = 0; ci < values.length; ci++) {
        if (values[ci] == null || isNaN(values[ci])) continue;
        var cx = xAt(samples[ci].ts);
        var cy = yAt(values[ci]);
        if (!started) {
          ctx.moveTo(cx, cy);
          started = true;
        } else ctx.lineTo(cx, cy);
      }
      if (started) ctx.stroke();
    }
    function drawTimeBand(fromTs, toTs, fillStyle, label) {
      var x1 = xAt(Math.max(t0, fromTs));
      var x2 = xAt(Math.min(t1, toTs));
      if (x2 - x1 < 1) return;
      ctx.fillStyle = fillStyle;
      ctx.fillRect(x1, padT, x2 - x1, plotH);
      if (label && x2 - x1 > 36) {
        ctx.fillStyle = 'rgba(226, 232, 240, 0.75)';
        ctx.font = '9px system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(label, (x1 + x2) / 2, padT + 11);
        ctx.textAlign = 'left';
      }
    }
    function drawQualityOverlays() {
      if (overlays.noData && anomalies.noDataBefore) {
        drawTimeBand(anomalies.noDataBefore.fromTs, anomalies.noDataBefore.toTs, 'rgba(51, 65, 85, 0.45)', 'no data');
      }
      if (overlays.noData && anomalies.noDataAfter) {
        drawTimeBand(anomalies.noDataAfter.fromTs, anomalies.noDataAfter.toTs, 'rgba(51, 65, 85, 0.45)', 'no data');
      }
      if (overlays.gaps) {
        for (var gi = 0; gi < anomalies.gaps.length; gi++) {
          var g = anomalies.gaps[gi];
          var fill =
            g.severity === 'high'
              ? 'rgba(239, 68, 68, 0.22)'
              : g.severity === 'med'
                ? 'rgba(251, 146, 60, 0.22)'
                : 'rgba(251, 191, 36, 0.18)';
          drawTimeBand(g.fromTs, g.toTs, fill, formatDurationMs(g.deltaMs));
        }
      }
    }
    function drawJumpMarkers() {
      if (!overlays.jumps) return;
      for (var ji = 0; ji < anomalies.jumps.length; ji++) {
        var jp = anomalies.jumps[ji];
        if (jp.ts < t0 || jp.ts > t1) continue;
        var jx = xAt(jp.ts);
        var jy = yAt(jp.mid);
        ctx.fillStyle = '#facc15';
        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(jx, jy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    function drawDayBoundaryMarkers() {
      if (chartCtx.mode === 'day' && chartCtx.day) {
        var range = dayChartTimeRange(chartCtx.day);
        if (!range) return;
        if (range.start >= t0 && range.start <= t1) drawMarker(range.start, '#a78bfa', 'SOD');
        if (range.end >= t0 && range.end <= t1) drawMarker(range.end, '#fb7185', 'EOD');
        return;
      }
      var trade = chartCtx.trade;
      if (!trade) return;
      var entryDate = new Date(trade.entryTs);
      var exitDate = new Date(trade.exitTs);
      var startDay = new Date(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate());
      var endDay = new Date(exitDate.getFullYear(), exitDate.getMonth(), exitDate.getDate());
      for (var d = new Date(startDay); d.getTime() <= endDay.getTime(); d.setDate(d.getDate() + 1)) {
        var dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
        var dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
        if (dayStart >= t0 && dayStart <= t1) drawMarker(dayStart, '#a78bfa', 'SOD');
        if (dayEnd >= t0 && dayEnd <= t1) drawMarker(dayEnd, '#fb7185', 'EOD');
      }
    }
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var yy = padT + (gi / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(padL + plotW, yy);
      ctx.stroke();
      var yVal = yMax - (gi / 4) * ySpan;
      ctx.fillStyle = '#64748b';
      ctx.font = '10px ui-monospace,monospace';
      ctx.textAlign = 'right';
      ctx.fillText(yVal.toFixed(2), padL - 4, yy + 3);
    }
    ctx.textAlign = 'left';
    var timeStep = pickAxisTimeStep(tSpan, Math.max(4, Math.floor(plotW / 72)));
    var tickStart = Math.ceil(t0 / timeStep) * timeStep;
    ctx.strokeStyle = '#334155';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px ui-monospace,monospace';
    ctx.textAlign = 'center';
    var lastDayKey = '';
    for (var tick = tickStart; tick <= t1; tick += timeStep) {
      var tx = xAt(tick);
      ctx.beginPath();
      ctx.moveTo(tx, padT + plotH);
      ctx.lineTo(tx, padT + plotH + 5);
      ctx.stroke();
      var tickDate = new Date(tick);
      var dayKey = tickDate.getFullYear() + '-' + tickDate.getMonth() + '-' + tickDate.getDate();
      var label = formatChartAxisTime(tick, t0, t1);
      if (tSpan > 86400000 && dayKey !== lastDayKey) {
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(label, tx, h - 8);
        lastDayKey = dayKey;
      } else {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(label, tx, h - 8);
      }
    }
    ctx.textAlign = 'left';
    drawQualityOverlays();
    if (overlays.shortCurve && probeSeries) drawCurve(probeSeries.short, '#22d3ee');
    if (overlays.mediumCurve && probeSeries) drawCurve(probeSeries.medium, '#a78bfa');
    if (overlays.longCurve && probeSeries) drawCurve(probeSeries.long, '#f472b6');
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    var lineGapMs = chartGapBreakMs(samples);
    var pathOpen = false;
    for (var j = 0; j < samples.length; j++) {
      if (j > 0 && samples[j].ts - samples[j - 1].ts > lineGapMs) {
        if (pathOpen) ctx.stroke();
        ctx.beginPath();
        pathOpen = false;
      }
      var sx = xAt(samples[j].ts);
      var sy = yAt(samples[j].mid);
      if (!pathOpen) {
        ctx.moveTo(sx, sy);
        pathOpen = true;
      } else ctx.lineTo(sx, sy);
    }
    if (pathOpen) ctx.stroke();
    drawJumpMarkers();
    var midAvg = mids.reduce(function (s, v) { return s + v; }, 0) / mids.length;
    var rangeMin = mm.min;
    var rangeMax = mm.max;
    if (overlays.avg) drawHLine(midAvg, '#60a5fa', 'AVG');
    if (overlays.min) drawHLine(rangeMin, '#34d399', 'MIN');
    if (overlays.max) drawHLine(rangeMax, '#f87171', 'MAX');
    if (chartCtx.mode === 'trade' && chartCtx.trade) {
      var tr = chartCtx.trade;
      if (overlays.entry && tr.entryPrice != null) drawHLine(Number(tr.entryPrice), '#34d399', 'Entry', [6, 3]);
      if (overlays.exit && tr.exitPrice != null) drawHLine(Number(tr.exitPrice), '#fbbf24', 'Exit', [6, 3]);
      if (overlays.tradeMid && tr.entryPrice != null && tr.exitPrice != null) {
        var tradeAvg = (Number(tr.entryPrice) + Number(tr.exitPrice)) / 2;
        if (!isNaN(tradeAvg)) drawHLine(tradeAvg, '#f59e0b', 'TRD');
      }
      if (overlays.entry) drawMarker(tr.entryTs, '#34d399', 'Open');
      if (overlays.exit) drawMarker(tr.exitTs, '#fbbf24', 'Close');
    }
    drawDayBoundaryMarkers();
    updateChartModalQualityNote();
    chartLayoutRetries = 0;
    } catch (err) {
      console.error('Chart draw failed:', err);
      var errCtx = prepareChartCanvas(tradeChartCanvas, w, h, true);
      if (errCtx) {
        errCtx.fillStyle = '#f87171';
        errCtx.font = '13px system-ui,sans-serif';
        errCtx.fillText('Chart draw error — see browser console.', 16, 36);
      }
    }
  }

  function closeTradeChartModal() {
    if (tradeChartModalRules) {
      tradeChartModalRules.innerHTML = '';
      tradeChartModalRules.classList.add('hidden');
    }
    if (tradeChartModalOverlays) tradeChartModalOverlays.classList.add('hidden');
    if (tradeChartHoverBar) {
      tradeChartHoverBar.classList.add('hidden');
      tradeChartHoverBar.textContent = '';
    }
    if (tradeChartCanvasWrap) {
      tradeChartCanvasWrap._chartHover = null;
      tradeChartCanvasWrap._chartLayout = null;
      tradeChartCanvasWrap._chartProbeSeries = null;
      tradeChartCanvasWrap._chartProbeSeriesForLength = 0;
      tradeChartCanvasWrap._chartAnomalies = null;
    }
    if (chartResizeDebounce != null) {
      clearTimeout(chartResizeDebounce);
      chartResizeDebounce = null;
    }
    if (tradeChartModal) {
      tradeChartModal.classList.add('hidden');
      tradeChartModal.setAttribute('aria-hidden', 'true');
    }
    if (chartResizeObserver && tradeChartCanvasWrap) {
      chartResizeObserver.disconnect();
      chartResizeObserver = null;
    }
    document.removeEventListener('keydown', tradeChartEscapeHandler);
  }
  function tradeChartEscapeHandler(e) {
    if (e.key === 'Escape') closeTradeChartModal();
  }

  function openChartModalShell(chartCtx) {
    chartLayoutRetries = 0;
    tradeChartModal.classList.remove('hidden');
    tradeChartModal.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', tradeChartEscapeHandler);
    buildChartOverlayUi(chartCtx);
    if (tradeChartCanvasWrap) tradeChartCanvasWrap._chartHover = null;
    updateChartHoverBar(null);
    if (chartResizeObserver) chartResizeObserver.disconnect();
    layoutChartPanelOnOpen();
    syncChartWrapHeight();
    if (tradeChartCanvasWrap && typeof ResizeObserver !== 'undefined') {
      chartResizeObserver = new ResizeObserver(function () {
        scheduleChartResizeRedraw();
      });
      chartResizeObserver.observe(tradeChartCanvasWrap);
      chartResizeObserver.observe(tradeChartModalPanel);
    }
    scheduleChartLayoutRedraw();
  }

  function requestChartSamples(epic, fromTs, toTs, chartCtx, days) {
    lastChartReqSeq += 1;
    var reqSeq = lastChartReqSeq;
    if (tradeChartCanvasWrap) {
      tradeChartCanvasWrap._chartContext = chartCtx;
      tradeChartCanvasWrap._chartSamples = null;
      tradeChartCanvasWrap._chartProbeSeries = null;
      tradeChartCanvasWrap._chartProbeSeriesForLength = 0;
      tradeChartCanvasWrap._chartHover = null;
    }
    chartLayoutRetries = 0;
    syncChartWrapHeight();
    drawTradeChartCanvas([], chartCtx);
    updateChartHoverBar(null);
    var payload = { epic: epic, reqId: reqSeq };
    if (days && days.length > 0) payload.days = days;
    else {
      payload.fromTs = fromTs;
      payload.toTs = toTs;
    }
    socket.emit('trade_chart_samples', payload);
    return reqSeq;
  }

  function openDayChartModal(epic, day, sampleCount) {
    if (!tradeChartModal || !tradeChartModalMeta) return;
    if (!epic) {
      appendLog('Select an instrument before opening day chart');
      return;
    }
    var range = dayChartTimeRange(day);
    if (!range) {
      appendLog('Invalid day: ' + day);
      return;
    }
    var chartCtx = { mode: 'day', day: day, sampleCount: sampleCount };
    openChartModalShell(chartCtx);
    if (tradeChartModalTitle) tradeChartModalTitle.textContent = 'Day chart — ' + day;
    var countStr =
      typeof sampleCount === 'number' && sampleCount >= 0 ? sampleCount.toLocaleString() + ' samples' : '—';
    tradeChartModalMeta.innerHTML =
      '<div><span class="text-slate-500">Epic</span> ' +
      escapeHtml(epic) +
      '</div>' +
      '<div><span class="text-slate-500">Date</span> ' +
      escapeHtml(day) +
      ' (local calendar day) &nbsp;|&nbsp; <span class="text-slate-500">Recorded</span> ' +
      countStr +
      '</div>' +
      '<div class="text-slate-500">Recorded mid price — no backtest required.</div>';
    if (tradeChartModalRules) {
      tradeChartModalRules.innerHTML = '';
      tradeChartModalRules.classList.add('hidden');
    }
    if (tradeChartModalHint) {
      tradeChartModalHint.textContent =
        'SOD/EOD = start/end of local calendar day. Hover for values; toggle probe avg curves to match rule conditions.';
    }
    requestChartSamples(epic, range.start, range.end, chartCtx, [day]);
  }

  function openTradeChartModal(trade, index) {
    if (!tradeChartModal || !tradeChartModalMeta) return;
    var epic = lastAnalyseEpic || (epicSelect && epicSelect.value) || state.savedEpic || '';
    if (!epic) {
      appendLog('Select an instrument (epic) before opening trade chart');
      return;
    }
    var chartCtx = { mode: 'trade', trade: trade };
    openChartModalShell(chartCtx);
    if (tradeChartModalTitle) tradeChartModalTitle.textContent = 'Trade #' + (index + 1) + ' — ' + trade.direction;
    var dur = formatDurationMs(trade.exitTs - trade.entryTs);
    var pnl = (trade.profitLoss || 0) * lastTradePlMult;
    var pnlStr = lastTradeUsePounds ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' $' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' pts';
    var pnlClass = pnl >= 0 ? 'text-emerald-400' : 'text-red-400';
    tradeChartModalMeta.innerHTML =
      '<div><span class="text-slate-500">Epic</span> ' + epic + '</div>' +
      '<div><span class="text-slate-500">Entry</span> ' + formatTimeWithTz(new Date(trade.entryTs).toISOString()) + ' @ ' + (trade.entryPrice != null ? Number(trade.entryPrice).toFixed(2) : '—') +
      ' &nbsp;|&nbsp; <span class="text-slate-500">Exit</span> ' + formatTimeWithTz(new Date(trade.exitTs).toISOString()) + ' @ ' + (trade.exitPrice != null ? Number(trade.exitPrice).toFixed(2) : '—') + '</div>' +
      '<div><span class="text-slate-500">P/L</span> <span class="' + pnlClass + '">' + pnlStr + '</span>' +
      ' &nbsp;|&nbsp; <span class="text-slate-500">Duration</span> ' + dur +
      ' &nbsp;|&nbsp; <span class="text-slate-500">Close</span> ' + exitReasonLabel(trade.exitReason) + '</div>';
    if (tradeChartModalRules) {
      tradeChartModalRules.classList.remove('hidden');
      if (trade.entryRules && trade.entryRules.length > 0) {
        tradeChartModalRules.innerHTML =
          '<div class="text-slate-500 mb-1">Entry rules (all must have passed)</div>' +
          '<ul class="list-disc pl-4 space-y-0.5 text-slate-300">' +
          trade.entryRules
            .map(function (r) {
              return '<li>' + formatEntryRuleLineHtml(r) + '</li>';
            })
            .join('') +
          '</ul>';
      } else {
        tradeChartModalRules.innerHTML =
          '<div class="text-slate-500">Entry rules are not available for this result. Run analysis again to store rule lines on each trade.</div>';
      }
    }
    if (tradeChartModalHint) {
      tradeChartModalHint.textContent =
        'Hover for bid/ask and short/medium/long averages at that moment. Toggle lines above the chart.';
    }
    var b = tradeBoundsLocalDays(trade.entryTs, trade.exitTs);
    requestChartSamples(epic, b.start, b.end, chartCtx);
  }

  socket.on('trade_chart_samples_result', function (data) {
    if (!data || data.reqId !== lastChartReqSeq) return;
    if (data.error) {
      if (tradeChartModalMeta) {
        tradeChartModalMeta.innerHTML = '<div class="text-amber-400">' + escapeHtml(data.error) + '</div>';
      }
      if (tradeChartCanvasWrap) tradeChartCanvasWrap._chartSamples = [];
      var errCtx = tradeChartCanvasWrap && tradeChartCanvasWrap._chartContext;
      drawTradeChartCanvas([], errCtx || { mode: 'day', day: '' });
      return;
    }
    var samples = data.samples || [];
    var chartCtx = tradeChartCanvasWrap && tradeChartCanvasWrap._chartContext;
    if (tradeChartModalHint && data.thinned) {
      tradeChartModalHint.textContent =
        'Recorded mid (downsampled for display — ' +
        (data.count || samples.length) +
        ' samples in range). Drag corner to resize.';
    }
    if (tradeChartCanvasWrap) {
      tradeChartCanvasWrap._chartSamples = samples;
      tradeChartCanvasWrap._chartProbeSeries = null;
      tradeChartCanvasWrap._chartProbeSeriesForLength = 0;
    }
    if (chartCtx) {
      chartLayoutRetries = 0;
      requestAnimationFrame(function () {
        syncChartWrapHeight();
        requestAnimationFrame(function () {
          redrawChart();
        });
      });
    }
  });

  if (tradeChartCanvasOverlay) {
    tradeChartCanvasOverlay.addEventListener('mousemove', onChartMouseMove);
    tradeChartCanvasOverlay.addEventListener('mouseleave', onChartMouseLeave);
  }

  if (tradeChartResizeGrip && tradeChartModalPanel) {
    var chartPanelResizing = false;
    var chartPanelStartX = 0;
    var chartPanelStartY = 0;
    var chartPanelStartW = 0;
    var chartPanelStartH = 0;
    var chartPanelActivePointer = null;
    function chartPanelResizeMove(e) {
      if (!chartPanelResizing || e.pointerId !== chartPanelActivePointer) return;
      setChartPanelSize(
        chartPanelStartW + (e.clientX - chartPanelStartX),
        chartPanelStartH + (e.clientY - chartPanelStartY),
        false
      );
    }
    function chartPanelResizeEnd(e) {
      if (!chartPanelResizing) return;
      if (e && e.pointerId != null && chartPanelActivePointer != null && e.pointerId !== chartPanelActivePointer) return;
      chartPanelResizing = false;
      chartPanelActivePointer = null;
      document.removeEventListener('pointermove', chartPanelResizeMove);
      document.removeEventListener('pointerup', chartPanelResizeEnd);
      document.removeEventListener('pointercancel', chartPanelResizeEnd);
      clampChartPanelToViewport();
      scheduleChartResizeRedraw();
    }
    tradeChartResizeGrip.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      chartPanelResizing = true;
      chartPanelActivePointer = e.pointerId;
      chartPanelStartX = e.clientX;
      chartPanelStartY = e.clientY;
      chartPanelStartW = tradeChartModalPanel.offsetWidth;
      chartPanelStartH = tradeChartModalPanel.offsetHeight;
      if (tradeChartResizeGrip.setPointerCapture) {
        try {
          tradeChartResizeGrip.setPointerCapture(e.pointerId);
        } catch (err) { /* ignore */ }
      }
      document.addEventListener('pointermove', chartPanelResizeMove);
      document.addEventListener('pointerup', chartPanelResizeEnd);
      document.addEventListener('pointercancel', chartPanelResizeEnd);
    });
  }

  if (tradeChartModalHeader && tradeChartModalPanel) {
    var chartPanelDragging = false;
    var chartPanelDragPointer = null;
    var chartPanelDragStartX = 0;
    var chartPanelDragStartY = 0;
    var chartPanelDragStartLeft = 0;
    var chartPanelDragStartTop = 0;
    function chartPanelDragMove(e) {
      if (!chartPanelDragging || e.pointerId !== chartPanelDragPointer) return;
      var left = chartPanelDragStartLeft + (e.clientX - chartPanelDragStartX);
      var top = chartPanelDragStartTop + (e.clientY - chartPanelDragStartY);
      tradeChartModalPanel.style.left = left + 'px';
      tradeChartModalPanel.style.top = top + 'px';
    }
    function chartPanelDragEnd(e) {
      if (!chartPanelDragging) return;
      if (e && e.pointerId != null && chartPanelDragPointer != null && e.pointerId !== chartPanelDragPointer) return;
      chartPanelDragging = false;
      chartPanelDragPointer = null;
      document.removeEventListener('pointermove', chartPanelDragMove);
      document.removeEventListener('pointerup', chartPanelDragEnd);
      document.removeEventListener('pointercancel', chartPanelDragEnd);
      clampChartPanelToViewport();
    }
    tradeChartModalHeader.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      tradeChartModalPanel.style.position = 'fixed';
      var rect = tradeChartModalPanel.getBoundingClientRect();
      chartPanelDragging = true;
      chartPanelDragPointer = e.pointerId;
      chartPanelDragStartX = e.clientX;
      chartPanelDragStartY = e.clientY;
      chartPanelDragStartLeft = rect.left;
      chartPanelDragStartTop = rect.top;
      if (tradeChartModalHeader.setPointerCapture) {
        try {
          tradeChartModalHeader.setPointerCapture(e.pointerId);
        } catch (err) { /* ignore */ }
      }
      document.addEventListener('pointermove', chartPanelDragMove);
      document.addEventListener('pointerup', chartPanelDragEnd);
      document.addEventListener('pointercancel', chartPanelDragEnd);
    });
  }

  if (tradeChartSizeUp) {
    tradeChartSizeUp.addEventListener('click', function (e) {
      e.stopPropagation();
      bumpChartPanelSize(80, 60);
    });
  }
  if (tradeChartSizeDown) {
    tradeChartSizeDown.addEventListener('click', function (e) {
      e.stopPropagation();
      bumpChartPanelSize(-80, -60);
    });
  }

  if (tradeChartModalClose) tradeChartModalClose.addEventListener('click', closeTradeChartModal);
  if (tradeChartModalBackdrop) {
    tradeChartModalBackdrop.addEventListener('click', closeTradeChartModal);
  }
  if (tradeChartModalPanel) {
    tradeChartModalPanel.addEventListener('click', function (e) {
      e.stopPropagation();
    });
  }
  if (reportEl) {
    reportEl.addEventListener('click', function (e) {
      var noTradeLi = e.target && e.target.closest ? e.target.closest('li[data-day-no-trade]') : null;
      if (noTradeLi) {
        var day = noTradeLi.getAttribute('data-day-no-trade');
        var sampleCount = parseInt(noTradeLi.getAttribute('data-day-samples') || '', 10);
        var epic = lastAnalyseEpic || (epicSelect && epicSelect.value) || state.savedEpic || '';
        openDayChartModal(epic, day, isNaN(sampleCount) ? null : sampleCount);
        return;
      }
      var li = e.target && e.target.closest ? e.target.closest('li[data-trade-index]') : null;
      if (!li) return;
      var ix = parseInt(li.getAttribute('data-trade-index'), 10);
      if (isNaN(ix) || !lastTrades[ix]) return;
      openTradeChartModal(lastTrades[ix], ix);
    });
    reportEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var noTradeLi = e.target && e.target.closest ? e.target.closest('li[data-day-no-trade]') : null;
      if (noTradeLi) {
        e.preventDefault();
        var day = noTradeLi.getAttribute('data-day-no-trade');
        var sampleCount = parseInt(noTradeLi.getAttribute('data-day-samples') || '', 10);
        var epic = lastAnalyseEpic || (epicSelect && epicSelect.value) || state.savedEpic || '';
        openDayChartModal(epic, day, isNaN(sampleCount) ? null : sampleCount);
        return;
      }
      var li = e.target && e.target.closest ? e.target.closest('li[data-trade-index]') : null;
      if (!li) return;
      e.preventDefault();
      var ix = parseInt(li.getAttribute('data-trade-index'), 10);
      if (isNaN(ix) || !lastTrades[ix]) return;
      openTradeChartModal(lastTrades[ix], ix);
    });
  }
  if (testRulesTradeList) {
    testRulesTradeList.addEventListener('click', function (e) {
      var li = e.target && e.target.closest ? e.target.closest('li[data-trade-index]') : null;
      if (!li) return;
      var ix = parseInt(li.getAttribute('data-trade-index'), 10);
      if (isNaN(ix) || !lastTrades[ix]) return;
      openTradeChartModal(lastTrades[ix], ix);
    });
  }

  function dayKeyFromTs(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function renderTradeRowHtml(t, idx, dayPrefix) {
    var usePounds = lastTradeUsePounds;
    var mult = lastTradePlMult;
    var entryTime = formatTimeWithTz(new Date(t.entryTs).toISOString());
    var closeTime = formatTimeWithTz(new Date(t.exitTs).toISOString());
    var plClass = (t.profitLoss || 0) >= 0 ? 'text-emerald-400' : 'text-red-400';
    var val = usePounds ? (t.profitLoss || 0) * mult : (t.profitLoss || 0);
    var plStr = val >= 0 ? '+' + val.toFixed(2) : val.toFixed(2);
    var unit = usePounds ? ' $' : ' pts';
    var er = t.exitReason || '';
    var tag = er === 'tp' ? 'TP' : er === 'sl' ? 'SL' : er === 'dsl' ? 'DynSL' : er === 'rules' ? 'Rules' : er === 'endOfPeriod' ? 'EOD' : '';
    var tagHtml = tag ? ' <span class="text-slate-500" title="Close reason">' + tag + '</span>' : '';
    var dayStr = dayPrefix ? '<span class="text-slate-500">' + escapeHtml(dayPrefix) + '</span> ' : '';
    return (
      '<li class="cursor-pointer rounded px-1 -mx-1 py-0.5 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-sky-500/50" data-trade-index="' +
      idx +
      '" role="button" tabindex="0" title="Click for entry/exit chart">' +
      dayStr +
      entryTime +
      ' \u2192 ' +
      closeTime +
      ' — ' +
      t.direction +
      ' <span class="' +
      plClass +
      '">' +
      plStr +
      unit +
      '</span>' +
      tagHtml +
      '</li>'
    );
  }

  function renderNoTradeDayRowHtml(dayInfo) {
    var noSamples = dayInfo.status === 'noSamples';
    var label = noSamples ? '— no samples (skipped)' : '— no simulated trade';
    if (noSamples) {
      return (
        '<li class="rounded px-1 -mx-1 py-0.5 text-slate-600">' +
        escapeHtml(dayInfo.day) +
        ' ' +
        label +
        '</li>'
      );
    }
    return (
      '<li class="cursor-pointer rounded px-1 -mx-1 py-0.5 text-slate-500 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-sky-500/50" data-day-no-trade="' +
      escapeHtml(dayInfo.day) +
      '" data-day-samples="' +
      (dayInfo.sampleCount != null ? dayInfo.sampleCount : '') +
      '" role="button" tabindex="0" title="Click for day price chart">' +
      escapeHtml(dayInfo.day) +
      ' ' +
      label +
      '</li>'
    );
  }

  function resolveAnalysedDaysForReport(report, sampleQuality) {
    if (report.analysedDays && report.analysedDays.length > 0) {
      return report.analysedDays.slice();
    }
    var trades = Array.isArray(report.trades) ? report.trades : [];
    var byDay = Object.create(null);
    for (var i = 0; i < trades.length; i++) {
      var dk = dayKeyFromTs(trades[i].entryTs);
      if (!byDay[dk]) byDay[dk] = [];
      byDay[dk].push(trades[i]);
    }
    function summarizeDay(day, sampleCount) {
      var dayTrades = byDay[day] || [];
      var pl = 0;
      for (var j = 0; j < dayTrades.length; j++) pl += dayTrades[j].profitLoss || 0;
      var sc = sampleCount != null && !isNaN(sampleCount) ? sampleCount : 0;
      return {
        day: day,
        sampleCount: sc,
        tradeCount: dayTrades.length,
        totalGainLoss: pl,
        status: sc === 0 ? 'noSamples' : undefined
      };
    }
    function sampleCountForDay(day) {
      if (!sampleQuality || !sampleQuality.days) return null;
      for (var k = 0; k < sampleQuality.days.length; k++) {
        if (sampleQuality.days[k].day === day) return sampleQuality.days[k].count;
      }
      return null;
    }
    function keysFromSources() {
      if (lastAnalyseDayKeys.length > 0) return lastAnalyseDayKeys.slice().sort();
      if (lastAnalyseSelectedDays.length > 0) return lastAnalyseSelectedDays.slice().sort();
      if (sampleQuality && sampleQuality.days && sampleQuality.days.length > 0) {
        return sampleQuality.days
          .map(function (d) {
            return d.day;
          })
          .sort();
      }
      var fromTrades = Object.keys(byDay).sort();
      return fromTrades;
    }
    var dayKeys = keysFromSources();
    if (dayKeys.length === 0) return [];
    return dayKeys.map(function (day) {
      var sc = sampleCountForDay(day);
      return summarizeDay(day, sc != null ? sc : 1);
    });
  }

  function mergeAnalyseReportPayload(data) {
    if (!data || !data.report) return null;
    var report = data.report;
    var trades = Array.isArray(data.trades)
      ? data.trades
      : Array.isArray(report.trades)
        ? report.trades
        : [];
    var analysedDays = Array.isArray(data.analysedDays) && data.analysedDays.length > 0
      ? data.analysedDays
      : report.analysedDays;
    return Object.assign({}, report, {
      trades: trades,
      analysedDays: analysedDays
    });
  }

  function renderBacktestTradeList(r, sampleQuality, tradeListEl, countEl) {
    if (!tradeListEl) return 0;
    var trades = Array.isArray(r.trades) ? r.trades : [];
    lastTrades = trades.slice();
    lastAnalysedDays = resolveAnalysedDaysForReport(r, sampleQuality);

    var usePounds = r.totalGainLossPounds != null && r.totalGainLoss != null && r.totalGainLoss !== 0;
    lastTradePlMult = usePounds ? r.totalGainLossPounds / r.totalGainLoss : 1;
    lastTradeUsePounds = usePounds;

    var html = '';
    var rowCount = 0;
    var summaryTradeCount = r.tradeCount != null ? r.tradeCount : 0;
    var tradesMissing = trades.length === 0 && summaryTradeCount > 0;

    if (tradesMissing) {
      html =
        '<li class="text-amber-400/90 px-1 py-0.5">Summary shows ' +
        summaryTradeCount +
        ' trade(s) but trade details did not arrive — restart the server (npm run build && npm start) and hard-refresh the page (Ctrl+Shift+R).</li>';
      rowCount = 1;
    } else if (trades.length > 0 && lastAnalysedDays.length === 0) {
      for (var idx = 0; idx < trades.length; idx++) {
        html += renderTradeRowHtml(trades[idx], idx, null);
        rowCount++;
      }
    } else if (lastAnalysedDays.length > 0) {
      var byDay = Object.create(null);
      for (var i = 0; i < trades.length; i++) {
        var dk = dayKeyFromTs(trades[i].entryTs);
        if (!byDay[dk]) byDay[dk] = [];
        byDay[dk].push({ trade: trades[i], idx: i });
      }
      var shownTrade = Object.create(null);
      for (var d = 0; d < lastAnalysedDays.length; d++) {
        var dayInfo = lastAnalysedDays[d];
        var dayTrades = byDay[dayInfo.day] || [];
        if (dayTrades.length === 0) {
          html += renderNoTradeDayRowHtml(dayInfo);
          rowCount++;
        } else {
          for (var j = 0; j < dayTrades.length; j++) {
            html += renderTradeRowHtml(dayTrades[j].trade, dayTrades[j].idx, dayInfo.day);
            shownTrade[dayTrades[j].idx] = true;
            rowCount++;
          }
        }
      }
      for (var ti = 0; ti < trades.length; ti++) {
        if (shownTrade[ti]) continue;
        html += renderTradeRowHtml(trades[ti], ti, dayKeyFromTs(trades[ti].entryTs));
        rowCount++;
      }
    } else if (trades.length > 0) {
      for (var tix = 0; tix < trades.length; tix++) {
        html += renderTradeRowHtml(trades[tix], tix, null);
        rowCount++;
      }
    }

    tradeListEl.innerHTML = html;
    if (countEl) {
      if (lastAnalysedDays.length > 0) {
        countEl.textContent = '(' + lastAnalysedDays.length + ' days · ' + trades.length + ' trades)';
      } else if (trades.length > 0) {
        countEl.textContent = '(' + trades.length + ' trades)';
      } else if (r.tradeCount > 0) {
        countEl.textContent = '(' + r.tradeCount + ' trades)';
      } else {
        countEl.textContent = '';
      }
    }
    return rowCount;
  }

  function showReport(report, usedTpSl, usedDynamicSl, sampleQuality, scrollIntoView) {
    if (!reportBody || !reportEl) return;
    var r = report;
    var totalPl = r.totalGainLossPounds != null
      ? (r.totalGainLossPounds >= 0 ? '+' : '') + r.totalGainLossPounds.toFixed(2) + ' $'
      : (r.totalGainLoss != null ? (r.totalGainLoss >= 0 ? '+' : '') + r.totalGainLoss.toFixed(2) + ' pts' : '—');
    var avgPl = r.avgTradePnlPounds != null
      ? (r.avgTradePnlPounds >= 0 ? '+' : '') + r.avgTradePnlPounds.toFixed(2) + ' $'
      : (r.avgTradePnl != null ? (r.avgTradePnl >= 0 ? '+' : '') + r.avgTradePnl.toFixed(2) + ' pts' : '—');
    var rows = [
      ['Total P/L', totalPl],
      ['Trades', r.tradeCount != null ? String(r.tradeCount) : '—'],
      ['Winning', r.winningTrades != null ? String(r.winningTrades) : '—'],
      ['Losing', r.losingTrades != null ? String(r.losingTrades) : '—'],
      ['Win rate', r.winRate != null ? r.winRate.toFixed(1) + '%' : '—'],
      ['Avg P/L', avgPl],
      ['Samples', r.sampleCount != null ? String(r.sampleCount) : '—'],
      ['Start', r.startTs ? formatTimeWithTz(new Date(r.startTs).toISOString()) : '—'],
      ['End', r.endTs ? formatTimeWithTz(new Date(r.endTs).toISOString()) : '—']
    ];
    if (r.daysAnalysed != null && r.daysAnalysed > 0) {
      rows.push(['Days', String(r.daysAnalysed)]);
    }
    if (r.closeReasonCounts) {
      var c = r.closeReasonCounts;
      var closes = [];
      if (c.tp > 0) closes.push(c.tp + ' TP');
      if (c.sl > 0) closes.push(c.sl + ' SL');
      if (c.dsl > 0) closes.push(c.dsl + ' dyn. SL');
      if (c.rules > 0) closes.push(c.rules + ' rules');
      if (c.endOfPeriod > 0) closes.push(c.endOfPeriod + ' end-of-period');
      if (closes.length > 0) rows.push(['Closes', closes.join(', ')]);
    }
    if (r.nonConsecutiveWarning) {
      rows.push(['Note', r.nonConsecutiveWarning]);
    }
    if (r.dynamicStopLossNote) {
      rows.push(['Dynamic SL', r.dynamicStopLossNote]);
    } else if (usedDynamicSl || r.dynamicStopLossApplied) {
      rows.push(['Dynamic SL', 'Applied in simulation (trailing stop)']);
    }
    if (usedTpSl) rows.unshift(['TP/SL', 'Applied from deal settings']);
    reportBody.innerHTML = rows.map(function (row) {
      return '<dt class="text-slate-500">' + row[0] + '</dt><dd class="font-mono">' + row[1] + '</dd>';
    }).join('');

    var tradeListSection = document.getElementById('testRulesTradeListSection');
    var tradeListEl = document.getElementById('testRulesTradeList');
    var tradeListCountEl = document.getElementById('testRulesTradeListCount');
    var tradeListHintEl = document.getElementById('testRulesTradeListHint');
    if (tradeListSection && tradeListEl) {
      var rowCount = 0;
      try {
        rowCount = renderBacktestTradeList(r, sampleQuality, tradeListEl, tradeListCountEl);
      } catch (renderErr) {
        console.error('Simulated trades list render failed', renderErr);
        tradeListEl.innerHTML =
          '<li class="text-amber-400/90 px-1 py-0.5">Could not render trade list — hard-refresh the page.</li>';
        rowCount = 1;
      }
      var tradeCount = Array.isArray(r.trades) ? r.trades.length : 0;
      var summaryTrades = r.tradeCount != null ? r.tradeCount : 0;
      var showList =
        rowCount > 0 ||
        tradeCount > 0 ||
        summaryTrades > 0 ||
        lastAnalysedDays.length > 0;
      if (showList) {
        if (tradeListHintEl && (tradeCount > 0 || lastAnalysedDays.length > 0)) {
          tradeListHintEl.classList.remove('hidden');
        } else if (tradeListHintEl) {
          tradeListHintEl.classList.add('hidden');
        }
        tradeListSection.classList.remove('hidden');
        var listMsg =
          'Simulated trades list: ' +
          rowCount +
          ' row(s), ' +
          tradeCount +
          ' trade(s) in payload' +
          (lastAnalysedDays.length > 0 ? ', ' + lastAnalysedDays.length + ' day(s)' : '');
        appendLog(listMsg);
        if (typeof log === 'function') log(listMsg);
      } else {
        if (tradeListCountEl) tradeListCountEl.textContent = '';
        if (tradeListHintEl) tradeListHintEl.classList.add('hidden');
        tradeListEl.innerHTML = '';
        tradeListSection.classList.add('hidden');
      }
    } else {
      var missingUiMsg = 'UI: Simulated trades list missing from page — hard refresh (Ctrl+Shift+R)';
      appendLog(missingUiMsg);
      if (typeof log === 'function') log(missingUiMsg);
    }

    var qualitySection = document.getElementById('testRulesQualitySection');
    var qualitySummary = document.getElementById('testRulesQualitySummary');
    var qualityDays = document.getElementById('testRulesQualityDays');
    if (qualitySection && qualitySummary) {
      if (sampleQuality && (sampleQuality.summaryWarnings || sampleQuality.days)) {
        var q = sampleQuality;
        var summaryLines = q.summaryWarnings || [];
        qualitySummary.innerHTML = summaryLines
          .map(function (line) {
            var cls = q.hasWarnings && line.indexOf('No major') !== 0 ? 'text-amber-200/90' : 'text-slate-400';
            return '<li class="' + cls + '">' + escapeHtml(line) + '</li>';
          })
          .join('');
        if (qualityDays && q.days && q.days.length > 0) {
          var dayLines = q.days.filter(function (d) { return d.warnings && d.warnings.length > 0; });
          if (dayLines.length > 0) {
            qualityDays.innerHTML = dayLines
              .map(function (d) {
                return (
                  '<li><span class="text-slate-500">' +
                  escapeHtml(d.day) +
                  '</span> (' +
                  d.count.toLocaleString() +
                  '): ' +
                  escapeHtml(d.warnings.join('; ')) +
                  '</li>'
                );
              })
              .join('');
            qualityDays.classList.remove('hidden');
          } else {
            qualityDays.innerHTML = '';
            qualityDays.classList.add('hidden');
          }
        }
        qualitySection.classList.remove('hidden');
      } else {
        qualitySummary.innerHTML = '';
        if (qualityDays) {
          qualityDays.innerHTML = '';
          qualityDays.classList.add('hidden');
        }
        qualitySection.classList.add('hidden');
      }
    }

    var blockerSection = document.getElementById('testRulesBlockerSection');
    var blockerList = document.getElementById('testRulesBlockerList');
    if (blockerSection && blockerList) {
      if (r.ruleBlockerCounts && r.ruleBlockerCounts.length > 0) {
        var opSymbols = { lte: '\u2264', gte: '\u2265', lt: '<', gt: '>', eq: '=' };
        blockerList.innerHTML = r.ruleBlockerCounts.map(function (b) {
          var op = opSymbols[b.op] || b.op;
          var dir = b.direction ? '<span class="text-slate-500">' + b.direction + '</span> ' : '';
          return '<li class="font-mono text-[11px]">' + dir + b.left + ' ' + op + ' ' + b.right + ': <span class="text-amber-400">' + b.soleBlockerCount + '</span></li>';
        }).join('');
        blockerSection.classList.remove('hidden');
      } else {
        blockerSection.classList.add('hidden');
      }
    }
    reportEl.classList.remove('hidden');
    if (scrollIntoView) {
      setTimeout(function () {
        reportEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (tradeListSection && !tradeListSection.classList.contains('hidden')) {
          tradeListSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 100);
    }
  }

  function showError(msg) {
    if (!reportBody || !reportEl) return;
    reportBody.innerHTML = '<dt class="text-slate-500">Error</dt><dd class="text-amber-400">' + (msg || 'Unknown error') + '</dd>';
    lastTrades = [];
    lastAnalysedDays = [];
    var tradeListSection = document.getElementById('testRulesTradeListSection');
    if (tradeListSection) tradeListSection.classList.add('hidden');
    reportEl.classList.remove('hidden');
  }

  function showAnalyseProgress(daysCount) {
    if (analyseProgressModal) analyseProgressModal.classList.remove('hidden');
    if (analyseProgressText) analyseProgressText.textContent = daysCount != null ? 'Processing ' + daysCount + ' day(s)…' : 'Processing…';
  }

  function hideAnalyseProgress() {
    if (analyseProgressModal) analyseProgressModal.classList.add('hidden');
  }

  socket.on('analyse_recording_progress', function (data) {
    if (data && typeof data.processed === 'number' && typeof data.total === 'number' && analyseProgressText) {
      analyseProgressText.textContent = data.processed === 0
        ? 'Starting… (0 of ' + data.total + ' days)'
        : 'Day ' + data.processed + ' of ' + data.total + '…';
    }
  });

  socket.on('analyse_recording_report', function (data) {
    hideAnalyseProgress();
    if (data && data.error) {
      showError(data.error);
      appendLog('Analysis: ' + data.error);
    } else if (data && data.report) {
      var report = mergeAnalyseReportPayload(data);
      if (!report) return;
      lastBacktestReport = report;
      lastAnalyseDayKeys = Array.isArray(data.analysedDayKeys) ? data.analysedDayKeys.slice() : [];
      if (lastAnalyseDayKeys.length === 0 && lastAnalyseSelectedDays.length > 0) {
        lastAnalyseDayKeys = lastAnalyseSelectedDays.slice();
      }
      showReport(report, !!data.usedTpSl, !!data.usedDynamicSl, data.sampleQuality, true);
      var tc = Array.isArray(report.trades) ? report.trades.length : 0;
      appendLog('Analysis complete: ' + (report.tradeCount != null ? report.tradeCount : tc) + ' trades, P/L ' + (report.totalGainLoss != null ? report.totalGainLoss.toFixed(2) : '—') + ' (payload trades: ' + tc + ')');
      if (data.sampleQuality && data.sampleQuality.hasWarnings && data.sampleQuality.summaryWarnings) {
        for (var qi = 0; qi < data.sampleQuality.summaryWarnings.length; qi++) {
          appendLog('Recording: ' + data.sampleQuality.summaryWarnings[qi]);
        }
      }
      if (data.usedDynamicSl || (data.report && data.report.dynamicStopLossApplied)) {
        var dslLog = data.report && data.report.dynamicStopLossNote
          ? 'Dynamic stop loss applied in simulation: ' + data.report.dynamicStopLossNote
          : 'Dynamic stop loss applied in simulation (trailing stop; may differ from live IG).';
        appendLog(dslLog);
      }
      var simNote = 'Test rules: those trades are simulated from recorded prices — no orders sent to IG.';
      appendLog(simNote);
      if (typeof log === 'function') log(simNote);
      if (data.dealingScheduleSource === 'default' && !state.is24_7Market) {
        appendLog('Note: IG did not return usable marketTimes — using default UK Mon–Fri 08:00–21:59 (Europe/London). Log in for exact IG hours per epic.');
      }
      var epic = (epicSelect && epicSelect.value) || state.savedEpic || '';
      profilesApi.updateLoadedProfileResult(epic, report).then(function () {
        if (!profilesApi.getLoadedProfileId()) profilesApi.promptSaveAfterAnalyse(report);
      });
    }
  });

  if (analyseProgressStop) {
    analyseProgressStop.addEventListener('click', function () {
      socket.emit('analyse_cancel');
    });
  }

  var loadDaysBtn = document.getElementById('testRulesLoadDays');
  var selectAllDaysBtn = document.getElementById('testRulesSelectAllDays');
  var clearDaysBtn = document.getElementById('testRulesClearDays');
  var deleteSelectedDaysBtn = document.getElementById('testRulesDeleteSelectedDays');
  var pruneBtn = document.getElementById('testRulesPruneBtn');
  var pruneMinCountEl = document.getElementById('testRulesPruneMinCount');
  var daysListEl = document.getElementById('testRulesDaysList');

  function getEpicDisplayName(epic) {
    if (!epicSelect || !epic) return epic || '';
    for (var i = 0; i < epicSelect.options.length; i++) {
      if (epicSelect.options[i].value === epic) return (epicSelect.options[i].textContent || '').trim() || epic;
    }
    return epic;
  }

  function renderDaysList(dayStats) {
    if (!daysListEl) return;
    daysListEl.innerHTML = '';
    var dayStatsArr = Array.isArray(dayStats) ? dayStats : [];
    var byEpic = {};
    for (var i = 0; i < dayStatsArr.length; i++) {
      var s = dayStatsArr[i];
      var epic = (s && s.epic) || '__unknown__';
      if (!byEpic[epic]) byEpic[epic] = [];
      byEpic[epic].push(s);
    }
    var epics = Object.keys(byEpic).sort();
    for (var e = 0; e < epics.length; e++) {
      var epic = epics[e];
      var items = byEpic[epic];
      var displayEpic = epic !== '__unknown__' ? getEpicDisplayName(epic) : epic;
      var section = document.createElement('div');
      section.className = 'flex flex-col gap-0.5';
      var epicLine = document.createElement('div');
      epicLine.className = 'text-slate-500 font-medium text-[11px] mt-1 first:mt-0';
      epicLine.textContent = displayEpic || epic;
      section.appendChild(epicLine);
      var daysRow = document.createElement('div');
      daysRow.className = 'flex flex-wrap gap-1.5';
      for (var j = 0; j < items.length; j++) {
        var s = items[j];
        var day = (s && s.day) || '';
        var count = s && typeof s.count === 'number' ? s.count : null;
        var value = epic !== '__unknown__' ? day + '|' + epic : day;
        var label = document.createElement('label');
        label.className = 'flex items-center gap-1 cursor-pointer text-slate-400 hover:text-slate-300';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = value;
        cb.className = 'rounded bg-slate-800 border-slate-600 text-emerald-500';
        label.appendChild(cb);
        var countStr = typeof count === 'number' && count >= 0 ? ' (' + count.toLocaleString() + ')' : '';
        if (typeof count === 'number' && count >= 0 && count < 3600) {
          label.className = 'flex items-center gap-1 cursor-pointer text-amber-400/90 hover:text-amber-300';
          label.title = 'Sparse day (< 3,600 samples). Analyse will show recording quality warnings.';
        }
        label.appendChild(document.createTextNode(day + countStr));
        var chartBtn = document.createElement('button');
        chartBtn.type = 'button';
        chartBtn.className =
          'ml-0.5 px-1.5 py-0.5 rounded text-[10px] bg-slate-700 hover:bg-sky-800/80 text-sky-300 border border-slate-600/80';
        chartBtn.textContent = 'Chart';
        chartBtn.title = 'View recorded price for this day (no analyse required)';
        (function (btnDay, btnCount, btnEpic) {
          chartBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var chartEpic =
              btnEpic !== '__unknown__' ? btnEpic : (epicSelect && epicSelect.value) || state.savedEpic || '';
            if (!chartEpic) {
              appendLog('Select an instrument before opening day chart');
              return;
            }
            openDayChartModal(chartEpic, btnDay, btnCount);
          });
        })(day, count, epic);
        label.appendChild(chartBtn);
        daysRow.appendChild(label);
      }
      section.appendChild(daysRow);
      daysListEl.appendChild(section);
    }
    var hasDays = dayStatsArr.length > 0;
    if (selectAllDaysBtn) selectAllDaysBtn.classList.toggle('hidden', !hasDays);
    if (clearDaysBtn) clearDaysBtn.classList.toggle('hidden', !hasDays);
    if (deleteSelectedDaysBtn) deleteSelectedDaysBtn.classList.toggle('hidden', !hasDays);
  }

  socket.on('recorded_days', function (data) {
    if (data && (data.dayStats || data.days)) {
      var stats = data.dayStats || (data.days || []).map(function (d) { return { day: d }; });
      renderDaysList(stats);
      var msg = stats.length > 0
        ? 'Loaded ' + stats.length + ' day(s) across ' + (data.dayStats ? new Set(data.dayStats.map(function (s) { return s.epic; }).filter(Boolean)).size : 1) + ' instrument(s)'
        : 'No recorded days (Record with streaming first)';
      appendLog(msg);
      if (stats.length === 0 && data.epicsWithData && data.epicsWithData.length > 0) {
        appendLog('Data exists for: ' + data.epicsWithData.join(', ') + ' – select that instrument');
      }
    } else {
      renderDaysList([]);
      appendLog('No recorded days');
    }
  });

  if (loadDaysBtn) {
    loadDaysBtn.addEventListener('click', function () {
      appendLog('Loading days…');
      socket.emit('get_recorded_days', '');
    });
  }
  if (selectAllDaysBtn) {
    selectAllDaysBtn.addEventListener('click', function () {
      var cbs = daysListEl ? daysListEl.querySelectorAll('input[type="checkbox"]') : [];
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
    });
  }
  if (clearDaysBtn) {
    clearDaysBtn.addEventListener('click', function () {
      var cbs = daysListEl ? daysListEl.querySelectorAll('input[type="checkbox"]') : [];
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
    });
  }

  if (deleteSelectedDaysBtn) {
    deleteSelectedDaysBtn.addEventListener('click', function () {
      var selected = [];
      var cbs = daysListEl ? daysListEl.querySelectorAll('input[type="checkbox"]:checked') : [];
      for (var i = 0; i < cbs.length; i++) {
        var v = cbs[i].value;
        if (v) selected.push(v);
      }
      if (selected.length === 0) {
        appendLog('Select at least one day to delete');
        return;
      }
      appendLog('Deleting ' + selected.length + ' day(s)…');
      socket.emit('delete_recorded_days', { items: selected });
    });
  }

  if (pruneBtn) {
    pruneBtn.addEventListener('click', function () {
      var epic = (epicSelect && epicSelect.value) || state.savedEpic || '';
      if (!epic) {
        appendLog('Select an instrument first');
        return;
      }
      var minCount = pruneMinCountEl ? parseInt(pruneMinCountEl.value, 10) : 3600;
      if (isNaN(minCount) || minCount < 0) minCount = 3600;
      appendLog('Pruning days with fewer than ' + minCount.toLocaleString() + ' samples…');
      socket.emit('prune_sparse_days', { epic: epic, minCount: minCount });
    });
  }

  socket.on('delete_recorded_days_result', function (data) {
    if (data && data.error) {
      appendLog('Delete failed: ' + data.error);
    } else if (data) {
      appendLog('Deleted ' + (data.deleted || 0).toLocaleString() + ' samples from ' + (data.daysRemoved || []).length + ' day(s)');
      if (data.recordedCount != null) updateRecordedCount(data.recordedCount);
      socket.emit('get_recorded_days', '');
    }
  });

  socket.on('prune_sparse_days_result', function (data) {
    if (data && data.error) {
      appendLog('Prune failed: ' + data.error);
    } else if (data) {
      appendLog('Pruned ' + (data.deleted || 0).toLocaleString() + ' samples from ' + (data.daysRemoved || []).length + ' sparse day(s)');
      if (data.recordedCount != null) updateRecordedCount(data.recordedCount);
      socket.emit('get_recorded_days', '');
    }
  });

  if (button2) {
    button2.addEventListener('click', function () {
      var epic = (epicSelect && epicSelect.value) || state.savedEpic || '';
      if (!epic) {
        appendLog('Select an instrument first');
        showError('Select an instrument first');
        return;
      }
      var cfg = getRulesForBacktest();
      var hasRules = cfg.ruleSets && cfg.ruleSets.some(function (rs) { return rs.rules && rs.rules.length > 0; });
      if (!hasRules) {
        appendLog('Add at least one rule (BUY or SELL)');
        showError('Add at least one rule (BUY or SELL)');
        return;
      }
      if (!cfg.backtestRuleSets || cfg.backtestRuleSets.length === 0) {
        appendLog('Select at least one rule set (BUY or SELL) to analyse');
        showError('Select at least one rule set');
        return;
      }
      var firstSet = cfg.ruleSets && cfg.ruleSets[0];
      var takeProfit = firstSet && firstSet.takeProfit ? firstSet.takeProfit : null;
      var stopLoss = firstSet && firstSet.stopLoss ? firstSet.stopLoss : null;
      var tpSlMode = firstSet && firstSet.tpSlMode ? firstSet.tpSlMode : 'rate';
      var dealSize = firstSet && firstSet.dealSize ? firstSet.dealSize : '1';
      var contractSize = (state.currentContractSize != null && state.currentContractSize > 0) ? state.currentContractSize : 1;

      var modeRadio = document.querySelector('input[name="testRulesAnalysisMode"]:checked');
      var intradayOnly = !modeRadio || modeRadio.value === 'intraday';

      var fromDateEl = document.getElementById('testRulesFromDate');
      var toDateEl = document.getElementById('testRulesToDate');
      var fromDate = fromDateEl && fromDateEl.value ? fromDateEl.value : null;
      var toDate = toDateEl && toDateEl.value ? toDateEl.value : null;
      var selectedDays = [];
      var dayCheckboxes = document.querySelectorAll('#testRulesDaysList input[type="checkbox"]:checked');
      for (var i = 0; i < dayCheckboxes.length; i++) {
        var val = dayCheckboxes[i].value;
        if (!val) continue;
        var pipeIdx = val.indexOf('|');
        var day = pipeIdx >= 0 ? val.slice(0, pipeIdx) : val;
        var itemEpic = pipeIdx >= 0 ? val.slice(pipeIdx + 1) : '';
        if (itemEpic && itemEpic !== epic) continue;
        selectedDays.push(day);
      }

      if (dayCheckboxes.length > 0 && selectedDays.length === 0) {
        appendLog('Select days for the current instrument (' + epic + ') to analyse');
        showError('Select days for the current instrument');
        return;
      }

      var rangeMsg = selectedDays.length > 0 ? ' ' + selectedDays.length + ' day(s)' : ((fromDate && toDate) ? ' ' + fromDate + ' to ' + toDate : (fromDate ? ' from ' + fromDate : toDate ? ' to ' + toDate : ''));
      appendLog('Analysing recording' + rangeMsg + ' (' + (intradayOnly ? 'intraday' : 'carry over') + ')…');
      var daysCount = selectedDays.length > 0 ? selectedDays.length : null;
      showAnalyseProgress(daysCount);
      lastAnalyseEpic = epic;
      lastAnalyseSelectedDays = selectedDays.slice().sort();
      socket.emit('analyse_recording', {
        epic: epic,
        intradayOnly: intradayOnly,
        fromDate: selectedDays.length === 0 ? fromDate : null,
        toDate: selectedDays.length === 0 ? toDate : null,
        selectedDays: selectedDays.length > 0 ? selectedDays : null,
        ruleSets: cfg.ruleSets,
        backtestRuleSets: cfg.backtestRuleSets,
        probeShortMinutes: cfg.probeShortMinutes,
        probeMediumMinutes: cfg.probeMediumMinutes,
        probeLongMinutes: cfg.probeLongMinutes,
        is24_7: !!state.is24_7Market,
        takeProfit: takeProfit,
        stopLoss: stopLoss,
        tpSlMode: tpSlMode,
        dealSize: dealSize,
        contractSize: contractSize,
        dynamicSlBuy: cfg.dynamicSlBuy,
        dynamicSlSell: cfg.dynamicSlSell,
        stopAfterLossBuy: cfg.engineControls && cfg.engineControls.stopAfterLossBuy,
        stopAfterLossSell: cfg.engineControls && cfg.engineControls.stopAfterLossSell,
        pauseOnLossSecondsBuy: cfg.engineControls && cfg.engineControls.pauseOnLossSecondsBuy,
        pauseOnLossSecondsSell: cfg.engineControls && cfg.engineControls.pauseOnLossSecondsSell,
        scheduleStartTime: cfg.engineControls && cfg.engineControls.scheduleStartTime,
        scheduleStopTime: cfg.engineControls && cfg.engineControls.scheduleStopTime,
        scheduleRepeatDaily: cfg.engineControls && cfg.engineControls.scheduleRepeatDaily,
        scheduleActiveDate: cfg.engineControls && cfg.engineControls.scheduleActiveDate,
        scheduleTimezone: cfg.engineControls && cfg.engineControls.scheduleTimezone
      });
    });
  }

  if (logBody) logBody.innerHTML = '';

  return {
    setTestRulesPanelEnabled: function (enabled) {
      var panel = document.getElementById('testRulesPanel');
      if (panel) panel.classList.toggle('hidden', !enabled);
    },
    refreshProfilesForEpic: function (epic) {
      if (profilesApi && profilesApi.refreshForEpic) profilesApi.refreshForEpic(epic);
    }
  };
}
