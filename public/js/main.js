/**
 * Entry point – wires socket, state, and modules.
 */
import { state } from './state.js';
import { initLog } from './log.js';
import { initStatus } from './status.js';
import { initAccount } from './account.js';
import { initDeal } from './deal.js';
import { initWatchlists } from './watchlists.js';
import { initPrices } from './prices.js';
import { initPositions } from './positions.js';
import { initOrders } from './orders.js';
import { initOrder } from './order.js';
import { initSettings } from './settings.js';
import { initProbes } from './probes.js';
import { initTestRules } from './testRules.js';
import { initTradingRules } from './tradingRules.js';
import { initTransactionLog } from './transactionLog.js';
import { initAppView } from './appView.js';
import { initOnboarding } from './onboarding.js';
import { formatTimeWithTz } from './utils.js';
import { updateDynamicTpStatusDisplay } from './dynamicTpUi.js';

const socket = io();

const log = initLog();
socket.on('log', log);
socket.on('marketDetails', function (data) {
  state.defaultCloseAt = data && data.defaultCloseAt ? data.defaultCloseAt : null;
  state.is24_7Market = !!(data && data.is24_7);
  state.clientSentiment = data && data.clientSentiment ? data.clientSentiment : null;
  var el = document.getElementById('marketClosesAt');
  if (el) {
    if (data && data.defaultCloseAt) {
      var d = new Date(data.defaultCloseAt);
      el.textContent = !isNaN(d.getTime()) ? formatTimeWithTz(data.defaultCloseAt) : '—';
    } else {
      el.textContent = '—';
    }
  }
  var sentimentEl = document.getElementById('nowSentiment');
  if (sentimentEl) {
    var s = state.clientSentiment;
    if (!s || (s.longPct === 0 && s.shortPct === 0)) {
      sentimentEl.textContent = '—';
      sentimentEl.title = 'IG client sentiment unavailable for this instrument';
      sentimentEl.className = 'font-mono text-xs text-slate-500';
    } else {
      var diff = s.longPct - s.shortPct;
      var label, cls, tooltip;
      if (diff > 5) {
        label = 'Bull';
        cls = 'font-mono text-xs text-emerald-500';
        tooltip = s.longPct + '% long / ' + s.shortPct + '% short. Bull = long > short by more than 5%.';
      } else if (diff < -5) {
        label = 'Bear';
        cls = 'font-mono text-xs text-red-500';
        tooltip = s.longPct + '% long / ' + s.shortPct + '% short. Bear = short > long by more than 5%.';
      } else {
        label = 'Neutral';
        cls = 'font-mono text-xs text-slate-400';
        tooltip = s.longPct + '% long / ' + s.shortPct + '% short. Neutral = long and short within 5%.';
      }
      sentimentEl.textContent = label;
      sentimentEl.title = tooltip;
      sentimentEl.className = cls;
    }
  }
});
socket.on('connect', function () { log('Connected'); });
socket.on('disconnect', function () { log('Disconnected'); });
log('UI ready');

const dealApi = initDeal(socket, state, log);
socket.on('dynamic_stop_loss_status', function (list) {
  state.dynamicStopLossStatus = Array.isArray(list) ? list : [];
  updateDynamicTpStatusDisplay(state);
});
const orderApi = initOrder(socket, state, log);

var probesApi = initProbes(socket, state, log);
var testRulesApi = initTestRules(socket, state, log, {
  applyTradeProfile: function (profile) {
    if (tradingRulesApi.applyTradeProfile) tradingRulesApi.applyTradeProfile(profile);
  }
});
var tradingRulesApi = initTradingRules(socket, state, dealApi.setDealEnabled, orderApi.setOrderEnabled, probesApi.setProbesPanelEnabled, probesApi.setBackfillEnabled, probesApi.setProbesSettingsLocked, probesApi.getProbeValues, dealApi.triggerDealConfirm, dealApi.placeDealDirect, log);
initStatus(socket, log, {
  onStopProbing: function () {
    tradingRulesApi.stopRulesEngine('Rules engine stopped (probing ended)');
  },
  onEngineStatusChange: function () {
    if (tradingRulesApi.updateDealEnabled) tradingRulesApi.updateDealEnabled();
    if (tradingRulesApi.updateSessionUi) tradingRulesApi.updateSessionUi();
  }
});
probesApi.setOnProbeUpdate(function () { tradingRulesApi.updateDealEnabled(); });
var transactionLogApi = initTransactionLog(socket);

function setTradePanelsVisible(visible) {
  probesApi.setProbesPanelEnabled(visible);
  tradingRulesApi.setTradingRulesPanelEnabled(visible);
  dealApi.setPositionsEnabled(visible);
  dealApi.setOrdersPanelEnabled(visible);
  dealApi.setDealPanelVisible(visible);
  transactionLogApi.setTransactionLogPanelEnabled(visible);
}

function hideAllWorkspacePanels() {
  setTradePanelsVisible(false);
  testRulesApi.setTestRulesPanelEnabled(false);
}

function refreshWorkspacePanels() {
  if (!appView.isWorkspaceReady()) {
    hideAllWorkspacePanels();
    return;
  }
  var onTrade = appView.getView() === 'trade';
  setTradePanelsVisible(onTrade);
  testRulesApi.setTestRulesPanelEnabled(!onTrade);
}

var appView = initAppView({ onViewChange: refreshWorkspacePanels });

initOnboarding(socket, state, appView, log, {
  onEnterWorkspace: refreshWorkspacePanels,
  onEpicSaved: function () {
    dealApi.loadDealSettings();
    orderApi.loadOrderSettings();
    if (tradingRulesApi.loadRules) tradingRulesApi.loadRules();
    if (testRulesApi.refreshProfilesForEpic) {
      testRulesApi.refreshProfilesForEpic(state.savedEpic || '');
    }
    if (testRulesApi.refreshRecordUi) testRulesApi.refreshRecordUi();
  }
});

var accountApi = initAccount(socket, state, tradingRulesApi.setBaseEnabled, dealApi.clearDealMessage, function (connected) {
  appView.setConnected(connected);
  if (appView.isWorkspaceReady()) refreshWorkspacePanels();
  else hideAllWorkspacePanels();
});

socket.on('status', function (status) {
  if (status === 'disconnected') return;
  var running = status === 'running';
  appView.setConnected(running);
  if (appView.isWorkspaceReady()) refreshWorkspacePanels();
});
initWatchlists(socket, state, log, {
  onEpicChange: function () {
    dealApi.loadDealSettings();
    orderApi.loadOrderSettings();
    if (tradingRulesApi.loadRules) tradingRulesApi.loadRules();
    if (testRulesApi.refreshProfilesForEpic) {
      testRulesApi.refreshProfilesForEpic(state.savedEpic || '');
    }
    if (testRulesApi.refreshRecordUi) testRulesApi.refreshRecordUi();
  }
});
initPrices(socket, state, log);
initPositions(socket, state, dealApi.showDealMessage, dealApi.clearDealMessage, log);
initOrders(socket, state, log);
initSettings(log, accountApi && accountApi.updateProfileFromConfig ? accountApi.updateProfileFromConfig : null);
