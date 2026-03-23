/**
 * Trading rules – [left] [op] [right]. Left = live (Buy, Sell, current time). Right = reference (probe stat, day start, or fixed).
 */
import { formatTimeWithTz } from './utils.js';

var RULE_LEFT = [
  { value: 'Buy', label: 'Buy' },
  { value: 'Sell', label: 'Sell' },
  { value: 'currentTime', label: 'current time' },
  { value: 'now.sentiment', label: 'now.sentiment' },
  { value: 'now.trend', label: 'now.trend' },
  { value: 'short.trend', label: 'short.trend' },
  { value: 'medium.trend', label: 'medium.trend' },
  { value: 'long.trend', label: 'long.trend' },
  { value: 'short.trendPct', label: 'short.trendPct' },
  { value: 'medium.trendPct', label: 'medium.trendPct' },
  { value: 'long.trendPct', label: 'long.trendPct' },
  { value: 'short.range', label: 'short.range' },
  { value: 'medium.range', label: 'medium.range' },
  { value: 'long.range', label: 'long.range' },
  { value: 'short.volume', label: 'short.volume' },
  { value: 'medium.volume', label: 'medium.volume' },
  { value: 'long.volume', label: 'long.volume' }
];
var RULE_OPS = [
  { value: 'lte', label: '\u2264' },
  { value: 'gte', label: '\u2265' },
  { value: 'lt', label: '<' },
  { value: 'gt', label: '>' },
  { value: 'eq', label: '=' }
];
var RIGHT_REFERENCES_PRICE = [
  { value: 'short.min', label: 'short.min' },
  { value: 'short.avg', label: 'short.avg' },
  { value: 'short.max', label: 'short.max' },
  { value: 'short.range', label: 'short.range' },
  { value: 'short.trendPct', label: 'short.trendPct' },
  { value: 'short.volume', label: 'short.volume' },
  { value: 'medium.min', label: 'medium.min' },
  { value: 'medium.avg', label: 'medium.avg' },
  { value: 'medium.max', label: 'medium.max' },
  { value: 'medium.range', label: 'medium.range' },
  { value: 'medium.trendPct', label: 'medium.trendPct' },
  { value: 'medium.volume', label: 'medium.volume' },
  { value: 'long.min', label: 'long.min' },
  { value: 'long.avg', label: 'long.avg' },
  { value: 'long.max', label: 'long.max' },
  { value: 'long.range', label: 'long.range' },
  { value: 'long.trendPct', label: 'long.trendPct' },
  { value: 'long.volume', label: 'long.volume' },
  { value: 'dayStart', label: 'day start' },
  { value: '__fixed__', label: 'Fixed...' }
];
var RIGHT_REFERENCES_TREND = [
  { value: 'up', label: 'up' },
  { value: 'down', label: 'down' },
  { value: 'flat', label: 'flat' }
];
var RIGHT_REFERENCES_SENTIMENT = [
  { value: 'Bull', label: 'Bull' },
  { value: 'Bear', label: 'Bear' },
  { value: 'Neutral', label: 'Neutral' },
  { value: 'any', label: 'any' }
];
var RIGHT_REF_KEYS = RIGHT_REFERENCES_PRICE.filter(function (r) { return r.value !== '__fixed__'; }).map(function (r) { return r.value; });

/** Returns rules and probe periods from DOM for backtest. Used by Test rules panel. */
export function getRulesForBacktest() {
  var rulesItems = document.getElementById('tradingRulesItems');
  var rules = [];
  if (rulesItems) {
    var items = rulesItems.querySelectorAll('[data-rule]');
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var enabledEl = el.querySelector('[data-rule-enabled]');
      var leftEl = el.querySelector('[data-left]');
      var opEl = el.querySelector('[data-op]');
      var rightEl = el.querySelector('[data-right]');
      var rightWrap = el.querySelector('[data-right-wrap]');
      var rightFixed = el.querySelector('[data-right-fixed]');
      if (!leftEl || !opEl) continue;
      var right;
      if (rightEl && rightEl.tagName === 'SELECT' && rightEl.value === '__fixed__') {
        right = rightFixed ? rightFixed.value : '';
      } else if (rightEl) {
        right = rightEl.value;
      } else if (rightWrap) {
        var inp = rightWrap.querySelector('input');
        right = inp ? inp.value : '';
      } else {
        continue;
      }
      var enabled = enabledEl ? enabledEl.checked : true;
      rules.push({ left: leftEl.value, op: opEl.value, right: right, enabled: enabled });
    }
  }
  var shortEl = document.getElementById('probeShortPeriod');
  var mediumEl = document.getElementById('probeMediumPeriod');
  var longEl = document.getElementById('probeLongPeriod');
  var short = parseInt(shortEl && shortEl.value, 10);
  var medium = parseInt(mediumEl && mediumEl.value, 10);
  var long = parseInt(longEl && longEl.value, 10);
  return {
    rules: rules,
    probeShortMinutes: isNaN(short) || short < 1 ? 5 : Math.min(short, 1440),
    probeMediumMinutes: isNaN(medium) || medium < 1 ? 60 : Math.min(Math.max(medium, 1), 10080),
    probeLongMinutes: (isNaN(long) || long < 1 ? 24 : Math.min(long, 720)) * 60
  };
}

export function initTradingRules(socket, state, setDealEnabled, setOrderEnabled, setProbesPanelEnabled, setProbesBackfillEnabled, getProbeValues, triggerDealConfirm, placeDealDirect, log) {
  var toggleBtn = document.getElementById('tradingRulesToggle');
  var confirmCheck = document.getElementById('tradingRulesConfirmBeforePlace');
  var rulesList = document.getElementById('tradingRulesList');
  var rulesItems = document.getElementById('tradingRulesItems');
  var addBtn = document.getElementById('tradingRulesAdd');
  var statusEl = document.getElementById('tradingRulesStatus');
  var engineStatusEl = document.getElementById('tradingRulesEngineStatus');
  var rulesLockedMsg = document.getElementById('tradingRulesLockedMsg');
  var dealEngineMsg = document.getElementById('dealEngineActiveMsg');
  var orderEngineMsg = document.getElementById('orderEngineActiveMsg');
  var autoStopCheck = document.getElementById('tradingRulesAutoStop');
  var autoStopMinutesInput = document.getElementById('tradingRulesAutoStopMinutes');
  var pauseOnLossInput = document.getElementById('tradingRulesPauseOnLoss');

  var baseEnabled = false;
  var rulesRunning = false;
  var sleepPreventionStatus = null;
  var prevRulesPass = false;
  var prevBlocked = false;
  var autoStopTimerId = null;
  var pauseOnLossTimerId = null;
  var pausedUntil = null;
  var cachedStopAtMs = null;
  var draggedRuleRow = null;
  var getProbeValuesFn = getProbeValues || function () { return null; };
  var triggerDealConfirmFn = typeof triggerDealConfirm === 'function' ? triggerDealConfirm : function () { return false; };
  var placeDealDirectFn = typeof placeDealDirect === 'function' ? placeDealDirect : function () { return false; };
  var setOrderEnabledFn = typeof setOrderEnabled === 'function' ? setOrderEnabled : function () {};
  var setProbesBackfillEnabledFn = typeof setProbesBackfillEnabled === 'function' ? setProbesBackfillEnabled : function () {};

  function getPauseOnLossSeconds() {
    if (!pauseOnLossInput || !pauseOnLossInput.value.trim()) return 0;
    var n = parseInt(pauseOnLossInput.value, 10);
    return !isNaN(n) && n >= 0 ? Math.min(n, 86400) : 0;
  }

  function getAutoStopBeforeMinutes() {
    if (!autoStopMinutesInput || !autoStopMinutesInput.value.trim()) return 60;
    var n = parseInt(autoStopMinutesInput.value, 10);
    return !isNaN(n) && n >= 0 ? Math.min(n, 1440) : 60;
  }

  function updateAutoStopDisplay() {
    var el = document.getElementById('tradingRulesAutoStopTime');
    if (!el) return;
    var stopAt = getStopAt();
    if (stopAt == null) {
      el.textContent = '—';
      el.title = 'Auto-stop disabled or no market close time';
      return;
    }
    var d = new Date(stopAt);
    var formatted = formatTimeWithTz(d.toISOString());
    el.textContent = 'Stops at ' + formatted;
    el.title = 'Engine will auto-stop at ' + formatted;
  }

  function getStopAt() {
    if (!autoStopCheck || !autoStopCheck.checked) return null;
    var beforeMs = getAutoStopBeforeMinutes() * 60 * 1000;
    var is24_7 = !!state.is24_7Market;
    if (is24_7) {
      var now = new Date();
      var y = now.getUTCFullYear();
      var m = now.getUTCMonth();
      var d = now.getUTCDate();
      var midnight = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0));
      return midnight.getTime() - beforeMs;
    }
    var closeAt = state.defaultCloseAt;
    if (!closeAt) return null;
    var closeMs = new Date(closeAt).getTime();
    if (isNaN(closeMs)) return null;
    return closeMs - beforeMs;
  }

  function checkAutoStop() {
    if (!rulesRunning) return;
    var stopAt = cachedStopAtMs != null ? cachedStopAtMs : getStopAt();
    if (stopAt == null) return;
    if (Date.now() >= stopAt) {
      rulesRunning = false;
      if (autoStopTimerId) {
        clearInterval(autoStopTimerId);
        autoStopTimerId = null;
      }
      updateToggleButton();
      saveRules();
      updateDealEnabled();
      var logFn = typeof log === 'function' ? log : function () {};
      var mins = getAutoStopBeforeMinutes();
      logFn('Rules engine auto-stopped (' + mins + ' min before ' + (state.is24_7Market ? 'midnight' : 'market close') + ')');
    }
  }

  function startAutoStopTimer() {
    if (autoStopTimerId) return;
    updateAutoStopDisplay();
    autoStopTimerId = setInterval(checkAutoStop, 60000);
  }

  function clearAutoStopTimer() {
    if (autoStopTimerId) {
      clearInterval(autoStopTimerId);
      autoStopTimerId = null;
    }
  }

  function getConfig() {
    return {
      running: rulesRunning,
      confirmBeforePlace: confirmCheck ? confirmCheck.checked : true,
      rules: getRulesFromDom(),
      autoStopEnabled: autoStopCheck ? autoStopCheck.checked : true,
      autoStopBeforeMinutes: getAutoStopBeforeMinutes(),
      pauseOnLossSeconds: getPauseOnLossSeconds()
    };
  }

  var pauseCountdownIntervalId = null;

  function doPauseOnLoss(seconds) {
    if (pauseOnLossTimerId) clearTimeout(pauseOnLossTimerId);
    if (pauseCountdownIntervalId) clearInterval(pauseCountdownIntervalId);
    rulesRunning = false;
    pausedUntil = Date.now() + seconds * 1000;
    if (state) state.rulesEngineRunning = false;
    clearAutoStopTimer();
    updateToggleButton();
    saveRules();
    updateDealEnabled();
    var logFn = typeof log === 'function' ? log : function () {};
    logFn('Rules engine paused on loss for ' + seconds + 's');
    pauseCountdownIntervalId = setInterval(function () {
      if (pausedUntil == null || Date.now() >= pausedUntil) {
        if (pauseCountdownIntervalId) clearInterval(pauseCountdownIntervalId);
        pauseCountdownIntervalId = null;
        return;
      }
      updateEngineState();
    }, 1000);
    pauseOnLossTimerId = setTimeout(function () {
      pauseOnLossTimerId = null;
      pausedUntil = null;
      if (pauseCountdownIntervalId) {
        clearInterval(pauseCountdownIntervalId);
        pauseCountdownIntervalId = null;
      }
      rulesRunning = true;
      if (state) state.rulesEngineRunning = true;
      startAutoStopTimer();
      updateToggleButton();
      saveRules();
      updateDealEnabled();
      logFn('Rules engine resumed after pause on loss');
    }, seconds * 1000);
  }

  function hasPositionOrOrder() {
    if (state.dealInProgress) return true;
    var positions = state.currentPositions || [];
    var orders = state.currentWorkingOrders || [];
    return positions.length > 0 || orders.length > 0;
  }

  function getRulesFromDom() {
    if (!rulesItems) return [];
    var items = rulesItems.querySelectorAll('[data-rule]');
    var rules = [];
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var enabledEl = el.querySelector('[data-rule-enabled]');
      var leftEl = el.querySelector('[data-left]');
      var opEl = el.querySelector('[data-op]');
      var rightEl = el.querySelector('[data-right]');
      var rightWrap = el.querySelector('[data-right-wrap]');
      var rightFixed = el.querySelector('[data-right-fixed]');
      if (!leftEl || !opEl) continue;
      var right;
      if (rightEl && rightEl.tagName === 'SELECT' && rightEl.value === '__fixed__') {
        right = rightFixed ? rightFixed.value : '';
      } else if (rightEl) {
        right = rightEl.value;
      } else if (rightWrap) {
        var inp = rightWrap.querySelector('input');
        right = inp ? inp.value : '';
      } else {
        continue;
      }
      var enabled = enabledEl ? enabledEl.checked : true;
      rules.push({ left: leftEl.value, op: opEl.value, right: right, enabled: enabled });
    }
    return rules;
  }

  function getContext() {
    var pv = getProbeValuesFn();
    var probes = pv ? { short: pv.short, medium: pv.medium, long: pv.long } : {};
    var sentiment = null;
    var s = state.clientSentiment;
    if (s && (s.longPct !== 0 || s.shortPct !== 0)) {
      var diff = s.longPct - s.shortPct;
      sentiment = diff > 5 ? 'Bull' : diff < -5 ? 'Bear' : 'Neutral';
    }
    return {
      offer: state.currentOffer,
      bid: state.currentBid,
      dayStart: state.dayStartBuy,
      currentTime: state.currentUpdateTime || '',
      currentTrend: state.currentTrend || null,
      sentiment: sentiment,
      probes: probes
    };
  }

  function getLeftValue(rule, ctx) {
    if (rule.left === 'Buy') return ctx.offer;
    if (rule.left === 'Sell') return ctx.bid;
    if (rule.left === 'currentTime') return ctx.currentTime || '';
    if (rule.left === 'now.sentiment') return ctx.sentiment;
    if (rule.left === 'now.trend') return ctx.currentTrend;
    if (rule.left === 'short.volume' || rule.left === 'medium.volume' || rule.left === 'long.volume') {
      var probe = rule.left.split('.')[0];
      var p = ctx.probes[probe];
      return p ? (p.count ?? 0) : null;
    }
    if (rule.left === 'short.trend' || rule.left === 'medium.trend' || rule.left === 'long.trend') {
      var probeTrend = rule.left.split('.')[0];
      var pt = ctx.probes[probeTrend];
      return pt ? (pt.trendDir ?? null) : null;
    }
    if (rule.left === 'short.trendPct' || rule.left === 'medium.trendPct' || rule.left === 'long.trendPct') {
      var probeTp = rule.left.split('.')[0];
      var ptp = ctx.probes[probeTp];
      return ptp && ptp.trendPct != null ? ptp.trendPct : null;
    }
    if (rule.left === 'short.range' || rule.left === 'medium.range' || rule.left === 'long.range') {
      var probeR = rule.left.split('.')[0];
      var pr = ctx.probes[probeR];
      return pr ? (pr.range ?? null) : null;
    }
    return null;
  }

  function getRightValue(rule, ctx) {
    if (rule.left === 'currentTime') return rule.right;
    if (rule.left === 'now.sentiment') return rule.right;
    if (rule.left === 'now.trend' || rule.left === 'short.trend' || rule.left === 'medium.trend' || rule.left === 'long.trend') return rule.right;
    var r = rule.right;
    if (RIGHT_REF_KEYS.indexOf(r) >= 0) {
      if (r === 'dayStart') return ctx.dayStart;
      var parts = r.split('.');
      var probe = parts[0];
      var stat = parts[1];
      var p = ctx.probes[probe];
      if (!p) return null;
      var key = stat === 'avg' ? 'avg' : stat === 'min' ? 'min' : stat === 'max' ? 'max' : stat === 'volume' ? 'count' : stat === 'range' ? 'range' : stat === 'trendPct' ? 'trendPct' : null;
      return key != null ? p[key] : null;
    }
    var n = parseFloat(r);
    return isNaN(n) ? null : n;
  }

  function evaluateRule(rule, ctx) {
    var leftVal = getLeftValue(rule, ctx);
    var rightVal = getRightValue(rule, ctx);
    if (rule.left === 'currentTime') {
      var lStr = String(leftVal || '').trim();
      var rStr = String(rightVal || '').trim();
      if (!lStr || !rStr) return false;
      var c = lStr.localeCompare(rStr);
      switch (rule.op) {
        case 'lte': return c <= 0;
        case 'gte': return c >= 0;
        case 'lt': return c < 0;
        case 'gt': return c > 0;
        case 'eq': return c === 0;
        default: return false;
      }
    }
    if (rule.left === 'now.sentiment') {
      if (leftVal == null) return true;
      if (rightVal == null) return false;
      var r = String(rightVal);
      if (r === 'any') return true;
      if (['Bull', 'Bear', 'Neutral'].indexOf(r) < 0) return false;
      var l = String(leftVal);
      return rule.op === 'eq' ? l === r : false;
    }
    if (rule.left === 'now.trend' || rule.left === 'short.trend' || rule.left === 'medium.trend' || rule.left === 'long.trend') {
      if (leftVal == null || rightVal == null) return false;
      var l = String(leftVal);
      var r = String(rightVal);
      if (['up', 'down', 'flat'].indexOf(r) < 0) return false;
      var trendOrd = function (x) { return x === 'down' ? 0 : x === 'flat' ? 1 : x === 'up' ? 2 : -1; };
      var leftOrd = trendOrd(l);
      var rightOrd = trendOrd(r);
      if (leftOrd < 0) return false;
      switch (rule.op) {
        case 'eq': return leftOrd === rightOrd;
        case 'lte': return leftOrd <= rightOrd;
        case 'gte': return leftOrd >= rightOrd;
        case 'lt': return leftOrd < rightOrd;
        case 'gt': return leftOrd > rightOrd;
        default: return false;
      }
    }
    if (typeof leftVal !== 'number' || typeof rightVal !== 'number') return false;
    switch (rule.op) {
      case 'lte': return leftVal <= rightVal;
      case 'gte': return leftVal >= rightVal;
      case 'lt': return leftVal < rightVal;
      case 'gt': return leftVal > rightVal;
      case 'eq': return leftVal === rightVal;
      default: return false;
    }
  }

  function evaluateRules(ctx, config) {
    if (!config) return false;
    var rules = config.rules || [];
    var enabledRules = rules.filter(function (r) { return r.enabled !== false; });
    if (enabledRules.length === 0) return false;
    for (var i = 0; i < enabledRules.length; i++) {
      if (!evaluateRule(enabledRules[i], ctx)) return false;
    }
    return true;
  }

  function formatRuleValue(val, rule, isLeft) {
    if (val == null || (typeof val === 'number' && isNaN(val))) return '\u2014';
    if (typeof val === 'string') return val || '\u2014';
    var isVolume = (isLeft && (rule.left === 'short.volume' || rule.left === 'medium.volume' || rule.left === 'long.volume')) ||
      (!isLeft && rule.right && /\.volume$/.test(rule.right));
    var isSentiment = (isLeft && rule.left === 'now.sentiment') || (!isLeft && rule.right && ['Bull', 'Bear', 'Neutral', 'any'].indexOf(rule.right) >= 0);
    var isTrend = (isLeft && (rule.left === 'now.trend' || rule.left === 'short.trend' || rule.left === 'medium.trend' || rule.left === 'long.trend')) ||
      (!isLeft && rule.right && ['up', 'down', 'flat'].indexOf(rule.right) >= 0);
    if (isSentiment || isTrend) return String(val);
    return isVolume ? String(Math.round(val)) : val.toFixed(2);
  }

  function getOpSymbol(op) {
    var m = RULE_OPS.find(function (o) { return o.value === op; });
    return m ? m.label : op;
  }

  function updateRuleStatusIndicators() {
    var ctx = getContext();
    if (!rulesItems) return;
    var rows = rulesItems.querySelectorAll('[data-rule]');
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i];
      var enabledEl = el.querySelector('[data-rule-enabled]');
      var leftEl = el.querySelector('[data-left]');
      var opEl = el.querySelector('[data-op]');
      var rightEl = el.querySelector('[data-right]');
      var rightFixed = el.querySelector('[data-right-fixed]');
      var statusEl = el.querySelector('[data-rule-status]');
      if (!leftEl || !opEl || !statusEl) continue;
      var enabled = enabledEl ? enabledEl.checked : true;
      el.classList.toggle('opacity-60', !enabled);
      if (!enabled) {
        statusEl.textContent = 'off';
        statusEl.className = 'text-center text-xs shrink-0 font-mono text-slate-500';
        statusEl.title = 'Rule disabled';
        continue;
      }
      var right;
      if (rightEl && rightEl.tagName === 'SELECT' && rightEl.value === '__fixed__') {
        right = rightFixed ? rightFixed.value : '';
      } else if (rightEl) {
        right = rightEl.value;
      } else {
        var wrap = el.querySelector('[data-right-wrap]');
        var inp = wrap ? wrap.querySelector('input') : null;
        right = inp ? inp.value : '';
      }
      var rule = { left: leftEl.value, op: opEl.value, right: right };
      var leftVal = getLeftValue(rule, ctx);
      var rightVal = getRightValue(rule, ctx);
      var pass = evaluateRule(rule, ctx);
      var leftStr = formatRuleValue(leftVal, rule, true);
      var rightStr = formatRuleValue(rightVal, rule, false);
      var opSym = getOpSymbol(rule.op);
      var liveText = leftStr + ' ' + opSym + ' ' + rightStr + ' ' + (pass ? '\u2713' : '\u2717');
      statusEl.textContent = liveText;
      statusEl.className = 'text-center text-xs shrink-0 font-mono' + (pass ? ' text-emerald-500' : ' text-red-500');
      statusEl.title = pass ? 'Condition met' : 'Condition not met';
    }
  }

  function updateEngineState() {
    var config = getConfig();
    var ctx = getContext();

    if (!config.running) {
      setDealEnabled(baseEnabled);
      setOrderEnabledFn(baseEnabled);
      setProbesBackfillEnabledFn(baseEnabled);
      if (dealEngineMsg) dealEngineMsg.classList.add('hidden');
      if (orderEngineMsg) orderEngineMsg.classList.add('hidden');
    if (engineStatusEl) {
      var remaining = pausedUntil != null && pausedUntil > Date.now() ? Math.ceil((pausedUntil - Date.now()) / 1000) : 0;
      var statusText = remaining > 0 ? 'Paused (loss) – resuming in ' + remaining + 's' : 'Engine: Stopped';
      engineStatusEl.textContent = statusText + (sleepPreventionStatus && remaining === 0 ? ' • ' + sleepPreventionStatus : '');
      engineStatusEl.className = 'text-xs ' + (remaining > 0 ? 'text-amber-400 mb-2 font-medium' : 'text-slate-500 mb-2');
    }
      if (statusEl)       statusEl.textContent = 'Manual trading enabled';
      updateRuleStatusIndicators();
      return;
    }

    setDealEnabled(false);
    setOrderEnabledFn(false);
    setProbesBackfillEnabledFn(false);
    if (dealEngineMsg) dealEngineMsg.classList.remove('hidden');
    if (orderEngineMsg) orderEngineMsg.classList.remove('hidden');
    if (engineStatusEl) {
      engineStatusEl.textContent = 'Engine: Running' + (sleepPreventionStatus ? ' • ' + sleepPreventionStatus : '');
      engineStatusEl.className = 'text-xs text-amber-400 mb-2 font-medium';
    }

    var rulesPass = evaluateRules(ctx, config);
    var blocked = hasPositionOrOrder();
    var pass = rulesPass;

    if (statusEl) {
      var rules = config.rules || [];
      var enabledRules = rules.filter(function (r) { return r.enabled !== false; });
      var needsProbes = enabledRules.some(function (r) {
        return (r.left !== 'currentTime' && RIGHT_REF_KEYS.indexOf(r.right) >= 0) ||
          r.left === 'short.volume' || r.left === 'medium.volume' || r.left === 'long.volume' ||
          r.left === 'short.trend' || r.left === 'medium.trend' || r.left === 'long.trend' ||
          r.left === 'short.trendPct' || r.left === 'medium.trendPct' || r.left === 'long.trendPct' ||
          r.left === 'short.range' || r.left === 'medium.range' || r.left === 'long.range';
      });
      var needsPrices = enabledRules.some(function (r) { return r.left === 'Buy' || r.left === 'Sell'; });
      var needsNowTrend = enabledRules.some(function (r) { return r.left === 'now.trend'; });
      var status = 'Conditions not met';
      if (rules.length === 0) status = 'Add at least one rule';
      else if (enabledRules.length === 0) status = 'Enable at least one rule';
      else if (needsProbes && !getProbeValuesFn()) status = 'Waiting for probe data';
      else if (needsPrices && (state.currentBid == null || state.currentOffer == null)) status = 'Waiting for prices';
      else if (needsNowTrend && state.currentTrend == null) status = 'Waiting for price updates (now.trend)';
      else if (pass && blocked) status = 'Conditions met – position/order exists, no new deal';
      else if (pass) status = 'Conditions met – placing deal';
      statusEl.textContent = status;
    }

    if (pass && !blocked && (!prevRulesPass || prevBlocked)) {
      var logFn = typeof log === 'function' ? log : function () {};
      logFn('Rules engine triggered deal' + (config.confirmBeforePlace ? ' (confirm)' : ' (direct)'));
      if (config.confirmBeforePlace) {
        triggerDealConfirmFn();
      } else {
        placeDealDirectFn();
      }
    }
    prevRulesPass = pass;
    prevBlocked = blocked;
    updateRuleStatusIndicators();
  }

  function updateToggleButton() {
    if (!toggleBtn) return;
    toggleBtn.textContent = rulesRunning ? 'Stop' : 'Start';
    toggleBtn.className = 'px-2 py-1 rounded text-xs font-medium transition-colors ' + (rulesRunning ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white');
    toggleBtn.title = rulesRunning ? 'Stop the rules engine' : 'Start the rules engine';
    setRulesEditable(!rulesRunning);
    if (state) state.rulesEngineRunning = rulesRunning;
    if (socket && typeof socket.emit === 'function') socket.emit('rules_engine_running', rulesRunning);
  }

  function setRulesEditable(editable) {
    if (addBtn) addBtn.disabled = !editable;
    if (rulesLockedMsg) rulesLockedMsg.classList.toggle('hidden', editable);
    if (autoStopCheck) autoStopCheck.disabled = !editable;
    if (autoStopMinutesInput) autoStopMinutesInput.disabled = !editable;
    if (pauseOnLossInput) pauseOnLossInput.disabled = !editable;
    if (!rulesItems) return;
    var rows = rulesItems.querySelectorAll('[data-rule]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var dragHandle = row.querySelector('[data-rule-drag]');
      if (dragHandle) dragHandle.draggable = editable;
      var controls = row.querySelectorAll('[data-rule-enabled], [data-left], [data-op], [data-right], [data-right-fixed], [data-remove]');
      for (var j = 0; j < controls.length; j++) controls[j].disabled = !editable;
    }
  }

  function updateDealEnabled() {
    updateEngineState();
  }

  function buildLeftOptions() {
    return RULE_LEFT.map(function (l) {
      var title = l.value === 'now.sentiment' ? ' title="IG client sentiment (Bull/Bear/Neutral)"' : '';
      return '<option value="' + l.value + '"' + title + '>' + l.label + '</option>';
    }).join('');
  }

  function buildOpOptions() {
    return RULE_OPS.map(function (o) { return '<option value="' + o.value + '">' + o.label + '</option>'; }).join('');
  }

  function buildRightOptionsPrice(selected) {
    return RIGHT_REFERENCES_PRICE.map(function (r) {
      var sel = r.value === (selected || '') ? ' selected' : '';
      return '<option value="' + r.value + '"' + sel + '>' + r.label + '</option>';
    }).join('');
  }

  function buildRightOptionsTrend(selected) {
    return RIGHT_REFERENCES_TREND.map(function (r) {
      var sel = r.value === (selected || '') ? ' selected' : '';
      return '<option value="' + r.value + '"' + sel + '>' + r.label + '</option>';
    }).join('');
  }

  function buildRightOptionsSentiment(selected) {
    return RIGHT_REFERENCES_SENTIMENT.map(function (r) {
      var sel = r.value === (selected || '') ? ' selected' : '';
      var title = r.value === 'any' ? ' title="Ignore when sentiment unavailable"' : '';
      return '<option value="' + r.value + '"' + sel + title + '>' + r.label + '</option>';
    }).join('');
  }

  function createRuleRow(rule) {
    rule = rule || { left: 'Buy', op: 'lte', right: 'short.avg', enabled: true };
    var left = rule.left || 'Buy';
    var op = rule.op || 'lte';
    var right = rule.right || 'short.avg';
    var enabled = rule.enabled !== false;
    var isVolumeLeft = left === 'short.volume' || left === 'medium.volume' || left === 'long.volume';
    var isTrendLeft = left === 'now.trend' || left === 'short.trend' || left === 'medium.trend' || left === 'long.trend';
    var isSentimentLeft = left === 'now.sentiment';
    var isFixed = rule.right && RIGHT_REF_KEYS.indexOf(rule.right) < 0 && rule.left !== 'currentTime' && !isVolumeLeft && !isTrendLeft && !isSentimentLeft;
    var isTime = rule.left === 'currentTime';
    var row = document.createElement('div');
    row.className = 'rules-grid p-2 rounded bg-slate-800 border border-slate-700';
    row.setAttribute('data-rule', '1');
    var rightHtml;
    if (isTime) {
      rightHtml = '<span data-right-wrap class="min-w-0"><input type="text" data-right value="' + (right ? String(right).replace(/"/g, '&quot;') : '') + '" placeholder="22:50" class="w-full min-w-0 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 font-mono text-xs"></span>';
    } else if (isVolumeLeft) {
      rightHtml = '<span data-right-wrap class="min-w-0"><input type="number" data-right step="1" min="0" value="' + (right || '') + '" placeholder="e.g. 10" class="w-full min-w-0 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 font-mono text-xs" title="Tick count (price updates) in period"></span>';
    } else if (isTrendLeft) {
      rightHtml = '<span data-right-wrap class="min-w-0"><select data-right class="w-full min-w-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs">' + buildRightOptionsTrend(right || 'up') + '</select></span>';
    } else if (isSentimentLeft) {
      rightHtml = '<span data-right-wrap class="min-w-0"><select data-right class="w-full min-w-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs">' + buildRightOptionsSentiment(right && ['Bull', 'Bear', 'Neutral', 'any'].indexOf(right) >= 0 ? right : 'Bull') + '</select></span>';
    } else if (isFixed) {
      rightHtml = '<span data-right-wrap class="flex items-center gap-1 min-w-0"><select data-right class="shrink-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs">' + buildRightOptionsPrice('__fixed__') + '</select><input type="number" data-right-fixed step="any" value="' + (right || '') + '" placeholder="0" class="w-20 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 font-mono text-xs"></span>';
    } else {
      rightHtml = '<span data-right-wrap class="min-w-0"><select data-right class="w-full min-w-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs">' + buildRightOptionsPrice(right) + '</select></span>';
    }
    var enabledChecked = enabled ? ' checked' : '';
    row.innerHTML =
      '<span data-rule-drag class="shrink-0" title="Drag to reorder">⋮⋮</span>' +
      '<input type="checkbox" data-rule-enabled class="rounded bg-slate-800 border-slate-600 text-emerald-500 focus:ring-emerald-500 shrink-0" title="Enable rule (engine must be stopped to change)"' + enabledChecked + '>' +
      '<select data-left class="w-full min-w-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs">' + buildLeftOptions() + '</select>' +
      '<select data-op class="w-full min-w-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs">' + buildOpOptions() + '</select>' +
      rightHtml +
      '<span data-rule-status class="text-center text-xs shrink-0" title="Condition met">—</span>' +
      '<button type="button" data-remove class="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-slate-700 text-xs shrink-0" title="Remove rule">×</button>';
    var enabledCheck = row.querySelector('[data-rule-enabled]');
    var leftSel = row.querySelector('[data-left]');
    var opSel = row.querySelector('[data-op]');
    var rightSel = row.querySelector('[data-right]');
    var rightWrap = row.querySelector('[data-right-wrap]');
    var rightFixed = row.querySelector('[data-right-fixed]');
    var removeBtn = row.querySelector('[data-remove]');
    if (enabledCheck) enabledCheck.checked = enabled;
    if (enabledCheck) enabledCheck.addEventListener('change', onChange);
    if (leftSel) leftSel.value = left;
    if (opSel) opSel.value = op;
    if (rightSel) rightSel.value = isTime ? '' : (isFixed ? '__fixed__' : (isTrendLeft ? (right || 'up') : (isSentimentLeft ? (right && ['Bull', 'Bear', 'Neutral', 'any'].indexOf(right) >= 0 ? right : 'Bull') : right)));
    if (rightFixed) rightFixed.value = isFixed ? right : '';

    function onChange() {
      saveRules();
      updateDealEnabled();
    }
    function onLeftChange() {
      var l = leftSel.value;
      var rightCell = row.querySelector('[data-rule-status]') ? row.querySelector('[data-rule-status]').previousElementSibling : null;
      if (!rightCell) return;
      var parent = rightCell.parentNode;
      var fixEl = rightCell.querySelector('[data-right-fixed]');
      var rightEl = rightCell.querySelector('[data-right]');
      var prevRight = (fixEl ? fixEl.value : (rightEl ? rightEl.value : '')) || '';
      rightCell.remove();
      if (l === 'currentTime') {
        var span = document.createElement('span');
        span.setAttribute('data-right-wrap', '1');
        span.className = 'min-w-0';
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = '22:50';
        inp.setAttribute('data-right', '1');
        inp.className = 'w-full min-w-0 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 font-mono text-xs';
        inp.value = prevRight || '';
        span.appendChild(inp);
        parent.insertBefore(span, parent.querySelector('[data-rule-status]'));
        inp.addEventListener('change', onChange);
        inp.addEventListener('input', onChange);
      } else if (l === 'short.volume' || l === 'medium.volume' || l === 'long.volume') {
        var span = document.createElement('span');
        span.setAttribute('data-right-wrap', '1');
        span.className = 'min-w-0';
        var inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '1';
        inp.min = '0';
        inp.placeholder = 'e.g. 10';
        inp.setAttribute('data-right', '1');
        inp.className = 'w-full min-w-0 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 font-mono text-xs';
        inp.value = prevRight || '';
        span.appendChild(inp);
        parent.insertBefore(span, parent.querySelector('[data-rule-status]'));
        inp.addEventListener('change', onChange);
        inp.addEventListener('input', onChange);
      } else if (l === 'now.trend' || l === 'short.trend' || l === 'medium.trend' || l === 'long.trend') {
        var spanTrend = document.createElement('span');
        spanTrend.setAttribute('data-right-wrap', '1');
        spanTrend.className = 'min-w-0';
        var selTrend = document.createElement('select');
        selTrend.setAttribute('data-right', '1');
        selTrend.className = 'w-full min-w-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs';
        selTrend.innerHTML = buildRightOptionsTrend(prevRight && ['up', 'down', 'flat'].indexOf(prevRight) >= 0 ? prevRight : 'up');
        spanTrend.appendChild(selTrend);
        parent.insertBefore(spanTrend, parent.querySelector('[data-rule-status]'));
        selTrend.addEventListener('change', onRightChange);
      } else if (l === 'now.sentiment') {
        if (opSel) opSel.value = 'eq';
        var spanSentiment = document.createElement('span');
        spanSentiment.setAttribute('data-right-wrap', '1');
        spanSentiment.className = 'min-w-0';
        var selSentiment = document.createElement('select');
        selSentiment.setAttribute('data-right', '1');
        selSentiment.className = 'w-full min-w-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs';
        selSentiment.innerHTML = buildRightOptionsSentiment(prevRight && ['Bull', 'Bear', 'Neutral', 'any'].indexOf(prevRight) >= 0 ? prevRight : 'Bull');
        spanSentiment.appendChild(selSentiment);
        parent.insertBefore(spanSentiment, parent.querySelector('[data-rule-status]'));
        selSentiment.addEventListener('change', onRightChange);
      } else {
        var newWrap = document.createElement('span');
        newWrap.setAttribute('data-right-wrap', '1');
        newWrap.className = 'min-w-0';
        var newSel = document.createElement('select');
        newSel.setAttribute('data-right', '1');
        newSel.className = 'w-full min-w-0 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-slate-200 text-xs';
        newSel.innerHTML = buildRightOptionsPrice('short.avg');
        newWrap.appendChild(newSel);
        parent.insertBefore(newWrap, parent.querySelector('[data-rule-status]'));
        newSel.addEventListener('change', onRightChange);
      }
      onChange();
    }
    function onRightChange() {
      var sel = row.querySelector('[data-right]');
      if (!sel || sel.tagName !== 'SELECT') return;
      var r = sel.value;
      var wrap = row.querySelector('[data-right-wrap]');
      var fix = row.querySelector('[data-right-fixed]');
      if (r === '__fixed__') {
        if (!fix && wrap) {
          var inp = document.createElement('input');
          inp.type = 'number';
          inp.step = 'any';
          inp.placeholder = '0';
          inp.setAttribute('data-right-fixed', '1');
          inp.className = 'w-20 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 font-mono text-xs ml-1';
          wrap.appendChild(inp);
          inp.addEventListener('change', onChange);
          inp.addEventListener('input', onChange);
        }
      } else if (fix) {
        fix.remove();
      }
      onChange();
    }
    if (leftSel) leftSel.addEventListener('change', onLeftChange);
    if (opSel) opSel.addEventListener('change', onChange);
    if (rightSel) rightSel.addEventListener('change', onRightChange);
    if (rightFixed) {
      rightFixed.addEventListener('change', onChange);
      rightFixed.addEventListener('input', onChange);
    }
    var rightInput = row.querySelector('[data-right]');
    if (rightInput && rightInput.tagName === 'INPUT') {
      rightInput.addEventListener('change', onChange);
      rightInput.addEventListener('input', onChange);
    }
    removeBtn.addEventListener('click', function () {
      row.remove();
      saveRules();
      updateDealEnabled();
    });
    var dragHandle = row.querySelector('[data-rule-drag]');
    if (dragHandle) {
      dragHandle.draggable = true;
      dragHandle.addEventListener('dragstart', function (e) {
        draggedRuleRow = row;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
        row.classList.add('opacity-50');
      });
      dragHandle.addEventListener('dragend', function () {
        row.classList.remove('opacity-50');
        draggedRuleRow = null;
      });
    }
    row.addEventListener('dragover', function (e) {
      if (!draggedRuleRow || draggedRuleRow === row) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!draggedRuleRow || draggedRuleRow === row) return;
      rulesItems.insertBefore(draggedRuleRow, row);
      saveRules();
      updateDealEnabled();
    });
    return row;
  }

  function saveRules() {
    var epicSelect = document.getElementById('epicSelect');
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    if (!epic) return;
    var config = getConfig();
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var instruments = (cfg.ui && cfg.ui.instruments) ? { ...cfg.ui.instruments } : {};
      instruments[epic] = { ...(instruments[epic] || {}), tradingRulesRunning: config.running, tradingRulesConfirmBeforePlace: config.confirmBeforePlace, tradingRules: config.rules, tradingRulesAutoStopEnabled: config.autoStopEnabled, tradingRulesAutoStopBeforeMinutes: config.autoStopBeforeMinutes, tradingRulesPauseOnLossSeconds: config.pauseOnLossSeconds };
      return fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui: { instruments: instruments } })
      });
    }).then(function (r) { return r && r.json ? r.json() : {}; }).catch(function () {});
  }

  function loadRules() {
    var epicSelect = document.getElementById('epicSelect');
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      if (!epic && cfg.epic) epic = cfg.epic;
      var ui = cfg.ui || {};
      var inst = (epic && ui.instruments && ui.instruments[epic]) ? ui.instruments[epic] : {};
      var confirmBeforePlace = inst.tradingRulesConfirmBeforePlace != null ? inst.tradingRulesConfirmBeforePlace !== false : ui.tradingRulesConfirmBeforePlace !== false;
      var autoStopEnabled = inst.tradingRulesAutoStopEnabled != null ? inst.tradingRulesAutoStopEnabled !== false : ui.tradingRulesAutoStopEnabled !== false;
      var autoStopBeforeMinutes = inst.tradingRulesAutoStopBeforeMinutes != null ? inst.tradingRulesAutoStopBeforeMinutes : ui.tradingRulesAutoStopBeforeMinutes;
      var pauseOnLossSeconds = inst.tradingRulesPauseOnLossSeconds != null ? inst.tradingRulesPauseOnLossSeconds : (ui.tradingRulesPauseOnLossSeconds != null ? ui.tradingRulesPauseOnLossSeconds : 0);
      var rules = inst.tradingRules || ui.tradingRules || [];
      rulesRunning = false; // Always off on start – prevents trading on stale indicators after restart
      if (state) state.rulesEngineRunning = false;
      if (confirmCheck) confirmCheck.checked = confirmBeforePlace;
      if (autoStopCheck) autoStopCheck.checked = autoStopEnabled;
      if (autoStopMinutesInput) {
        var mins = (autoStopBeforeMinutes != null && !isNaN(autoStopBeforeMinutes) && autoStopBeforeMinutes >= 0) ? Math.min(autoStopBeforeMinutes, 1440) : 60;
        autoStopMinutesInput.value = mins;
      }
      if (pauseOnLossInput) {
        var secs = (pauseOnLossSeconds != null && !isNaN(pauseOnLossSeconds) && pauseOnLossSeconds >= 0) ? Math.min(pauseOnLossSeconds, 86400) : 0;
        pauseOnLossInput.value = secs;
      }
      if (rulesItems) {
        rulesItems.innerHTML = '';
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          if (!r || !r.left || !r.op) continue;
          rulesItems.appendChild(createRuleRow(r));
        }
      }
      updateToggleButton();
      if (rulesRunning) startAutoStopTimer();
      else clearAutoStopTimer();
      updateEngineState();
    }).catch(function () { updateEngineState(); });
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      if (pausedUntil != null) {
        pausedUntil = null;
        if (pauseOnLossTimerId) { clearTimeout(pauseOnLossTimerId); pauseOnLossTimerId = null; }
        if (pauseCountdownIntervalId) { clearInterval(pauseCountdownIntervalId); pauseCountdownIntervalId = null; }
      }
      rulesRunning = !rulesRunning;
      if (rulesRunning) startAutoStopTimer();
      else clearAutoStopTimer();
      updateToggleButton();
      saveRules();
      updateDealEnabled();
    });
  }
  if (confirmCheck) {
    confirmCheck.addEventListener('change', function () {
      saveRules();
    });
  }
  if (autoStopCheck) {
    autoStopCheck.addEventListener('change', function () {
      saveRules();
      updateAutoStopDisplay();
    });
  }
  if (autoStopMinutesInput) {
    autoStopMinutesInput.addEventListener('change', function () {
      saveRules();
      updateAutoStopDisplay();
    });
    autoStopMinutesInput.addEventListener('input', updateAutoStopDisplay);
  }
  if (pauseOnLossInput) {
    pauseOnLossInput.addEventListener('change', saveRules);
  }
  if (addBtn) {
    addBtn.addEventListener('click', function () {
      if (rulesItems) rulesItems.appendChild(createRuleRow({}));
      saveRules();
      updateDealEnabled();
    });
  }

  socket.on('disconnect', function () {
    rulesRunning = false;
    if (state) state.rulesEngineRunning = false;
    pausedUntil = null;
    if (pauseOnLossTimerId) {
      clearTimeout(pauseOnLossTimerId);
      pauseOnLossTimerId = null;
    }
    if (pauseCountdownIntervalId) {
      clearInterval(pauseCountdownIntervalId);
      pauseCountdownIntervalId = null;
    }
    clearAutoStopTimer();
    updateToggleButton();
    updateDealEnabled();
  });

  socket.on('transaction_added', function (tx) {
    if (!tx || tx.type !== 'closed' || typeof tx.profitLoss !== 'number' || tx.profitLoss >= 0) return;
    var seconds = getPauseOnLossSeconds();
    if (seconds > 0 && rulesRunning) doPauseOnLoss(seconds);
  });

  socket.on('positions', function () {
    updateEngineState();
  });
  socket.on('working_orders', updateEngineState);
  socket.on('marketDetails', function () {
    setTimeout(updateAutoStopDisplay, 0);
    setTimeout(updateDealEnabled, 0);
  });
  socket.on('price_update', function () {
    setTimeout(updateRuleStatusIndicators, 0);
  });

  socket.on('sleep_prevention_status', function (msg) {
    sleepPreventionStatus = msg || null;
    if (engineStatusEl) {
      var remaining = pausedUntil != null && pausedUntil > Date.now() ? Math.ceil((pausedUntil - Date.now()) / 1000) : 0;
      var statusText = remaining > 0 ? 'Paused (loss) – resuming in ' + remaining + 's' : (rulesRunning ? 'Engine: Running' : 'Engine: Stopped');
      engineStatusEl.textContent = statusText + (sleepPreventionStatus && remaining === 0 ? ' • ' + sleepPreventionStatus : '');
    }
  });

  loadRules();
  updateAutoStopDisplay();

  return {
    setBaseEnabled: function (enabled) {
      baseEnabled = !!enabled;
      updateDealEnabled();
    },
    updateDealEnabled: updateDealEnabled,
    setTradingRulesPanelEnabled: function (enabled) {
      var panel = document.getElementById('tradingRulesPanel');
      if (panel) panel.classList.toggle('hidden', !enabled);
    },
    loadRules: loadRules
  };
}
