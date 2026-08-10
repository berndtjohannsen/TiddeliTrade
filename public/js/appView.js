/**
 * Trade vs Research workspace tabs (shared header, same socket session).
 */

const STORAGE_KEY = 'tiddeliTradeAppView';

/** @typedef {'trade'|'research'} AppViewId */

/**
 * @param {{ onViewChange?: (view: AppViewId) => void }} [opts]
 */
export function initAppView(opts) {
  var onViewChange = opts && opts.onViewChange ? opts.onViewChange : null;
  /** @type {AppViewId} */
  var currentView = 'trade';
  var connected = false;
  var workspaceReady = false;

  var tradeRoot = document.getElementById('tradeViewRoot');
  var researchRoot = document.getElementById('researchViewRoot');
  var launchPanel = document.getElementById('launchPanel');
  var navTrade = document.getElementById('appNavTrade');
  var navResearch = document.getElementById('appNavResearch');

  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'research' || saved === 'trade') currentView = saved;
  } catch (_) { /* ignore */ }

  function updateNavButtons() {
    var tradeActive = currentView === 'trade';
    var tradeCls =
      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ' +
      (tradeActive ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200');
    var researchCls =
      'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ' +
      (!tradeActive ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200');
    if (navTrade) {
      navTrade.className = tradeCls;
      navTrade.setAttribute('aria-selected', tradeActive ? 'true' : 'false');
    }
    if (navResearch) {
      navResearch.className = researchCls;
      navResearch.setAttribute('aria-selected', !tradeActive ? 'true' : 'false');
    }
  }

  function applyLayout() {
    var showWorkspace = workspaceReady;
    var tradeOn = showWorkspace && currentView === 'trade';
    var researchOn = showWorkspace && currentView === 'research';
    if (tradeRoot) tradeRoot.classList.toggle('hidden', !tradeOn);
    if (researchRoot) researchRoot.classList.toggle('hidden', !researchOn);
    if (launchPanel) launchPanel.classList.toggle('hidden', showWorkspace);
    var placeholder = document.getElementById('mainPlaceholder');
    if (placeholder) placeholder.classList.toggle('hidden', !showWorkspace || connected);
    updateNavButtons();
  }

  function setView(view) {
    if (view !== 'trade' && view !== 'research') return;
    currentView = view;
    try {
      localStorage.setItem(STORAGE_KEY, view);
    } catch (_) { /* ignore */ }
    applyLayout();
    if (onViewChange) onViewChange(view);
  }

  function setConnected(isConnected) {
    connected = !!isConnected;
    applyLayout();
  }

  function setWorkspaceReady(ready) {
    workspaceReady = !!ready;
    applyLayout();
  }

  if (navTrade) {
    navTrade.addEventListener('click', function () {
      if (!workspaceReady) return;
      setView('trade');
    });
  }
  if (navResearch) {
    navResearch.addEventListener('click', function () {
      if (!workspaceReady) return;
      setView('research');
    });
  }

  var openTradeRulesBtn = document.getElementById('researchOpenTradeRulesBtn');
  if (openTradeRulesBtn) {
    openTradeRulesBtn.addEventListener('click', function () {
      if (!workspaceReady) return;
      setView('trade');
    });
  }

  updateNavButtons();
  applyLayout();

  return {
    getView: function () {
      return currentView;
    },
    setView: setView,
    setConnected: setConnected,
    setWorkspaceReady: setWorkspaceReady,
    isConnected: function () {
      return connected;
    },
    isWorkspaceReady: function () {
      return workspaceReady;
    }
  };
}
