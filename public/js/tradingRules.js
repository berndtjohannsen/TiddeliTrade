/**
 * Trading rules – [live] [op] [ref] in the row; engine semantics unchanged (left = live, right = reference).
 * UI groups rows by probe horizon (short / medium / long / other); config persists ruleGroups. Paraphrase line = probe-first wording when live is Buy/Sell vs a probe ref.
 */
import { formatTimeWithTz, formatMoney } from './utils.js';
import { state } from './state.js';
import {
  applyDynamicTpFromConfig,
  applyDynamicTpUiState,
  isDynamicTpEnabled,
  isDynamicTpEnabledForDirection,
  readDynamicSlScope,
  rulesBuyDynamicTpConfigPayload,
  rulesSellDynamicTpConfigPayload,
  syncDynamicTpUi,
  updateDynamicTpStatusDisplay,
  writeRulesDynamicSlScope
} from './dynamicTpUi.js';

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
  { value: 'short.period_start', label: 'short period start' },
  { value: 'medium.min', label: 'medium.min' },
  { value: 'medium.avg', label: 'medium.avg' },
  { value: 'medium.max', label: 'medium.max' },
  { value: 'medium.range', label: 'medium.range' },
  { value: 'medium.trendPct', label: 'medium.trendPct' },
  { value: 'medium.volume', label: 'medium.volume' },
  { value: 'medium.period_start', label: 'medium period start' },
  { value: 'long.min', label: 'long.min' },
  { value: 'long.avg', label: 'long.avg' },
  { value: 'long.max', label: 'long.max' },
  { value: 'long.range', label: 'long.range' },
  { value: 'long.trendPct', label: 'long.trendPct' },
  { value: 'long.volume', label: 'long.volume' },
  { value: 'long.period_start', label: 'long period start' },
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

/** When set, Research backtest uses embedded rules from a loaded profile (Trade tab unchanged). */
var activeBacktestStrategyOverride = null;
/** When set, Research backtest uses embedded engine controls from a loaded profile. */
var activeBacktestEngineControlsOverride = null;

export function setActiveBacktestStrategyOverride(strategy) {
  activeBacktestStrategyOverride = strategy || null;
}

export function getActiveBacktestStrategyOverride() {
  return activeBacktestStrategyOverride;
}

export function setActiveBacktestEngineControlsOverride(controls) {
  activeBacktestEngineControlsOverride = controls || null;
}

export function getActiveBacktestEngineControlsOverride() {
  return activeBacktestEngineControlsOverride;
}

function cloneRuleGroups(rg) {
  var out = { short: [], medium: [], long: [], other: [] };
  for (var i = 0; i < RULE_GROUP_ORDER.length; i++) {
    var k = RULE_GROUP_ORDER[i];
    var arr = rg && rg[k] ? rg[k] : [];
    out[k] = arr.map(function (r) {
      return { left: r.left, op: r.op, right: r.right, enabled: r.enabled !== false };
    });
  }
  return out;
}

export function captureBacktestStrategySnapshot() {
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
  var shortEl = document.getElementById('probeShortPeriod');
  var mediumEl = document.getElementById('probeMediumPeriod');
  var longEl = document.getElementById('probeLongPeriod');
  var short = parseInt(shortEl && shortEl.value, 10);
  var medium = parseInt(mediumEl && mediumEl.value, 10);
  var long = parseInt(longEl && longEl.value, 10);
  var dslBuy = readDynamicSlScope('buy');
  var dslSell = readDynamicSlScope('sell');
  return {
    ruleSets: {
      buy: {
        ruleGroups: cloneRuleGroups(buyRg),
        dealSize: buySize ? (buySize.value.trim() || '1') : '1',
        takeProfit: buyTp && buyTp.value.trim() ? buyTp.value.trim() : null,
        stopLoss: buySl && buySl.value.trim() ? buySl.value.trim() : null,
        tpSlMode: buyMode ? buyMode.value : 'rate'
      },
      sell: {
        ruleGroups: cloneRuleGroups(sellRg),
        dealSize: sellSize ? (sellSize.value.trim() || '1') : '1',
        takeProfit: sellTp && sellTp.value.trim() ? sellTp.value.trim() : null,
        stopLoss: sellSl && sellSl.value.trim() ? sellSl.value.trim() : null,
        tpSlMode: sellMode ? sellMode.value : 'rate'
      }
    },
    dynamicSl: {
      buy: { enabled: dslBuy.enabled, trigger: dslBuy.trigger || null, lock: dslBuy.lock || null },
      sell: { enabled: dslSell.enabled, trigger: dslSell.trigger || null, lock: dslSell.lock || null }
    },
    probeShortMinutes: isNaN(short) || short < 1 ? 5 : Math.min(short, 1440),
    probeMediumMinutes: isNaN(medium) || medium < 1 ? 60 : Math.min(Math.max(medium, 1), 10080),
    probeLongMinutes: (isNaN(long) || long < 1 ? 24 : Math.min(long, 720)) * 60
  };
}

export function captureAnalyseOptionsFromDom(epic) {
  var backtestBuy = document.getElementById('testRulesBacktestBuy');
  var backtestSell = document.getElementById('testRulesBacktestSell');
  var backtestRuleSets = [];
  if (backtestBuy && backtestBuy.checked) backtestRuleSets.push('BUY');
  if (backtestSell && backtestSell.checked) backtestRuleSets.push('SELL');
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
    if (epic && itemEpic && itemEpic !== epic) continue;
    selectedDays.push(day);
  }
  return {
    selectedDays: selectedDays.length > 0 ? selectedDays : null,
    fromDate: selectedDays.length > 0 ? null : fromDate,
    toDate: selectedDays.length > 0 ? null : toDate,
    intradayOnly: intradayOnly,
    backtestRuleSets: backtestRuleSets.length > 0 ? backtestRuleSets : ['BUY', 'SELL']
  };
}

function sideToRuleSetPayload(side, direction, dsl) {
  var rg = side.ruleGroups || { short: [], medium: [], long: [], other: [] };
  return {
    direction: direction,
    rules: flattenRuleGroups(rg),
    dealSize: side.dealSize || '1',
    takeProfit: dsl && dsl.enabled ? null : (side.takeProfit || null),
    stopLoss: side.stopLoss || null,
    tpSlMode: side.tpSlMode || 'rate'
  };
}

export function buildPayloadFromStrategy(strategy, analyseOptions) {
  var dslBuy = strategy.dynamicSl && strategy.dynamicSl.buy;
  var dslSell = strategy.dynamicSl && strategy.dynamicSl.sell;
  return {
    ruleSets: [
      sideToRuleSetPayload(strategy.ruleSets.buy, 'BUY', dslBuy),
      sideToRuleSetPayload(strategy.ruleSets.sell, 'SELL', dslSell)
    ],
    backtestRuleSets: analyseOptions.backtestRuleSets,
    probeShortMinutes: strategy.probeShortMinutes,
    probeMediumMinutes: strategy.probeMediumMinutes,
    probeLongMinutes: strategy.probeLongMinutes,
    dynamicSlBuy: dslBuy || { enabled: false },
    dynamicSlSell: dslSell || { enabled: false }
  };
}

/** Engine safety settings from Trade tab DOM (used by backtest analyse and profile save). */
export function captureEngineControlsSnapshot() {
  return readEngineControlsFromDom();
}

function parseMaxParallelDealsInput(input) {
  if (!input || !input.value.trim()) return 1;
  var n = parseInt(input.value, 10);
  if (isNaN(n) || n < 1) return 1;
  return Math.min(n, 10);
}

function parseMaxRunDaysInput(input) {
  if (!input || !input.value.trim()) return 0;
  var n = parseInt(input.value, 10);
  if (isNaN(n) || n < 1) return 0;
  return Math.min(n, 365);
}

function parseStopAfterConsecutiveLossesInput(input) {
  if (!input || !input.value.trim()) return 0;
  var n = parseInt(input.value, 10);
  if (isNaN(n) || n < 1) return 0;
  return Math.min(n, 20);
}

/** Merge saved streak with legacy stop-after-any-loss flag (treated as 1). */
function resolveStopAfterConsecutiveLossesFromSaved(explicit, legacyStopAfterAnyLoss) {
  var n = typeof explicit === 'number' && !isNaN(explicit) ? explicit : 0;
  if (n >= 1) return Math.min(n, 20);
  return legacyStopAfterAnyLoss ? 1 : 0;
}

/** Write engine controls snapshot onto Trade tab DOM. */
export function applyEngineControlsSnapshot(controls) {
  if (!controls) return;
  var pauseOnLossInput = document.getElementById('tradingRulesPauseOnLoss');
  var maxParallelDealsInput = document.getElementById('tradingRulesMaxParallelDeals');
  var stopAfterConsecutiveInput = document.getElementById('tradingRulesStopAfterConsecutiveLosses');
  var scheduleStart = document.getElementById('tradingRulesScheduleStart');
  var scheduleStop = document.getElementById('tradingRulesScheduleStop');
  var scheduleRepeat = document.getElementById('tradingRulesScheduleRepeatDaily');
  var pauseSec = controls.pauseOnLossSecondsBuy != null
    ? controls.pauseOnLossSecondsBuy
    : (controls.pauseOnLossSecondsSell != null ? controls.pauseOnLossSecondsSell : 0);
  if (pauseOnLossInput) pauseOnLossInput.value = pauseSec > 0 ? String(pauseSec) : '';
  if (maxParallelDealsInput) {
    var mp = controls.maxParallelDeals != null ? controls.maxParallelDeals : 1;
    maxParallelDealsInput.value = String(Math.max(1, Math.min(10, mp)));
  }
  if (stopAfterConsecutiveInput) {
    var legacyStop = !!(controls.stopAfterLossBuy || controls.stopAfterLossSell);
    var streak = resolveStopAfterConsecutiveLossesFromSaved(controls.stopAfterConsecutiveLosses, legacyStop);
    stopAfterConsecutiveInput.value = streak > 0 ? String(streak) : '';
  }
  if (scheduleStart) scheduleStart.value = controls.scheduleStartTime || '';
  if (scheduleStop) scheduleStop.value = controls.scheduleStopTime || '';
  if (scheduleRepeat) scheduleRepeat.checked = controls.scheduleRepeatDaily !== false;
  var forcedClose = document.getElementById('tradingRulesForcedClose');
  var maxRunDaysInput = document.getElementById('tradingRulesMaxRunDays');
  if (forcedClose) forcedClose.value = controls.forcedCloseTime || '';
  if (maxRunDaysInput) {
    maxRunDaysInput.value = controls.maxRunDays != null && controls.maxRunDays > 0 ? String(controls.maxRunDays) : '';
  }
  state.rulesForcedCloseTime = controls.forcedCloseTime || '';
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent('tiddeli:rules-schedule-changed'));
  }
}

function readEngineControlsFromDom() {
  var pauseOnLossInput = document.getElementById('tradingRulesPauseOnLoss');
  var maxParallelDealsInput = document.getElementById('tradingRulesMaxParallelDeals');
  var stopAfterConsecutiveInput = document.getElementById('tradingRulesStopAfterConsecutiveLosses');
  var scheduleStart = document.getElementById('tradingRulesScheduleStart');
  var scheduleStop = document.getElementById('tradingRulesScheduleStop');
  var scheduleRepeat = document.getElementById('tradingRulesScheduleRepeatDaily');
  var forcedClose = document.getElementById('tradingRulesForcedClose');
  var maxRunDaysInput = document.getElementById('tradingRulesMaxRunDays');
  function parsePause(input) {
    if (!input || !input.value.trim()) return 0;
    var n = parseInt(input.value, 10);
    return !isNaN(n) && n >= 0 ? Math.min(n, 86400) : 0;
  }
  var pauseSec = parsePause(pauseOnLossInput);
  return {
    stopAfterConsecutiveLosses: parseStopAfterConsecutiveLossesInput(stopAfterConsecutiveInput),
    pauseOnLossSecondsBuy: pauseSec,
    pauseOnLossSecondsSell: pauseSec,
    maxParallelDeals: parseMaxParallelDealsInput(maxParallelDealsInput),
    scheduleStartTime: scheduleStart && scheduleStart.value ? scheduleStart.value : '',
    scheduleStopTime: scheduleStop && scheduleStop.value ? scheduleStop.value : '',
    scheduleRepeatDaily: scheduleRepeat ? scheduleRepeat.checked !== false : true,
    forcedCloseTime: forcedClose && forcedClose.value ? forcedClose.value : '',
    maxRunDays: parseMaxRunDaysInput(maxRunDaysInput),
    scheduleTimezone: typeof Intl !== 'undefined' && Intl.DateTimeFormat
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined,
    scheduleActiveDate: (function () {
      var repeatEl = document.getElementById('tradingRulesScheduleRepeatDaily');
      var startEl = document.getElementById('tradingRulesScheduleStart');
      var stopEl = document.getElementById('tradingRulesScheduleStop');
      var hasLimits = (startEl && startEl.value) || (stopEl && stopEl.value);
      if (repeatEl && repeatEl.checked) return '';
      if (!hasLimits) return '';
      var d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })()
  };
}

/** Returns rule sets and probe periods from DOM for backtest. Used by Test rules panel. */
export function getRulesForBacktest() {
  var engineControls = activeBacktestEngineControlsOverride || readEngineControlsFromDom();
  if (activeBacktestStrategyOverride) {
    var opts = captureAnalyseOptionsFromDom(null);
    var built = buildPayloadFromStrategy(activeBacktestStrategyOverride, opts);
    return {
      rules: built.ruleSets[0].rules.concat(built.ruleSets[1].rules),
      ruleSets: built.ruleSets,
      backtestRuleSets: built.backtestRuleSets,
      probeShortMinutes: built.probeShortMinutes,
      probeMediumMinutes: built.probeMediumMinutes,
      probeLongMinutes: built.probeLongMinutes,
      dynamicSlBuy: built.dynamicSlBuy,
      dynamicSlSell: built.dynamicSlSell,
      engineControls: engineControls
    };
  }
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
    { direction: 'BUY', rules: flattenRuleGroups(buyRg), dealSize: buySize ? (buySize.value.trim() || '1') : '1', takeProfit: isDynamicTpEnabled('buy') ? null : (buyTp && buyTp.value.trim() ? buyTp.value.trim() : null), stopLoss: buySl && buySl.value.trim() ? buySl.value.trim() : null, tpSlMode: buyMode ? buyMode.value : 'rate' },
    { direction: 'SELL', rules: flattenRuleGroups(sellRg), dealSize: sellSize ? (sellSize.value.trim() || '1') : '1', takeProfit: isDynamicTpEnabled('sell') ? null : (sellTp && sellTp.value.trim() ? sellTp.value.trim() : null), stopLoss: sellSl && sellSl.value.trim() ? sellSl.value.trim() : null, tpSlMode: sellMode ? sellMode.value : 'rate' }
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
    probeLongMinutes: (isNaN(long) || long < 1 ? 24 : Math.min(long, 720)) * 60,
    dynamicSlBuy: { enabled: isDynamicTpEnabled('buy'), trigger: readDynamicSlScope('buy').trigger, lock: readDynamicSlScope('buy').lock },
    dynamicSlSell: { enabled: isDynamicTpEnabled('sell'), trigger: readDynamicSlScope('sell').trigger, lock: readDynamicSlScope('sell').lock },
    engineControls: engineControls
  };
}

export function initTradingRules(socket, state, setDealEnabled, setOrderEnabled, setProbesPanelEnabled, setProbesBackfillEnabled, setProbesSettingsLocked, getProbeValues, triggerDealConfirm, placeDealDirect, log) {
  var toggleBtn = document.getElementById('tradingRulesToggle');
  var confirmCheck = document.getElementById('tradingRulesConfirmBeforePlace');
  var rulesBuyGroupsRoot = document.getElementById('tradingRulesBuyGroups');
  var rulesSellGroupsRoot = document.getElementById('tradingRulesSellGroups');
  var statusEl = document.getElementById('tradingRulesStatus');
  var statusSellEl = document.getElementById('tradingRulesStatusSell');
  var engineStatusEl = document.getElementById('tradingRulesEngineStatus');
  var rulesNoProbesModal = document.getElementById('rulesNoProbesModal');
  var rulesNoProbesCancel = document.getElementById('rulesNoProbesCancel');
  var rulesNoProbesRulesOnly = document.getElementById('rulesNoProbesRulesOnly');
  var rulesNoProbesWithProbes = document.getElementById('rulesNoProbesWithProbes');
  var rulesLockedMsg = document.getElementById('tradingRulesLockedMsg');
  var rulesLockedMsgBuy = document.getElementById('tradingRulesLockedMsgBuy');
  var rulesLockedMsgSell = document.getElementById('tradingRulesLockedMsgSell');
  var dealEngineMsg = document.getElementById('dealEngineActiveMsg');
  var orderEngineMsg = document.getElementById('orderEngineActiveMsg');
  var pauseOnLossInput = document.getElementById('tradingRulesPauseOnLoss');
  var maxParallelDealsInput = document.getElementById('tradingRulesMaxParallelDeals');
  var stopAfterConsecutiveInput = document.getElementById('tradingRulesStopAfterConsecutiveLosses');
  var scheduleStartInput = document.getElementById('tradingRulesScheduleStart');
  var scheduleStopInput = document.getElementById('tradingRulesScheduleStop');
  var scheduleRepeatCheck = document.getElementById('tradingRulesScheduleRepeatDaily');
  var forcedCloseInput = document.getElementById('tradingRulesForcedClose');
  var maxRunDaysInput = document.getElementById('tradingRulesMaxRunDays');
  var scheduleStatusEl = document.getElementById('tradingRulesScheduleStatus');
  var tradeViewRoot = document.getElementById('tradeViewRoot');
  var tradeManualSection = document.getElementById('tradeManualSection');
  var sessionBanner = document.getElementById('tradeSessionStatusBanner');
  var sessionStatusDot = document.getElementById('tradeSessionStatusDot');
  var sessionRulesLabel = document.getElementById('tradeSessionRulesLabel');
  var sessionRulesText = document.getElementById('tradeSessionRulesText');
  var navRulesBadge = document.getElementById('appNavTradeRulesBadge');
  var rulesStartModal = document.getElementById('rulesStartModal');
  var rulesStartModalSummary = document.getElementById('rulesStartModalSummary');
  var rulesStartModalOk = document.getElementById('rulesStartModalOk');
  var rulesStartModalCancel = document.getElementById('rulesStartModalCancel');
  var commonPanelInputs = [
    confirmCheck,
    maxParallelDealsInput,
    pauseOnLossInput,
    stopAfterConsecutiveInput,
    scheduleStartInput,
    scheduleStopInput,
    scheduleRepeatCheck,
    forcedCloseInput,
    maxRunDaysInput
  ];
  /** When repeat-daily is off, schedule applies only on this calendar day (local). */
  var scheduleActiveDate = null;
  /** Local date (YYYY-MM-DD) when the engine last entered the schedule window. */
  var scheduleLastInsideDate = null;
  /** Local date when rules forced-close sweep last ran (once per day). */
  var forcedCloseLastRunDate = null;
  /** Local date (YYYY-MM-DD) when the current rules run started — for max run days. */
  var rulesEngineStartedDate = null;
  /** dealId → 'buy' | 'sell' for deals placed by the rules engine (tracked until position closes). */
  var rulesPlacedDealIds = Object.create(null);
  var baseEnabled = false;
  var rulesEngineRunning = false;

  function hideRulesNoProbesModal() {
    if (rulesNoProbesModal) {
      rulesNoProbesModal.classList.add('hidden');
      rulesNoProbesModal.setAttribute('aria-hidden', 'true');
    }
  }

  function showRulesNoProbesModal() {
    if (rulesNoProbesModal) {
      rulesNoProbesModal.classList.remove('hidden');
      rulesNoProbesModal.setAttribute('aria-hidden', 'false');
    }
  }

  function isProbingActive() {
    return state && state.engineStatus === 'running';
  }

  function isIgLoggedInLocal() {
    var st = state && state.engineStatus ? state.engineStatus : 'ready';
    return st === 'connected' || st === 'running';
  }

  /** Manual deal/order allowed when logged in and rules engine is not running. */
  function canManualTrade() {
    if (rulesEngineRunning || isPausedOnLoss()) return false;
    return isIgLoggedInLocal();
  }

  function rulesRunningWithoutProbes() {
    return rulesEngineRunning && !isProbingActive();
  }

  function engineStatusClass(ui) {
    if (!ui) ui = getRulesUiMode();
    if (ui.key === 'paused') return 'text-xs text-sky-400 mb-2 font-medium';
    if (ui.key === 'halted-loss') return 'text-xs text-amber-400 mb-2 font-medium';
    if (ui.key === 'stopped') return 'text-xs text-slate-500 mb-2';
    if (ui.key === 'active') return 'text-xs text-emerald-400 mb-2 font-medium';
    return 'text-xs text-amber-400 mb-2 font-medium';
  }
  var buyEnabledCheck = document.getElementById('tradingRulesBuyEnabled');
  var sellEnabledCheck = document.getElementById('tradingRulesSellEnabled');
  var sleepPreventionStatus = null;
  var prevRulesPass = false;
  var prevBlocked = false;
  /** Suppress rapid re-fires when pass/blocked flicker (e.g. positions poll). */
  var RULES_DEAL_ATTEMPT_COOLDOWN_MS = 8000;
  /** Abandon rulesDealPending if confirm/submit hangs this long. */
  var RULES_DEAL_PENDING_TIMEOUT_MS = 120000;
  var lastRulesDealAttemptMs = 0;

  function getMaxParallelDeals() {
    return parseMaxParallelDealsInput(maxParallelDealsInput);
  }

  function armRulesDealPending() {
    if (!state) return false;
    state.rulesDealPending = true;
    state.rulesDealPendingSinceMs = Date.now();
    return true;
  }

  function clearRulesDealPending() {
    if (!state) return;
    state.rulesDealPending = false;
    state.rulesDealPendingSinceMs = null;
  }
  var scheduleTimerId = null;
  var pauseOnLossTimerId = null;
  var pausedUntil = null;
  var consecutiveLossCount = 0;
  /** Local calendar day (YYYY-MM-DD) for the current loss streak. */
  var lossStreakDayKey = null;
  /** Local calendar day when stop/halt was triggered; blocks new deals until next day. */
  var lossHaltedDayKey = null;
  /** Last seen local day — detects midnight rollover. */
  var lossHandlingWatchDayKey = null;
  var draggedRuleWrap = null;
  var getProbeValuesFn = getProbeValues || function () { return null; };
  var triggerDealConfirmFn = typeof triggerDealConfirm === 'function' ? triggerDealConfirm : function () { return false; };
  var placeDealDirectFn = typeof placeDealDirect === 'function' ? placeDealDirect : function () { return false; };
  var setOrderEnabledFn = typeof setOrderEnabled === 'function' ? setOrderEnabled : function () {};
  var setProbesBackfillEnabledFn = typeof setProbesBackfillEnabled === 'function' ? setProbesBackfillEnabled : function () {};
  var setProbesSettingsLockedFn = typeof setProbesSettingsLocked === 'function' ? setProbesSettingsLocked : function () {};

  function getRulesBuyEnabled() {
    return !buyEnabledCheck || buyEnabledCheck.checked !== false;
  }

  function getRulesSellEnabled() {
    return !sellEnabledCheck || sellEnabledCheck.checked !== false;
  }

  function isBuyActive() {
    return rulesEngineRunning && getRulesBuyEnabled();
  }

  function isSellActive() {
    return rulesEngineRunning && getRulesSellEnabled();
  }

  function getPauseOnLossSeconds() {
    if (!pauseOnLossInput || !pauseOnLossInput.value.trim()) return 0;
    var n = parseInt(pauseOnLossInput.value, 10);
    return !isNaN(n) && n >= 0 ? Math.min(n, 86400) : 0;
  }

  function getStopAfterConsecutiveLosses() {
    return parseStopAfterConsecutiveLossesInput(stopAfterConsecutiveInput);
  }

  function localDateKey(d) {
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function closeDateKeyFromTx(tx) {
    var ts = tx && tx.timestamp ? Date.parse(tx.timestamp) : NaN;
    if (isNaN(ts)) ts = Date.now();
    return localDateKey(new Date(ts));
  }

  function syncLossStreakForCloseDay(closeDayKey) {
    if (lossStreakDayKey !== closeDayKey) {
      lossStreakDayKey = closeDayKey;
      consecutiveLossCount = 0;
    }
  }

  function isLossHaltedToday(nowMs) {
    nowMs = nowMs != null ? nowMs : Date.now();
    return lossHaltedDayKey != null && lossHaltedDayKey === localDateKey(new Date(nowMs));
  }

  function haltRulesForLossDay(closeDayKey, message) {
    lossHaltedDayKey = closeDayKey;
    var logFn = typeof log === 'function' ? log : function () {};
    logFn(message + ' Resumes next local calendar day.');
    updateDealEnabled();
  }

  /** Reset streak at midnight; halt from a prior day clears automatically. */
  function syncLossHandlingDayRollover(nowMs) {
    nowMs = nowMs != null ? nowMs : Date.now();
    var today = localDateKey(new Date(nowMs));
    if (lossHandlingWatchDayKey != null && lossHandlingWatchDayKey !== today) {
      consecutiveLossCount = 0;
      lossStreakDayKey = null;
    }
    lossHandlingWatchDayKey = today;
  }

  function parseScheduleTimeInput(input) {
    if (!input || !input.value || !input.value.trim()) return null;
    var parts = input.value.trim().split(':');
    if (parts.length < 2) return null;
    var h = parseInt(parts[0], 10);
    var min = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  function syncRulesForcedCloseToState() {
    state.rulesForcedCloseTime = forcedCloseInput && forcedCloseInput.value ? forcedCloseInput.value : '';
  }

  function syncRulesPlacedDealIdToState(dealId, direction) {
    if (!dealId) return;
    state.rulesPlacedDealIds[dealId] = direction === 'SELL' ? 'sell' : 'buy';
    rulesPlacedDealIds[dealId] = state.rulesPlacedDealIds[dealId];
  }

  function clearRulesPlacedDealIdFromState(dealId) {
    if (!dealId) return;
    delete state.rulesPlacedDealIds[dealId];
    delete rulesPlacedDealIds[dealId];
  }

  /** ISO datetime for the next rules forced-close (local HH:MM). */
  function getNextForcedCloseIso(nowMs) {
    var fcMin = parseScheduleTimeInput(forcedCloseInput);
    if (fcMin == null) return null;
    var d = new Date(nowMs);
    var nowMin = d.getHours() * 60 + d.getMinutes();
    var target = new Date(d);
    target.setSeconds(0, 0);
    target.setMilliseconds(0);
    if (nowMin >= fcMin) target.setDate(target.getDate() + 1);
    target.setHours(Math.floor(fcMin / 60), fcMin % 60, 0, 0);
    return target.toISOString();
  }

  function maybeDefaultForcedCloseFromMarket() {
    if (!forcedCloseInput || forcedCloseInput.value) return;
    if (state.is24_7Market) return;
    if (!state.defaultCloseAt) return;
    var d = new Date(state.defaultCloseAt);
    if (isNaN(d.getTime())) return;
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    forcedCloseInput.value = hh + ':' + mm;
    syncRulesForcedCloseToState();
  }

  function isPastForcedClose(nowMs) {
    var fcMin = parseScheduleTimeInput(forcedCloseInput);
    if (fcMin == null) return false;
    var nowMin = new Date(nowMs).getHours() * 60 + new Date(nowMs).getMinutes();
    return nowMin >= fcMin;
  }

  function hasForcedCloseTime() {
    return parseScheduleTimeInput(forcedCloseInput) != null;
  }

  /** Calendar days elapsed since startDateKey (day 1 = start day, local). */
  function calendarDaysSinceStart(startDateKey, nowMs) {
    if (!startDateKey) return 0;
    var parts = startDateKey.split('-');
    if (parts.length !== 3) return 0;
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return 0;
    var start = new Date(y, m, d);
    var now = new Date(nowMs);
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diff = Math.floor((today.getTime() - start.getTime()) / 86400000);
    return diff + 1;
  }

  function getMaxRunDays() {
    return parseMaxRunDaysInput(maxRunDaysInput);
  }

  function runMaxRunDaysStopIfNeeded(nowMs) {
    var maxDays = getMaxRunDays();
    if (!rulesEngineRunning || maxDays <= 0 || !rulesEngineStartedDate) return false;
    if (calendarDaysSinceStart(rulesEngineStartedDate, nowMs) <= maxDays) return false;
    stopRulesEngine('Rules engine stopped (max run days: ' + maxDays + ')');
    return true;
  }

  function runForcedCloseIfNeeded(nowMs) {
    if (!hasForcedCloseTime() || !isPastForcedClose(nowMs)) return false;
    var today = localDateKey(new Date(nowMs));
    if (forcedCloseLastRunDate === today) return false;
    forcedCloseLastRunDate = today;
    var epicSelect = document.getElementById('epicSelect');
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    if (socket && typeof socket.emit === 'function' && epic) {
      socket.emit('rules_forced_close_sweep', { epic: epic });
    }
    var logFn = typeof log === 'function' ? log : function () {};
    var fcTxt = forcedCloseInput && forcedCloseInput.value ? forcedCloseInput.value : '—';
    logFn('Rules forced close at ' + fcTxt + ' — flattening open positions');
    return true;
  }

  function hasScheduleLimits() {
    return parseScheduleTimeInput(scheduleStartInput) != null || parseScheduleTimeInput(scheduleStopInput) != null;
  }

  function formatScheduleWindowShort() {
    var startTxt = scheduleStartInput && scheduleStartInput.value ? scheduleStartInput.value : '—';
    var stopTxt = scheduleStopInput && scheduleStopInput.value ? scheduleStopInput.value : '—';
    return startTxt + '–' + stopTxt;
  }

  function isScheduleTodayOnly() {
    return scheduleRepeatCheck && !scheduleRepeatCheck.checked;
  }

  function isScheduleExpiredDay(nowMs) {
    if (!isScheduleTodayOnly() || !scheduleActiveDate) return false;
    return localDateKey(new Date(nowMs)) !== scheduleActiveDate;
  }

  function markScheduleInsideIfNeeded(nowMs) {
    if (!hasScheduleLimits() || !isWithinScheduleWindow(nowMs)) return;
    var today = localDateKey(new Date(nowMs));
    if (scheduleLastInsideDate !== today) {
      scheduleLastInsideDate = today;
      saveRules();
    }
  }

  /** Stop when today-only schedule was for a past day. */
  function runScheduleExpiredStopIfNeeded(nowMs) {
    if (!rulesEngineRunning || !isScheduleExpiredDay(nowMs)) return false;
    scheduleLastInsideDate = null;
    stopRulesEngine('Rules engine stopped (schedule expired — today only)');
    return true;
  }

  function getPauseRemainingSec() {
    if (pausedUntil == null || pausedUntil <= Date.now()) return 0;
    return Math.ceil((pausedUntil - Date.now()) / 1000);
  }

  function isPausedOnLoss() {
    return getPauseRemainingSec() > 0;
  }

  /** @returns {{ key: string, pauseSec?: number, scheduleText?: string }} */
  function getRulesUiMode() {
    if (!rulesEngineRunning) return { key: 'stopped' };
    var pauseSec = getPauseRemainingSec();
    if (pauseSec > 0) return { key: 'paused', pauseSec: pauseSec };
    if (isLossHaltedToday()) return { key: 'halted-loss' };
    if (hasScheduleLimits() && !isWithinScheduleWindow(Date.now())) {
      var now = Date.now();
      var beforeOpen = !isPastScheduleStop(now);
      var today = localDateKey(new Date(now));
      return {
        key: 'armed-schedule',
        scheduleText: formatScheduleWindowShort(),
        beforeOpen: beforeOpen,
        scheduleExpired: isScheduleExpiredDay(now),
        doneForToday: !beforeOpen && scheduleLastInsideDate === today
      };
    }
    if (rulesRunningWithoutProbes()) return { key: 'armed-probes' };
    return { key: 'active' };
  }

  function formatRulesSessionDetail(ui) {
    if (ui.key === 'paused') {
      return 'Resuming in ' + ui.pauseSec + 's after loss';
    }
    if (ui.key === 'halted-loss') {
      return 'Halted for today (loss) — resumes tomorrow';
    }
    if (ui.key === 'armed-schedule') {
      if (ui.scheduleExpired) return 'Schedule expired (today only)';
      if (ui.beforeOpen) return 'Opens ' + ui.scheduleText;
      if (ui.doneForToday) return 'No new deals until tomorrow';
      return 'Next window ' + ui.scheduleText;
    }
    if (ui.key === 'armed-probes') return 'Start probing for live prices';
    if (ui.key === 'active') return 'Monitoring conditions';
    if (canManualTrade()) return 'Manual trading available';
    if (isIgLoggedInLocal()) return 'Stop rules to trade manually';
    return 'Connect to IG to trade manually';
  }

  function formatRulesSessionLabel(ui) {
    if (ui.key === 'paused') return 'Paused';
    if (ui.key === 'halted-loss') return 'Halted';
    if (ui.key === 'active') return 'Rules Active';
    if (ui.key === 'armed-schedule' && ui.scheduleExpired) return 'Expired';
    if (ui.key === 'armed-schedule' && ui.doneForToday) return 'Done';
    if (ui.key === 'armed-schedule' && ui.beforeOpen) return 'Waiting';
    if (ui.key === 'stopped') return 'Rules Stop';
    return 'Armed';
  }

  function rulesSessionValueClass(ui) {
    if (ui.key === 'paused') return 'trade-overview-rules-label trade-overview-rules-label--paused';
    if (ui.key === 'halted-loss') return 'trade-overview-rules-label trade-overview-rules-label--done';
    if (ui.key === 'active') return 'trade-overview-rules-label trade-overview-rules-label--active';
    if (ui.key === 'stopped') return 'trade-overview-rules-label trade-overview-rules-label--stopped';
    if (ui.key === 'armed-schedule' && ui.scheduleExpired) return 'trade-overview-rules-label trade-overview-rules-label--expired';
    if (ui.key === 'armed-schedule' && ui.doneForToday) return 'trade-overview-rules-label trade-overview-rules-label--done';
    if (ui.key === 'armed-schedule' && ui.beforeOpen) return 'trade-overview-rules-label trade-overview-rules-label--waiting';
    if (ui.key === 'armed-schedule') return 'trade-overview-rules-label trade-overview-rules-label--armed';
    return 'trade-overview-rules-label trade-overview-rules-label--armed';
  }

  /** @returns {{ key: string }} */
  function getProbesUiMode() {
    var st = state && state.engineStatus ? state.engineStatus : 'ready';
    if (st === 'running') return { key: 'running' };
    if (st === 'connecting') return { key: 'connecting' };
    if (st === 'disconnected') return { key: 'disconnected' };
    return { key: 'stopped' };
  }

  function updateTradeSessionUi() {
    var ui = getRulesUiMode();
    var probesUi = getProbesUiMode();
    var sessionActive = ui.key !== 'stopped';
    var probesActive = probesUi.key === 'running' || probesUi.key === 'connecting';
    if (tradeViewRoot) {
      tradeViewRoot.classList.toggle('trade-rules-session', sessionActive);
      tradeViewRoot.classList.remove('trade-rules-mode-active', 'trade-rules-mode-paused', 'trade-rules-mode-schedule');
      if (ui.key === 'active') tradeViewRoot.classList.add('trade-rules-mode-active');
      if (ui.key === 'paused') tradeViewRoot.classList.add('trade-rules-mode-paused');
      if (ui.key === 'armed-schedule') tradeViewRoot.classList.add('trade-rules-mode-schedule');
    }
    if (tradeManualSection) tradeManualSection.classList.toggle('trade-manual-locked', rulesEngineRunning || isPausedOnLoss());
    setProbesSettingsLockedFn(sessionActive);
    if (sessionStatusDot) {
      sessionStatusDot.classList.remove(
        'trade-session-status-dot--idle',
        'trade-session-status-dot--probes',
        'trade-session-status-dot--live'
      );
      if (sessionActive) sessionStatusDot.classList.add('trade-session-status-dot--live');
      else if (probesActive || probesUi.key === 'running') sessionStatusDot.classList.add('trade-session-status-dot--probes');
      else sessionStatusDot.classList.add('trade-session-status-dot--idle');
    }
    if (sessionBanner) {
      sessionBanner.classList.remove(
        'trade-session-banner-idle',
        'trade-session-banner-probes',
        'trade-session-banner-live',
        'trade-rules-banner-active',
        'trade-rules-banner-paused',
        'trade-rules-banner-schedule',
        'trade-rules-banner-armed'
      );
      if (sessionActive) {
        sessionBanner.classList.add('trade-session-banner-live');
        if (ui.key === 'active') sessionBanner.classList.add('trade-rules-banner-active');
        else if (ui.key === 'paused') sessionBanner.classList.add('trade-rules-banner-paused');
        else if (ui.key === 'armed-schedule') sessionBanner.classList.add('trade-rules-banner-schedule');
        else sessionBanner.classList.add('trade-rules-banner-armed');
      } else if (probesUi.key === 'running' || probesUi.key === 'connecting') {
        sessionBanner.classList.add('trade-session-banner-probes');
      } else {
        sessionBanner.classList.add('trade-session-banner-idle');
      }
    }
    if (sessionRulesLabel) {
      sessionRulesLabel.textContent = formatRulesSessionLabel(ui);
      sessionRulesLabel.className = rulesSessionValueClass(ui);
    }
    if (sessionRulesText) {
      sessionRulesText.textContent = formatRulesSessionDetail(ui);
      sessionRulesText.className = 'trade-overview-rules-detail';
    }
    if (navRulesBadge) navRulesBadge.classList.toggle('hidden', !sessionActive);
  }

  function buildRulesStartModalSummary() {
    var ui = getRulesUiMode();
    var lines = [];
    lines.push('Mode: ' + (ui.key === 'active' ? 'Active' : ui.key === 'armed-schedule' ? 'Armed (outside schedule)' : ui.key === 'armed-probes' ? 'Armed (no live prices)' : 'Armed'));
    lines.push('BUY: ' + (getRulesBuyEnabled() ? 'enabled' : 'off') + ' · SELL: ' + (getRulesSellEnabled() ? 'enabled' : 'off'));
    lines.push('Probes: ' + (isProbingActive() ? 'running' : 'not running'));
    if (hasScheduleLimits()) {
      var repeatTxt = scheduleRepeatCheck && scheduleRepeatCheck.checked ? 'daily' : 'today only';
      lines.push('Schedule: ' + formatScheduleWindowShort() + ' (' + repeatTxt + ')');
      if (isScheduleExpiredDay(Date.now())) {
        lines.push('Schedule expired (today only) — update or stop rules');
      } else if (isWithinScheduleWindow(Date.now())) {
        lines.push('Within schedule now');
      } else if (!isPastScheduleStop(Date.now())) {
        lines.push('Before schedule start — no new deals until window opens');
      } else if (scheduleLastInsideDate === localDateKey(new Date())) {
        lines.push('Schedule ended for today — no new deals (engine stays armed)');
      } else {
        lines.push('Outside schedule — armed for next window, no new deals yet');
      }
    } else {
      lines.push('Schedule: no time limit');
    }
    if (hasForcedCloseTime()) {
      lines.push('Forced close: ' + (forcedCloseInput && forcedCloseInput.value ? forcedCloseInput.value : '—') + ' (local)');
    } else {
      lines.push('Forced close: none');
    }
    var maxDays = getMaxRunDays();
    if (maxDays > 0 && rulesEngineStartedDate) {
      var elapsed = calendarDaysSinceStart(rulesEngineStartedDate, Date.now());
      lines.push('Max run days: ' + maxDays + ' (day ' + elapsed + ' of ' + maxDays + ')');
    } else if (maxDays > 0) {
      lines.push('Max run days: ' + maxDays);
    } else {
      lines.push('Max run days: unlimited');
    }
    lines.push('Max parallel deals: ' + getMaxParallelDeals());
    var pauseSec = getPauseOnLossSeconds();
    if (pauseSec > 0) lines.push('Loss handling: pause ' + pauseSec + 's after each loss');
    lines.push('Loss handling: per local calendar day (close date)');
    var streak = getStopAfterConsecutiveLosses();
    if (streak > 0) {
      lines.push('Loss handling: halt for today after ' + streak + ' loss' + (streak === 1 ? '' : 'es') + ' in a row');
    } else if (pauseSec <= 0) {
      lines.push('Loss handling: none');
    }
    lines.push('Manual deal/order: disabled');
    return lines.join('\n');
  }

  function hideRulesStartModal() {
    if (rulesStartModal) {
      rulesStartModal.classList.add('hidden');
      rulesStartModal.setAttribute('aria-hidden', 'true');
    }
  }

  function showRulesStartModal() {
    if (rulesStartModalSummary) rulesStartModalSummary.textContent = buildRulesStartModalSummary();
    if (rulesStartModal) {
      rulesStartModal.classList.remove('hidden');
      rulesStartModal.setAttribute('aria-hidden', 'false');
    }
  }

  /** True when new deals may open (local time window). Blank start/stop = no limit. */
  function isWithinScheduleWindow(nowMs) {
    var startMin = parseScheduleTimeInput(scheduleStartInput);
    var stopMin = parseScheduleTimeInput(scheduleStopInput);
    if (startMin == null && stopMin == null) return true;
    if (isScheduleTodayOnly()) {
      if (scheduleActiveDate && localDateKey(new Date(nowMs)) !== scheduleActiveDate) return false;
    }
    var d = new Date(nowMs);
    var nowMin = d.getHours() * 60 + d.getMinutes();
    if (startMin != null && stopMin != null) {
      if (startMin <= stopMin) return nowMin >= startMin && nowMin < stopMin;
      return nowMin >= startMin || nowMin < stopMin;
    }
    if (startMin != null) return nowMin >= startMin;
    return nowMin < stopMin;
  }

  function updateScheduleDisplay() {
    if (!scheduleStatusEl) return;
    if (!hasScheduleLimits()) {
      scheduleStatusEl.textContent = 'No time limit';
      scheduleStatusEl.title = 'Start and stop times blank — engine may run any time when started';
      return;
    }
    var now = Date.now();
    if (isScheduleExpiredDay(now)) {
      scheduleStatusEl.textContent = 'Expired (today only · saved ' + (scheduleActiveDate || '—') + ')';
      scheduleStatusEl.title = 'Schedule was for a past day — stop rules or save new times';
      return;
    }
    var active = isWithinScheduleWindow(now);
    var startTxt = scheduleStartInput && scheduleStartInput.value ? scheduleStartInput.value : '—';
    var stopTxt = scheduleStopInput && scheduleStopInput.value ? scheduleStopInput.value : '—';
    var repeatTxt = scheduleRepeatCheck && scheduleRepeatCheck.checked ? 'daily' : 'today only';
    var beforeOpen = hasScheduleLimits() && !active && !isPastScheduleStop(now);
    scheduleStatusEl.textContent = active
      ? 'Active now (' + repeatTxt + ')'
      : (beforeOpen ? 'Opens at ' + startTxt + ' (' + repeatTxt + ')' : 'Outside window (' + startTxt + '–' + stopTxt + ')');
    scheduleStatusEl.title = active
      ? 'Within schedule — new deals allowed'
      : (beforeOpen ? 'Before schedule start — no new deals yet' : 'Outside schedule — no new deals until next window');
  }

  /** True when local time is at or after the schedule stop (not merely before start). */
  function isPastScheduleStop(nowMs) {
    var startMin = parseScheduleTimeInput(scheduleStartInput);
    var stopMin = parseScheduleTimeInput(scheduleStopInput);
    if (stopMin == null) return false;
    if (isScheduleTodayOnly()) {
      if (scheduleActiveDate && localDateKey(new Date(nowMs)) !== scheduleActiveDate) return true;
    }
    var nowMin = new Date(nowMs).getHours() * 60 + new Date(nowMs).getMinutes();
    if (startMin != null && stopMin != null && startMin <= stopMin && nowMin < startMin) return false;
    return nowMin >= stopMin;
  }

  function checkScheduleStop() {
    var nowMs = Date.now();
    syncLossHandlingDayRollover(nowMs);
    if (!rulesEngineRunning) {
      runForcedCloseIfNeeded(nowMs);
      return;
    }
    markScheduleInsideIfNeeded(nowMs);
    runForcedCloseIfNeeded(nowMs);
    if (runMaxRunDaysStopIfNeeded(nowMs)) return;
    runScheduleExpiredStopIfNeeded(nowMs);
  }

  function syncScheduleTimer() {
    if (rulesEngineRunning || isPausedOnLoss() || hasForcedCloseTime()) startScheduleTimer();
    else clearScheduleTimer();
  }

  function startScheduleTimer() {
    if (scheduleTimerId) return;
    updateScheduleDisplay();
    scheduleTimerId = setInterval(function () {
      updateScheduleDisplay();
      checkScheduleStop();
      if (rulesEngineRunning || isPausedOnLoss()) updateEngineState();
    }, 30000);
  }

  function clearScheduleTimer() {
    if (scheduleTimerId) {
      clearInterval(scheduleTimerId);
      scheduleTimerId = null;
    }
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
    if (isBuyActive()) runSets.push('BUY');
    if (isSellActive()) runSets.push('SELL');
    var confirm = confirmCheck ? confirmCheck.checked !== false : true;
    return {
      running: rulesEngineRunning,
      confirmBeforePlaceBuy: confirm,
      confirmBeforePlaceSell: confirm,
      ruleSets: getRuleSetsFromDom(),
      runRuleSets: runSets,
      pauseOnLossSeconds: getPauseOnLossSeconds(),
      maxParallelDeals: getMaxParallelDeals(),
      scheduleStartTime: scheduleStartInput && scheduleStartInput.value ? scheduleStartInput.value : '',
      scheduleStopTime: scheduleStopInput && scheduleStopInput.value ? scheduleStopInput.value : '',
      scheduleRepeatDaily: scheduleRepeatCheck ? scheduleRepeatCheck.checked !== false : true,
      forcedCloseTime: forcedCloseInput && forcedCloseInput.value ? forcedCloseInput.value : '',
      maxRunDays: getMaxRunDays()
    };
  }

  var pauseCountdownIntervalId = null;

  function doPauseOnLoss(seconds) {
    if (pauseOnLossTimerId) clearTimeout(pauseOnLossTimerId);
    if (pauseCountdownIntervalId) clearInterval(pauseCountdownIntervalId);
    pausedUntil = Date.now() + seconds * 1000;
    saveRules();
    updateDealEnabled();
    var logFn = typeof log === 'function' ? log : function () {};
    logFn('Rules engine paused on loss for ' + seconds + 's');
    pauseCountdownIntervalId = setInterval(function () {
      if (!isPausedOnLoss()) {
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
      saveRules();
      updateDealEnabled();
      logFn('Rules engine resumed after pause on loss');
    }, seconds * 1000);
  }

  /** Max wait for positions list after IG accepts a rules deal — prevents duplicate place before poll catches up. */
  var RULES_PENDING_POSITION_SYNC_MS = 20000;

  function countOpenDealSlots() {
    var positions = state.currentPositions || [];
    var orders = state.currentWorkingOrders || [];
    return positions.length + orders.length;
  }

  function hasPositionOrOrder() {
    if (state.rulesDealPending) {
      var pendingSince = state.rulesDealPendingSinceMs;
      if (pendingSince != null && Date.now() - pendingSince > RULES_DEAL_PENDING_TIMEOUT_MS) {
        clearRulesDealPending();
      } else {
        return true;
      }
    }
    if (state.dealInProgress) return true;
    if (countOpenDealSlots() >= getMaxParallelDeals()) return true;
    var pe = state.pendingRulesPositionEpic;
    if (pe) {
      var since = state.pendingRulesPositionSinceMs;
      if (since != null && Date.now() - since > RULES_PENDING_POSITION_SYNC_MS) {
        state.pendingRulesPositionEpic = null;
        state.pendingRulesPositionSinceMs = null;
      } else {
        var posList = state.currentPositions || [];
        var synced = posList.some(function (p) { return p.epic === pe; });
        if (synced) {
          state.pendingRulesPositionEpic = null;
          state.pendingRulesPositionSinceMs = null;
        } else {
          return true;
        }
      }
    }
    return false;
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
      if (stat === 'period_start') {
        if (rule.left === 'Buy') return p.periodStartBuy != null ? p.periodStartBuy : null;
        if (rule.left === 'Sell') return p.periodStartSell != null ? p.periodStartSell : null;
        return null;
      }
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

  function formatCommonEngineStatus() {
    var ui = getRulesUiMode();
    if (ui.key === 'paused') {
      return 'Rules trading: Paused (loss) – resuming in ' + ui.pauseSec + 's • manual trading off';
    }
    if (ui.key === 'halted-loss') {
      return 'Rules trading: Halted for today (loss) – resumes tomorrow • manual trading off';
    }
    if (ui.key === 'stopped') {
      return 'Rules trading: Stopped • BUY: off • SELL: off';
    }
    function dirStatus(enabled) {
      if (!enabled) return 'Off';
      return ui.key === 'active' ? 'Active' : 'Armed';
    }
    var engineWord = ui.key === 'active' ? 'Active' : 'Armed';
    var line = 'Rules trading: ' + engineWord + ' • BUY: ' + dirStatus(getRulesBuyEnabled()) + ' • SELL: ' + dirStatus(getRulesSellEnabled());
    if (ui.key === 'armed-schedule') {
      if (ui.scheduleExpired) line += ' • schedule expired (today only)';
      else if (ui.beforeOpen) line += ' • opens ' + ui.scheduleText;
      else if (ui.doneForToday) line += ' • done for today (' + ui.scheduleText + ')';
      else line += ' • next window ' + ui.scheduleText;
    }
    if (ui.key === 'armed-probes') line += ' • No live prices — start probing';
    if (rulesEngineRunning && sleepPreventionStatus) line += ' • ' + sleepPreventionStatus;
    return line;
  }

  function updateEngineState() {
    syncLossHandlingDayRollover(Date.now());
    var config = getConfig();
    var ctx = getContext();
    var ui = getRulesUiMode();
    updateScheduleDisplay();

    if (ui.key === 'paused' && rulesEngineRunning) {
      setDealEnabled(false);
      setOrderEnabledFn(false);
      setProbesBackfillEnabledFn(false);
      if (dealEngineMsg) dealEngineMsg.classList.remove('hidden');
      if (orderEngineMsg) orderEngineMsg.classList.remove('hidden');
      var pausedStatus = formatCommonEngineStatus();
      if (engineStatusEl) {
        engineStatusEl.textContent = pausedStatus;
        engineStatusEl.className = engineStatusClass(ui);
      }
      var pausedDetail = 'Paused on loss — resuming in ' + ui.pauseSec + 's';
      if (statusEl) statusEl.textContent = pausedDetail;
      if (statusSellEl) statusSellEl.textContent = pausedDetail;
      updateRuleStatusIndicators();
      updateTradeSessionUi();
      return;
    }

    if (ui.key === 'halted-loss' && rulesEngineRunning) {
      setDealEnabled(false);
      setOrderEnabledFn(false);
      setProbesBackfillEnabledFn(false);
      if (dealEngineMsg) dealEngineMsg.classList.remove('hidden');
      if (orderEngineMsg) orderEngineMsg.classList.remove('hidden');
      if (engineStatusEl) {
        engineStatusEl.textContent = formatCommonEngineStatus();
        engineStatusEl.className = engineStatusClass(ui);
      }
      var haltedDetail = 'Halted for today (loss) — resumes tomorrow';
      if (statusEl) statusEl.textContent = haltedDetail;
      if (statusSellEl) statusSellEl.textContent = haltedDetail;
      updateRuleStatusIndicators();
      updateTradeSessionUi();
      return;
    }

    if (!config.running) {
      var manualEnabled = canManualTrade();
      setDealEnabled(manualEnabled);
      setOrderEnabledFn(manualEnabled);
      setProbesBackfillEnabledFn(isProbingActive());
      if (dealEngineMsg) dealEngineMsg.classList.add('hidden');
      if (orderEngineMsg) orderEngineMsg.classList.add('hidden');
      var fullStatus = formatCommonEngineStatus();
      if (engineStatusEl) {
        engineStatusEl.textContent = fullStatus;
        engineStatusEl.className = engineStatusClass(ui);
      }
      if (statusEl) {
        statusEl.textContent = manualEnabled
          ? 'Manual trading enabled'
          : (isIgLoggedInLocal() ? 'Stop rules to enable manual trading' : 'Connect to IG to trade manually');
      }
      if (statusSellEl) {
        statusSellEl.textContent = manualEnabled
          ? 'Manual trading enabled'
          : (isIgLoggedInLocal() ? 'Stop rules to enable manual trading' : 'Connect to IG to trade manually');
      }
      updateRuleStatusIndicators();
      updateTradeSessionUi();
      return;
    }

    setDealEnabled(false);
    setOrderEnabledFn(false);
    setProbesBackfillEnabledFn(false);
    if (dealEngineMsg) dealEngineMsg.classList.remove('hidden');
    if (orderEngineMsg) orderEngineMsg.classList.remove('hidden');
    if (engineStatusEl) {
      engineStatusEl.textContent = formatCommonEngineStatus();
      engineStatusEl.className = engineStatusClass(ui);
    }

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
    var scheduleBlocked = hasScheduleLimits() && !isWithinScheduleWindow(Date.now());
    var lossHalted = isLossHaltedToday();
    var blocked = hasPositionOrOrder() || scheduleBlocked || lossHalted;

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
      if ((runBuy ? buyRules : []).length === 0 && (runSell ? sellRules : []).length === 0) {
        status = config.running && !runBuy && !runSell
          ? 'Engine running – enable BUY or SELL'
          : 'Add at least one rule to the selected set(s)';
      }
      else if (allEnabledRules.length === 0) status = 'Enable at least one rule';
      else if (needsProbes && !getProbeValuesFn()) status = 'Waiting for probe data';
      else if (needsPrices && (state.currentBid == null || state.currentOffer == null)) status = 'Waiting for prices';
      else if (needsNowTrend && state.currentTrend == null) status = 'Waiting for price updates (now.trend)';
      else if (pass && hasPositionOrOrder()) {
        var maxPar = getMaxParallelDeals();
        var openSlots = countOpenDealSlots();
        if (openSlots >= maxPar && !state.dealInProgress && !state.rulesDealPending) {
          status = 'Conditions met – max parallel deals (' + maxPar + ') reached, no new deal';
        } else {
          status = 'Conditions met – position/order exists, no new deal';
        }
      }
      else if (pass && scheduleBlocked) {
        if (isScheduleExpiredDay(Date.now())) status = 'Conditions met – schedule expired (today only), no new deal';
        else if (!isPastScheduleStop(Date.now())) status = 'Conditions met – before schedule window, no new deal';
        else if (scheduleLastInsideDate === localDateKey(new Date())) status = 'Conditions met – schedule ended for today, no new deal';
        else status = 'Conditions met – outside schedule window, no new deal';
      }
      else if (pass && lossHalted) {
        status = 'Conditions met – halted for today (loss), resumes tomorrow';
      }
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
        armRulesDealPending();
        var placed = false;
        var dealOpts = {
          direction: triggeredSet === 'buy' ? 'BUY' : 'SELL',
          ruleSet: set,
          fromRules: true
        };
        var rulesCloseAt = getNextForcedCloseIso(nowMs);
        if (rulesCloseAt) dealOpts.closeAt = rulesCloseAt;
        if (confirm) {
          placed = !!triggerDealConfirmFn(dealOpts);
        } else {
          placed = !!placeDealDirectFn(dealOpts);
        }
        if (!placed) clearRulesDealPending();
      }
    }
    prevRulesPass = pass;
    prevBlocked = blocked;
    updateRuleStatusIndicators();
    updateTradeSessionUi();
  }

  function updateToggleButton() {
    var text = rulesEngineRunning ? 'Stop rules' : 'Start rules';
    var cls = 'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ' + (rulesEngineRunning ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white');
    var title = rulesEngineRunning
      ? 'Stop automated rules trading (manual Deal/Order re-enabled)'
      : 'Start automated rules trading (manual Deal/Order disabled while running)';
    if (toggleBtn) { toggleBtn.textContent = text; toggleBtn.className = cls; toggleBtn.title = title; }
    setRulesEditable();
    if (state) state.rulesEngineRunning = rulesEngineRunning;
    if (socket && typeof socket.emit === 'function') socket.emit('rules_engine_running', rulesEngineRunning);
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('tiddeli:rules-engine-running', { detail: { running: rulesEngineRunning } }));
    }
    updateTradeSessionUi();
  }

  function setRulesEditable() {
    var buyEditable = !isBuyActive();
    var sellEditable = !isSellActive();
    if (rulesBuyGroupsRoot) {
      var addBuyBtns = rulesBuyGroupsRoot.querySelectorAll('[data-add-rule-group][data-rules-panel="buy"]');
      for (var ab = 0; ab < addBuyBtns.length; ab++) addBuyBtns[ab].disabled = !buyEditable;
    }
    if (rulesSellGroupsRoot) {
      var addSellBtns = rulesSellGroupsRoot.querySelectorAll('[data-add-rule-group][data-rules-panel="sell"]');
      for (var as = 0; as < addSellBtns.length; as++) addSellBtns[as].disabled = !sellEditable;
    }
    if (rulesLockedMsg) rulesLockedMsg.classList.toggle('hidden', !rulesEngineRunning);
    if (rulesLockedMsgBuy) rulesLockedMsgBuy.classList.toggle('hidden', buyEditable);
    if (rulesLockedMsgSell) rulesLockedMsgSell.classList.toggle('hidden', sellEditable);
    var commonLocked = rulesEngineRunning;
    for (var ci = 0; ci < commonPanelInputs.length; ci++) {
      var commonEl = commonPanelInputs[ci];
      if (commonEl) commonEl.disabled = commonLocked;
    }
    if (pauseOnLossInput) pauseOnLossInput.disabled = commonLocked;
    if (stopAfterConsecutiveInput) stopAfterConsecutiveInput.disabled = commonLocked;
    var buyDslIds = ['tradingRulesDynamicTp', 'tradingRulesDynamicTpTrigger', 'tradingRulesDynamicTpLock'];
    var sellDslIds = ['tradingRulesSellDynamicTp', 'tradingRulesSellDynamicTpTrigger', 'tradingRulesSellDynamicTpLock'];
    for (var db = 0; db < buyDslIds.length; db++) {
      var buyDslEl = document.getElementById(buyDslIds[db]);
      if (buyDslEl) buyDslEl.disabled = !buyEditable;
    }
    for (var ds = 0; ds < sellDslIds.length; ds++) {
      var sellDslEl = document.getElementById(sellDslIds[ds]);
      if (sellDslEl) sellDslEl.disabled = !sellEditable;
    }
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

  function persistScheduleActiveDate() {
    if (scheduleRepeatCheck && scheduleRepeatCheck.checked) {
      scheduleActiveDate = null;
    } else if (hasScheduleLimits()) {
      scheduleActiveDate = localDateKey(new Date());
    } else {
      scheduleActiveDate = null;
    }
  }

  function saveRules() {
    var epicSelect = document.getElementById('epicSelect');
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    if (!epic) return;
    persistScheduleActiveDate();
    var config = getConfig();
    var persistedRuleSets = getPersistedRuleSets(config.ruleSets);
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var instruments = (cfg.ui && cfg.ui.instruments) ? { ...cfg.ui.instruments } : {};
      instruments[epic] = {
        ...(instruments[epic] || {}),
        tradingRulesRunning: rulesEngineRunning,
        rulesRunningBuy: isBuyActive(),
        rulesRunningSell: isSellActive(),
        rulesBuyEnabled: getRulesBuyEnabled(),
        rulesSellEnabled: getRulesSellEnabled(),
        ruleSets: persistedRuleSets,
        tradingRulesConfirmBeforePlace: config.confirmBeforePlaceBuy,
        tradingRulesConfirmBeforePlaceBuy: config.confirmBeforePlaceBuy,
        tradingRulesConfirmBeforePlaceSell: config.confirmBeforePlaceSell,
        tradingRulesPauseOnLossSeconds: getPauseOnLossSeconds(),
        tradingRulesPauseOnLossSecondsBuy: getPauseOnLossSeconds(),
        tradingRulesPauseOnLossSecondsSell: getPauseOnLossSeconds(),
        tradingRulesMaxParallelDeals: getMaxParallelDeals(),
        tradingRulesStopAfterConsecutiveLosses: getStopAfterConsecutiveLosses() || undefined,
        tradingRulesScheduleStartTime: config.scheduleStartTime || '',
        tradingRulesScheduleStopTime: config.scheduleStopTime || '',
        tradingRulesScheduleRepeatDaily: config.scheduleRepeatDaily !== false,
        tradingRulesScheduleActiveDate: scheduleActiveDate,
        tradingRulesScheduleLastInsideDate: scheduleLastInsideDate,
        tradingRulesForcedCloseTime: config.forcedCloseTime || '',
        tradingRulesMaxRunDays: config.maxRunDays > 0 ? config.maxRunDays : undefined,
        tradingRulesEngineStartedDate: rulesEngineStartedDate || undefined,
        ...rulesBuyDynamicTpConfigPayload(),
        ...rulesSellDynamicTpConfigPayload()
      };
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
      var confirmUnified = inst.tradingRulesConfirmBeforePlace != null
        ? inst.tradingRulesConfirmBeforePlace !== false
        : (inst.tradingRulesConfirmBeforePlaceBuy != null
          ? inst.tradingRulesConfirmBeforePlaceBuy !== false
          : (inst.tradingRulesConfirmBeforePlaceSell != null
            ? inst.tradingRulesConfirmBeforePlaceSell !== false
            : ui.tradingRulesConfirmBeforePlace !== false));
      var pauseSec = inst.tradingRulesPauseOnLossSeconds != null
        ? inst.tradingRulesPauseOnLossSeconds
        : Math.max(
          inst.tradingRulesPauseOnLossSecondsBuy != null ? inst.tradingRulesPauseOnLossSecondsBuy : 0,
          inst.tradingRulesPauseOnLossSecondsSell != null ? inst.tradingRulesPauseOnLossSecondsSell : 0,
          ui.tradingRulesPauseOnLossSeconds != null ? ui.tradingRulesPauseOnLossSeconds : 0
        );
      var stopAfterLoss = inst.tradingRulesStopAfterLoss === true
        || inst.tradingRulesStopAfterLossBuy === true
        || inst.tradingRulesStopAfterLossSell === true
        || ui.tradingRulesStopAfterLossBuy === true
        || ui.tradingRulesStopAfterLossSell === true;
      var stopAfterConsecutive = resolveStopAfterConsecutiveLossesFromSaved(
        inst.tradingRulesStopAfterConsecutiveLosses != null
          ? inst.tradingRulesStopAfterConsecutiveLosses
          : (ui.tradingRulesStopAfterConsecutiveLosses != null ? ui.tradingRulesStopAfterConsecutiveLosses : 0),
        stopAfterLoss
      );
      var maxParallel = inst.tradingRulesMaxParallelDeals != null
        ? inst.tradingRulesMaxParallelDeals
        : (ui.tradingRulesMaxParallelDeals != null ? ui.tradingRulesMaxParallelDeals : 1);
      var schedStart = inst.tradingRulesScheduleStartTime != null ? inst.tradingRulesScheduleStartTime : (ui.tradingRulesScheduleStartTime || '');
      var schedStop = inst.tradingRulesScheduleStopTime != null ? inst.tradingRulesScheduleStopTime : (ui.tradingRulesScheduleStopTime || '');
      var schedRepeat = inst.tradingRulesScheduleRepeatDaily != null ? inst.tradingRulesScheduleRepeatDaily !== false : (ui.tradingRulesScheduleRepeatDaily !== false);
      var forcedClose = inst.tradingRulesForcedCloseTime != null ? inst.tradingRulesForcedCloseTime : (ui.tradingRulesForcedCloseTime || '');
      var maxRunDays = inst.tradingRulesMaxRunDays != null
        ? inst.tradingRulesMaxRunDays
        : (ui.tradingRulesMaxRunDays != null ? ui.tradingRulesMaxRunDays : 0);
      rulesEngineStartedDate = inst.tradingRulesEngineStartedDate != null
        ? inst.tradingRulesEngineStartedDate
        : (ui.tradingRulesEngineStartedDate || null);
      scheduleActiveDate = inst.tradingRulesScheduleActiveDate != null ? inst.tradingRulesScheduleActiveDate : (ui.tradingRulesScheduleActiveDate || null);
      scheduleLastInsideDate = inst.tradingRulesScheduleLastInsideDate != null
        ? inst.tradingRulesScheduleLastInsideDate
        : (ui.tradingRulesScheduleLastInsideDate || null);
      var ruleSets = inst.ruleSets || ui.ruleSets;
      var prevRunning = inst.tradingRulesRunning != null ? inst.tradingRulesRunning : ui.tradingRulesRunning;
      rulesEngineRunning = inst.tradingRulesRunning != null ? !!inst.tradingRulesRunning
        : (inst.rulesRunningBuy || inst.rulesRunningSell || ui.rulesRunningBuy || ui.rulesRunningSell || prevRunning);
      if (buyEnabledCheck) {
        if (inst.rulesBuyEnabled != null) buyEnabledCheck.checked = inst.rulesBuyEnabled !== false;
        else if (inst.rulesRunningBuy != null && inst.rulesRunningSell != null && inst.rulesRunningBuy !== inst.rulesRunningSell) {
          buyEnabledCheck.checked = inst.rulesRunningBuy === true;
        } else buyEnabledCheck.checked = true;
      }
      if (sellEnabledCheck) {
        if (inst.rulesSellEnabled != null) sellEnabledCheck.checked = inst.rulesSellEnabled !== false;
        else if (inst.rulesRunningBuy != null && inst.rulesRunningSell != null && inst.rulesRunningBuy !== inst.rulesRunningSell) {
          sellEnabledCheck.checked = inst.rulesRunningSell === true;
        } else sellEnabledCheck.checked = true;
      }
      if (!ruleSets && (inst.tradingRules || ui.tradingRules)) {
        var legacyRules = inst.tradingRules || ui.tradingRules || [];
        var dealDir = (inst.dealDirection || ui.dealDirection || 'BUY').toUpperCase();
        ruleSets = {
          buy: dealDir === 'BUY' ? { rules: legacyRules, dealSize: inst.dealSize || ui.dealSize || '1', takeProfit: inst.dealTakeProfit || ui.dealTakeProfit || null, stopLoss: inst.dealStopLoss || ui.dealStopLoss || null, tpSlMode: inst.dealTpSlMode || ui.dealTpSlMode || 'rate' } : { rules: [], dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate' },
          sell: dealDir === 'SELL' ? { rules: legacyRules, dealSize: inst.dealSize || ui.dealSize || '1', takeProfit: inst.dealTakeProfit || ui.dealTakeProfit || null, stopLoss: inst.dealStopLoss || ui.dealStopLoss || null, tpSlMode: inst.dealTpSlMode || ui.dealTpSlMode || 'rate' } : { rules: [], dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate' }
        };
      }
      if (!ruleSets) ruleSets = { buy: { rules: [], dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate' }, sell: { rules: [], dealSize: '1', takeProfit: null, stopLoss: null, tpSlMode: 'rate' } };
      if (state) state.rulesEngineRunning = rulesEngineRunning;
      if (confirmCheck) confirmCheck.checked = confirmUnified;
      if (pauseOnLossInput) {
        pauseOnLossInput.value = (pauseSec != null && !isNaN(pauseSec) && pauseSec >= 0) ? Math.min(pauseSec, 86400) : 0;
      }
      if (maxParallelDealsInput) {
        var mp = maxParallel != null && !isNaN(Number(maxParallel)) ? Number(maxParallel) : 1;
        maxParallelDealsInput.value = String(Math.max(1, Math.min(10, Math.floor(mp))));
      }
      if (stopAfterConsecutiveInput) {
        stopAfterConsecutiveInput.value = stopAfterConsecutive > 0 ? String(stopAfterConsecutive) : '';
      }
      if (scheduleStartInput) scheduleStartInput.value = schedStart || '';
      if (scheduleStopInput) scheduleStopInput.value = schedStop || '';
      if (scheduleRepeatCheck) scheduleRepeatCheck.checked = schedRepeat;
      if (forcedCloseInput) forcedCloseInput.value = forcedClose || '';
      if (maxRunDaysInput) {
        maxRunDaysInput.value = maxRunDays != null && Number(maxRunDays) > 0 ? String(Math.min(365, Math.floor(Number(maxRunDays)))) : '';
      }
      syncRulesForcedCloseToState();
      applyDynamicTpFromConfig(inst, ui);
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
      applyDynamicTpUiState();
      if (rulesEngineRunning && !rulesEngineStartedDate) {
        rulesEngineStartedDate = localDateKey(new Date());
        saveRules();
      }
      updateToggleButton();
      if (rulesEngineRunning) {
        markScheduleInsideIfNeeded(Date.now());
        if (!runMaxRunDaysStopIfNeeded(Date.now()) && !runScheduleExpiredStopIfNeeded(Date.now())) syncScheduleTimer();
      } else {
        syncScheduleTimer();
      }
      runForcedCloseIfNeeded(Date.now());
      updateEngineState();
      updateRulesEstTpSlDisplay();
    }).catch(function () { updateEngineState(); });
  }

  function applyRuleSetsSnapshot(strategy) {
    if (!strategy || !strategy.ruleSets) return;
    var ruleSets = { buy: strategy.ruleSets.buy, sell: strategy.ruleSets.sell };
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
    if (strategy.dynamicSl) {
      var db = strategy.dynamicSl.buy || { enabled: false };
      var ds = strategy.dynamicSl.sell || { enabled: false };
      writeRulesDynamicSlScope('buy', !!db.enabled, db.trigger, db.lock);
      writeRulesDynamicSlScope('sell', !!ds.enabled, ds.trigger, ds.lock);
    }
    if (strategy.probeShortMinutes != null) {
      var shortP = document.getElementById('probeShortPeriod');
      if (shortP) shortP.value = strategy.probeShortMinutes;
    }
    if (strategy.probeMediumMinutes != null) {
      var medP = document.getElementById('probeMediumPeriod');
      if (medP) medP.value = strategy.probeMediumMinutes;
    }
    if (strategy.probeLongMinutes != null) {
      var longP = document.getElementById('probeLongPeriod');
      if (longP) longP.value = Math.max(1, Math.min(720, Math.round(strategy.probeLongMinutes / 60)));
    }
    applyDynamicTpUiState();
    updateRulesEstTpSlDisplay();
  }

  function clearPauseOnLossState() {
    if (pausedUntil != null) {
      pausedUntil = null;
      if (pauseOnLossTimerId) { clearTimeout(pauseOnLossTimerId); pauseOnLossTimerId = null; }
      if (pauseCountdownIntervalId) { clearInterval(pauseCountdownIntervalId); pauseCountdownIntervalId = null; }
    }
  }

  function clearConsecutiveLossCount() {
    consecutiveLossCount = 0;
    lossStreakDayKey = localDateKey(new Date());
  }

  function startRulesEngine(opts) {
    var options = opts || {};
    clearPauseOnLossState();
    clearConsecutiveLossCount();
    syncLossHandlingDayRollover(Date.now());
    rulesEngineRunning = true;
    rulesEngineStartedDate = localDateKey(new Date());
    markScheduleInsideIfNeeded(Date.now());
    if (!isProbingActive() && !options.withProbing && log) log('Rules started without active price stream');
    syncScheduleTimer();
    updateToggleButton();
    saveRules();
    updateDealEnabled();
    if (options.showStartModal !== false) showRulesStartModal();
  }

  function stopRulesEngine(reason) {
    if (!rulesEngineRunning && !isPausedOnLoss() && !(state && state.rulesEngineRunning)) {
      if (!reason) return;
    }
    clearPauseOnLossState();
    clearConsecutiveLossCount();
    clearRulesDealPending();
    lastRulesDealAttemptMs = 0;
    rulesEngineRunning = false;
    scheduleLastInsideDate = null;
    rulesEngineStartedDate = null;
    syncScheduleTimer();
    hideRulesStartModal();
    if (state) state.rulesEngineRunning = false;
    updateToggleButton();
    saveRules();
    updateDealEnabled();
    if (reason) {
      var logFn = typeof log === 'function' ? log : function () {};
      logFn(reason);
    }
  }

  function startRulesAndProbing() {
    if (socket && typeof socket.emit === 'function') {
      var logFn = typeof log === 'function' ? log : function () {};
      logFn('Start probing clicked');
      socket.emit('start');
    }
    startRulesEngine({ withProbing: true });
  }

  function doToggleEngine() {
    if (rulesEngineRunning) {
      stopRulesEngine();
      return;
    }
    if (!isProbingActive()) {
      showRulesNoProbesModal();
      return;
    }
    startRulesEngine();
  }
  if (toggleBtn) toggleBtn.addEventListener('click', doToggleEngine);
  if (rulesStartModalOk) rulesStartModalOk.addEventListener('click', hideRulesStartModal);
  if (rulesStartModalCancel) {
    rulesStartModalCancel.addEventListener('click', function () {
      hideRulesStartModal();
      stopRulesEngine('Rules engine stopped (cancelled at start)');
    });
  }
  if (rulesStartModal) {
    rulesStartModal.addEventListener('click', function (e) {
      if (e.target === rulesStartModal) hideRulesStartModal();
    });
  }
  if (rulesNoProbesCancel) rulesNoProbesCancel.addEventListener('click', hideRulesNoProbesModal);
  if (rulesNoProbesRulesOnly) {
    rulesNoProbesRulesOnly.addEventListener('click', function () {
      hideRulesNoProbesModal();
      startRulesEngine();
    });
  }
  if (rulesNoProbesWithProbes) {
    rulesNoProbesWithProbes.addEventListener('click', function () {
      hideRulesNoProbesModal();
      startRulesAndProbing();
    });
  }
  if (rulesNoProbesModal) {
    rulesNoProbesModal.addEventListener('click', function (e) {
      if (e.target === rulesNoProbesModal) hideRulesNoProbesModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (rulesStartModal && !rulesStartModal.classList.contains('hidden')) hideRulesStartModal();
      else if (rulesNoProbesModal && !rulesNoProbesModal.classList.contains('hidden')) hideRulesNoProbesModal();
    });
  }
  if (buyEnabledCheck) buyEnabledCheck.addEventListener('change', function () { saveRules(); updateEngineState(); });
  if (sellEnabledCheck) sellEnabledCheck.addEventListener('change', function () { saveRules(); updateEngineState(); });
  if (confirmCheck) confirmCheck.addEventListener('change', saveRules);
  if (maxParallelDealsInput) {
    maxParallelDealsInput.addEventListener('change', function () {
      saveRules();
      updateEngineState();
    });
  }
  if (pauseOnLossInput) pauseOnLossInput.addEventListener('change', saveRules);
  if (stopAfterConsecutiveInput) stopAfterConsecutiveInput.addEventListener('change', saveRules);
  function onScheduleFieldChange() {
    updateScheduleDisplay();
    syncRulesForcedCloseToState();
    syncScheduleTimer();
    saveRules();
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('tiddeli:rules-schedule-changed'));
    }
  }
  if (scheduleStartInput) {
    scheduleStartInput.addEventListener('change', onScheduleFieldChange);
    scheduleStartInput.addEventListener('input', updateScheduleDisplay);
  }
  if (scheduleStopInput) {
    scheduleStopInput.addEventListener('change', onScheduleFieldChange);
    scheduleStopInput.addEventListener('input', updateScheduleDisplay);
  }
  if (scheduleRepeatCheck) scheduleRepeatCheck.addEventListener('change', onScheduleFieldChange);
  if (forcedCloseInput) {
    forcedCloseInput.addEventListener('change', onScheduleFieldChange);
    forcedCloseInput.addEventListener('input', updateScheduleDisplay);
  }
  if (maxRunDaysInput) maxRunDaysInput.addEventListener('change', onScheduleFieldChange);
  var tradingRulesDynamicTp = document.getElementById('tradingRulesDynamicTp');
  if (tradingRulesDynamicTp) {
    tradingRulesDynamicTp.addEventListener('change', function () {
      syncDynamicTpUi('rules');
      applyDynamicTpUiState();
      saveRules();
      updateRulesEstTpSlDisplay();
    });
  }
  ['tradingRulesDynamicTpTrigger', 'tradingRulesDynamicTpLock'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', function () {
        syncDynamicTpUi('rules');
        saveRules();
      });
      el.addEventListener('input', function () {
        syncDynamicTpUi('rules');
        saveRules();
      });
    }
  });
  var tradingRulesSellDynamicTp = document.getElementById('tradingRulesSellDynamicTp');
  if (tradingRulesSellDynamicTp) {
    tradingRulesSellDynamicTp.addEventListener('change', function () {
      syncDynamicTpUi('rules-sell');
      applyDynamicTpUiState();
      saveRules();
      updateRulesEstTpSlDisplay();
    });
  }
  ['tradingRulesSellDynamicTpTrigger', 'tradingRulesSellDynamicTpLock'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', function () {
        syncDynamicTpUi('rules-sell');
        saveRules();
      });
      el.addEventListener('input', function () {
        syncDynamicTpUi('rules-sell');
        saveRules();
      });
    }
  });
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

  socket.on('dynamic_stop_loss_status', function () {
    updateDynamicTpStatusDisplay(state);
  });

  socket.on('status', function () {
    updateDealEnabled();
  });

  socket.on('deal_placed', function () {
    var m = state.dealJustPlaced;
    state.dealJustPlaced = null;
    if (m && m.source === 'rules' && m.dealId) {
      syncRulesPlacedDealIdToState(m.dealId, m.direction);
    }
  });

  function resumeRulesAfterReconnect() {
    if (!rulesEngineRunning && !isPausedOnLoss()) return;
    markScheduleInsideIfNeeded(Date.now());
    if (runMaxRunDaysStopIfNeeded(Date.now())) return;
    if (runScheduleExpiredStopIfNeeded(Date.now())) return;
    syncScheduleTimer();
    updateToggleButton();
    if (state) state.rulesEngineRunning = rulesEngineRunning;
    if (socket && typeof socket.emit === 'function') socket.emit('rules_engine_running', rulesEngineRunning);
    updateEngineState();
    updateDealEnabled();
    updateTradeSessionUi();
  }

  socket.on('disconnect', function (reason) {
    for (var rid in rulesPlacedDealIds) delete rulesPlacedDealIds[rid];
    state.rulesPlacedDealIds = Object.create(null);
    // Only stop on explicit client disconnect(); transient drops (ping timeout, transport close, server restart) keep rules armed.
    if (reason === 'io client disconnect') {
      stopRulesEngine('Rules engine stopped (disconnected)');
      return;
    }
    if (rulesEngineRunning || isPausedOnLoss()) {
      syncScheduleTimer();
      var logFn = typeof log === 'function' ? log : function () {};
      logFn('Connection lost (' + (reason || 'unknown') + ') — rules stay armed; resume when reconnected');
      updateEngineState();
      updateTradeSessionUi();
    }
  });

  socket.on('connect', function () {
    if (!rulesEngineRunning && !isPausedOnLoss()) return;
    resumeRulesAfterReconnect();
    var logFn = typeof log === 'function' ? log : function () {};
    if (rulesEngineRunning) logFn('Reconnected — rules trading resumed');
  });

  socket.on('transaction_added', function (tx) {
    if (!tx || tx.type !== 'closed' || !tx.dealId) return;
    var panel = rulesPlacedDealIds[tx.dealId];
    if (panel != null) clearRulesPlacedDealIdFromState(tx.dealId);
    var closeDayKey = closeDateKeyFromTx(tx);
    if (panel != null && typeof tx.profitLoss === 'number' && tx.profitLoss >= 0) {
      syncLossStreakForCloseDay(closeDayKey);
      consecutiveLossCount = 0;
      return;
    }
    if (typeof tx.profitLoss !== 'number' || tx.profitLoss >= 0) return;
    syncLossStreakForCloseDay(closeDayKey);
    var skipPauseForThisClose = false;
    if (panel != null && rulesEngineRunning) {
      var streakLimit = getStopAfterConsecutiveLosses();
      if (streakLimit > 0) {
        consecutiveLossCount += 1;
        if (consecutiveLossCount >= streakLimit) {
          skipPauseForThisClose = true;
          haltRulesForLossDay(closeDayKey, 'Rules halted for today (' + consecutiveLossCount + ' consecutive losses).');
        }
      }
    }
    if (!skipPauseForThisClose) {
      var seconds = getPauseOnLossSeconds();
      if (seconds > 0 && rulesEngineRunning) doPauseOnLoss(seconds);
    }
  });

  socket.on('positions', function () {
    updateEngineState();
  });
  socket.on('working_orders', updateEngineState);
  socket.on('marketDetails', function () {
    maybeDefaultForcedCloseFromMarket();
    setTimeout(updateScheduleDisplay, 0);
    setTimeout(updateDealEnabled, 0);
    setTimeout(updateRulesEstTpSlDisplay, 0);
  });
  socket.on('price_update', function () {
    setTimeout(updateRuleStatusIndicators, 0);
    setTimeout(updateRulesEstTpSlDisplay, 0);
  });

  socket.on('sleep_prevention_status', function (msg) {
    sleepPreventionStatus = msg || null;
    updateEngineState();
  });

  loadRules();
  updateScheduleDisplay();
  updateRulesEstTpSlDisplay();
  updateTradeSessionUi();
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
    stopRulesEngine: stopRulesEngine,
    updateSessionUi: updateTradeSessionUi,
    setBaseEnabled: function (enabled) {
      baseEnabled = !!enabled;
      updateDealEnabled();
    },
    updateDealEnabled: updateDealEnabled,
    setTradingRulesPanelEnabled: function (enabled) {
      var commonPanel = document.getElementById('tradingRulesCommonPanel');
      var buyPanel = document.getElementById('tradingRulesBuyPanel');
      var sellPanel = document.getElementById('tradingRulesSellPanel');
      if (commonPanel) commonPanel.classList.toggle('hidden', !enabled);
      if (buyPanel) buyPanel.classList.toggle('hidden', !enabled);
      if (sellPanel) sellPanel.classList.toggle('hidden', !enabled);
    },
    loadRules: loadRules,
    applyRuleSetsSnapshot: applyRuleSetsSnapshot,
    applyTradeProfile: function (profile) {
      if (!profile) return;
      if (profile.strategy) applyRuleSetsSnapshot(profile.strategy);
      applyEngineControlsSnapshot(profile.engineControls);
      saveRules();
      updateDealEnabled();
    }
  };
}
