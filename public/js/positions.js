/**
 * Positions list and close position.
 */
import { formatMoney, formatTimeWithTz } from './utils.js';

export function initPositions(socket, state, showDealMessage, clearDealMessage, log) {
  var positionsList = document.getElementById('positionsList');
  var positionsEmpty = document.getElementById('positionsEmpty');
  var epicSelect = document.getElementById('epicSelect');

  function resolveInstrumentName(epic) {
    if (!epicSelect) return epic;
    for (var i = 0; i < epicSelect.options.length; i++) {
      if (epicSelect.options[i].value === epic) return epicSelect.options[i].text || epic;
    }
    return epic;
  }

  function getCurrentEpic() {
    return (epicSelect && epicSelect.value) || state.savedEpic || '';
  }

  function resolveBidOffer(pos, currentEpic, liveBid, liveOffer, hasLivePrices) {
    if (hasLivePrices && pos.epic === currentEpic) {
      return { bid: liveBid, offer: liveOffer, live: true };
    }
    var bid = typeof pos.bid === 'number' ? pos.bid : parseFloat(pos.bid);
    var offer = typeof pos.offer === 'number' ? pos.offer : parseFloat(pos.offer);
    if (isNaN(bid) || isNaN(offer)) return { bid: null, offer: null, live: false };
    return { bid: bid, offer: offer, live: false };
  }

  function formatPrice(val) {
    if (val == null || isNaN(val)) return '—';
    return val >= 1000 || val <= -1000
      ? val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : String(val);
  }

  function buildDynamicStopLossRows(dealId, currency) {
    var dslList = state.dynamicStopLossStatus || [];
    for (var di = 0; di < dslList.length; di++) {
      if (dslList[di].dealId !== dealId) continue;
      var dsl = dslList[di];
      var cur = currency || '';
      var triggerStr = dsl.triggerProfit != null && !isNaN(dsl.triggerProfit)
        ? formatMoney(dsl.triggerProfit, cur)
        : '—';
      var lockStr = dsl.lockProfit != null && !isNaN(dsl.lockProfit)
        ? formatMoney(dsl.lockProfit, cur)
        : '—';
      var stepStr = dsl.minStepProfit != null && !isNaN(dsl.minStepProfit) && dsl.minStepProfit > 0
        ? formatMoney(dsl.minStepProfit, cur)
        : '—';
      var highestLockStr = dsl.highestLockApplied > 0
        ? formatMoney(dsl.highestLockApplied, cur)
        : '—';
      var lastStopStr = dsl.lastStopLevel != null && !isNaN(dsl.lastStopLevel) ? formatPrice(dsl.lastStopLevel) : '—';
      var statusStr = dsl.lastMessage || 'Active';
      return (
        '<dt class="text-slate-500" data-tooltip="Profit before trailing starts">DSL trigger</dt><dd class="font-mono text-amber-400/90">' + triggerStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="Initial locked profit once trigger is hit">DSL lock</dt><dd class="font-mono text-amber-400/90">' + lockStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="Minimum profit step before stop is amended again">DSL min step</dt><dd class="font-mono text-amber-400/90">' + stepStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="Highest locked profit applied so far">DSL lock applied</dt><dd class="font-mono text-amber-400/90">' + highestLockStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="Last stop level sent to IG">DSL stop level</dt><dd class="font-mono text-amber-400/90">' + lastStopStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="App is trailing stop on IG (no take profit)">DSL status</dt><dd class="font-mono text-amber-400/90 text-[10px]">' + statusStr + '</dd>'
      );
    }
    return '';
  }

  function renderPositions(positions) {
    if (!positionsList || !positionsEmpty) return;
    var currentEpic = getCurrentEpic();
    var liveBid = state.currentBid;
    var liveOffer = state.currentOffer;
    var hasLivePrices = currentEpic && liveBid != null && !isNaN(liveBid) && liveOffer != null && !isNaN(liveOffer);
    positionsList.innerHTML = '';
    if (!positions || positions.length === 0) {
      var empty = document.createElement('p');
      empty.id = 'positionsEmpty';
      empty.className = 'text-slate-500 text-xs';
      empty.textContent = 'No open positions';
      positionsList.appendChild(empty);
      return;
    }
    positions.forEach(function (pos) {
      var card = document.createElement('div');
      card.className = 'rounded-lg bg-slate-800 border border-slate-700 p-2 space-y-1';
      card.setAttribute('data-deal-id', pos.dealId || '');
      var dirClass = pos.direction === 'BUY' ? 'text-emerald-500' : 'text-red-500';
      var name = pos.instrumentName || resolveInstrumentName(pos.epic) || pos.epic || '—';
      var contractSize = pos.contractSize != null && pos.contractSize > 0 ? pos.contractSize : 1;
      var posValue = (pos.size != null && pos.level != null) ? pos.size * pos.level * contractSize : null;
      var posValueStr = posValue != null ? formatMoney(posValue, pos.currency || '') : '—';
      var prices = resolveBidOffer(pos, currentEpic, liveBid, liveOffer, hasLivePrices);
      var buyStr = formatPrice(prices.offer);
      var sellStr = formatPrice(prices.bid);
      var priceLiveClass = prices.live ? ' text-emerald-400/90' : '';
      var netIfClosed = null;
      if (pos.size != null && pos.level != null && contractSize > 0 && prices.bid != null && prices.offer != null) {
        if (pos.direction === 'BUY') {
          netIfClosed = (prices.bid - pos.level) * pos.size * contractSize;
        } else {
          netIfClosed = (pos.level - prices.offer) * pos.size * contractSize;
        }
      }
      var netStr = netIfClosed != null ? formatMoney(netIfClosed, pos.currency || '') : '—';
      var netClass = netIfClosed != null ? (netIfClosed >= 0 ? 'text-emerald-500' : 'text-red-500') : 'text-slate-300';
      var hasScheduledClose = !!pos.closeAt;
      var openedAtStr = formatTimeWithTz(pos.createdAt);
      var scheduledCloseStrTz = pos.closeAt ? formatTimeWithTz(pos.closeAt) : '—';
      var scheduledCloseRow = '<dt class="text-slate-500" data-tooltip="App will auto-close at this time (app must be running)">Scheduled close</dt><dd class="font-mono text-slate-400">' + scheduledCloseStrTz + '</dd>';
      var dslRows = buildDynamicStopLossRows(pos.dealId, pos.currency || '');
      var cancelSchedBtn = hasScheduledClose
        ? '<button type="button" class="mt-1 w-full px-2 py-1 rounded bg-amber-600/80 hover:bg-amber-600 text-white text-xs font-medium transition-colors cancel-scheduled-close" data-deal-id="' + (pos.dealId || '') + '">Cancel scheduled close</button>'
        : '';
      card.innerHTML =
        '<div class="flex items-center justify-between gap-2">' +
        '<span class="font-mono text-slate-200 truncate" title="' + (pos.epic || '') + '">' + name + '</span>' +
        '<span class="font-mono ' + dirClass + ' text-xs shrink-0">' + (pos.direction || '') + '</span>' +
        '</div>' +
        '<dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">' +
        '<dt class="text-slate-500">Size</dt><dd class="font-mono text-slate-300">' + (pos.size != null ? pos.size : '—') + '</dd>' +
        '<dt class="text-slate-500">Entry</dt><dd class="font-mono text-slate-300">' + (pos.level != null ? pos.level : '—') + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="Current ask — price to buy (live when streaming this epic)">Buy</dt><dd class="font-mono text-slate-300' + priceLiveClass + '" data-buy-value>' + buyStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="Current bid — price to sell (live when streaming this epic)">Sell</dt><dd class="font-mono text-slate-300' + priceLiveClass + '" data-sell-value>' + sellStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="When position was opened (local time)">Opened at</dt><dd class="font-mono text-slate-400 text-xs">' + openedAtStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="Net gain/loss if closed at current price">Net if closed</dt><dd class="font-mono ' + netClass + '" data-net-value>' + netStr + '</dd>' +
        '<dt class="text-slate-500">Take profit</dt><dd class="font-mono text-slate-400">' + (pos.limitLevel != null ? pos.limitLevel : '—') + '</dd>' +
        '<dt class="text-slate-500">Stop loss</dt><dd class="font-mono text-slate-400">' + (pos.stopLevel != null ? pos.stopLevel : '—') + '</dd>' +
        dslRows +
        scheduledCloseRow +
        '<dt class="text-slate-500">Position value</dt><dd class="font-mono text-slate-300">' + posValueStr + '</dd>' +
        '</dl>' +
        cancelSchedBtn +
        '<button type="button" class="mt-1 w-full px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 text-white text-xs font-medium transition-colors" data-deal-id="' + (pos.dealId || '') + '" data-epic="' + (pos.epic || '') + '" data-expiry="' + (pos.expiry || '-') + '" data-direction="' + (pos.direction || '') + '" data-size="' + (pos.size != null ? pos.size : 0) + '">Close position</button>';
      positionsList.appendChild(card);
    });
    positionsList.querySelectorAll('button[data-deal-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dealId = btn.getAttribute('data-deal-id');
        if (btn.classList.contains('cancel-scheduled-close')) {
          if (dealId) {
            btn.disabled = true;
            socket.emit('cancelScheduledClose', dealId);
          }
          return;
        }
        var epic = btn.getAttribute('data-epic');
        var expiry = btn.getAttribute('data-expiry');
        var direction = btn.getAttribute('data-direction');
        var size = parseFloat(btn.getAttribute('data-size') || '0');
        if (epic && expiry && direction && !isNaN(size) && size > 0) {
          btn.disabled = true;
          socket.emit('closePosition', { dealId: dealId, epic: epic, expiry: expiry, direction: direction, size: size });
        }
      });
    });
  }

  socket.on('positions', function (positions) {
    state.currentPositions = positions || [];
    var filtered = state.currentPositions.filter(function (p) { return !state.recentlyClosedDealIds[p.dealId]; });
    renderPositions(filtered);
  });

  socket.on('dynamic_stop_loss_status', function (list) {
    state.dynamicStopLossStatus = Array.isArray(list) ? list : [];
    var filtered = (state.currentPositions || []).filter(function (p) { return !state.recentlyClosedDealIds[p.dealId]; });
    if (filtered.length > 0) renderPositions(filtered);
  });

  function updateLivePriceFields() {
    if (!positionsList) return;
    var currentEpic = getCurrentEpic();
    var liveBid = state.currentBid;
    var liveOffer = state.currentOffer;
    var hasLivePrices = currentEpic && liveBid != null && !isNaN(liveBid) && liveOffer != null && !isNaN(liveOffer);
    var filtered = (state.currentPositions || []).filter(function (p) { return !state.recentlyClosedDealIds[p.dealId]; });
    filtered.forEach(function (pos) {
      var prices = resolveBidOffer(pos, currentEpic, liveBid, liveOffer, hasLivePrices);
      var card = positionsList.querySelector('[data-deal-id="' + (pos.dealId || '') + '"]');
      if (!card) return;
      var buyEl = card.querySelector('[data-buy-value]');
      var sellEl = card.querySelector('[data-sell-value]');
      var netEl = card.querySelector('[data-net-value]');
      if (buyEl) {
        buyEl.textContent = formatPrice(prices.offer);
        buyEl.className = 'font-mono text-slate-300' + (prices.live ? ' text-emerald-400/90' : '');
      }
      if (sellEl) {
        sellEl.textContent = formatPrice(prices.bid);
        sellEl.className = 'font-mono text-slate-300' + (prices.live ? ' text-emerald-400/90' : '');
      }
      if (!netEl) return;
      var contractSize = pos.contractSize != null && pos.contractSize > 0 ? pos.contractSize : 1;
      var netIfClosed = null;
      if (pos.size != null && pos.level != null && contractSize > 0 && prices.bid != null && prices.offer != null) {
        if (pos.direction === 'BUY') {
          netIfClosed = (prices.bid - pos.level) * pos.size * contractSize;
        } else {
          netIfClosed = (pos.level - prices.offer) * pos.size * contractSize;
        }
      }
      var netStr = netIfClosed != null ? formatMoney(netIfClosed, pos.currency || '') : '—';
      var netClass = netIfClosed != null ? (netIfClosed >= 0 ? 'text-emerald-500' : 'text-red-500') : 'text-slate-300';
      netEl.textContent = netStr;
      netEl.className = 'font-mono ' + netClass;
    });
  }

  socket.on('price_update', function () {
    if (!state.currentPositions || state.currentPositions.length === 0) return;
    updateLivePriceFields();
  });

  socket.on('disconnect', function () {
    state.currentPositions = [];
    renderPositions([]);
  });

  socket.on('position_closed', function (data) {
    clearDealMessage();
    var dealId = data && data.dealId;
    if (dealId) {
      state.recentlyClosedDealIds[dealId] = true;
      state.currentPositions = state.currentPositions.filter(function (p) { return p.dealId !== dealId; });
      renderPositions(state.currentPositions);
      setTimeout(function () { delete state.recentlyClosedDealIds[dealId]; }, 60000);
    }
  });

  socket.on('close_position_error', function (msg) {
    showDealMessage(msg || 'Close failed');
    log('Close position error: ' + msg);
    socket.emit('getPositions');
  });
}
