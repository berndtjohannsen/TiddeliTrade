/**
 * Log window and log function.
 * Returns the log function after setting up resize handle.
 */
import { formatTimeWithTz } from './utils.js';

export function initLog() {
  var logContent = document.getElementById('logContent');
  var logWindow = document.getElementById('logWindow');
  var logResizeHandle = document.getElementById('logResizeHandle');

  if (logResizeHandle && logWindow) {
    var startY = 0;
    var startHeight = 0;
    var minH = 48;
    var maxH = Math.max(200, window.innerHeight * 0.5);
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var h = cfg.ui && typeof cfg.ui.logWindowHeight === 'number' ? cfg.ui.logWindowHeight : 48;
      h = Math.min(maxH, Math.max(minH, h));
      logWindow.style.height = h + 'px';
    }).catch(function () {});
    logResizeHandle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      startY = e.clientY;
      startHeight = logWindow.offsetHeight;
      function onMove(e) {
        var dy = startY - e.clientY;
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
    var entry = document.createElement('div');
    entry.textContent = '[' + formatTimeWithTz(new Date().toISOString()) + '] ' + msg;
    logContent.appendChild(entry);
    if (logWindow) logWindow.scrollTop = logWindow.scrollHeight;
  }
  return log;
}
