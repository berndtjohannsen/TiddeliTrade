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
import {
  buildPersonalExportEnvelope,
  defaultImportedProfileName,
  describeImportPreview,
  downloadProfileExport,
  parseProfileImportText,
  prepareImportedProfile,
  profileExportFilename,
  readProfileImportFile
} from './tradeProfileTransfer.js';

function newProfileId() {
  return 'bp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function formatPlForProfileName(report) {
  if (!report) return '';
  if (report.totalGainLossPounds != null) {
    var v = report.totalGainLossPounds;
    return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);
  }
  if (report.totalGainLoss != null) {
    var p = report.totalGainLoss;
    return (p >= 0 ? '+' : '') + p.toFixed(2) + ' pts';
  }
  return '';
}

/** Default name for new profiles, e.g. d:95 w/l:555/119 82.3% +$697.60 */
function defaultProfileName(strategy, analyseOptions, report) {
  if (!report) {
    var sets = (analyseOptions && analyseOptions.backtestRuleSets) || ['BUY', 'SELL'];
    return sets.join('+');
  }
  var parts = [];
  var days =
    report.daysAnalysed != null && report.daysAnalysed > 0
      ? report.daysAnalysed
      : analyseOptions && analyseOptions.selectedDays
        ? analyseOptions.selectedDays.length
        : 0;
  if (days > 0) parts.push('d:' + days);
  if (report.winningTrades != null && report.losingTrades != null) {
    parts.push('w/l:' + report.winningTrades + '/' + report.losingTrades);
  }
  if (report.winRate != null) parts.push(report.winRate.toFixed(1) + '%');
  var pl = formatPlForProfileName(report);
  if (pl) parts.push(pl);
  return parts.length > 0 ? parts.join(' ') : 'Profile';
}

function formatWinRate(summary) {
  if (!summary || summary.winRate == null || isNaN(summary.winRate)) return '—';
  return summary.winRate.toFixed(1) + '%';
}

/** When the backtest was run (saved report, legacy lastResult, or profile save time). */
function profileRunAt(profile) {
  if (!profile) return null;
  if (profile.savedReport && profile.savedReport.runAt) return profile.savedReport.runAt;
  if (profile.lastResult && profile.lastResult.runAt) return profile.lastResult.runAt;
  return profile.savedAt || null;
}

/** One-line stats: run date, P/L, days, trades, win rate. */
function formatProfileInlineStats(summary, runAt) {
  if (!summary) return '';
  var parts = [];
  var runDate = formatProfileDate(runAt);
  if (runDate && runDate !== '—') parts.push(runDate);
  var pl = formatPlSummary(summary);
  if (pl && pl !== '—') parts.push('P/L ' + pl);
  if (summary.daysAnalysed != null) parts.push(summary.daysAnalysed + ' days');
  if (summary.tradeCount != null) parts.push(summary.tradeCount + ' trades');
  var winRate = formatWinRate(summary);
  if (winRate !== '—') parts.push(winRate + ' win');
  return parts.join(' · ');
}

function formatReportSummary(report, runAt) {
  if (!report) return '';
  return formatProfileInlineStats(report, runAt != null ? runAt : Date.now());
}

/** HTML second line for profile list rows (P/L coloured). */
function formatProfileInlineStatsHtml(summary, runAt, plClass) {
  if (!summary) return '';
  var bits = [];
  var sep = '<span class="text-slate-500"> · </span>';
  var runDate = formatProfileDate(runAt);
  if (runDate && runDate !== '—') {
    bits.push('<span class="text-slate-500">' + escapeHtml(runDate) + '</span>');
  }
  var pl = formatPlSummary(summary);
  if (pl && pl !== '—') {
    bits.push('<span class="' + plClass + '">P/L ' + escapeHtml(pl) + '</span>');
  }
  if (summary.daysAnalysed != null) {
    bits.push('<span class="text-slate-500">' + summary.daysAnalysed + ' days</span>');
  }
  if (summary.tradeCount != null) {
    bits.push('<span class="text-slate-500">' + summary.tradeCount + ' trades</span>');
  }
  var winRate = formatWinRate(summary);
  if (winRate !== '—') {
    bits.push('<span class="text-slate-500">' + escapeHtml(winRate) + ' win</span>');
  }
  return bits.join(sep);
}

/** Multi-line summary for the post-analyse result modal. */
function formatReportDetailForModal(report) {
  if (!report) return '—';
  var lines = [];
  var pl = report.totalGainLossPounds != null
    ? (report.totalGainLossPounds >= 0 ? '+' : '') + report.totalGainLossPounds.toFixed(2) + ' $'
    : report.totalGainLoss != null
      ? (report.totalGainLoss >= 0 ? '+' : '') + report.totalGainLoss.toFixed(2) + ' pts'
      : '—';
  lines.push('Total P/L: ' + pl);
  if (report.tradeCount != null) lines.push('Trades: ' + report.tradeCount);
  if (report.winRate != null) lines.push('Win rate: ' + report.winRate.toFixed(1) + '%');
  if (report.daysAnalysed != null && report.daysAnalysed > 0) lines.push('Days analysed: ' + report.daysAnalysed);
  if (report.sampleCount != null) lines.push('Samples: ' + report.sampleCount);
  return lines.join('\n');
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

var PROFILE_APPLY_BLOCKED_MSG = 'Stop rules before loading a profile.';

export function initBacktestProfiles(opts) {
  var applyTradeProfile = opts && opts.applyTradeProfile ? opts.applyTradeProfile : null;
  var onLoadProfile = opts && opts.onLoadProfile ? opts.onLoadProfile : null;
  var onRestoreSavedReport = opts && opts.onRestoreSavedReport ? opts.onRestoreSavedReport : null;
  var onProfileApplyBlocked = opts && opts.onProfileApplyBlocked ? opts.onProfileApplyBlocked : null;
  var isRulesEngineRunning = opts && opts.isRulesEngineRunning ? opts.isRulesEngineRunning : function () {
    return false;
  };
  var getEpic = opts && opts.getEpic ? opts.getEpic : function () {
    return '';
  };

  var listEl = document.getElementById('backtestProfilesList');
  var tradeSelectEl = document.getElementById('tradeProfileSelect');
  var tradeExportBtn = document.getElementById('tradeProfileExportBtn');
  var saveBtn = document.getElementById('backtestProfileSaveBtn');
  var exportToolbarBtn = document.getElementById('backtestProfileExportBtn');
  var importBtn = document.getElementById('backtestProfileImportBtn');
  var importFileInput = document.getElementById('backtestProfileImportFile');
  var importModal = document.getElementById('backtestProfileImportModal');
  var importPreviewEl = document.getElementById('backtestProfileImportPreview');
  var importWarningsEl = document.getElementById('backtestProfileImportWarnings');
  var importNameInput = document.getElementById('backtestProfileImportName');
  var importActivateCheck = document.getElementById('backtestProfileImportActivate');
  var importErrorEl = document.getElementById('backtestProfileImportError');
  var importCancelBtn = document.getElementById('backtestProfileImportCancel');
  var importOkBtn = document.getElementById('backtestProfileImportOk');
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
  var pendingImport = null;
  var cachedAppVersion = null;

  /** True when live rules apply must not be replaced (engine running). */
  function rulesBlockProfileApply() {
    return !!isRulesEngineRunning();
  }

  function notifyProfileApplyBlocked() {
    if (onProfileApplyBlocked) onProfileApplyBlocked(PROFILE_APPLY_BLOCKED_MSG);
    else if (activeLabel) {
      activeLabel.textContent = PROFILE_APPLY_BLOCKED_MSG;
      activeLabel.classList.remove('hidden');
    }
  }

  /** Disable profile load controls while rules engine is running. */
  function syncProfileApplyLock() {
    var locked = rulesBlockProfileApply();
    var epic = getEpic();
    if (tradeSelectEl) {
      tradeSelectEl.title = locked
        ? PROFILE_APPLY_BLOCKED_MSG
        : 'Load a saved strategy profile onto Trade (and Research backtests)';
    }
    if (importActivateCheck) {
      importActivateCheck.disabled = locked;
      importActivateCheck.title = locked ? PROFILE_APPLY_BLOCKED_MSG : '';
      if (locked) importActivateCheck.checked = false;
    }
    if (epic) renderList(epic);
  }

  function resolveAppVersion() {
    if (cachedAppVersion) return Promise.resolve(cachedAppVersion);
    return fetch('/api/version')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        cachedAppVersion = (data && data.version) || '0.0.0';
        return cachedAppVersion;
      })
      .catch(function () {
        cachedAppVersion = '0.0.0';
        return cachedAppVersion;
      });
  }

  function getInstrumentNameForEpic(epic) {
    var epicSelect = document.getElementById('epicSelect');
    if (epicSelect && epicSelect.options) {
      for (var i = 0; i < epicSelect.options.length; i++) {
        var opt = epicSelect.options[i];
        if (opt.value === epic) return opt.textContent || epic;
      }
    }
    return epic || '';
  }

  function buildExportMeta(epic) {
    var tz;
    try {
      tz = typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined;
    } catch (_e) {
      tz = undefined;
    }
    return {
      epic: epic,
      instrumentName: getInstrumentNameForEpic(epic),
      timezone: tz
    };
  }

  function exportProfileToFile(profile, epic) {
    if (!profile || !epic) return Promise.reject(new Error('Nothing to export'));
    return resolveAppVersion().then(function (appVersion) {
      var meta = buildExportMeta(epic);
      meta.appVersion = appVersion;
      var envelope = buildPersonalExportEnvelope(profile, meta);
      downloadProfileExport(envelope, profileExportFilename(profile.name));
    });
  }

  function syncTradeExportButton(epic) {
    if (!tradeExportBtn) return;
    var activeId = tradeSelectEl && tradeSelectEl.value ? tradeSelectEl.value : getActiveTradeProfileId(epic);
    var hasProfile = !!(epic && activeId && findProfile(epic, activeId));
    tradeExportBtn.disabled = !hasProfile;
    tradeExportBtn.title = hasProfile
      ? 'Download the selected profile as a file (no recordings)'
      : 'Select a saved profile from the dropdown first';
  }

  function resolveProfileForExport(epic) {
    if (!epic) return null;
    var activeId = getActiveTradeProfileId(epic);
    if (activeId) {
      var active = findProfile(epic, activeId);
      if (active) return active;
    }
    if (tradeSelectEl && tradeSelectEl.value) {
      return findProfile(epic, tradeSelectEl.value);
    }
    return null;
  }

  function exportResolvedProfile(epic) {
    var profile = resolveProfileForExport(epic);
    if (!profile) {
      return Promise.reject(
        new Error('No profile selected — activate one in the list or pick from Trade profile dropdown')
      );
    }
    return exportProfileToFile(profile, epic);
  }

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
    tradeSelectEl.title = rulesBlockProfileApply()
      ? PROFILE_APPLY_BLOCKED_MSG
      : 'Load a saved strategy profile onto Trade (and Research backtests)';
    syncTradeExportButton(epic);
  }

  function activateTradeProfile(profile, epic, options) {
    if (!profile || !epic) return false;
    var skipApply = options && options.skipApply;
    if (!skipApply && rulesBlockProfileApply()) {
      notifyProfileApplyBlocked();
      return false;
    }
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
    return true;
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
    while (names[trimmed + ' (' + n + ')']) n++;
    return trimmed + ' (' + n + ')';
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
    var profileApplyLocked = rulesBlockProfileApply();
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
        var runAt = profileRunAt(p);
        var inlineStats = formatProfileInlineStats(summary, runAt);
        var inlineStatsHtml = formatProfileInlineStatsHtml(
          summary,
          runAt,
          summary && (summary.totalGainLossPounds != null ? summary.totalGainLossPounds : summary.totalGainLoss) < 0
            ? 'text-red-400'
            : 'text-emerald-400'
        );
        var runDate = formatProfileDate(runAt);
        var loadTitle = profileApplyLocked
          ? PROFILE_APPLY_BLOCKED_MSG
          : 'Activate on Trade (same rules for backtest)' +
            (runDate && runDate !== '—' ? ' — run ' + runDate : '') +
            (inlineStats ? ' — ' + inlineStats : '');
        var loadBtnClass =
          'flex-1 min-w-0 text-left' +
          (profileApplyLocked && !active ? ' opacity-50 cursor-not-allowed' : '');
        return (
          '<li class="group flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1 py-1 ' +
          (active ? 'bg-violet-900/40 ring-1 ring-violet-600/50' : 'hover:bg-slate-800/60') +
          '">' +
          '<button type="button" class="' +
          loadBtnClass +
          '" data-profile-load="' +
          p.id +
          '"' +
          (profileApplyLocked && !active ? ' disabled' : '') +
          ' title="' +
          escapeHtml(loadTitle) +
          '">' +
          '<span class="text-slate-200 font-medium truncate block">' +
          escapeHtml(p.name) +
          '</span>' +
          (inlineStatsHtml
            ? '<span class="font-mono text-[10px] block truncate" title="' +
              escapeHtml(inlineStats) +
              '">' +
              inlineStatsHtml +
              '</span>'
            : '<span class="font-mono text-[10px] text-slate-500 block">No backtest result saved</span>') +
          '</button>' +
          '<button type="button" class="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200" data-profile-export="' +
          p.id +
          '" title="Export this profile">↓</button>' +
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

  function setImportError(msg) {
    if (!importErrorEl) return;
    if (msg) {
      importErrorEl.textContent = msg;
      importErrorEl.classList.remove('hidden');
    } else {
      importErrorEl.textContent = '';
      importErrorEl.classList.add('hidden');
    }
  }

  function hideImportModal() {
    pendingImport = null;
    setImportError('');
    if (importModal) {
      importModal.classList.add('hidden');
      importModal.setAttribute('aria-hidden', 'true');
    }
  }

  function showImportModal(parsed, epic) {
    if (!parsed || !parsed.ok || !parsed.profile) return;
    pendingImport = {
      epic: epic,
      envelope: parsed.envelope,
      profile: parsed.profile,
      warnings: parsed.warnings || []
    };
    var sourceName =
      parsed.envelope && parsed.envelope.source && parsed.envelope.source.instrumentName
        ? parsed.envelope.source.instrumentName
        : null;
    var suggested = suggestUniqueProfileName(
      defaultImportedProfileName(parsed.profile, sourceName),
      epic
    );
    if (importPreviewEl) {
      var lines = describeImportPreview(parsed.envelope, parsed.profile, epic);
      importPreviewEl.innerHTML = lines
        .map(function (line) {
          return '<li>' + escapeHtml(line) + '</li>';
        })
        .join('');
    }
    if (importWarningsEl) {
      if (pendingImport.warnings.length > 0) {
        importWarningsEl.innerHTML = pendingImport.warnings
          .map(function (w) {
            return '<li>' + escapeHtml(w) + '</li>';
          })
          .join('');
        importWarningsEl.classList.remove('hidden');
      } else {
        importWarningsEl.innerHTML = '';
        importWarningsEl.classList.add('hidden');
      }
    }
    if (importNameInput) {
      importNameInput.value = suggested;
      importNameInput.disabled = false;
    }
    if (importActivateCheck) importActivateCheck.checked = true;
    setImportError('');
    if (importModal) {
      importModal.classList.remove('hidden');
      importModal.setAttribute('aria-hidden', 'false');
    }
    if (importNameInput) {
      setTimeout(function () {
        importNameInput.focus();
        importNameInput.select();
      }, 0);
    }
  }

  function importProfileFromPending() {
    if (!pendingImport) return Promise.reject(new Error('Nothing to import'));
    var epic = pendingImport.epic || getEpic();
    if (!epic) return Promise.reject(new Error('Select an instrument first'));
    var name = importNameInput ? importNameInput.value : '';
    var trimmed = (name || '').trim();
    if (!trimmed) return Promise.reject(new Error('Enter a profile name'));
    if (profileNameTaken(epic, trimmed)) {
      return Promise.reject(new Error('Another profile already uses that name'));
    }
    var sourceName =
      pendingImport.envelope && pendingImport.envelope.source
        ? pendingImport.envelope.source.instrumentName
        : null;
    var profile = prepareImportedProfile(pendingImport.profile, {
      name: trimmed,
      sourceInstrumentName: sourceName
    });
    var profiles = getProfilesForEpic(epic).slice();
    profiles.push(profile);
    var activate = !!(importActivateCheck && importActivateCheck.checked);
    if (activate && rulesBlockProfileApply()) {
      return Promise.reject(new Error(PROFILE_APPLY_BLOCKED_MSG));
    }
    return persistProfiles(epic, profiles).then(function () {
      if (activate) {
        activateTradeProfile(profile, epic, { skipApply: false, skipReport: false });
      } else {
        renderTradeSelect(epic);
        renderList(epic);
      }
      return profile;
    });
  }

  function handleImportFileSelected(file) {
    var epic = getEpic();
    if (!epic) {
      if (activeLabel) {
        activeLabel.textContent = 'Select an instrument first';
        activeLabel.classList.remove('hidden');
      }
      return;
    }
    readProfileImportFile(file)
      .then(function (text) {
        return parseProfileImportText(text);
      })
      .then(function (parsed) {
        if (!parsed.ok) {
          if (activeLabel) {
            activeLabel.textContent = parsed.error || 'Invalid profile file';
            activeLabel.classList.remove('hidden');
          }
          return;
        }
        showImportModal(parsed, epic);
      })
      .catch(function (err) {
        if (activeLabel) {
          activeLabel.textContent = err && err.message ? err.message : 'Import failed';
          activeLabel.classList.remove('hidden');
        }
      });
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

  /**
   * Outcome after analyse for result modal + optional save prompt.
   * @returns {{ kind: 'none'|'unchanged'|'save_new'|'save_copy', epic?: string, normalized?: object, profileName?: string, suggestedName?: string, detail?: string, comment?: string }}
   */
  function getAnalyseProfileOutcome(payload, epicOverride) {
    var normalized = normalizeSavePayload(payload);
    if (!normalized || !normalized.report) return { kind: 'none' };
    var report = normalized.report;
    var epic = epicOverride || getEpic();
    if (!epic) return { kind: 'none' };
    var detail = formatReportDetailForModal(report);
    var activeId = getActiveTradeProfileId(epic);
    if (!activeId) {
      return {
        kind: 'save_new',
        epic: epic,
        normalized: normalized,
        detail: detail,
        comment: 'No active profile on Trade. You can save this run as a profile when you close this dialog.'
      };
    }
    var profile = findProfile(epic, activeId);
    if (!profile) {
      return {
        kind: 'save_new',
        epic: epic,
        normalized: normalized,
        detail: detail,
        comment: 'No active profile on Trade. You can save this run as a profile when you close this dialog.'
      };
    }
    if (!profileResultDiffers(profile, report)) {
      return {
        kind: 'unchanged',
        epic: epic,
        normalized: normalized,
        profileName: profile.name,
        detail: detail,
        comment:
          'Results are the same as saved profile "' +
          profile.name +
          '" (trade count, days, and P/L match). The profile report was refreshed.'
      };
    }
    return {
      kind: 'save_copy',
      epic: epic,
      normalized: normalized,
      profileName: profile.name,
      suggestedName: suggestUniqueProfileName(profile.name + ' copy', epic),
      detail: detail,
      comment:
        'Results differ from profile "' +
        profile.name +
        '". You can save this run as a new profile copy when you close this dialog.'
    };
  }

  function applyAnalyseProfileOutcome(outcome) {
    if (!outcome || outcome.kind === 'none') return Promise.resolve();
    if (outcome.kind === 'unchanged' && outcome.epic && outcome.normalized) {
      var activeId = getActiveTradeProfileId(outcome.epic);
      if (activeId) return updateProfileResult(outcome.epic, activeId, outcome.normalized);
    }
    return Promise.resolve();
  }

  function followUpSaveAfterAnalyseOutcome(outcome) {
    if (!outcome || outcome.kind === 'none' || outcome.kind === 'unchanged') return;
    if (outcome.kind === 'save_new') {
      promptSaveAfterAnalyse(outcome.normalized, outcome.epic);
      return;
    }
    if (outcome.kind === 'save_copy') {
      showSaveModal({
        epic: outcome.epic,
        payload: outcome.normalized,
        suggestedName: outcome.suggestedName,
        summary: formatReportSummary(outcome.normalized.report),
        intro:
          'Results differ from profile "' +
          outcome.profileName +
          '". Save as a new profile? The original keeps its saved result.'
      });
    }
  }

  function promptSaveAfterAnalyseIfNeeded(payload, epicOverride) {
    var outcome = getAnalyseProfileOutcome(payload, epicOverride);
    applyAnalyseProfileOutcome(outcome);
    return outcome;
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

  if (exportToolbarBtn) {
    exportToolbarBtn.addEventListener('click', function () {
      var epic = getEpic();
      if (!epic) {
        if (activeLabel) {
          activeLabel.textContent = 'Select an instrument first';
          activeLabel.classList.remove('hidden');
        }
        return;
      }
      exportResolvedProfile(epic).catch(function (err) {
        if (activeLabel) {
          activeLabel.textContent = err && err.message ? err.message : 'Export failed';
          activeLabel.classList.remove('hidden');
        }
      });
    });
  }

  if (importBtn && importFileInput) {
    importBtn.addEventListener('click', function () {
      if (!getEpic()) {
        if (activeLabel) {
          activeLabel.textContent = 'Select an instrument first';
          activeLabel.classList.remove('hidden');
        }
        return;
      }
      importFileInput.value = '';
      importFileInput.click();
    });
    importFileInput.addEventListener('change', function () {
      var file = importFileInput.files && importFileInput.files[0];
      if (file) handleImportFileSelected(file);
    });
  }

  if (importCancelBtn) importCancelBtn.addEventListener('click', hideImportModal);
  if (importOkBtn) {
    importOkBtn.addEventListener('click', function () {
      if (importOkBtn.disabled) return;
      importOkBtn.disabled = true;
      importProfileFromPending()
        .then(function () {
          hideImportModal();
        })
        .catch(function (err) {
          setImportError(err && err.message ? err.message : 'Could not import profile');
        })
        .finally(function () {
          importOkBtn.disabled = false;
        });
    });
  }
  if (importNameInput) {
    importNameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (importOkBtn) importOkBtn.click();
      }
    });
  }
  if (importModal) {
    importModal.addEventListener('click', function (e) {
      if (e.target === importModal) hideImportModal();
    });
  }

  if (tradeExportBtn) {
    tradeExportBtn.addEventListener('click', function () {
      var epic = getEpic();
      if (!epic) return;
      exportResolvedProfile(epic).catch(function (err) {
        if (activeLabel) {
          activeLabel.textContent = err && err.message ? err.message : 'Export failed';
          activeLabel.classList.remove('hidden');
        }
      });
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
    if (importModal && !importModal.classList.contains('hidden')) hideImportModal();
    else if (saveModal && !saveModal.classList.contains('hidden')) hideSaveModal();
    else if (renameModal && !renameModal.classList.contains('hidden')) hideRenameModal();
    else if (deleteModal && !deleteModal.classList.contains('hidden')) hideDeleteModal();
  });

  if (tradeSelectEl) {
    tradeSelectEl.addEventListener('change', function () {
      var epic = getEpic();
      if (!epic) return;
      syncTradeExportButton(epic);
      var id = tradeSelectEl.value || '';
      if (!id) {
        clearTradeProfileSelection(epic);
        return;
      }
      var profile = findProfile(epic, id);
      if (profile && !activateTradeProfile(profile, epic)) {
        var activeId = getActiveTradeProfileId(epic);
        tradeSelectEl.value = activeId && findProfile(epic, activeId) ? activeId : '';
      }
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
        if (rulesBlockProfileApply()) {
          notifyProfileApplyBlocked();
          return;
        }
        var p = findProfile(epic, loadId);
        if (p) activateTradeProfile(p, epic);
        return;
      }
      var exportId = t.getAttribute('data-profile-export');
      if (!exportId && t.closest) {
        var exportBtn = t.closest('[data-profile-export]');
        if (exportBtn) exportId = exportBtn.getAttribute('data-profile-export');
      }
      if (exportId) {
        var exportProfile = findProfile(epic, exportId);
        if (exportProfile) {
          exportProfileToFile(exportProfile, epic).catch(function (err) {
            if (activeLabel) {
              activeLabel.textContent = err && err.message ? err.message : 'Export failed';
              activeLabel.classList.remove('hidden');
            }
          });
        }
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

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('tiddeli:rules-engine-running', syncProfileApplyLock);
  }

  fetchProfiles().then(function () {
    syncProfileApplyLock();
  });

  return {
    syncProfileApplyLock: syncProfileApplyLock,
    refreshForEpic: function (epic) {
      var e = epic || getEpic();
      renderTradeSelect(e);
      renderList(e);
      setActiveLabelForEpic(e);
    },
    reload: fetchProfiles,
    promptSaveAfterAnalyse: promptSaveAfterAnalyse,
    promptSaveAfterAnalyseIfNeeded: promptSaveAfterAnalyseIfNeeded,
    getAnalyseProfileOutcome: getAnalyseProfileOutcome,
    applyAnalyseProfileOutcome: applyAnalyseProfileOutcome,
    followUpSaveAfterAnalyseOutcome: followUpSaveAfterAnalyseOutcome,
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
