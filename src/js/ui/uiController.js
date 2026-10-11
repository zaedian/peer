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

export function setStatus(text, color = 'text-slate-400') {
  const node = el('connection-status');
  if (!node) return;
  node.className = `text-xs mt-1 ${color}`;
  node.innerText = text;
}

export function setRoleBadge(isHost) {
  const node = el('role-badge');
  if (!node) return;
  node.innerText = isHost ? 'HOST' : 'GUEST';
  node.className = isHost
    ? 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
    : 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-600/20 text-cyan-300 border border-cyan-500/40';
}

export function setE2EEStatus(mode, detail = '') {
  // mode: 'on' | 'off' | 'error'
  const node = el('e2ee-status');
  if (!node) return;
  if (mode === 'on') {
    node.className = 'text-[11px] text-emerald-400';
    node.innerText = `🔒 E2EE on (AES-GCM-256)${detail ? ` — ${detail}` : ''}`;
  } else if (mode === 'error') {
    node.className = 'text-[11px] text-red-400';
    node.innerText = `⚠️ E2EE error${detail ? `: ${detail}` : ''}`;
  } else {
    node.className = 'text-[11px] text-slate-500';
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
    `<span class="truncate font-medium">${escapeHTML(username)}</span>` +
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
    li.className =
      'flex items-center justify-between text-xs py-1 px-2 rounded bg-slate-900 border border-slate-800/80';
    const kick = isHost && !user.isHost
      ? `<button data-kick="${escAttr(peerId)}" aria-label="Kick ${escapeHTML(user.username)}" class="text-red-400 hover:text-red-300 ml-2 font-bold px-1.5 py-0.5 rounded bg-red-950/50">Kick</button>`
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
    li.className =
      'flex items-center justify-between text-xs py-1 px-2 rounded bg-slate-900 border border-slate-800/80';
    li.innerHTML = peerRowHTML(user.username + (user.isHost ? ' 👑' : ''));
    listEl.appendChild(li);
  });
}

/* ---------- messages ---------- */

export function appendChatMessage(sender, text, isSelf, timeStr = formatTime()) {
  const container = el('chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `flex flex-col ${isSelf ? 'items-end' : 'items-start'}`;
  div.innerHTML = `
    <span class="text-[10px] text-slate-400 mb-0.5 px-1">${escapeHTML(sender)} · ${escapeHTML(timeStr)}</span>
    <div class="max-w-[85%] px-3.5 py-2 rounded-2xl text-sm ${isSelf ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-100 rounded-bl-none'} break-words">${escapeHTML(text)}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

export function appendSystemMessage(text) {
  const container = el('chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'text-center my-1';
  div.innerHTML = `<span class="text-[11px] bg-slate-950/80 text-slate-400 border border-slate-800/60 px-3 py-1 rounded-full">${escapeHTML(text)}</span>`;
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
  node.className = locked
    ? 'text-[11px] text-amber-300'
    : 'text-[11px] text-slate-500';
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
