/**
 * Transaction log panel – scrollable list, total, reset. Persisted server-side.
 * Open and close rows with the same deal id share a round-trip # and colour stripe.
 */
import { formatMoney, formatLogTimestamp } from './utils.js';

/** Left-border colours so matching open/close rows are easy to spot. */
var PAIR_BORDER_COLORS = ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#fb7185', '#eab308'];

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function shortDealRef(dealId) {
  var d = String(dealId || '').trim();
  if (!d) return '';
  if (d.length <= 10) return d;
  return '…' + d.slice(-8);
}

function txIsOpen(tx) {
  return tx && tx.type === 'open';
}

/**
 * Assign round-trip numbers in log order (oldest deal id first).
 * @param {object[]} transactions chronological (oldest first)
 */
function buildDealPairMeta(transactions) {
  var meta = {};
  var seq = 0;
  for (var i = 0; i < transactions.length; i++) {
    var did = (transactions[i].dealId || '').trim();
    if (!did) continue;
    if (!meta[did]) {
      seq++;
      meta[did] = { seq: seq, ref: shortDealRef(did), hasOpen: false, hasClosed: false };
    }
    if (txIsOpen(transactions[i])) meta[did].hasOpen = true;
    else meta[did].hasClosed = true;
  }
  return meta;
}

function pairBorderStyle(seq) {
  if (!seq) return '';
  var color = PAIR_BORDER_COLORS[(seq - 1) % PAIR_BORDER_COLORS.length];
  return 'border-left: 3px solid ' + color;
}

export function initTransactionLog(socket) {
  var listEl = document.getElementById('transactionLogList');
  var totalEl = document.getElementById('transactionLogTotal');
  var resetBtn = document.getElementById('transactionLogReset');
  var panelEl = document.getElementById('transactionLogPanel');

  function setPanelEnabled(enabled) {
    if (panelEl) panelEl.classList.toggle('hidden', !enabled);
  }

  function renderTransaction(tx, dealMeta) {
    var isOpen = txIsOpen(tx);
    var did = (tx.dealId || '').trim();
    var pair = did && dealMeta[did] ? dealMeta[did] : null;
    var time = formatLogTimestamp(tx.timestamp);
    var timeTitle = time;
    if (!isOpen && tx.openedAt) {
      timeTitle = 'Closed: ' + time + ' · Opened: ' + formatLogTimestamp(tx.openedAt);
    } else if (isOpen) {
      timeTitle = 'Opened: ' + time;
    }
    if (pair) {
      timeTitle += ' · Round-trip #' + pair.seq;
      if (did) timeTitle += ' · Deal ' + did;
      if (isOpen && pair.hasClosed) timeTitle += ' (close logged)';
      else if (isOpen && !pair.hasClosed) timeTitle += ' (still open or close not in log)';
      else if (!isOpen && pair.hasOpen) timeTitle += ' (matches open row #' + pair.seq + ')';
      else if (!isOpen && !pair.hasOpen) timeTitle += ' (open not in log)';
    }
    var profileBadge = '';
    if (tx.profile === 'live') {
      profileBadge =
        '<span class="shrink-0 px-1 py-0.5 rounded text-[10px] font-semibold bg-amber-600/90 text-amber-950" title="Live account">LIVE</span>';
    } else if (tx.profile === 'demo') {
      profileBadge =
        '<span class="shrink-0 px-1 py-0.5 rounded text-[10px] font-semibold bg-slate-600/80 text-slate-300" title="Demo account">Demo</span>';
    }
    var name = tx.instrumentName || tx.epic || '—';
    var dirClass = tx.direction === 'BUY' ? 'text-emerald-500' : 'text-red-500';
    var plClass = isOpen ? 'text-amber-400' : tx.profitLoss >= 0 ? 'text-emerald-500' : 'text-red-500';
    var plStr = isOpen ? 'Open' : formatMoney(tx.profitLoss, tx.currency || '');
    var entryStr = tx.entry != null ? Number(tx.entry).toFixed(2) : '—';
    var exitStr = tx.exit != null ? Number(tx.exit).toFixed(2) : '—';
    var sizeStr = tx.size != null ? String(tx.size) : '';
    var priceLine = isOpen ? entryStr + ' → —' : entryStr + ' → ' + exitStr;
    var rowBg = isOpen ? 'bg-slate-800/40' : '';
    var borderStyle = pair ? pairBorderStyle(pair.seq) : isOpen ? 'border-left: 2px solid rgb(245 158 11 / 0.5)' : '';
    var pairLabel = pair
      ? '<span class="shrink-0 w-9 text-center text-slate-400 font-semibold" title="' +
        escAttr('Round-trip #' + pair.seq + (pair.ref ? ' · ' + pair.ref : '')) +
        '">#' +
        pair.seq +
        '</span>'
      : '<span class="shrink-0 w-9 text-center text-slate-600" title="No deal id">—</span>';
    var legBadge = isOpen
      ? '<span class="shrink-0 text-[10px] uppercase tracking-wide text-amber-400/90" title="Position opened">Open</span>'
      : '<span class="shrink-0 text-[10px] uppercase tracking-wide text-slate-500" title="Position closed">Close</span>';
    return (
      '<div class="flex items-center gap-2 py-1.5 px-2 border-b border-slate-800/50 last:border-0 text-xs whitespace-nowrap flex-nowrap ' +
      rowBg +
      '" style="' +
      escAttr(borderStyle) +
      '">' +
      '<span class="text-slate-500 shrink-0 min-w-[10.5rem]" title="' +
      escAttr(timeTitle) +
      '">' +
      time +
      '</span>' +
      pairLabel +
      legBadge +
      profileBadge +
      '<span class="text-slate-300 min-w-0 truncate flex-1" title="' +
      escAttr(tx.epic || '') +
      '">' +
      escAttr(name) +
      '</span>' +
      '<span class="' +
      dirClass +
      ' shrink-0">' +
      escAttr(tx.direction || '') +
      (sizeStr ? ' ' + escAttr(sizeStr) : '') +
      '</span>' +
      '<span class="text-slate-500 font-mono shrink-0">' +
      escAttr(priceLine) +
      '</span>' +
      '<span class="' +
      plClass +
      ' shrink-0 font-medium ml-auto text-right min-w-[4.5rem]">' +
      escAttr(plStr) +
      '</span>' +
      '</div>'
    );
  }

  function renderListHeader() {
    return (
      '<div class="flex items-center gap-2 py-1 px-2 text-[10px] uppercase tracking-wide text-slate-600 border-b border-slate-800 sticky top-0 bg-slate-900/95 z-[1]">' +
      '<span class="shrink-0 min-w-[10.5rem]">Time</span>' +
      '<span class="shrink-0 w-9 text-center" title="Same # and stripe = same round-trip">#</span>' +
      '<span class="shrink-0 w-10">Leg</span>' +
      '<span class="shrink-0 w-8"></span>' +
      '<span class="flex-1 min-w-0">Instrument</span>' +
      '<span class="shrink-0">Side</span>' +
      '<span class="shrink-0">Entry → exit</span>' +
      '<span class="shrink-0 ml-auto text-right min-w-[4.5rem]">P/L</span>' +
      '</div>'
    );
  }

  function render(transactions) {
    if (!listEl || !totalEl) return;
    var chronological = Array.isArray(transactions) ? transactions.slice() : [];
    var dealMeta = buildDealPairMeta(chronological);
    var list = chronological.slice().reverse();
    if (list.length === 0) {
      listEl.innerHTML = '<p class="text-slate-500 text-xs py-2">No transactions</p>';
    } else {
      listEl.innerHTML = renderListHeader() + list.map(function (tx) {
        return renderTransaction(tx, dealMeta);
      }).join('');
    }
    var totalsByCur = {};
    chronological.forEach(function (tx) {
      if (tx.type === 'open') return;
      var c = tx.currency && String(tx.currency).trim() ? String(tx.currency).trim() : '—';
      totalsByCur[c] = (totalsByCur[c] || 0) + (tx.profitLoss || 0);
    });
    var curKeys = Object.keys(totalsByCur);
    if (curKeys.length === 0) {
      totalEl.textContent = '—';
    } else if (curKeys.length === 1) {
      totalEl.textContent = formatMoney(totalsByCur[curKeys[0]], curKeys[0]);
    } else {
      curKeys.sort();
      totalEl.textContent = curKeys.map(function (c) {
        return formatMoney(totalsByCur[c], c);
      }).join(' + ');
    }
    var singleTotal = curKeys.length === 1 ? totalsByCur[curKeys[0]] : null;
    totalEl.className =
      'font-mono font-semibold ' +
      (curKeys.length === 1 ? (singleTotal >= 0 ? 'text-emerald-500' : 'text-red-500') : 'text-slate-300');
  }

  function load() {
    fetch('/api/transactions')
      .then(function (r) {
        return r.json();
      })
      .then(render)
      .catch(function () {
        if (listEl) listEl.innerHTML = '<p class="text-slate-500 text-xs py-2">Failed to load</p>';
      });
  }

  socket.on('transaction_added', function (tx) {
    if (!tx) return;
    fetch('/api/transactions')
      .then(function (r) {
        return r.json();
      })
      .then(render)
      .catch(function () {});
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      fetch('/api/transactions/reset', { method: 'POST' })
        .then(function (r) {
          return r.json();
        })
        .then(render)
        .catch(function () {});
    });
  }

  load();

  return { setTransactionLogPanelEnabled: setPanelEnabled };
}
