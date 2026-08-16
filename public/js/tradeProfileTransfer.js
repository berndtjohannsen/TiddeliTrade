/**
 * Trade profile export/import — personal sync (no recordings).
 * Uses a versioned envelope; unknown profile fields are preserved for forward compatibility.
 */

export const TRADE_PROFILE_FORMAT = 'tiddeli-trade-profile';
export const TRADE_PROFILE_FORMAT_VERSION = 1;
export const TRADE_PROFILE_SHARE_LEVEL_PERSONAL = 'personal';
export const TRADE_PROFILE_FILE_EXT = '.tiddeli-profile.json';

/** Profile keys regenerated on import — never taken from the file. */
const RUNTIME_PROFILE_KEYS = ['id'];

/**
 * Per-format-version migrations on the envelope (not the inner profile shape).
 * Add entries when breaking envelope fields change; profile fields pass through untouched.
 */
const ENVELOPE_MIGRATIONS = {
  1: function (envelope) {
    return envelope;
  }
};

export function newImportProfileId() {
  return 'bp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** JSON clone — keeps extra keys future app versions may add. */
export function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function stripRuntimeProfileFields(profile) {
  if (!profile || typeof profile !== 'object') return {};
  var clone = deepCloneJson(profile);
  for (var i = 0; i < RUNTIME_PROFILE_KEYS.length; i++) {
    delete clone[RUNTIME_PROFILE_KEYS[i]];
  }
  return clone;
}

function sanitizeFilenamePart(name) {
  return String(name || 'profile')
    .trim()
    .replace(/[^\w\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'profile';
}

export function profileExportFilename(profileName) {
  return sanitizeFilenamePart(profileName) + TRADE_PROFILE_FILE_EXT;
}

/**
 * @param {object} profile - Saved BacktestProfile (full personal export).
 * @param {object} meta
 * @param {string} meta.epic
 * @param {string} [meta.instrumentName]
 * @param {string} [meta.appVersion]
 * @param {string} [meta.timezone]
 */
export function buildPersonalExportEnvelope(profile, meta) {
  meta = meta || {};
  var payload = stripRuntimeProfileFields(profile);
  return {
    format: TRADE_PROFILE_FORMAT,
    formatVersion: TRADE_PROFILE_FORMAT_VERSION,
    shareLevel: TRADE_PROFILE_SHARE_LEVEL_PERSONAL,
    exportedAt: new Date().toISOString(),
    appVersion: meta.appVersion || null,
    source: {
      epic: meta.epic || null,
      instrumentName: meta.instrumentName || null,
      timezone: meta.timezone || null,
      exportedProfileId: profile && profile.id ? profile.id : null
    },
    profile: payload
  };
}

function migrateEnvelope(envelope) {
  var version = typeof envelope.formatVersion === 'number' ? envelope.formatVersion : 0;
  if (version < 1) {
    envelope.formatVersion = 1;
    version = 1;
  }
  while (version < TRADE_PROFILE_FORMAT_VERSION) {
    var next = version + 1;
    if (ENVELOPE_MIGRATIONS[next]) {
      envelope = ENVELOPE_MIGRATIONS[next](envelope);
      envelope.formatVersion = next;
    } else {
      break;
    }
    version = next;
  }
  return envelope;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Minimum shape: profile object with a strategy key (object). Extra keys allowed.
 */
export function validateProfileShape(profile) {
  if (!isPlainObject(profile)) {
    return { ok: false, error: 'Profile must be a JSON object.' };
  }
  if (!isPlainObject(profile.strategy)) {
    return { ok: false, error: 'Profile is missing a strategy object.' };
  }
  return { ok: true };
}

function normalizeRawImportData(data) {
  if (!isPlainObject(data)) {
    return { ok: false, error: 'File must contain a JSON object.' };
  }

  if (data.format === TRADE_PROFILE_FORMAT || data.profile != null) {
    var envelope = migrateEnvelope(deepCloneJson(data));
    if (!isPlainObject(envelope.profile)) {
      return { ok: false, error: 'Envelope is missing a profile object.' };
    }
    var check = validateProfileShape(envelope.profile);
    if (!check.ok) return check;
    return { ok: true, envelope: envelope, profile: envelope.profile };
  }

  /* Bare profile JSON (no envelope) — still accepted for manual/legacy use. */
  var bareCheck = validateProfileShape(data);
  if (!bareCheck.ok) return bareCheck;
  var bareEnvelope = {
    format: TRADE_PROFILE_FORMAT,
    formatVersion: TRADE_PROFILE_FORMAT_VERSION,
    shareLevel: TRADE_PROFILE_SHARE_LEVEL_PERSONAL,
    exportedAt: null,
    appVersion: null,
    source: { epic: null, instrumentName: null, timezone: null, exportedProfileId: data.id || null },
    profile: deepCloneJson(data)
  };
  return { ok: true, envelope: bareEnvelope, profile: bareEnvelope.profile };
}

/**
 * Parse file text into envelope + profile. Returns warnings for non-fatal issues.
 */
export function parseProfileImportText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'File is empty.' };
  }
  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'Invalid JSON: ' + (e && e.message ? e.message : 'parse error') };
  }

  var normalized = normalizeRawImportData(data);
  if (!normalized.ok) return normalized;

  var warnings = [];
  var envelope = normalized.envelope;
  if (typeof envelope.formatVersion === 'number' && envelope.formatVersion > TRADE_PROFILE_FORMAT_VERSION) {
    warnings.push(
      'File format v' +
        envelope.formatVersion +
        ' is newer than this app (v' +
        TRADE_PROFILE_FORMAT_VERSION +
        '). Importing anyway — unknown fields are kept.'
    );
  }
  if (envelope.shareLevel && envelope.shareLevel !== TRADE_PROFILE_SHARE_LEVEL_PERSONAL) {
    warnings.push('Share level "' + envelope.shareLevel + '" — imported as-is.');
  }
  if (!normalized.profile.name || !String(normalized.profile.name).trim()) {
    warnings.push('Profile has no name; a default name will be used on import.');
  }

  return {
    ok: true,
    envelope: envelope,
    profile: normalized.profile,
    warnings: warnings
  };
}

export function defaultImportedProfileName(profile, sourceInstrumentName) {
  var base = profile && profile.name ? String(profile.name).trim() : '';
  if (!base && sourceInstrumentName) base = sourceInstrumentName + ' profile';
  if (!base) base = 'Imported profile';
  return base;
}

/**
 * Build a profile ready to persist locally (new id, savedAt, optional rename).
 */
export function prepareImportedProfile(profile, options) {
  options = options || {};
  var clone = deepCloneJson(profile);
  for (var i = 0; i < RUNTIME_PROFILE_KEYS.length; i++) {
    delete clone[RUNTIME_PROFILE_KEYS[i]];
  }
  clone.id = newImportProfileId();
  clone.savedAt = Date.now();
  var name = options.name != null ? String(options.name).trim() : '';
  if (name) clone.name = name;
  else if (!clone.name || !String(clone.name).trim()) {
    clone.name = defaultImportedProfileName(profile, options.sourceInstrumentName);
  }
  return clone;
}

export function describeExportContents(profile) {
  var parts = ['Rules & probes', 'Engine controls', 'Analyse options'];
  if (profile && profile.savedReport) parts.push('Saved backtest report');
  else if (profile && profile.lastResult) parts.push('Backtest summary');
  return parts.join(' · ');
}

export function describeImportPreview(envelope, profile, targetEpic) {
  var lines = [];
  var source = envelope && envelope.source ? envelope.source : {};
  if (source.instrumentName || source.epic) {
    lines.push(
      'From: ' +
        (source.instrumentName || source.epic) +
        (source.epic && source.instrumentName ? ' (' + source.epic + ')' : '')
    );
  }
  if (targetEpic && source.epic && source.epic !== targetEpic) {
    lines.push('Import onto: ' + targetEpic + ' (source epic differs)');
  } else if (targetEpic) {
    lines.push('Import onto: ' + targetEpic);
  }
  if (envelope && envelope.appVersion) lines.push('Exported with app v' + envelope.appVersion);
  if (envelope && envelope.exportedAt) {
    try {
      lines.push('Exported: ' + new Date(envelope.exportedAt).toLocaleString());
    } catch (_e) {
      lines.push('Exported: ' + envelope.exportedAt);
    }
  }
  lines.push('Includes: ' + describeExportContents(profile));
  lines.push('Recordings: not included — re-run backtest after import if needed.');
  return lines;
}

export function downloadProfileExport(envelope, filename) {
  var blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename || profileExportFilename(envelope.profile && envelope.profile.name);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function readProfileImportFile(file) {
  return new Promise(function (resolve, reject) {
    if (!file) {
      reject(new Error('No file selected'));
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = function () {
      reject(new Error('Could not read file'));
    };
    reader.readAsText(file);
  });
}
