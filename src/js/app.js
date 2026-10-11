/**
 * app.js — Entry point / UI event listeners.
 * Wires uiController.js (DOM) <-> peerManager.js (PeerJS + E2EE + mesh).
 */

import { PeerManager } from './network/peerManager.js';
import { buildInviteLink, getRoomIdFromHash } from './crypto/crypto.js';
import * as ui from './ui/uiController.js';

let manager = null;
let lastRoomCode = '';
let lastPassphrase = '';

function makeManager() {
  return new PeerManager({
    onStatus: (t, c) => ui.setStatus(t, c),
    onSystemMessage: (t) => ui.appendSystemMessage(t),
    onChatMessage: (sender, text, isSelf) => ui.appendChatMessage(sender, text, isSelf),
    onHostPeerList: (view, isHost) => ui.updatePeerListUI(view, isHost),
    onClientPeerList: (users) => ui.updateClientPeerListUI(users),
    onRoleChanged: (isHost, hostId) => {
      ui.setRoleBadge(isHost);
      const rc = isHost ? manager.myId : hostId;
      const input = document.getElementById('display-room-code');
      if (input && rc) input.value = rc;
    },
    onKeepAlive: () => {},
    onReady: (roomCode, isHost) => {
      lastRoomCode = roomCode;
      lastPassphrase = manager.passphrase;
      ui.showChatScreen(roomCode);
      ui.setRoleBadge(isHost);
      ui.setE2EEStatus('on', 'shared room key');
      refreshInviteLink();
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
    box.value = buildInviteLink(lastRoomCode, lastPassphrase);
  }
}

async function onCreateRoom() {
  const name = ui.getUsernameInput();
  if (!name) { alert('Please enter your name first.'); return; }
  manager = makeManager();
  try {
    await manager.createRoom(name);
  } catch (e) {
    alert('Could not create room: ' + (e?.message || e));
  }
}

async function onJoinRoom() {
  const name = ui.getUsernameInput();
  const code = ui.getRoomCodeInput();
  if (!name) { alert('Please enter your name first.'); return; }
  if (!code) { alert('Please enter a valid Room Code.'); return; }
  manager = makeManager();
  ui.setE2EEStatus('off');
  try {
    await manager.joinRoom(name, code);
    // Room code echo + chat screen happen on host-link open; but if the
    // invite hash carried a room id we already know it — show pending UI.
    lastRoomCode = code;
    manager.cbs.onReady?.(code, false);
    // Correct the badge: we are a guest until a promotion happens.
    ui.setRoleBadge(false);
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
}

function onCopyRoomCode() {
  const input = document.getElementById('display-room-code');
  input.select();
  navigator.clipboard.writeText(input.value).then(
    () => ui.appendSystemMessage('Room Code copied to clipboard!'),
    () => alert('Copy failed — select and copy manually.'),
  );
}

function onCopyInvite() {
  refreshInviteLink();
  const input = document.getElementById('display-invite-link');
  if (!input || !input.value) { alert('Join a room first.'); return; }
  input.select();
  navigator.clipboard.writeText(input.value).then(
    () => ui.appendSystemMessage('Invite link (room + encryption key) copied!'),
    () => alert('Copy failed — select and copy manually.'),
  );
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
  document.getElementById('create-room-btn')?.addEventListener('click', onCreateRoom);
  document.getElementById('join-room-btn')?.addEventListener('click', onJoinRoom);
  document.getElementById('chat-form')?.addEventListener('submit', onSendMessage);
  document.getElementById('copy-code-btn')?.addEventListener('click', onCopyRoomCode);
  document.getElementById('copy-invite-btn')?.addEventListener('click', onCopyInvite);
  document.getElementById('leave-room-btn')?.addEventListener('click', onLeaveRoom);

  // Prefill room code from invite link hash (#key=...&room=<id>).
  const prefill = getRoomIdFromHash();
  if (prefill) ui.setRoomCodeInput(prefill);

  ui.setE2EEStatus('off');
  ui.setRoleBadge(false);

  window.addEventListener('beforeunload', () => {
    try { manager?.leaveRoom(); } catch (_) {}
  });
});
