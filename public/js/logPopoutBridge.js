/**
 * Optional log pop-out windows (second monitor) — BroadcastChannel sync from main app only.
 * Does not start a second price stream or rules engine.
 */

var POPOUT_FEATURES = 'popup=yes,width=780,height=460,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes';
var popoutByView = {};
var popoutOpenHooks = {};

export function registerPopoutOpenHook(view, fn) {
  if (view && typeof fn === 'function') popoutOpenHooks[view] = fn;
}

function runPopoutOpenHook(view) {
  var fn = popoutOpenHooks[view];
  if (!fn) return;
  fn();
  window.setTimeout(fn, 250);
}

export function logPopoutChannelName(view) {
  return 'tiddeli-log-popout-' + view;
}

/** Open or focus a dedicated log window (must be called from a user gesture). */
export function openLogPopout(view) {
  var url = '/log-popout.html?view=' + encodeURIComponent(view);
  var targetName = 'tiddeli-log-' + view;
  var existing = popoutByView[view];
  if (existing && !existing.closed) {
    existing.focus();
    runPopoutOpenHook(view);
    return existing;
  }
  var win = window.open(url, targetName, POPOUT_FEATURES);
  if (win) popoutByView[view] = win;
  runPopoutOpenHook(view);
  return win;
}

/**
 * Main window: listen for sync-request and publish updates to pop-out.
 * @param {string} view activity | deals | recording
 * @param {function(): object} getSyncPayload
 * @returns {function(object): void}
 */
export function initMainPopoutBridge(view, getSyncPayload) {
  if (typeof BroadcastChannel === 'undefined') {
    return function () {};
  }
  var ch = new BroadcastChannel(logPopoutChannelName(view));
  ch.onmessage = function (e) {
    var d = e && e.data;
    if (d && d.op === 'sync-request' && d.view === view) {
      ch.postMessage({ op: 'sync', view: view, payload: getSyncPayload() });
    }
  };
  return function publish(msg) {
    var payload = msg || {};
    payload.view = view;
    ch.postMessage(payload);
  };
}

/** Wire "Pop out" buttons (data-log-popout="activity|deals|recording"). */
export function wireLogPopoutButtons(root) {
  var scope = root || document;
  var buttons = scope.querySelectorAll('[data-log-popout]');
  for (var i = 0; i < buttons.length; i++) {
    (function (btn) {
      if (btn.getAttribute('data-log-popout-wired') === '1') return;
      btn.setAttribute('data-log-popout-wired', '1');
      btn.addEventListener('click', function () {
        var view = btn.getAttribute('data-log-popout');
        if (view) openLogPopout(view);
      });
    })(buttons[i]);
  }
}
