/**
 * app.js — Entry point / UI event listeners.
 * Wires uiController.js (DOM) <-> peerManager.js (PeerJS + E2EE + mesh).
 */

import { PeerManager, ensurePeerJS } from './network/peerManager.js';
import { buildInviteLink, getRoomIdFromHash, getRoomPasswordFromHash } from './crypto/crypto.js';
import { CallManager } from './media/calls.js';
import { playNudge, startRing, stopRing } from './media/nudge.js';
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
    onHostPeerList: (view, isHost, myId) => ui.updatePeerListUI(view, isHost, myId),
    onClientPeerList: (users, locked, myId) => {
      ui.updateClientPeerListUI(users, myId);
      ui.setLockStatus(!!locked);
    },
    onTyping: (username) => showTyping(username),
    onLockChanged: (locked) => ui.setLockStatus(!!locked),
    onDenied: (reason) => {
      alert(reason === 'wrong-password' ? 'Wrong room password.' : 'Join rejected by host.');
      location.reload();
    },
    onNudge: (username) => {
      playNudge(3);
      ui.appendSystemMessage(`🔔 ${username} nudged the room`);
    },
    onCallSignal: (msg) => handleCallSignal(msg),
    onIncomingMediaCall: (call) => handleIncomingMedia(call),
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
  bar.classList.toggle('typing', names.length > 0);
}

/* ---------- voice/video calls + nudges ---------- */

let calls = null;
let outgoing = null; // { to, name, video, timer }
let incomingInvite = null; // { from, username, video, timer }
let activePeer = null; // { id, name, video }
const CALL_TIMEOUT_MS = 30000;

function ensureCalls() {
  if (!calls) {
    calls = new CallManager({
      getPeer: () => manager?.peer,
      onLocalStream: (s) => ui.attachLocalStream(s),
      onRemoteStream: (s) => {
        ui.attachRemoteStream(s);
        if (activePeer) {
          setCallBase(activePeer.video ? 'In call' : 'In call 🎙️');
          startCallTimer();
        }
      },
      onEnded: () => {
        stopCallTimer();
        ui.hideCallOverlay();
        if (activePeer) {
          ui.appendSystemMessage('Call ended.');
          activePeer = null;
        }
        if (outgoing) {
          clearTimeout(outgoing.timer);
          outgoing = null;
        }
      },
    });
  }
  return calls;
}

/* ---------- call duration ticker ---------- */
let callStart = 0;
let callTick = null;
let callBase = 'In call';

function setCallBase(base) {
  callBase = base;
  renderCallTime();
}

function renderCallTime() {
  if (!callStart) {
    ui.setCallStatus(callBase);
    return;
  }
  const s = Math.floor((Date.now() - callStart) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  ui.setCallStatus(`${callBase} · ${mm}:${ss}`);
}

function startCallTimer() {
  if (callTick) return;
  callStart = Date.now();
  renderCallTime();
  callTick = setInterval(renderCallTime, 1000);
}

function stopCallTimer() {
  if (callTick) clearInterval(callTick);
  callTick = null;
  callStart = 0;
}

function nameFor(peerId) {
  const hit = manager?.roster?.find((m) => m.id === peerId);
  return hit ? hit.username : 'Peer';
}

function busy() {
  return !!calls?.inCall || !!outgoing || !!incomingInvite;
}

function onNudgePressed() {
  if (!manager) return;
  if (manager.sendNudge()) {
    ui.appendSystemMessage('You nudged the room 🔔');
  } else {
    ui.appendSystemMessage('Nobody to nudge yet.');
  }
}

async function startOutgoing(targetId, video) {
  if (!manager || !targetId) return;
  const cm = ensureCalls();
  if (busy()) {
    ui.appendSystemMessage('Already in a call.');
    return;
  }
  const name = nameFor(targetId);
  outgoing = {
    to: targetId, name, video,
    timer: setTimeout(() => {
      if (!outgoing) return;
      outgoing = null;
      ui.hideCallOverlay();
      ui.appendSystemMessage(`${name} didn't answer.`);
    }, CALL_TIMEOUT_MS),
  };
  if (!manager.sendCallSignal({ type: 'call-invite', to: targetId, video })) {
    clearTimeout(outgoing.timer);
    outgoing = null;
    ui.hideCallOverlay();
    ui.appendSystemMessage('Not connected — call not sent.');
    return;
  }
  ui.showCallOverlay(name, video);
  ui.setCallStatus('Calling…');
}

async function handleCallSignal(msg) {  if (!msg || !msg.type) return;
  const cm = ensureCalls();
  if (msg.type === 'call-invite') {
    if (!msg.from) return;
    // Simultaneous dial: we already called them — keep our outgoing leg,
    // decline theirs so exactly one call survives.
    if (outgoing && outgoing.to === msg.from) {
      manager?.sendCallSignal({ type: 'call-decline', to: msg.from });
      return;
    }
    if (busy()) {
      manager?.sendCallSignal({ type: 'call-decline', to: msg.from });
      return;
    }
    incomingInvite = {
      from: msg.from,
      username: String(msg.username || 'Someone'),
      video: !!msg.video,
      timer: setTimeout(() => {
        incomingInvite = null;
        stopRing();
        ui.hideIncoming();
        ui.appendSystemMessage('Missed a call.');
      }, CALL_TIMEOUT_MS),
    };
    ui.showIncoming(incomingInvite.username, incomingInvite.video);
    startRing();
  } else if (msg.type === 'call-accept') {
    if (outgoing && msg.from === outgoing.to) {
      clearTimeout(outgoing.timer);
      const { to, name } = outgoing;
      // Callee may have downgraded video → voice-only.
      const video = outgoing.video && msg.video !== false;
      outgoing = null;
      activePeer = { id: to, name, video };
      if (!video) ui.showCallOverlay(name, false);
      setCallBase('Connecting…');
      ui.setCallStatus('Connecting…');
      try {
        await cm.startCall(to, video);
        setCallBase(video ? 'In call' : 'In call 🎙️');
      } catch (e) {
        if (video) {
          // Camera missing/blocked → fall back to voice instead of failing.
          try {
            await cm.startCall(to, false);
            activePeer.video = false;
            ui.showCallOverlay(name, false);
            setCallBase('In call 🎙️');
            ui.appendSystemMessage('Camera unavailable — voice only.');
          } catch (e2) {
            activePeer = null;
            stopCallTimer();
            ui.hideCallOverlay();
            manager?.sendCallSignal({ type: 'call-end', to });
            ui.appendSystemMessage('Call failed: ' + (e2?.message || e2));
          }
        } else {
          activePeer = null;
          stopCallTimer();
          ui.hideCallOverlay();
          manager?.sendCallSignal({ type: 'call-end', to });
          ui.appendSystemMessage('Call failed: ' + (e?.message || e));
        }
      }
    }
  } else if (msg.type === 'call-mute') {
    if (activePeer && msg.from === activePeer.id) ui.setRemoteMute(!!msg.muted);
  } else if (msg.type === 'call-camera') {
    if (activePeer && msg.from === activePeer.id) ui.setRemoteCameraOff(!!msg.off);
  } else if (msg.type === 'call-decline' || msg.type === 'call-end') {    if (outgoing && msg.from === outgoing.to) {
      clearTimeout(outgoing.timer);
      outgoing = null;
      ui.hideCallOverlay();
      ui.appendSystemMessage(msg.type === 'call-decline' ? 'Call declined.' : 'Call ended.');
    } else if (incomingInvite && msg.from === incomingInvite.from) {
      clearTimeout(incomingInvite.timer);
      incomingInvite = null;
      stopRing();
      ui.hideIncoming();
    } else if (activePeer && msg.from === activePeer.id) {
      const nm = activePeer.name;
      activePeer = null;
      cm.hangup();
      ui.hideCallOverlay();
      ui.appendSystemMessage(`${nm} ended the call.`);
    }
  }
}

function handleIncomingMedia(call) {
  const cm = ensureCalls();
  const from = call?.peer;
  // Expected only as the callee's leg after we accepted.
  if (activePeer && from === activePeer.id && !cm.inCall) {
    if (cm.adoptIncoming(call, from, activePeer.video)) {
      setCallBase(activePeer.video ? 'In call' : 'In call 🎙️');
      return;
    }
  }
  // Unsolicited or busy: close the media and tell the caller right away
  // (instead of leaving them on "Calling…" until timeout).
  try { call?.close(); } catch (_) {}
  if (from) manager?.sendCallSignal({ type: 'call-decline', to: from });
}

async function onAcceptCall() {
  if (!incomingInvite || !manager) return;
  const inv = incomingInvite;
  incomingInvite = null;
  clearTimeout(inv.timer);
  stopRing();
  ui.hideIncoming();
  const cm = ensureCalls();
  ui.showCallOverlay(inv.username, inv.video);
  ui.setCallStatus('Connecting…');
  try {
    await cm.capture(inv.video);
  } catch (e) {
    if (inv.video) {
      // Camera missing/blocked → fall back to voice instead of declining.
      try {
        await cm.capture(false);
        inv.video = false;
        ui.showCallOverlay(inv.username, false);
        ui.appendSystemMessage('Camera unavailable — voice only.');
      } catch (e2) {
        ui.hideCallOverlay();
        manager.sendCallSignal({ type: 'call-decline', to: inv.from });
        ui.appendSystemMessage('Mic/camera blocked: ' + (e2?.message || e2));
        return;
      }
    } else {
      ui.hideCallOverlay();
      manager.sendCallSignal({ type: 'call-decline', to: inv.from });
      ui.appendSystemMessage('Mic/camera blocked: ' + (e?.message || e));
      return;
    }
  }
  activePeer = { id: inv.from, name: inv.username, video: inv.video };
  manager.sendCallSignal({ type: 'call-accept', to: inv.from, video: inv.video });
  // Safety: if the caller never dials, don't stick on "Connecting…".
  setTimeout(() => {
    if (activePeer && activePeer.id === inv.from && !calls?.inCall) {
      endActiveCall();
      ui.appendSystemMessage('Call failed to connect.');
    }
  }, 20000);
}

function onDeclineCall() {
  if (!incomingInvite) return;
  clearTimeout(incomingInvite.timer);
  manager?.sendCallSignal({ type: 'call-decline', to: incomingInvite.from });
  incomingInvite = null;
  stopRing();
  ui.hideIncoming();
}

function endActiveCall() {
  stopRing();
  ui.hideIncoming();
  try {
    if (outgoing) {
      clearTimeout(outgoing.timer);
      manager?.sendCallSignal({ type: 'call-end', to: outgoing.to });
      outgoing = null;
    }
    if (incomingInvite) {
      clearTimeout(incomingInvite.timer);
      manager?.sendCallSignal({ type: 'call-decline', to: incomingInvite.from });
      incomingInvite = null;
    }
    if (activePeer) {
      manager?.sendCallSignal({ type: 'call-end', to: activePeer.id });
      activePeer = null;
    }
    calls?.hangup();
  } catch (_) {}
  ui.hideCallOverlay();
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
  try { endActiveCall(); } catch (_) {}
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
  // Preload/validate PeerJS early so failures show here, not at join time.
  // Falls back to alternate CDNs if the primary script was blocked.
  ensurePeerJS().catch((e) => {
    ui.setStatus(e.message, 'text-red-400');
  });
  document.getElementById('create-room-btn')?.addEventListener('click', onCreateRoom);
  document.getElementById('join-room-btn')?.addEventListener('click', onJoinRoom);
  document.getElementById('chat-form')?.addEventListener('submit', onSendMessage);
  document.getElementById('copy-code-btn')?.addEventListener('click', onCopyRoomCode);
  document.getElementById('copy-invite-btn')?.addEventListener('click', onCopyInvite);
  document.getElementById('leave-room-btn')?.addEventListener('click', onLeaveRoom);

  // Peer list actions are rendered dynamically — one delegated listener.
  document.getElementById('peer-list')?.addEventListener('click', (e) => {
    const kick = e.target.closest('[data-kick]');
    if (kick) {
      onKickClicked(kick.getAttribute('data-kick'));
      return;
    }
    const ca = e.target.closest('[data-call-audio]');
    if (ca) {
      startOutgoing(ca.getAttribute('data-call-audio'), false);
      return;
    }
    const cv = e.target.closest('[data-call-video]');
    if (cv) {
      startOutgoing(cv.getAttribute('data-call-video'), true);
      return;
    }
    if (e.target.closest('[data-nudge]')) onNudgePressed();
  });

  // Call controls.
  document.getElementById('accept-btn')?.addEventListener('click', onAcceptCall);
  document.getElementById('decline-btn')?.addEventListener('click', onDeclineCall);
  document.getElementById('hangup-btn')?.addEventListener('click', endActiveCall);
  document.getElementById('mute-btn')?.addEventListener('click', () => {
    try {
      const m = !!calls?.toggleMute();
      ui.setMuteUI(m);
      if (activePeer) manager?.sendCallSignal({ type: 'call-mute', to: activePeer.id, muted: m });
    } catch (_) {}
  });
  document.getElementById('camera-btn')?.addEventListener('click', () => {
    try {
      const off = !!calls?.toggleCamera();
      ui.setCameraUI(off);
      if (activePeer) manager?.sendCallSignal({ type: 'call-camera', to: activePeer.id, off });
    } catch (_) {}
  });
  document.getElementById('switch-btn')?.addEventListener('click', async () => {
    try {
      await calls?.switchCamera();
      ui.setCameraUI(false);
    } catch (e) {
      ui.appendSystemMessage('Could not switch camera: ' + (e?.message || e));
    }
  });

  // Escape declines an incoming call, or hangs up an active one.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (incomingInvite) onDeclineCall();
    else if (calls?.inCall || outgoing) endActiveCall();
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
    try { endActiveCall(); } catch (_) {}
    try { manager?.leaveRoom(); } catch (_) {}
  });
});
