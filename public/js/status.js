/**
 * Version display, status, session connect/disconnect (Probes + Research).
 */
import { state } from './state.js';

export function initStatus(socket, log, opts) {
  var onStopProbing = opts && opts.onStopProbing ? opts.onStopProbing : null;
  const versionEl = document.getElementById('version');
  const statusEl = document.getElementById('status');
  const startBtns = Array.from(document.querySelectorAll('.sessionStartBtn'));
  const stopBtns = Array.from(document.querySelectorAll('.sessionStopBtn'));
  const mainPlaceholder = document.getElementById('mainPlaceholder');

  fetch('/api/version')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (versionEl) versionEl.textContent = 'TiddeliTrade ver: ' + (data.version || '0.0.0');
    })
    .catch(function () {
      if (versionEl) versionEl.textContent = 'TiddeliTrade ver: 0.0.0';
    });

  var STOP_PROBE_TOOLTIP_DEFAULT = 'Stop price stream and probes';
  var STOP_PROBE_TOOLTIP_LOCKED = 'Stop rules trading first — probing cannot be stopped while rules are active';

  function isStopProbingBlocked() {
    return !!state.rulesEngineRunning;
  }

  function setSessionButtons(isRunning, isConnecting, isDisconnected) {
    startBtns.forEach(function (btn) {
      btn.classList.toggle('hidden', isRunning);
      btn.disabled = isRunning || isConnecting;
    });
    stopBtns.forEach(function (btn) {
      btn.classList.toggle('hidden', !isRunning || isDisconnected);
      var blocked = btn.id === 'probesSessionStopBtn' && isStopProbingBlocked();
      btn.disabled = !isRunning || blocked;
      if (btn.id === 'probesSessionStopBtn') {
        btn.setAttribute('data-tooltip', blocked && isRunning ? STOP_PROBE_TOOLTIP_LOCKED : STOP_PROBE_TOOLTIP_DEFAULT);
      }
    });
  }

  function setStatus(status) {
    state.engineStatus = (status === 'disconnected' ? 'ready' : status) || 'ready';
    var label = (status || 'ready').charAt(0).toUpperCase() + (status || 'ready').slice(1);
    if (statusEl) statusEl.textContent = 'Status: ' + label;
    var isRunning = status === 'running';
    var isConnecting = status === 'connecting';
    var isDisconnected = status === 'disconnected';
    setSessionButtons(isRunning, isConnecting, isDisconnected);
    if (mainPlaceholder && isConnecting) {
      mainPlaceholder.textContent = 'Connecting…';
      mainPlaceholder.classList.remove('hidden', 'text-red-500');
    }
    if (opts.onEngineStatusChange) opts.onEngineStatusChange();
  }

  socket.on('status', setStatus);

  socket.on('disconnect', function () {
    setStatus('disconnected');
  });

  function onStartClick() {
    log('Start probing clicked');
    socket.emit('start');
  }

  function onStopClick(ev) {
    var btn = ev && ev.currentTarget;
    if (btn && btn.id === 'probesSessionStopBtn' && isStopProbingBlocked()) {
      log('Stop probing blocked — stop rules trading first');
      return;
    }
    if (btn && btn.id === 'probesSessionStopBtn' && onStopProbing) onStopProbing();
    log('Stop probing clicked');
    socket.emit('stop');
  }

  startBtns.forEach(function (btn) {
    btn.addEventListener('click', onStartClick);
  });
  stopBtns.forEach(function (btn) {
    btn.addEventListener('click', onStopClick);
  });
}
