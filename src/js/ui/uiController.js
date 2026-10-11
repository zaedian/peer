/**
 * uiController.js — All DOM manipulation and render logic.
 * No PeerJS / crypto / networking code lives here.
 */

export function escapeHTML(str) {
  return String(str).replace(
    /[&<>'"]/g,
    (tag) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag),
  );
}

function el(id) {
  return document.getElementById(id);
}

/** Escape for use inside a double-quoted HTML attribute. */
function escAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Deterministic hue per name for avatars. */
function nameHue(name) {
  let h = 0;
  const s = String(name || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function avatarHTML(name, cls = 'avatar') {
  const initial = (String(name || '?').trim()[0] || '?').toUpperCase();
  return `<span class="${cls}" style="--h:${nameHue(name)}" aria-hidden="true">${escapeHTML(initial)}</span>`;
}

const STATUS_DOT = {
  'text-emerald-400': '#34d399',
  'text-amber-400': '#fbbf24',
  'text-red-400': '#f87171',
};

export function setStatus(text, color = 'text-slate-400') {
  const node = el('connection-status');
  if (node) {
    node.className = color;
    node.innerText = text;
  }
  const dot = el('status-dot');
  if (dot) {
    dot.style.background = STATUS_DOT[color] || '#5b6b84';
    dot.classList.toggle('live', color === 'text-emerald-400' || color === 'text-amber-400');
  }
}

export function setRoleBadge(isHost) {
  const node = el('role-badge');
  if (!node) return;
  node.innerText = isHost ? 'HOST' : 'GUEST';
  node.className = `role-badge ${isHost ? 'host' : 'guest'}`;
}

export function setE2EEStatus(mode, detail = '') {
  // mode: 'on' | 'off' | 'error'
  const node = el('e2ee-status');
  if (!node) return;
  if (mode === 'on') {
    node.className = 'e2ee on';
    node.innerText = `🔒 E2EE on (AES-GCM-256)${detail ? ` — ${detail}` : ''}`;
  } else if (mode === 'error') {
    node.className = 'e2ee err';
    node.innerText = `⚠️ E2EE error${detail ? `: ${detail}` : ''}`;
  } else {
    node.className = 'e2ee off';
    node.innerText = '🔓 E2EE off';
  }
}

export function showChatScreen(roomCode) {
  el('display-room-code').value = roomCode;
  el('setup-screen').classList.add('hidden');
  el('chat-screen').classList.remove('hidden');
}

export function showSetupScreen() {
  el('chat-screen').classList.add('hidden');
  el('setup-screen').classList.remove('hidden');
}

/* ---------- peer list ---------- */

function peerRowHTML(username, kickBtn) {
  return (
    `${avatarHTML(username, 'peer-avatar')}` +
    `<span class="nm">${escapeHTML(username)}</span>` +
    (kickBtn || '')
  );
}

// Host-side render (kick buttons visible for guests).
export function updatePeerListUI(connections, isHost) {
  const listEl = el('peer-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  let count = 0;
  for (const peerId in connections) {
    count++;
    const user = connections[peerId];
    const li = document.createElement('li');
    li.className = 'peer-row';
    const kick = isHost && !user.isHost
      ? `<button data-kick="${escAttr(peerId)}" aria-label="Kick ${escapeHTML(user.username)}" class="kick-btn">Kick</button>`
      : '';
    li.innerHTML = peerRowHTML(user.username, kick);
    listEl.appendChild(li);
  }
  el('user-count').innerText = String(count);
}

// Client-side render from the roster broadcast by the host.
export function updateClientPeerListUI(users) {
  const listEl = el('peer-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  el('user-count').innerText = String(users.length);
  users.forEach((user) => {
    const li = document.createElement('li');
    li.className = 'peer-row';
    li.innerHTML = peerRowHTML(user.username + (user.isHost ? ' 👑' : ''));
    listEl.appendChild(li);
  });
}

/* ---------- messages ---------- */

export function appendChatMessage(sender, text, isSelf, timeStr = formatTime()) {
  const container = el('chat-messages');
  if (!container) return;
  const row = document.createElement('div');
  row.className = `msg-row ${isSelf ? 'self' : 'other'}`;
  row.innerHTML =
    (!isSelf ? avatarHTML(sender) : '') +
    `<div class="msg-body">
      <span class="msg-meta">${escapeHTML(sender)} · ${escapeHTML(timeStr)}</span>
      <div class="bubble">${escapeHTML(text)}</div>
    </div>`;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

export function appendSystemMessage(text) {
  const container = el('chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.innerHTML = `<span class="sys-pill">${escapeHTML(text)}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

/* ---------- form helpers ---------- */

export function getUsernameInput() {
  return (el('username-input').value || '').trim();
}

export function getRoomCodeInput() {
  return (el('room-code-input').value || '').trim();
}

export function setRoomCodeInput(v) {
  el('room-code-input').value = v;
}

export function getPasswordInput() {
  return (el('room-password-input').value || '').trim();
}

export function setPasswordInput(v) {
  el('room-password-input').value = v;
}

export function getIncludePwChecked() {
  return !!el('include-pw-checkbox')?.checked;
}

export function setLockStatus(locked) {
  const node = el('room-lock-status');
  if (!node) return;
  node.innerText = locked ? '🔑 Locked (password required)' : '🔓 Open room';
  node.className = `lockstat ${locked ? 'on' : 'off'}`;
}

export function getMessageText() {
  return (el('message-input').value || '').trim();
}

export function clearMessageInput() {
  el('message-input').value = '';
}

export function focusUsername() {
  el('username-input')?.focus();
}

export function focusMessageInput() {
  el('message-input')?.focus();
}
