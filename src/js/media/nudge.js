/**
 * nudge.js — attention buzzer + incoming-call ringer.
 * Morse-style beeps via Web Audio (rapid nudges pile up like code),
 * plus vibration on phones. No permissions needed (unlike mic/camera).
 */

let _ctx = null;

function ac() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!_ctx) {
    try { _ctx = new AC(); } catch (_) { return null; }
  }
  if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
  return _ctx;
}

// Browsers require a user gesture before audio: unlock on first touch/click.
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => ac(), { passive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function beep(freq = 880, dur = 0.12, vol = 0.22, when = 0) {
  const ctx = ac();
  if (!ctx) return;
  try {
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    gain.gain.setValueAtTime(vol, t + Math.max(0.015, dur - 0.03));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  } catch (_) { /* audio unavailable */ }
}

function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch (_) {}
}

// Serialize rapid nudges so they sound like morse, not noise.
let _chain = Promise.resolve();

/**
 * Play a nudge: `...` beeps. Each call queues behind the last.
 * @param {number} [count=3]
 */
export function playNudge(count = 3) {
  _chain = _chain.then(async () => {
    buzz([130, 70, 130, 70, 130]);
    for (let i = 0; i < count; i++) {
      beep(880, 0.12);
      await sleep(210);
    }
  }).catch(() => {});
  return _chain;
}

/* ---------- incoming-call ringer ---------- */

let _ringTimer = null;

/** Loop a two-tone ring until stopRing(). */
export function startRing() {
  stopRing();
  buzz([300, 200, 300]);
  beep(660, 0.18);
  setTimeout(() => beep(520, 0.22), 240);
  _ringTimer = setInterval(() => {
    beep(660, 0.18);
    setTimeout(() => beep(520, 0.22), 240);
    buzz([300, 200, 300]);
  }, 1600);
}

export function stopRing() {
  if (_ringTimer) clearInterval(_ringTimer);
  _ringTimer = null;
  try { navigator.vibrate?.(0); } catch (_) {}
}
