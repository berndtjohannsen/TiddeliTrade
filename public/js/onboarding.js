/**

 * First-run setup and launch workspace picker (Trade / Research).

 * Launch Connect = IG login only (connect_ig). Workspace Start session = stream + trading.

 */



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



export function updateHeaderInstrument(cfgOrEpic, displayName) {

  var el = document.getElementById('headerInstrument');

  if (!el) return;

    if (cfgOrEpic && typeof cfgOrEpic === 'object') {

    var cfg = cfgOrEpic;

    var label = formatInstrumentLabel(cfg);

    el.textContent = label || '—';

    el.title = cfg.epic || 'Instrument';

    return;

  }

  var epic = cfgOrEpic || '';

  var name = displayName || epic;

  if (name && epic && name !== epic) {

    el.textContent = name + ' (' + epic + ')';

  } else {

    el.textContent = epic || '—';

  }

  el.title = epic || 'Instrument';

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

 * @param {{ onEnterWorkspace?: (view: 'trade'|'research') => void, onEpicSaved?: (epic: string) => void }} [opts]

 */

export function initOnboarding(socket, state, appView, log, opts) {

  var onEnterWorkspace = opts && opts.onEnterWorkspace ? opts.onEnterWorkspace : null;

  var onEpicSaved = opts && opts.onEpicSaved ? opts.onEpicSaved : null;



  var launchPanel = document.getElementById('launchPanel');

  var connectionBar = document.getElementById('launchConnectionBar');

  var launchConnectBtn = document.getElementById('launchConnectBtn');

  var launchDisconnectBtn = document.getElementById('launchDisconnectBtn');

  var launchConfigBtn = document.getElementById('launchConfigBtn');

  var launchConnectionStatus = document.getElementById('launchConnectionStatus');

  var instrumentSection = document.getElementById('launchInstrumentSection');

  var instrumentHint = document.getElementById('launchInstrumentHint');

  var setupPanel = document.getElementById('onboardingSetup');

  var modePanel = document.getElementById('onboardingMode');

  var modeAccount = document.getElementById('onboardingModeAccount');

  var modeInstrumentName = document.getElementById('onboardingModeInstrumentName');

  var modeInstrumentEpic = document.getElementById('onboardingModeInstrumentEpic');

  var modeStatus = document.getElementById('modeStatus');

  var modeActions = document.getElementById('onboardingModeActions');

  var modeConnectHint = document.getElementById('onboardingModeConnectHint');

  var setupStatus = document.getElementById('setupStatus');

  var setupSaveBtn = document.getElementById('setupSaveBtn');

  var setupCancelBtn = document.getElementById('setupCancelBtn');

  var setupFinishBtn = document.getElementById('setupFinishBtn');

  var profileSelect = document.getElementById('setupProfileSelect');

  var baseUrlEl = document.getElementById('setupBaseUrl');

  var apiKeyEl = document.getElementById('setupApiKey');

  var usernameEl = document.getElementById('setupUsername');

  var passwordEl = document.getElementById('setupPassword');

  var watchlistSelect = document.getElementById('watchlistSelect');

  var epicSelect = document.getElementById('epicSelect');

  var appNav = document.getElementById('appNav');



  var clientConfig = null;

  var inSetupFlow = false;



  function setSetupStatus(msg, isError) {

    if (!setupStatus) return;

    setupStatus.textContent = msg || '';

    setupStatus.classList.toggle('hidden', !msg);

    setupStatus.className = 'text-sm ' + (isError ? 'text-red-400' : 'text-slate-400');

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



  function setInstrumentControlsEnabled(enabled) {

    if (watchlistSelect) watchlistSelect.disabled = !enabled;

    if (epicSelect) epicSelect.disabled = !enabled;

    if (instrumentHint) {

      instrumentHint.textContent = 'Select watchlist and instrument before continuing.';

    }

  }



  function updateLaunchConnectionButtons() {

    var loggedIn = isIgLoggedIn(state);

    var connecting = state.engineStatus === 'connecting';

    if (launchConnectBtn) {

      launchConnectBtn.classList.toggle('hidden', loggedIn || connecting || inSetupFlow);

      launchConnectBtn.disabled = connecting;

    }

    if (launchDisconnectBtn) {

      launchDisconnectBtn.classList.toggle('hidden', !loggedIn || connecting);

    }

    if (loggedIn && !connecting) {

      setLaunchConnectionStatus(state.engineStatus === 'running'

        ? 'Logged in — session active in workspace'

        : 'Logged in — choose instrument, then Trade or Research');

    } else if (!connecting) {

      setLaunchConnectionStatus('');

    }

    showInstrumentSection(loggedIn && !connecting);

    if (launchConfigBtn) {

      launchConfigBtn.classList.toggle('hidden', loggedIn || connecting || inSetupFlow);

    }

    updateModeWorkspaceActions();

  }



  function updateLaunchModeDisplay(cfg) {

    var c = cfg || clientConfig;

    if (!c) return;

    var isLive = c.activeProfile === 'live';

    if (modeAccount) {

      modeAccount.textContent = isLive ? 'Live' : 'Demo';

      modeAccount.className = 'px-2 py-0.5 rounded text-xs font-semibold ' + (isLive ? 'bg-amber-600/90 text-amber-950' : 'bg-slate-600/80 text-slate-300');

      modeAccount.title = isLive ? 'Live IG account' : 'Demo IG account';

    }

    if (modeInstrumentName) {

      if (!c.epic) {

        modeInstrumentName.textContent = 'Not selected yet';

        modeInstrumentName.className = 'text-sm text-amber-400';

        modeInstrumentName.title = 'Choose an instrument after connecting';

        if (modeInstrumentEpic) modeInstrumentEpic.classList.add('hidden');

      } else if (c.epicDisplayName && c.epicDisplayName !== c.epic) {

        modeInstrumentName.textContent = c.epicDisplayName;

        modeInstrumentName.className = 'text-base font-medium text-slate-100 truncate';

        modeInstrumentName.title = c.epicDisplayName;

        if (modeInstrumentEpic) {

          modeInstrumentEpic.textContent = c.epic;

          modeInstrumentEpic.classList.remove('hidden');

          modeInstrumentEpic.title = c.epic;

        }

      } else {

        modeInstrumentName.textContent = c.epic;

        modeInstrumentName.className = 'text-sm font-medium text-slate-100 truncate font-mono';

        modeInstrumentName.title = c.epic;

        if (modeInstrumentEpic) modeInstrumentEpic.classList.add('hidden');

      }

    }

  }



  function updateModeWorkspaceActions() {

    if (!modePanel || modePanel.classList.contains('hidden')) return;

    var loggedIn = isIgLoggedIn(state);

    var connecting = state.engineStatus === 'connecting';

    if (modeActions) modeActions.classList.toggle('hidden', !loggedIn || connecting);

    if (changeSetup) changeSetup.classList.toggle('hidden', !loggedIn || connecting);

    if (modeConnectHint) {

      modeConnectHint.classList.toggle('hidden', loggedIn && !connecting);

      if (!loggedIn && !connecting) {

        modeConnectHint.textContent = 'Connect to IG above to continue.';

      } else if (connecting) {

        modeConnectHint.textContent = 'Connecting…';

      }

    }

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



  function showLaunchChrome() {

    showLaunch();

    showConnectionBar(true);

    updateLaunchConnectionButtons();

  }



  function showLaunch() {

    if (launchPanel) launchPanel.classList.remove('hidden');

  }



  function hideLaunch() {

    if (launchPanel) launchPanel.classList.add('hidden');

  }



  function showSetup() {

    inSetupFlow = true;

    if (setupPanel) setupPanel.classList.remove('hidden');

    if (modePanel) modePanel.classList.add('hidden');

    setInstrumentControlsEnabled(isIgLoggedIn(state));

    if (clientConfig) seedInstrumentFromConfig(clientConfig);

    showLaunch();

    showConnectionBar(false);

    updateLaunchConnectionButtons();

  }



  function showMode() {

    inSetupFlow = false;

    if (setupPanel) setupPanel.classList.add('hidden');

    if (modePanel) modePanel.classList.remove('hidden');

    updateLaunchModeDisplay(clientConfig);

    setInstrumentControlsEnabled(isIgLoggedIn(state));

    if (clientConfig) seedInstrumentFromConfig(clientConfig);

    if (isIgLoggedIn(state)) socket.emit('getWatchlists');

    updateModeWorkspaceActions();

    showLaunchChrome();

  }



  function loadProfileFields(cfg, profileOverride) {

    var activeProfile = profileOverride || (profileSelect && profileSelect.value) || cfg.activeProfile || 'demo';

    var profiles = cfg.igProfilesSafe || { demo: {}, live: {} };

    if (profileSelect) profileSelect.value = activeProfile;

    var p = profiles[activeProfile] || {};

    if (usernameEl) usernameEl.value = p.igUsername || '';

    if (baseUrlEl) {

      baseUrlEl.value = p.igBaseUrl || '';

      baseUrlEl.placeholder = activeProfile === 'live' ? 'https://api.ig.com' : 'https://demo-api.ig.com';

    }

    if (apiKeyEl) {

      apiKeyEl.value = '';

      apiKeyEl.placeholder = p.credentialsConfigured ? '•••••• (leave blank to keep)' : 'IG API key';

    }

    if (passwordEl) {

      passwordEl.value = '';

      passwordEl.placeholder = p.credentialsConfigured ? '•••••• (leave blank to keep)' : 'IG password';

    }

  }



  function onProfileChange() {

    var selectedProfile = profileSelect && profileSelect.value ? profileSelect.value : 'demo';

    if (clientConfig) {

      loadProfileFields(clientConfig, selectedProfile);

      return;

    }

    fetch('/api/config')

      .then(function (r) { return r.json(); })

      .then(function (data) {

        clientConfig = data;

        loadProfileFields(data, selectedProfile);

      })

      .catch(function () {});

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

      updateHeaderInstrument(data);

      updateLaunchModeDisplay(data);

      if (onEpicSaved) onEpicSaved(epic);

      return data;

    });

  }



  function enterWorkspace(view) {

    if (!isIgLoggedIn(state)) {

      if (inSetupFlow) setSetupStatus('Connect to IG first', true);

      else setModeStatus('Connect to IG first', true);

      return;

    }

    if (!epicSelect || !epicSelect.value) {

      if (inSetupFlow) setSetupStatus('Select an instrument', true);

      else setModeStatus('Select an instrument', true);

      return;

    }

    var finish = function () {

      hideLaunch();

      if (appNav) appNav.classList.remove('hidden');

      appView.setWorkspaceReady(true);

      appView.setView(view);

      if (clientConfig) updateHeaderInstrument(clientConfig);

      if (onEnterWorkspace) onEnterWorkspace(view);

    };

    saveEpicSelection().then(finish).catch(function (err) {

      var msg = err.message || 'Failed to save instrument';

      if (inSetupFlow) setSetupStatus(msg, true);

      else setModeStatus(msg, true);

    });

  }



  function updateFinishButton() {

    if (!setupFinishBtn || !epicSelect) return;

    setupFinishBtn.disabled = !(isIgLoggedIn(state) && epicSelect.value);

  }



  function saveCredentials() {

    var payload = {};

    if (profileSelect && profileSelect.value) payload.activeProfile = profileSelect.value;

    if (baseUrlEl && baseUrlEl.value.trim()) payload.igBaseUrl = baseUrlEl.value.trim();

    if (apiKeyEl && apiKeyEl.value.trim()) payload.igApiKey = apiKeyEl.value.trim();

    if (usernameEl && usernameEl.value.trim()) payload.igUsername = usernameEl.value.trim();

    if (passwordEl && passwordEl.value.trim()) payload.igPassword = passwordEl.value.trim();

    return fetch('/api/config', {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify(payload)

    }).then(function (r) {

      if (!r.ok) throw new Error('Failed to save credentials');

      return r.json();

    });

  }



  function onSetupCancel() {

    setSetupStatus('');

    if (clientConfig) loadProfileFields(clientConfig);

    showMode();

  }



  function onSetupSave() {

    setSetupStatus('Saving credentials…');

    if (setupSaveBtn) setupSaveBtn.disabled = true;

    saveCredentials()

      .then(function (data) {

        clientConfig = data;

        if (!data.credentialsConfigured) {

          throw new Error('Enter API key, username, and password');

        }

        setSetupStatus('');

        if (setupSaveBtn) setupSaveBtn.disabled = false;

        showMode();

      })

      .catch(function (err) {

        setSetupStatus(err.message || 'Save failed', true);

        if (setupSaveBtn) setupSaveBtn.disabled = false;

      });

  }



  function onSetupFinish() {

    if (!epicSelect || !epicSelect.value) {

      setSetupStatus('Select an instrument', true);

      return;

    }

    setSetupStatus('Saving…');

    if (setupFinishBtn) setupFinishBtn.disabled = true;

    saveEpicSelection()

      .then(function () {

        return fetch('/api/config', {

          method: 'POST',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify({ ui: { setupComplete: true } })

        }).then(function (r) { return r.json(); });

      })

      .then(function (data) {

        clientConfig = data;

        setSetupStatus('');

        showMode();

      })

      .catch(function (err) {

        setSetupStatus(err.message || 'Save failed', true);

        if (setupFinishBtn) setupFinishBtn.disabled = false;

      });

  }



  function onLaunchConnect() {

    setLaunchConnectionStatus('Connecting…');

    setModeStatus('');

    if (!clientConfig || !clientConfig.credentialsConfigured) {

      setModeStatus('Save account credentials in Account settings first', true);

      return;

    }

    socket.emit('connect_ig');

  }



  function onLaunchDisconnect() {

    socket.emit('stop');

  }



  function onLaunchLoggedIn() {

    setInstrumentControlsEnabled(true);

    if (inSetupFlow) {

      if (setupFinishBtn) setupFinishBtn.classList.remove('hidden');

      setSetupStatus('Logged in. Choose your instrument below.');

    } else {

      setModeStatus('');

    }

    socket.emit('getWatchlists');

    updateFinishButton();

    updateLaunchConnectionButtons();

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

    updateFinishButton();

  }



  socket.on('watchlists', populateWatchlists);

  socket.on('epics', populateEpics);



  socket.on('account', function (data) {

    if (!isLaunchVisible()) return;

    if (data && data.accountId && isIgLoggedIn(state)) onLaunchLoggedIn();

  });



  socket.on('status', function (status) {

    if (!isLaunchVisible()) return;

    if (status === 'connecting') setLaunchConnectionStatus('Connecting…');

    if (status === 'connected') onLaunchLoggedIn();

    if (status === 'running') updateLaunchConnectionButtons();

    if (status === 'ready' || status === 'stopped') {

      setInstrumentControlsEnabled(false);

      updateLaunchConnectionButtons();

      if (inSetupFlow && setupFinishBtn) setupFinishBtn.classList.add('hidden');

    }

    updateLaunchConnectionButtons();

  });



  socket.on('login_error', function (msg) {

    if (!isLaunchVisible()) return;

    setLaunchConnectionStatus('Login failed: ' + msg, true);

    if (inSetupFlow) {

      setSetupStatus('Login failed: ' + msg, true);

    } else {

      setModeStatus('Login failed: ' + msg, true);

    }

    updateLaunchConnectionButtons();

  });



  if (profileSelect) profileSelect.addEventListener('change', onProfileChange);

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

      updateFinishButton();

      if (!inSetupFlow && epicSelect.value) {

        saveEpicSelection().catch(function () {});

      }

    });

  }

  if (setupSaveBtn) setupSaveBtn.addEventListener('click', onSetupSave);

  if (setupCancelBtn) setupCancelBtn.addEventListener('click', onSetupCancel);

  if (setupFinishBtn) setupFinishBtn.addEventListener('click', onSetupFinish);

  if (launchConnectBtn) launchConnectBtn.addEventListener('click', onLaunchConnect);

  if (launchDisconnectBtn) launchDisconnectBtn.addEventListener('click', onLaunchDisconnect);

  function openAccountSettings() {

    if (isIgLoggedIn(state)) socket.emit('stop');

    if (setupFinishBtn) setupFinishBtn.classList.add('hidden');

    if (clientConfig) loadProfileFields(clientConfig);

    showSetup();

  }

  if (launchConfigBtn) launchConfigBtn.addEventListener('click', openAccountSettings);



  var chooseTrade = document.getElementById('onboardingChooseTrade');

  var chooseResearch = document.getElementById('onboardingChooseResearch');

  var changeSetup = document.getElementById('onboardingChangeSetup');

  if (chooseTrade) chooseTrade.addEventListener('click', function () { enterWorkspace('trade'); });

  if (chooseResearch) chooseResearch.addEventListener('click', function () { enterWorkspace('research'); });

  if (changeSetup) changeSetup.addEventListener('click', openAccountSettings);



  fetch('/api/config')

    .then(function (r) { return r.json(); })

    .then(function (cfg) {

      clientConfig = cfg;

      state.activeProfile = cfg.activeProfile || 'demo';

      state.savedEpic = cfg.epic || '';

      state.savedWatchlistId = cfg.watchlistId || '';

      updateHeaderInstrument(cfg);

      loadProfileFields(cfg);

      if (needsSetup(cfg)) {

        showSetup();

      } else {

        if (!(cfg.ui && cfg.ui.setupComplete)) {

          fetch('/api/config', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ ui: { setupComplete: true } })

          }).catch(function () {});

        }

        showMode();

      }

    })

    .catch(function () {

      showSetup();

    });



  return {

    isSetupComplete: function () {

      return clientConfig && !needsSetup(clientConfig);

    },

    showModePicker: showMode,

    hideLaunch: hideLaunch,

    isLaunchVisible: isLaunchVisible

  };

}


