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

let usedSecondsCache = 0;
let ticksSinceSave = 0;
let warned5Min = false;
let warned1Min = false;

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

function ensureTodayState() {
  const today = getTodayKey();
  if (configRead('kidsTimerDate') !== today) {
    configWrite('kidsTimerDate', today);
    configWrite('kidsTimerUsedSeconds', 0);
    configWrite('kidsTimerExtraSeconds', 0);
    usedSecondsCache = 0;
    ticksSinceSave = 0;
    warned5Min = false;
    warned1Min = false;
  } else if (ticksSinceSave === 0) {
    usedSecondsCache = configRead('kidsTimerUsedSeconds');
  }
}

function flushUsedSeconds() {
  if (ticksSinceSave > 0) {
    configWrite('kidsTimerUsedSeconds', usedSecondsCache);
    ticksSinceSave = 0;
  }
}

function getRemainingSeconds() {
  ensureTodayState();
  const totalSeconds =
    configRead('kidsTimerLimitMinutes') * 60 +
    configRead('kidsTimerExtraSeconds');
  return Math.max(0, totalSeconds - usedSecondsCache);
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

function extendTime(minutes) {
  ensureTodayState();
  const extra = configRead('kidsTimerExtraSeconds') + minutes * 60;
  configWrite('kidsTimerExtraSeconds', extra);
  warned5Min = false;
  warned1Min = false;
  hideLockOverlay();
  showNotification(`Kids Timer extended by ${minutes} minutes`, 4000, 'green');
}

function resetTodayTimer() {
  configWrite('kidsTimerDate', getTodayKey());
  configWrite('kidsTimerUsedSeconds', 0);
  configWrite('kidsTimerExtraSeconds', 0);
  usedSecondsCache = 0;
  ticksSinceSave = 0;
  warned5Min = false;
  warned1Min = false;
  hideLockOverlay();
  showNotification('Kids Timer reset for today', 4000, 'green');
}

function showLockOverlay() {
  if (lockOverlay) return;

  pausePlayback();

  const overlay = document.createElement('div');
  overlay.className = 'ytaf-kids-overlay';

  const card = document.createElement('div');
  card.className = 'ytaf-kids-card';

  const heading = document.createElement('h2');
  heading.textContent = "Time's Up!";
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
      extendTime(15)
    );
  });

  const btn30 = document.createElement('button');
  btn30.type = 'button';
  btn30.className = 'ytaf-kids-btn';
  btn30.textContent = 'Extend +30 min (Parent PIN)';
  btn30.addEventListener('click', () => {
    requireParentPin('Enter Parent PIN to add 30 minutes', () =>
      extendTime(30)
    );
  });

  const btnReset = document.createElement('button');
  btnReset.type = 'button';
  btnReset.className = 'ytaf-kids-btn';
  btnReset.textContent = 'Unlock / Reset Today (Parent PIN)';
  btnReset.addEventListener('click', () => {
    requireParentPin('Enter Parent PIN to reset today', () =>
      resetTodayTimer()
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

function showKidsSettingsModal() {
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
    const isKids = configRead('kidsAccountActive');
    const limit = configRead('kidsTimerLimitMinutes');
    const autoDetect = configRead('kidsAccountAutoDetect');
    const remaining = getRemainingSeconds();

    statusEl.innerHTML =
      `Timer: <strong>${enabled ? 'Enabled' : 'Disabled'}</strong><br>` +
      `Current Profile: <strong>${isKids ? 'Kids Account (Protected)' : 'Standard Account'}</strong><br>` +
      `Remaining Today: <strong>${formatDuration(remaining)}</strong> (Limit: ${limit} min)`;

    btnToggleTimer.textContent = `Kids Timer: ${enabled ? 'ON' : 'OFF'}`;
    btnToggleKidsProfile.textContent = `Current Profile: ${isKids ? 'Kids Account' : 'Standard Account'}`;
    btnLimit.textContent = `Daily Limit: ${limit} min (Press OK to cycle)`;
    btnAutoDetect.textContent = `Auto-detect Kids Profile: ${autoDetect ? 'ON' : 'OFF'}`;
  };

  btnToggleTimer.addEventListener('click', () => {
    const next = !configRead('kidsTimerEnabled');
    configWrite('kidsTimerEnabled', next);
    if (!next) hideLockOverlay();
    refreshUI();
  });

  btnToggleKidsProfile.addEventListener('click', () => {
    const next = !configRead('kidsAccountActive');
    configWrite('kidsAccountActive', next);
    if (!next) hideLockOverlay();
    refreshUI();
  });

  btnLimit.addEventListener('click', () => {
    const current = configRead('kidsTimerLimitMinutes');
    const idx = LIMIT_PRESETS.indexOf(current);
    const next = LIMIT_PRESETS[(idx + 1) % LIMIT_PRESETS.length] ?? 60;
    configWrite('kidsTimerLimitMinutes', next);
    refreshUI();
  });

  btnAutoDetect.addEventListener('click', () => {
    configWrite('kidsAccountAutoDetect', !configRead('kidsAccountAutoDetect'));
    refreshUI();
  });

  btnAdd15.addEventListener('click', () => {
    extendTime(15);
    refreshUI();
  });

  btnReset.addEventListener('click', () => {
    resetTodayTimer();
    refreshUI();
  });

  const closeSettings = () => {
    removeModal(overlay);
  };

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
 * Recursively scan YouTube accounts_list JSON for a selected kids/supervised profile.
 * @param {unknown} node
 * @param {number} depth
 * @returns {boolean}
 */
function detectSelectedKidsAccount(node, depth = 0) {
  if (depth > 12 || !node || typeof node !== 'object') return false;

  if (Array.isArray(node)) {
    return node.some((item) => detectSelectedKidsAccount(item, depth + 1));
  }

  const obj = /** @type {Record<string, unknown>} */ (node);
  if (obj.isSelected === true) {
    if (obj.isKidsAccount === true || obj.isSupervised === true) {
      return true;
    }
    const serialized = JSON.stringify(obj).toLowerCase();
    if (
      serialized.includes('youtube kids') ||
      serialized.includes('"supervised"')
    ) {
      return true;
    }
  }

  return Object.values(obj).some((val) =>
    detectSelectedKidsAccount(val, depth + 1)
  );
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
        configRead('kidsAccountActive')
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
      configWrite('kidsAccountActive', false);
    }
    resolveCommand(payload, extra);
  });

  const fetchRegistry = await FetchRegistry.getInstance();
  fetchRegistry.addEventListener('response', async (evt) => {
    if (!configRead('kidsAccountAutoDetect')) return;
    const response = evt.detail;
    if (!response.url.includes('accounts_list')) return;

    try {
      const data = await response.clone().json();
      if (detectSelectedKidsAccount(data)) {
        configWrite('kidsAccountActive', true);
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
  ensureTodayState();

  setInterval(() => {
    const enabled = configRead('kidsTimerEnabled');
    const isKids = configRead('kidsAccountActive');

    if (!enabled || !isKids) {
      hideLockOverlay();
      return;
    }

    ensureTodayState();
    const remaining = getRemainingSeconds();

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
        usedSecondsCache += 1;
        ticksSinceSave += 1;

        const updatedRemaining = getRemainingSeconds();
        if (updatedRemaining === 300 && !warned5Min) {
          warned5Min = true;
          showNotification('Kids Timer: 5 minutes remaining', 5000, 'yellow');
        } else if (updatedRemaining === 60 && !warned1Min) {
          warned1Min = true;
          showNotification('Kids Timer: 1 minute remaining', 5000, 'red');
        }

        if (updatedRemaining <= 0) {
          flushUsedSeconds();
          showLockOverlay();
        } else if (ticksSinceSave >= 10) {
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

configAddChangeListener('kidsAccountActive', (evt) => {
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
