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
  if (frag.includes('=')) {
    // Param-style fragment: key=...&room=...&pw=...
    // An empty key= is treated as missing (never as a passphrase).
    try {
      return new URLSearchParams(frag).get('key') || null;
    } catch (_) {
      return null;
    }
  }
  // Bare fragment = passphrase itself.
  try {
    return decodeURIComponent(frag) || null;
  } catch (_) {
    return frag || null;
  }
}

/** Remove room credentials from the URL (call on leave/room switch). */
export function clearRoomHash() {
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch (_) {
    try { window.location.hash = ''; } catch (_) {}
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
 * Build a shareable invite link containing the room id + encryption key,
 * and optionally the room password (off by default — fragment stays client-side).
 */
export function buildInviteLink(roomId, passphrase, password = null) {
  const base = window.location.href.split('#')[0];
  let frag = `key=${encodeURIComponent(passphrase)}&room=${encodeURIComponent(roomId)}`;
  if (password) frag += `&pw=${encodeURIComponent(password)}`;
  return `${base}#${frag}`;
}

/* ---------- room password (access gate, never sent in clear) ---------- */

/** SHA-256 hex digest helper. */
export async function sha256Hex(str) {
  const digest = await window.crypto.subtle.digest('SHA-256', _enc.encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One-way verifier for a room password. Salt = original room/host id.
 * The guest sends this hash; the plaintext password never leaves their device
 * (except inside the URL fragment if the host opts into link sharing).
 */
export function passwordVerifier(password, salt) {
  return sha256Hex(`${salt}::${password}`);
}

/** Length-sensitive comparison to avoid trivial timing leaks. */
export function verifiersEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extract a shared room password from the invite hash (#...&pw=<pw>). */
export function getRoomPasswordFromHash() {
  const h = window.location.hash || '';
  if (h.length < 2) return null;
  try {
    const pw = new URLSearchParams(h.slice(1)).get('pw');
    return pw || null;
  } catch (_) {
    return null;
  }
}
