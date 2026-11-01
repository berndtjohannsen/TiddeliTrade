/**
 * Activity log — popup modal (not docked under Trade/Research).
 * Returns the log function after wiring open/close, resize, and unread badge.
 */
import { formatLogTimestamp } from './utils.js';
import { initMainPopoutBridge, wireLogPopoutButtons } from './logPopoutBridge.js';

/** Show/hide a float modal by id; returns whether it is now visible. */
export function setFloatModalOpen(modalId, open) {
  var modal = document.getElementById(modalId);
  if (!modal) return false;
  modal.classList.toggle('hidden', !open);
  modal.setAttribute('aria-hidden', open ? 'false' : 'true');
  return open;
}

export function isFloatModalOpen(modalId) {
  var modal = document.getElementById(modalId);
  return !!(modal && !modal.classList.contains('hidden'));
}

/** Backdrop click, Close buttons, Escape — call once at startup. */
export function initFloatModals() {
  document.addEventListener('click', function (e) {
    var closeId = e.target && e.target.getAttribute && e.target.getAttribute('data-close-modal');
    if (closeId) setFloatModalOpen(closeId, false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    ['appLogModal', 'transactionLogModal', 'recordingLogModal'].forEach(function (id) {
      if (isFloatModalOpen(id)) setFloatModalOpen(id, false);
    });
  });
}

export function initLog() {
  initFloatModals();
  wireLogPopoutButtons(document);

  var logContent = document.getElementById('logContent');
  var logWindow = document.getElementById('logWindow');
  var logResizeHandle = document.getElementById('logResizeHandle');
  var openBtn = document.getElementById('openAppLogBtn');
  var clearBtn = document.getElementById('appLogClearBtn');
  var unreadBadge = document.getElementById('appLogUnreadBadge');
  /** Newest first — mirrored to optional pop-out window. */
  var activityLines = [];

  var publishActivityPopout = initMainPopoutBridge('activity', function () {
    return { lines: activityLines.slice() };
  });

  function setUnread(visible) {
    if (unreadBadge) unreadBadge.classList.toggle('hidden', !visible);
  }

  function openAppLogModal() {
    setFloatModalOpen('appLogModal', true);
    setUnread(false);
    if (logContent) logContent.scrollTop = 0;
  }

  if (openBtn) {
    openBtn.addEventListener('click', function () {
      openAppLogModal();
    });
  }

  if (clearBtn && logContent) {
    clearBtn.addEventListener('click', function () {
      logContent.innerHTML = '';
      activityLines = [];
      publishActivityPopout({ op: 'clear' });
    });
  }

  var openTxBtn = document.getElementById('openTransactionLogBtn');
  if (openTxBtn) {
    openTxBtn.addEventListener('click', function () {
      setFloatModalOpen('transactionLogModal', true);
    });
  }

  var openRecBtn = document.getElementById('openRecordingLogBtn');
  if (openRecBtn) {
    openRecBtn.addEventListener('click', function () {
      setFloatModalOpen('recordingLogModal', true);
    });
  }

  if (logResizeHandle && logWindow) {
    var startY = 0;
    var startHeight = 0;
    var minH = 160;
    var maxH = Math.max(280, window.innerHeight * 0.75);
    fetch('/api/config')
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        var h = cfg.ui && typeof cfg.ui.logWindowHeight === 'number' ? cfg.ui.logWindowHeight : 320;
        h = Math.min(maxH, Math.max(minH, h));
        logWindow.style.height = h + 'px';
      })
      .catch(function () {});
    logResizeHandle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      startY = e.clientY;
      startHeight = logWindow.offsetHeight;
      function onMove(ev) {
        var dy = ev.clientY - startY;
        var h = Math.min(maxH, Math.max(minH, startHeight + dy));
        logWindow.style.height = h + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        var h = parseInt(logWindow.style.height, 10);
        if (!isNaN(h)) {
          fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ui: { logWindowHeight: h } })
          }).catch(function () {});
        }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function log(msg) {
    if (!logContent) return;
    var line = '[' + formatLogTimestamp(new Date().toISOString()) + '] ' + msg;
    var entry = document.createElement('div');
    entry.textContent = line;
    logContent.prepend(entry);
    activityLines.unshift(line);
    while (logContent.childNodes.length > 500) {
      logContent.removeChild(logContent.lastChild);
    }
    while (activityLines.length > 500) activityLines.pop();
    publishActivityPopout({ op: 'line', text: line });
    if (isFloatModalOpen('appLogModal')) {
      logContent.scrollTop = 0;
    } else {
      setUnread(true);
    }
  }

  log.openModal = openAppLogModal;
  return log;
}
