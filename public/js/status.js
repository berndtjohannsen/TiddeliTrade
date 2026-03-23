/**
 * Version display, status, start/stop.
 */
import { state } from './state.js';

export function initStatus(socket, log) {
  const versionEl = document.getElementById('version');
  const statusEl = document.getElementById('status');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const mainPlaceholder = document.getElementById('mainPlaceholder');

  fetch('/api/version')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (versionEl) versionEl.textContent = 'TiddeliTrade ver: ' + (data.version || '0.0.0');
    })
    .catch(function () {
      if (versionEl) versionEl.textContent = 'TiddeliTrade ver: 0.0.0';
    });

  function setStatus(status) {
    state.engineStatus = (status === 'disconnected' ? 'ready' : status) || 'ready';
    var label = (status || 'ready').charAt(0).toUpperCase() + (status || 'ready').slice(1);
    if (statusEl) statusEl.textContent = 'Status: ' + label;
    var isRunning = status === 'running';
    var isConnecting = status === 'connecting';
    var isDisconnected = status === 'disconnected';
    if (startBtn) { startBtn.classList.toggle('hidden', isRunning); startBtn.disabled = isRunning || isConnecting; }
    if (stopBtn) { stopBtn.classList.toggle('hidden', !isRunning || isDisconnected); stopBtn.disabled = !isRunning; }
    if (mainPlaceholder && isConnecting) {
      mainPlaceholder.textContent = 'Connecting...';
      mainPlaceholder.classList.remove('text-red-500');
    }
  }

  socket.on('status', setStatus);

  socket.on('disconnect', function () {
    setStatus('disconnected');
  });

  if (startBtn) {
    startBtn.addEventListener('click', function () {
      log('Start clicked');
      socket.emit('start');
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      log('Stop clicked');
      socket.emit('stop');
    });
  }
}
