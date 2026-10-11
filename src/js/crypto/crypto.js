/**
 * crypto.js — True Zero-Trust E2EE via native Web Crypto API.
 *
 * - AES-GCM 256-bit encryption / decryption.
 * - Room passphrase is taken from, or stored in, the URL hash fragment
 *   (`window.location.hash`), so the key is never sent to any server.
 *   Supported hash formats:
 *     #key=<url-encoded-passphrase>
 *     #key=<pass>&room=<peer-id>        (shareable invite link)
 *     #<url-encoded-passphrase>          (legacy bare fragment)
 * - TextEncoder / TextDecoder for string <-> ArrayBuffer conversion.
 */

const _enc = new TextEncoder();
const _dec = new TextDecoder();

/* ---------- base64 helpers (binary-safe) ---------- */

function bufToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes) {
  return bufToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------- passphrase <-> hash fragment ---------- */

/**
 * Extract the encryption passphrase from window.location.hash, if present.
 * @returns {string|null}
 */
export function getRoomPassphrase() {
  const h = window.location.hash || '';
  if (h.length < 2) return null;
  const frag = h.slice(1); // strip '#'
  // URLSearchParams-style fragment: key=...&room=...
  try {
    const params = new URLSearchParams(frag);
    const k = params.get('key');
    if (k) return k;
  } catch (_) { /* fall through to bare fragment */ }
  if (frag.startsWith('key=')) return decodeURIComponent(frag.slice(4));
  // bare fragment = passphrase itself
  try {
    return decodeURIComponent(frag);
  } catch (_) {
    return frag;
  }
}

/**
 * Extract a prefilled room/host PeerJS id from the hash (#...&room=<id>).
 * @returns {string|null}
 */
export function getRoomIdFromHash() {
  const h = window.location.hash || '';
  if (h.length < 2) return null;
  try {
    const params = new URLSearchParams(h.slice(1));
    const r = params.get('room');
    if (r) return r.trim();
  } catch (_) { /* ignore */ }
  return null;
}

/** Generate a fresh random 256-bit passphrase (base64url, URL-safe). */
export function generatePassphrase() {
  return bytesToBase64Url(window.crypto.getRandomValues(new Uint8Array(32)));
}

/** Persist the passphrase into the URL hash without reloading the page. */
export function setRoomPassphrase(passphrase, roomId = null) {
  const frag = roomId
    ? `key=${encodeURIComponent(passphrase)}&room=${encodeURIComponent(roomId)}`
    : `key=${encodeURIComponent(passphrase)}`;
  if (window.location.hash !== `#${frag}`) {
    window.location.hash = frag;
  }
}

/**
 * Derive a non-extractable AES-GCM 256-bit CryptoKey from a passphrase.
 * SHA-256(passphrase) is used as the raw key material.
 */
export async function deriveKeyFromPassphrase(passphrase) {
  const digest = await window.crypto.subtle.digest('SHA-256', _enc.encode(passphrase));
  return window.crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// Cached so we only derive once per page load.
let _cachedKey = null;
let _cachedPassphrase = null;

/**
 * Get the room's CryptoKey, generating + storing a passphrase in the URL
 * hash fragment if none exists yet.
 * @returns {Promise<{ key: CryptoKey, passphrase: string, isNew: boolean }>}
 */
export async function getOrCreateRoomKey() {
  if (_cachedKey) return { key: _cachedKey, passphrase: _cachedPassphrase, isNew: false };
  let passphrase = getRoomPassphrase();
  let isNew = false;
  if (!passphrase) {
    passphrase = generatePassphrase();
    setRoomPassphrase(passphrase);
    isNew = true;
  }
  const key = await deriveKeyFromPassphrase(passphrase);
  _cachedKey = key;
  _cachedPassphrase = passphrase;
  return { key, passphrase, isNew };
}

/** Forget the cached key (used on leave/room switch). */
export function clearCachedKey() {
  _cachedKey = null;
  _cachedPassphrase = null;
}

/* ---------- message encryption ---------- */

/**
 * Encrypt a plaintext chat message.
 * @param {string} text
 * @param {CryptoKey} key
 * @returns {Promise<{ iv: string, data: string }>} base64-encoded envelope
 */
export async function encryptMessage(text, key) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12)); // 96-bit nonce
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, _enc.encode(text));
  return { iv: bufToB64(iv), data: bufToB64(ct) };
}

/**
 * Decrypt an envelope produced by encryptMessage().
 * @param {{ iv: string, data: string }} encryptedObj
 * @param {CryptoKey} key
 * @returns {Promise<string>} plaintext
 */
export async function decryptMessage(encryptedObj, key) {
  if (!encryptedObj || typeof encryptedObj.iv !== 'string' || typeof encryptedObj.data !== 'string') {
    throw new Error('Malformed encrypted payload');
  }
  const iv = b64ToBytes(encryptedObj.iv);
  const data = b64ToBytes(encryptedObj.data);
  const pt = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return _dec.decode(pt);
}

/**
 * Build a shareable invite link containing both the room id and the
 * encryption key fragment, so a guest joins with the correct key.
 */
export function buildInviteLink(roomId, passphrase) {
  const base = window.location.href.split('#')[0];
  return `${base}#key=${encodeURIComponent(passphrase)}&room=${encodeURIComponent(roomId)}`;
}
