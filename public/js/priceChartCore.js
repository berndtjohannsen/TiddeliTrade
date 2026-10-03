/**
 * Shared price chart drawing (Research modal + Trade Overview live stream).
 * Matches layout/colors of the Research day/trade charts in testRules.js.
 */

var CHART_GAP_MS = 5000;

export function prepareChartCanvas(canvas, w, h, fillBg) {
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

function medianNum(nums) {
  if (!nums || nums.length === 0) return 0;
  var sorted = nums.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

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

export function chartGapBreakMs(samples) {
  return Math.max(CHART_GAP_MS, medianSampleDeltaMs(samples) * 3);
}

export function normalizeChartSamples(samples) {
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

function minMaxMids(mids) {
  var min = mids[0];
  var max = mids[0];
  for (var i = 1; i < mids.length; i++) {
    if (mids[i] < min) min = mids[i];
    if (mids[i] > max) max = mids[i];
  }
  return { min: min, max: max };
}

export function computeProbeSeries(samples, probeMs) {
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

function formatProbeWindowLabel(prefix, minutes) {
  if (minutes >= 1440 && minutes % 1440 === 0) return prefix + minutes / 1440 + 'd';
  if (minutes >= 60 && minutes % 60 === 0) return prefix + minutes / 60 + 'h';
  return prefix + minutes + 'm';
}

/** Downsample for canvas performance while keeping last point. */
export function thinSamplesForChart(samples, maxPoints) {
  if (!samples || samples.length <= maxPoints) return samples ? samples.slice() : [];
  var stride = Math.ceil(samples.length / maxPoints);
  var out = [];
  for (var i = 0; i < samples.length; i += stride) out.push(samples[i]);
  var last = samples[samples.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function nearestSampleIndex(samples, ts) {
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
    if (d0 < d1) return lo - 1;
  }
  return lo;
}

/**
 * Live Trade Overview chart — same visual language as Research price charts.
 * @param {HTMLCanvasElement} canvas
 * @param {{ width: number, height: number, samples: object[], probeMs: object, refTs: number, probeStats?: object, statusText?: string }} opts
 * @returns {{ layout: object|null, probeSeries: object|null, samples: object[] }}
 */
export function drawLiveProbeChart(canvas, opts) {
  var w = opts.width;
  var h = opts.height;
  var refTs = opts.refTs != null ? opts.refTs : Date.now();
  var probeMs = opts.probeMs;
  var samples = normalizeChartSamples(thinSamplesForChart(opts.samples || [], 4000));
  var emptyMsg = opts.statusText || 'Waiting for live prices…';

  var padL = 58;
  var padR = 14;
  var padT = 22;
  var padB = 44;

  if (w < padL + padR + 24 || h < padT + padB + 24) {
    return { layout: null, probeSeries: null, samples: samples };
  }

  if (samples.length < 2) {
    var emptyCtx = prepareChartCanvas(canvas, w, h, true);
    if (emptyCtx) {
      emptyCtx.fillStyle = '#94a3b8';
      emptyCtx.font = '13px system-ui,sans-serif';
      emptyCtx.fillText(samples.length === 1 ? 'Collecting more samples…' : emptyMsg, 16, 36);
    }
    return { layout: null, probeSeries: null, samples: samples };
  }

  var ctx = prepareChartCanvas(canvas, w, h, true);
  if (!ctx) return { layout: null, probeSeries: null, samples: samples };

  var plotW = w - padL - padR;
  var plotH = h - padT - padB;
  var sampleT0 = samples[0].ts;
  var sampleT1 = samples[samples.length - 1].ts;
  var t0 = Math.min(sampleT0, refTs - (probeMs && probeMs.long ? probeMs.long : 0));
  var t1 = Math.max(sampleT1, refTs);
  if (t1 - t0 < 60000) {
    t0 = refTs - 60000;
    t1 = refTs + 5000;
  }
  var tSpan = t1 - t0 || 1;

  var mids = [];
  for (var si = 0; si < samples.length; si++) mids.push(samples[si].mid);
  var mm = minMaxMids(mids);
  var stats = opts.probeStats || {};
  var yCandidates = [mm.min, mm.max];
  ['short', 'medium', 'long'].forEach(function (key) {
    var st = stats[key];
    if (st && st.count > 0) {
      if (st.min != null) yCandidates.push(st.min);
      if (st.max != null) yCandidates.push(st.max);
      if (st.avg != null) yCandidates.push(st.avg);
    }
  });
  var yMin = Math.min.apply(null, yCandidates);
  var yMax = Math.max.apply(null, yCandidates);
  var yPad = (yMax - yMin) * 0.08 || 0.01;
  yMin -= yPad;
  yMax += yPad;
  var ySpan = yMax - yMin || 1;

  var layout = {
    padL: padL, padR: padR, padT: padT, padB: padB, plotW: plotW, plotH: plotH,
    t0: t0, t1: t1, tSpan: tSpan, yMin: yMin, yMax: yMax, w: w, h: h
  };

  function xAt(ts) {
    return padL + ((ts - t0) / tSpan) * plotW;
  }
  function yAt(price) {
    return padT + ((yMax - price) / ySpan) * plotH;
  }

  var probeSeries = probeMs ? computeProbeSeries(samples, probeMs) : null;

  function drawTimeBand(fromTs, toTs, fillStyle) {
    var x1 = xAt(Math.max(t0, fromTs));
    var x2 = xAt(Math.min(t1, toTs));
    if (x2 - x1 < 1) return;
    ctx.fillStyle = fillStyle;
    ctx.fillRect(x1, padT, x2 - x1, plotH);
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

  // Y grid (Research chart style)
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

  // X time axis
  var timeStep = pickAxisTimeStep(tSpan, Math.max(4, Math.floor(plotW / 72)));
  var tickStart = Math.ceil(t0 / timeStep) * timeStep;
  ctx.strokeStyle = '#334155';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px ui-monospace,monospace';
  ctx.textAlign = 'center';
  for (var tick = tickStart; tick <= t1; tick += timeStep) {
    var tx = xAt(tick);
    ctx.beginPath();
    ctx.moveTo(tx, padT + plotH);
    ctx.lineTo(tx, padT + plotH + 5);
    ctx.stroke();
    ctx.fillText(formatChartAxisTime(tick, t0, t1), tx, h - 8);
  }
  ctx.textAlign = 'left';

  // Probe lookback bands ending at now (long → short, shorter on top)
  if (probeMs) {
    var windows = [
      { startTs: refTs - probeMs.long, stopTs: refTs, fill: 'rgba(244, 114, 182, 0.07)' },
      { startTs: refTs - probeMs.medium, stopTs: refTs, fill: 'rgba(167, 139, 250, 0.09)' },
      { startTs: refTs - probeMs.short, stopTs: refTs, fill: 'rgba(34, 211, 238, 0.11)' }
    ];
    for (var bi = 0; bi < windows.length; bi++) {
      var band = windows[bi];
      drawTimeBand(band.startTs, band.stopTs, band.fill);
    }
  }

  // Rolling probe averages (same colors as Research overlay toggles)
  if (probeSeries) {
    drawCurve(probeSeries.long, '#f472b6');
    drawCurve(probeSeries.medium, '#a78bfa');
    drawCurve(probeSeries.short, '#22d3ee');
  }

  // Recorded mid price line
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

  // "Now" vertical
  if (refTs >= t0 && refTs <= t1) {
    var nx = xAt(refTs);
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(nx, padT);
    ctx.lineTo(nx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#facc15';
    ctx.font = '10px system-ui,sans-serif';
    ctx.fillText('Now', Math.min(nx + 4, w - padR - 28), padT + 12);
  }

  // Probe window start verticals at now
  if (probeMs) {
    var winLines = [
      { ts: refTs - probeMs.long, color: '#f472b6', label: formatProbeWindowLabel('L', probeMs.longMin) },
      { ts: refTs - probeMs.medium, color: '#a78bfa', label: formatProbeWindowLabel('M', probeMs.mediumMin) },
      { ts: refTs - probeMs.short, color: '#22d3ee', label: formatProbeWindowLabel('S', probeMs.shortMin) }
    ];
    for (var wi = 0; wi < winLines.length; wi++) {
      var wl = winLines[wi];
      if (wl.ts < t0 || wl.ts > t1) continue;
      var lx = xAt(wl.ts);
      ctx.strokeStyle = wl.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(lx, padT);
      ctx.lineTo(lx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = wl.color;
      ctx.font = '10px system-ui,sans-serif';
      ctx.fillText(wl.label + ' start', Math.min(lx + 3, w - padR - 52), padT + 24 + wi * 11);
    }
  }

  return { layout: layout, probeSeries: probeSeries, samples: samples };
}

/** Crosshair on overlay canvas (Research chart hover). */
export function drawChartCrosshair(overlayCanvas, layout, sample) {
  if (!overlayCanvas || !layout || !sample) return;
  var w = layout.w;
  var h = layout.h;
  var ctx = prepareChartCanvas(overlayCanvas, w, h, false);
  if (!ctx) return;
  var padL = layout.padL;
  var padT = layout.padT;
  var plotW = layout.plotW;
  var plotH = layout.plotH;
  var yMax = layout.yMax;
  var ySpan = layout.yMax - layout.yMin || 1;
  var hx = padL + ((sample.ts - layout.t0) / layout.tSpan) * plotW;
  var hy = padT + ((yMax - sample.mid) / ySpan) * plotH;
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
