/**
 * Deal form, market details, confirm/error modals.
 */
import { formatMoney, formatTimeWithTz, playSuccessSound } from './utils.js';

export function initDeal(socket, state, log) {
  var dealPanel = document.getElementById('dealPanel');
  var dealMessageEl = document.getElementById('dealMessage');
  var epicSelect = document.getElementById('epicSelect');
  var dealForm = document.getElementById('dealForm');
  var dealConfirmModal = document.getElementById('dealConfirmModal');
  var dealConfirmCancel = document.getElementById('dealConfirmCancel');
  var dealConfirmOk = document.getElementById('dealConfirmOk');
  var dealErrorModal = document.getElementById('dealErrorModal');
  var dealErrorOk = document.getElementById('dealErrorOk');
  var pendingDealParams = null;

  function showDealMessage(msg) {
    if (dealMessageEl) {
      dealMessageEl.textContent = msg;
      dealMessageEl.classList.remove('hidden');
    }
  }
  function clearDealMessage() {
    if (dealMessageEl) {
      dealMessageEl.textContent = '';
      dealMessageEl.classList.add('hidden');
    }
  }
  function setDealEnabled(enabled) {
    var btn = document.getElementById('dealPlaceBtn');
    var form = document.getElementById('dealForm');
    if (btn) btn.disabled = !enabled;
    if (form) {
      var inputs = form.querySelectorAll('input, select');
      inputs.forEach(function (el) { el.disabled = !enabled; });
    }
  }
  function setPositionsEnabled(enabled) {
    var panel = document.getElementById('positionsPanel');
    if (panel) panel.classList.toggle('hidden', !enabled);
  }
  function setOrdersPanelEnabled(enabled) {
    var ordersList = document.getElementById('ordersPanel');
    var orderForm = document.getElementById('orderPanel');
    if (ordersList) ordersList.classList.toggle('hidden', !enabled);
    if (orderForm) orderForm.classList.toggle('hidden', !enabled);
  }

  socket.on('marketDetails', function (data) {
    state.is24_7Market = !!data.is24_7;
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    if (!data.epic || data.epic !== epic) return;
    state.currentMinDealSize = data.minDealSize != null && !isNaN(data.minDealSize) ? data.minDealSize : null;
    var minEl = document.getElementById('dealMinSize');
    if (minEl) {
      if (state.currentMinDealSize != null) {
        minEl.textContent = 'Min: ' + state.currentMinDealSize;
        minEl.classList.remove('hidden');
      } else {
        minEl.textContent = 'Min: —';
        minEl.classList.add('hidden');
      }
    }
    var currencyEl = document.getElementById('dealCurrency');
    state.currentDealCurrency = data.currencyCode || '';
    state.currentContractSize = (data.contractSize != null && !isNaN(data.contractSize)) ? data.contractSize : 1;
    state.currentLotSize = (data.lotSize != null && !isNaN(data.lotSize)) ? data.lotSize : null;
    state.currentMarginFactor = (data.marginFactor != null && !isNaN(data.marginFactor)) ? data.marginFactor : null;
    state.currentValueOfOnePip = (data.valueOfOnePip != null && !isNaN(data.valueOfOnePip)) ? data.valueOfOnePip : null;
    state.currentScalingFactor = (data.scalingFactor != null && !isNaN(data.scalingFactor) && data.scalingFactor > 0) ? data.scalingFactor : null;
    state.currentExchangeRateToAccount = (data.exchangeRateToAccount != null && !isNaN(data.exchangeRateToAccount) && data.exchangeRateToAccount > 0) ? data.exchangeRateToAccount : null;
    state.dayStartBuy = (data.dayStartBuy != null && !isNaN(data.dayStartBuy)) ? data.dayStartBuy : null;
    var nowDayStart = document.getElementById('nowDayStart');
    if (nowDayStart) nowDayStart.textContent = state.dayStartBuy != null ? state.dayStartBuy.toFixed(2) : '—';
    if (currencyEl) {
      currencyEl.textContent = state.currentDealCurrency ? state.currentDealCurrency : '—';
    }
    updateDealEstimateDisplay();
  });

  var dealCloseAtClear = document.getElementById('dealCloseAtClear');
  if (dealCloseAtClear) {
    dealCloseAtClear.addEventListener('click', function () {
      var closeAtEl = document.getElementById('dealCloseAt');
      if (closeAtEl) closeAtEl.value = '';
      saveDealSettings();
    });
  }

  function getDealSettings() {
    var directionEl = document.getElementById('dealDirection');
    var sizeEl = document.getElementById('dealSize');
    var modeEl = document.getElementById('dealTpSlMode');
    var tpEl = document.getElementById('dealTakeProfit');
    var slEl = document.getElementById('dealStopLoss');
    var closeAtEl = document.getElementById('dealCloseAt');
    return {
      dealDirection: directionEl ? directionEl.value : 'BUY',
      dealSize: sizeEl ? sizeEl.value.trim() : '',
      dealTpSlMode: modeEl ? modeEl.value : 'value',
      dealTakeProfit: tpEl ? tpEl.value.trim() : '',
      dealStopLoss: slEl ? slEl.value.trim() : '',
      dealCloseAt: closeAtEl && closeAtEl.value ? closeAtEl.value : ''
    };
  }

  function isCloseAtInPast(closeAtStr) {
    if (!closeAtStr || !closeAtStr.trim()) return false;
    var ms = new Date(closeAtStr.trim()).getTime();
    return !isNaN(ms) && ms <= Date.now();
  }

  function saveDealSettings() {
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    if (!epic) return;
    var s = getDealSettings();
    var closeAt = s.dealCloseAt;
    if (closeAt && isCloseAtInPast(closeAt)) closeAt = '';
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var instruments = (cfg.ui && cfg.ui.instruments) ? { ...cfg.ui.instruments } : {};
      instruments[epic] = { ...(instruments[epic] || {}), dealDirection: s.dealDirection, dealSize: s.dealSize, dealTpSlMode: s.dealTpSlMode, dealTakeProfit: s.dealTakeProfit, dealStopLoss: s.dealStopLoss, dealCloseAt: (closeAt && closeAt.trim()) ? closeAt : null };
      return fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui: { instruments: instruments } })
      });
    }).then(function (r) { return r && r.json ? r.json() : {}; }).catch(function () {});
  }

  function loadDealSettings() {
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      if (!epic && cfg.epic) epic = cfg.epic;
      var ui = cfg.ui || {};
      var inst = (epic && ui.instruments && ui.instruments[epic]) ? ui.instruments[epic] : {};
      var s = { dealDirection: inst.dealDirection || ui.dealDirection, dealSize: inst.dealSize != null ? inst.dealSize : ui.dealSize, dealTpSlMode: inst.dealTpSlMode || ui.dealTpSlMode, dealTakeProfit: inst.dealTakeProfit != null ? inst.dealTakeProfit : ui.dealTakeProfit, dealStopLoss: inst.dealStopLoss != null ? inst.dealStopLoss : ui.dealStopLoss, dealCloseAt: (inst.dealCloseAt != null && inst.dealCloseAt !== '') ? inst.dealCloseAt : '' };
      var directionEl = document.getElementById('dealDirection');
      var sizeEl = document.getElementById('dealSize');
      var modeEl = document.getElementById('dealTpSlMode');
      var tpEl = document.getElementById('dealTakeProfit');
      var slEl = document.getElementById('dealStopLoss');
      var closeAtEl = document.getElementById('dealCloseAt');
      if (directionEl && s.dealDirection) directionEl.value = s.dealDirection;
      if (sizeEl && s.dealSize != null) sizeEl.value = s.dealSize;
      if (modeEl && s.dealTpSlMode) modeEl.value = s.dealTpSlMode;
      if (tpEl && s.dealTakeProfit != null) tpEl.value = s.dealTakeProfit;
      if (slEl && s.dealStopLoss != null) slEl.value = s.dealStopLoss;
      if (closeAtEl) {
        if (s.dealCloseAt && !isCloseAtInPast(s.dealCloseAt)) {
          closeAtEl.value = s.dealCloseAt;
        } else {
          closeAtEl.value = '';
          if (s.dealCloseAt) saveDealSettings();
        }
      }
      updateTpSlPlaceholders();
      updateDealEstimateDisplay();
    }).catch(function () {});
  }

  function updateTpSlPlaceholders() {
    var modeEl = document.getElementById('dealTpSlMode');
    var tpEl = document.getElementById('dealTakeProfit');
    var slEl = document.getElementById('dealStopLoss');
    var mode = modeEl ? modeEl.value : 'value';
    var ph = mode === 'value' ? 'e.g. 50' : (mode === 'pct' ? 'e.g. 1.5' : 'e.g. 2650.50');
    if (tpEl) tpEl.placeholder = ph;
    if (slEl) slEl.placeholder = ph;
  }
  var dealTpSlMode = document.getElementById('dealTpSlMode');
  if (dealTpSlMode) {
    dealTpSlMode.addEventListener('change', function () {
      updateTpSlPlaceholders();
      updateDealEstimateDisplay();
      saveDealSettings();
    });
    updateTpSlPlaceholders();
  }
  ['dealDirection', 'dealSize', 'dealTakeProfit', 'dealStopLoss'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', function () {
        updateDealEstimateDisplay();
        saveDealSettings();
      });
      if (id === 'dealSize' || id === 'dealTakeProfit' || id === 'dealStopLoss') {
        el.addEventListener('input', function () {
          updateDealEstimateDisplay();
          saveDealSettings();
        });
      }
    }
  });
  var dealCloseAtEl = document.getElementById('dealCloseAt');
  if (dealCloseAtEl) {
    dealCloseAtEl.addEventListener('change', function () {
      if (dealCloseAtEl.value && isCloseAtInPast(dealCloseAtEl.value)) {
        dealCloseAtEl.value = '';
      }
      saveDealSettings();
    });
  }

  function computeEstimatedGainLoss() {
    var directionEl = document.getElementById('dealDirection');
    var sizeEl = document.getElementById('dealSize');
    var tpEl = document.getElementById('dealTakeProfit');
    var slEl = document.getElementById('dealStopLoss');
    var modeEl = document.getElementById('dealTpSlMode');
    var direction = directionEl ? directionEl.value : 'BUY';
    var size = parseFloat(sizeEl && sizeEl.value.trim() ? sizeEl.value.trim() : sizeEl && sizeEl.placeholder ? sizeEl.placeholder : '1');
    var tpRaw = tpEl ? tpEl.value.trim() : '';
    var slRaw = slEl ? slEl.value.trim() : '';
    var mode = modeEl ? modeEl.value : 'value';
    var entryPrice = direction === 'BUY' ? state.currentOffer : state.currentBid;
    var contractSize = state.currentContractSize > 0 ? state.currentContractSize : 1;
    var currency = state.currentDealCurrency || '';
    if (!tpRaw && !slRaw) return null;
    if ((mode === 'pct' || mode === 'rate') && (entryPrice == null || isNaN(entryPrice) || entryPrice <= 0)) return null;
    if (isNaN(size) || size <= 0) return null;
    var tpGain = null;
    var slLoss = null;
    if (mode === 'value') {
      if (tpRaw) {
        var tpVal = parseFloat(tpRaw);
        tpGain = !isNaN(tpVal) ? tpVal : null;
      }
      if (slRaw) {
        var slVal = parseFloat(slRaw);
        slLoss = !isNaN(slVal) && slVal > 0 ? -slVal : null;
      }
    } else if (mode === 'rate' && entryPrice != null && !isNaN(entryPrice)) {
      var denom = size * contractSize;
      if (tpRaw) {
        var tpLevel = parseFloat(tpRaw);
        if (!isNaN(tpLevel)) {
          tpGain = direction === 'BUY' ? (tpLevel - entryPrice) * denom : (entryPrice - tpLevel) * denom;
        }
      }
      if (slRaw) {
        var slLevel = parseFloat(slRaw);
        if (!isNaN(slLevel)) {
          slLoss = direction === 'BUY' ? (entryPrice - slLevel) * denom : (slLevel - entryPrice) * denom;
          if (slLoss < 0) slLoss = null;
          else slLoss = -slLoss;
        }
      }
    } else if (mode === 'pct' && entryPrice != null && !isNaN(entryPrice)) {
      var denom = size * contractSize;
      if (tpRaw) {
        var tpPct = parseFloat(tpRaw);
        if (!isNaN(tpPct)) {
          var tpLevel = direction === 'BUY' ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100);
          tpGain = direction === 'BUY' ? (tpLevel - entryPrice) * denom : (entryPrice - tpLevel) * denom;
        }
      }
      if (slRaw) {
        var slPct = parseFloat(slRaw);
        if (!isNaN(slPct) && slPct > 0) {
          var slLevel = direction === 'BUY' ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100);
          slLoss = direction === 'BUY' ? (entryPrice - slLevel) * denom : (slLevel - entryPrice) * denom;
          slLoss = -slLoss;
        }
      }
    }
    if (tpGain == null && slLoss == null) return null;
    return { tpGain: tpGain, slLoss: slLoss, currency: currency };
  }

  function isTakeProfitLoss() {
    var directionEl = document.getElementById('dealDirection');
    var tpEl = document.getElementById('dealTakeProfit');
    var modeEl = document.getElementById('dealTpSlMode');
    var sizeEl = document.getElementById('dealSize');
    var direction = directionEl ? directionEl.value : 'BUY';
    var tpRaw = tpEl ? tpEl.value.trim() : '';
    var mode = modeEl ? modeEl.value : 'value';
    var entryPrice = direction === 'BUY' ? state.currentOffer : state.currentBid;
    var size = parseFloat(sizeEl && sizeEl.value.trim() ? sizeEl.value.trim() : sizeEl && sizeEl.placeholder ? sizeEl.placeholder : '1');
    if (!tpRaw || entryPrice == null || isNaN(entryPrice) || entryPrice <= 0) return false;
    var tpLevel = null;
    if (mode === 'rate') {
      tpLevel = parseFloat(tpRaw);
      if (isNaN(tpLevel)) return false;
    } else if (mode === 'pct') {
      var tpPct = parseFloat(tpRaw);
      if (isNaN(tpPct)) return false;
      tpLevel = direction === 'BUY' ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100);
    } else if (mode === 'value') {
      var tpVal = parseFloat(tpRaw);
      if (isNaN(tpVal)) return false;
      var denom = size * (state.currentContractSize > 0 ? state.currentContractSize : 1);
      if (denom <= 0) return false;
      tpLevel = direction === 'BUY' ? entryPrice + tpVal / denom : entryPrice - tpVal / denom;
    }
    if (tpLevel == null || isNaN(tpLevel)) return false;
    return direction === 'BUY' ? tpLevel <= entryPrice : tpLevel >= entryPrice;
  }

  function updateDealEstimateDisplay() {
    var el = document.getElementById('dealEstTpSl');
    if (!el) return;
    var est = computeEstimatedGainLoss();
    if (!est) {
      el.textContent = '—';
      el.className = 'text-xs font-mono text-slate-400';
    } else {
      var parts = [];
      if (est.tpGain != null) parts.push('TP: ' + formatMoney(est.tpGain, est.currency));
      if (est.slLoss != null) parts.push('SL: ' + formatMoney(est.slLoss, est.currency));
      el.textContent = parts.length ? parts.join(', ') : '—';
      var tpIsLoss = est.tpGain != null && est.tpGain < 0;
      el.className = 'text-xs font-mono ' + (est.tpGain != null && est.slLoss != null ? (tpIsLoss ? 'text-red-500' : 'text-slate-400') : est.tpGain != null ? (tpIsLoss ? 'text-red-500' : 'text-emerald-500') : 'text-red-500');
    }
    var tpWarningEl = document.getElementById('dealTpWarning');
    if (tpWarningEl) {
      if (isTakeProfitLoss()) {
        tpWarningEl.classList.remove('hidden');
      } else {
        tpWarningEl.classList.add('hidden');
      }
    }
  }

  function showDealConfirmModal(params) {
    var instrumentName = epicSelect && epicSelect.options[epicSelect.selectedIndex] ? epicSelect.options[epicSelect.selectedIndex].text : params.epic;
    document.getElementById('confirmInstrument').textContent = instrumentName || params.epic;
    document.getElementById('confirmDirection').textContent = params.direction;
    document.getElementById('confirmDirection').className = 'font-mono ' + (params.direction === 'BUY' ? 'text-emerald-500' : 'text-red-500');
    var bid = state.currentBid;
    var offer = state.currentOffer;
    var livePriceEl = document.getElementById('confirmLivePrice');
    if (livePriceEl) {
      if (bid != null && !isNaN(bid) && offer != null && !isNaN(offer)) {
        livePriceEl.textContent = bid.toFixed(2) + ' / ' + offer.toFixed(2);
        livePriceEl.title = 'Bid / Offer';
      } else {
        livePriceEl.textContent = '—';
        livePriceEl.title = '';
      }
    }
    document.getElementById('confirmSize').textContent = params.size + (state.currentDealCurrency ? ' ' + state.currentDealCurrency : '');
    document.getElementById('confirmTakeProfit').textContent = params.takeProfit || '—';
    document.getElementById('confirmStopLoss').textContent = params.stopLoss || '—';
    document.getElementById('confirmCloseAt').textContent = params.closeAt ? formatTimeWithTz(params.closeAt) : '—';
    var sizeNum = parseFloat(params.size) || 0;
    var price = params.direction === 'BUY' ? state.currentOffer : state.currentBid;
    var positionValue = null;
    var margin = null;
    var fallbackCost = null;
    if (price != null && !isNaN(price) && sizeNum > 0) {
      positionValue = sizeNum * price * state.currentContractSize;
      if (state.currentMarginFactor != null && state.currentMarginFactor > 0) {
        margin = positionValue * state.currentMarginFactor;
      }
      var spread = state.currentSpread;
      if (spread != null && !isNaN(spread) && spread >= 0 && sizeNum > 0) {
        var spreadInPoints = spread;
        if (state.currentScalingFactor != null && state.currentScalingFactor > 0) {
          spreadInPoints = spread / state.currentScalingFactor;
        }
        var valuePerPoint = (state.currentValueOfOnePip != null ? state.currentValueOfOnePip : (state.currentLotSize != null ? state.currentLotSize : state.currentContractSize));
        fallbackCost = 2 * spreadInPoints * sizeNum * valuePerPoint;
      }
    }
    var displayCurrency = state.currentDealCurrency || '—';
    if (state.currentExchangeRateToAccount != null && state.accountCurrency && state.currentDealCurrency !== state.accountCurrency && positionValue != null) {
      positionValue = positionValue * state.currentExchangeRateToAccount;
      if (margin != null) margin = margin * state.currentExchangeRateToAccount;
      if (fallbackCost != null) fallbackCost = fallbackCost * state.currentExchangeRateToAccount;
      displayCurrency = state.accountCurrency;
    } else if (state.accountCurrency) {
      displayCurrency = state.accountCurrency;
    }
    document.getElementById('confirmPositionValue').textContent = positionValue != null ? formatMoney(positionValue, displayCurrency) : '—';
    document.getElementById('confirmMargin').textContent = margin != null ? formatMoney(margin, displayCurrency) : '—';
    document.getElementById('confirmCost').textContent = 'Loading…';
    document.getElementById('confirmCost').setAttribute('data-fallback', fallbackCost != null ? String(fallbackCost) : '');
    document.getElementById('confirmCost').setAttribute('data-currency', displayCurrency);
    pendingDealParams = params;
    var liveWarn = document.getElementById('dealConfirmLiveWarning');
    if (liveWarn) {
      if (state.activeProfile === 'live') liveWarn.classList.remove('hidden');
      else liveWarn.classList.add('hidden');
    }
    if (dealConfirmModal) {
      dealConfirmModal.classList.remove('hidden');
      dealConfirmModal.setAttribute('aria-hidden', 'false');
    }
    socket.emit('getIndicativeCosts', {
      epic: params.epic,
      direction: params.direction,
      size: params.size,
      bid: state.currentBid,
      offer: state.currentOffer,
      currencyCode: state.currentDealCurrency || 'USD'
    });
  }

  socket.on('indicativeCosts', function (data) {
    var el = document.getElementById('confirmCost');
    if (!el || !dealConfirmModal || dealConfirmModal.classList.contains('hidden')) return;
    var displayCurrency = el.getAttribute('data-currency') || (state.accountCurrency || '—');
    if (data.error) {
      var fallback = el.getAttribute('data-fallback');
      el.textContent = fallback ? formatMoney(parseFloat(fallback), displayCurrency) + ' (approx)' : '—';
      return;
    }
    var total = (data.totalCost != null && !isNaN(data.totalCost)) ? data.totalCost : ((data.openingSpread || 0) + (data.closingSpread || 0));
    el.textContent = formatMoney(total, data.currencyCodeISO || displayCurrency);
    el.removeAttribute('data-fallback');
    el.removeAttribute('data-currency');
  });

  function hideDealConfirmModal() {
    pendingDealParams = null;
    if (dealConfirmModal) {
      dealConfirmModal.classList.add('hidden');
      dealConfirmModal.setAttribute('aria-hidden', 'true');
    }
  }

  function hideDealErrorModal() {
    if (dealErrorModal) {
      dealErrorModal.classList.add('hidden');
      dealErrorModal.setAttribute('aria-hidden', 'true');
    }
  }

  function buildDealParams() {
    var epic = epicSelect ? epicSelect.value : '';
    if (!epic) {
      showDealMessage('Select an instrument first');
      return null;
    }
    clearDealMessage();
    var directionEl = document.getElementById('dealDirection');
    var sizeEl = document.getElementById('dealSize');
    var takeProfitEl = document.getElementById('dealTakeProfit');
    var stopLossEl = document.getElementById('dealStopLoss');
    var closeAtEl = document.getElementById('dealCloseAt');
    var size = sizeEl ? sizeEl.value.trim() : '';
    if (!size) {
      size = (sizeEl && sizeEl.placeholder) ? sizeEl.placeholder : '1';
    }
    var sizeNum = parseFloat(size);
    if (state.currentMinDealSize != null && !isNaN(sizeNum) && sizeNum < state.currentMinDealSize) {
      showDealMessage('Size ' + size + ' is below minimum (' + state.currentMinDealSize + ')');
      return null;
    }
    var tpSlMode = document.getElementById('dealTpSlMode');
    var mode = tpSlMode ? tpSlMode.value : 'value';
    var tpRaw = takeProfitEl ? takeProfitEl.value.trim() : '';
    var slRaw = stopLossEl ? stopLossEl.value.trim() : '';
    var entryPrice = directionEl && directionEl.value === 'BUY' ? state.currentOffer : state.currentBid;
    var takeProfit = tpRaw ? parseFloat(tpRaw) : undefined;
    var stopLoss = slRaw ? parseFloat(slRaw) : undefined;
    var needsPrices = (mode === 'pct' || mode === 'value') && (tpRaw || slRaw);
    if (needsPrices && (entryPrice == null || isNaN(entryPrice) || entryPrice <= 0)) {
      showDealMessage('Current prices required for TP/SL in ' + (mode === 'pct' ? '%' : 'value') + ' mode');
      return null;
    }
    if (mode === 'pct' && entryPrice != null && !isNaN(entryPrice) && entryPrice > 0) {
      if (takeProfit != null && !isNaN(takeProfit)) {
        takeProfit = directionEl && directionEl.value === 'BUY'
          ? entryPrice * (1 + takeProfit / 100)
          : entryPrice * (1 - takeProfit / 100);
      }
      if (stopLoss != null && !isNaN(stopLoss)) {
        stopLoss = directionEl && directionEl.value === 'BUY'
          ? entryPrice * (1 - stopLoss / 100)
          : entryPrice * (1 + stopLoss / 100);
      }
    } else if (mode === 'value' && entryPrice != null && !isNaN(entryPrice) && sizeNum > 0 && state.currentContractSize > 0) {
      var denom = sizeNum * state.currentContractSize;
      if (takeProfit != null && !isNaN(takeProfit) && takeProfit > 0) {
        takeProfit = directionEl && directionEl.value === 'BUY'
          ? entryPrice + takeProfit / denom
          : entryPrice - takeProfit / denom;
      }
      if (stopLoss != null && !isNaN(stopLoss) && stopLoss > 0) {
        stopLoss = directionEl && directionEl.value === 'BUY'
          ? entryPrice - stopLoss / denom
          : entryPrice + stopLoss / denom;
      }
    }
    var params = {
      epic: epic,
      direction: directionEl ? directionEl.value : 'BUY',
      size: size,
      takeProfit: takeProfit != null && !isNaN(takeProfit) ? String(takeProfit) : undefined,
      stopLoss: stopLoss != null && !isNaN(stopLoss) ? String(stopLoss) : undefined,
      closeAt: closeAtEl && closeAtEl.value ? closeAtEl.value : undefined,
      bid: (state.currentBid != null && !isNaN(state.currentBid)) ? state.currentBid : undefined,
      offer: (state.currentOffer != null && !isNaN(state.currentOffer)) ? state.currentOffer : undefined
    };
    if (!params.takeProfit) delete params.takeProfit;
    if (!params.stopLoss) delete params.stopLoss;
    if (!params.closeAt) delete params.closeAt;
    return params;
  }

  function buildDealParamsAndShowConfirm() {
    var params = buildDealParams();
    if (params) {
      showDealConfirmModal(params);
      return true;
    }
    return false;
  }

  var lastDealFromRulesEngine = false;
  var dealInProgress = false;

  function placeDealDirect() {
    if (dealInProgress) {
      log('Deal already in progress, skipping duplicate');
      return false;
    }
    var params = buildDealParams();
    if (params) {
      dealInProgress = true;
      state.dealInProgress = true;
      lastDealFromRulesEngine = true;
      log('Rules engine placing deal: ' + params.direction + ' ' + params.size + ' ' + params.epic);
      socket.emit('placeDeal', params);
      return true;
    }
    return false;
  }

  if (dealForm) {
    dealForm.addEventListener('submit', function (e) {
      e.preventDefault();
      buildDealParamsAndShowConfirm();
    });
  }

  if (dealConfirmCancel) dealConfirmCancel.addEventListener('click', hideDealConfirmModal);
  if (dealConfirmOk) dealConfirmOk.addEventListener('click', function () {
    if (dealInProgress) {
      log('Deal already in progress, please wait');
      return;
    }
    if (pendingDealParams) {
      dealInProgress = true;
      state.dealInProgress = true;
      log('Placing deal: ' + pendingDealParams.direction + ' ' + pendingDealParams.size + ' ' + pendingDealParams.epic);
      socket.emit('placeDeal', pendingDealParams);
      hideDealConfirmModal();
    }
  });
  if (dealConfirmModal) {
    dealConfirmModal.addEventListener('click', function (e) {
      if (e.target === dealConfirmModal) hideDealConfirmModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !dealConfirmModal.classList.contains('hidden')) hideDealConfirmModal();
    });
  }

  if (dealErrorOk) dealErrorOk.addEventListener('click', hideDealErrorModal);
  if (dealErrorModal) {
    dealErrorModal.addEventListener('click', function (e) {
      if (e.target === dealErrorModal) hideDealErrorModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dealErrorModal && !dealErrorModal.classList.contains('hidden')) hideDealErrorModal();
    });
  }

  socket.on('price_update', function () {
    setTimeout(updateDealEstimateDisplay, 0);
    var livePriceEl = document.getElementById('confirmLivePrice');
    if (livePriceEl && dealConfirmModal && !dealConfirmModal.classList.contains('hidden')) {
      var bid = state.currentBid;
      var offer = state.currentOffer;
      if (bid != null && !isNaN(bid) && offer != null && !isNaN(offer)) {
        livePriceEl.textContent = bid.toFixed(2) + ' / ' + offer.toFixed(2);
      }
    }
  });

  loadDealSettings();

  setInterval(function () {
    var closeAtEl = document.getElementById('dealCloseAt');
    if (closeAtEl && closeAtEl.value && isCloseAtInPast(closeAtEl.value)) {
      closeAtEl.value = '';
      saveDealSettings();
    }
  }, 60000);

  socket.on('deal_placed', function (data) {
    dealInProgress = false;
    state.dealInProgress = false;
    clearDealMessage();
    if (lastDealFromRulesEngine) {
      lastDealFromRulesEngine = false;
      playSuccessSound();
    }
    // Server already broadcasts "Deal placed" via io.emit('log'); no need to log again
  });

  socket.on('deal_error', function (msg) {
    dealInProgress = false;
    state.dealInProgress = false;
    lastDealFromRulesEngine = false;
    hideDealConfirmModal();
    var errText = document.getElementById('dealErrorText');
    var errModal = document.getElementById('dealErrorModal');
    if (errText) errText.textContent = msg || 'Deal failed';
    if (errModal) {
      errModal.classList.remove('hidden');
      errModal.setAttribute('aria-hidden', 'false');
    }
    log('Deal error: ' + msg);
  });

  socket.on('disconnect', function () {
    dealInProgress = false;
    state.dealInProgress = false;
  });

  return {
    setDealEnabled,
    setPositionsEnabled,
    setOrdersPanelEnabled,
    showDealMessage,
    clearDealMessage,
    triggerDealConfirm: buildDealParamsAndShowConfirm,
    placeDealDirect,
    loadDealSettings
  };
}
