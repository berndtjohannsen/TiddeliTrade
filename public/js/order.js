/**
 * Order box – Alarm or Execute when price is reached (separate from Deal).
 * One price point: when market reaches it, either notify (Alarm) or trade (Execute).
 */
import { formatMoney, formatTimeWithTz } from './utils.js';
import {
  applyDynamicTpFromConfig,
  isDynamicTpEnabled,
  manualDynamicTpConfigPayload,
  syncDynamicTpUi,
  updateDynamicTpStatusDisplay
} from './dynamicTpUi.js';

export function initOrder(socket, state, log) {
  var orderPanel = document.getElementById('orderPanel');
  var orderMessageEl = document.getElementById('orderMessage');
  var orderForm = document.getElementById('orderForm');
  var epicSelect = document.getElementById('epicSelect');
  var orderConfirmModal = document.getElementById('orderConfirmModal');
  var orderConfirmCancel = document.getElementById('orderConfirmCancel');
  var orderConfirmOk = document.getElementById('orderConfirmOk');
  var pendingOrderParams = null;

  function showOrderMessage(msg) {
    if (orderMessageEl) {
      orderMessageEl.textContent = msg;
      orderMessageEl.classList.remove('hidden');
    }
  }
  function clearOrderMessage() {
    if (orderMessageEl) {
      orderMessageEl.textContent = '';
      orderMessageEl.classList.add('hidden');
    }
  }
  function setOrderEnabled(enabled) {
    var btn = document.getElementById('orderPlaceBtn');
    var form = document.getElementById('orderForm');
    if (btn) btn.disabled = !enabled;
    if (form) {
      var inputs = form.querySelectorAll('input, select');
      inputs.forEach(function (el) { el.disabled = !enabled; });
    }
  }

  function getOrderSettings() {
    var directionEl = document.getElementById('orderDirection');
    var sizeEl = document.getElementById('orderSize');
    var modeEl = document.getElementById('orderTpSlMode');
    var tpEl = document.getElementById('orderTakeProfit');
    var slEl = document.getElementById('orderStopLoss');
    var closeAtEl = document.getElementById('orderCloseAt');
    var stopAtEl = document.getElementById('orderStopAt');
    return {
      orderDirection: directionEl ? directionEl.value : 'BUY',
      orderSize: sizeEl ? sizeEl.value.trim() : '',
      orderTpSlMode: modeEl ? modeEl.value : 'value',
      orderTakeProfit: tpEl ? tpEl.value.trim() : '',
      orderStopLoss: slEl ? slEl.value.trim() : '',
      orderCloseAt: closeAtEl && closeAtEl.value ? closeAtEl.value : '',
      orderStopAt: stopAtEl && stopAtEl.value ? stopAtEl.value : ''
    };
  }

  function saveOrderSettings() {
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    if (!epic) return;
    var s = getOrderSettings();
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var instruments = (cfg.ui && cfg.ui.instruments) ? { ...cfg.ui.instruments } : {};
      instruments[epic] = {
        ...(instruments[epic] || {}),
        orderDirection: s.orderDirection,
        orderSize: s.orderSize,
        orderTpSlMode: s.orderTpSlMode,
        orderTakeProfit: s.orderTakeProfit,
        orderStopLoss: s.orderStopLoss,
        orderCloseAt: s.orderCloseAt || undefined,
        orderStopAt: s.orderStopAt || undefined,
        ...manualDynamicTpConfigPayload()
      };
      return fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui: { instruments: instruments } })
      });
    }).then(function (r) { return r && r.json ? r.json() : {}; }).catch(function () {});
  }

  function loadOrderSettings() {
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      if (!epic && cfg.epic) epic = cfg.epic;
      var ui = cfg.ui || {};
      var inst = (epic && ui.instruments && ui.instruments[epic]) ? ui.instruments[epic] : {};
      var s = { orderDirection: inst.orderDirection || ui.orderDirection, orderSize: inst.orderSize != null ? inst.orderSize : ui.orderSize, orderTpSlMode: inst.orderTpSlMode || ui.orderTpSlMode, orderTakeProfit: inst.orderTakeProfit != null ? inst.orderTakeProfit : ui.orderTakeProfit, orderStopLoss: inst.orderStopLoss != null ? inst.orderStopLoss : ui.orderStopLoss, orderCloseAt: inst.orderCloseAt != null ? inst.orderCloseAt : ui.orderCloseAt, orderStopAt: inst.orderStopAt != null ? inst.orderStopAt : ui.orderStopAt };
      var directionEl = document.getElementById('orderDirection');
      var sizeEl = document.getElementById('orderSize');
      var modeEl = document.getElementById('orderTpSlMode');
      var tpEl = document.getElementById('orderTakeProfit');
      var slEl = document.getElementById('orderStopLoss');
      var closeAtEl = document.getElementById('orderCloseAt');
      var stopAtEl = document.getElementById('orderStopAt');
      if (directionEl && s.orderDirection) directionEl.value = s.orderDirection;
      if (sizeEl && s.orderSize != null) sizeEl.value = s.orderSize;
      if (modeEl && s.orderTpSlMode) modeEl.value = s.orderTpSlMode;
      if (tpEl && s.orderTakeProfit != null) tpEl.value = s.orderTakeProfit;
      if (slEl && s.orderStopLoss != null) slEl.value = s.orderStopLoss;
      if (closeAtEl && s.orderCloseAt) closeAtEl.value = s.orderCloseAt;
      if (stopAtEl && s.orderStopAt) stopAtEl.value = s.orderStopAt;
      applyDynamicTpFromConfig(inst, ui);
      updateOrderTpSlPlaceholders();
    }).catch(function () {});
  }

  var orderStopAtClear = document.getElementById('orderStopAtClear');
  if (orderStopAtClear) {
    orderStopAtClear.addEventListener('click', function () {
      var stopAtEl = document.getElementById('orderStopAt');
      if (stopAtEl) stopAtEl.value = '';
      saveOrderSettings();
    });
  }
  var orderCloseAtClear = document.getElementById('orderCloseAtClear');
  if (orderCloseAtClear) {
    orderCloseAtClear.addEventListener('click', function () {
      var closeAtEl = document.getElementById('orderCloseAt');
      if (closeAtEl) closeAtEl.value = '';
      saveOrderSettings();
    });
  }

  function updateOrderTpSlPlaceholders() {
    var modeEl = document.getElementById('orderTpSlMode');
    var tpEl = document.getElementById('orderTakeProfit');
    var slEl = document.getElementById('orderStopLoss');
    var mode = modeEl ? modeEl.value : 'value';
    var ph = mode === 'value' ? 'e.g. 50' : (mode === 'pct' ? 'e.g. 1.5' : 'e.g. 2650.50');
    if (tpEl) tpEl.placeholder = ph;
    if (slEl) slEl.placeholder = ph;
  }
  var orderTpSlMode = document.getElementById('orderTpSlMode');
  if (orderTpSlMode) {
    orderTpSlMode.addEventListener('change', function () { updateOrderTpSlPlaceholders(); saveOrderSettings(); });
    updateOrderTpSlPlaceholders();
  }
  ['orderDirection', 'orderSize', 'orderTakeProfit', 'orderStopLoss', 'orderCloseAt', 'orderStopAt'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', saveOrderSettings);
      if (id === 'orderSize' || id === 'orderTakeProfit' || id === 'orderStopLoss') el.addEventListener('input', saveOrderSettings);
    }
  });

  function showOrderConfirmModal(params) {
    var instrumentName = epicSelect && epicSelect.options[epicSelect.selectedIndex] ? epicSelect.options[epicSelect.selectedIndex].text : params.epic;
    document.getElementById('orderConfirmInstrument').textContent = instrumentName || params.epic;
    document.getElementById('orderConfirmDirection').textContent = params.direction || '—';
    document.getElementById('orderConfirmDirection').className = 'font-mono ' + (params.direction === 'BUY' ? 'text-emerald-500' : 'text-red-500');
    var bid = state.currentBid;
    var offer = state.currentOffer;
    var livePriceEl = document.getElementById('orderConfirmLivePrice');
    if (livePriceEl) {
      if (bid != null && !isNaN(bid) && offer != null && !isNaN(offer)) {
        livePriceEl.textContent = bid.toFixed(2) + ' / ' + offer.toFixed(2);
        livePriceEl.title = 'Bid / Offer';
      } else {
        livePriceEl.textContent = '—';
        livePriceEl.title = '';
      }
    }
    document.getElementById('orderConfirmPrice').textContent = params.price != null ? params.price : '—';
    document.getElementById('orderConfirmSize').textContent = params.size ? params.size + (state.currentDealCurrency ? ' ' + state.currentDealCurrency : '') : '—';
    document.getElementById('orderConfirmTakeProfit').textContent = isDynamicTpEnabled('manual')
      ? '— (dynamic stop loss)'
      : (params.takeProfit || '—');
    document.getElementById('orderConfirmStopLoss').textContent = params.stopLoss || '—';
    document.getElementById('orderConfirmCloseAt').textContent = params.closeAt ? formatTimeWithTz(params.closeAt) : '—';
    document.getElementById('orderConfirmStopAt').textContent = params.stopAt ? formatTimeWithTz(params.stopAt) : '—';
    var sizeNum = parseFloat(params.size) || 0;
    var price = params.price;
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
    document.getElementById('orderConfirmPositionValue').textContent = positionValue != null ? formatMoney(positionValue, displayCurrency) : '—';
    document.getElementById('orderConfirmMargin').textContent = margin != null ? formatMoney(margin, displayCurrency) : '—';
    document.getElementById('orderConfirmCost').textContent = 'Loading…';
    document.getElementById('orderConfirmCost').setAttribute('data-fallback', fallbackCost != null ? String(fallbackCost) : '');
    document.getElementById('orderConfirmCost').setAttribute('data-currency', displayCurrency);
    pendingOrderParams = params;
    if (orderConfirmModal) {
      orderConfirmModal.classList.remove('hidden');
      orderConfirmModal.setAttribute('aria-hidden', 'false');
    }
    if (params.epic && params.size) {
      socket.emit('getIndicativeCosts', {
        epic: params.epic,
        direction: params.direction,
        size: params.size,
        bid: params.price,
        offer: params.price,
        currencyCode: state.currentDealCurrency || 'USD'
      });
    }
  }

  socket.on('indicativeCosts', function (data) {
    var el = document.getElementById('orderConfirmCost');
    if (!el || !orderConfirmModal || orderConfirmModal.classList.contains('hidden')) return;
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

  function hideOrderConfirmModal() {
    pendingOrderParams = null;
    if (orderConfirmModal) {
      orderConfirmModal.classList.add('hidden');
      orderConfirmModal.setAttribute('aria-hidden', 'true');
    }
  }

  if (orderConfirmCancel) orderConfirmCancel.addEventListener('click', hideOrderConfirmModal);
  if (orderConfirmOk) orderConfirmOk.addEventListener('click', function () {
    if (!pendingOrderParams) return;
    socket.emit('placeOrder', {
        action: 'EXECUTE',
        epic: pendingOrderParams.epic,
        direction: pendingOrderParams.direction,
        price: pendingOrderParams.price,
        size: pendingOrderParams.size,
        takeProfit: pendingOrderParams.takeProfit,
        stopLoss: pendingOrderParams.stopLoss,
        closeAt: pendingOrderParams.closeAt,
        stopAt: pendingOrderParams.stopAt
      });
  });

  socket.on('order_placed', function (data) {
    if (orderConfirmModal && !orderConfirmModal.classList.contains('hidden')) {
      log('Order placed: ' + (data.dealReference || ''));
      showOrderMessage('Order placed in IG.');
      hideOrderConfirmModal();
    }
  });
  socket.on('order_error', function (msg) {
    if (orderConfirmModal && !orderConfirmModal.classList.contains('hidden')) {
      showOrderMessage(msg || 'Order failed');
    } else {
      showOrderMessage(msg || 'Order failed');
    }
  });
  if (orderConfirmModal) {
    orderConfirmModal.addEventListener('click', function (e) {
      if (e.target === orderConfirmModal) hideOrderConfirmModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && orderConfirmModal && !orderConfirmModal.classList.contains('hidden')) hideOrderConfirmModal();
    });
  }

  socket.on('price_update', function () {
    var livePriceEl = document.getElementById('orderConfirmLivePrice');
    if (livePriceEl && orderConfirmModal && !orderConfirmModal.classList.contains('hidden')) {
      var bid = state.currentBid;
      var offer = state.currentOffer;
      if (bid != null && !isNaN(bid) && offer != null && !isNaN(offer)) {
        livePriceEl.textContent = bid.toFixed(2) + ' / ' + offer.toFixed(2);
      }
    }
  });

  socket.on('marketDetails', function (data) {
    var epic = (epicSelect && epicSelect.value) || state.savedEpic;
    if (!data.epic || data.epic !== epic) return;
    var minEl = document.getElementById('orderMinSize');
    if (minEl) {
      var minDealSize = data.minDealSize != null && !isNaN(data.minDealSize) ? data.minDealSize : null;
      if (minDealSize != null) {
        minEl.textContent = 'Min: ' + minDealSize;
        minEl.classList.remove('hidden');
      } else {
        minEl.textContent = 'Min: —';
        minEl.classList.add('hidden');
      }
    }
    var closeAtEl = document.getElementById('orderCloseAt');
    var stopAtEl = document.getElementById('orderStopAt');
    if (data.defaultCloseAt) {
      var d = new Date(data.defaultCloseAt);
      if (!isNaN(d.getTime())) {
        var y = d.getFullYear();
        var mo = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        var h = String(d.getHours()).padStart(2, '0');
        var mi = String(d.getMinutes()).padStart(2, '0');
        if (closeAtEl) closeAtEl.value = y + '-' + mo + '-' + day + 'T' + h + ':' + mi;
        var goodTill = new Date(d.getTime() - 2 * 60 * 1000);
        if (stopAtEl) {
          var gty = goodTill.getFullYear();
          var gtmo = String(goodTill.getMonth() + 1).padStart(2, '0');
          var gtday = String(goodTill.getDate()).padStart(2, '0');
          var gth = String(goodTill.getHours()).padStart(2, '0');
          var gtmi = String(goodTill.getMinutes()).padStart(2, '0');
          stopAtEl.value = gty + '-' + gtmo + '-' + gtday + 'T' + gth + ':' + gtmi;
        }
      }
    }
  });

  if (orderForm) {
    orderForm.addEventListener('submit', function (e) {
      e.preventDefault();
      clearOrderMessage();
      var epic = epicSelect ? epicSelect.value : '';
      if (!epic) {
        showOrderMessage('Select an instrument first');
        return;
      }
      var priceEl = document.getElementById('orderPrice');
      var priceRaw = priceEl ? priceEl.value.trim() : '';
      if (!priceRaw) {
        showOrderMessage('Price is required');
        return;
      }
      var price = parseFloat(priceRaw);
      if (isNaN(price) || price <= 0) {
        showOrderMessage('Price must be a positive number');
        return;
      }
      var sizeEl = document.getElementById('orderSize');
      var sizeRaw = sizeEl ? sizeEl.value.trim() : '';
      if (!sizeRaw) sizeRaw = sizeEl && sizeEl.placeholder ? sizeEl.placeholder : '1';
      var sizeNum = parseFloat(sizeRaw);
      if (isNaN(sizeNum) || sizeNum <= 0) {
        showOrderMessage('Size is required');
        return;
      }
      if (state.currentMinDealSize != null && sizeNum < state.currentMinDealSize) {
        showOrderMessage('Size ' + sizeRaw + ' is below minimum (' + state.currentMinDealSize + ')');
        return;
      }
      var stopAtEl = document.getElementById('orderStopAt');
      var stopAt = stopAtEl && stopAtEl.value ? stopAtEl.value : undefined;
      var directionEl = document.getElementById('orderDirection');
      var direction = directionEl ? directionEl.value : 'BUY';
      var size = sizeRaw || '1';
      var takeProfit = undefined;
      var stopLoss = undefined;
      var closeAt = undefined;
      {
        var takeProfitEl = document.getElementById('orderTakeProfit');
        var stopLossEl = document.getElementById('orderStopLoss');
        var closeAtEl = document.getElementById('orderCloseAt');
        var tpSlModeEl = document.getElementById('orderTpSlMode');
        var mode = tpSlModeEl ? tpSlModeEl.value : 'value';
        var tpRaw = takeProfitEl ? takeProfitEl.value.trim() : '';
        var slRaw = stopLossEl ? stopLossEl.value.trim() : '';
        var entryPrice = price;
        takeProfit = tpRaw ? parseFloat(tpRaw) : undefined;
        stopLoss = slRaw ? parseFloat(slRaw) : undefined;
        var needsPrices = (mode === 'pct' || mode === 'value') && (tpRaw || slRaw);
        if (needsPrices && (entryPrice == null || isNaN(entryPrice) || entryPrice <= 0)) {
          showOrderMessage('Price required for TP/SL in ' + (mode === 'pct' ? '%' : 'value') + ' mode');
          return;
        }
        if (mode === 'pct' && entryPrice != null && !isNaN(entryPrice) && entryPrice > 0) {
          if (takeProfit != null && !isNaN(takeProfit)) {
            takeProfit = direction === 'BUY'
              ? entryPrice * (1 + takeProfit / 100)
              : entryPrice * (1 - takeProfit / 100);
          }
          if (stopLoss != null && !isNaN(stopLoss)) {
            stopLoss = direction === 'BUY'
              ? entryPrice * (1 - stopLoss / 100)
              : entryPrice * (1 + stopLoss / 100);
          }
        } else if (mode === 'value' && entryPrice != null && !isNaN(entryPrice) && sizeNum > 0 && state.currentContractSize > 0) {
          var denom = sizeNum * state.currentContractSize;
          if (takeProfit != null && !isNaN(takeProfit) && takeProfit > 0) {
            takeProfit = direction === 'BUY'
              ? entryPrice + takeProfit / denom
              : entryPrice - takeProfit / denom;
          }
          if (stopLoss != null && !isNaN(stopLoss) && stopLoss > 0) {
            stopLoss = direction === 'BUY'
              ? entryPrice - stopLoss / denom
              : entryPrice + stopLoss / denom;
          }
        }
        takeProfit = takeProfit != null && !isNaN(takeProfit) ? String(takeProfit) : undefined;
        stopLoss = stopLoss != null && !isNaN(stopLoss) ? String(stopLoss) : undefined;
        closeAt = closeAtEl && closeAtEl.value ? closeAtEl.value : undefined;
      }
      var params = {
        action: 'EXECUTE',
        epic: epic,
        direction: direction,
        price: price,
        size: size,
        takeProfit: takeProfit,
        stopLoss: stopLoss,
        closeAt: closeAt,
        stopAt: stopAt
      };
      if (isDynamicTpEnabled('manual')) delete params.takeProfit;
      showOrderConfirmModal(params);
    });
  }

  var orderDynamicStopLoss = document.getElementById('orderDynamicStopLoss');
  if (orderDynamicStopLoss) {
    orderDynamicStopLoss.addEventListener('change', function () {
      syncDynamicTpUi('order');
      saveOrderSettings();
    });
  }
  ['orderDynamicStopLossTrigger', 'orderDynamicStopLossLock'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', function () {
        syncDynamicTpUi('order');
        saveOrderSettings();
      });
      el.addEventListener('input', function () {
        syncDynamicTpUi('order');
        saveOrderSettings();
      });
    }
  });

  socket.on('dynamic_stop_loss_status', function (list) {
    state.dynamicStopLossStatus = Array.isArray(list) ? list : [];
    updateDynamicTpStatusDisplay(state);
  });

  loadOrderSettings();

  return {
    setOrderEnabled,
    showOrderMessage,
    clearOrderMessage,
    loadOrderSettings
  };
}
