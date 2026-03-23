/**
 * Working orders list and cancel order.
 */
import { formatTimeWithTz } from './utils.js';

export function initOrders(socket, state, log) {
  var epicSelect = document.getElementById('epicSelect');

  function resolveInstrumentName(epic) {
    if (!epicSelect) return epic;
    for (var i = 0; i < epicSelect.options.length; i++) {
      if (epicSelect.options[i].value === epic) return epicSelect.options[i].text || epic;
    }
    return epic;
  }

  function renderOrders(orders) {
    var ordersList = document.getElementById('ordersList');
    if (!ordersList) return;
    ordersList.innerHTML = '';
    if (!orders || orders.length === 0) {
      var empty = document.createElement('p');
      empty.id = 'ordersEmpty';
      empty.className = 'text-slate-500 text-xs';
      empty.textContent = 'No working orders';
      ordersList.appendChild(empty);
      return;
    }
    orders.forEach(function (ord) {
      var card = document.createElement('div');
      card.className = 'rounded-lg bg-slate-800 border border-slate-700 p-2 space-y-1';
      var dirClass = ord.direction === 'BUY' ? 'text-emerald-500' : 'text-red-500';
      var name = ord.instrumentName || resolveInstrumentName(ord.epic) || ord.epic || '—';
      var goodTillStr = ord.goodTillDate ? formatTimeWithTz(ord.goodTillDate) : '—';
      var hasScheduledClose = !!ord.scheduledClose;
      var scheduledCloseStr = ord.scheduledClose ? formatTimeWithTz(ord.scheduledClose) : '—';
      var scheduledCloseRow = hasScheduledClose
        ? '<dt class="text-slate-500" data-tooltip="App will auto-close position when order fills">Scheduled close</dt><dd class="font-mono text-slate-400">' + scheduledCloseStr + '</dd>'
        : '';
      card.innerHTML =
        '<div class="flex items-center justify-between gap-2">' +
        '<span class="font-mono text-slate-200 truncate" title="' + (ord.epic || '') + '">' + name + '</span>' +
        '<span class="font-mono ' + dirClass + ' text-xs shrink-0">' + (ord.direction || '') + ' ' + (ord.orderType || 'LIMIT') + '</span>' +
        '</div>' +
        '<dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">' +
        '<dt class="text-slate-500">Size</dt><dd class="font-mono text-slate-300">' + (ord.orderSize != null ? ord.orderSize : '—') + '</dd>' +
        '<dt class="text-slate-500">Trigger</dt><dd class="font-mono text-slate-300">' + (ord.orderLevel != null ? ord.orderLevel : '—') + '</dd>' +
        '<dt class="text-slate-500">Take profit</dt><dd class="font-mono text-slate-400">' + (ord.limitLevel != null ? ord.limitLevel : '—') + '</dd>' +
        '<dt class="text-slate-500">Stop loss</dt><dd class="font-mono text-slate-400">' + (ord.stopLevel != null ? ord.stopLevel : '—') + '</dd>' +
        '<dt class="text-slate-500">Good till</dt><dd class="font-mono text-slate-400">' + goodTillStr + '</dd>' +
        scheduledCloseRow +
        '</dl>' +
        '<button type="button" class="mt-1 w-full px-2 py-1 rounded bg-amber-600/80 hover:bg-amber-600 text-white text-xs font-medium transition-colors" data-deal-id="' + (ord.dealId || '') + '">Cancel order</button>';
      ordersList.appendChild(card);
    });
    ordersList.querySelectorAll('button[data-deal-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dealId = (btn.getAttribute('data-deal-id') || '').trim();
        if (dealId) {
          btn.disabled = true;
          state.pendingDeleteDealId = dealId;
          socket.emit('deleteWorkingOrder', dealId);
        }
      });
    });
  }

  state.recentlyAddedOrders = state.recentlyAddedOrders || {};
  state.recentlyDeletedDealIds = state.recentlyDeletedDealIds || {};
  socket.on('disconnect', function () {
    state.currentWorkingOrders = [];
    renderOrders([]);
  });

  socket.on('working_orders', function (orders) {
    state.currentWorkingOrders = orders || [];
    var filtered = state.currentWorkingOrders.filter(function (o) {
      var oid = (o.dealId || '').toString().trim();
      return !state.recentlyDeletedDealIds[oid];
    });
    var recent = state.recentlyAddedOrders || {};
    var toAdd = [];
    var now = Date.now();
    for (var id in recent) {
      var rid = (id || '').toString().trim();
      if (now - recent[id].at < 30000 && !state.recentlyDeletedDealIds[rid]) {
        var found = filtered.some(function (o) { return (o.dealId || '').toString().trim() === rid; });
        if (!found) toAdd.push(recent[id].order);
      }
    }
    renderOrders(filtered.concat(toAdd));
  });

  socket.on('working_order_added', function (order) {
    if (order && order.epic) {
      var exists = state.currentWorkingOrders.some(function (o) { return o.dealId === order.dealId || o.dealReference === order.dealReference; });
      if (!exists) {
        state.currentWorkingOrders = state.currentWorkingOrders.concat([order]);
        state.recentlyAddedOrders = state.recentlyAddedOrders || {};
        state.recentlyAddedOrders[order.dealId || order.dealReference] = { order: order, at: Date.now() };
        renderOrders(state.currentWorkingOrders);
      }
    }
  });

  function onOrderDeleted(dealId) {
    var id = (dealId || '').toString().trim();
    if (!id) return;
    state.recentlyDeletedDealIds[id] = true;
    if (state.pendingDeleteDealId === id) state.pendingDeleteDealId = null;
    state.currentWorkingOrders = state.currentWorkingOrders.filter(function (o) { return (o.dealId || '').toString().trim() !== id; });
    var ordersList = document.getElementById('ordersList');
    if (ordersList) {
      var btns = ordersList.querySelectorAll('button[data-deal-id]');
      for (var i = 0; i < btns.length; i++) {
        var attrVal = (btns[i].getAttribute('data-deal-id') || '').toString().trim();
        if (attrVal === id) {
          var card = btns[i].closest('.rounded-lg');
          if (card) card.remove();
          if (!ordersList.querySelector('.rounded-lg')) {
            ordersList.innerHTML = '';
            var empty = document.createElement('p');
            empty.id = 'ordersEmpty';
            empty.className = 'text-slate-500 text-xs';
            empty.textContent = 'No working orders';
            ordersList.appendChild(empty);
          }
          break;
        }
      }
    }
    setTimeout(function () { delete state.recentlyDeletedDealIds[id]; }, 60000);
  }

  socket.on('log', function (msg) {
    if (msg && typeof msg === 'string' && msg.indexOf('Order cancelled: ') === 0) {
      onOrderDeleted(msg.replace('Order cancelled: ', '').trim());
    }
  });

  socket.on('working_order_deleted', function (data) {
    onOrderDeleted(data && data.dealId);
  });

  socket.on('order_deleted', function (data) {
    onOrderDeleted(data && data.dealId);
  });

  socket.on('delete_order_error', function (msg) {
    log('Cancel order error: ' + (msg || ''));
    if (state.pendingDeleteDealId) {
      delete state.recentlyDeletedDealIds[state.pendingDeleteDealId];
      state.pendingDeleteDealId = null;
    }
    socket.emit('getWorkingOrders');
  });
}
