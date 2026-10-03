/**
 * Account modal — IG credentials, connect/disconnect.
 */
import { state } from './state.js';

function isIgLoggedIn() {
  return state.engineStatus === 'connected' || state.engineStatus === 'running';
}

/**
 * @param {(msg: string) => void} log
 * @param {{ onConfigSaved?: (data: object) => void, socket?: import('socket.io-client').Socket }} [opts]
 */
export function initSettings(log, opts) {
  var onConfigSaved = opts && opts.onConfigSaved ? opts.onConfigSaved : null;
  var socket = opts && opts.socket ? opts.socket : null;

  var settingsModal = document.getElementById('settingsModal');
  var settingsClose = document.getElementById('settingsClose');
  var settingsCancel = document.getElementById('settingsCancel');
  var settingsForm = document.getElementById('settingsForm');
  var settingsStatus = document.getElementById('settingsStatus');
  var profileSelect = document.getElementById('igProfileSelect');
  var accountConnectBtn = document.getElementById('accountConnectBtn');
  var accountDisconnectBtn = document.getElementById('accountDisconnectBtn');
  var accountConnectionStatus = document.getElementById('accountConnectionStatus');
  var credentialsConfigured = false;

  function loadConfigIntoForm() {
    return fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        credentialsConfigured = !!data.credentialsConfigured;
        var usernameEl = document.getElementById('igUsername');
        var apiKeyEl = document.getElementById('igApiKey');
        var passwordEl = document.getElementById('igPassword');
        var baseUrlEl = document.getElementById('igBaseUrl');
        var activeProfile = data.activeProfile || 'demo';
        var profiles = data.igProfilesSafe || { demo: {}, live: {} };
        if (profileSelect) profileSelect.value = activeProfile;
        var p = profiles[activeProfile] || {};
        if (usernameEl) usernameEl.value = p.igUsername || '';
        if (baseUrlEl) {
          baseUrlEl.value = p.igBaseUrl || '';
          baseUrlEl.placeholder = activeProfile === 'live' ? 'https://api.ig.com' : 'https://demo-api.ig.com';
        }
        if (apiKeyEl) { apiKeyEl.value = ''; apiKeyEl.placeholder = p.credentialsConfigured ? '••••••' : 'IG API key'; }
        if (passwordEl) { passwordEl.value = ''; passwordEl.placeholder = p.credentialsConfigured ? '••••••' : 'IG password'; }
        updateConnectionButtons();
        return data;
      })
      .catch(function () { return null; });
  }

  function onProfileChange() {
    var activeProfile = profileSelect && profileSelect.value ? profileSelect.value : 'demo';
    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var usernameEl = document.getElementById('igUsername');
        var apiKeyEl = document.getElementById('igApiKey');
        var passwordEl = document.getElementById('igPassword');
        var baseUrlEl = document.getElementById('igBaseUrl');
        var profiles = data.igProfilesSafe || { demo: {}, live: {} };
        var p = profiles[activeProfile] || {};
        if (usernameEl) usernameEl.value = p.igUsername || '';
        if (baseUrlEl) {
          baseUrlEl.value = p.igBaseUrl || '';
          baseUrlEl.placeholder = activeProfile === 'live' ? 'https://api.ig.com' : 'https://demo-api.ig.com';
        }
        if (apiKeyEl) { apiKeyEl.value = ''; apiKeyEl.placeholder = p.credentialsConfigured ? '••••••' : 'IG API key'; }
        if (passwordEl) { passwordEl.value = ''; passwordEl.placeholder = p.credentialsConfigured ? '••••••' : 'IG password'; }
      })
      .catch(function () {});
  }

  function updateConnectionButtons() {
    var loggedIn = isIgLoggedIn();
    var connecting = state.engineStatus === 'connecting';
    if (accountConnectBtn) {
      accountConnectBtn.classList.toggle('hidden', loggedIn || connecting);
      accountConnectBtn.disabled = connecting || !credentialsConfigured;
    }
    if (accountDisconnectBtn) {
      accountDisconnectBtn.classList.toggle('hidden', !loggedIn || connecting);
    }
    if (accountConnectionStatus) {
      if (connecting) {
        accountConnectionStatus.textContent = 'Connecting…';
        accountConnectionStatus.className = 'text-xs text-slate-400';
      } else if (loggedIn) {
        accountConnectionStatus.textContent = state.engineStatus === 'running'
          ? 'Logged in — stream active'
          : 'Logged in';
        accountConnectionStatus.className = 'text-xs text-emerald-400/90';
      } else if (!credentialsConfigured) {
        accountConnectionStatus.textContent = 'Enter credentials and click OK';
        accountConnectionStatus.className = 'text-xs text-amber-400/90';
      } else {
        accountConnectionStatus.textContent = 'Not connected';
        accountConnectionStatus.className = 'text-xs text-slate-500';
      }
    }
  }

  function showAccount() {
    loadConfigIntoForm();
    if (settingsModal) {
      settingsModal.classList.remove('hidden');
      settingsModal.setAttribute('aria-hidden', 'false');
    }
  }

  function hideAccount() {
    if (settingsModal) {
      settingsModal.classList.add('hidden');
      settingsModal.setAttribute('aria-hidden', 'true');
    }
    if (settingsStatus) {
      settingsStatus.classList.add('hidden');
      settingsStatus.textContent = '';
    }
  }

  function onConnectClick() {
    if (!socket) return;
    if (!credentialsConfigured) {
      if (settingsStatus) {
        settingsStatus.textContent = 'Enter credentials and click OK first.';
        settingsStatus.className = 'text-sm text-amber-400';
        settingsStatus.classList.remove('hidden');
      }
      return;
    }
    if (accountConnectionStatus) {
      accountConnectionStatus.textContent = 'Connecting…';
      accountConnectionStatus.className = 'text-xs text-slate-400';
    }
    socket.emit('connect_ig');
  }

  function onDisconnectClick() {
    if (socket) socket.emit('stop');
  }

  if (settingsClose) settingsClose.addEventListener('click', hideAccount);
  if (settingsCancel) settingsCancel.addEventListener('click', hideAccount);
  if (profileSelect) profileSelect.addEventListener('change', onProfileChange);
  if (accountConnectBtn) accountConnectBtn.addEventListener('click', onConnectClick);
  if (accountDisconnectBtn) accountDisconnectBtn.addEventListener('click', onDisconnectClick);

  if (settingsModal) {
    settingsModal.addEventListener('click', function (e) {
      if (e.target === settingsModal) hideAccount();
    });
  }

  if (socket) {
    socket.on('status', function () {
      updateConnectionButtons();
    });
    socket.on('login_error', function (msg) {
      if (accountConnectionStatus) {
        accountConnectionStatus.textContent = 'Login failed: ' + msg;
        accountConnectionStatus.className = 'text-xs text-red-400';
      }
      updateConnectionButtons();
    });
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var apiKey = document.getElementById('igApiKey');
      var username = document.getElementById('igUsername');
      var password = document.getElementById('igPassword');
      var baseUrlEl = document.getElementById('igBaseUrl');
      var payload = {};
      if (profileSelect && profileSelect.value) payload.activeProfile = profileSelect.value;
      if (baseUrlEl && baseUrlEl.value.trim()) payload.igBaseUrl = baseUrlEl.value.trim();
      if (apiKey && apiKey.value.trim()) payload.igApiKey = apiKey.value.trim();
      if (username && username.value.trim()) payload.igUsername = username.value.trim();
      if (password && password.value.trim()) payload.igPassword = password.value.trim();

      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          credentialsConfigured = !!data.credentialsConfigured;
          log('Account saved');
          if (typeof onConfigSaved === 'function') onConfigSaved(data);
          hideAccount();
        })
        .catch(function (err) {
          log('Account save failed: ' + (err.message || 'Unknown error'));
          if (settingsStatus) {
            settingsStatus.textContent = 'Error: ' + (err.message || 'Failed to save');
            settingsStatus.classList.remove('hidden');
            settingsStatus.className = 'text-sm text-red-500';
          }
        });
    });
  }

  return {
    showAccount: showAccount,
    hideAccount: hideAccount,
    updateConnectionButtons: updateConnectionButtons,
    refreshFromConfig: loadConfigIntoForm
  };
}
