/**
 * Standalone log pop-out page — receives mirror updates from the main TiddeliTrade tab.
 */
import { logPopoutChannelName } from './logPopoutBridge.js';
import { buildTransactionLogView } from './transactionLog.js';

function viewFromQuery() {
  var params = new URLSearchParams(window.location.search);
  var v = (params.get('view') || 'activity').trim();
  if (v === 'deals' || v === 'recording') return v;
  return 'activity';
}

function setTitle(view) {
  var titles = {
    activity: 'TiddeliTrade — Activity log',
    deals: 'TiddeliTrade — Deals log',
    recording: 'TiddeliTrade — Recording log'
  };
  document.title = titles[view] || titles.activity;
  var heading = document.getElementById('popoutHeading');
  if (heading) heading.textContent = titles[view] || titles.activity;
}

function initActivityPopout(contentEl, scrollEl) {
  function renderLines(lines) {
    if (!contentEl) return;
    contentEl.innerHTML = '';
    if (!lines || !lines.length) {
      contentEl.textContent = '—';
      return;
    }
    for (var i = 0; i < lines.length; i++) {
      var div = document.createElement('div');
      div.textContent = lines[i];
      contentEl.appendChild(div);
    }
  }
  return {
    onSync: function (payload) {
      renderLines(payload && payload.lines ? payload.lines : []);
    },
    onMessage: function (d) {
      if (d.op === 'line' && d.text) {
        if (contentEl && contentEl.textContent === '—') contentEl.textContent = '';
        var entry = document.createElement('div');
        entry.textContent = d.text;
        if (contentEl.firstChild) contentEl.insertBefore(entry, contentEl.firstChild);
        else contentEl.appendChild(entry);
        while (contentEl.childNodes.length > 500) contentEl.removeChild(contentEl.lastChild);
      } else if (d.op === 'clear') {
        renderLines([]);
      }
      if (scrollEl) scrollEl.scrollTop = 0;
    }
  };
}

function hidePopoutRoot(id) {
  var el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function showPopoutRoot(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function applyDealsView(listEl, totalEl, transactions) {
  var view = buildTransactionLogView(transactions || []);
  if (listEl) listEl.innerHTML = view.listHtml;
  if (totalEl) {
    totalEl.textContent = view.totalText;
    totalEl.className = view.totalClass;
  }
}

function initDealsPopout(listEl, totalEl, hintEl) {
  function loadFromServer() {
    fetch('/api/transactions')
      .then(function (r) {
        return r.json();
      })
      .then(function (transactions) {
        applyDealsView(listEl, totalEl, transactions);
        if (hintEl) hintEl.textContent = 'Live from server — updates also mirror the main TiddeliTrade tab.';
      })
      .catch(function () {
        if (hintEl) hintEl.textContent = 'Could not load transactions — check that the main app is running.';
        if (listEl) listEl.innerHTML = '<p class="text-slate-500 text-xs py-2">Failed to load</p>';
      });
  }
  loadFromServer();
  return {
    onSync: function (payload) {
      applyDealsView(listEl, totalEl, payload && payload.transactions);
    },
    onMessage: function (d) {
      if (d.op !== 'deals-snapshot') return;
      applyDealsView(listEl, totalEl, d.transactions);
    },
    refresh: loadFromServer
  };
}

function initRecordingPopout(tbodyEl, scrollEl) {
  return {
    onSync: function (payload) {
      if (tbodyEl && payload && payload.tbodyHtml != null) tbodyEl.innerHTML = payload.tbodyHtml;
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    },
    onMessage: function (d) {
      if (d.op !== 'recording-snapshot') return;
      if (tbodyEl && d.tbodyHtml != null) tbodyEl.innerHTML = d.tbodyHtml;
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  };
}

var view = viewFromQuery();
setTitle(view);

var hint = document.getElementById('popoutHint');
if (hint) {
  hint.textContent =
    'Mirrors the main TiddeliTrade window — keep that tab open. Controls (reset, record) stay in the main app.';
}

var handler = null;
if (view === 'activity') {
  showPopoutRoot('popoutActivityRoot');
  handler = initActivityPopout(
    document.getElementById('popoutActivityContent'),
    document.getElementById('popoutActivityScroll')
  );
  hidePopoutRoot('popoutDealsRoot');
  hidePopoutRoot('popoutRecordingRoot');
} else if (view === 'deals') {
  showPopoutRoot('popoutDealsRoot');
  handler = initDealsPopout(
    document.getElementById('popoutDealsList'),
    document.getElementById('popoutDealsTotal'),
    hint
  );
  hidePopoutRoot('popoutActivityRoot');
  hidePopoutRoot('popoutRecordingRoot');
} else {
  showPopoutRoot('popoutRecordingRoot');
  handler = initRecordingPopout(
    document.getElementById('popoutRecordingBody'),
    document.getElementById('popoutRecordingScroll')
  );
  hidePopoutRoot('popoutActivityRoot');
  hidePopoutRoot('popoutDealsRoot');
}

if (typeof BroadcastChannel === 'undefined') {
  if (hint) hint.textContent = 'BroadcastChannel not supported in this browser — use the in-app log modal instead.';
} else {
  var ch = new BroadcastChannel(logPopoutChannelName(view));
  function requestSync() {
    ch.postMessage({ op: 'sync-request', view: view });
  }
  ch.onmessage = function (e) {
    var d = e && e.data;
    if (!d) return;
    if (d.op === 'sync-request') return;
    if (d.view !== view) return;
    if (d.op === 'sync' && handler) handler.onSync(d.payload);
    else if (handler) handler.onMessage(d);
  };
  requestSync();
  window.addEventListener('focus', function () {
    requestSync();
    if (handler && handler.refresh) handler.refresh();
  });
}
