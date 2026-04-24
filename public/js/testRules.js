/**
 * Test rules panel – recording, recorded log, and backtest analysis.
 */
import { formatTimeWithTz } from './utils.js';
import { getRulesForBacktest } from './tradingRules.js';

export function initTestRules(socket, state, log) {
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
  var tradeChartModalClose = document.getElementById('tradeChartModalClose');
  var tradeChartModalTitle = document.getElementById('tradeChartModalTitle');
  var tradeChartModalMeta = document.getElementById('tradeChartModalMeta');
  var tradeChartCanvas = document.getElementById('tradeChartCanvas');
  var tradeChartCanvasWrap = document.getElementById('tradeChartCanvasWrap');
  var tradeChartModalHint = document.getElementById('tradeChartModalHint');
  var tradeChartModalPanel = document.getElementById('tradeChartModalPanel');
  var tradeChartModalRules = document.getElementById('tradeChartModalRules');
  var testRulesTradeList = document.getElementById('testRulesTradeList');
  var lastTrades = [];
  var lastTradePlMult = 1;
  var lastTradeUsePounds = false;
  var lastAnalyseEpic = '';
  var lastChartReqSeq = 0;
  var chartResizeObserver = null;

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
    if (er === 'rules') return 'Rules';
    if (er === 'endOfPeriod') return 'EOD';
    return er || '—';
  }

  function drawTradeChartCanvas(samples, trade) {
    var canvas = tradeChartCanvas;
    var wrapEl = tradeChartCanvasWrap;
    if (!canvas || !wrapEl || !trade) return;
    var ctx = canvas.getContext('2d');
    var w = wrapEl.clientWidth;
    var h = wrapEl.clientHeight;
    if (w < 10 || h < 10) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    if (!samples || samples.length < 2) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px system-ui,sans-serif';
      ctx.fillText('No recorded samples in this time range.', 16, 36);
      return;
    }
    var padL = 54;
    var padR = 14;
    var padT = 22;
    var padB = 36;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;
    var t0 = samples[0].ts;
    var t1 = samples[samples.length - 1].ts;
    var tSpan = t1 - t0 || 1;
    var mids = [];
    for (var si = 0; si < samples.length; si++) mids.push(samples[si].mid);
    var yMin = Math.min.apply(null, mids);
    var yMax = Math.max.apply(null, mids);
    var yPad = (yMax - yMin) * 0.08 || 0.01;
    yMin -= yPad;
    yMax += yPad;
    var ySpan = yMax - yMin || 1;
    function xAt(ts) {
      return padL + ((ts - t0) / tSpan) * plotW;
    }
    function yAt(price) {
      return padT + ((yMax - price) / ySpan) * plotH;
    }
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var yy = padT + (gi / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(padL + plotW, yy);
      ctx.stroke();
    }
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var j = 0; j < samples.length; j++) {
      var sx = xAt(samples[j].ts);
      var sy = yAt(samples[j].mid);
      if (j === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
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
      ctx.font = '11px system-ui,sans-serif';
      ctx.fillText(label, Math.min(x + 3, w - padR - 48), padT + 14);
    }
    drawMarker(trade.entryTs, '#34d399', 'Open');
    drawMarker(trade.exitTs, '#fbbf24', 'Close');
    ctx.fillStyle = '#64748b';
    ctx.font = '10px ui-monospace,monospace';
    ctx.textAlign = 'left';
    ctx.fillText(yMax.toFixed(2), 4, padT + 10);
    ctx.fillText(yMin.toFixed(2), 4, padT + plotH);
    ctx.textAlign = 'center';
    ctx.fillText(new Date(t0).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), padL + plotW * 0.25, h - 10);
    ctx.fillText(new Date(t1).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), padL + plotW * 0.75, h - 10);
  }

  function closeTradeChartModal() {
    if (tradeChartModalRules) {
      tradeChartModalRules.innerHTML = '';
      tradeChartModalRules.classList.add('hidden');
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

  function openTradeChartModal(trade, index) {
    if (!tradeChartModal || !tradeChartModalMeta) return;
    var epic = lastAnalyseEpic || (epicSelect && epicSelect.value) || state.savedEpic || '';
    if (!epic) {
      appendLog('Select an instrument (epic) before opening trade chart');
      return;
    }
    lastChartReqSeq += 1;
    var reqSeq = lastChartReqSeq;
    tradeChartModal.classList.remove('hidden');
    tradeChartModal.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', tradeChartEscapeHandler);
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
              return (
                '<li><span class="font-mono text-[11px]">' +
                escapeHtml(r.left) +
                ' <span class="text-slate-500">' +
                escapeHtml(r.op) +
                '</span> ' +
                escapeHtml(r.right) +
                '</span></li>'
              );
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
        'Recorded mid price. Range = local calendar day(s) covering the trade, plus 3 h before and after that window (where samples exist).';
    }
    drawTradeChartCanvas([], trade);
    if (chartResizeObserver) chartResizeObserver.disconnect();
    if (tradeChartCanvasWrap && typeof ResizeObserver !== 'undefined') {
      chartResizeObserver = new ResizeObserver(function () {
        var s = tradeChartCanvasWrap._chartSamples;
        var tr = tradeChartCanvasWrap._chartTrade;
        if (tr) drawTradeChartCanvas(Array.isArray(s) ? s : [], tr);
      });
      chartResizeObserver.observe(tradeChartCanvasWrap);
    }
    tradeChartCanvasWrap._chartTrade = trade;
    tradeChartCanvasWrap._chartSamples = null;
    var b = tradeBoundsLocalDays(trade.entryTs, trade.exitTs);
    socket.emit('trade_chart_samples', { epic: epic, fromTs: b.start, toTs: b.end, reqId: reqSeq });
  }

  socket.on('trade_chart_samples_result', function (data) {
    if (!data || data.reqId !== lastChartReqSeq) return;
    if (data.error) {
      if (tradeChartModalMeta) {
        tradeChartModalMeta.innerHTML = '<div class="text-amber-400">' + data.error + '</div>';
      }
      drawTradeChartCanvas([], { entryTs: 0, exitTs: 0 });
      return;
    }
    var samples = data.samples || [];
    var trade = tradeChartCanvasWrap && tradeChartCanvasWrap._chartTrade;
    if (tradeChartModalHint && data.thinned) {
      tradeChartModalHint.textContent =
        'Recorded mid (downsampled for display). Same time range as above. Drag corner to resize.';
    }
    if (tradeChartCanvasWrap) tradeChartCanvasWrap._chartSamples = samples;
    if (trade) drawTradeChartCanvas(samples, trade);
  });

  if (tradeChartModalClose) tradeChartModalClose.addEventListener('click', closeTradeChartModal);
  if (tradeChartModal) {
    tradeChartModal.addEventListener('click', function (e) {
      if (e.target === tradeChartModal) closeTradeChartModal();
    });
  }
  if (tradeChartModalPanel) {
    tradeChartModalPanel.addEventListener('click', function (e) {
      e.stopPropagation();
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
    testRulesTradeList.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var li = e.target && e.target.closest ? e.target.closest('li[data-trade-index]') : null;
      if (!li) return;
      e.preventDefault();
      var ix = parseInt(li.getAttribute('data-trade-index'), 10);
      if (isNaN(ix) || !lastTrades[ix]) return;
      openTradeChartModal(lastTrades[ix], ix);
    });
  }

  function showReport(report, usedTpSl) {
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
      if (c.rules > 0) closes.push(c.rules + ' rules');
      if (c.endOfPeriod > 0) closes.push(c.endOfPeriod + ' end-of-period');
      if (closes.length > 0) rows.push(['Closes', closes.join(', ')]);
    }
    if (r.nonConsecutiveWarning) {
      rows.push(['Note', r.nonConsecutiveWarning]);
    }
    if (usedTpSl) rows.unshift(['TP/SL', 'Applied from deal settings']);
    reportBody.innerHTML = rows.map(function (row) {
      return '<dt class="text-slate-500">' + row[0] + '</dt><dd class="font-mono">' + row[1] + '</dd>';
    }).join('');

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
    var tradeListSection = document.getElementById('testRulesTradeListSection');
    var tradeList = document.getElementById('testRulesTradeList');
    if (tradeListSection && tradeList) {
      if (r.trades && r.trades.length > 0) {
        var usePounds = r.totalGainLossPounds != null && r.totalGainLoss != null && r.totalGainLoss !== 0;
        var mult = usePounds ? r.totalGainLossPounds / r.totalGainLoss : 1;
        lastTrades = r.trades.slice();
        lastTradePlMult = mult;
        lastTradeUsePounds = usePounds;
        tradeList.innerHTML = r.trades.map(function (t, idx) {
          var entryTime = formatTimeWithTz(new Date(t.entryTs).toISOString());
          var closeTime = formatTimeWithTz(new Date(t.exitTs).toISOString());
          var plClass = (t.profitLoss || 0) >= 0 ? 'text-emerald-400' : 'text-red-400';
          var val = usePounds ? (t.profitLoss || 0) * mult : (t.profitLoss || 0);
          var plStr = val >= 0 ? '+' + val.toFixed(2) : val.toFixed(2);
          var unit = usePounds ? ' $' : ' pts';
          var er = t.exitReason || '';
          var tag = er === 'tp' ? 'TP' : er === 'sl' ? 'SL' : er === 'rules' ? 'Rules' : er === 'endOfPeriod' ? 'EOD' : '';
          var tagHtml = tag ? ' <span class="text-slate-500" title="Close reason">' + tag + '</span>' : '';
          return (
            '<li class="cursor-pointer rounded px-1 -mx-1 py-0.5 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-sky-500/50" data-trade-index="' +
            idx +
            '" role="button" tabindex="0" title="Click for price chart">' +
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
        }).join('');
        tradeListSection.classList.remove('hidden');
      } else {
        lastTrades = [];
        tradeListSection.classList.add('hidden');
      }
    }
    reportEl.classList.remove('hidden');
  }

  function showError(msg) {
    if (!reportBody || !reportEl) return;
    reportBody.innerHTML = '<dt class="text-slate-500">Error</dt><dd class="text-amber-400">' + (msg || 'Unknown error') + '</dd>';
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
      showReport(data.report, !!data.usedTpSl);
      appendLog('Analysis complete: ' + data.report.tradeCount + ' trades, P/L ' + data.report.totalGainLoss.toFixed(2));
      var simNote = 'Test rules: those trades are simulated from recorded prices — no orders sent to IG.';
      appendLog(simNote);
      if (typeof log === 'function') log(simNote);
      if (data.dealingScheduleSource === 'default' && !state.is24_7Market) {
        appendLog('Note: IG did not return usable marketTimes — using default UK Mon–Fri 08:00–21:59 (Europe/London). Log in for exact IG hours per epic.');
      }
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
        label.appendChild(document.createTextNode(day + countStr));
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
        contractSize: contractSize
      });
    });
  }

  if (logBody) logBody.innerHTML = '';

  return {
    setTestRulesPanelEnabled: function (enabled) {
      var panel = document.getElementById('testRulesPanel');
      if (panel) panel.classList.toggle('hidden', !enabled);
    }
  };
}
