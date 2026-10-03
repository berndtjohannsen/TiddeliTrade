/**
 * Home screen — IG connect, instrument pick, Trade / Research workspace entry.
 * Launch Connect = IG login only (connect_ig). Workspace Start session = stream + trading.
 */

import { hideAppBootOverlay } from './utils.js';

function needsSetup(cfg) {
  if (!cfg) return true;
  if (cfg.ui && cfg.ui.setupComplete) return false;
  if (cfg.credentialsConfigured && cfg.epic) return false;
  if (!cfg.credentialsConfigured) return true;
  if (!cfg.epic) return true;
  return true;
}

function formatInstrumentLabel(cfg) {
  if (!cfg || !cfg.epic) return '';
  if (cfg.epicDisplayName && cfg.epic) return cfg.epicDisplayName + ' (' + cfg.epic + ')';
  return cfg.epic;
}

/** Header instrument: only when in workspace and logged in to IG (not on Home). */
export function syncHeaderInstrument(state, cfg) {
  var el = document.getElementById('headerInstrument');
  if (!el) return;
  var onHome = isLaunchVisible();
  var loggedIn = state && (state.engineStatus === 'connected' || state.engineStatus === 'running');
  if (onHome || !loggedIn || !cfg || !cfg.epic) {
    el.textContent = '—';
    el.title = 'Instrument';
    return;
  }
  var label = formatInstrumentLabel(cfg);
  el.textContent = label || '—';
  el.title = cfg.epic || 'Instrument';
}

function isLaunchVisible() {
  var lp = document.getElementById('launchPanel');
  return lp && !lp.classList.contains('hidden');
}

function isIgLoggedIn(state) {
  return state.engineStatus === 'connected' || state.engineStatus === 'running';
}

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {{ activeProfile?: string, savedEpic?: string, engineStatus?: string, rulesEngineRunning?: boolean }} state
 * @param {ReturnType<import('./appView.js').initAppView>} appView
 * @param {(msg: string) => void} log
 * @param {{ onEnterWorkspace?: (view: 'trade'|'research') => void, onEpicSaved?: (epic: string) => void, accountApi?: { showAccount?: () => void }, prepareForHome?: () => void, showConfirm?: (options: object) => Promise<boolean> }} [opts]
 */
export function initOnboarding(socket, state, appView, log, opts) {
  var onEnterWorkspace = opts && opts.onEnterWorkspace ? opts.onEnterWorkspace : null;
  var onEpicSaved = opts && opts.onEpicSaved ? opts.onEpicSaved : null;
  var accountApi = opts && opts.accountApi ? opts.accountApi : null;
  var prepareForHome = opts && opts.prepareForHome ? opts.prepareForHome : null;
  var showConfirm = opts && opts.showConfirm ? opts.showConfirm : null;

  var launchPanel = document.getElementById('launchPanel');
  var connectionBar = document.getElementById('launchConnectionBar');
  var launchConnectBtn = document.getElementById('launchConnectBtn');
  var launchDisconnectBtn = document.getElementById('launchDisconnectBtn');
  var launchAccountBtn = document.getElementById('launchAccountBtn');
  var launchConnectionStatus = document.getElementById('launchConnectionStatus');
  var instrumentSection = document.getElementById('launchInstrumentSection');
  var instrumentHint = document.getElementById('launchInstrumentHint');
  var homeSetupHint = document.getElementById('homeSetupHint');
  var modePanel = document.getElementById('onboardingMode');
  var modeStatus = document.getElementById('modeStatus');
  var modeActions = document.getElementById('onboardingModeActions');
  var modeConnectHint = document.getElementById('onboardingModeConnectHint');
  var homeBtn = document.getElementById('homeBtn');
  var watchlistSelect = document.getElementById('watchlistSelect');
  var epicSelect = document.getElementById('epicSelect');
  var appNav = document.getElementById('appNav');

  var clientConfig = null;

  function openAccount() {
    if (accountApi && accountApi.showAccount) accountApi.showAccount();
  }

  function setModeStatus(msg, isError) {
    if (!modeStatus) return;
    modeStatus.textContent = msg || '';
    modeStatus.classList.toggle('hidden', !msg);
    modeStatus.className = 'text-sm ' + (isError ? 'text-red-400' : 'text-slate-400');
  }

  function setLaunchConnectionStatus(msg, isError) {
    if (!launchConnectionStatus) return;
    launchConnectionStatus.textContent = msg || '';
    launchConnectionStatus.className = 'text-xs ' + (isError ? 'text-red-400' : 'text-slate-500');
  }

  function showConnectionBar(show) {
    if (connectionBar) connectionBar.classList.toggle('hidden', !show);
  }

  function showInstrumentSection(show) {
    if (instrumentSection) instrumentSection.classList.toggle('hidden', !show);
  }

  function updateInstrumentPickerLayout() {
    var loggedIn = isIgLoggedIn(state);
    var connecting = state.engineStatus === 'connecting';
    showInstrumentSection(loggedIn && !connecting);
  }

  function setInstrumentControlsEnabled(enabled) {
    if (watchlistSelect) watchlistSelect.disabled = !enabled;
    if (epicSelect) epicSelect.disabled = !enabled;
    if (instrumentHint) {
      instrumentHint.textContent = enabled
        ? 'Select watchlist and instrument before continuing.'
        : 'Connect to IG to load watchlists.';
    }
  }

  function updateHomeSetupHint() {
    if (!homeSetupHint) return;
    var needs = clientConfig && !clientConfig.credentialsConfigured;
    homeSetupHint.classList.toggle('hidden', !needs);
  }

  function updateLaunchConnectionButtons() {
    var loggedIn = isIgLoggedIn(state);
    var connecting = state.engineStatus === 'connecting';
    var hasCreds = !!(clientConfig && clientConfig.credentialsConfigured);

    if (launchConnectBtn) {
      launchConnectBtn.classList.toggle('hidden', loggedIn || connecting);
      launchConnectBtn.disabled = connecting || !hasCreds;
    }
    if (launchDisconnectBtn) {
      launchDisconnectBtn.classList.toggle('hidden', !loggedIn || connecting);
    }
    if (loggedIn && !connecting) {
      setLaunchConnectionStatus(state.engineStatus === 'running'
        ? 'Logged in — session active in workspace'
        : 'Logged in — choose instrument, then Trade or Research');
    } else if (!connecting) {
      setLaunchConnectionStatus(hasCreds ? '' : 'Open Account and click OK first');
    }
    updateInstrumentPickerLayout();
    updateHomeSetupHint();
    updateModeWorkspaceActions();
  }

  function updateModeWorkspaceActions() {
    if (!modePanel || modePanel.classList.contains('hidden')) return;
    var loggedIn = isIgLoggedIn(state);
    var connecting = state.engineStatus === 'connecting';
    if (modeActions) modeActions.classList.toggle('hidden', !loggedIn || connecting);
    if (modeConnectHint) {
      modeConnectHint.classList.toggle('hidden', loggedIn && !connecting);
      if (!loggedIn && !connecting) {
        modeConnectHint.textContent = clientConfig && clientConfig.credentialsConfigured
          ? 'Connect to IG above to continue.'
          : 'Open Account and click OK first.';
      } else if (connecting) {
        modeConnectHint.textContent = 'Connecting…';
      }
    }
  }

  function updateHomeChrome() {
    var inWorkspace = appView.isWorkspaceReady();
    if (homeBtn) homeBtn.classList.toggle('hidden', !inWorkspace);
    if (appNav) appNav.classList.toggle('hidden', !inWorkspace);
  }

  function seedInstrumentFromConfig(cfg) {
    if (!epicSelect || !cfg) return;
    if (cfg.epic) {
      epicSelect.innerHTML = '';
      var opt = document.createElement('option');
      opt.value = cfg.epic;
      opt.textContent = cfg.epicDisplayName || cfg.epic;
      epicSelect.appendChild(opt);
      epicSelect.value = cfg.epic;
      state.savedEpic = cfg.epic;
    }
    if (watchlistSelect && cfg.watchlistId) {
      watchlistSelect.innerHTML = '';
      var wOpt = document.createElement('option');
      wOpt.value = cfg.watchlistId;
      wOpt.textContent = cfg.watchlistDisplayName || cfg.watchlistId;
      watchlistSelect.appendChild(wOpt);
      watchlistSelect.value = cfg.watchlistId;
      state.savedWatchlistId = cfg.watchlistId;
    }
  }

  function showLaunch() {
    if (launchPanel) launchPanel.classList.remove('hidden');
  }

  function hideLaunch() {
    if (launchPanel) launchPanel.classList.add('hidden');
  }

  function showMode() {
    if (modePanel) modePanel.classList.remove('hidden');
    updateInstrumentPickerLayout();
    setInstrumentControlsEnabled(isIgLoggedIn(state));
    if (clientConfig) seedInstrumentFromConfig(clientConfig);
    if (isIgLoggedIn(state)) socket.emit('getWatchlists');
    updateModeWorkspaceActions();
    showLaunch();
    showConnectionBar(true);
    updateLaunchConnectionButtons();
    updateHomeChrome();
    hideAppBootOverlay();
  }

  function saveEpicSelection() {
    if (!epicSelect || !epicSelect.value) return Promise.resolve(null);
    var epic = epicSelect.value;
    var selectedOpt = epicSelect.options[epicSelect.selectedIndex];
    var displayName = selectedOpt ? selectedOpt.textContent.trim() : epic;
    var watchlistId = watchlistSelect ? watchlistSelect.value : '';
    var watchlistName = '';
    if (watchlistSelect && watchlistSelect.selectedIndex >= 0) {
      watchlistName = (watchlistSelect.options[watchlistSelect.selectedIndex].textContent || '').trim();
    }
    socket.emit('setWatchlist', watchlistId);
    socket.emit('setEpic', epic);
    return fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        epic: epic,
        epicDisplayName: displayName,
        watchlistId: watchlistId || undefined,
        watchlistDisplayName: watchlistName || undefined
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      clientConfig = data;
      state.savedEpic = epic;
      updateInstrumentPickerLayout();
      syncHeaderInstrument(state, data);
      if (onEpicSaved) onEpicSaved(epic);
      return data;
    });
  }

  function enterWorkspace(view) {
    if (!isIgLoggedIn(state)) {
      setModeStatus('Connect to IG first', true);
      return;
    }
    if (!epicSelect || !epicSelect.value) {
      setModeStatus('Select an instrument', true);
      if (instrumentSection) instrumentSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    var finish = function () {
      hideLaunch();
      if (appNav) appNav.classList.remove('hidden');
      appView.setWorkspaceReady(true);
      appView.setView(view);
      syncHeaderInstrument(state, clientConfig);
      updateHomeChrome();
      if (onEnterWorkspace) onEnterWorkspace(view);
    };
    saveEpicSelection().then(finish).catch(function (err) {
      setModeStatus(err.message || 'Failed to save instrument', true);
    });
  }

  function finishGoHome() {
    if (prepareForHome) prepareForHome();
    appView.setWorkspaceReady(false);
    showMode();
  }

  function goHome() {
    var streaming = state.engineStatus === 'running';
    var rulesActive = !!state.rulesEngineRunning;
    if (!streaming && !rulesActive) {
      finishGoHome();
      return;
    }
    var parts = [];
    if (rulesActive) parts.push('stop rules trading');
    if (streaming) parts.push('stop the price stream');
    var msg = 'Return to Home? This will ' + parts.join(' and ') + '. You stay logged in to IG.';
    var confirmFn = showConfirm || function (opts) {
      return Promise.resolve(window.confirm((opts && opts.message) || ''));
    };
    confirmFn({
      title: 'Return to Home',
      message: msg,
      okLabel: 'Home',
      cancelLabel: 'Stay'
    }).then(function (ok) {
      if (ok) finishGoHome();
    });
  }

  function onLaunchConnect() {
    setLaunchConnectionStatus('Connecting…');
    setModeStatus('');
    if (!clientConfig || !clientConfig.credentialsConfigured) {
      setModeStatus('Open Account and click OK first', true);
      openAccount();
      return;
    }
    socket.emit('connect_ig');
  }

  function onLaunchDisconnect() {
    socket.emit('stop');
  }

  function onLaunchLoggedIn() {
    setInstrumentControlsEnabled(true);
    setModeStatus('');
    socket.emit('getWatchlists');
    updateLaunchConnectionButtons();
    updateInstrumentPickerLayout();
  }

  function onConfigUpdated(cfg) {
    clientConfig = cfg || clientConfig;
    if (cfg) {
      state.activeProfile = cfg.activeProfile || state.activeProfile;
      updateLaunchConnectionButtons();
      updateInstrumentPickerLayout();
    }
  }

  function populateWatchlists(list) {
    if (!isLaunchVisible() || !watchlistSelect) return;
    var cur = state.savedWatchlistId || watchlistSelect.value || (clientConfig && clientConfig.watchlistId) || '';
    watchlistSelect.innerHTML = '<option value="">—</option>';
    list.forEach(function (w) {
      var opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name || w.id;
      watchlistSelect.appendChild(opt);
    });
    var id = cur && list.some(function (w) { return String(w.id) === String(cur); })
      ? cur
      : (list[0] && list[0].id ? list[0].id : '');
    if (id) {
      watchlistSelect.value = id;
      var matched = list.find(function (w) { return String(w.id) === String(id); });
      if (matched && matched.name) {
        if (clientConfig) clientConfig.watchlistDisplayName = matched.name;
        fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ watchlistId: id, watchlistDisplayName: matched.name })
        }).then(function (r) { return r.json(); }).then(function (data) {
          clientConfig = data;
        }).catch(function () {});
      }
      socket.emit('getEpics', id);
    }
  }

  function populateEpics(list) {
    if (!isLaunchVisible() || !epicSelect) return;
    var cur = state.savedEpic || epicSelect.value || (clientConfig && clientConfig.epic) || '';
    epicSelect.innerHTML = '<option value="">—</option>';
    (list || []).forEach(function (e) {
      var opt = document.createElement('option');
      opt.value = e.epic;
      opt.textContent = e.instrumentName || e.epic;
      epicSelect.appendChild(opt);
    });
    if (cur && list && list.some(function (e) { return e.epic === cur; })) {
      epicSelect.value = cur;
    }
  }

  function refreshLaunchUi() {
    syncHeaderInstrument(state, clientConfig);
    if (!isLaunchVisible()) return;
    updateLaunchConnectionButtons();
    updateModeWorkspaceActions();
  }

  socket.on('watchlists', populateWatchlists);
  socket.on('epics', populateEpics);

  socket.on('account', function (data) {
    if (data && data.accountId && isIgLoggedIn(state)) onLaunchLoggedIn();
    refreshLaunchUi();
  });

  socket.on('status', function (status) {
    if (isLaunchVisible()) {
      if (status === 'connecting') setLaunchConnectionStatus('Connecting…');
      if (status === 'connected') onLaunchLoggedIn();
      if (status === 'ready' || status === 'stopped') setInstrumentControlsEnabled(false);
    }
    refreshLaunchUi();
    updateHomeChrome();
  });

  socket.on('login_error', function (msg) {
    if (isLaunchVisible()) {
      setLaunchConnectionStatus('Login failed: ' + msg, true);
      setModeStatus('Login failed: ' + msg, true);
    }
    refreshLaunchUi();
  });

  if (watchlistSelect) {
    watchlistSelect.addEventListener('change', function () {
      if (!isLaunchVisible()) return;
      var id = watchlistSelect.value;
      state.savedWatchlistId = id;
      var name = watchlistSelect.selectedIndex >= 0
        ? (watchlistSelect.options[watchlistSelect.selectedIndex].textContent || '').trim()
        : '';
      if (id && name) {
        fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ watchlistId: id, watchlistDisplayName: name })
        }).then(function (r) { return r.json(); }).then(function (data) {
          clientConfig = data;
        }).catch(function () {});
      }
      if (id) socket.emit('getEpics', id);
    });
  }

  if (epicSelect) {
    epicSelect.addEventListener('change', function () {
      if (!isLaunchVisible()) return;
      if (epicSelect.value) saveEpicSelection().catch(function () {});
    });
  }

  if (launchConnectBtn) launchConnectBtn.addEventListener('click', onLaunchConnect);
  if (launchDisconnectBtn) launchDisconnectBtn.addEventListener('click', onLaunchDisconnect);
  if (launchAccountBtn) launchAccountBtn.addEventListener('click', openAccount);
  if (homeBtn) homeBtn.addEventListener('click', goHome);

  var chooseTrade = document.getElementById('onboardingChooseTrade');
  var chooseResearch = document.getElementById('onboardingChooseResearch');
  if (chooseTrade) chooseTrade.addEventListener('click', function () { enterWorkspace('trade'); });
  if (chooseResearch) chooseResearch.addEventListener('click', function () { enterWorkspace('research'); });

  fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      clientConfig = cfg;
      state.activeProfile = cfg.activeProfile || 'demo';
      state.savedEpic = cfg.epic || '';
      state.savedWatchlistId = cfg.watchlistId || '';
      syncHeaderInstrument(state, cfg);
      if (!(cfg.ui && cfg.ui.setupComplete) && cfg.credentialsConfigured && cfg.epic) {
        fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ui: { setupComplete: true } })
        }).catch(function () {});
      }
      showMode();
    })
    .catch(function () {
      showMode();
    });

  return {
    isSetupComplete: function () {
      return clientConfig && !needsSetup(clientConfig);
    },
    showHome: showMode,
    goHome: goHome,
    hideLaunch: hideLaunch,
    isLaunchVisible: isLaunchVisible,
    onConfigUpdated: onConfigUpdated,
    syncHeaderInstrument: function () {
      syncHeaderInstrument(state, clientConfig);
    }
  };
}
