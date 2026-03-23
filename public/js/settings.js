/**
 * Settings modal.
 */
export function initSettings(log, onConfigSaved) {
  var settingsBtn = document.getElementById('settingsBtn');
  var settingsModal = document.getElementById('settingsModal');
  var settingsClose = document.getElementById('settingsClose');
  var settingsCancel = document.getElementById('settingsCancel');
  var settingsForm = document.getElementById('settingsForm');
  var settingsStatus = document.getElementById('settingsStatus');
  var profileSelect = document.getElementById('igProfileSelect');

  function loadConfigIntoForm() {
    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var usernameEl = document.getElementById('igUsername');
        var apiKeyEl = document.getElementById('igApiKey');
        var passwordEl = document.getElementById('igPassword');
        var baseUrlEl = document.getElementById('igBaseUrl');
        var activeProfile = data.activeProfile || 'demo';
        var profiles = data.igProfilesSafe || { demo: {}, live: {} };
        if (profileSelect) profileSelect.value = activeProfile;
        var p = profiles[activeProfile] || {};
        if (usernameEl) usernameEl.value = p.igUsername || '';
        if (baseUrlEl) {
          baseUrlEl.value = p.igBaseUrl || '';
          baseUrlEl.placeholder = activeProfile === 'live' ? 'https://api.ig.com' : 'https://demo-api.ig.com';
        }
        if (apiKeyEl) { apiKeyEl.value = ''; apiKeyEl.placeholder = p.credentialsConfigured ? '••••••' : 'IG API key'; }
        if (passwordEl) { passwordEl.value = ''; passwordEl.placeholder = p.credentialsConfigured ? '••••••' : 'IG password'; }
      })
      .catch(function () {});
  }

  function onProfileChange() {
    var activeProfile = profileSelect && profileSelect.value ? profileSelect.value : 'demo';
    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var usernameEl = document.getElementById('igUsername');
        var apiKeyEl = document.getElementById('igApiKey');
        var passwordEl = document.getElementById('igPassword');
        var baseUrlEl = document.getElementById('igBaseUrl');
        var profiles = data.igProfilesSafe || { demo: {}, live: {} };
        var p = profiles[activeProfile] || {};
        if (usernameEl) usernameEl.value = p.igUsername || '';
        if (baseUrlEl) {
          baseUrlEl.value = p.igBaseUrl || '';
          baseUrlEl.placeholder = activeProfile === 'live' ? 'https://api.ig.com' : 'https://demo-api.ig.com';
        }
        if (apiKeyEl) { apiKeyEl.value = ''; apiKeyEl.placeholder = p.credentialsConfigured ? '••••••' : 'IG API key'; }
        if (passwordEl) { passwordEl.value = ''; passwordEl.placeholder = p.credentialsConfigured ? '••••••' : 'IG password'; }
      })
      .catch(function () {});
  }

  function showSettings() {
    loadConfigIntoForm();
    if (settingsModal) {
      settingsModal.classList.remove('hidden');
      settingsModal.setAttribute('aria-hidden', 'false');
    }
  }

  function hideSettings() {
    if (settingsModal) {
      settingsModal.classList.add('hidden');
      settingsModal.setAttribute('aria-hidden', 'true');
    }
    if (settingsStatus) {
      settingsStatus.classList.add('hidden');
      settingsStatus.textContent = '';
    }
  }

  if (settingsBtn) settingsBtn.addEventListener('click', showSettings);
  if (settingsClose) settingsClose.addEventListener('click', hideSettings);
  if (settingsCancel) settingsCancel.addEventListener('click', hideSettings);
  if (profileSelect) profileSelect.addEventListener('change', onProfileChange);

  if (settingsModal) {
    settingsModal.addEventListener('click', function (e) {
      if (e.target === settingsModal) hideSettings();
    });
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var apiKey = document.getElementById('igApiKey');
      var username = document.getElementById('igUsername');
      var password = document.getElementById('igPassword');
      var baseUrlEl = document.getElementById('igBaseUrl');
      var payload = {};
      if (profileSelect && profileSelect.value) payload.activeProfile = profileSelect.value;
      if (baseUrlEl && baseUrlEl.value.trim()) payload.igBaseUrl = baseUrlEl.value.trim();
      if (apiKey && apiKey.value.trim()) payload.igApiKey = apiKey.value.trim();
      if (username && username.value.trim()) payload.igUsername = username.value.trim();
      if (password && password.value.trim()) payload.igPassword = password.value.trim();

      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          log('Config saved');
          if (typeof onConfigSaved === 'function') onConfigSaved(data);
          if (settingsStatus) {
            settingsStatus.textContent = 'Saved.';
            settingsStatus.classList.remove('hidden');
            settingsStatus.className = 'text-sm text-emerald-500';
          }
          var activeProfile = data.activeProfile || 'demo';
          var profiles = data.igProfilesSafe || { demo: {}, live: {} };
          var p = profiles[activeProfile] || {};
          if (profileSelect) profileSelect.value = activeProfile;
          if (username) username.value = p.igUsername || username.value;
          if (baseUrlEl) {
            baseUrlEl.value = p.igBaseUrl || '';
            baseUrlEl.placeholder = activeProfile === 'live' ? 'https://api.ig.com' : 'https://demo-api.ig.com';
          }
          if (apiKey) { apiKey.value = ''; apiKey.placeholder = p.credentialsConfigured ? '••••••' : 'IG API key'; }
          if (password) { password.value = ''; password.placeholder = p.credentialsConfigured ? '••••••' : 'IG password'; }
        })
        .catch(function (err) {
          log('Config save failed: ' + (err.message || 'Unknown error'));
          if (settingsStatus) {
            settingsStatus.textContent = 'Error: ' + (err.message || 'Failed to save');
            settingsStatus.classList.remove('hidden');
            settingsStatus.className = 'text-sm text-red-500';
          }
        });
    });
  }
}
