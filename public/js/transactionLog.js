/**
 * Transaction log panel – scrollable list, total, reset. Persisted server-side.
 */
import { formatMoney, formatTimeWithTz, playSuccessSound } from './utils.js';

export function initTransactionLog(socket) {
  var listEl = document.getElementById('transactionLogList');
  var totalEl = document.getElementById('transactionLogTotal');
  var resetBtn = document.getElementById('transactionLogReset');
  var panelEl = document.getElementById('transactionLogPanel');

  function setPanelEnabled(enabled) {
    if (panelEl) panelEl.classList.toggle('hidden', !enabled);
  }

  function renderTransaction(tx) {
    var time = formatTimeWithTz(tx.timestamp);
    var name = tx.instrumentName || tx.epic || '—';
    var dirClass = tx.direction === 'BUY' ? 'text-emerald-500' : 'text-red-500';
    var isOpen = tx.type === 'open';
    var plClass = isOpen ? 'text-amber-400' : (tx.profitLoss >= 0 ? 'text-emerald-500' : 'text-red-500');
    var plStr = isOpen ? 'Open' : formatMoney(tx.profitLoss, tx.currency || '');
    var entryStr = tx.entry != null ? Number(tx.entry).toFixed(2) : '—';
    var exitStr = tx.exit != null ? Number(tx.exit).toFixed(2) : '—';
    var sizeStr = tx.size != null ? String(tx.size) : '';
    var priceLine = isOpen ? entryStr + ' → —' : entryStr + ' → ' + exitStr;
    var rowBg = isOpen ? 'bg-slate-800/50' : '';
    var rowBorder = isOpen ? 'border-l-2 border-amber-500/70' : '';
    return '<div class="flex items-center gap-3 py-1.5 px-2 border-b border-slate-800/50 last:border-0 text-xs whitespace-nowrap flex-nowrap ' + rowBg + ' ' + rowBorder + '">' +
      '<span class="text-slate-500 shrink-0 min-w-[7.5rem]" title="' + time + '">' + time + '</span>' +
      '<span class="text-slate-300 min-w-0 truncate flex-1" title="' + (tx.epic || '') + '">' + name + '</span>' +
      '<span class="' + dirClass + ' shrink-0">' + (tx.direction || '') + (sizeStr ? ' ' + sizeStr : '') + '</span>' +
      '<span class="text-slate-500 font-mono shrink-0">' + priceLine + '</span>' +
      '<span class="' + plClass + ' shrink-0 font-medium ml-auto text-right">' + plStr + '</span>' +
      '</div>';
  }

  function render(transactions) {
    if (!listEl || !totalEl) return;
    var list = Array.isArray(transactions) ? transactions : [];
    list = list.slice().reverse();
    if (list.length === 0) {
      listEl.innerHTML = '<p class="text-slate-500 text-xs py-2">No transactions</p>';
    } else {
      listEl.innerHTML = list.map(renderTransaction).join('');
    }
    var total = list.reduce(function (sum, tx) { return sum + (tx.type === 'open' ? 0 : (tx.profitLoss || 0)); }, 0);
    var currency = list.length > 0 && list[0].currency ? list[0].currency : '';
    totalEl.textContent = formatMoney(total, currency);
    totalEl.className = 'font-mono font-semibold ' + (total >= 0 ? 'text-emerald-500' : 'text-red-500');
  }

  function load() {
    fetch('/api/transactions').then(function (r) { return r.json(); }).then(render).catch(function () {
      if (listEl) listEl.innerHTML = '<p class="text-slate-500 text-xs py-2">Failed to load</p>';
    });
  }

  socket.on('transaction_added', function (tx) {
    if (!tx) return;
    if (tx.type !== 'open' && typeof tx.profitLoss === 'number' && tx.profitLoss > 0) playSuccessSound();
    fetch('/api/transactions').then(function (r) { return r.json(); }).then(render).catch(function () {});
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      fetch('/api/transactions/reset', { method: 'POST' }).then(function (r) { return r.json(); }).then(render).catch(function () {});
    });
  }

  load();

  return { setTransactionLogPanelEnabled: setPanelEnabled };
}
