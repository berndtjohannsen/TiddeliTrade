/**
 * Trading rules – [live] [op] [ref] in the row; engine semantics unchanged (left = live, right = reference).
 * UI groups rows by probe horizon (short / medium / long / other); config persists ruleGroups. Paraphrase line = probe-first wording when live is Buy/Sell vs a probe ref.
 */
import { formatTimeWithTz, formatMoney } from './utils.js';

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

function getRulesFromContainer(container) {
  if (!container) return [];
  var items = container.querySelectorAll('[data-rule]');
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

var RULE_GROUP_ORDER = ['long', 'medium', 'short', 'other'];

function groupContainerId(panel, group) {
  var cap = { short: 'Short', medium: 'Medium', long: 'Long', other: 'Other' };
  return 'tradingRules' + (panel === 'buy' ? 'Buy' : 'Sell') + cap[group];
}

function inferRuleGroup(rule) {
  var s = (rule.left || '') + ' ' + (rule.right || '');
  var found = [];
  if (/\bshort\./.test(s)) found.push('short');
  if (/\bmedium\./.test(s)) found.push('medium');
  if (/\blong\./.test(s)) found.push('long');
  var uniq = [];
  for (var f = 0; f < found.length; f++) {
    if (uniq.indexOf(found[f]) < 0) uniq.push(found[f]);
  }
  if (uniq.length === 1) return uniq[0];
  return 'other';
}

function defaultRuleForGroup(group, panel) {
  var live = panel === 'sell' ? 'Sell' : 'Buy';
  if (group === 'short') return { left: live, op: 'gt', right: 'short.avg', enabled: true };
  if (group === 'medium') return { left: live, op: 'gt', right: 'medium.avg', enabled: true };
  if (group === 'long') return { left: live, op: 'gt', right: 'long.avg', enabled: true };
  return { left: 'currentTime', op: 'lte', right: '', enabled: true };
}

function readRuleFromRow(rowEl) {
  if (!rowEl || !rowEl.getAttribute('data-rule')) return null;
  var enabledEl = rowEl.querySelector('[data-rule-enabled]');
  var leftEl = rowEl.querySelector('[data-left]');
  var opEl = rowEl.querySelector('[data-op]');
  var rightEl = rowEl.querySelector('[data-right]');
  var rightWrap = rowEl.querySelector('[data-right-wrap]');
  var rightFixed = rowEl.querySelector('[data-right-fixed]');
  if (!leftEl || !opEl) return null;
  var right;
  if (rightEl && rightEl.tagName === 'SELECT' && rightEl.value === '__fixed__') {
    right = rightFixed ? rightFixed.value : '';
  } else if (rightEl) {
    right = rightEl.value;
  } else if (rightWrap) {
    var inp = rightWrap.querySelector('input');
    right = inp ? inp.value : '';
  } else {
    return null;
  }
  var enabled = enabledEl ? enabledEl.checked : true;
  return { left: leftEl.value, op: opEl.value, right: right, enabled: enabled };
}

function invertComparisonOp(op) {
  switch (op) {
    case 'lt': return 'gt';
    case 'gt': return 'lt';
    case 'lte': return 'gte';
    case 'gte': return 'lte';
    default: return op;
  }
}

function labelForRuleToken(val) {
  for (var i = 0; i < RULE_LEFT.length; i++) {
    if (RULE_LEFT[i].value === val) return RULE_LEFT[i].label;
  }
  for (var j = 0; j < RIGHT_REFERENCES_PRICE.length; j++) {
    if (RIGHT_REFERENCES_PRICE[j].value === val) return RIGHT_REFERENCES_PRICE[j].label;
  }
  if (['up', 'down', 'flat'].indexOf(val) >= 0) return val;
  if (['Bull', 'Bear', 'Neutral', 'any'].indexOf(val) >= 0) return val;
  return val || '\u2014';
}

function comparisonPhrase(op) {
  switch (op) {
    case 'lt': return 'is less than';
    case 'gt': return 'is greater than';
    case 'lte': return 'is less than or equal to';
    case 'gte': return 'is greater than or equal to';
    case 'eq': return 'equals';
    default: return op;
  }
}

function formatRuleParaphrase(rule) {
  if (!rule || !rule.left || !rule.op) return '';
  var L = rule.left;
  var R = rule.right;
  var op = rule.op;
  var probeRight = RIGHT_REF_KEYS.indexOf(R) >= 0 || R === 'dayStart';
  if ((L === 'Buy' || L === 'Sell') && probeRight) {
    return labelForRuleToken(R) + ' ' + comparisonPhrase(invertComparisonOp(op)) + ' ' + labelForRuleToken(L) + '.';
  }
  return labelForRuleToken(L) + ' ' + comparisonPhrase(op) + ' ' + labelForRuleToken(R) + '.';
}

function collectRuleGroupsFromDom(panel) {
  var out = { short: [], medium: [], long: [], other: [] };
  for (var i = 0; i < RULE_GROUP_ORDER.length; i++) {
    var g = RULE_GROUP_ORDER[i];
    var el = document.getElementById(groupContainerId(panel, g));
    out[g] = getRulesFromContainer(el);
  }
  return out;
}

function flattenRuleGroups(rg) {
  var flat = [];
  for (var i = 0; i < RULE_GROUP_ORDER.length; i++) {
    var arr = rg[RULE_GROUP_ORDER[i]] || [];
    for (var j = 0; j < arr.length; j++) flat.push(arr[j]);
  }
  return flat;
}

function getPersistedRuleSets(rs) {
  var emptyRg = { short: [], medium: [], long: [], other: [] };
  if (!rs || !rs.buy || !rs.sell) {
    return {
      buy: { dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate', ruleGroups: emptyRg },
      sell: { dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate', ruleGroups: emptyRg }
    };
  }
  return {
    buy: {
      dealSize: rs.buy.dealSize,
      takeProfit: rs.buy.takeProfit,
      stopLoss: rs.buy.stopLoss,
      tpSlMode: rs.buy.tpSlMode,
      ruleGroups: rs.buy.ruleGroups || emptyRg
    },
    sell: {
      dealSize: rs.sell.dealSize,
      takeProfit: rs.sell.takeProfit,
      stopLoss: rs.sell.stopLoss,
      tpSlMode: rs.sell.tpSlMode,
      ruleGroups: rs.sell.ruleGroups || emptyRg
    }
  };
}

function normalizeRuleGroupsFromSaved(sideData) {
  var empty = { short: [], medium: [], long: [], other: [] };
  if (!sideData) return empty;
  var rg = sideData.ruleGroups;
  if (rg && typeof rg === 'object') {
    var hasAny = false;
    for (var h = 0; h < RULE_GROUP_ORDER.length; h++) {
      if (Array.isArray(rg[RULE_GROUP_ORDER[h]])) hasAny = true;
    }
    if (hasAny) {
      for (var i = 0; i < RULE_GROUP_ORDER.length; i++) {
        var key = RULE_GROUP_ORDER[i];
        empty[key] = Array.isArray(rg[key]) ? rg[key] : [];
      }
      return empty;
    }
  }
  var flat = sideData.rules;
  if (flat && flat.length) {
    for (var j = 0; j < flat.length; j++) {
      var rr = flat[j];
      if (!rr || !rr.left || !rr.op) continue;
      var g = inferRuleGroup(rr);
      empty[g].push(rr);
    }
  }
  return empty;
}

/** Returns rule sets and probe periods from DOM for backtest. Used by Test rules panel. */
export function getRulesForBacktest() {
  var buyRg = collectRuleGroupsFromDom('buy');
  var sellRg = collectRuleGroupsFromDom('sell');
  var buySize = document.getElementById('rulesBuySize');
  var buyTp = document.getElementById('rulesBuyTp');
  var buySl = document.getElementById('rulesBuySl');
  var buyMode = document.getElementById('rulesBuyTpSlMode');
  var sellSize = document.getElementById('rulesSellSize');
  var sellTp = document.getElementById('rulesSellTp');
  var sellSl = document.getElementById('rulesSellSl');
  var sellMode = document.getElementById('rulesSellTpSlMode');
  var ruleSets = [
    { direction: 'BUY', rules: flattenRuleGroups(buyRg), dealSize: buySize ? (buySize.value.trim() || '1') : '1', takeProfit: buyTp && buyTp.value.trim() ? buyTp.value.trim() : null, stopLoss: buySl && buySl.value.trim() ? buySl.value.trim() : null, tpSlMode: buyMode ? buyMode.value : 'rate' },
    { direction: 'SELL', rules: flattenRuleGroups(sellRg), dealSize: sellSize ? (sellSize.value.trim() || '1') : '1', takeProfit: sellTp && sellTp.value.trim() ? sellTp.value.trim() : null, stopLoss: sellSl && sellSl.value.trim() ? sellSl.value.trim() : null, tpSlMode: sellMode ? sellMode.value : 'rate' }
  ];
  var backtestBuy = document.getElementById('testRulesBacktestBuy');
  var backtestSell = document.getElementById('testRulesBacktestSell');
  var backtestRuleSets = [];
  if (backtestBuy && backtestBuy.checked) backtestRuleSets.push('BUY');
  if (backtestSell && backtestSell.checked) backtestRuleSets.push('SELL');
  var shortEl = document.getElementById('probeShortPeriod');
  var mediumEl = document.getElementById('probeMediumPeriod');
  var longEl = document.getElementById('probeLongPeriod');
  var short = parseInt(shortEl && shortEl.value, 10);
  var medium = parseInt(mediumEl && mediumEl.value, 10);
  var long = parseInt(longEl && longEl.value, 10);
  return {
    rules: ruleSets[0].rules.concat(ruleSets[1].rules),
    ruleSets: ruleSets,
    backtestRuleSets: backtestRuleSets.length > 0 ? backtestRuleSets : ['BUY', 'SELL'],
    probeShortMinutes: isNaN(short) || short < 1 ? 5 : Math.min(short, 1440),
    probeMediumMinutes: isNaN(medium) || medium < 1 ? 60 : Math.min(Math.max(medium, 1), 10080),
    probeLongMinutes: (isNaN(long) || long < 1 ? 24 : Math.min(long, 720)) * 60
  };
}

export function initTradingRules(socket, state, setDealEnabled, setOrderEnabled, setProbesPanelEnabled, setProbesBackfillEnabled, getProbeValues, triggerDealConfirm, placeDealDirect, log) {
  var toggleBtn = document.getElementById('tradingRulesToggle');
  var toggleBtnSell = document.getElementById('tradingRulesToggleSell');
  var confirmCheck = document.getElementById('tradingRulesConfirmBeforePlace');
  var confirmCheckSell = document.getElementById('tradingRulesConfirmBeforePlaceSell');
  var rulesBuyGroupsRoot = document.getElementById('tradingRulesBuyGroups');
  var rulesSellGroupsRoot = document.getElementById('tradingRulesSellGroups');
  var statusEl = document.getElementById('tradingRulesStatus');
  var statusSellEl = document.getElementById('tradingRulesStatusSell');
  var engineStatusEl = document.getElementById('tradingRulesEngineStatus');
  var engineStatusSellEl = document.getElementById('tradingRulesEngineStatusSell');
  var rulesLockedMsg = document.getElementById('tradingRulesLockedMsg');
  var rulesLockedMsgSell = document.getElementById('tradingRulesLockedMsgSell');
  var dealEngineMsg = document.getElementById('dealEngineActiveMsg');
  var orderEngineMsg = document.getElementById('orderEngineActiveMsg');
  var autoStopCheck = document.getElementById('tradingRulesAutoStop');
  var autoStopCheckSell = document.getElementById('tradingRulesAutoStopSell');
  var autoStopMinutesInput = document.getElementById('tradingRulesAutoStopMinutes');
  var autoStopMinutesInputSell = document.getElementById('tradingRulesAutoStopMinutesSell');
  var pauseOnLossInput = document.getElementById('tradingRulesPauseOnLoss');
  var pauseOnLossInputSell = document.getElementById('tradingRulesPauseOnLossSell');
  var baseEnabled = false;
  var rulesRunningBuy = false;
  var rulesRunningSell = false;
  var sleepPreventionStatus = null;
  var prevRulesPass = false;
  var prevBlocked = false;
  /** Suppress rapid re-fires when pass/blocked flicker (e.g. positions poll) without a stable pass→fail cycle. */
  var RULES_DEAL_ATTEMPT_COOLDOWN_MS = 8000;
  var lastRulesDealAttemptMs = 0;
  var autoStopTimerId = null;
  var pauseOnLossTimerId = null;
  var pausedUntil = null;
  var draggedRuleWrap = null;
  var getProbeValuesFn = getProbeValues || function () { return null; };
  var triggerDealConfirmFn = typeof triggerDealConfirm === 'function' ? triggerDealConfirm : function () { return false; };
  var placeDealDirectFn = typeof placeDealDirect === 'function' ? placeDealDirect : function () { return false; };
  var setOrderEnabledFn = typeof setOrderEnabled === 'function' ? setOrderEnabled : function () {};
  var setProbesBackfillEnabledFn = typeof setProbesBackfillEnabled === 'function' ? setProbesBackfillEnabled : function () {};

  function getPauseOnLossSeconds() {
    var buySec = 0, sellSec = 0;
    if (pauseOnLossInput && pauseOnLossInput.value.trim()) { var n = parseInt(pauseOnLossInput.value, 10); buySec = !isNaN(n) && n >= 0 ? Math.min(n, 86400) : 0; }
    if (pauseOnLossInputSell && pauseOnLossInputSell.value.trim()) { var m = parseInt(pauseOnLossInputSell.value, 10); sellSec = !isNaN(m) && m >= 0 ? Math.min(m, 86400) : 0; }
    return Math.max(buySec, sellSec);
  }

  function getPauseOnLossSecondsBuy() {
    if (!pauseOnLossInput || !pauseOnLossInput.value.trim()) return 0;
    var n = parseInt(pauseOnLossInput.value, 10);
    return !isNaN(n) && n >= 0 ? Math.min(n, 86400) : 0;
  }

  function getPauseOnLossSecondsSell() {
    if (!pauseOnLossInputSell || !pauseOnLossInputSell.value.trim()) return 0;
    var n = parseInt(pauseOnLossInputSell.value, 10);
    return !isNaN(n) && n >= 0 ? Math.min(n, 86400) : 0;
  }

  function getAutoStopBeforeMinutes(panel) {
    var input = panel === 'sell' ? autoStopMinutesInputSell : autoStopMinutesInput;
    if (!input || !input.value.trim()) return 60;
    var n = parseInt(input.value, 10);
    return !isNaN(n) && n >= 0 ? Math.min(n, 1440) : 60;
  }

  function computeRulesEstTpSl(direction, sizeEl, tpEl, slEl, modeEl) {
    if (!sizeEl || !tpEl || !slEl || !modeEl) return null;
    var size = parseFloat(sizeEl.value.trim() || '1');
    var tpRaw = tpEl.value.trim();
    var slRaw = slEl.value.trim();
    var mode = modeEl.value || 'value';
    var entryPrice = direction === 'BUY' ? state.currentOffer : state.currentBid;
    var contractSize = (state.currentContractSize > 0 ? state.currentContractSize : 1);
    var currency = state.currentDealCurrency || '';
    if (!tpRaw && !slRaw) return null;
    if ((mode === 'pct' || mode === 'rate') && (entryPrice == null || isNaN(entryPrice) || entryPrice <= 0)) return null;
    if (isNaN(size) || size <= 0) return null;
    var tpGain = null;
    var slLoss = null;
    if (mode === 'value') {
      if (tpRaw) { var tpVal = parseFloat(tpRaw); tpGain = !isNaN(tpVal) ? tpVal : null; }
      if (slRaw) { var slVal = parseFloat(slRaw); slLoss = !isNaN(slVal) && slVal > 0 ? -slVal : null; }
    } else if (mode === 'rate' && entryPrice != null && !isNaN(entryPrice)) {
      var denom = size * contractSize;
      if (tpRaw) { var tpLevel = parseFloat(tpRaw); if (!isNaN(tpLevel)) tpGain = direction === 'BUY' ? (tpLevel - entryPrice) * denom : (entryPrice - tpLevel) * denom; }
      if (slRaw) { var slLevel = parseFloat(slRaw); if (!isNaN(slLevel)) { slLoss = direction === 'BUY' ? (entryPrice - slLevel) * denom : (slLevel - entryPrice) * denom; slLoss = slLoss < 0 ? null : -slLoss; } }
    } else if (mode === 'pct' && entryPrice != null && !isNaN(entryPrice)) {
      var denom = size * contractSize;
      if (tpRaw) { var tpPct = parseFloat(tpRaw); if (!isNaN(tpPct)) { var tpLvl = direction === 'BUY' ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100); tpGain = direction === 'BUY' ? (tpLvl - entryPrice) * denom : (entryPrice - tpLvl) * denom; } }
      if (slRaw) { var slPct = parseFloat(slRaw); if (!isNaN(slPct) && slPct > 0) { var slLvl = direction === 'BUY' ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100); slLoss = direction === 'BUY' ? (entryPrice - slLvl) * denom : (slLvl - entryPrice) * denom; slLoss = -slLoss; } }
    }
    if (tpGain == null && slLoss == null) return null;
    return { tpGain: tpGain, slLoss: slLoss, currency: currency };
  }

  function updateRulesEstTpSlDisplay() {
    var buySize = document.getElementById('rulesBuySize');
    var buyTp = document.getElementById('rulesBuyTp');
    var buySl = document.getElementById('rulesBuySl');
    var buyMode = document.getElementById('rulesBuyTpSlMode');
    var sellSize = document.getElementById('rulesSellSize');
    var sellTp = document.getElementById('rulesSellTp');
    var sellSl = document.getElementById('rulesSellSl');
    var sellMode = document.getElementById('rulesSellTpSlMode');
    function updateOne(el, direction, sizeEl, tpEl, slEl, modeEl) {
      if (!el) return;
      var est = computeRulesEstTpSl(direction, sizeEl, tpEl, slEl, modeEl);
      if (!est) { el.textContent = '—'; el.className = 'text-xs font-mono text-slate-400'; return; }
      var parts = [];
      if (est.tpGain != null) parts.push('TP: ' + formatMoney(est.tpGain, est.currency));
      if (est.slLoss != null) parts.push('SL: ' + formatMoney(est.slLoss, est.currency));
      el.textContent = parts.length ? parts.join(', ') : '—';
      var tpIsLoss = est.tpGain != null && est.tpGain < 0;
      el.className = 'text-xs font-mono ' + (est.tpGain != null && est.slLoss != null ? (tpIsLoss ? 'text-red-500' : 'text-slate-400') : est.tpGain != null ? (tpIsLoss ? 'text-red-500' : 'text-emerald-500') : 'text-red-500');
    }
    updateOne(document.getElementById('rulesBuyEstTpSl'), 'BUY', buySize, buyTp, buySl, buyMode);
    updateOne(document.getElementById('rulesSellEstTpSl'), 'SELL', sellSize, sellTp, sellSl, sellMode);
  }

  /** Next auto-stop instant: always strictly in the future. Rolls past stale defaultCloseAt / UTC-midnight math so the engine does not stop immediately after startup. */
  function getStopAtForPanel(panel) {
    var check = panel === 'sell' ? autoStopCheckSell : autoStopCheck;
    if (!check || !check.checked) return null;
    var beforeMs = getAutoStopBeforeMinutes(panel) * 60 * 1000;
    var is24_7 = !!state.is24_7Market;
    var now = Date.now();
    if (is24_7) {
      var t = new Date();
      var y = t.getUTCFullYear();
      var m = t.getUTCMonth();
      var d = t.getUTCDate();
      for (var k = 1; k <= 8; k++) {
        var midnight = new Date(Date.UTC(y, m, d + k, 0, 0, 0, 0)).getTime();
        var stopAt = midnight - beforeMs;
        if (stopAt > now) return stopAt;
      }
      return null;
    }
    var closeAt = state.defaultCloseAt;
    if (!closeAt) return null;
    var closeMs = new Date(closeAt).getTime();
    if (isNaN(closeMs)) return null;
    for (var i = 0; i < 8; i++) {
      var stopAt2 = closeMs - beforeMs;
      if (stopAt2 > now) return stopAt2;
      closeMs += 24 * 60 * 60 * 1000;
    }
    return null;
  }

  function getStopAt() {
    var buyAt = (rulesRunningBuy ? getStopAtForPanel('buy') : null);
    var sellAt = (rulesRunningSell ? getStopAtForPanel('sell') : null);
    if (buyAt == null && sellAt == null) return null;
    if (buyAt == null) return sellAt;
    if (sellAt == null) return buyAt;
    return Math.min(buyAt, sellAt);
  }

  function updateAutoStopDisplay() {
    function showOne(el, panel) {
      var stopAt = getStopAtForPanel(panel);
      if (stopAt == null) {
        if (el) { el.textContent = '—'; el.title = 'Auto-stop disabled or no market close time'; }
      } else {
        var d = new Date(stopAt);
        var formatted = formatTimeWithTz(d.toISOString());
        if (el) { el.textContent = 'Stops at ' + formatted; el.title = 'Engine will auto-stop at ' + formatted; }
      }
    }
    showOne(document.getElementById('tradingRulesAutoStopTime'), 'buy');
    showOne(document.getElementById('tradingRulesAutoStopTimeSell'), 'sell');
  }

  function checkAutoStop() {
    if (!rulesRunningBuy && !rulesRunningSell) return;
    var stopAt = getStopAt();
    if (stopAt == null) return;
    if (Date.now() >= stopAt) {
      rulesRunningBuy = false;
      rulesRunningSell = false;
      if (autoStopTimerId) {
        clearInterval(autoStopTimerId);
        autoStopTimerId = null;
      }
      updateToggleButton();
      saveRules();
      updateDealEnabled();
      var logFn = typeof log === 'function' ? log : function () {};
      logFn('Rules engine auto-stopped');
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

  function getRuleSetsFromDom() {
    var buySize = document.getElementById('rulesBuySize');
    var buyTp = document.getElementById('rulesBuyTp');
    var buySl = document.getElementById('rulesBuySl');
    var buyMode = document.getElementById('rulesBuyTpSlMode');
    var sellSize = document.getElementById('rulesSellSize');
    var sellTp = document.getElementById('rulesSellTp');
    var sellSl = document.getElementById('rulesSellSl');
    var sellMode = document.getElementById('rulesSellTpSlMode');
    var buyRg = collectRuleGroupsFromDom('buy');
    var sellRg = collectRuleGroupsFromDom('sell');
    return {
      buy: {
        ruleGroups: buyRg,
        rules: flattenRuleGroups(buyRg),
        dealSize: buySize ? (buySize.value.trim() || '1') : '1',
        takeProfit: buyTp && buyTp.value.trim() ? buyTp.value.trim() : null,
        stopLoss: buySl && buySl.value.trim() ? buySl.value.trim() : null,
        tpSlMode: buyMode ? buyMode.value : 'rate'
      },
      sell: {
        ruleGroups: sellRg,
        rules: flattenRuleGroups(sellRg),
        dealSize: sellSize ? (sellSize.value.trim() || '1') : '1',
        takeProfit: sellTp && sellTp.value.trim() ? sellTp.value.trim() : null,
        stopLoss: sellSl && sellSl.value.trim() ? sellSl.value.trim() : null,
        tpSlMode: sellMode ? sellMode.value : 'rate'
      }
    };
  }

  function getConfig() {
    var runSets = [];
    if (rulesRunningBuy) runSets.push('BUY');
    if (rulesRunningSell) runSets.push('SELL');
    return {
      running: rulesRunningBuy || rulesRunningSell,
      confirmBeforePlaceBuy: confirmCheck ? confirmCheck.checked : true,
      confirmBeforePlaceSell: confirmCheckSell ? confirmCheckSell.checked : true,
      ruleSets: getRuleSetsFromDom(),
      runRuleSets: runSets,
      autoStopEnabledBuy: autoStopCheck ? autoStopCheck.checked : true,
      autoStopEnabledSell: autoStopCheckSell ? autoStopCheckSell.checked : true,
      autoStopBeforeMinutesBuy: getAutoStopBeforeMinutes('buy'),
      autoStopBeforeMinutesSell: getAutoStopBeforeMinutes('sell'),
      pauseOnLossSeconds: getPauseOnLossSeconds()
    };
  }

  var pauseCountdownIntervalId = null;

  var prevRulesRunningBuyOnPause = false;
  var prevRulesRunningSellOnPause = false;
  function doPauseOnLoss(seconds) {
    if (pauseOnLossTimerId) clearTimeout(pauseOnLossTimerId);
    if (pauseCountdownIntervalId) clearInterval(pauseCountdownIntervalId);
    prevRulesRunningBuyOnPause = rulesRunningBuy;
    prevRulesRunningSellOnPause = rulesRunningSell;
    rulesRunningBuy = false;
    rulesRunningSell = false;
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
      rulesRunningBuy = prevRulesRunningBuyOnPause;
      rulesRunningSell = prevRulesRunningSellOnPause;
      if (state) state.rulesEngineRunning = rulesRunningBuy || rulesRunningSell;
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
    var containers = [rulesBuyGroupsRoot, rulesSellGroupsRoot];
    for (var c = 0; c < containers.length; c++) {
      var rulesItems = containers[c];
      if (!rulesItems) continue;
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
    var remaining = pausedUntil != null && pausedUntil > Date.now() ? Math.ceil((pausedUntil - Date.now()) / 1000) : 0;
    var statusText = remaining > 0 ? 'Paused (loss) – resuming in ' + remaining + 's' : 'Engine: Stopped';
    var statusCls = 'text-xs ' + (remaining > 0 ? 'text-amber-400 mb-2 font-medium' : 'text-slate-500 mb-2');
    var fullStatus = statusText + (sleepPreventionStatus && remaining === 0 ? ' • ' + sleepPreventionStatus : '');
    if (engineStatusEl) { engineStatusEl.textContent = fullStatus; engineStatusEl.className = statusCls; }
    if (engineStatusSellEl) { engineStatusSellEl.textContent = fullStatus; engineStatusSellEl.className = statusCls; }
      if (statusEl) statusEl.textContent = 'Manual trading enabled';
      if (statusSellEl) statusSellEl.textContent = 'Manual trading enabled';
      updateRuleStatusIndicators();
      return;
    }

    setDealEnabled(false);
    setOrderEnabledFn(false);
    setProbesBackfillEnabledFn(false);
    if (dealEngineMsg) dealEngineMsg.classList.remove('hidden');
    if (orderEngineMsg) orderEngineMsg.classList.remove('hidden');
    var buyStatus = rulesRunningBuy ? ('Engine: Running (BUY)' + (sleepPreventionStatus ? ' • ' + sleepPreventionStatus : '')) : 'Engine: Stopped';
    var sellStatus = rulesRunningSell ? ('Engine: Running (SELL)' + (sleepPreventionStatus ? ' • ' + sleepPreventionStatus : '')) : 'Engine: Stopped';
    if (engineStatusEl) { engineStatusEl.textContent = buyStatus; engineStatusEl.className = 'text-xs ' + (rulesRunningBuy ? 'text-amber-400 mb-2 font-medium' : 'text-slate-500 mb-2'); }
    if (engineStatusSellEl) { engineStatusSellEl.textContent = sellStatus; engineStatusSellEl.className = 'text-xs ' + (rulesRunningSell ? 'text-amber-400 mb-2 font-medium' : 'text-slate-500 mb-2'); }

    var ruleSets = config.ruleSets || { buy: { rules: [] }, sell: { rules: [] } };
    var runRuleSets = config.runRuleSets || ['BUY', 'SELL'];
    var runBuy = runRuleSets.indexOf('BUY') >= 0;
    var runSell = runRuleSets.indexOf('SELL') >= 0;
    var buyRules = ruleSets.buy && ruleSets.buy.rules ? ruleSets.buy.rules : [];
    var sellRules = ruleSets.sell && ruleSets.sell.rules ? ruleSets.sell.rules : [];
    var buyPass = runBuy && buyRules.length > 0 && evaluateRules(ctx, { rules: buyRules });
    var sellPass = runSell && sellRules.length > 0 && evaluateRules(ctx, { rules: sellRules });
    var triggeredSet = buyPass ? 'buy' : (sellPass ? 'sell' : null);
    var pass = !!triggeredSet;
    var blocked = hasPositionOrOrder();

    var activeBuyRules = runBuy ? buyRules : [];
    var activeSellRules = runSell ? sellRules : [];
    var allEnabledRules = activeBuyRules.filter(function (r) { return r.enabled !== false; }).concat(activeSellRules.filter(function (r) { return r.enabled !== false; }));
    if (statusEl) {
      var needsProbes = allEnabledRules.some(function (r) {
        return (r.left !== 'currentTime' && RIGHT_REF_KEYS.indexOf(r.right) >= 0) ||
          r.left === 'short.volume' || r.left === 'medium.volume' || r.left === 'long.volume' ||
          r.left === 'short.trend' || r.left === 'medium.trend' || r.left === 'long.trend' ||
          r.left === 'short.trendPct' || r.left === 'medium.trendPct' || r.left === 'long.trendPct' ||
          r.left === 'short.range' || r.left === 'medium.range' || r.left === 'long.range';
      });
      var needsPrices = allEnabledRules.some(function (r) { return r.left === 'Buy' || r.left === 'Sell'; });
      var needsNowTrend = allEnabledRules.some(function (r) { return r.left === 'now.trend'; });
      var status = 'Conditions not met';
      if ((runBuy ? buyRules : []).length === 0 && (runSell ? sellRules : []).length === 0) status = 'Add at least one rule to the selected set(s)';
      else if (allEnabledRules.length === 0) status = 'Enable at least one rule';
      else if (needsProbes && !getProbeValuesFn()) status = 'Waiting for probe data';
      else if (needsPrices && (state.currentBid == null || state.currentOffer == null)) status = 'Waiting for prices';
      else if (needsNowTrend && state.currentTrend == null) status = 'Waiting for price updates (now.trend)';
      else if (pass && blocked) status = 'Conditions met – position/order exists, no new deal';
      else if (pass && !blocked) {
        var willFireThisTick = !prevRulesPass || prevBlocked;
        status =
          (triggeredSet === 'buy' ? 'BUY' : 'SELL') +
          ' conditions met – ' +
          (willFireThisTick
            ? 'firing deal now (one shot)'
            : 'holding (no repeat until a rule fails or block clears)');
      }
      statusEl.textContent = status;
      if (statusSellEl) statusSellEl.textContent = status;
    }

    if (pass && !blocked && (!prevRulesPass || prevBlocked)) {
      var set = triggeredSet === 'buy' ? ruleSets.buy : ruleSets.sell;
      var confirm = triggeredSet === 'buy' ? config.confirmBeforePlaceBuy : config.confirmBeforePlaceSell;
      var nowMs = Date.now();
      if (nowMs - lastRulesDealAttemptMs < RULES_DEAL_ATTEMPT_COOLDOWN_MS) {
        /* skip: avoid duplicate logs / duplicate IG attempts when blocked or pass flickers */
      } else {
        lastRulesDealAttemptMs = nowMs;
        if (confirm) {
          triggerDealConfirmFn({ direction: triggeredSet === 'buy' ? 'BUY' : 'SELL', ruleSet: set });
        } else {
          placeDealDirectFn({ direction: triggeredSet === 'buy' ? 'BUY' : 'SELL', ruleSet: set });
        }
      }
    }
    if (prevRulesPass && !pass) lastRulesDealAttemptMs = 0;
    prevRulesPass = pass;
    prevBlocked = blocked;
    updateRuleStatusIndicators();
  }

  function updateToggleButton() {
    var buyText = rulesRunningBuy ? 'Stop' : 'Start';
    var sellText = rulesRunningSell ? 'Stop' : 'Start';
    var buyCls = 'px-2 py-1 rounded text-xs font-medium transition-colors ' + (rulesRunningBuy ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white');
    var sellCls = 'px-2 py-1 rounded text-xs font-medium transition-colors ' + (rulesRunningSell ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white');
    if (toggleBtn) { toggleBtn.textContent = buyText; toggleBtn.className = buyCls; toggleBtn.title = rulesRunningBuy ? 'Stop BUY rules engine' : 'Start BUY rules engine'; }
    if (toggleBtnSell) { toggleBtnSell.textContent = sellText; toggleBtnSell.className = sellCls; toggleBtnSell.title = rulesRunningSell ? 'Stop SELL rules engine' : 'Start SELL rules engine'; }
    setRulesEditable();
    if (state) state.rulesEngineRunning = rulesRunningBuy || rulesRunningSell;
    if (socket && typeof socket.emit === 'function') socket.emit('rules_engine_running', rulesRunningBuy || rulesRunningSell);
  }

  function setRulesEditable() {
    var buyEditable = !rulesRunningBuy;
    var sellEditable = !rulesRunningSell;
    if (rulesBuyGroupsRoot) {
      var addBuyBtns = rulesBuyGroupsRoot.querySelectorAll('[data-add-rule-group][data-rules-panel="buy"]');
      for (var ab = 0; ab < addBuyBtns.length; ab++) addBuyBtns[ab].disabled = !buyEditable;
    }
    if (rulesSellGroupsRoot) {
      var addSellBtns = rulesSellGroupsRoot.querySelectorAll('[data-add-rule-group][data-rules-panel="sell"]');
      for (var as = 0; as < addSellBtns.length; as++) addSellBtns[as].disabled = !sellEditable;
    }
    if (rulesLockedMsg) rulesLockedMsg.classList.toggle('hidden', buyEditable);
    if (rulesLockedMsgSell) rulesLockedMsgSell.classList.toggle('hidden', sellEditable);
    if (autoStopCheck) autoStopCheck.disabled = !buyEditable;
    if (autoStopCheckSell) autoStopCheckSell.disabled = !sellEditable;
    if (autoStopMinutesInput) autoStopMinutesInput.disabled = !buyEditable;
    if (autoStopMinutesInputSell) autoStopMinutesInputSell.disabled = !sellEditable;
    if (pauseOnLossInput) pauseOnLossInput.disabled = !buyEditable;
    if (pauseOnLossInputSell) pauseOnLossInputSell.disabled = !sellEditable;
    if (rulesBuyGroupsRoot) {
      var buyRows = rulesBuyGroupsRoot.querySelectorAll('[data-rule]');
      for (var i = 0; i < buyRows.length; i++) {
        var row = buyRows[i];
        var dragHandle = row.querySelector('[data-rule-drag]');
        if (dragHandle) dragHandle.draggable = buyEditable;
        var controls = row.querySelectorAll('[data-rule-enabled], [data-left], [data-op], [data-right], [data-right-fixed], [data-remove]');
        for (var j = 0; j < controls.length; j++) controls[j].disabled = !buyEditable;
      }
    }
    if (rulesSellGroupsRoot) {
      var sellRows = rulesSellGroupsRoot.querySelectorAll('[data-rule]');
      for (var si = 0; si < sellRows.length; si++) {
        var srow = sellRows[si];
        var sdrag = srow.querySelector('[data-rule-drag]');
        if (sdrag) sdrag.draggable = sellEditable;
        var scontrols = srow.querySelectorAll('[data-rule-enabled], [data-left], [data-op], [data-right], [data-right-fixed], [data-remove]');
        for (var sj = 0; sj < scontrols.length; sj++) scontrols[sj].disabled = !sellEditable;
      }
    }
    var buyInputs = ['rulesBuySize', 'rulesBuyTp', 'rulesBuySl', 'rulesBuyTpSlMode'];
    var sellInputs = ['rulesSellSize', 'rulesSellTp', 'rulesSellSl', 'rulesSellTpSlMode'];
    for (var bi = 0; bi < buyInputs.length; bi++) {
      var el = document.getElementById(buyInputs[bi]);
      if (el) el.disabled = !buyEditable;
    }
    for (var si = 0; si < sellInputs.length; si++) {
      var sel = document.getElementById(sellInputs[si]);
      if (sel) sel.disabled = !sellEditable;
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

  function bindRuleGroupDropZone(container) {
    if (!container) return;
    container.addEventListener('dragover', function (e) {
      if (!draggedRuleWrap) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    container.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!draggedRuleWrap) return;
      if (e.target && e.target.closest && e.target.closest('[data-rule]')) return;
      container.appendChild(draggedRuleWrap);
      saveRules();
      updateDealEnabled();
    });
  }

  function createRuleRow(rule, groupHint, panel) {
    var panelSide = panel === 'sell' ? 'sell' : 'buy';
    var gh = groupHint || 'other';
    var base = defaultRuleForGroup(gh, panelSide);
    if (!rule || typeof rule !== 'object' || !rule.left || !rule.op) {
      rule = base;
    } else {
      var rRight = rule.right;
      if (rule.left === 'currentTime') {
        rRight = rRight != null ? rRight : '';
      } else if (rRight === undefined || rRight === null || rRight === '') {
        rRight = base.right != null ? base.right : '';
      }
      rule = { left: rule.left, op: rule.op, right: rRight, enabled: rule.enabled !== false };
    }
    var left = rule.left || 'Buy';
    var op = rule.op || 'lte';
    var right = rule.right;
    if ((right == null || right === '') && left !== 'currentTime') {
      right = base.right != null ? base.right : '';
    }
    var enabled = rule.enabled !== false;
    var isVolumeLeft = left === 'short.volume' || left === 'medium.volume' || left === 'long.volume';
    var isTrendLeft = left === 'now.trend' || left === 'short.trend' || left === 'medium.trend' || left === 'long.trend';
    var isSentimentLeft = left === 'now.sentiment';
    var rightKey = typeof right === 'string' ? right : (right != null ? String(right) : '');
    var isFixed = rightKey !== '' && RIGHT_REF_KEYS.indexOf(rightKey) < 0 && left !== 'currentTime' && !isVolumeLeft && !isTrendLeft && !isSentimentLeft;
    var isTime = left === 'currentTime';
    var wrap = document.createElement('div');
    wrap.setAttribute('data-rule-wrap', '1');
    wrap.className = 'rounded-lg border border-slate-700 bg-slate-800/90 overflow-hidden';
    var row = document.createElement('div');
    row.className = 'rules-grid p-2 border-0 border-b border-slate-700/40';
    row.setAttribute('data-rule', '1');
    var paraphraseEl = document.createElement('p');
    paraphraseEl.setAttribute('data-rule-paraphrase', '1');
    paraphraseEl.className = 'px-2 py-1.5 text-[11px] text-slate-500 leading-snug';
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

    wrap.appendChild(row);
    wrap.appendChild(paraphraseEl);

    function refreshParaphrase() {
      var r = readRuleFromRow(row);
      if (paraphraseEl) paraphraseEl.textContent = r ? formatRuleParaphrase(r) : '';
    }

    function onChange() {
      refreshParaphrase();
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
      wrap.remove();
      saveRules();
      updateDealEnabled();
    });
    var dragHandle = row.querySelector('[data-rule-drag]');
    if (dragHandle) {
      dragHandle.draggable = true;
      dragHandle.addEventListener('dragstart', function (e) {
        draggedRuleWrap = wrap;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
        wrap.classList.add('opacity-50');
      });
      dragHandle.addEventListener('dragend', function () {
        wrap.classList.remove('opacity-50');
        draggedRuleWrap = null;
      });
    }
    row.addEventListener('dragover', function (e) {
      if (!draggedRuleWrap) return;
      var myWrap = row.parentNode;
      if (!myWrap || !myWrap.getAttribute('data-rule-wrap') || draggedRuleWrap === myWrap) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!draggedRuleWrap) return;
      var myWrap = row.parentNode;
      if (!myWrap || !myWrap.getAttribute('data-rule-wrap') || draggedRuleWrap === myWrap) return;
      myWrap.parentNode.insertBefore(draggedRuleWrap, myWrap);
      saveRules();
      updateDealEnabled();
    });
    refreshParaphrase();
    return wrap;
  }

  function saveRules() {
    var epicSelect = document.getElementById('epicSelect');
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    if (!epic) return;
    var config = getConfig();
    var persistedRuleSets = getPersistedRuleSets(config.ruleSets);
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var instruments = (cfg.ui && cfg.ui.instruments) ? { ...cfg.ui.instruments } : {};
      instruments[epic] = { ...(instruments[epic] || {}), tradingRulesRunning: config.running, rulesRunningBuy: rulesRunningBuy, rulesRunningSell: rulesRunningSell, ruleSets: persistedRuleSets, tradingRulesConfirmBeforePlaceBuy: config.confirmBeforePlaceBuy, tradingRulesConfirmBeforePlaceSell: config.confirmBeforePlaceSell, tradingRulesAutoStopEnabledBuy: config.autoStopEnabledBuy, tradingRulesAutoStopEnabledSell: config.autoStopEnabledSell, tradingRulesAutoStopBeforeMinutesBuy: config.autoStopBeforeMinutesBuy, tradingRulesAutoStopBeforeMinutesSell: config.autoStopBeforeMinutesSell, tradingRulesPauseOnLossSecondsBuy: getPauseOnLossSecondsBuy(), tradingRulesPauseOnLossSecondsSell: getPauseOnLossSecondsSell() };
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
      var confirmBuy = inst.tradingRulesConfirmBeforePlaceBuy != null ? inst.tradingRulesConfirmBeforePlaceBuy !== false : (inst.tradingRulesConfirmBeforePlace != null ? inst.tradingRulesConfirmBeforePlace !== false : ui.tradingRulesConfirmBeforePlace !== false);
      var confirmSell = inst.tradingRulesConfirmBeforePlaceSell != null ? inst.tradingRulesConfirmBeforePlaceSell !== false : (inst.tradingRulesConfirmBeforePlace != null ? inst.tradingRulesConfirmBeforePlace !== false : ui.tradingRulesConfirmBeforePlace !== false);
      var autoStopBuy = inst.tradingRulesAutoStopEnabledBuy != null ? inst.tradingRulesAutoStopEnabledBuy !== false : (inst.tradingRulesAutoStopEnabled != null ? inst.tradingRulesAutoStopEnabled !== false : ui.tradingRulesAutoStopEnabled !== false);
      var autoStopSell = inst.tradingRulesAutoStopEnabledSell != null ? inst.tradingRulesAutoStopEnabledSell !== false : (inst.tradingRulesAutoStopEnabled != null ? inst.tradingRulesAutoStopEnabled !== false : ui.tradingRulesAutoStopEnabled !== false);
      var autoStopMinsBuy = inst.tradingRulesAutoStopBeforeMinutesBuy != null ? inst.tradingRulesAutoStopBeforeMinutesBuy : (inst.tradingRulesAutoStopBeforeMinutes != null ? inst.tradingRulesAutoStopBeforeMinutes : ui.tradingRulesAutoStopBeforeMinutes);
      var autoStopMinsSell = inst.tradingRulesAutoStopBeforeMinutesSell != null ? inst.tradingRulesAutoStopBeforeMinutesSell : (inst.tradingRulesAutoStopBeforeMinutes != null ? inst.tradingRulesAutoStopBeforeMinutes : ui.tradingRulesAutoStopBeforeMinutes);
      var pauseBuy = inst.tradingRulesPauseOnLossSecondsBuy != null ? inst.tradingRulesPauseOnLossSecondsBuy : (inst.tradingRulesPauseOnLossSeconds != null ? inst.tradingRulesPauseOnLossSeconds : (ui.tradingRulesPauseOnLossSeconds != null ? ui.tradingRulesPauseOnLossSeconds : 0));
      var pauseSell = inst.tradingRulesPauseOnLossSecondsSell != null ? inst.tradingRulesPauseOnLossSecondsSell : (inst.tradingRulesPauseOnLossSeconds != null ? inst.tradingRulesPauseOnLossSeconds : (ui.tradingRulesPauseOnLossSeconds != null ? ui.tradingRulesPauseOnLossSeconds : 0));
      var ruleSets = inst.ruleSets || ui.ruleSets;
      var prevRunning = inst.tradingRulesRunning || ui.tradingRulesRunning;
      rulesRunningBuy = inst.rulesRunningBuy != null ? inst.rulesRunningBuy : (ui.rulesRunningBuy != null ? ui.rulesRunningBuy : (prevRunning ? true : false));
      rulesRunningSell = inst.rulesRunningSell != null ? inst.rulesRunningSell : (ui.rulesRunningSell != null ? ui.rulesRunningSell : (prevRunning ? true : false));
      if (!ruleSets && (inst.tradingRules || ui.tradingRules)) {
        var legacyRules = inst.tradingRules || ui.tradingRules || [];
        var dealDir = (inst.dealDirection || ui.dealDirection || 'BUY').toUpperCase();
        ruleSets = {
          buy: dealDir === 'BUY' ? { rules: legacyRules, dealSize: inst.dealSize || ui.dealSize || '1', takeProfit: inst.dealTakeProfit || ui.dealTakeProfit || null, stopLoss: inst.dealStopLoss || ui.dealStopLoss || null, tpSlMode: inst.dealTpSlMode || ui.dealTpSlMode || 'rate' } : { rules: [], dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate' },
          sell: dealDir === 'SELL' ? { rules: legacyRules, dealSize: inst.dealSize || ui.dealSize || '1', takeProfit: inst.dealTakeProfit || ui.dealTakeProfit || null, stopLoss: inst.dealStopLoss || ui.dealStopLoss || null, tpSlMode: inst.dealTpSlMode || ui.dealTpSlMode || 'rate' } : { rules: [], dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate' }
        };
      }
      if (!ruleSets) ruleSets = { buy: { rules: [], dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate' }, sell: { rules: [], dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate' } };
      if (state) state.rulesEngineRunning = rulesRunningBuy || rulesRunningSell;
      if (confirmCheck) confirmCheck.checked = confirmBuy;
      if (confirmCheckSell) confirmCheckSell.checked = confirmSell;
      if (autoStopCheck) autoStopCheck.checked = autoStopBuy;
      if (autoStopCheckSell) autoStopCheckSell.checked = autoStopSell;
      if (autoStopMinutesInput) {
        var minsBuy = (autoStopMinsBuy != null && !isNaN(autoStopMinsBuy) && autoStopMinsBuy >= 0) ? Math.min(autoStopMinsBuy, 1440) : 60;
        autoStopMinutesInput.value = minsBuy;
      }
      if (autoStopMinutesInputSell) {
        var minsSell = (autoStopMinsSell != null && !isNaN(autoStopMinsSell) && autoStopMinsSell >= 0) ? Math.min(autoStopMinsSell, 1440) : 60;
        autoStopMinutesInputSell.value = minsSell;
      }
      if (pauseOnLossInput) {
        var secsBuy = (pauseBuy != null && !isNaN(pauseBuy) && pauseBuy >= 0) ? Math.min(pauseBuy, 86400) : 0;
        pauseOnLossInput.value = secsBuy;
      }
      if (pauseOnLossInputSell) {
        var secsSell = (pauseSell != null && !isNaN(pauseSell) && pauseSell >= 0) ? Math.min(pauseSell, 86400) : 0;
        pauseOnLossInputSell.value = secsSell;
      }
      for (var gi = 0; gi < RULE_GROUP_ORDER.length; gi++) {
        var gk = RULE_GROUP_ORDER[gi];
        var buyBox = document.getElementById(groupContainerId('buy', gk));
        var sellBox = document.getElementById(groupContainerId('sell', gk));
        if (buyBox) buyBox.innerHTML = '';
        if (sellBox) sellBox.innerHTML = '';
      }
      var buyRg = normalizeRuleGroupsFromSaved(ruleSets.buy);
      var sellRg = normalizeRuleGroupsFromSaved(ruleSets.sell);
      for (var gix = 0; gix < RULE_GROUP_ORDER.length; gix++) {
        var gkey = RULE_GROUP_ORDER[gix];
        var buyEl = document.getElementById(groupContainerId('buy', gkey));
        var sellEl = document.getElementById(groupContainerId('sell', gkey));
        var blist = buyRg[gkey] || [];
        var slist = sellRg[gkey] || [];
        for (var bx = 0; bx < blist.length; bx++) {
          var br = blist[bx];
          if (br && br.left && br.op && buyEl) buyEl.appendChild(createRuleRow(br, gkey, 'buy'));
        }
        for (var sx = 0; sx < slist.length; sx++) {
          var sr = slist[sx];
          if (sr && sr.left && sr.op && sellEl) sellEl.appendChild(createRuleRow(sr, gkey, 'sell'));
        }
      }
      var bid = document.getElementById('rulesBuySize');
      var btp = document.getElementById('rulesBuyTp');
      var bsl = document.getElementById('rulesBuySl');
      var bmode = document.getElementById('rulesBuyTpSlMode');
      var sid = document.getElementById('rulesSellSize');
      var stp = document.getElementById('rulesSellTp');
      var ssl = document.getElementById('rulesSellSl');
      var smode = document.getElementById('rulesSellTpSlMode');
      if (bid && ruleSets.buy) bid.value = ruleSets.buy.dealSize || '1';
      if (btp && ruleSets.buy) btp.value = ruleSets.buy.takeProfit || '';
      if (bsl && ruleSets.buy) bsl.value = ruleSets.buy.stopLoss || '';
      if (bmode && ruleSets.buy) bmode.value = ruleSets.buy.tpSlMode || 'rate';
      if (sid && ruleSets.sell) sid.value = ruleSets.sell.dealSize || '1';
      if (stp && ruleSets.sell) stp.value = ruleSets.sell.takeProfit || '';
      if (ssl && ruleSets.sell) ssl.value = ruleSets.sell.stopLoss || '';
      if (smode && ruleSets.sell) smode.value = ruleSets.sell.tpSlMode || 'rate';
      updateToggleButton();
      if (rulesRunningBuy || rulesRunningSell) startAutoStopTimer();
      else clearAutoStopTimer();
      updateEngineState();
      updateRulesEstTpSlDisplay();
    }).catch(function () { updateEngineState(); });
  }

  function doToggleBuy() {
    if (pausedUntil != null) {
      pausedUntil = null;
      if (pauseOnLossTimerId) { clearTimeout(pauseOnLossTimerId); pauseOnLossTimerId = null; }
      if (pauseCountdownIntervalId) { clearInterval(pauseCountdownIntervalId); pauseCountdownIntervalId = null; }
    }
    rulesRunningBuy = !rulesRunningBuy;
    if (rulesRunningBuy || rulesRunningSell) startAutoStopTimer();
    else clearAutoStopTimer();
    updateToggleButton();
    saveRules();
    updateDealEnabled();
  }
  function doToggleSell() {
    if (pausedUntil != null) {
      pausedUntil = null;
      if (pauseOnLossTimerId) { clearTimeout(pauseOnLossTimerId); pauseOnLossTimerId = null; }
      if (pauseCountdownIntervalId) { clearInterval(pauseCountdownIntervalId); pauseCountdownIntervalId = null; }
    }
    rulesRunningSell = !rulesRunningSell;
    if (rulesRunningBuy || rulesRunningSell) startAutoStopTimer();
    else clearAutoStopTimer();
    updateToggleButton();
    saveRules();
    updateDealEnabled();
  }
  if (toggleBtn) toggleBtn.addEventListener('click', doToggleBuy);
  if (toggleBtnSell) toggleBtnSell.addEventListener('click', doToggleSell);
  if (confirmCheck) confirmCheck.addEventListener('change', saveRules);
  if (confirmCheckSell) confirmCheckSell.addEventListener('change', saveRules);
  if (autoStopCheck) {
    autoStopCheck.addEventListener('change', function () {
      saveRules();
      updateAutoStopDisplay();
    });
  }
  if (autoStopCheckSell) {
    autoStopCheckSell.addEventListener('change', function () {
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
  if (autoStopMinutesInputSell) {
    autoStopMinutesInputSell.addEventListener('change', function () {
      saveRules();
      updateAutoStopDisplay();
    });
    autoStopMinutesInputSell.addEventListener('input', updateAutoStopDisplay);
  }
  if (pauseOnLossInput) pauseOnLossInput.addEventListener('change', saveRules);
  if (pauseOnLossInputSell) pauseOnLossInputSell.addEventListener('change', saveRules);
  function wireRulesAddButtons(root, panel) {
    if (!root) return;
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var btn = t.closest('[data-add-rule-group]');
      if (!btn || btn.getAttribute('data-rules-panel') !== panel) return;
      var grp = btn.getAttribute('data-add-rule-group');
      if (!grp) return;
      var box = document.getElementById(groupContainerId(panel, grp));
      if (box) box.appendChild(createRuleRow({}, grp, panel));
      saveRules();
      updateDealEnabled();
    });
  }
  wireRulesAddButtons(rulesBuyGroupsRoot, 'buy');
  wireRulesAddButtons(rulesSellGroupsRoot, 'sell');
  for (var bdz = 0; bdz < RULE_GROUP_ORDER.length; bdz++) {
    var gdz = RULE_GROUP_ORDER[bdz];
    bindRuleGroupDropZone(document.getElementById(groupContainerId('buy', gdz)));
    bindRuleGroupDropZone(document.getElementById(groupContainerId('sell', gdz)));
  }

  socket.on('disconnect', function () {
    rulesRunningBuy = false;
    rulesRunningSell = false;
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
    if (seconds > 0 && (rulesRunningBuy || rulesRunningSell)) doPauseOnLoss(seconds);
  });

  socket.on('positions', function () {
    updateEngineState();
  });
  socket.on('working_orders', updateEngineState);
  socket.on('marketDetails', function () {
    setTimeout(updateAutoStopDisplay, 0);
    setTimeout(updateDealEnabled, 0);
    setTimeout(updateRulesEstTpSlDisplay, 0);
  });
  socket.on('price_update', function () {
    setTimeout(updateRuleStatusIndicators, 0);
    setTimeout(updateRulesEstTpSlDisplay, 0);
  });

  socket.on('sleep_prevention_status', function (msg) {
    sleepPreventionStatus = msg || null;
    var remaining = pausedUntil != null && pausedUntil > Date.now() ? Math.ceil((pausedUntil - Date.now()) / 1000) : 0;
    if (remaining > 0) {
      var pauseStatus = 'Paused (loss) – resuming in ' + remaining + 's' + (sleepPreventionStatus ? ' • ' + sleepPreventionStatus : '');
      if (engineStatusEl) engineStatusEl.textContent = pauseStatus;
      if (engineStatusSellEl) engineStatusSellEl.textContent = pauseStatus;
    } else {
      var buyStatus = rulesRunningBuy ? ('Engine: Running (BUY)' + (sleepPreventionStatus ? ' • ' + sleepPreventionStatus : '')) : 'Engine: Stopped';
      var sellStatus = rulesRunningSell ? ('Engine: Running (SELL)' + (sleepPreventionStatus ? ' • ' + sleepPreventionStatus : '')) : 'Engine: Stopped';
      if (engineStatusEl) engineStatusEl.textContent = buyStatus;
      if (engineStatusSellEl) engineStatusSellEl.textContent = sellStatus;
    }
  });

  loadRules();
  updateAutoStopDisplay();
  updateRulesEstTpSlDisplay();
  function persistRulesTpSlUi() {
    updateRulesEstTpSlDisplay();
    saveRules();
  }
  ['rulesBuySize', 'rulesBuyTp', 'rulesBuySl', 'rulesBuyTpSlMode', 'rulesSellSize', 'rulesSellTp', 'rulesSellSl', 'rulesSellTpSlMode'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', persistRulesTpSlUi);
      if (id !== 'rulesBuyTpSlMode' && id !== 'rulesSellTpSlMode') el.addEventListener('input', persistRulesTpSlUi);
    }
  });

  return {
    setBaseEnabled: function (enabled) {
      baseEnabled = !!enabled;
      updateDealEnabled();
    },
    updateDealEnabled: updateDealEnabled,
    setTradingRulesPanelEnabled: function (enabled) {
      var buyPanel = document.getElementById('tradingRulesBuyPanel');
      var sellPanel = document.getElementById('tradingRulesSellPanel');
      if (buyPanel) buyPanel.classList.toggle('hidden', !enabled);
      if (sellPanel) sellPanel.classList.toggle('hidden', !enabled);
    },
    loadRules: loadRules
  };
}
