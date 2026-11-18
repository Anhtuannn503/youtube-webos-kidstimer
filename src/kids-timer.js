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
const DAY_NAMES_NL = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

/**
 * @typedef {Object} KidsProfile
 * @property {string} name
 * @property {boolean} isKids
 * @property {number} limitMinutes
 * @property {string} date
 * @property {number} usedSeconds
 * @property {number} extraSeconds
 * @property {Record<string, number>} [history]
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

/** @type {ResolveCommandRegistry | null} */
let resolveRegistry = null;

/** @type {import('./app_api/index').ResolveCommandPayload | null} */
let lastAccountSelectorPayload = null;

let currentAccountKey = DEFAULT_ACCOUNT_KEY;
let currentAccountName = 'Huidig account';
let pendingSeconds = 0;
let warned5MinForKey = '';
let warned1MinForKey = '';
let switchingFromLockUntil = 0;

/**
 * @param {Date} [d]
 * @returns {string}
 */
function formatDateKey(d = new Date()) {
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTodayKey() {
  return formatDateKey(new Date());
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
 * Keep only the last 14 days of history to keep storage compact.
 * @param {Record<string, number> | undefined} history
 * @returns {Record<string, number>}
 */
function pruneHistory(history) {
  if (!history || typeof history !== 'object') return {};
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffKey = formatDateKey(cutoff);
  /** @type {Record<string, number>} */
  const pruned = {};
  for (const [k, v] of Object.entries(history)) {
    if (k >= cutoffKey && typeof v === 'number' && v >= 0) {
      pruned[k] = v;
    }
  }
  return pruned;
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

    if (!profile.history || typeof profile.history !== 'object') {
      profile.history = {};
      if (profile.date && profile.usedSeconds > 0) {
        profile.history[profile.date] = profile.usedSeconds;
      }
      changed = true;
    }

    if (
      fallbackName &&
      fallbackName !== 'Huidig account' &&
      profile.name !== fallbackName
    ) {
      profile.name = fallbackName;
      changed = true;
    }

    if (profile.date !== today) {
      if (profile.date && profile.usedSeconds > 0) {
        profile.history = pruneHistory({
          ...profile.history,
          [profile.date]: profile.usedSeconds
        });
      }
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
    name:
      fallbackName || (key === DEFAULT_ACCOUNT_KEY ? 'Standaardaccount' : key),
    isKids: false,
    limitMinutes: configRead('kidsTimerLimitMinutes') || 60,
    date: today,
    usedSeconds: 0,
    extraSeconds: 0,
    history: {}
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
    const today = getTodayKey();
    const nextUsed = profile.usedSeconds + pendingSeconds;
    const nextHistory = pruneHistory({
      ...(profile.history || {}),
      [today]: nextUsed
    });
    updateProfile(currentAccountKey, {
      usedSeconds: nextUsed,
      history: nextHistory
    });
    pendingSeconds = 0;
  }
}

function formatDuration(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatShortHoursMinutes(totalSeconds) {
  const totalMins = Math.round(totalSeconds / 60);
  if (totalMins < 60) return `${totalMins}m`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m > 0 ? `${h}u ${m}m` : `${h}u`;
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
          errorEl.textContent = 'Onjuiste pincode. Probeer het opnieuw.';
        }
      } catch (err) {
        currentPin = '';
        updateDots();
        errorEl.textContent =
          err instanceof Error ? err.message : 'Fout bij opslaan van pincode.';
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

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'WIS', '0', 'DEL'];
  for (const key of keys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ytaf-kids-btn';
    btn.textContent = key;

    btn.addEventListener('click', () => {
      if (key === 'WIS') {
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
    cancelBtn.textContent = 'Annuleren';
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
      title: 'Bevestig ouder-PIN',
      subtitle: 'Voer je 4-cijferige ouder-PIN nogmaals in',
      cancellable: true,
      onSubmit: (pin) => {
        if (pin !== firstPin) {
          showNotification(
            'Pincodes kwamen niet overeen. Probeer opnieuw.',
            3000,
            'red'
          );
          setTimeout(() => showSetPinFlow(onSuccess), 0);
          return true;
        }
        configWrite('kidsTimerPinHash', hashPin(pin));
        showNotification('Ouder-PIN opgeslagen.', 3000, 'green');
        setTimeout(() => onSuccess(), 0);
        return true;
      }
    });
  };

  showPinModal({
    title: 'Ouder-PIN instellen',
    subtitle: 'Kies een 4-cijferige pincode om de kindertimer te beveiligen',
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
    title: 'Ouder-PIN vereist',
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
    `${profile.name} verlengd met ${minutes} minuten`,
    4000,
    'green'
  );
}

function resetTodayTimer(key = currentAccountKey) {
  const profile = getOrCreateProfile(key);
  const today = getTodayKey();
  const nextHistory = pruneHistory({
    ...(profile.history || {}),
    [today]: 0
  });
  updateProfile(key, {
    date: today,
    usedSeconds: 0,
    extraSeconds: 0,
    history: nextHistory
  });
  if (key === currentAccountKey) {
    pendingSeconds = 0;
    warned5MinForKey = '';
    warned1MinForKey = '';
    hideLockOverlay();
  }
  showNotification(`Timer gereset voor ${profile.name}`, 4000, 'green');
}

function switchAccountFromLock() {
  switchingFromLockUntil = Date.now() + 45000;
  hideLockOverlay();
  if (resolveRegistry) {
    const payload = lastAccountSelectorPayload ?? {
      startAccountSelectorCommand: {
        nextEndpoint: {
          browseEndpoint: { browseId: 'FEwhat_to_watch' }
        }
      }
    };
    resolveRegistry.dispatchCommand(payload);
  }
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
  heading.textContent = `De tijd is om, ${profile.name}!`;
  card.appendChild(heading);

  const subEl = document.createElement('p');
  subEl.className = 'ytaf-kids-subtitle';
  subEl.textContent =
    'Je schermtijd voor vandaag is op. Vraag een ouder om te verlengen of te wisselen van profiel.';
  card.appendChild(subEl);

  const actions = document.createElement('div');
  actions.className = 'ytaf-kids-actions';

  const btnSwitch = document.createElement('button');
  btnSwitch.type = 'button';
  btnSwitch.className = 'ytaf-kids-btn ytaf-kids-btn-primary';
  btnSwitch.textContent = 'Wissel van profiel (Ouder-PIN)';
  btnSwitch.addEventListener('click', () => {
    requireParentPin('Voer ouder-PIN in om van profiel te wisselen', () =>
      switchAccountFromLock()
    );
  });

  const btn15 = document.createElement('button');
  btn15.type = 'button';
  btn15.className = 'ytaf-kids-btn';
  btn15.textContent = 'Verleng +15 min (Ouder-PIN)';
  btn15.addEventListener('click', () => {
    requireParentPin('Voer ouder-PIN in voor +15 minuten', () =>
      extendTime(15, currentAccountKey)
    );
  });

  const btn30 = document.createElement('button');
  btn30.type = 'button';
  btn30.className = 'ytaf-kids-btn';
  btn30.textContent = 'Verleng +30 min (Ouder-PIN)';
  btn30.addEventListener('click', () => {
    requireParentPin('Voer ouder-PIN in voor +30 minuten', () =>
      extendTime(30, currentAccountKey)
    );
  });

  const btnReset = document.createElement('button');
  btnReset.type = 'button';
  btnReset.className = 'ytaf-kids-btn';
  btnReset.textContent = 'Deblokkeer / Reset vandaag (Ouder-PIN)';
  btnReset.addEventListener('click', () => {
    requireParentPin('Voer ouder-PIN in om vandaag te resetten', () =>
      resetTodayTimer(currentAccountKey)
    );
  });

  actions.appendChild(btnSwitch);
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

function showWeeklyOverviewModal(onBackToSettings) {
  flushUsedSeconds();

  const overlay = document.createElement('div');
  overlay.className = 'ytaf-kids-overlay';

  const card = document.createElement('div');
  card.className = 'ytaf-kids-card';

  const heading = document.createElement('h2');
  heading.textContent = 'Weekoverzicht kijktijd';
  card.appendChild(heading);

  const subEl = document.createElement('p');
  subEl.className = 'ytaf-kids-subtitle';
  subEl.textContent = 'Afgelopen 7 dagen per gebruiker (alleen afspeeltijd)';
  card.appendChild(subEl);

  const listEl = document.createElement('div');
  listEl.className = 'ytaf-kids-weekly-list';

  /** @type {Array<{ key: string, label: string }>} */
  const days = [];
  for (let offset = 6; offset >= 0; offset--) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    const key = formatDateKey(d);
    const label = offset === 0 ? 'Vandaag' : DAY_NAMES_NL[d.getDay()] ?? '';
    days.push({ key, label });
  }

  const profiles = getProfilesMap();
  const profileKeys = Object.keys(profiles);
  const todayKey = getTodayKey();

  if (profileKeys.length === 0) {
    const emptyEl = document.createElement('p');
    emptyEl.className = 'ytaf-kids-subtitle';
    emptyEl.textContent = 'Nog geen kijkgeschiedenis beschikbaar.';
    listEl.appendChild(emptyEl);
  } else {
    for (const pKey of profileKeys) {
      const p = getOrCreateProfile(pKey);
      const history = p.history || {};
      let weekTotal = 0;

      const userBox = document.createElement('div');
      userBox.className = 'ytaf-kids-weekly-user';

      const daysGrid = document.createElement('div');
      daysGrid.className = 'ytaf-kids-weekly-days';

      for (const day of days) {
        let secs = history[day.key] ?? 0;
        if (day.key === todayKey) {
          secs = Math.max(secs, p.usedSeconds);
        }
        weekTotal += secs;

        const cell = document.createElement('div');
        cell.className = 'ytaf-kids-weekly-day';

        const dayLabel = document.createElement('div');
        dayLabel.textContent = day.label;
        cell.appendChild(dayLabel);

        const timeLabel = document.createElement('strong');
        timeLabel.textContent = formatShortHoursMinutes(secs);
        cell.appendChild(timeLabel);

        daysGrid.appendChild(cell);
      }

      const headerLine = document.createElement('div');
      const nameStrong = document.createElement('strong');
      nameStrong.textContent = `${p.name} (${p.isKids ? 'Kind' : 'Volwassene'})`;
      headerLine.appendChild(nameStrong);
      headerLine.appendChild(
        document.createTextNode(
          ` — Week: ${formatShortHoursMinutes(weekTotal)}`
        )
      );

      userBox.appendChild(headerLine);
      userBox.appendChild(daysGrid);
      listEl.appendChild(userBox);
    }
  }

  card.appendChild(listEl);

  const closeAndBack = () => {
    removeModal(overlay);
    if (onBackToSettings) onBackToSettings();
  };

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'ytaf-kids-btn ytaf-kids-btn-primary';
  backBtn.textContent = 'Terug';
  backBtn.addEventListener('click', closeAndBack);
  card.appendChild(backBtn);

  overlay.appendChild(card);
  pushModal({
    element: overlay,
    onBack: closeAndBack,
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
  heading.textContent = 'Alle profielen beheren';
  card.appendChild(heading);

  const subEl = document.createElement('p');
  subEl.className = 'ytaf-kids-subtitle';
  subEl.textContent =
    'Kies een profiel om te wisselen tussen Kind-account (met timer) en Volwassene (geen timer).';
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
      emptyEl.textContent = 'Nog geen profielen gevonden.';
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
          ? `Kind (${p.limitMinutes}m, nog ${remaining})`
          : 'Volwassene (geen timer)';
        btn.textContent = `${p.name}${isCurrent ? ' [Actief]' : ''}: ${roleLabel}`;
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
    backBtn.textContent = 'Terug';
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
  heading.textContent = 'Ouderlijk toezicht & Kindertimer';
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
  btnAdd15.textContent = '+15 min vandaag';

  const btnReset = document.createElement('button');
  btnReset.type = 'button';
  btnReset.className = 'ytaf-kids-btn';
  btnReset.textContent = 'Reset vandaag';

  rowExtra.appendChild(btnAdd15);
  rowExtra.appendChild(btnReset);

  const rowOverviews = document.createElement('div');
  rowOverviews.className = 'ytaf-kids-row';

  const btnManageProfiles = document.createElement('button');
  btnManageProfiles.type = 'button';
  btnManageProfiles.className = 'ytaf-kids-btn';
  btnManageProfiles.textContent = 'Alle profielen...';

  const btnWeeklyOverview = document.createElement('button');
  btnWeeklyOverview.type = 'button';
  btnWeeklyOverview.className = 'ytaf-kids-btn';
  btnWeeklyOverview.textContent = 'Weekoverzicht...';

  rowOverviews.appendChild(btnManageProfiles);
  rowOverviews.appendChild(btnWeeklyOverview);

  const rowBottom = document.createElement('div');
  rowBottom.className = 'ytaf-kids-row';

  const btnChangePin = document.createElement('button');
  btnChangePin.type = 'button';
  btnChangePin.className = 'ytaf-kids-btn';
  btnChangePin.textContent = 'PIN wijzigen';

  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'ytaf-kids-btn ytaf-kids-btn-primary';
  btnClose.textContent = 'Sluiten';

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

    appendStatusLine('Hoofdschakelaar timer: ', enabled ? 'Aan' : 'Uit');
    statusEl.appendChild(document.createElement('br'));
    appendStatusLine('Ingelogd profiel: ', profile.name);
    statusEl.appendChild(document.createElement('br'));
    appendStatusLine(
      'Type account: ',
      profile.isKids ? 'Kind-account (timer actief)' : 'Volwassene (geen timer)'
    );
    if (profile.isKids) {
      statusEl.appendChild(document.createElement('br'));
      appendStatusLine(
        'Resterend vandaag: ',
        formatDuration(remaining),
        ` (Limiet: ${profile.limitMinutes} min)`
      );
    }

    btnToggleTimer.textContent = `Kindertimer: ${enabled ? 'AAN' : 'UIT'}`;
    btnToggleKidsProfile.textContent = `Profiel "${profile.name}": ${profile.isKids ? 'Kind-account (timer)' : 'Volwassene (geen timer)'}`;
    btnLimit.textContent = `Daglimiet "${profile.name}": ${profile.limitMinutes} min (klik om te wisselen)`;
    btnAutoDetect.textContent = `YouTube Kids auto-detectie: ${autoDetect ? 'AAN' : 'UIT'}`;
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

  btnWeeklyOverview.addEventListener('click', () => {
    closeSettings();
    showWeeklyOverviewModal(() => showKidsSettingsModal());
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
  actions.appendChild(rowOverviews);
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

  requireParentPin('Voer ouder-PIN in om instellingen te openen', () =>
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
    switchingFromLockUntil = 0;
  } else if (nextName && nextName !== 'Huidig account') {
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
    /^(search|zoeken|home|start|subscriptions|abonnementen|library|bibliotheek|settings|instellingen|music|muziek|gaming|gamen|movies|films|shorts|news|nieuws|sports|sport|live|podcasts|sign in|inloggen|guest|gast|youtube|youtube kids|kids|switch account|account wisselen)$/i;

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

  /** @type {Array<{ top: number, text: string }>} */
  const candidates = [];

  const specific = document.querySelectorAll(
    'ytlr-guide-entry-renderer, ytlr-pivot-bar-item-renderer, [idomkey*="account"], ytlr-account-item-renderer, yt-formatted-string, span, div, [role="button"]'
  );
  for (const el of specific) {
    if (el.closest('.ytaf-ui-container, .ytaf-kids-overlay')) continue;
    const rect = el.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= 0 &&
      rect.left < 240 &&
      rect.top >= 0 &&
      rect.top < 220
    ) {
      const text = el.getAttribute('aria-label') || el.textContent || '';
      if (text.trim()) {
        candidates.push({ top: rect.top, text });
      }
    }
  }

  candidates.sort((a, b) => a.top - b.top);
  for (const item of candidates) {
    if (applyDetectedName(item.text)) return;
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
  resolveRegistry = registry;
  const prevAccountSelectorHook = registry.getHook(
    'startAccountSelectorCommand'
  );

  registry.setHook(
    'startAccountSelectorCommand',
    (resolveCommand, payload, extra) => {
      lastAccountSelectorPayload = payload;
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
        isCurrentAccountKids() &&
        Date.now() > switchingFromLockUntil
      ) {
        pausePlayback();
        requireParentPin(
          'Voer ouder-PIN in om van account te wisselen',
          proceed
        );
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
      setActiveAccount(DEFAULT_ACCOUNT_KEY, 'Huidig account', false);
      setTimeout(() => refreshActiveAccountFromDom(), 1500);
    }
    resolveCommand(payload, extra);
  });

  const fetchRegistry = await FetchRegistry.getInstance();
  fetchRegistry.addEventListener('response', async (evt) => {
    const response = evt.detail;
    if (
      !response.url.includes('account') &&
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
    const profile = getOrCreateProfile(currentAccountKey, currentAccountName);

    if (enabled && isKids) {
      const remaining = getProfileRemainingSeconds(profile, currentAccountKey);
      if (remaining <= 0) {
        flushUsedSeconds();
        if (Date.now() >= switchingFromLockUntil) {
          showLockOverlay();
        }
        pausePlayback();
        return;
      }
    } else {
      hideLockOverlay();
    }

    if (
      lockOverlay === null &&
      document.visibilityState === 'visible' &&
      playerInstance
    ) {
      const state = playerInstance.getPlayerStateObject();
      if (state.isPlaying && !playerInstance.isInline()) {
        pendingSeconds += 1;

        if (enabled && isKids) {
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
              `Kindertimer (${profile.name}): nog 5 minuten`,
              5000,
              'yellow'
            );
          } else if (
            updatedRemaining === 60 &&
            warned1MinForKey !== currentAccountKey
          ) {
            warned1MinForKey = currentAccountKey;
            showNotification(
              `Kindertimer (${profile.name}): nog 1 minuut`,
              5000,
              'red'
            );
          }

          if (updatedRemaining <= 0) {
            flushUsedSeconds();
            showLockOverlay();
            return;
          }
        }

        if (pendingSeconds >= 10) {
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
