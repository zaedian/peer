/**
 * app.js — Entry point / UI event listeners.
 * Wires uiController.js (DOM) <-> peerManager.js (PeerJS + E2EE + mesh).
 */

import { PeerManager } from './network/peerManager.js';
import { buildInviteLink, getRoomIdFromHash, getRoomPasswordFromHash } from './crypto/crypto.js';
import * as ui from './ui/uiController.js';

let manager = null;
let lastRoomCode = '';
let lastPassphrase = '';
let hostPassword = '';
let unreadCount = 0;
const BASE_TITLE = 'P2P Chat Room (Admin Host)';
const HISTORY_CAP = 200;
const LOBBY_STASH_KEY = 'p2pchat-lobby';

function historyKey(room) {
  return `p2pchat-log:${room}`;
}

function loadHistory(room) {
  try {
    const raw = sessionStorage.getItem(historyKey(room));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-HISTORY_CAP) : [];
  } catch (_) {
    return [];
  }
}

function queueHistorySave(room, entry) {
  try {
    const log = loadHistory(room);
    log.push(entry);
    sessionStorage.setItem(historyKey(room), JSON.stringify(log.slice(-HISTORY_CAP)));
  } catch (_) { /* storage unavailable — chat still works */ }
}

function bumpUnread() {
  if (!document.hidden) return;
  unreadCount++;
  document.title = `(${unreadCount}) ${BASE_TITLE}`;
}

function resetUnread() {
  unreadCount = 0;
  document.title = BASE_TITLE;
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    ui.appendSystemMessage(okMsg);
    return;
  } catch (_) { /* fall through to legacy fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    ui.appendSystemMessage(okMsg);
  } catch (_) {
    alert('Copy failed — select and copy manually.');
  }
}

function makeManager() {
  return new PeerManager({
    onStatus: (t, c) => ui.setStatus(t, c),
    onSystemMessage: (t) => ui.appendSystemMessage(t),
    onChatMessage: (sender, text, isSelf) => {
      const time = ui.formatTime();
      ui.appendChatMessage(sender, text, isSelf, time);
      if (lastRoomCode) queueHistorySave(lastRoomCode, { s: sender, t: text, self: isSelf, time });
      if (!isSelf) bumpUnread();
      hideTyping(sender);
    },
    onHostPeerList: (view, isHost) => ui.updatePeerListUI(view, isHost),
    onClientPeerList: (users, locked) => {
      ui.updateClientPeerListUI(users);
      ui.setLockStatus(!!locked);
    },
    onTyping: (username) => showTyping(username),
    onLockChanged: (locked) => ui.setLockStatus(!!locked),
    onDenied: (reason) => {
      alert(reason === 'wrong-password' ? 'Wrong room password.' : 'Join rejected by host.');
      location.reload();
    },
    onRoleChanged: (isHost, hostId) => {
      ui.setRoleBadge(isHost);
      const rc = isHost ? manager.myId : hostId;
      const input = document.getElementById('display-room-code');
      if (input && rc) input.value = rc;
      // After a promotion the invite must point at the NEW host.
      lastRoomCode = rc;
      lastPassphrase = manager.passphrase;
      refreshInviteLink();
    },
    onKeepAlive: () => {},
    onReady: (roomCode, isHost) => {
      lastRoomCode = roomCode;
      lastPassphrase = manager.passphrase;
      try { sessionStorage.removeItem(LOBBY_STASH_KEY); } catch (_) {}
      ui.showChatScreen(roomCode);
      ui.setRoleBadge(isHost);
      ui.setE2EEStatus('on', 'shared room key');
      ui.setLockStatus(isHost ? !!hostPassword : manager.roomLocked);
      refreshInviteLink();
      // Restore this tab's session history (display-only).
      for (const m of loadHistory(roomCode)) {
        ui.appendChatMessage(m.s, m.t, !!m.self, m.time || ui.formatTime());
      }
      ui.focusMessageInput();
    },
    onKicked: () => {
      alert('You have been kicked by the host.');
      location.reload();
    },
    onE2EEError: () => ui.setE2EEStatus('error', 'check invite link'),
  });
}

function refreshInviteLink() {
  const box = document.getElementById('display-invite-link');
  if (!box) return;
  if (manager && !manager.isHost && !manager.hadKeyInUrl) {
    box.value = '';
    box.placeholder = 'Ask the host for the invite link (no key in your URL)';
    return;
  }
  if (lastRoomCode && lastPassphrase) {
    const pw = manager?.isHost && hostPassword && ui.getIncludePwChecked() ? hostPassword : null;
    box.value = buildInviteLink(lastRoomCode, lastPassphrase, pw);
  }
}

/* ---------- typing indicator ---------- */
const typingTimers = new Map();

function showTyping(username) {
  const bar = document.getElementById('typing-indicator');
  if (!bar || !username) return;
  if (typingTimers.has(username)) clearTimeout(typingTimers.get(username));
  typingTimers.set(username, setTimeout(() => hideTyping(username), 4000));
  renderTyping();
}

function hideTyping(username) {
  if (typingTimers.has(username)) {
    clearTimeout(typingTimers.get(username));
    typingTimers.delete(username);
    renderTyping();
  }
}

function renderTyping() {
  const bar = document.getElementById('typing-indicator');
  if (!bar) return;
  const names = [...typingTimers.keys()];
  bar.innerText = names.length ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…` : '';
}

async function onCreateRoom() {
  const name = ui.getUsernameInput();
  if (!name) { alert('Please enter your name first.'); return; }
  hostPassword = ui.getPasswordInput();
  manager = makeManager();
  try {
    await manager.createRoom(name, { password: hostPassword });
  } catch (e) {
    alert('Could not create room: ' + (e?.message || e));
  }
}

async function onJoinRoom() {
  const name = ui.getUsernameInput();
  const code = ui.getRoomCodeInput();
  const pw = ui.getPasswordInput();
  if (!name) { alert('Please enter your name first.'); return; }
  if (!code) { alert('Please enter a valid Room Code.'); return; }
  // Stash the lobby so a wrong-password reload doesn't eat what you typed.
  try { sessionStorage.setItem(LOBBY_STASH_KEY, JSON.stringify({ name, code })); } catch (_) {}
  hostPassword = '';
  manager = makeManager();
  ui.setE2EEStatus('off');
  try {
    await manager.joinRoom(name, code, { password: pw });
    // Room code echo + chat screen happen on host-link open; but if the
    // invite hash carried a room id we already know it — show pending UI.
    lastRoomCode = code;
    manager.cbs.onReady?.(code, false);
    // Correct the badge: we are a guest until a promotion happens.
    ui.setRoleBadge(false);
    if (!manager.hadKeyInUrl) {
      ui.setE2EEStatus('error', 'missing key — get the invite link');
    }
    ui.setStatus('Connecting to Host...', 'text-amber-400');
  } catch (e) {
    alert('Could not join room: ' + (e?.message || e));
  }
}

async function onSendMessage(e) {
  e.preventDefault();
  const text = ui.getMessageText();
  if (!text || !manager) return;
  await manager.sendChatMessage(text);
  ui.clearMessageInput();
  resetUnread();
}

function onCopyRoomCode() {
  const input = document.getElementById('display-room-code');
  copyText(input.value, 'Room Code copied to clipboard!');
}

function onCopyInvite() {
  refreshInviteLink();
  const input = document.getElementById('display-invite-link');
  if (!input || !input.value) { alert('Join a room first.'); return; }
  copyText(input.value, 'Invite link (room + encryption key) copied!');
}

function onLeaveRoom() {
  if (!confirm('Are you sure you want to leave the room?')) return;
  try { manager?.leaveRoom(); } catch (_) {}
  location.reload();
}

function onKickClicked(peerId) {
  manager?.kickUser(peerId);
}

// Legacy inline-onclick compatibility (original index.html used these).
globalThis.createRoom = onCreateRoom;
globalThis.joinRoom = onJoinRoom;
globalThis.sendMessage = onSendMessage;
globalThis.copyRoomCode = onCopyRoomCode;
globalThis.copyInviteLink = onCopyInvite;
globalThis.leaveRoom = onLeaveRoom;
globalThis.kickUser = onKickClicked;

document.addEventListener('DOMContentLoaded', () => {
  if (!globalThis.Peer) {
    ui.setStatus('Failed to load PeerJS (check connection/ad-blocker)', 'text-red-400');
  }
  document.getElementById('create-room-btn')?.addEventListener('click', onCreateRoom);
  document.getElementById('join-room-btn')?.addEventListener('click', onJoinRoom);
  document.getElementById('chat-form')?.addEventListener('submit', onSendMessage);
  document.getElementById('copy-code-btn')?.addEventListener('click', onCopyRoomCode);
  document.getElementById('copy-invite-btn')?.addEventListener('click', onCopyInvite);
  document.getElementById('leave-room-btn')?.addEventListener('click', onLeaveRoom);

  // Kick buttons are rendered dynamically — one delegated listener.
  document.getElementById('peer-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kick]');
    if (btn) onKickClicked(btn.getAttribute('data-kick'));
  });

  // Enter anywhere in the lobby: join if a room code is filled, else create.
  document.getElementById('setup-screen')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (ui.getRoomCodeInput()) onJoinRoom();
    else onCreateRoom();
  });

  document.getElementById('message-input')?.addEventListener('focus', resetUnread);
  document.getElementById('message-input')?.addEventListener('input', () => {
    try { manager?.sendTyping(); } catch (_) {}
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resetUnread();
  });

  // Prefill room code + password from invite link hash (#key=...&room=<id>&pw=<pw>).
  const prefill = getRoomIdFromHash();
  if (prefill) ui.setRoomCodeInput(prefill);
  const prePw = getRoomPasswordFromHash();
  if (prePw) ui.setPasswordInput(prePw);
  // Restore lobby text after a rejected-join reload (invite link wins).
  try {
    const stash = JSON.parse(sessionStorage.getItem(LOBBY_STASH_KEY) || 'null');
    if (stash && !prefill) {
      if (stash.name && !ui.getUsernameInput()) {
        document.getElementById('username-input').value = stash.name;
      }
      if (stash.code && !ui.getRoomCodeInput()) ui.setRoomCodeInput(stash.code);
    } else if (stash?.name && !ui.getUsernameInput()) {
      document.getElementById('username-input').value = stash.name;
    }
  } catch (_) {}

  ui.setE2EEStatus('off');
  ui.setRoleBadge(false);
  ui.focusUsername();

  window.addEventListener('beforeunload', () => {
    try { manager?.leaveRoom(); } catch (_) {}
  });
});
