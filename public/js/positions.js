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
      var netIfClosed = null;
      if (pos.size != null && pos.level != null && contractSize > 0) {
        var bid, offer;
        if (hasLivePrices && pos.epic === currentEpic) {
          bid = liveBid;
          offer = liveOffer;
        } else {
          bid = typeof pos.bid === 'number' ? pos.bid : parseFloat(pos.bid);
          offer = typeof pos.offer === 'number' ? pos.offer : parseFloat(pos.offer);
        }
        if (!isNaN(bid) && !isNaN(offer)) {
          if (pos.direction === 'BUY') {
            netIfClosed = (bid - pos.level) * pos.size * contractSize;
          } else {
            netIfClosed = (pos.level - offer) * pos.size * contractSize;
          }
        }
      }
      var netStr = netIfClosed != null ? formatMoney(netIfClosed, pos.currency || '') : '—';
      var netClass = netIfClosed != null ? (netIfClosed >= 0 ? 'text-emerald-500' : 'text-red-500') : 'text-slate-300';
      var hasScheduledClose = !!pos.closeAt;
      var openedAtStr = formatTimeWithTz(pos.createdAt);
      var scheduledCloseStrTz = pos.closeAt ? formatTimeWithTz(pos.closeAt) : '—';
      var scheduledCloseRow = '<dt class="text-slate-500" data-tooltip="App will auto-close at this time (app must be running)">Scheduled close</dt><dd class="font-mono text-slate-400">' + scheduledCloseStrTz + '</dd>';
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
        '<dt class="text-slate-500" data-tooltip="When position was opened (local time)">Opened at</dt><dd class="font-mono text-slate-400 text-xs">' + openedAtStr + '</dd>' +
        '<dt class="text-slate-500" data-tooltip="Net gain/loss if closed at current price">Net if closed</dt><dd class="font-mono ' + netClass + '" data-net-value>' + netStr + '</dd>' +
        '<dt class="text-slate-500">Take profit</dt><dd class="font-mono text-slate-400">' + (pos.limitLevel != null ? pos.limitLevel : '—') + '</dd>' +
        '<dt class="text-slate-500">Stop loss</dt><dd class="font-mono text-slate-400">' + (pos.stopLevel != null ? pos.stopLevel : '—') + '</dd>' +
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

  function updateNetValuesOnly() {
    if (!positionsList) return;
    var currentEpic = getCurrentEpic();
    var liveBid = state.currentBid;
    var liveOffer = state.currentOffer;
    if (!currentEpic || liveBid == null || isNaN(liveBid) || liveOffer == null || isNaN(liveOffer)) return;
    var filtered = (state.currentPositions || []).filter(function (p) { return !state.recentlyClosedDealIds[p.dealId]; });
    filtered.forEach(function (pos) {
      if (pos.epic !== currentEpic) return;
      var card = positionsList.querySelector('[data-deal-id="' + (pos.dealId || '') + '"]');
      if (!card) return;
      var netEl = card.querySelector('[data-net-value]');
      if (!netEl) return;
      var contractSize = pos.contractSize != null && pos.contractSize > 0 ? pos.contractSize : 1;
      var netIfClosed = null;
      if (pos.size != null && pos.level != null && contractSize > 0) {
        if (pos.direction === 'BUY') {
          netIfClosed = (liveBid - pos.level) * pos.size * contractSize;
        } else {
          netIfClosed = (pos.level - liveOffer) * pos.size * contractSize;
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
    var currentEpic = getCurrentEpic();
    var hasMatch = state.currentPositions.some(function (p) { return p.epic === currentEpic; });
    if (hasMatch) updateNetValuesOnly();
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
