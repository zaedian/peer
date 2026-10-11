/**
 * silentAudio.js — Mobile background heartbeat / keep-alive workaround.
 *
 * Mobile browsers (Android Chrome, iOS Safari) throttle or freeze the JS
 * event loop when a tab is backgrounded, which kills PeerJS heartbeats and
 * breaks host-failover detection. Playing (near-)silent audio keeps the
 * page's audio pipeline — and therefore its JS thread — alive longer.
 *
 * Implementation: Web Audio API oscillator -> gain(0.001) -> destination.
 * The gain is effectively inaudible but non-zero so the OS treats audio as
 * active. Must be started from a user gesture (join/create click).
 */

let _ctx = null;
let _osc = null;
let _gain = null;
let _active = false;

function _onVisibilityChange() {
  // iOS/Chrome may suspend the context when hidden; resume it.
  if (_ctx && _ctx.state === 'suspended') {
    _ctx.resume().catch(() => {});
  }
}

/**
 * Start the silent audio loop.
 * @returns {boolean} true if keep-alive is active.
 */
export function enableMobileKeepAlive() {
  if (_active && _ctx) {
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    return true;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    _ctx = new AC();
    _osc = _ctx.createOscillator();
    _gain = _ctx.createGain();
    _gain.gain.value = 0.001; // effectively silent, but keeps audio pipeline alive
    _osc.frequency.value = 440;
    _osc.type = 'sine';
    _osc.connect(_gain);
    _gain.connect(_ctx.destination);
    _osc.start();
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    document.addEventListener('visibilitychange', _onVisibilityChange);
    _active = true;
    return true;
  } catch (_) {
    _active = false;
    return false;
  }
}

/** Stop the silent audio loop and release resources. */
export function disableMobileKeepAlive() {
  document.removeEventListener('visibilitychange', _onVisibilityChange);
  try {
    if (_osc) {
      _osc.stop();
      _osc.disconnect();
    }
  } catch (_) { /* already stopped */ }
  try {
    if (_gain) _gain.disconnect();
  } catch (_) { /* ignore */ }
  try {
    if (_ctx) _ctx.close().catch(() => {});
  } catch (_) { /* ignore */ }
  _ctx = null;
  _osc = null;
  _gain = null;
  _active = false;
}

/** @returns {boolean} */
export function isKeepAliveActive() {
  return _active;
}
