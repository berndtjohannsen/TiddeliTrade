/**
 * Dynamic stop loss UI: separate BUY/SELL rules engines; manual deal + order share one setting.
 */

/** @typedef {'buy'|'sell'|'manual'} DynamicSlScope */

var RULES_BUY = {
  ch: 'tradingRulesDynamicTp',
  trig: 'tradingRulesDynamicTpTrigger',
  lock: 'tradingRulesDynamicTpLock',
  fields: 'tradingRulesDynamicTpFields',
  status: 'tradingRulesDynamicTpStatus',
  tp: 'rulesBuyTp'
};

var RULES_SELL = {
  ch: 'tradingRulesSellDynamicTp',
  trig: 'tradingRulesSellDynamicTpTrigger',
  lock: 'tradingRulesSellDynamicTpLock',
  fields: 'tradingRulesSellDynamicTpFields',
  status: 'tradingRulesSellDynamicTpStatus',
  tp: 'rulesSellTp'
};

var MANUAL = {
  ch: 'dealDynamicStopLoss',
  trig: 'dealDynamicStopLossTrigger',
  lock: 'dealDynamicStopLossLock',
  fields: 'dealDynamicStopLossFields',
  status: 'dealDynamicStopLossStatus',
  tp: 'dealTakeProfit'
};

var ORDER = {
  ch: 'orderDynamicStopLoss',
  trig: 'orderDynamicStopLossTrigger',
  lock: 'orderDynamicStopLossLock',
  fields: 'orderDynamicStopLossFields',
  status: 'orderDynamicStopLossStatus',
  tp: 'orderTakeProfit'
};

function scopeUi(scope) {
  if (scope === 'sell') return RULES_SELL;
  if (scope === 'manual') return MANUAL;
  if (scope === 'order') return ORDER;
  return RULES_BUY;
}

/** @param {DynamicSlScope|'order'} [scope] */
export function isDynamicTpEnabled(scope) {
  if (scope === 'order') {
    var och = document.getElementById(ORDER.ch);
    return !!(och && och.checked);
  }
  if (scope === 'manual') {
    var mch = document.getElementById(MANUAL.ch);
    return !!(mch && mch.checked);
  }
  if (scope === 'sell') {
    var sch = document.getElementById(RULES_SELL.ch);
    return !!(sch && sch.checked);
  }
  if (scope === 'buy') {
    var bch = document.getElementById(RULES_BUY.ch);
    return !!(bch && bch.checked);
  }
  return isDynamicTpEnabled('buy') || isDynamicTpEnabled('sell') || isDynamicTpEnabled('manual');
}

/** Rules deal: use BUY/SELL scope from direction. */
export function isDynamicTpEnabledForDirection(direction) {
  return isDynamicTpEnabled(direction === 'SELL' ? 'sell' : 'buy');
}

function readScopeValues(ui) {
  var ch = document.getElementById(ui.ch);
  var trig = document.getElementById(ui.trig);
  var lock = document.getElementById(ui.lock);
  return {
    enabled: !!(ch && ch.checked),
    trigger: trig && trig.value.trim() ? trig.value.trim() : '',
    lock: lock && lock.value.trim() ? lock.value.trim() : ''
  };
}

export function readDynamicSlScope(scope) {
  return readScopeValues(scopeUi(scope === 'sell' ? 'sell' : scope === 'manual' ? 'manual' : scope === 'order' ? 'order' : 'buy'));
}

/** Apply BUY/SELL dynamic SL checkbox + fields without touching manual/order. */
export function writeRulesDynamicSlScope(scope, enabled, trigger, lock) {
  writeScopeValues(scopeUi(scope === 'sell' ? 'sell' : 'buy'), enabled, trigger, lock);
}

/** @param {DynamicSlScope|'order'} scope */
function writeScopeValues(ui, enabled, trigger, lock) {
  var ch = document.getElementById(ui.ch);
  var trig = document.getElementById(ui.trig);
  var lockEl = document.getElementById(ui.lock);
  if (ch) ch.checked = enabled;
  if (trig && trigger != null) trig.value = trigger === '' ? '' : String(trigger);
  if (lockEl && lock != null) lockEl.value = lock === '' ? '' : String(lock);
}

/** @param {DynamicSlScope|'order'} scope */
function applyScopeUiState(scope) {
  var ui = scopeUi(scope);
  var on = isDynamicTpEnabled(scope);
  var fields = document.getElementById(ui.fields);
  if (fields) fields.classList.toggle('hidden', !on);
  var tp = document.getElementById(ui.tp);
  if (tp) {
    tp.disabled = on;
    tp.classList.toggle('opacity-50', on);
    tp.classList.toggle('cursor-not-allowed', on);
  }
}

export function applyDynamicTpUiState() {
  applyScopeUiState('buy');
  applyScopeUiState('sell');
  applyScopeUiState('manual');
  applyScopeUiState('order');
}

/** @param {'deal'|'rules'|'rules-sell'|'order'} source */
export function syncDynamicTpUi(source) {
  var fromUi =
    source === 'rules-sell'
      ? RULES_SELL
      : source === 'rules'
        ? RULES_BUY
        : source === 'order'
          ? ORDER
          : MANUAL;
  var v = readScopeValues(fromUi);
  if (source === 'deal' || source === 'order') {
    writeScopeValues(MANUAL, v.enabled, v.trigger, v.lock);
    writeScopeValues(ORDER, v.enabled, v.trigger, v.lock);
  } else if (source === 'rules-sell') {
    writeScopeValues(RULES_SELL, v.enabled, v.trigger, v.lock);
  } else {
    writeScopeValues(RULES_BUY, v.enabled, v.trigger, v.lock);
  }
  applyDynamicTpUiState();
}

export function updateDynamicTpStatusDisplay(state) {
  var list = (state && state.dynamicStopLossStatus) || [];
  var text =
    list.length === 0
      ? ''
      : list
          .map(function (s) {
            return (s.dealId || '') + ': ' + (s.lastMessage || '—');
          })
          .join(' · ');
  [RULES_BUY.status, RULES_SELL.status, MANUAL.status, ORDER.status].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (text) {
      el.classList.remove('hidden');
      el.textContent = text;
    } else {
      el.classList.add('hidden');
      el.textContent = '';
    }
  });
}

function legacyDsl(inst, ui) {
  return {
    enabled:
      inst.dealDynamicStopLossEnabled === true ||
      (inst.dealDynamicStopLossEnabled == null && ui.dealDynamicStopLossEnabled === true),
    trigger: inst.dealDynamicStopLossTrigger != null ? inst.dealDynamicStopLossTrigger : ui.dealDynamicStopLossTrigger,
    lock: inst.dealDynamicStopLossLock != null ? inst.dealDynamicStopLossLock : ui.dealDynamicStopLossLock
  };
}

export function applyDynamicTpFromConfig(inst, ui) {
  var leg = legacyDsl(inst, ui);
  var buyEnabled =
    inst.rulesDynamicStopLossEnabledBuy != null
      ? inst.rulesDynamicStopLossEnabledBuy === true
      : leg.enabled;
  var sellEnabled =
    inst.rulesDynamicStopLossEnabledSell != null
      ? inst.rulesDynamicStopLossEnabledSell === true
      : leg.enabled;
  var buyTrig =
    inst.rulesDynamicStopLossTriggerBuy != null ? inst.rulesDynamicStopLossTriggerBuy : leg.trigger;
  var buyLock = inst.rulesDynamicStopLossLockBuy != null ? inst.rulesDynamicStopLossLockBuy : leg.lock;
  var sellTrig =
    inst.rulesDynamicStopLossTriggerSell != null ? inst.rulesDynamicStopLossTriggerSell : leg.trigger;
  var sellLock = inst.rulesDynamicStopLossLockSell != null ? inst.rulesDynamicStopLossLockSell : leg.lock;
  var manualEnabled = inst.dealDynamicStopLossEnabled != null ? inst.dealDynamicStopLossEnabled === true : leg.enabled;
  var manualTrig = inst.dealDynamicStopLossTrigger != null ? inst.dealDynamicStopLossTrigger : leg.trigger;
  var manualLock = inst.dealDynamicStopLossLock != null ? inst.dealDynamicStopLossLock : leg.lock;

  writeScopeValues(RULES_BUY, buyEnabled, buyTrig != null ? String(buyTrig) : '', buyLock != null ? String(buyLock) : '');
  writeScopeValues(
    RULES_SELL,
    sellEnabled,
    sellTrig != null ? String(sellTrig) : '',
    sellLock != null ? String(sellLock) : ''
  );
  writeScopeValues(
    MANUAL,
    manualEnabled,
    manualTrig != null ? String(manualTrig) : '',
    manualLock != null ? String(manualLock) : ''
  );
  writeScopeValues(
    ORDER,
    manualEnabled,
    manualTrig != null ? String(manualTrig) : '',
    manualLock != null ? String(manualLock) : ''
  );
  applyDynamicTpUiState();
}

export function rulesBuyDynamicTpConfigPayload() {
  var v = readScopeValues(RULES_BUY);
  return {
    rulesDynamicStopLossEnabledBuy: v.enabled,
    rulesDynamicStopLossTriggerBuy: v.trigger || null,
    rulesDynamicStopLossLockBuy: v.lock || null
  };
}

export function rulesSellDynamicTpConfigPayload() {
  var v = readScopeValues(RULES_SELL);
  return {
    rulesDynamicStopLossEnabledSell: v.enabled,
    rulesDynamicStopLossTriggerSell: v.trigger || null,
    rulesDynamicStopLossLockSell: v.lock || null
  };
}

export function manualDynamicTpConfigPayload() {
  var v = readScopeValues(MANUAL);
  return {
    dealDynamicStopLossEnabled: v.enabled,
    dealDynamicStopLossTrigger: v.trigger || null,
    dealDynamicStopLossLock: v.lock || null
  };
}

/** @deprecated use scoped payloads */
export function dynamicTpConfigPayload() {
  return Object.assign(rulesBuyDynamicTpConfigPayload(), rulesSellDynamicTpConfigPayload(), manualDynamicTpConfigPayload());
}
