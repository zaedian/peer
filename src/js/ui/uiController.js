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

// Live call/presence state (no networking here — app.js drives these).
const mutedPeers = new Set(); // peerId -> muted
let inCallPeerId = '';
let callBusy = false;
let activeCallIsVoice = false;

/** Mark a peer muted/unmuted; badge survives future re-renders. */
export function setPeerMuted(peerId, muted) {
  if (!peerId) return;
  if (muted) mutedPeers.add(peerId);
  else mutedPeers.delete(peerId);
  const sel = `[data-mute-tag="${String(peerId).replace(/"/g, '')}"]`;
  document.querySelectorAll(sel).forEach((badge) => {
    badge.classList.toggle('hidden', !muted);
  });
}

/** Highlight the peer currently in-call; '' clears. Disables other call buttons. */
export function setCallBusy(busy, peerId = '', isVoiceCall = false) {
  callBusy = !!busy;
  inCallPeerId = peerId || '';
  activeCallIsVoice = !!isVoiceCall && !!busy;
  document.querySelectorAll('[data-call-audio],[data-call-video]').forEach((btn) => {
    const id = btn.getAttribute('data-call-audio') || btn.getAttribute('data-call-video') || '';
    const isActivePeer = id && id === inCallPeerId;
    const isVideoBtn = btn.hasAttribute('data-call-video');
    // While busy: only the active peer's video button stays enabled (as a
    // video-upgrade request when the active call is voice-only).
    const allow = !callBusy || (isActivePeer && isVideoBtn && activeCallIsVoice);
    btn.disabled = !allow;
    btn.classList.toggle('btn-disabled', !allow);
    if (isActivePeer && isVideoBtn && activeCallIsVoice) {
      btn.title = 'Request video upgrade';
      btn.setAttribute('aria-label', 'Request video upgrade');
      btn.classList.add('upgrade-pulse');
    } else {
      btn.classList.remove('upgrade-pulse');
    }
  });
  document.querySelectorAll('[data-incall-pill]').forEach((pill) => {
    const rowId = pill.closest('[data-peer-row]')?.getAttribute('data-peer-row') || '';
    pill.classList.toggle('hidden', rowId !== inCallPeerId || !inCallPeerId);
  });
}

function peerRowHTML(username, buttons, peerId = '', isSelf = false) {
  const muted = peerId && mutedPeers.has(peerId);
  const inCall = peerId && peerId === inCallPeerId;
  return (
    `${avatarHTML(username, 'peer-avatar')}` +
    `<span class="nm">${escapeHTML(username)}</span>` +
    `<span data-mute-tag="${escAttr(peerId)}" class="mute-tag${muted ? '' : ' hidden'}" title="Muted">🔇</span>` +
    `<span data-incall-pill class="incall-pill${inCall ? '' : ' hidden'}" title="In call">In call</span>` +
    (buttons || '')
  );
}

/** Per-peer action buttons (call / video / file / nudge). None for your own row. */
function peerActionsHTML(peerId, username, isSelf, allowCalls = true) {
  if (isSelf) return '';
  const nm = escapeHTML(username);
  const nudge = `<button data-nudge="${escAttr(peerId)}" title="Nudge ${nm}" aria-label="Nudge ${nm}" class="icon-btn">🔔</button>`;
  const file = `<button data-file="${escAttr(peerId)}" title="Send file to ${nm}" aria-label="Send file to ${nm}" class="icon-btn">📁</button>`;
  if (!allowCalls || !peerId) return `<span class="peer-actions">${file}${nudge}</span>`;
  const id = escAttr(peerId);
  const isActivePeer = peerId === inCallPeerId;
  const dis = (isVideo) => {
    // Active peer's video button stays live as upgrade; everything else locks while busy.
    if (!callBusy) return '';
    if (isActivePeer && isVideo && activeCallIsVoice) return '';
    return ' disabled';
  };
  return `<span class="peer-actions">` +
    `<button data-call-audio="${id}" title="Voice call ${nm}" aria-label="Voice call ${nm}" class="icon-btn"${dis(false)}>📞</button>` +
    `<button data-call-video="${id}" title="${isActivePeer && activeCallIsVoice ? 'Request video upgrade' : `Video call ${nm}`}" aria-label="${isActivePeer && activeCallIsVoice ? 'Request video upgrade' : `Video call ${nm}`}" class="icon-btn${isActivePeer && activeCallIsVoice ? ' upgrade-pulse' : ''}"${dis(true)}>🎥</button>` +
    file +
    nudge +
    `</span>`;
}

// Host-side render (kick buttons visible for guests).
export function updatePeerListUI(connections, isHost, myId = '') {
  const listEl = el('peer-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  let count = 0;
  for (const peerId in connections) {
    count++;
    const user = connections[peerId];
    const self = peerId === myId;
    const li = document.createElement('li');
    li.className = 'peer-row';
    li.setAttribute('data-peer-row', peerId);
    const kick = isHost && !user.isHost
      ? `<button data-kick="${escAttr(peerId)}" aria-label="Kick ${escapeHTML(user.username)}" class="kick-btn">Kick</button>`
      : '';
    li.innerHTML = peerRowHTML(user.username, peerActionsHTML(peerId, user.username, self) + kick, peerId, self);
    listEl.appendChild(li);
  }
  el('user-count').innerText = String(count);
}

// Client-side render from the roster broadcast by the host.
export function updateClientPeerListUI(users, myId = '') {
  const listEl = el('peer-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  el('user-count').innerText = String(users.length);
  users.forEach((user) => {
    const hasId = typeof user.id === 'string' && user.id.length > 0;
    const uid = hasId ? user.id : '';
    const li = document.createElement('li');
    li.className = 'peer-row';
    if (uid) li.setAttribute('data-peer-row', uid);
    li.innerHTML = peerRowHTML(
      user.username + (user.isHost ? ' 👑' : ''),
      peerActionsHTML(uid, user.username, uid === myId, hasId),
      uid,
      uid === myId,
    );
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
  const joinOpen = el('join-form') && !el('join-form').classList.contains('hidden');
  const primary = joinOpen ? el('username-input') : el('create-username-input');
  const fallback = joinOpen ? el('create-username-input') : el('username-input');
  return ((primary?.value || fallback?.value) || '').trim();
}

export function setUsernameInput(v) {
  if (el('username-input')) el('username-input').value = v;
  if (el('create-username-input')) el('create-username-input').value = v;
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
  const joinOpen = el('join-form') && !el('join-form').classList.contains('hidden');
  const target = joinOpen ? el('username-input') : (el('create-username-input') || el('username-input'));
  target?.focus();
}

export function focusMessageInput() {
  el('message-input')?.focus();
}

/* ---------- voice/video call overlay ---------- */

let _callPeerName = 'Peer';

export function showCallOverlay(peerName, video) {
  _callPeerName = peerName || 'Peer';
  el('call-overlay')?.classList.remove('hidden');
  const nm = el('call-peer-name');
  if (nm) nm.innerText = _callPeerName;
  const rn = el('remote-name');
  if (rn) rn.innerText = _callPeerName;
  el('call-stage')?.classList.toggle('hidden', !video);
  el('call-avatar') && (el('call-avatar').innerHTML = avatarHTML(_callPeerName, 'avatar big'));
  el('remote-avatar') && (el('remote-avatar').innerHTML = avatarHTML(_callPeerName, 'avatar big'));
  el('voice-only')?.classList.toggle('hidden', video);
  el('switch-btn')?.classList.toggle('hidden', !video);
  setRemoteMute(false);
  setRemoteCameraOff(false);
  setCallStatus(video ? 'Video call' : 'Voice call');
  setMuteUI(false);
  setCameraUI(false);
  setCameraUpgradeMode(!video);
}

export function hideCallOverlay() {
  el('call-overlay')?.classList.add('hidden');
  attachLocalStream(null);
  attachRemoteStream(null);
}

export function setCallStatus(text) {
  const node = el('call-status');
  if (node) node.innerText = text;
}

export function attachLocalStream(stream) {
  const v = el('local-video');
  if (v) v.srcObject = stream || null;
}

export function attachRemoteStream(stream) {
  const v = el('remote-video');
  if (v) {
    v.srcObject = stream || null;
    if (stream) v.play().catch(() => {});
  }
}

export function setMuteUI(muted) {
  const b = el('mute-btn');
  if (b) {
    b.innerText = muted ? '🔇' : '🎙️';
    b.setAttribute('aria-pressed', String(muted));
  }
}

export function setCameraUI(off) {
  const b = el('camera-btn');
  if (b) {
    b.innerText = off ? '🚫' : '📷';
    b.setAttribute('aria-pressed', String(off));
  }
}

/** Remote peer muted/unmuted (via call-mute signal). Mirrors to the peer list. */
export function setRemoteMute(muted) {
  el('remote-mic-badge')?.classList.toggle('hidden', !muted);
  if (inCallPeerId) setPeerMuted(inCallPeerId, muted);
}

/** Voice-call camera button becomes a "request video" upgrade affordance. */
export function setCameraUpgradeMode(isVoiceCall) {
  const b = el('camera-btn');
  if (!b) return;
  if (isVoiceCall) {
    b.innerText = '🎥';
    b.title = 'Request video upgrade';
    b.setAttribute('aria-label', 'Request video upgrade');
    b.classList.add('upgrade-pulse');
  } else {
    b.classList.remove('upgrade-pulse');
    b.innerText = b.getAttribute('aria-pressed') === 'true' ? '🚫' : '📷';
    b.title = '';
    b.setAttribute('aria-label', b.getAttribute('aria-pressed') === 'true' ? 'Turn camera on' : 'Turn camera off');
  }
}

/** Remote camera on/off (via call-camera signal): avatar fallback tile. */
export function setRemoteCameraOff(off) {
  el('remote-video')?.classList.toggle('hidden', off);
  el('remote-fallback')?.classList.toggle('hidden', !off);
}

export function showIncoming(username, video) {
  const box = el('incoming-call');
  box?.classList.remove('hidden');
  box?.classList.toggle('video', !!video);
  box?.classList.toggle('voice', !video);
  const icon = el('incoming-icon');
  if (icon) icon.innerText = video ? '🎥' : '🎙️';
  const kind = el('incoming-kind');
  if (kind) {
    kind.innerText = video ? 'Video request' : 'Voice request';
    kind.className = `incoming-kind${video ? ' video' : ''}`;
  }
  const t = el('incoming-text');
  if (t) t.innerText = `${username} wants a ${video ? 'video' : 'voice'} call…`;
  el('accept-btn')?.focus();
}

export function hideIncoming() {
  el('incoming-call')?.classList.add('hidden');
}

/* ---------- video upgrade prompt (voice → video mid-call) ---------- */

export function showUpgradePrompt(username) {
  el('upgrade-prompt')?.classList.remove('hidden');
  const t = el('upgrade-text');
  if (t) t.innerText = `${username} wants to switch to video…`;
  el('upgrade-accept-btn')?.focus();
}

export function hideUpgradePrompt() {
  el('upgrade-prompt')?.classList.add('hidden');
}

/* ---------- invite-link lobby mode ---------- */

let _inviteMode = false;

export function isInviteMode() {
  return _inviteMode;
}

/**
 * Lobby step: 'choice' (join vs create) | 'join' (name + code) | 'create' (name + options).
 */
export function showLobbyView(which) {
  el('lobby-choice')?.classList.toggle('hidden', which !== 'choice');
  el('join-form')?.classList.toggle('hidden', which !== 'join');
  el('create-form')?.classList.toggle('hidden', which !== 'create');
  if (which === 'join' || which === 'create') {
    setTimeout(() => focusUsername(), 50);
  }
}

/**
 * Invite-link mode: guests land straight on the join step with the code
 * prefilled, so it's just name + Accept Invite.
 */
export function enterInviteMode(roomId) {
  _inviteMode = true;
  showLobbyView('join');
  el('invite-banner')?.classList.remove('hidden');
  const chip = el('invite-room-chip');
  if (chip && roomId) chip.innerText = String(roomId).slice(0, 12) + (String(roomId).length > 12 ? '…' : '');
  el('manual-code-wrap')?.classList.add('hidden');
  const join = el('join-room-btn');
  if (join) join.innerText = 'Accept Invite ✓';
  el('show-manual-btn')?.classList.remove('hidden');
  el('join-back-btn')?.classList.add('hidden');
  // The room code is fixed by the link — keep it out of the way.
  const code = el('room-code-input');
  if (code && roomId) {
    code.value = roomId;
    code.setAttribute('readonly', '');
  }
  el('username-input')?.focus();
}

/** Back to the manual join step (same view, code field revealed). */
export function exitInviteMode() {
  _inviteMode = false;
  el('invite-banner')?.classList.add('hidden');
  el('manual-code-wrap')?.classList.remove('hidden');
  const join = el('join-room-btn');
  if (join) join.innerText = 'Join →';
  el('show-manual-btn')?.classList.add('hidden');
  el('join-back-btn')?.classList.remove('hidden');
  el('room-code-input')?.removeAttribute('readonly');
}

/* ---------- toast (quiet confirmations, not chat noise) ---------- */

let _toastTimer = null;

export function showToast(text) {
  const t = el('toast');
  if (!t) return;
  t.innerText = String(text || '');
  t.classList.remove('hidden');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ---------- emoji picker (dependency-free) ---------- */

const EMOJIS = ['😀','😁','😂','🤣','😊','😍','😎','🤔','😅','😭','😡','👍','👎','👏','🙏','👋','🔥','🎉','❤️','💯','✨','😴','🤯','🥳','😇','🙄','🤝','👀','💡','🚀','🍕','☕','⚽','🎮','🌙','☀️','🍀','💩','🤖','👻','💔','😱','🤠','🥲','🫡','✅','❌'];

export function renderEmojiPanel() {
  const p = el('emoji-panel');
  if (!p || p.dataset.built) return;
  p.dataset.built = '1';
  p.innerHTML = EMOJIS.map((e) => `<button type="button" data-emoji="${e}" class="emoji-cell" aria-label="Insert ${e}">${e}</button>`).join('');
}

export function toggleEmojiPanel(force) {
  const p = el('emoji-panel');
  const b = el('emoji-btn');
  if (!p) return false;
  renderEmojiPanel();
  const show = typeof force === 'boolean' ? force : p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  b?.setAttribute('aria-expanded', String(show));
  return show;
}

export function insertEmojiAtCursor(emoji) {
  const input = el('message-input');
  if (!input) return;
  const s = input.selectionStart ?? input.value.length;
  const e = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, s) + emoji + input.value.slice(e);
  try {
    const pos = s + emoji.length;
    input.setSelectionRange(pos, pos);
  } catch (_) {}
  input.focus();
}

/* ---------- file sharing cards (WhatsApp-style accept / deny) ---------- */

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

function fileIconFor(mime) {
  const m = String(mime || '');
  if (m.startsWith('image/')) return '🖼️';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎵';
  if (m.includes('pdf')) return '📕';
  if (m.includes('zip') || m.includes('rar') || m.includes('tar')) return '🗜️';
  return '📄';
}

function scrollChat() {
  const c = el('chat-messages');
  if (c) c.scrollTop = c.scrollHeight;
}

/** Incoming offer with Accept / Decline. Container id: file-<fileId>. */
export function appendFileOffer({ fileId, sender, name, size, mime, timeStr = formatTime() }) {
  const container = el('chat-messages');
  if (!container || !fileId) return;
  const row = document.createElement('div');
  row.className = 'msg-row other';
  row.id = `file-${CSSSafe(fileId)}`;
  row.innerHTML =
    avatarHTML(sender) +
    `<div class="msg-body">
      <span class="msg-meta">${escapeHTML(sender)} · ${escapeHTML(timeStr)}</span>
      <div class="bubble file-card">
        <div class="file-head"><span class="file-icon" aria-hidden="true">${fileIconFor(mime)}</span>
          <div class="file-meta"><span class="file-name">${escapeHTML(name)}</span>
          <span class="file-size">${escapeHTML(formatBytes(size))}</span></div></div>
        <p class="file-hint">Wants to send you this file</p>
        <div class="file-actions">
          <button type="button" data-file-decline="${escAttr(fileId)}" class="file-btn decline">Decline</button>
          <button type="button" data-file-accept="${escAttr(fileId)}" class="file-btn accept">Accept ✓</button>
        </div>
        <div class="file-prog hidden"><div class="file-bar"></div></div>
      </div>
    </div>`;
  container.appendChild(row);
  scrollChat();
}

/** Outgoing offer state (waiting / sending progress). */
export function appendFileOutgoing({ fileId, name, size, mime, toName, timeStr = formatTime() }) {
  const container = el('chat-messages');
  if (!container || !fileId) return;
  const row = document.createElement('div');
  row.className = 'msg-row self';
  row.id = `file-${CSSSafe(fileId)}`;
  row.innerHTML =
    `<div class="msg-body">
      <span class="msg-meta">You → ${escapeHTML(toName || 'peer')} · ${escapeHTML(timeStr)}</span>
      <div class="bubble file-card">
        <div class="file-head"><span class="file-icon" aria-hidden="true">${fileIconFor(mime)}</span>
          <div class="file-meta"><span class="file-name">${escapeHTML(name)}</span>
          <span class="file-size">${escapeHTML(formatBytes(size))}</span></div></div>
        <p class="file-hint" data-file-status>Waiting for them to accept…</p>
        <div class="file-prog hidden"><div class="file-bar"></div></div>
      </div>
    </div>`;
  container.appendChild(row);
  scrollChat();
}

export function setFileProgress(fileId, pct, statusText) {
  const card = document.getElementById(`file-${CSSSafe(fileId)}`);
  if (!card) return;
  const wrap = card.querySelector('.file-prog');
  const bar = card.querySelector('.file-bar');
  if (wrap) wrap.classList.remove('hidden');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
  const hint = card.querySelector('[data-file-status]') || card.querySelector('.file-hint');
  if (hint && statusText) hint.innerText = statusText;
}

function CSSSafe(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '');
}

export function resolveFileOffer(fileId, accepted) {
  const card = document.getElementById(`file-${CSSSafe(fileId)}`);
  if (!card) return;
  card.querySelector('.file-actions')?.remove();
  let hint = card.querySelector('.file-hint');
  if (hint) hint.innerText = accepted ? 'Accepted — receiving…' : 'Declined.';
}

export function completeFileCard({ fileId, url, name, size, mime, sender, isSelf, timeStr = formatTime() }) {
  let card = document.getElementById(`file-${CSSSafe(fileId)}`);
  const isImage = String(mime || '').startsWith('image/');
  const inner =
    `<div class="file-head"><span class="file-icon" aria-hidden="true">${fileIconFor(mime)}</span>
      <div class="file-meta"><span class="file-name">${escapeHTML(name)}</span>
      <span class="file-size">${escapeHTML(formatBytes(size))}</span></div></div>` +
    (isImage ? `<a href="${escAttr(url)}" download="${escAttr(name)}"><img src="${escAttr(url)}" alt="${escAttr(name)}" class="file-img" loading="lazy"></a>` : '') +
    `<a href="${escAttr(url)}" download="${escAttr(name)}" class="file-dl">⬇ Download</a>`;
  if (card) {
    const bubble = card.querySelector('.bubble');
    if (bubble) bubble.innerHTML = inner;
    const hint = card.querySelector('.file-hint');
    if (hint) hint.remove();
    card.querySelector('.file-prog')?.remove();
    card.querySelector('.file-actions')?.remove();
  } else {
    const container = el('chat-messages');
    if (!container) return;
    const row = document.createElement('div');
    row.className = `msg-row ${isSelf ? 'self' : 'other'}`;
    row.id = `file-${CSSSafe(fileId)}`;
    row.innerHTML =
      (isSelf ? '' : avatarHTML(sender)) +
      `<div class="msg-body">
        <span class="msg-meta">${escapeHTML(isSelf ? 'You' : sender)} · ${escapeHTML(timeStr)}</span>
        <div class="bubble file-card">${inner}</div>
      </div>`;
    container.appendChild(row);
  }
  scrollChat();
}

export function failFileCard(fileId, message) {
  const card = document.getElementById(`file-${CSSSafe(fileId)}`);
  if (!card) return;
  const hint = card.querySelector('.file-hint') || card.querySelector('[data-file-status]');
  if (hint) hint.innerText = message || 'Transfer failed.';
  card.querySelector('.file-actions')?.remove();
}
