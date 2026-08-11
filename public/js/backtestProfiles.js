/**
 * Saved strategy profiles per instrument — selected on Trade, shared with Research backtests.
 */
import {
  captureAnalyseOptionsFromDom,
  captureBacktestStrategySnapshot,
  captureEngineControlsSnapshot,
  setActiveBacktestEngineControlsOverride,
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

/** Report summary from profile (saved full report or legacy lastResult). */
function profileReportSummary(profile) {
  if (profile && profile.savedReport && profile.savedReport.report) return profile.savedReport.report;
  if (profile && profile.lastResult) return profile.lastResult;
  return null;
}

function normalizeSavePayload(reportOrPayload) {
  if (!reportOrPayload) return null;
  if (reportOrPayload.report) return reportOrPayload;
  return { report: reportOrPayload };
}

function cloneTradesForSave(trades, maxTrades) {
  if (!Array.isArray(trades)) return { trades: [], truncated: false };
  var list = trades;
  var truncated = false;
  if (typeof maxTrades === 'number' && maxTrades > 0 && list.length > maxTrades) {
    list = list.slice(0, maxTrades);
    truncated = true;
  }
  var out = list.map(function (t) {
    var copy = {
      direction: t.direction,
      entryTs: t.entryTs,
      entryPrice: t.entryPrice,
      exitTs: t.exitTs,
      exitPrice: t.exitPrice,
      profitLoss: t.profitLoss,
      exitReason: t.exitReason
    };
    if (Array.isArray(t.entryRules)) {
      copy.entryRules = t.entryRules.map(function (r) {
        return Object.assign({}, r);
      });
    }
    return copy;
  });
  return { trades: out, truncated: truncated };
}

/** Cap trades stored in config profiles (full report stays in session until reload). */
var MAX_PROFILE_SAVED_TRADES = 2000;

function cloneReportForSave(report) {
  if (!report) return null;
  var clonedTrades = cloneTradesForSave(report.trades, MAX_PROFILE_SAVED_TRADES);
  return {
    trades: clonedTrades.trades,
    tradesTruncated: clonedTrades.truncated,
    totalGainLoss: report.totalGainLoss,
    totalGainLossPounds: report.totalGainLossPounds,
    tradeCount: report.tradeCount,
    winningTrades: report.winningTrades,
    losingTrades: report.losingTrades,
    winRate: report.winRate,
    avgTradePnl: report.avgTradePnl,
    avgTradePnlPounds: report.avgTradePnlPounds,
    sampleCount: report.sampleCount,
    startTs: report.startTs,
    endTs: report.endTs,
    openAtEnd: report.openAtEnd,
    daysAnalysed: report.daysAnalysed,
    closeReasonCounts: report.closeReasonCounts ? Object.assign({}, report.closeReasonCounts) : undefined,
    nonConsecutiveWarning: report.nonConsecutiveWarning,
    ruleBlockerCounts: Array.isArray(report.ruleBlockerCounts)
      ? report.ruleBlockerCounts.map(function (b) { return Object.assign({}, b); })
      : undefined,
    dynamicStopLossApplied: report.dynamicStopLossApplied,
    dynamicStopLossNote: report.dynamicStopLossNote,
    analysedDays: Array.isArray(report.analysedDays)
      ? report.analysedDays.map(function (d) { return Object.assign({}, d); })
      : undefined
  };
}

function cloneSampleQualityForSave(sampleQuality) {
  if (!sampleQuality) return undefined;
  return {
    hasWarnings: !!sampleQuality.hasWarnings,
    summaryWarnings: Array.isArray(sampleQuality.summaryWarnings) ? sampleQuality.summaryWarnings.slice() : [],
    totalSamples: sampleQuality.totalSamples,
    dayCount: sampleQuality.dayCount,
    gapsOver5s: sampleQuality.gapsOver5s,
    gapsOver30s: sampleQuality.gapsOver30s,
    gapsOver60s: sampleQuality.gapsOver60s,
    maxGapMs: sampleQuality.maxGapMs,
    estimatedMissingSamples: sampleQuality.estimatedMissingSamples,
    largeMidJumpCount: sampleQuality.largeMidJumpCount,
    invalidSpreadCount: sampleQuality.invalidSpreadCount,
    days: Array.isArray(sampleQuality.days)
      ? sampleQuality.days.map(function (d) {
          return Object.assign({}, d, {
            warnings: Array.isArray(d.warnings) ? d.warnings.slice() : []
          });
        })
      : []
  };
}

function buildSavedReportSnapshot(payload) {
  var normalized = normalizeSavePayload(payload);
  if (!normalized || !normalized.report) return undefined;
  var runAt = Date.now();
  return {
    runAt: runAt,
    report: cloneReportForSave(normalized.report),
    sampleQuality: cloneSampleQualityForSave(normalized.sampleQuality),
    usedTpSl: !!normalized.usedTpSl,
    usedDynamicSl: !!normalized.usedDynamicSl,
    analysedDayKeys: Array.isArray(normalized.analysedDayKeys) ? normalized.analysedDayKeys.slice() : undefined
  };
}

function summaryFromReport(report, runAt) {
  if (!report) return undefined;
  return {
    totalGainLoss: report.totalGainLoss,
    totalGainLossPounds: report.totalGainLossPounds,
    daysAnalysed: report.daysAnalysed,
    tradeCount: report.tradeCount,
    winRate: report.winRate,
    runAt: runAt != null ? runAt : Date.now()
  };
}

function profileResultDiffers(profile, report) {
  if (!report) return false;
  var last = profileReportSummary(profile);
  if (!last) return true;
  if (last.tradeCount !== report.tradeCount) return true;
  if (last.daysAnalysed !== report.daysAnalysed) return true;
  var plA = last.totalGainLossPounds != null ? last.totalGainLossPounds : last.totalGainLoss;
  var plB = report.totalGainLossPounds != null ? report.totalGainLossPounds : report.totalGainLoss;
  if (plA == null || plB == null) return plA !== plB;
  return Math.abs(plA - plB) > 0.001;
}

function formatProfileDate(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function initBacktestProfiles(opts) {
  var applyTradeProfile = opts && opts.applyTradeProfile ? opts.applyTradeProfile : null;
  var onLoadProfile = opts && opts.onLoadProfile ? opts.onLoadProfile : null;
  var onRestoreSavedReport = opts && opts.onRestoreSavedReport ? opts.onRestoreSavedReport : null;
  var getEpic = opts && opts.getEpic ? opts.getEpic : function () {
    return '';
  };

  var listEl = document.getElementById('backtestProfilesList');
  var tradeSelectEl = document.getElementById('tradeProfileSelect');
  var saveBtn = document.getElementById('backtestProfileSaveBtn');
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
  var renameModal = document.getElementById('backtestProfileRenameModal');
  var renameNameInput = document.getElementById('backtestProfileRenameName');
  var renameError = document.getElementById('backtestProfileRenameError');
  var renameCancelBtn = document.getElementById('backtestProfileRenameCancel');
  var renameOkBtn = document.getElementById('backtestProfileRenameOk');

  var profilesByEpic = Object.create(null);
  var activeTradeProfileByEpic = Object.create(null);
  var pendingSavePayload = null;
  var pendingDelete = null;
  var pendingRename = null;

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
    pendingSavePayload = null;
    setSaveError('');
    if (saveModal) {
      saveModal.classList.add('hidden');
      saveModal.setAttribute('aria-hidden', 'true');
    }
  }

  function showSaveModal(opts) {
    var options = opts || {};
    var epic = options.epic || getEpic();
    if (!epic) return false;
    pendingSavePayload = options.payload || (options.report ? { report: options.report } : null);
    var reportForUi = pendingSavePayload && pendingSavePayload.report ? pendingSavePayload.report : null;
    if (saveIntro) {
      saveIntro.textContent =
        options.intro ||
        (reportForUi
          ? 'Save this backtest run as a profile? Rules, probes, engine controls, analyse options, and the full backtest report will be stored.'
          : 'Save current rules, probes, engine controls, and analyse options as a named profile.');
    }
    var summaryText = options.summary != null ? options.summary : formatReportSummary(reportForUi);
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
    saveCurrentProfile(name, pendingSavePayload)
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

  function setRenameError(msg) {
    if (!renameError) return;
    if (msg) {
      renameError.textContent = msg;
      renameError.classList.remove('hidden');
    } else {
      renameError.textContent = '';
      renameError.classList.add('hidden');
    }
  }

  function hideRenameModal() {
    pendingRename = null;
    setRenameError('');
    if (renameModal) {
      renameModal.classList.add('hidden');
      renameModal.setAttribute('aria-hidden', 'true');
    }
  }

  function showRenameModal(epic, profile) {
    if (!profile) return;
    pendingRename = { epic: epic, id: profile.id };
    if (renameNameInput) {
      renameNameInput.value = profile.name || '';
      renameNameInput.disabled = false;
    }
    setRenameError('');
    if (renameModal) {
      renameModal.classList.remove('hidden');
      renameModal.setAttribute('aria-hidden', 'false');
    }
    if (renameNameInput) {
      setTimeout(function () {
        renameNameInput.focus();
        renameNameInput.select();
      }, 0);
    }
  }

  function profileNameTaken(epic, name, excludeId) {
    var trimmed = (name || '').trim();
    if (!trimmed) return false;
    var profiles = getProfilesForEpic(epic);
    for (var i = 0; i < profiles.length; i++) {
      if (profiles[i].id === excludeId) continue;
      if (profiles[i].name === trimmed) return true;
    }
    return false;
  }

  function confirmRenameModal() {
    if (!pendingRename) return;
    var epic = pendingRename.epic;
    var id = pendingRename.id;
    var name = renameNameInput ? renameNameInput.value : '';
    var trimmed = name.trim();
    if (!trimmed) {
      setRenameError('Enter a profile name');
      return;
    }
    var profile = findProfile(epic, id);
    if (profile && profile.name === trimmed) {
      hideRenameModal();
      return;
    }
    if (profileNameTaken(epic, trimmed, id)) {
      setRenameError('Another profile already uses that name');
      return;
    }
    if (renameOkBtn) renameOkBtn.disabled = true;
    renameProfile(epic, id, trimmed)
      .then(function () {
        hideRenameModal();
      })
      .catch(function (err) {
        setRenameError(err && err.message ? err.message : 'Could not rename profile');
      })
      .finally(function () {
        if (renameOkBtn) renameOkBtn.disabled = false;
      });
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

  function getActiveTradeProfileId(epic) {
    return activeTradeProfileByEpic[epic] || '';
  }

  function setActiveLabelForEpic(epic) {
    var id = getActiveTradeProfileId(epic);
    if (!id) {
      setActiveLabel('', false);
      return;
    }
    var profile = findProfile(epic, id);
    if (!profile) {
      setActiveLabel('', false);
      return;
    }
    setActiveLabel('Active: ' + profile.name + ' (' + formatProfileDate(profile.savedAt) + ')', true);
  }

  function clearBacktestOverrides() {
    setActiveBacktestStrategyOverride(null);
    setActiveBacktestEngineControlsOverride(null);
  }

  function persistActiveTradeProfileId(epic, profileId) {
    if (!epic) return Promise.resolve();
    if (profileId) activeTradeProfileByEpic[epic] = profileId;
    else delete activeTradeProfileByEpic[epic];
    return fetch('/api/config')
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        var inst = Object.assign({}, (cfg.ui && cfg.ui.instruments && cfg.ui.instruments[epic]) || {});
        if (profileId) inst.activeTradeProfileId = profileId;
        else delete inst.activeTradeProfileId;
        var instrumentsPatch = Object.create(null);
        instrumentsPatch[epic] = inst;
        return fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ui: { instruments: instrumentsPatch } })
        });
      });
  }

  function renderTradeSelect(epic) {
    if (!tradeSelectEl) return;
    var profiles = getProfilesForEpic(epic);
    var activeId = getActiveTradeProfileId(epic);
    var html = '<option value="">Custom (manual edits)</option>';
    profiles
      .slice()
      .sort(function (a, b) {
        return (b.savedAt || 0) - (a.savedAt || 0);
      })
      .forEach(function (p) {
        var pl = formatPlSummary(profileReportSummary(p));
        var suffix = pl && pl !== '—' ? ' · ' + pl : '';
        html +=
          '<option value="' +
          escapeHtml(p.id) +
          '"' +
          (p.id === activeId ? ' selected' : '') +
          '>' +
          escapeHtml(p.name) +
          suffix +
          '</option>';
      });
    tradeSelectEl.innerHTML = html;
    tradeSelectEl.value = activeId && findProfile(epic, activeId) ? activeId : '';
    tradeSelectEl.disabled = !epic;
  }

  function activateTradeProfile(profile, epic, options) {
    if (!profile || !epic) return;
    var skipApply = options && options.skipApply;
    if (!skipApply && applyTradeProfile) applyTradeProfile(profile);
    clearBacktestOverrides();
    activeTradeProfileByEpic[epic] = profile.id;
    applyAnalyseOptionsToDom(epic, profile.analyseOptions);
    persistActiveTradeProfileId(epic, profile.id).then(function () {
      renderTradeSelect(epic);
      renderList(epic);
      setActiveLabelForEpic(epic);
    });
    if (onLoadProfile && !(options && options.skipReport)) onLoadProfile(profile);
    if (onRestoreSavedReport && !(options && options.skipReport)) {
      var toRestore = profile.savedReport || savedReportFromProfile(profile);
      if (toRestore && toRestore.report) onRestoreSavedReport(toRestore);
    }
  }

  function clearTradeProfileSelection(epic) {
    if (!epic) return;
    delete activeTradeProfileByEpic[epic];
    clearBacktestOverrides();
    persistActiveTradeProfileId(epic, '').then(function () {
      renderTradeSelect(epic);
      renderList(epic);
      setActiveLabel('', false);
    });
  }

  function getProfilesForEpic(epic) {
    return profilesByEpic[epic] || [];
  }

  function suggestUniqueProfileName(base, epic) {
    var trimmed = (base || '').trim();
    if (!trimmed) return trimmed;
    var profiles = getProfilesForEpic(epic);
    var names = Object.create(null);
    for (var i = 0; i < profiles.length; i++) names[profiles[i].name] = true;
    if (!names[trimmed]) return trimmed;
    var n = 2;
    while (names[trimmed + ' ' + n]) n++;
    return trimmed + ' ' + n;
  }

  function fetchProfiles() {
    return fetch('/api/config')
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        profilesByEpic = Object.create(null);
        activeTradeProfileByEpic = Object.create(null);
        var instruments = (cfg.ui && cfg.ui.instruments) || {};
        for (var epic in instruments) {
          if (!Object.prototype.hasOwnProperty.call(instruments, epic)) continue;
          var inst = instruments[epic];
          var list = inst.backtestProfiles;
          if (Array.isArray(list) && list.length > 0) profilesByEpic[epic] = list.slice();
          if (inst.activeTradeProfileId) activeTradeProfileByEpic[epic] = inst.activeTradeProfileId;
        }
        var currentEpic = getEpic();
        renderTradeSelect(currentEpic);
        renderList(currentEpic);
        setActiveLabelForEpic(currentEpic);
      })
      .catch(function () {
        renderTradeSelect(getEpic());
        renderList(getEpic());
      });
  }

  function persistProfiles(epic, profiles) {
    return fetch('/api/config')
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        var instrumentsPatch = Object.create(null);
        instrumentsPatch[epic] = Object.assign({}, (cfg.ui && cfg.ui.instruments && cfg.ui.instruments[epic]) || {}, {
          backtestProfiles: profiles
        });
        return fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ui: { instruments: instrumentsPatch } })
        });
      })
      .then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (body) {
            throw new Error((body && body.error) || ('Could not save profile (HTTP ' + r.status + ')'));
          });
        }
      })
      .then(function () {
        profilesByEpic[epic] = profiles.slice();
        renderTradeSelect(epic);
        renderList(epic);
        setActiveLabelForEpic(epic);
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
    activateTradeProfile(profile, epic, options);
  }

  function clearLoadedProfile() {
    clearTradeProfileSelection(getEpic());
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
        var active = p.id === getActiveTradeProfileId(epic);
        var summary = profileReportSummary(p);
        var pl = summary ? formatPlSummary(summary) : '—';
        var plClass =
          summary && (summary.totalGainLossPounds != null ? summary.totalGainLossPounds : summary.totalGainLoss) < 0
            ? 'text-red-400'
            : summary
              ? 'text-emerald-400'
              : 'text-slate-500';
        var days = summary && summary.daysAnalysed != null ? summary.daysAnalysed : '—';
        var trades = summary && summary.tradeCount != null ? summary.tradeCount : '—';
        var savedDate = formatProfileDate(p.savedAt);
        return (
          '<li class="group flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1 py-1 ' +
          (active ? 'bg-violet-900/40 ring-1 ring-violet-600/50' : 'hover:bg-slate-800/60') +
          '">' +
          '<button type="button" class="flex-1 min-w-0 text-left" data-profile-load="' +
          p.id +
          '" title="Activate on Trade (same rules for backtest) — saved ' +
          savedDate +
          '">' +
          '<span class="text-slate-200 font-medium truncate block">' +
          escapeHtml(p.name) +
          '</span>' +
          '<span class="font-mono text-[10px]">' +
          '<span class="text-slate-500">' +
          savedDate +
          '</span>' +
          '<span class="text-slate-500"> · </span>' +
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
          '<button type="button" class="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200" data-profile-rename="' +
          p.id +
          '" title="Rename profile">✎</button>' +
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

  function saveCurrentProfile(name, payload) {
    var epic = getEpic();
    if (!epic) return Promise.reject(new Error('Select an instrument first'));
    var strategy = captureBacktestStrategySnapshot();
    var analyseOptions = captureAnalyseOptionsFromDom(epic);
    var engineControls = captureEngineControlsSnapshot();
    var normalized = normalizeSavePayload(payload);
    var report = normalized && normalized.report ? normalized.report : null;
    var savedReport = buildSavedReportSnapshot(normalized);
    var profile = {
      id: newProfileId(),
      name: name.trim() || defaultProfileName(strategy, analyseOptions, report),
      savedAt: Date.now(),
      strategy: strategy,
      analyseOptions: analyseOptions,
      engineControls: engineControls,
      savedReport: savedReport,
      lastResult: savedReport ? summaryFromReport(savedReport.report, savedReport.runAt) : undefined
    };
    var profiles = getProfilesForEpic(epic).slice();
    profiles.push(profile);
    return persistProfiles(epic, profiles).then(function () {
      activateTradeProfile(profile, epic, { skipApply: true, skipReport: true });
      return profile;
    });
  }

  function updateProfileResult(epic, profileId, payload) {
    var normalized = normalizeSavePayload(payload);
    if (!epic || !profileId || !normalized || !normalized.report) return Promise.resolve();
    var savedReport = buildSavedReportSnapshot(normalized);
    if (!savedReport) return Promise.resolve();
    var profiles = getProfilesForEpic(epic).slice();
    var idx = -1;
    for (var i = 0; i < profiles.length; i++) {
      if (profiles[i].id === profileId) idx = i;
    }
    if (idx < 0) return Promise.resolve();
    profiles[idx] = Object.assign({}, profiles[idx], {
      savedReport: savedReport,
      lastResult: summaryFromReport(savedReport.report, savedReport.runAt)
    });
    return persistProfiles(epic, profiles);
  }

  function deleteProfile(epic, id) {
    var profiles = getProfilesForEpic(epic).filter(function (p) {
      return p.id !== id;
    });
    var wasActive = getActiveTradeProfileId(epic) === id;
    if (wasActive) {
      delete activeTradeProfileByEpic[epic];
      clearBacktestOverrides();
    }
    return persistProfiles(epic, profiles).then(function () {
      if (wasActive) {
        return persistActiveTradeProfileId(epic, '').then(function () {
          renderTradeSelect(epic);
          setActiveLabel('', false);
        });
      }
    });
  }

  function renameProfile(epic, id, newName) {
    var trimmed = (newName || '').trim();
    if (!trimmed) return Promise.reject(new Error('Enter a profile name'));
    if (profileNameTaken(epic, trimmed, id)) {
      return Promise.reject(new Error('Another profile already uses that name'));
    }
    var profiles = getProfilesForEpic(epic).slice();
    var idx = -1;
    for (var i = 0; i < profiles.length; i++) {
      if (profiles[i].id === id) idx = i;
    }
    if (idx < 0) return Promise.reject(new Error('Profile not found'));
    profiles[idx] = Object.assign({}, profiles[idx], { name: trimmed });
    return persistProfiles(epic, profiles);
  }

  function promptSaveAfterAnalyse(payload, epicOverride) {
    var normalized = normalizeSavePayload(payload);
    if (!normalized || !normalized.report) return;
    var epic = epicOverride || getEpic();
    if (!epic) return;
    var report = normalized.report;
    var strategy = captureBacktestStrategySnapshot();
    var analyseOptions = captureAnalyseOptionsFromDom(epic);
    var suggested = defaultProfileName(strategy, analyseOptions, report);
    showSaveModal({
      epic: epic,
      payload: normalized,
      suggestedName: suggested,
      summary: formatReportSummary(report)
    });
  }

  function promptSaveAfterAnalyseIfNeeded(payload, epicOverride) {
    var normalized = normalizeSavePayload(payload);
    if (!normalized || !normalized.report) return Promise.resolve();
    var report = normalized.report;
    var epic = epicOverride || getEpic();
    if (!epic) return Promise.resolve();
    var activeId = getActiveTradeProfileId(epic);
    if (!activeId) {
      promptSaveAfterAnalyse(normalized, epic);
      return Promise.resolve();
    }
    var profile = findProfile(epic, activeId);
    if (!profile) {
      promptSaveAfterAnalyse(normalized, epic);
      return Promise.resolve();
    }
    if (!profileResultDiffers(profile, report)) {
      return updateProfileResult(epic, activeId, normalized);
    }
    var suggested = suggestUniqueProfileName(profile.name + ' copy', epic);
    showSaveModal({
      epic: epic,
      payload: normalized,
      suggestedName: suggested,
      summary: formatReportSummary(report),
      intro:
        'Results differ from profile "' +
        profile.name +
        '". Save as a new profile? The original keeps its saved result.'
    });
    return Promise.resolve();
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

  if (renameCancelBtn) renameCancelBtn.addEventListener('click', hideRenameModal);
  if (renameOkBtn) renameOkBtn.addEventListener('click', confirmRenameModal);
  if (renameNameInput) {
    renameNameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmRenameModal();
      }
    });
  }
  if (renameModal) {
    renameModal.addEventListener('click', function (e) {
      if (e.target === renameModal) hideRenameModal();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (saveModal && !saveModal.classList.contains('hidden')) hideSaveModal();
    else if (renameModal && !renameModal.classList.contains('hidden')) hideRenameModal();
    else if (deleteModal && !deleteModal.classList.contains('hidden')) hideDeleteModal();
  });

  if (tradeSelectEl) {
    tradeSelectEl.addEventListener('change', function () {
      var epic = getEpic();
      if (!epic) return;
      var id = tradeSelectEl.value || '';
      if (!id) {
        clearTradeProfileSelection(epic);
        return;
      }
      var profile = findProfile(epic, id);
      if (profile) activateTradeProfile(profile, epic);
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
        if (p) activateTradeProfile(p, epic);
        return;
      }
      var delId = t.getAttribute('data-profile-delete');
      if (delId) {
        var delProfile = findProfile(epic, delId);
        if (delProfile) showDeleteModal(epic, delProfile);
        return;
      }
      var renameId = t.getAttribute('data-profile-rename');
      if (!renameId && t.closest) {
        var renameBtn = t.closest('[data-profile-rename]');
        if (renameBtn) renameId = renameBtn.getAttribute('data-profile-rename');
      }
      if (renameId) {
        var profileToRename = findProfile(epic, renameId);
        if (profileToRename) showRenameModal(epic, profileToRename);
        return;
      }
    });
  }

  fetchProfiles();

  return {
    refreshForEpic: function (epic) {
      var e = epic || getEpic();
      renderTradeSelect(e);
      renderList(e);
      setActiveLabelForEpic(e);
    },
    reload: fetchProfiles,
    promptSaveAfterAnalyse: promptSaveAfterAnalyse,
    promptSaveAfterAnalyseIfNeeded: promptSaveAfterAnalyseIfNeeded,
    getLoadedProfileId: function () {
      return getActiveTradeProfileId(getEpic());
    },
    getActiveTradeProfileId: function (epic) {
      return getActiveTradeProfileId(epic || getEpic());
    },
    updateLoadedProfileResult: function (epic, report) {
      var activeId = getActiveTradeProfileId(epic);
      if (activeId) return updateProfileResult(epic, activeId, report);
      return Promise.resolve();
    },
    clearLoadedProfile: clearLoadedProfile
  };
}

/** Build a minimal report object from saved lastResult summary (legacy profiles). */
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

/** Saved report snapshot from a profile (full UI report or legacy summary). */
export function savedReportFromProfile(profile) {
  if (!profile) return null;
  if (profile.savedReport) return profile.savedReport;
  if (!profile.lastResult) return null;
  var partial = reportFromProfileLastResult(profile.lastResult);
  if (!partial) return null;
  return {
    runAt: profile.lastResult.runAt || profile.savedAt || Date.now(),
    report: partial,
    usedTpSl: false,
    usedDynamicSl: false
  };
}
