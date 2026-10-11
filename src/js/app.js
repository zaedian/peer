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
const BASE_TITLE = 'Peer Chat';
const HISTORY_CAP = 200;
const LOBBY_STASH_KEY = 'p2pchat-lobby';
const USERNAME_KEY = 'p2pchat-username';
const AUTOJOIN_KEY = 'p2pchat-autojoin';

function rememberedName() {
  try {
    return (localStorage.getItem(USERNAME_KEY) || '').trim();
  } catch (_) {
    return '';
  }
}

function rememberName(name) {
  try {
    if (name) localStorage.setItem(USERNAME_KEY, name);
  } catch (_) {}
}

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
    ui.showToast(okMsg);
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
    ui.showToast(okMsg);
  } catch (_) {
    alert('Copy failed — select and copy manually.');
  }
}

// Chat stays clean: only people + calls + files reach the message list.
// Connection/debug noise goes to the console + header status instead.
function showServerNote(text) {
  const t = String(text || '');
  if (!t) return;
  if (
    /joined the room\.|left the room\.|nudged the room|is now hosting|New host took over|Kicked |kicked by the host|timed out and was removed/i.test(t)
  ) {
    ui.appendSystemMessage(t);
    return;
  }
  console.debug('[room]', t);
}

function makeManager() {
  return new PeerManager({
    onStatus: (t, c) => ui.setStatus(t, c),
    onSystemMessage: (t) => showServerNote(t),
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
    onFileSignal: (msg) => handleFileSignal(msg),
    onIncomingMediaCall: (call) => handleIncomingMedia(call),
    onRoleChanged: (isHost, hostId) => {
      ui.setRoleBadge(isHost);
      // Everyone shares ONE link: the original room id (held by whoever hosts).
      const rc = manager.roomId || (isHost ? manager.myId : hostId);
      const input = document.getElementById('display-room-code');
      if (input && rc) input.value = rc;
      // After a promotion the invite must keep pointing at the room id.
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
let upgradeInvite = null; // { from, username, timer } — incoming voice→video request
let upgradeRequestedTo = ''; // peerId we asked to switch to video (awaiting answer)
let upgradingToVideo = ''; // peerId mid-switch (suppress onEnded overlay teardown)
const CALL_TIMEOUT_MS = 30000;
const UPGRADE_TIMEOUT_MS = 30000;

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
        // Mid-upgrade teardown of the old voice leg: keep the overlay +
        // activePeer alive for the incoming video dial.
        if (upgradingToVideo) return;
        stopCallTimer();
        ui.hideCallOverlay();
        ui.setCallBusy(false);
        ui.hideUpgradePrompt();
        stopRing();
        if (upgradeInvite) {
          clearTimeout(upgradeInvite.timer);
          upgradeInvite = null;
        }
        upgradeRequestedTo = '';
        if (activePeer) {
          ui.setPeerMuted(activePeer.id, false);
          ui.appendSystemMessage('Call ended.');
          activePeer = null;
        }
        if (manager?.myId) ui.setPeerMuted(manager.myId, false);
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
  return !!calls?.inCall || !!outgoing || !!incomingInvite || !!upgradingToVideo;
}

function onNudgePressed() {
  if (!manager) return;
  if (manager.sendNudge()) {
    ui.showToast('You nudged the room 🔔');
  } else {
    ui.showToast('Nobody to nudge yet.');
  }
}

async function startOutgoing(targetId, video) {
  if (!manager || !targetId) return;
  const cm = ensureCalls();
  // In a voice call with this same peer, the 🎥 button means
  // "request a video upgrade" — not a second parallel call.
  if (activePeer && activePeer.id === targetId && !activePeer.video && video) {
    requestVideoUpgrade();
    return;
  }
  if (busy()) {
    ui.showToast('Already in a call.');
    return;
  }
  const name = nameFor(targetId);
  outgoing = {
    to: targetId, name, video,
    timer: setTimeout(() => {
      if (!outgoing) return;
      outgoing = null;
      ui.hideCallOverlay();
      ui.setCallBusy(false);
      ui.appendSystemMessage(`${name} didn't answer.`);
    }, CALL_TIMEOUT_MS),
  };
  if (!manager.sendCallSignal({ type: 'call-invite', to: targetId, video })) {
    clearTimeout(outgoing.timer);
    outgoing = null;
    ui.hideCallOverlay();
    ui.setCallBusy(false);
    ui.showToast('Not connected — call not sent.');
    return;
  }
  ui.showCallOverlay(name, video);
  ui.setCallStatus('Calling…');
  ui.setCallBusy(true, targetId, !video);
}

/* ---------- voice → video upgrade (in-call 🎥 request) ---------- */

function requestVideoUpgrade() {
  if (!activePeer || activePeer.video || !manager) return;
  if (upgradeRequestedTo || upgradingToVideo || upgradeInvite) {
    ui.showToast('Video request already pending…');
    return;
  }
  if (!manager.sendCallSignal({ type: 'call-upgrade-request', to: activePeer.id })) {
    ui.showToast('Not connected — video request not sent.');
    return;
  }
  upgradeRequestedTo = activePeer.id;
  ui.setCallStatus('Video request sent… 🎥');
  ui.appendSystemMessage(`🎥 Video request sent to ${activePeer.name} — waiting for them to accept…`);
  setTimeout(() => {
    if (upgradeRequestedTo === activePeer?.id) {
      upgradeRequestedTo = '';
      ui.appendSystemMessage('Video request timed out — staying on voice.');
      setCallBase('In call 🎙️');
    }
  }, UPGRADE_TIMEOUT_MS);
}

function handleUpgradeRequest(msg) {
  if (!msg.from) return;
  // Only the current call peer can upgrade us; anything else is declined.
  if (!activePeer || msg.from !== activePeer.id || activePeer.video) {
    manager?.sendCallSignal({ type: 'call-upgrade-decline', to: msg.from });
    return;
  }
  if (upgradeInvite || upgradingToVideo) return;
  upgradeInvite = {
    from: msg.from,
    username: String(msg.username || activePeer.name || 'Peer'),
    timer: setTimeout(() => {
      upgradeInvite = null;
      stopRing();
      ui.hideUpgradePrompt();
      ui.appendSystemMessage('Missed a video request.');
    }, UPGRADE_TIMEOUT_MS),
  };
  ui.showUpgradePrompt(upgradeInvite.username);
  startRing();
}

async function onAcceptUpgrade() {
  if (!upgradeInvite || !manager) return;
  const inv = upgradeInvite;
  upgradeInvite = null;
  clearTimeout(inv.timer);
  stopRing();
  ui.hideUpgradePrompt();
  if (!activePeer || activePeer.id !== inv.from) return;
  const cm = ensureCalls();
  ui.setCallStatus('Switching to video… 🎥');
  // Capture the camera BEFORE tearing down voice so the video dial lands.
  try {
    await cm.capture(true);
  } catch (e) {
    ui.appendSystemMessage('Camera unavailable — staying on voice. ' + (e?.message || e));
    manager.sendCallSignal({ type: 'call-upgrade-decline', to: inv.from });
    setCallBase('In call 🎙️');
    return;
  }
  upgradingToVideo = inv.from;
  manager.sendCallSignal({ type: 'call-upgrade-accept', to: inv.from });
  // Drop the old voice leg; onEnded is suppressed while upgradingToVideo set.
  try { calls?.hangup(); } catch (_) {}
  activePeer.video = true;
  ui.showCallOverlay(activePeer.name, true);
  ui.setCallBusy(true, activePeer.id, false);
  ui.setCallStatus('Switching to video… 🎥');
  setCallBase('Connecting video…');
  // Safety: if the caller never redials, fall back to voice-ended state.
  setTimeout(() => {
    if (upgradingToVideo === inv.from && !calls?.inCall) {
      upgradingToVideo = '';
      endActiveCall();
      ui.appendSystemMessage('Video switch failed to connect.');
    }
  }, 20000);
}

function onDeclineUpgrade() {
  if (!upgradeInvite) return;
  clearTimeout(upgradeInvite.timer);
  manager?.sendCallSignal({ type: 'call-upgrade-decline', to: upgradeInvite.from });
  upgradeInvite = null;
  stopRing();
  ui.hideUpgradePrompt();
}

async function handleUpgradeAccept(msg) {
  if (!upgradeRequestedTo || msg.from !== upgradeRequestedTo) return;
  if (!activePeer || activePeer.id !== msg.from) {
    upgradeRequestedTo = '';
    return;
  }
  upgradeRequestedTo = '';
  upgradingToVideo = msg.from;
  const cm = ensureCalls();
  const { id, name } = activePeer;
  ui.setCallStatus('Switching to video… 🎥');
  // Drop voice leg first (suppressed), then dial video.
  try { calls?.hangup(); } catch (_) {}
  activePeer.video = true;
  ui.showCallOverlay(name, true);
  ui.setCallBusy(true, id, false);
  setCallBase('Connecting video…');
  ui.setCallStatus('Connecting video…');
  try {
    await cm.startCall(id, true);
    upgradingToVideo = '';
    setCallBase('In call');
    ui.appendSystemMessage('Switched to video 🎥');
  } catch (e) {
    upgradingToVideo = '';
    activePeer.video = false;
    ui.showCallOverlay(name, false);
    ui.setCallBusy(true, id, true);
    setCallBase('In call 🎙️');
    ui.appendSystemMessage('Video switch failed — staying on voice. ' + (e?.message || e));
  }
}

function handleUpgradeDecline(msg) {
  if (upgradeRequestedTo && msg.from === upgradeRequestedTo) {
    upgradeRequestedTo = '';
    ui.appendSystemMessage('Video request declined — staying on voice 🎙️.');
    if (activePeer) setCallBase('In call 🎙️');
  }
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
      ui.setCallBusy(true, to, !video);
      setCallBase('Connecting…');
      ui.setCallStatus('Connecting…');
      try {
        await cm.startCall(to, video);
        setCallBase(video ? 'In call' : 'In call 🎙️');
        ui.setCallBusy(true, to, !video);
      } catch (e) {
        if (video) {
          // Camera missing/blocked → fall back to voice instead of failing.
          try {
            await cm.startCall(to, false);
            activePeer.video = false;
            ui.showCallOverlay(name, false);
            ui.setCallBusy(true, to, true);
            setCallBase('In call 🎙️');
            ui.appendSystemMessage('Camera unavailable — voice only.');
          } catch (e2) {
            activePeer = null;
            stopCallTimer();
            ui.hideCallOverlay();
            ui.setCallBusy(false);
            manager?.sendCallSignal({ type: 'call-end', to });
            ui.appendSystemMessage('Call failed: ' + (e2?.message || e2));
          }
        } else {
          activePeer = null;
          stopCallTimer();
          ui.hideCallOverlay();
          ui.setCallBusy(false);
          manager?.sendCallSignal({ type: 'call-end', to });
          ui.appendSystemMessage('Call failed: ' + (e?.message || e));
        }
      }
    }
  } else if (msg.type === 'call-mute') {
    if (activePeer && msg.from === activePeer.id) {
      ui.setRemoteMute(!!msg.muted);
      ui.setPeerMuted(msg.from, !!msg.muted);
    }
  } else if (msg.type === 'call-camera') {
    if (activePeer && msg.from === activePeer.id) ui.setRemoteCameraOff(!!msg.off);
  } else if (msg.type === 'call-upgrade-request') {
    handleUpgradeRequest(msg);
  } else if (msg.type === 'call-upgrade-accept') {
    handleUpgradeAccept(msg);
  } else if (msg.type === 'call-upgrade-decline') {
    handleUpgradeDecline(msg);
  } else if (msg.type === 'call-decline' || msg.type === 'call-end') {    if (outgoing && msg.from === outgoing.to) {
      clearTimeout(outgoing.timer);
      outgoing = null;
      ui.hideCallOverlay();
      ui.setCallBusy(false);
      ui.appendSystemMessage(msg.type === 'call-decline' ? 'Call declined.' : 'Call ended.');
    } else if (incomingInvite && msg.from === incomingInvite.from) {
      clearTimeout(incomingInvite.timer);
      incomingInvite = null;
      stopRing();
      ui.hideIncoming();
    } else if (upgradeInvite && msg.from === upgradeInvite.from) {
      // Peer hung up while we were deciding on their video request.
      clearTimeout(upgradeInvite.timer);
      upgradeInvite = null;
      stopRing();
      ui.hideUpgradePrompt();
    } else if (upgradeRequestedTo && msg.from === upgradeRequestedTo) {
      upgradeRequestedTo = '';
      if (activePeer) setCallBase(activePeer.video ? 'In call' : 'In call 🎙️');
    } else if (activePeer && msg.from === activePeer.id) {
      const nm = activePeer.name;
      const pid = activePeer.id;
      activePeer = null;
      upgradingToVideo = '';
      upgradeRequestedTo = '';
      if (upgradeInvite) {
        clearTimeout(upgradeInvite.timer);
        upgradeInvite = null;
        stopRing();
        ui.hideUpgradePrompt();
      }
      ui.setPeerMuted(pid, false);
      cm.hangup();
      ui.hideCallOverlay();
      ui.setCallBusy(false);
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
      upgradingToVideo = '';
      setCallBase(activePeer.video ? 'In call' : 'In call 🎙️');
      ui.setCallBusy(true, activePeer.id, !activePeer.video);
      if (activePeer.video) ui.appendSystemMessage('Switched to video 🎥');
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
        ui.setCallBusy(false);
        manager.sendCallSignal({ type: 'call-decline', to: inv.from });
        ui.appendSystemMessage('Mic/camera blocked: ' + (e2?.message || e2));
        return;
      }
    } else {
      ui.hideCallOverlay();
      ui.setCallBusy(false);
      manager.sendCallSignal({ type: 'call-decline', to: inv.from });
      ui.appendSystemMessage('Mic/camera blocked: ' + (e?.message || e));
      return;
    }
  }
  activePeer = { id: inv.from, name: inv.username, video: inv.video };
  ui.setCallBusy(true, inv.from, !inv.video);
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
  ui.hideUpgradePrompt();
  upgradingToVideo = '';
  upgradeRequestedTo = '';
  if (upgradeInvite) {
    try { clearTimeout(upgradeInvite.timer); } catch (_) {}
    upgradeInvite = null;
  }
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
      ui.setPeerMuted(activePeer.id, false);
      activePeer = null;
    }
    if (manager?.myId) ui.setPeerMuted(manager.myId, false);
    calls?.hangup();
  } catch (_) {}
  ui.hideCallOverlay();
  ui.setCallBusy(false);
}

/* ---------- P2P file sharing (offer → accept/deny → chunks) ---------- */

const FILE_CHUNK = 64 * 1024; // 64 KB per DataConnection message
const FILE_MAX = 50 * 1024 * 1024; // 50 MB cap
const FILE_OFFER_MS = 120000;
let fileSeq = 0;
const outgoingFiles = new Map(); // fileId -> { file, to, total }
const incomingOffers = new Map(); // fileId -> { from, username, name, size, mime, timer }
const incomingFiles = new Map(); // fileId -> { from, username, name, size, mime, chunks, received, total }
let pendingFilePeer = '';

function otherPeers() {
  if (!manager) return [];
  const seen = new Map();
  for (const m of manager.roster || []) {
    if (m.id && m.id !== manager.myId) seen.set(m.id, m.username || 'Peer');
  }
  for (const id in manager.connections || {}) {
    if (id !== manager.myId && !seen.has(id)) {
      seen.set(id, manager.connections[id]?.username || 'Peer');
    }
  }
  return [...seen.entries()].map(([id, username]) => ({ id, username }));
}

function onFileButton(peerId) {
  if (!manager || !peerId) return;
  pendingFilePeer = peerId;
  document.getElementById('file-input')?.click();
}

function onAttachPressed() {
  if (!manager) {
    ui.showToast('Join a room first.');
    return;
  }
  const peers = otherPeers();
  if (!peers.length) {
    ui.showToast('Nobody to send to yet.');
    return;
  }
  if (peers.length === 1) pendingFilePeer = peers[0].id;
  if (!pendingFilePeer || !peers.some((p) => p.id === pendingFilePeer)) {
    ui.showToast('Tap 📁 by their name to send a file.');
    return;
  }
  document.getElementById('file-input')?.click();
}

async function onFileChosen(file) {
  if (!file || !manager) return;
  if (file.size > FILE_MAX) {
    ui.showToast('File too big (50 MB max).');
    return;
  }
  if (file.size === 0) {
    ui.showToast('Empty file — nothing to send.');
    return;
  }
  const peers = otherPeers();
  const target = peers.find((p) => p.id === pendingFilePeer) || peers[0];
  if (!target) {
    ui.showToast('Nobody to send to yet.');
    return;
  }
  const fileId = `${manager.myId || 'me'}-${Date.now()}-${fileSeq++}`.replace(/[^a-zA-Z0-9-]/g, '');
  const name = String(file.name || 'file').slice(0, 255);
  const total = Math.max(1, Math.ceil(file.size / FILE_CHUNK));
  outgoingFiles.set(fileId, { file, to: target.id, total });
  const ok = manager.sendFileSignal({
    type: 'file-offer', to: target.id, fileId,
    name, size: file.size, mime: file.type || 'application/octet-stream',
  });
  if (!ok) {
    outgoingFiles.delete(fileId);
    ui.showToast('Not connected — file not offered.');
    return;
  }
  ui.appendFileOutgoing({ fileId, name, size: file.size, mime: file.type, toName: target.username });
  ui.setFileProgress(fileId, 0, 'Waiting for them to accept…');
  pendingFilePeer = '';
}

function handleFileSignal(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'file-offer') {
    if (!msg.from || !msg.fileId) return;
    if (!/^[A-Za-z0-9-]{1,128}$/.test(String(msg.fileId))) return;
    const name = String(msg.name || 'file').slice(0, 255);
    const size = Number(msg.size) || 0;
    if (size > FILE_MAX) {
      manager?.sendFileSignal({ type: 'file-decline', to: msg.from, fileId: msg.fileId });
      return;
    }
    const username = String(msg.username || nameFor(msg.from) || 'Someone');
    if (incomingOffers.has(msg.fileId) || incomingFiles.has(msg.fileId)) return;
    const timer = setTimeout(() => {
      incomingOffers.delete(msg.fileId);
      ui.failFileCard(msg.fileId, 'Offer expired.');
    }, FILE_OFFER_MS);
    incomingOffers.set(msg.fileId, { from: msg.from, username, name, size, mime: String(msg.mime || ''), timer });
    ui.appendFileOffer({ fileId: msg.fileId, sender: username, name, size, mime: String(msg.mime || '') });
    ui.showToast(`📁 ${username} wants to send a file`);
  } else if (msg.type === 'file-accept') {
    if (!msg.from || !msg.fileId) return;
    const out = outgoingFiles.get(msg.fileId);
    if (!out || out.to !== msg.from) return;
    ui.setFileProgress(msg.fileId, 1, 'Sending…');
    sendFileChunks(msg.fileId);
  } else if (msg.type === 'file-decline') {
    if (!msg.from || !msg.fileId) return;
    if (outgoingFiles.has(msg.fileId)) {
      outgoingFiles.delete(msg.fileId);
      ui.failFileCard(msg.fileId, 'They declined the file.');
      ui.showToast('File declined.');
    }
  } else if (msg.type === 'file-chunk') {
    const t = incomingFiles.get(msg.fileId);
    if (!t || (msg.from && msg.from !== t.from)) return;
    if (typeof msg.seq !== 'number' || !msg.buf) return;
    if (!t.chunks[msg.seq]) {
      t.chunks[msg.seq] = msg.buf;
      t.received++;
      ui.setFileProgress(msg.fileId, (t.received / t.total) * 100, `Receiving… ${Math.round((t.received / t.total) * 100)}%`);
    }
  } else if (msg.type === 'file-done') {
    const t = incomingFiles.get(msg.fileId);
    if (!t) return;
    try {
      const blob = new Blob(t.chunks, { type: t.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      ui.completeFileCard({ fileId: msg.fileId, url, name: t.name, size: t.size, mime: t.mime, sender: t.username, isSelf: false });
      ui.showToast(`📁 ${t.name} received`);
      if (lastRoomCode) queueHistorySave(lastRoomCode, { s: t.username, t: `📁 sent a file: ${t.name}`, self: false, time: ui.formatTime() });
    } catch (_) {
      ui.failFileCard(msg.fileId, 'Could not assemble file.');
    }
    incomingFiles.delete(msg.fileId);
  } else if (msg.type === 'file-cancel') {
    if (incomingOffers.has(msg.fileId)) {
      clearTimeout(incomingOffers.get(msg.fileId).timer);
      incomingOffers.delete(msg.fileId);
      ui.failFileCard(msg.fileId, 'They cancelled the file.');
    }
    if (incomingFiles.has(msg.fileId)) {
      incomingFiles.delete(msg.fileId);
      ui.failFileCard(msg.fileId, 'Transfer cancelled.');
    }
    if (outgoingFiles.has(msg.fileId)) {
      outgoingFiles.delete(msg.fileId);
      ui.failFileCard(msg.fileId, 'Transfer cancelled.');
    }
  }
}

async function sendFileChunks(fileId) {
  const out = outgoingFiles.get(fileId);
  if (!out || !manager) return;
  const { file, to, total } = out;
  for (let seq = 0; seq < total; seq++) {
    if (!outgoingFiles.has(fileId)) return; // declined/cancelled mid-send
    const slice = file.slice(seq * FILE_CHUNK, (seq + 1) * FILE_CHUNK);
    let buf = null;
    try {
      buf = await slice.arrayBuffer();
    } catch (_) {
      ui.failFileCard(fileId, 'Could not read file.');
      outgoingFiles.delete(fileId);
      return;
    }
    const ok = manager.sendFileSignal({ type: 'file-chunk', to, fileId, seq, total, buf });
    if (!ok) {
      ui.failFileCard(fileId, 'Connection lost mid-transfer.');
      outgoingFiles.delete(fileId);
      return;
    }
    ui.setFileProgress(fileId, ((seq + 1) / total) * 100, `Sending… ${Math.round(((seq + 1) / total) * 100)}%`);
    if (seq % 8 === 7) await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
  }
  if (!outgoingFiles.has(fileId)) return;
  manager.sendFileSignal({ type: 'file-done', to, fileId });
  try {
    const url = URL.createObjectURL(file);
    ui.completeFileCard({ fileId, url, name: file.name, size: file.size, mime: file.type, sender: 'You', isSelf: true });
    if (lastRoomCode) queueHistorySave(lastRoomCode, { s: 'You', t: `📁 sent a file: ${file.name}`, self: true, time: ui.formatTime() });
  } catch (_) {}
  outgoingFiles.delete(fileId);
}

function acceptFile(fileId) {
  const offer = incomingOffers.get(fileId);
  if (!offer || !manager) return;
  clearTimeout(offer.timer);
  incomingOffers.delete(fileId);
  const total = Math.max(1, Math.ceil((offer.size || 1) / FILE_CHUNK));
  incomingFiles.set(fileId, { ...offer, chunks: new Array(total), received: 0, total });
  ui.resolveFileOffer(fileId, true);
  ui.setFileProgress(fileId, 0, 'Receiving… 0%');
  manager.sendFileSignal({ type: 'file-accept', to: offer.from, fileId });
}

function declineFile(fileId) {
  const offer = incomingOffers.get(fileId);
  if (!offer) return;
  clearTimeout(offer.timer);
  incomingOffers.delete(fileId);
  ui.resolveFileOffer(fileId, false);
  manager?.sendFileSignal({ type: 'file-decline', to: offer.from, fileId });
}

async function onCreateRoom() {
  const name = ui.getUsernameInput();
  if (!name) { alert('Please enter your name first.'); return; }
  rememberName(name);
  hostPassword = ui.getPasswordInput();
  manager = makeManager();
  try {
    await manager.createRoom(name, { password: hostPassword });
  } catch (e) {
    alert('Could not create room: ' + (e?.message || e));
  }
}

async function onJoinRoom(opts = {}) {
  const auto = !!opts.auto;
  const name = ui.getUsernameInput();
  const code = ui.getRoomCodeInput();
  const pw = ui.getPasswordInput();
  if (!name) {
    if (auto) return false;
    alert('Please enter your name first.');
    return false;
  }
  if (!code) {
    if (auto) return false;
    alert('Please enter a valid Room Code.');
    return false;
  }
  rememberName(name);
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
    return true;
  } catch (e) {
    if (auto) {
      ui.setStatus('Could not join automatically — enter your name and accept.', 'text-amber-400');
      ui.showToast('Auto-join failed: ' + (e?.message || e));
      return false;
    }
    alert('Could not join room: ' + (e?.message || e));
    return false;
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
  document.getElementById('choice-join-btn')?.addEventListener('click', () => ui.showLobbyView('join'));
  document.getElementById('choice-create-btn')?.addEventListener('click', () => ui.showLobbyView('create'));
  document.getElementById('join-back-btn')?.addEventListener('click', () => ui.showLobbyView('choice'));
  document.getElementById('create-back-btn')?.addEventListener('click', () => ui.showLobbyView('choice'));
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
      if (ca.disabled) return;
      startOutgoing(ca.getAttribute('data-call-audio'), false);
      return;
    }
    const cv = e.target.closest('[data-call-video]');
    if (cv) {
      if (cv.disabled) return;
      startOutgoing(cv.getAttribute('data-call-video'), true);
      return;
    }
    const fb = e.target.closest('[data-file]');
    if (fb) {
      onFileButton(fb.getAttribute('data-file'));
      return;
    }
    if (e.target.closest('[data-nudge]')) onNudgePressed();
  });

  // File offer accept/deny buttons live inside chat bubbles — delegated.
  document.getElementById('chat-messages')?.addEventListener('click', (e) => {
    const acc = e.target.closest('[data-file-accept]');
    if (acc) {
      acceptFile(acc.getAttribute('data-file-accept'));
      return;
    }
    const dec = e.target.closest('[data-file-decline]');
    if (dec) {
      declineFile(dec.getAttribute('data-file-decline'));
    }
  });

  // Composer: attach + emoji.
  document.getElementById('attach-btn')?.addEventListener('click', onAttachPressed);
  document.getElementById('file-input')?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) onFileChosen(f);
  });
  document.getElementById('emoji-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    ui.toggleEmojiPanel();
  });
  document.getElementById('emoji-panel')?.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-emoji]');
    if (cell) ui.insertEmojiAtCursor(cell.getAttribute('data-emoji'));
  });
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('emoji-panel');
    if (panel && !panel.classList.contains('hidden')) {
      if (!e.target.closest('#emoji-panel') && !e.target.closest('#emoji-btn')) {
        ui.toggleEmojiPanel(false);
      }
    }
  });

  // Call controls.
  document.getElementById('accept-btn')?.addEventListener('click', onAcceptCall);
  document.getElementById('decline-btn')?.addEventListener('click', onDeclineCall);
  document.getElementById('upgrade-accept-btn')?.addEventListener('click', onAcceptUpgrade);
  document.getElementById('upgrade-decline-btn')?.addEventListener('click', onDeclineUpgrade);
  document.getElementById('hangup-btn')?.addEventListener('click', endActiveCall);
  document.getElementById('show-manual-btn')?.addEventListener('click', () => ui.exitInviteMode());
  document.getElementById('mute-btn')?.addEventListener('click', () => {
    try {
      const m = !!calls?.toggleMute();
      ui.setMuteUI(m);
      if (manager?.myId) ui.setPeerMuted(manager.myId, m);
      if (activePeer) manager?.sendCallSignal({ type: 'call-mute', to: activePeer.id, muted: m });
    } catch (_) {}
  });
  document.getElementById('camera-btn')?.addEventListener('click', () => {
    try {
      // Voice-only call: the 🎥 button sends a video upgrade request
      // instead of toggling a camera that isn't in the call.
      if (activePeer && !activePeer.video) {
        requestVideoUpgrade();
        return;
      }
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

  // Escape declines an incoming call / upgrade, or hangs up an active one.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (upgradeInvite) onDeclineUpgrade();
    else if (incomingInvite) onDeclineCall();
    else if (calls?.inCall || outgoing) endActiveCall();
  });

  // Enter in a lobby step submits that step.
  document.getElementById('join-form')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onJoinRoom();
  });
  document.getElementById('create-form')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onCreateRoom();
  });

  document.getElementById('message-input')?.addEventListener('focus', resetUnread);
  document.getElementById('message-input')?.addEventListener('input', () => {
    try { manager?.sendTyping(); } catch (_) {}
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resetUnread();
  });

  // Prefill room code + password from invite link hash (#key=...&room=<id>&pw=<pw>).
  // Invite links open a streamlined Accept flow (no Create Room path).
  const prefill = getRoomIdFromHash();
  if (prefill) {
    ui.setRoomCodeInput(prefill);
    ui.enterInviteMode(prefill);
  }
  const prePw = getRoomPasswordFromHash();
  if (prePw) ui.setPasswordInput(prePw);
  // Restore lobby text after a rejected-join reload (invite link wins).
  try {
    const stash = JSON.parse(sessionStorage.getItem(LOBBY_STASH_KEY) || 'null');
    if (stash && !prefill) {
      if (stash.name && !ui.getUsernameInput()) {
        ui.setUsernameInput(stash.name);
      }
      if (stash.code && !ui.getRoomCodeInput()) ui.setRoomCodeInput(stash.code);
    } else if (stash?.name && !ui.getUsernameInput()) {
      ui.setUsernameInput(stash.name);
    }
  } catch (_) {}
  // Returning guests skip typing: reuse the name from last time.
  if (!ui.getUsernameInput()) {
    const saved = rememberedName();
    if (saved) ui.setUsernameInput(saved);
  }

  // Auto-join: invite link + known name → straight into the room.
  // Once per tab session, so a rejected join can never reload-loop.
  let autoTried = false;
  try { autoTried = sessionStorage.getItem(AUTOJOIN_KEY) === '1'; } catch (_) {}
  if (prefill && !autoTried && ui.getUsernameInput() && ui.getRoomCodeInput()) {
    try { sessionStorage.setItem(AUTOJOIN_KEY, '1'); } catch (_) {}
    const joinBtn = document.getElementById('join-room-btn');
    if (joinBtn) {
      joinBtn.disabled = true;
      joinBtn.innerText = 'Joining…';
    }
    ui.setStatus(`Joining as ${ui.getUsernameInput()}...`, 'text-amber-400');
    setTimeout(() => {
      onJoinRoom({ auto: true }).then((ok) => {
        if (!ok && joinBtn) {
          joinBtn.disabled = false;
          joinBtn.innerText = ui.isInviteMode() ? 'Accept Invite ✓' : 'Join →';
        }
      });
    }, 350);
  }

  ui.setE2EEStatus('off');
  ui.setRoleBadge(false);
  ui.focusUsername();

  window.addEventListener('beforeunload', () => {
    try { endActiveCall(); } catch (_) {}
    try { manager?.leaveRoom(); } catch (_) {}
  });
});
