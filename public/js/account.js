/**
 * Account display, setDealEnabled, setPositionsEnabled.
 */
export function initAccount(socket, state, setBaseEnabled, setPositionsEnabled, setOrdersPanelEnabled, clearDealMessage, setProbesPanelEnabled, setTransactionLogPanelEnabled) {
  var accountInfo = document.getElementById('accountInfo');
  var mainPlaceholder = document.getElementById('mainPlaceholder');
  var splashPanel = document.getElementById('splashPanel');
  var dealPanel = document.getElementById('dealPanel');
  var splashHint = document.getElementById('splashHint');
  var watchlistSelect = document.getElementById('watchlistSelect');
  var epicSelect = document.getElementById('epicSelect');

  setBaseEnabled(false);
  setPositionsEnabled(false);
  if (setOrdersPanelEnabled) setOrdersPanelEnabled(false);
  if (setProbesPanelEnabled) setProbesPanelEnabled(false);
  if (setTransactionLogPanelEnabled) setTransactionLogPanelEnabled(false);

  function updateProfileBadge() {
    var badge = document.getElementById('profileBadge');
    if (badge) {
      var profile = state.activeProfile || 'demo';
      badge.textContent = profile === 'live' ? 'LIVE' : 'Demo';
      badge.className = 'px-2 py-0.5 rounded text-xs font-semibold shrink-0 ' + (profile === 'live' ? 'bg-amber-600/90 text-amber-950' : 'bg-slate-600/80 text-slate-300');
      badge.setAttribute('data-tooltip', profile === 'live' ? 'Real money – trades execute on your live IG account' : 'Demo account – no real money at risk');
      badge.classList.remove('hidden');
    }
    var dealLiveWarn = document.getElementById('dealLiveWarning');
    if (dealLiveWarn) {
      if (state.activeProfile === 'live') dealLiveWarn.classList.remove('hidden');
      else dealLiveWarn.classList.add('hidden');
    }
  }

  function setAccount(data) {
    if (!accountInfo) return;
    if (mainPlaceholder) mainPlaceholder.classList.remove('text-red-500');
    if (!data || !data.accountId) {
      accountInfo.classList.add('hidden');
      accountInfo.textContent = '';
      state.accountCurrency = '';
      fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
        state.activeProfile = cfg.activeProfile || 'demo';
        updateProfileBadge();
      }).catch(function () { state.activeProfile = 'demo'; updateProfileBadge(); });
      if (mainPlaceholder) { mainPlaceholder.textContent = ''; mainPlaceholder.classList.add('hidden'); }
      if (splashPanel) splashPanel.classList.remove('hidden');
      if (dealPanel) dealPanel.classList.add('hidden');
      if (splashHint) { splashHint.textContent = 'Press Start to connect'; splashHint.classList.remove('text-red-500'); }
      if (watchlistSelect) watchlistSelect.classList.add('hidden');
      if (epicSelect) epicSelect.disabled = true;
      setBaseEnabled(false);
      setPositionsEnabled(false);
      if (setOrdersPanelEnabled) setOrdersPanelEnabled(false);
      if (setProbesPanelEnabled) setProbesPanelEnabled(false);
      if (setTransactionLogPanelEnabled) setTransactionLogPanelEnabled(false);
      state.currentMinDealSize = null;
      state.currentDealCurrency = '';
      state.currentContractSize = 1;
      state.currentLotSize = null;
      state.currentMarginFactor = null;
      state.currentValueOfOnePip = null;
      state.currentScalingFactor = null;
      state.currentExchangeRateToAccount = null;
      var minEl = document.getElementById('dealMinSize');
      if (minEl) { minEl.classList.add('hidden'); minEl.textContent = 'Min: —'; }
      var orderMinEl = document.getElementById('orderMinSize');
      if (orderMinEl) { orderMinEl.classList.add('hidden'); orderMinEl.textContent = 'Min: —'; }
      var currencyEl = document.getElementById('dealCurrency');
      if (currencyEl) currencyEl.textContent = '—';
      clearDealMessage();
      return;
    }
    var banner = document.getElementById('disconnectBanner');
    if (banner) banner.classList.add('hidden');
    if (splashHint) splashHint.classList.remove('text-red-200');
    state.accountCurrency = data.currencyIsoCode || '';
    state.activeProfile = data.activeProfile || 'demo';
    updateProfileBadge();
    var env = data.reroutingEnvironment ? ' (' + data.reroutingEnvironment.toLowerCase() + ')' : '';
    accountInfo.textContent = 'Account: ' + data.accountId + env + ': ' + (data.accountType || '');
    accountInfo.classList.remove('hidden');
    if (mainPlaceholder) mainPlaceholder.textContent = '';
    if (splashPanel) splashPanel.classList.add('hidden');
    if (dealPanel) dealPanel.classList.remove('hidden');
    if (watchlistSelect) watchlistSelect.classList.remove('hidden');
    if (epicSelect) epicSelect.disabled = false;
    setBaseEnabled(true);
    setPositionsEnabled(true);
    if (setOrdersPanelEnabled) setOrdersPanelEnabled(true);
    if (setProbesPanelEnabled) setProbesPanelEnabled(true);
    if (setTransactionLogPanelEnabled) setTransactionLogPanelEnabled(true);
    socket.emit('getWatchlists');
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var sizeEl = document.getElementById('dealSize');
      if (sizeEl && cfg.defaultSize) {
        if (!sizeEl.value) sizeEl.value = cfg.defaultSize;
        if (!sizeEl.placeholder) sizeEl.placeholder = cfg.defaultSize;
      }
      var orderSizeEl = document.getElementById('orderSize');
      if (orderSizeEl && cfg.defaultSize) {
        if (!orderSizeEl.value) orderSizeEl.value = cfg.defaultSize;
        if (!orderSizeEl.placeholder) orderSizeEl.placeholder = cfg.defaultSize;
      }
    }).catch(function () {});
  }

  socket.on('account', setAccount);

  var disconnectBanner = document.getElementById('disconnectBanner');
  socket.on('disconnect', function () {
    setAccount(null);
    if (disconnectBanner) disconnectBanner.classList.remove('hidden');
    if (splashHint) splashHint.textContent = 'Server disconnected. Press Start to reconnect.';
    if (splashHint) splashHint.classList.add('text-red-200');
  });

  socket.on('status', function (status) {
    if (splashHint && status === 'connecting') splashHint.textContent = 'Connecting...';
  });

  socket.on('login_error', function (msg) {
    if (splashHint) splashHint.textContent = 'Error: ' + msg;
    if (splashHint) splashHint.classList.add('text-red-500');
    if (mainPlaceholder) { mainPlaceholder.textContent = 'Error: ' + msg; mainPlaceholder.classList.remove('hidden'); mainPlaceholder.classList.add('text-red-500'); }
  });

  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
    state.activeProfile = cfg.activeProfile || 'demo';
    updateProfileBadge();
  }).catch(function () { state.activeProfile = 'demo'; updateProfileBadge(); });

  return {
    updateProfileFromConfig: function (cfg) {
      state.activeProfile = (cfg && cfg.activeProfile) || 'demo';
      updateProfileBadge();
    }
  };
}
