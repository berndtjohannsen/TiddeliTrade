/**
 * Watchlists and epics – launch page selects; state sync when connected in workspace.
 * @param {Object} opts - Optional. onEpicChange(epic) called when epic changes (user select or server).
 */
export function initWatchlists(socket, state, log, opts) {
  var onEpicChange = (opts && typeof opts.onEpicChange === 'function') ? opts.onEpicChange : function () {};
  var watchlistSelect = document.getElementById('watchlistSelect');
  var epicSelect = document.getElementById('epicSelect');
  var headerMessageEl = document.getElementById('headerMessage');
  var headerMessageTimer = null;

  function isLaunchVisible() {
    var lp = document.getElementById('launchPanel');
    return lp && !lp.classList.contains('hidden');
  }

  function showHeaderMessage(msg) {
    if (!headerMessageEl) return;
    if (headerMessageTimer) clearTimeout(headerMessageTimer);
    headerMessageEl.textContent = msg;
    headerMessageEl.classList.remove('hidden');
    headerMessageTimer = setTimeout(function () {
      headerMessageEl.textContent = '';
      headerMessageEl.classList.add('hidden');
      headerMessageTimer = null;
    }, 5000);
  }

  socket.on('watchlists', function (list) {
    if (isLaunchVisible()) return;
    if (!watchlistSelect) return;
    var cur = state.savedWatchlistId || watchlistSelect.value;
    watchlistSelect.innerHTML = '<option value="">—</option>';
    list.forEach(function (w) {
      var opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name || w.id;
      watchlistSelect.appendChild(opt);
    });
    var id = cur && list.some(function (w) { return w.id === cur; }) ? cur : (list[0] && list[0].id ? list[0].id : '');
    if (id) {
      watchlistSelect.value = id;
      socket.emit('setWatchlist', id);
      socket.emit('getEpics', id);
    }
  });

  socket.on('watchlists_error', function (msg) {
    log('Watchlists: ' + msg);
  });

  socket.on('epics', function (list) {
    if (isLaunchVisible()) return;
    if (!epicSelect) return;
    var cur = state.savedEpic || epicSelect.value;
    epicSelect.innerHTML = '<option value="">—</option>';
    list.forEach(function (e) {
      var opt = document.createElement('option');
      opt.value = e.epic;
      opt.textContent = e.instrumentName || e.epic;
      epicSelect.appendChild(opt);
    });
    if (cur && list.some(function (e) { return e.epic === cur; })) {
      epicSelect.value = cur;
      socket.emit('setEpic', cur);
      onEpicChange(cur);
    }
  });

  socket.on('epics_error', function (msg) {
    log('Epics: ' + msg);
  });

  socket.on('epic', function (epic) {
    state.savedEpic = epic || '';
    if (epicSelect && epic && !isLaunchVisible()) {
      epicSelect.value = epic;
    }
    onEpicChange(epic);
  });

  socket.on('watchlistId', function (id) {
    state.savedWatchlistId = id || '';
    if (watchlistSelect && id && !isLaunchVisible()) {
      watchlistSelect.value = id;
    }
  });

  if (watchlistSelect) {
    watchlistSelect.addEventListener('change', function () {
      if (isLaunchVisible()) return;
      var id = watchlistSelect.value;
      var prevId = state.savedWatchlistId || '';
      if (id === prevId) return;
      if (state.rulesEngineRunning) {
        watchlistSelect.value = prevId || '';
        log('Stop the rules engine first before changing watchlist.');
        showHeaderMessage('Stop the rules engine first before changing watchlist.');
        return;
      }
      log('Watchlist selected: ' + (watchlistSelect.options[watchlistSelect.selectedIndex]?.text || id));
      socket.emit('setWatchlist', id);
      socket.emit('getEpics', id);
    });
  }

  if (epicSelect) {
    epicSelect.addEventListener('change', function () {
      if (isLaunchVisible()) return;
      var epic = epicSelect.value;
      var prevEpic = state.savedEpic || '';
      if (epic === prevEpic) return;
      if (state.rulesEngineRunning) {
        epicSelect.value = prevEpic || '';
        log('Stop the rules engine first before changing instrument.');
        showHeaderMessage('Stop the rules engine first before changing instrument.');
        return;
      }
      log('Epic selected: ' + (epicSelect.options[epicSelect.selectedIndex]?.text || epic));
      socket.emit('setEpic', epic);
      onEpicChange(epic);
    });
  }
}
