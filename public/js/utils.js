/** Play a short success chime (e.g. deal placed, closed with profit). */
export function playSuccessSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    var play = function (freq, start, duration) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + duration);
      osc.start(start);
      osc.stop(start + duration);
    };
    play(523.25, 0, 0.08);
    play(659.25, 0.1, 0.12);
  } catch (_) {}
}

export function formatMoney(val, currency) {
  if (val == null || isNaN(val)) return '—';
  var s = val >= 1000 || val <= -1000 ? val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : val.toFixed(2);
  return (currency && currency !== '—') ? s + ' ' + currency : s;
}

/** Format ISO date string as local time with timezone, e.g. "14:32:15 (CET)" or "27 Jan 14:32:15 (CET)" if not today. */
export function formatTimeWithTz(isoString) {
  if (!isoString) return '—';
  var d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  var now = new Date();
  var isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  var timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  var tzPart = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d).find(function (p) { return p.type === 'timeZoneName'; });
  var tzSuffix = tzPart ? ' (' + tzPart.value + ')' : '';
  return isToday ? timeStr + tzSuffix : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + timeStr + tzSuffix;
}

/** Local calendar date + time + short TZ for debug log lines, e.g. "2026-04-21, 14:32:15 (CET)". */
export function formatLogTimestamp(isoString) {
  if (!isoString) return '—';
  var d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  var dateStr = d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  var timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  var tzPart = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d).find(function (p) {
    return p.type === 'timeZoneName';
  });
  var tzSuffix = tzPart ? ' (' + tzPart.value + ')' : '';
  return dateStr + ', ' + timeStr + tzSuffix;
}

/** Hide the initial startup overlay once Home is ready. */
export function hideAppBootOverlay() {
  var el = document.getElementById('appBootOverlay');
  if (!el || el.classList.contains('app-boot-overlay--hidden')) return;
  el.classList.add('app-boot-overlay--hidden');
  el.setAttribute('aria-busy', 'false');
}

/** In-app confirm dialog (replaces browser confirm). Returns a promise resolving to true/false. */
export function initAppConfirmModal() {
  var modal = document.getElementById('appConfirmModal');
  var titleEl = document.getElementById('appConfirmTitle');
  var messageEl = document.getElementById('appConfirmMessage');
  var okBtn = document.getElementById('appConfirmOk');
  var cancelBtn = document.getElementById('appConfirmCancel');
  var pending = null;

  function hide() {
    if (modal) {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    }
    pending = null;
  }

  function showConfirm(options) {
    options = options || {};
    if (!modal || !titleEl || !messageEl || !okBtn || !cancelBtn) {
      return Promise.resolve(false);
    }
    titleEl.textContent = options.title || 'Confirm';
    messageEl.textContent = options.message || '';
    okBtn.textContent = options.okLabel || 'OK';
    cancelBtn.textContent = options.cancelLabel || 'Cancel';
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    return new Promise(function (resolve) {
      pending = resolve;
    });
  }

  function finish(result) {
    if (pending) pending(result);
    hide();
  }

  if (okBtn) okBtn.addEventListener('click', function () { finish(true); });
  if (cancelBtn) cancelBtn.addEventListener('click', function () { finish(false); });
  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) finish(false);
    });
  }

  return { showConfirm: showConfirm };
}
