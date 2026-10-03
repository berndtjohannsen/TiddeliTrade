/**
 * Account display and workspace connection state.
 */
import { syncHeaderInstrument } from './onboarding.js';

export function initAccount(socket, state, setBaseEnabled, clearDealMessage, onWorkspaceConnectionChange) {
  var accountInfo = document.getElementById('accountInfo');
  var mainPlaceholder = document.getElementById('mainPlaceholder');
  var splashHint = document.getElementById('splashHint');

  setBaseEnabled(false);
  if (onWorkspaceConnectionChange) onWorkspaceConnectionChange(false);

  function isIgLoggedIn() {
    return state.engineStatus === 'connected' || state.engineStatus === 'running';
  }

  function updateOverviewProfileBadge() {
    var overviewBadge = document.getElementById('tradeOverviewProfileBadge');
    if (!overviewBadge) return;
    var profile = state.activeProfile || 'demo';
    var isLive = profile === 'live';
    overviewBadge.textContent = isLive ? 'LIVE' : 'Demo';
    overviewBadge.className = 'profile-indicator ' + (isLive ? 'profile-indicator--live' : 'profile-indicator--demo');
    overviewBadge.setAttribute('aria-label', isLive ? 'Live account' : 'Demo account');
    if (isLive) {
      overviewBadge.setAttribute(
        'data-tooltip',
        'Real money — trades execute on your live IG account'
      );
    } else {
      overviewBadge.setAttribute('data-tooltip', 'Demo account — no real money');
    }
  }

  function updateProfileBadge() {
    updateOverviewProfileBadge();
    var badge = document.getElementById('profileBadge');
    if (badge) {
      if (!isIgLoggedIn()) {
        badge.classList.add('hidden');
        badge.removeAttribute('data-tooltip');
      } else {
        var profile = state.activeProfile || 'demo';
        var isLive = profile === 'live';
        badge.textContent = isLive ? 'LIVE' : 'Demo';
        badge.className = 'profile-indicator ' + (isLive ? 'profile-indicator--live' : 'profile-indicator--demo');
        badge.classList.remove('hidden');
        badge.setAttribute('aria-label', isLive ? 'Live account' : 'Demo account');
        if (isLive) {
          badge.setAttribute('data-tooltip', 'Real money — trades execute on your live IG account');
        } else {
          badge.removeAttribute('data-tooltip');
        }
      }
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
      updateProfileBadge();
      fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
        state.activeProfile = cfg.activeProfile || 'demo';
        updateProfileBadge();
      }).catch(function () { state.activeProfile = 'demo'; updateProfileBadge(); });
      if (mainPlaceholder) { mainPlaceholder.textContent = ''; mainPlaceholder.classList.add('hidden'); }
      if (splashHint) { splashHint.textContent = ''; splashHint.classList.add('hidden'); }
      fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
        syncHeaderInstrument(state, cfg);
      }).catch(function () {});
      setBaseEnabled(false);
      if (onWorkspaceConnectionChange) onWorkspaceConnectionChange(false);
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
    var sessionActive = state.engineStatus === 'running' || state.engineStatus === 'connected';
    setBaseEnabled(sessionActive);
    if (onWorkspaceConnectionChange) onWorkspaceConnectionChange(sessionActive);
    if (sessionActive) socket.emit('getWatchlists');
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      syncHeaderInstrument(state, cfg);
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
    if (splashHint) splashHint.textContent = 'Server disconnected. Open Account or Home to reconnect.';
    if (splashHint) splashHint.classList.add('text-red-200');
  });

  socket.on('status', function (status) {
    if (splashHint && status === 'connecting') splashHint.textContent = 'Connecting...';
    updateProfileBadge();
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
