/*global navigate*/
import sha256 from 'tiny-sha256';
import { configRead, configWrite, configAddChangeListener } from './config.js';
import { ResolveCommandRegistry } from './app_api/index';
import { FetchRegistry } from './hooks/fetch';
import { getPlayerManager } from './player_api/manager';
import { showNotification } from './ui.js';
import './kids-timer.css';

const PIN_LENGTH = 4;
const LIMIT_PRESETS = [15, 30, 45, 60, 90, 120];
const ARROW_KEY_CODE = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
const DEFAULT_ACCOUNT_KEY = 'default';

/**
 * @typedef {Object} KidsProfile
 * @property {string} name
 * @property {boolean} isKids
 * @property {number} limitMinutes
 * @property {string} date
 * @property {number} usedSeconds
 * @property {number} extraSeconds
 */

/**
 * @typedef {Object} ModalEntry
 * @property {HTMLElement} element
 * @property {(() => void) | null} onBack
 * @property {((digit: string) => void) | null} onDigit
 * @property {(() => void) | null} onBackspace
 */

/** @type {ModalEntry[]} */
const activeModals = [];

/** @type {HTMLElement | null} */
let lockOverlay = null;

/** @type {import('./player_api/yt-api').YTPlayer | null} */
let playerInstance = null;

let currentAccountKey = DEFAULT_ACCOUNT_KEY;
let currentAccountName = 'Current Account';
let pendingSeconds = 0;
let warned5MinForKey = '';
let warned1MinForKey = '';

function getTodayKey() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function hashPin(pin) {
  return sha256(`ytaf-kids-pin:${pin}`);
}

function hasPin() {
  return Boolean(configRead('kidsTimerPinHash'));
}

function verifyPin(pin) {
  return hashPin(pin) === configRead('kidsTimerPinHash');
}

/**
 * @returns {Record<string, KidsProfile>}
 */
function getProfilesMap() {
  const raw = configRead('kidsProfiles');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return { ...raw };
}

/**
 * @param {Record<string, KidsProfile>} profiles
 */
function saveProfilesMap(profiles) {
  configWrite('kidsProfiles', profiles);
}

/**
 * @param {string} [key]
 * @param {string} [fallbackName]
 * @returns {KidsProfile}
 */
function getOrCreateProfile(key = currentAccountKey, fallbackName) {
  const profiles = getProfilesMap();
  const today = getTodayKey();
  const existing = profiles[key];

  if (existing) {
    let changed = false;
    const profile = { ...existing };

    if (
      fallbackName &&
      fallbackName !== 'Current Account' &&
      profile.name !== fallbackName
    ) {
      profile.name = fallbackName;
      changed = true;
    }

    if (profile.date !== today) {
      profile.date = today;
      profile.usedSeconds = 0;
      profile.extraSeconds = 0;
      changed = true;
      if (key === currentAccountKey) {
        pendingSeconds = 0;
        warned5MinForKey = '';
        warned1MinForKey = '';
      }
    }

    if (changed) {
      profiles[key] = profile;
      saveProfilesMap(profiles);
    }

    return profile;
  }

  /** @type {KidsProfile} */
  const created = {
    name: fallbackName || (key === DEFAULT_ACCOUNT_KEY ? 'Default Account' : key),
    isKids: false,
    limitMinutes: configRead('kidsTimerLimitMinutes') || 60,
    date: today,
    usedSeconds: 0,
    extraSeconds: 0
  };
  profiles[key] = created;
  saveProfilesMap(profiles);
  return created;
}

/**
 * @param {string} key
 * @param {Partial<KidsProfile>} patch
 * @returns {KidsProfile}
 */
function updateProfile(key, patch) {
  const profiles = getProfilesMap();
  const current = getOrCreateProfile(key);
  const updated = { ...current, ...patch };
  profiles[key] = updated;
  saveProfilesMap(profiles);
  return updated;
}

function isCurrentAccountKids() {
  const profile = getOrCreateProfile(currentAccountKey, currentAccountName);
  return Boolean(profile.isKids);
}

/**
 * @param {KidsProfile} profile
 * @param {string} [key]
 * @returns {number}
 */
function getProfileRemainingSeconds(profile, key) {
  const extraPending = key === currentAccountKey ? pendingSeconds : 0;
  const totalSeconds = profile.limitMinutes * 60 + profile.extraSeconds;
  return Math.max(0, totalSeconds - (profile.usedSeconds + extraPending));
}

function flushUsedSeconds() {
  if (pendingSeconds > 0) {
    const profile = getOrCreateProfile(currentAccountKey, currentAccountName);
    updateProfile(currentAccountKey, {
      usedSeconds: profile.usedSeconds + pendingSeconds
    });
    pendingSeconds = 0;
  }
}

function formatDuration(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function pausePlayback() {
  const video = document.querySelector('video');
  if (video && !video.paused) {
    video.pause();
  }
}

function focusFirstInModal(modalEl) {
  const firstBtn = modalEl.querySelector('button');
  if (firstBtn instanceof HTMLElement) {
    firstBtn.focus();
  }
}

/**
 * @param {ModalEntry} entry
 */
function pushModal(entry) {
  activeModals.push(entry);
  document.body.appendChild(entry.element);
  focusFirstInModal(entry.element);
}

/**
 * @param {HTMLElement} element
 */
function removeModal(element) {
  const idx = activeModals.findIndex((m) => m.element === element);
  if (idx !== -1) {
    activeModals.splice(idx, 1);
  }
  element.remove();

  const top = activeModals[activeModals.length - 1];
  if (top) {
    focusFirstInModal(top.element);
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.subtitle
 * @param {boolean} opts.cancellable
 * @param {(pin: string) => boolean} opts.onSubmit
 * @param {(() => void) | undefined} [opts.onCancel]
 */
function showPinModal({ title, subtitle, cancellable, onSubmit, onCancel }) {
  const overlay = document.createElement('div');
  overlay.className = 'ytaf-kids-overlay ytaf-kids-pin-layer';

  const card = document.createElement('div');
  card.className = 'ytaf-kids-card';

  const heading = document.createElement('h2');
  heading.textContent = title;
  card.appendChild(heading);

  const subEl = document.createElement('p');
  subEl.className = 'ytaf-kids-subtitle';
  subEl.textContent = subtitle;
  card.appendChild(subEl);

  const dotsContainer = document.createElement('div');
  dotsContainer.className = 'ytaf-kids-pin-dots';
  const dots = [];
  for (let i = 0; i < PIN_LENGTH; i++) {
    const dot = document.createElement('div');
    dot.className = 'ytaf-kids-pin-dot';
    dots.push(dot);
    dotsContainer.appendChild(dot);
  }
  card.appendChild(dotsContainer);

  const errorEl = document.createElement('div');
  errorEl.className = 'ytaf-kids-error';
  card.appendChild(errorEl);

  let currentPin = '';

  const updateDots = () => {
    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('filled', i < currentPin.length);
    }
  };

  const closeModal = () => {
    removeModal(overlay);
  };

  const handleDigit = (digit) => {
    if (currentPin.length >= PIN_LENGTH) return;
    errorEl.textContent = '';
    currentPin += digit;
    updateDots();

    if (currentPin.length === PIN_LENGTH) {
      const entered = currentPin;
      try {
        const accepted = onSubmit(entered);
        if (accepted) {
          closeModal();
        } else {
          currentPin = '';
          updateDots();
          errorEl.textContent = 'Incorrect PIN. Please try again.';
        }
      } catch (err) {
        currentPin = '';
        updateDots();
        errorEl.textContent =
          err instanceof Error ? err.message : 'Error saving PIN.';
      }
    }
  };

  const handleBackspace = () => {
    if (currentPin.length === 0) return;
    currentPin = currentPin.slice(0, -1);
    errorEl.textContent = '';
    updateDots();
  };

  const numpad = document.createElement('div');
  numpad.className = 'ytaf-kids-numpad';

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLR', '0', 'DEL'];
  for (const key of keys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ytaf-kids-btn';
    btn.textContent = key;

    btn.addEventListener('click', () => {
      if (key === 'CLR') {
        currentPin = '';
        errorEl.textContent = '';
        updateDots();
      } else if (key === 'DEL') {
        handleBackspace();
      } else {
        handleDigit(key);
      }
    });

    numpad.appendChild(btn);
  }
  card.appendChild(numpad);

  const handleCancel = () => {
    closeModal();
    if (onCancel) onCancel();
  };

  if (cancellable) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ytaf-kids-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', handleCancel);
    card.appendChild(cancelBtn);
  }

  overlay.appendChild(card);

  pushModal({
    element: overlay,
    onBack: cancellable ? handleCancel : null,
    onDigit: handleDigit,
    onBackspace: handleBackspace
  });
}

/**
 * @param {() => void} onSuccess
 */
function showSetPinFlow(onSuccess) {
  let firstPin = '';

  const askConfirm = () => {
    showPinModal({
      title: 'Confirm Parent PIN',
      subtitle: 'Re-enter your 4-digit Parent PIN',
      cancellable: true,
      onSubmit: (pin) => {
        if (pin !== firstPin) {
          showNotification('PINs did not match. Please try again.', 3000, 'red');
          setTimeout(() => showSetPinFlow(onSuccess), 0);
          return true;
        }
        configWrite('kidsTimerPinHash', hashPin(pin));
        showNotification('Parent PIN saved.', 3000, 'green');
        setTimeout(() => onSuccess(), 0);
        return true;
      }
    });
  };

  showPinModal({
    title: 'Set Parent PIN',
    subtitle: 'Choose a 4-digit PIN to protect Kids Timer settings',
    cancellable: true,
    onSubmit: (pin) => {
      firstPin = pin;
      setTimeout(() => askConfirm(), 0);
      return true;
    }
  });
}

/**
 * @param {string} subtitle
 * @param {() => void} onVerified
 * @param {(() => void) | undefined} [onCancel]
 */
function requireParentPin(subtitle, onVerified, onCancel) {
  showPinModal({
    title: 'Parent PIN Required',
    subtitle,
    cancellable: true,
    onSubmit: (pin) => {
      if (!verifyPin(pin)) return false;
      onVerified();
      return true;
    },
    onCancel
  });
}

function hideLockOverlay() {
  if (!lockOverlay) return;
  removeModal(lockOverlay);
  lockOverlay = null;
}

function extendTime(minutes, key = currentAccountKey) {
  const profile = getOrCreateProfile(key);
  updateProfile(key, { extraSeconds: profile.extraSeconds + minutes * 60 });
  if (key === currentAccountKey) {
    warned5MinForKey = '';
    warned1MinForKey = '';
    hideLockOverlay();
  }
  showNotification(
    `Extended ${profile.name} by ${minutes} minutes`,
    4000,
    'green'
  );
}

function resetTodayTimer(key = currentAccountKey) {
  const profile = getOrCreateProfile(key);
  updateProfile(key, {
    date: getTodayKey(),
    usedSeconds: 0,
    extraSeconds: 0
  });
  if (key === currentAccountKey) {
    pendingSeconds = 0;
    warned5MinForKey = '';
    warned1MinForKey = '';
    hideLockOverlay();
  }
  showNotification(`Timer reset for ${profile.name}`, 4000, 'green');
}

function showLockOverlay() {
  if (lockOverlay) return;

  pausePlayback();

  const profile = getOrCreateProfile(currentAccountKey, currentAccountName);

  const overlay = document.createElement('div');
  overlay.className = 'ytaf-kids-overlay';

  const card = document.createElement('div');
  card.className = 'ytaf-kids-card';

  const heading = document.createElement('h2');
  heading.textContent = `Time's Up, ${profile.name}!`;
  card.appendChild(heading);

  const subEl = document.createElement('p');
  subEl.className = 'ytaf-kids-subtitle';
  subEl.textContent =
    'Your screen time limit for today has been reached. Ask a parent to extend or unlock.';
  card.appendChild(subEl);

  const actions = document.createElement('div');
  actions.className = 'ytaf-kids-actions';

  const btn15 = document.createElement('button');
  btn15.type = 'button';
  btn15.className = 'ytaf-kids-btn ytaf-kids-btn-primary';
  btn15.textContent = 'Extend +15 min (Parent PIN)';
  btn15.addEventListener('click', () => {
    requireParentPin('Enter Parent PIN to add 15 minutes', () =>
      extendTime(15, currentAccountKey)
    );
  });

  const btn30 = document.createElement('button');
  btn30.type = 'button';
  btn30.className = 'ytaf-kids-btn';
  btn30.textContent = 'Extend +30 min (Parent PIN)';
  btn30.addEventListener('click', () => {
    requireParentPin('Enter Parent PIN to add 30 minutes', () =>
      extendTime(30, currentAccountKey)
    );
  });

  const btnReset = document.createElement('button');
  btnReset.type = 'button';
  btnReset.className = 'ytaf-kids-btn';
  btnReset.textContent = 'Unlock / Reset Today (Parent PIN)';
  btnReset.addEventListener('click', () => {
    requireParentPin('Enter Parent PIN to reset today', () =>
      resetTodayTimer(currentAccountKey)
    );
  });

  actions.appendChild(btn15);
  actions.appendChild(btn30);
  actions.appendChild(btnReset);
  card.appendChild(actions);
  overlay.appendChild(card);

  lockOverlay = overlay;
  pushModal({
    element: overlay,
    onBack: null,
    onDigit: null,
    onBackspace: null
  });
}

function showManageProfilesModal(onBackToSettings) {
  const overlay = document.createElement('div');
  overlay.className = 'ytaf-kids-overlay';

  const card = document.createElement('div');
  card.className = 'ytaf-kids-card';

  const heading = document.createElement('h2');
  heading.textContent = 'Manage All Profiles';
  card.appendChild(heading);

  const subEl = document.createElement('p');
  subEl.className = 'ytaf-kids-subtitle';
  subEl.textContent =
    'Select a profile to toggle between Kids Account (with timer) and Adult Account (no timer).';
  card.appendChild(subEl);

  const listEl = document.createElement('div');
  listEl.className = 'ytaf-kids-actions';
  card.appendChild(listEl);

  const closeAndBack = () => {
    removeModal(overlay);
    if (onBackToSettings) onBackToSettings();
  };

  const renderList = () => {
    listEl.textContent = '';
    const profiles = getProfilesMap();
    const keys = Object.keys(profiles);

    if (keys.length === 0) {
      const emptyEl = document.createElement('p');
      emptyEl.className = 'ytaf-kids-subtitle';
      emptyEl.textContent = 'No profiles detected yet.';
      listEl.appendChild(emptyEl);
    } else {
      for (const key of keys) {
        const p = getOrCreateProfile(key);
        const isCurrent = key === currentAccountKey;
        const remaining = formatDuration(getProfileRemainingSeconds(p, key));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ytaf-kids-btn';
        const roleLabel = p.isKids
          ? `Kids (${p.limitMinutes}m, ${remaining} left)`
          : 'Adult (No Timer)';
        btn.textContent = `${p.name}${isCurrent ? ' [Active]' : ''}: ${roleLabel}`;
        btn.addEventListener('click', () => {
          updateProfile(key, { isKids: !p.isKids });
          if (isCurrent && p.isKids) {
            hideLockOverlay();
          }
          renderList();
        });
        listEl.appendChild(btn);
      }
    }

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'ytaf-kids-btn ytaf-kids-btn-primary';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', closeAndBack);
    listEl.appendChild(backBtn);
    focusFirstInModal(overlay);
  };

  overlay.appendChild(card);
  pushModal({
    element: overlay,
    onBack: closeAndBack,
    onDigit: null,
    onBackspace: null
  });
  renderList();
}

function showKidsSettingsModal() {
  refreshActiveAccountFromDom();

  const overlay = document.createElement('div');
  overlay.className = 'ytaf-kids-overlay';

  const card = document.createElement('div');
  card.className = 'ytaf-kids-card';

  const heading = document.createElement('h2');
  heading.textContent = 'Parental Controls & Kids Timer';
  card.appendChild(heading);

  const statusEl = document.createElement('div');
  statusEl.className = 'ytaf-kids-status';
  card.appendChild(statusEl);

  const actions = document.createElement('div');
  actions.className = 'ytaf-kids-actions';

  const btnToggleTimer = document.createElement('button');
  btnToggleTimer.type = 'button';
  btnToggleTimer.className = 'ytaf-kids-btn';

  const btnToggleKidsProfile = document.createElement('button');
  btnToggleKidsProfile.type = 'button';
  btnToggleKidsProfile.className = 'ytaf-kids-btn';

  const btnLimit = document.createElement('button');
  btnLimit.type = 'button';
  btnLimit.className = 'ytaf-kids-btn';

  const btnAutoDetect = document.createElement('button');
  btnAutoDetect.type = 'button';
  btnAutoDetect.className = 'ytaf-kids-btn';

  const rowExtra = document.createElement('div');
  rowExtra.className = 'ytaf-kids-row';

  const btnAdd15 = document.createElement('button');
  btnAdd15.type = 'button';
  btnAdd15.className = 'ytaf-kids-btn';
  btnAdd15.textContent = '+15 min Today';

  const btnReset = document.createElement('button');
  btnReset.type = 'button';
  btnReset.className = 'ytaf-kids-btn';
  btnReset.textContent = 'Reset Today';

  rowExtra.appendChild(btnAdd15);
  rowExtra.appendChild(btnReset);

  const btnManageProfiles = document.createElement('button');
  btnManageProfiles.type = 'button';
  btnManageProfiles.className = 'ytaf-kids-btn';
  btnManageProfiles.textContent = 'Manage All Profiles...';

  const rowBottom = document.createElement('div');
  rowBottom.className = 'ytaf-kids-row';

  const btnChangePin = document.createElement('button');
  btnChangePin.type = 'button';
  btnChangePin.className = 'ytaf-kids-btn';
  btnChangePin.textContent = 'Change PIN';

  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'ytaf-kids-btn ytaf-kids-btn-primary';
  btnClose.textContent = 'Close';

  rowBottom.appendChild(btnChangePin);
  rowBottom.appendChild(btnClose);

  const refreshUI = () => {
    const enabled = configRead('kidsTimerEnabled');
    const profile = getOrCreateProfile(currentAccountKey, currentAccountName);
    const autoDetect = configRead('kidsAccountAutoDetect');
    const remaining = getProfileRemainingSeconds(profile, currentAccountKey);

    statusEl.textContent = '';

    const appendStatusLine = (label, value, suffix = '') => {
      statusEl.appendChild(document.createTextNode(label));
      const strong = document.createElement('strong');
      strong.textContent = value;
      statusEl.appendChild(strong);
      if (suffix) {
        statusEl.appendChild(document.createTextNode(suffix));
      }
    };

    appendStatusLine('Master Timer: ', enabled ? 'Enabled' : 'Disabled');
    statusEl.appendChild(document.createElement('br'));
    appendStatusLine('Logged-in Account: ', profile.name);
    statusEl.appendChild(document.createElement('br'));
    appendStatusLine(
      'Account Type: ',
      profile.isKids ? 'Kids Account (Timer Active)' : 'Adult Account (No Timer)'
    );
    if (profile.isKids) {
      statusEl.appendChild(document.createElement('br'));
      appendStatusLine(
        'Remaining Today: ',
        formatDuration(remaining),
        ` (Limit: ${profile.limitMinutes} min)`
      );
    }

    btnToggleTimer.textContent = `Master Kids Timer: ${enabled ? 'ON' : 'OFF'}`;
    btnToggleKidsProfile.textContent = `Set "${profile.name}": ${profile.isKids ? 'Kids Account (Timer)' : 'Adult Account (No Timer)'}`;
    btnLimit.textContent = `Daily Limit for "${profile.name}": ${profile.limitMinutes} min (Cycle)`;
    btnAutoDetect.textContent = `Auto-detect YouTube Kids: ${autoDetect ? 'ON' : 'OFF'}`;
  };

  btnToggleTimer.addEventListener('click', () => {
    const next = !configRead('kidsTimerEnabled');
    configWrite('kidsTimerEnabled', next);
    if (!next) hideLockOverlay();
    refreshUI();
  });

  btnToggleKidsProfile.addEventListener('click', () => {
    const profile = getOrCreateProfile(currentAccountKey, currentAccountName);
    const next = !profile.isKids;
    updateProfile(currentAccountKey, { isKids: next });
    if (!next) hideLockOverlay();
    refreshUI();
  });

  btnLimit.addEventListener('click', () => {
    const profile = getOrCreateProfile(currentAccountKey, currentAccountName);
    const idx = LIMIT_PRESETS.indexOf(profile.limitMinutes);
    const next = LIMIT_PRESETS[(idx + 1) % LIMIT_PRESETS.length] ?? 60;
    updateProfile(currentAccountKey, { limitMinutes: next });
    refreshUI();
  });

  btnAutoDetect.addEventListener('click', () => {
    configWrite('kidsAccountAutoDetect', !configRead('kidsAccountAutoDetect'));
    refreshUI();
  });

  btnAdd15.addEventListener('click', () => {
    extendTime(15, currentAccountKey);
    refreshUI();
  });

  btnReset.addEventListener('click', () => {
    resetTodayTimer(currentAccountKey);
    refreshUI();
  });

  const closeSettings = () => {
    removeModal(overlay);
  };

  btnManageProfiles.addEventListener('click', () => {
    closeSettings();
    showManageProfilesModal(() => showKidsSettingsModal());
  });

  btnChangePin.addEventListener('click', () => {
    closeSettings();
    showSetPinFlow(() => showKidsSettingsModal());
  });

  btnClose.addEventListener('click', closeSettings);

  actions.appendChild(btnToggleTimer);
  actions.appendChild(btnToggleKidsProfile);
  actions.appendChild(btnLimit);
  actions.appendChild(btnAutoDetect);
  actions.appendChild(rowExtra);
  actions.appendChild(btnManageProfiles);
  actions.appendChild(rowBottom);

  card.appendChild(actions);
  overlay.appendChild(card);

  refreshUI();

  pushModal({
    element: overlay,
    onBack: closeSettings,
    onDigit: null,
    onBackspace: null
  });
}

export function openParentalControls() {
  if (!hasPin()) {
    showSetPinFlow(() => showKidsSettingsModal());
    return;
  }

  requireParentPin('Enter Parent PIN to open Kids Timer settings', () =>
    showKidsSettingsModal()
  );
}

/**
 * Extract readable text from YouTube simpleText or runs object.
 * @param {unknown} val
 * @returns {string}
 */
function extractYtText(val) {
  if (!val || typeof val !== 'object') return '';
  const obj = /** @type {Record<string, unknown>} */ (val);
  if (typeof obj.simpleText === 'string') return obj.simpleText.trim();
  if (Array.isArray(obj.runs)) {
    return obj.runs
      .map((r) =>
        r && typeof r === 'object' && typeof r.text === 'string' ? r.text : ''
      )
      .join('')
      .trim();
  }
  return '';
}

/**
 * Extract stable account key from YouTube accountItemRenderer.
 * @param {Record<string, unknown>} obj
 * @param {string} name
 * @returns {string}
 */
function extractAccountKey(obj, name) {
  const endpoint = obj.serviceEndpoint;
  if (endpoint && typeof endpoint === 'object') {
    const jsonStr = JSON.stringify(endpoint);
    const match = /"(?:datasyncIdToken|pageIdToken|obfuscatedGaiaId)"\s*:\s*"([^"]+)"/.exec(
      jsonStr
    );
    if (match?.[1]) {
      return `yt:${match[1]}`;
    }
  }
  return `name:${name.toLowerCase()}`;
}

/**
 * Recursively scan YouTube accounts_list JSON for account items.
 * @param {unknown} node
 * @param {number} depth
 * @param {Array<{ key: string, name: string, isSelected: boolean, isKids: boolean }>} found
 */
function collectAccountsFromJson(node, depth = 0, found = []) {
  if (depth > 14 || !node || typeof node !== 'object') return found;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectAccountsFromJson(item, depth + 1, found);
    }
    return found;
  }

  const obj = /** @type {Record<string, unknown>} */ (node);
  if ('accountName' in obj) {
    const name = extractYtText(obj.accountName);
    if (name && ('isSelected' in obj || 'accountPhoto' in obj)) {
      const byline = extractYtText(obj.accountByline).toLowerCase();
      const isKids =
        obj.isKidsAccount === true || byline.includes('youtube kids');
      found.push({
        key: extractAccountKey(obj, name),
        name,
        isSelected: 'isSelected' in obj ? obj.isSelected === true : true,
        isKids
      });
    }
  }

  for (const val of Object.values(obj)) {
    collectAccountsFromJson(val, depth + 1, found);
  }
  return found;
}

/**
 * Switch the active tracked account and update lock state accordingly.
 * @param {string} nextKey
 * @param {string} nextName
 * @param {boolean} [autoIsKids]
 */
function setActiveAccount(nextKey, nextName, autoIsKids = false) {
  if (nextKey !== currentAccountKey) {
    flushUsedSeconds();
    currentAccountKey = nextKey;
    currentAccountName = nextName;
    pendingSeconds = 0;
    warned5MinForKey = '';
    warned1MinForKey = '';
  } else if (nextName && nextName !== 'Current Account') {
    currentAccountName = nextName;
  }

  const profile = getOrCreateProfile(currentAccountKey, currentAccountName);
  if (autoIsKids && configRead('kidsAccountAutoDetect') && !profile.isKids) {
    updateProfile(currentAccountKey, { isKids: true });
  }

  if (!configRead('kidsTimerEnabled') || !isCurrentAccountKids()) {
    hideLockOverlay();
  }
}

function isKidsLogoVisibleInDom() {
  const logoNodes = document.querySelectorAll(
    'ytlr-redux-connect-ytlr-logo-entity, [idomkey*="logo"], [aria-label*="YouTube Kids"]'
  );
  for (const node of logoNodes) {
    const label = node.getAttribute('aria-label') || node.textContent || '';
    if (label.toLowerCase().includes('kids')) {
      return true;
    }
  }
  return false;
}

function refreshActiveAccountFromDom() {
  const navIgnore =
    /^(search|home|subscriptions|library|settings|music|gaming|movies|shorts|news|sports|live|podcasts|sign in|guest|youtube|youtube kids|kids)$/i;

  const isKidsLogo = isKidsLogoVisibleInDom();

  const applyDetectedName = (raw) => {
    const label = raw.replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40 || navIgnore.test(label)) {
      return false;
    }
    const nextKey = `name:${label.toLowerCase()}`;
    if (
      currentAccountKey === DEFAULT_ACCOUNT_KEY ||
      (currentAccountKey.startsWith('name:') && currentAccountKey !== nextKey)
    ) {
      setActiveAccount(nextKey, label, isKidsLogo);
    } else if (!currentAccountKey.startsWith('yt:')) {
      currentAccountName = label;
    }
    return true;
  };

  const specific = document.querySelectorAll(
    'ytlr-guide-entry-renderer, ytlr-pivot-bar-item-renderer, [idomkey*="account"], ytlr-account-item-renderer'
  );
  for (const el of specific) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.left < 300 && rect.top < 220) {
      const text = el.getAttribute('aria-label') || el.textContent || '';
      if (applyDetectedName(text)) return;
    }
  }

  // Fallback: scan visible elements in the top-left sidebar corner (where YouTube TV renders the active profile name)
  const sidebarEls = document.querySelectorAll(
    'yt-formatted-string, span, div, [role="button"]'
  );
  for (const el of sidebarEls) {
    if (el.closest('.ytaf-ui-container, .ytaf-kids-overlay')) continue;
    if (el.children.length > 0) continue;
    const rect = el.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= 0 &&
      rect.left < 220 &&
      rect.top >= 0 &&
      rect.top < 200
    ) {
      const text = el.textContent || '';
      if (applyDetectedName(text)) return;
    }
  }
}

function handleModalKeyEvent(evt) {
  const topModal = activeModals[activeModals.length - 1];
  if (!topModal) return true;

  evt.preventDefault();
  evt.stopPropagation();

  if (evt.type !== 'keydown') return false;

  if (evt.keyCode in ARROW_KEY_CODE) {
    if (!topModal.element.contains(document.activeElement)) {
      focusFirstInModal(topModal.element);
    } else {
      navigate(ARROW_KEY_CODE[evt.keyCode]);
      if (!topModal.element.contains(document.activeElement)) {
        focusFirstInModal(topModal.element);
      }
    }
  } else if (evt.keyCode === 13) {
    if (
      evt instanceof KeyboardEvent &&
      document.activeElement instanceof HTMLElement &&
      topModal.element.contains(document.activeElement)
    ) {
      document.activeElement.click();
    }
  } else if (evt.keyCode === 27 || evt.keyCode === 461) {
    if (topModal.onBack) {
      topModal.onBack();
    }
  } else if (evt.key >= '0' && evt.key <= '9' && topModal.onDigit) {
    topModal.onDigit(evt.key);
  } else if (evt.keyCode === 8 && topModal.onBackspace) {
    topModal.onBackspace();
  }

  return false;
}

document.addEventListener('keydown', handleModalKeyEvent, true);
document.addEventListener('keypress', handleModalKeyEvent, true);
document.addEventListener('keyup', handleModalKeyEvent, true);

async function initAccountHooks() {
  const registry = await ResolveCommandRegistry.getInstance();
  const prevAccountSelectorHook = registry.getHook(
    'startAccountSelectorCommand'
  );

  registry.setHook(
    'startAccountSelectorCommand',
    (resolveCommand, payload, extra) => {
      const proceed = () => {
        if (prevAccountSelectorHook) {
          prevAccountSelectorHook(resolveCommand, payload, extra);
        } else {
          resolveCommand(payload, extra);
        }
      };

      if (
        !configRead('autoAccountSelect') &&
        configRead('kidsTimerEnabled') &&
        isCurrentAccountKids()
      ) {
        pausePlayback();
        requireParentPin('Enter Parent PIN to switch account', proceed);
        return;
      }
      proceed();
    }
  );

  registry.setHook('onIdentityChanged', (resolveCommand, payload, extra) => {
    const context = payload?.onIdentityChanged?.identityActionContext;
    if (
      context &&
      typeof context === 'object' &&
      'isSameIdentity' in context &&
      context.isSameIdentity === false
    ) {
      setActiveAccount(DEFAULT_ACCOUNT_KEY, 'Current Account', false);
      setTimeout(() => refreshActiveAccountFromDom(), 1500);
    }
    resolveCommand(payload, extra);
  });

  const fetchRegistry = await FetchRegistry.getInstance();
  fetchRegistry.addEventListener('response', async (evt) => {
    const response = evt.detail;
    if (
      !response.url.includes('accounts_list') &&
      !response.url.includes('/guide')
    ) {
      return;
    }

    try {
      const data = await response.clone().json();
      const accounts = collectAccountsFromJson(data);
      for (const acc of accounts) {
        getOrCreateProfile(acc.key, acc.name);
        if (acc.isKids && configRead('kidsAccountAutoDetect')) {
          updateProfile(acc.key, { isKids: true });
        }
      }

      const selected = accounts.find((acc) => acc.isSelected);
      if (selected) {
        setActiveAccount(selected.key, selected.name, selected.isKids);
      }
    } catch (err) {
      console.debug('[KidsTimer] Could not parse accounts_list:', err);
    }
  });
}

async function initPlaybackMonitor() {
  const manager = await getPlayerManager();
  playerInstance = manager.player;
}

function startTimerLoop() {
  setInterval(() => {
    if (currentAccountKey === DEFAULT_ACCOUNT_KEY) {
      refreshActiveAccountFromDom();
    }

    const enabled = configRead('kidsTimerEnabled');
    const isKids = isCurrentAccountKids();

    if (!enabled || !isKids) {
      hideLockOverlay();
      return;
    }

    const profile = getOrCreateProfile(currentAccountKey, currentAccountName);
    const remaining = getProfileRemainingSeconds(profile, currentAccountKey);

    if (remaining <= 0) {
      flushUsedSeconds();
      showLockOverlay();
      pausePlayback();
      return;
    }

    if (
      lockOverlay === null &&
      document.visibilityState === 'visible' &&
      playerInstance
    ) {
      const state = playerInstance.getPlayerStateObject();
      if (state.isPlaying && !playerInstance.isInline()) {
        pendingSeconds += 1;
        const updatedRemaining = getProfileRemainingSeconds(
          profile,
          currentAccountKey
        );

        if (
          updatedRemaining === 300 &&
          warned5MinForKey !== currentAccountKey
        ) {
          warned5MinForKey = currentAccountKey;
          showNotification(
            `Kids Timer (${profile.name}): 5 minutes remaining`,
            5000,
            'yellow'
          );
        } else if (
          updatedRemaining === 60 &&
          warned1MinForKey !== currentAccountKey
        ) {
          warned1MinForKey = currentAccountKey;
          showNotification(
            `Kids Timer (${profile.name}): 1 minute remaining`,
            5000,
            'red'
          );
        }

        if (updatedRemaining <= 0) {
          flushUsedSeconds();
          showLockOverlay();
        } else if (pendingSeconds >= 10) {
          flushUsedSeconds();
        }
      }
    }
  }, 1000);
}

configAddChangeListener('kidsTimerEnabled', (evt) => {
  if (!evt.detail.newValue) {
    hideLockOverlay();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushUsedSeconds();
  }
});

window.addEventListener('beforeunload', () => {
  flushUsedSeconds();
});

initAccountHooks();
initPlaybackMonitor();
startTimerLoop();
