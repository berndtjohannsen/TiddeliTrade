/**
 * Saved Research backtest profiles (Option A): named snapshots + last result per epic.
 */
import {
  captureAnalyseOptionsFromDom,
  captureBacktestStrategySnapshot,
  setActiveBacktestStrategyOverride
} from './tradingRules.js';

function newProfileId() {
  return 'bp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function formatPlSummary(result) {
  if (!result) return '—';
  if (result.totalGainLossPounds != null) {
    var v = result.totalGainLossPounds;
    return (v >= 0 ? '+' : '') + v.toFixed(2);
  }
  if (result.totalGainLoss != null) {
    var p = result.totalGainLoss;
    return (p >= 0 ? '+' : '') + p.toFixed(2) + ' pts';
  }
  return '—';
}

function defaultProfileName(strategy, analyseOptions, report) {
  var sets = (analyseOptions && analyseOptions.backtestRuleSets) || ['BUY', 'SELL'];
  var days =
    report && report.daysAnalysed != null && report.daysAnalysed > 0
      ? report.daysAnalysed
      : analyseOptions && analyseOptions.selectedDays
        ? analyseOptions.selectedDays.length
        : 0;
  var pl = report ? formatPlSummary(report) : '';
  var parts = [sets.join('+')];
  if (days > 0) parts.push(days + 'd');
  if (pl && pl !== '—') parts.push(pl);
  return parts.join(' ');
}

function formatReportSummary(report) {
  if (!report) return '';
  var parts = [];
  if (report.daysAnalysed != null) parts.push(report.daysAnalysed + ' days');
  if (report.tradeCount != null) parts.push(report.tradeCount + ' trades');
  var pl = formatPlSummary(report);
  if (pl && pl !== '—') parts.push('P/L ' + pl);
  return parts.join(' · ');
}

export function initBacktestProfiles(opts) {
  var applyToTrade = opts && opts.applyToTrade ? opts.applyToTrade : null;
  var onLoadProfile = opts && opts.onLoadProfile ? opts.onLoadProfile : null;
  var onClearProfile = opts && opts.onClearProfile ? opts.onClearProfile : null;
  var getEpic = opts && opts.getEpic ? opts.getEpic : function () {
    return '';
  };

  var listEl = document.getElementById('backtestProfilesList');
  var saveBtn = document.getElementById('backtestProfileSaveBtn');
  var clearBtn = document.getElementById('backtestProfileClearLoadBtn');
  var activeLabel = document.getElementById('backtestProfileActiveLabel');
  var saveModal = document.getElementById('backtestProfileSaveModal');
  var saveIntro = document.getElementById('backtestProfileSaveIntro');
  var saveSummary = document.getElementById('backtestProfileSaveSummary');
  var saveNameInput = document.getElementById('backtestProfileSaveName');
  var saveError = document.getElementById('backtestProfileSaveError');
  var saveCancelBtn = document.getElementById('backtestProfileSaveCancel');
  var saveOkBtn = document.getElementById('backtestProfileSaveOk');
  var deleteModal = document.getElementById('backtestProfileDeleteModal');
  var deleteNameEl = document.getElementById('backtestProfileDeleteName');
  var deleteCancelBtn = document.getElementById('backtestProfileDeleteCancel');
  var deleteOkBtn = document.getElementById('backtestProfileDeleteOk');

  var profilesByEpic = Object.create(null);
  var loadedProfileId = null;
  var loadedProfileEpic = null;
  var pendingSaveReport = null;
  var pendingDelete = null;

  function setSaveError(msg) {
    if (!saveError) return;
    if (msg) {
      saveError.textContent = msg;
      saveError.classList.remove('hidden');
    } else {
      saveError.textContent = '';
      saveError.classList.add('hidden');
    }
  }

  function hideSaveModal() {
    pendingSaveReport = null;
    setSaveError('');
    if (saveModal) {
      saveModal.classList.add('hidden');
      saveModal.setAttribute('aria-hidden', 'true');
    }
  }

  function showSaveModal(opts) {
    var options = opts || {};
    var epic = getEpic();
    if (!epic) return false;
    pendingSaveReport = options.report || null;
    if (saveIntro) {
      saveIntro.textContent =
        options.intro ||
        (pendingSaveReport
          ? 'Save this backtest run as a profile? Rules, probes, and analyse options will be stored.'
          : 'Save current rules, probes, and analyse options as a named profile.');
    }
    var summaryText = options.summary != null ? options.summary : formatReportSummary(pendingSaveReport);
    if (saveSummary) {
      if (summaryText) {
        saveSummary.textContent = summaryText;
        saveSummary.classList.remove('hidden');
      } else {
        saveSummary.textContent = '';
        saveSummary.classList.add('hidden');
      }
    }
    if (saveNameInput) {
      saveNameInput.value = options.suggestedName != null ? options.suggestedName : '';
      saveNameInput.disabled = false;
    }
    setSaveError('');
    if (saveModal) {
      saveModal.classList.remove('hidden');
      saveModal.setAttribute('aria-hidden', 'false');
    }
    if (saveNameInput) {
      setTimeout(function () {
        saveNameInput.focus();
        saveNameInput.select();
      }, 0);
    }
    return true;
  }

  function submitSaveModal() {
    var epic = getEpic();
    if (!epic) {
      setSaveError('Select an instrument first');
      return;
    }
    var name = saveNameInput ? saveNameInput.value : '';
    if (saveOkBtn) saveOkBtn.disabled = true;
    saveCurrentProfile(name, pendingSaveReport)
      .then(function () {
        hideSaveModal();
      })
      .catch(function (err) {
        setSaveError(err && err.message ? err.message : 'Could not save profile');
      })
      .finally(function () {
        if (saveOkBtn) saveOkBtn.disabled = false;
      });
  }

  function hideDeleteModal() {
    pendingDelete = null;
    if (deleteModal) {
      deleteModal.classList.add('hidden');
      deleteModal.setAttribute('aria-hidden', 'true');
    }
  }

  function showDeleteModal(epic, profile) {
    if (!profile) return;
    pendingDelete = { epic: epic, id: profile.id };
    if (deleteNameEl) deleteNameEl.textContent = profile.name || profile.id;
    if (deleteModal) {
      deleteModal.classList.remove('hidden');
      deleteModal.setAttribute('aria-hidden', 'false');
    }
  }

  function confirmDeleteModal() {
    if (!pendingDelete) return;
    var epic = pendingDelete.epic;
    var id = pendingDelete.id;
    hideDeleteModal();
    deleteProfile(epic, id);
  }

  function setActiveLabel(text, visible) {
    if (!activeLabel) return;
    if (visible) {
      activeLabel.textContent = text;
      activeLabel.classList.remove('hidden');
    } else {
      activeLabel.textContent = '';
      activeLabel.classList.add('hidden');
    }
  }

  function updateClearButton() {
    if (!clearBtn) return;
    if (loadedProfileId) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }

  function getProfilesForEpic(epic) {
    return profilesByEpic[epic] || [];
  }

  function fetchProfiles() {
    return fetch('/api/config')
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        profilesByEpic = Object.create(null);
        var instruments = (cfg.ui && cfg.ui.instruments) || {};
        for (var epic in instruments) {
          if (!Object.prototype.hasOwnProperty.call(instruments, epic)) continue;
          var list = instruments[epic].backtestProfiles;
          if (Array.isArray(list) && list.length > 0) profilesByEpic[epic] = list.slice();
        }
        renderList(getEpic());
      })
      .catch(function () {
        renderList(getEpic());
      });
  }

  function persistProfiles(epic, profiles) {
    return fetch('/api/config')
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        var instruments = Object.assign({}, (cfg.ui && cfg.ui.instruments) || {});
        instruments[epic] = Object.assign({}, instruments[epic] || {}, { backtestProfiles: profiles });
        return fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ui: Object.assign({}, cfg.ui, { instruments: instruments }) })
        });
      })
      .then(function () {
        profilesByEpic[epic] = profiles.slice();
        renderList(epic);
      });
  }

  function applyAnalyseOptionsToDom(epic, options) {
    if (!options) return;
    var buyCb = document.getElementById('testRulesBacktestBuy');
    var sellCb = document.getElementById('testRulesBacktestSell');
    var sets = options.backtestRuleSets || ['BUY', 'SELL'];
    if (buyCb) buyCb.checked = sets.indexOf('BUY') >= 0;
    if (sellCb) sellCb.checked = sets.indexOf('SELL') >= 0;
    var radios = document.querySelectorAll('input[name="testRulesAnalysisMode"]');
    for (var i = 0; i < radios.length; i++) {
      var r = radios[i];
      r.checked = options.intradayOnly ? r.value === 'intraday' : r.value === 'carryover';
    }
    var fromEl = document.getElementById('testRulesFromDate');
    var toEl = document.getElementById('testRulesToDate');
    if (fromEl) fromEl.value = options.fromDate || '';
    if (toEl) toEl.value = options.toDate || '';
    var daysList = document.getElementById('testRulesDaysList');
    if (daysList) {
      var want = options.selectedDays || [];
      var boxes = daysList.querySelectorAll('input[type="checkbox"]');
      for (var b = 0; b < boxes.length; b++) {
        var cb = boxes[b];
        var val = cb.value || '';
        var pipeIdx = val.indexOf('|');
        var day = pipeIdx >= 0 ? val.slice(0, pipeIdx) : val;
        var itemEpic = pipeIdx >= 0 ? val.slice(pipeIdx + 1) : '';
        if (itemEpic && epic && itemEpic !== epic) continue;
        cb.checked = want.indexOf(day) >= 0;
      }
    }
  }

  function loadProfile(profile, epic, options) {
    if (!profile) return;
    loadedProfileId = profile.id;
    loadedProfileEpic = epic;
    setActiveBacktestStrategyOverride(profile.strategy);
    applyAnalyseOptionsToDom(epic, profile.analyseOptions);
    setActiveLabel('Profile: ' + profile.name, true);
    updateClearButton();
    if (onLoadProfile && !(options && options.skipReport)) onLoadProfile(profile);
  }

  function clearLoadedProfile() {
    loadedProfileId = null;
    loadedProfileEpic = null;
    setActiveBacktestStrategyOverride(null);
    setActiveLabel('', false);
    updateClearButton();
    if (onClearProfile) onClearProfile();
  }

  function renderList(epic) {
    if (!listEl) return;
    var profiles = getProfilesForEpic(epic);
    if (profiles.length === 0) {
      listEl.innerHTML = '<li class="text-slate-500 text-[11px] py-1">No saved profiles for this instrument.</li>';
      return;
    }
    listEl.innerHTML = profiles
      .slice()
      .sort(function (a, b) {
        return (b.savedAt || 0) - (a.savedAt || 0);
      })
      .map(function (p) {
        var active = p.id === loadedProfileId && epic === loadedProfileEpic;
        var pl = p.lastResult ? formatPlSummary(p.lastResult) : '—';
        var plClass =
          p.lastResult && (p.lastResult.totalGainLossPounds != null ? p.lastResult.totalGainLossPounds : p.lastResult.totalGainLoss) < 0
            ? 'text-red-400'
            : p.lastResult
              ? 'text-emerald-400'
              : 'text-slate-500';
        var days = p.lastResult && p.lastResult.daysAnalysed != null ? p.lastResult.daysAnalysed : '—';
        var trades = p.lastResult && p.lastResult.tradeCount != null ? p.lastResult.tradeCount : '—';
        return (
          '<li class="group flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1 py-1 ' +
          (active ? 'bg-violet-900/40 ring-1 ring-violet-600/50' : 'hover:bg-slate-800/60') +
          '">' +
          '<button type="button" class="flex-1 min-w-0 text-left" data-profile-load="' +
          p.id +
          '" title="Load profile (embedded rules; Trade tab unchanged)">' +
          '<span class="text-slate-200 font-medium truncate block">' +
          escapeHtml(p.name) +
          '</span>' +
          '<span class="font-mono text-[10px]">' +
          '<span class="' +
          plClass +
          '">' +
          pl +
          '</span>' +
          '<span class="text-slate-500"> · ' +
          days +
          ' days · ' +
          trades +
          ' trades</span>' +
          '</span>' +
          '</button>' +
          '<button type="button" class="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 hidden group-hover:inline-block" data-profile-apply="' +
          p.id +
          '" title="Copy rules to Trade tab">Trade</button>' +
          '<button type="button" class="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-slate-800 hover:bg-red-900/50 text-slate-400 hover:text-red-300" data-profile-delete="' +
          p.id +
          '" title="Delete profile">×</button>' +
          '</li>'
        );
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function findProfile(epic, id) {
    var list = getProfilesForEpic(epic);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function saveCurrentProfile(name, report) {
    var epic = getEpic();
    if (!epic) return Promise.reject(new Error('Select an instrument first'));
    var strategy = captureBacktestStrategySnapshot();
    var analyseOptions = captureAnalyseOptionsFromDom(epic);
    var profile = {
      id: newProfileId(),
      name: name.trim() || defaultProfileName(strategy, analyseOptions, report),
      savedAt: Date.now(),
      strategy: strategy,
      analyseOptions: analyseOptions,
      lastResult: report
        ? {
            totalGainLoss: report.totalGainLoss,
            totalGainLossPounds: report.totalGainLossPounds,
            daysAnalysed: report.daysAnalysed,
            tradeCount: report.tradeCount,
            winRate: report.winRate,
            runAt: Date.now()
          }
        : undefined
    };
    var profiles = getProfilesForEpic(epic).slice();
    profiles.push(profile);
    return persistProfiles(epic, profiles).then(function () {
      loadProfile(profile, epic, { skipReport: true });
      return profile;
    });
  }

  function updateProfileResult(epic, profileId, report) {
    if (!epic || !profileId || !report) return Promise.resolve();
    var profiles = getProfilesForEpic(epic).slice();
    var idx = -1;
    for (var i = 0; i < profiles.length; i++) {
      if (profiles[i].id === profileId) idx = i;
    }
    if (idx < 0) return Promise.resolve();
    profiles[idx] = Object.assign({}, profiles[idx], {
      lastResult: {
        totalGainLoss: report.totalGainLoss,
        totalGainLossPounds: report.totalGainLossPounds,
        daysAnalysed: report.daysAnalysed,
        tradeCount: report.tradeCount,
        winRate: report.winRate,
        runAt: Date.now()
      }
    });
    return persistProfiles(epic, profiles);
  }

  function deleteProfile(epic, id) {
    var profiles = getProfilesForEpic(epic).filter(function (p) {
      return p.id !== id;
    });
    if (loadedProfileId === id && loadedProfileEpic === epic) clearLoadedProfile();
    return persistProfiles(epic, profiles);
  }

  function promptSaveAfterAnalyse(report) {
    if (!report) return;
    var strategy = captureBacktestStrategySnapshot();
    var analyseOptions = captureAnalyseOptionsFromDom(getEpic());
    var suggested = defaultProfileName(strategy, analyseOptions, report);
    showSaveModal({
      report: report,
      suggestedName: suggested,
      summary: formatReportSummary(report)
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      if (!getEpic()) {
        if (activeLabel) {
          activeLabel.textContent = 'Select an instrument first';
          activeLabel.classList.remove('hidden');
        }
        return;
      }
      showSaveModal({ suggestedName: '' });
    });
  }

  if (saveCancelBtn) saveCancelBtn.addEventListener('click', hideSaveModal);
  if (saveOkBtn) saveOkBtn.addEventListener('click', submitSaveModal);
  if (saveNameInput) {
    saveNameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitSaveModal();
      }
    });
  }
  if (saveModal) {
    saveModal.addEventListener('click', function (e) {
      if (e.target === saveModal) hideSaveModal();
    });
  }

  if (deleteCancelBtn) deleteCancelBtn.addEventListener('click', hideDeleteModal);
  if (deleteOkBtn) deleteOkBtn.addEventListener('click', confirmDeleteModal);
  if (deleteModal) {
    deleteModal.addEventListener('click', function (e) {
      if (e.target === deleteModal) hideDeleteModal();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (saveModal && !saveModal.classList.contains('hidden')) hideSaveModal();
    else if (deleteModal && !deleteModal.classList.contains('hidden')) hideDeleteModal();
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      clearLoadedProfile();
    });
  }

  if (listEl) {
    listEl.addEventListener('click', function (e) {
      var epic = getEpic();
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var loadId = t.getAttribute('data-profile-load');
      if (!loadId && t.closest) {
        var btn = t.closest('[data-profile-load]');
        if (btn) loadId = btn.getAttribute('data-profile-load');
      }
      if (loadId) {
        var p = findProfile(epic, loadId);
        if (p) loadProfile(p, epic);
        return;
      }
      var delId = t.getAttribute('data-profile-delete');
      if (delId) {
        var delProfile = findProfile(epic, delId);
        if (delProfile) showDeleteModal(epic, delProfile);
        return;
      }
      var applyId = t.getAttribute('data-profile-apply');
      if (applyId && applyToTrade) {
        var prof = findProfile(epic, applyId);
        if (prof && prof.strategy) applyToTrade(prof.strategy);
      }
    });
  }

  fetchProfiles();

  return {
    refreshForEpic: function (epic) {
      renderList(epic || getEpic());
      if (loadedProfileEpic && epic && loadedProfileEpic !== epic) clearLoadedProfile();
    },
    reload: fetchProfiles,
    promptSaveAfterAnalyse: promptSaveAfterAnalyse,
    getLoadedProfileId: function () {
      return loadedProfileId;
    },
    updateLoadedProfileResult: function (epic, report) {
      if (loadedProfileId && loadedProfileEpic === epic) {
        return updateProfileResult(epic, loadedProfileId, report);
      }
      return Promise.resolve();
    },
    clearLoadedProfile: clearLoadedProfile
  };
}

/** Build a minimal report object from saved lastResult for display on load. */
export function reportFromProfileLastResult(lastResult) {
  if (!lastResult) return null;
  return {
    totalGainLoss: lastResult.totalGainLoss,
    totalGainLossPounds: lastResult.totalGainLossPounds,
    daysAnalysed: lastResult.daysAnalysed,
    tradeCount: lastResult.tradeCount,
    winningTrades: null,
    losingTrades: null,
    winRate: lastResult.winRate,
    sampleCount: null,
    startTs: 0,
    endTs: 0
  };
}
