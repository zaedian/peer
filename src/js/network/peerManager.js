/**
 * peerManager.js — Modular PeerJS lifecycle manager (ES Module).
 *
 * Responsibilities:
 *  - Create / join rooms, own the PeerJS Peer + DataConnections.
 *  - Intercept OUTGOING chat through crypto.js (AES-GCM encrypt) and
 *    INCOMING chat through crypto.js (decrypt) before display.
 *  - Own the MeshNetwork heartbeat / host-failover instance.
 *  - Graceful error handling + auto-reconnect (peer.reconnect()).
 *
 * UI is never touched directly: everything renders via injected callbacks
 * (wired to uiController.js in app.js).
 */

import {
  encryptMessage,
  decryptMessage,
  getOrCreateRoomKey,
  getRoomPassphrase,
  clearCachedKey,
  clearRoomHash,
  passwordVerifier,
  verifiersEqual,
} from '../crypto/crypto.js';
import { MeshNetwork } from './meshNetwork.js';
import { enableMobileKeepAlive, disableMobileKeepAlive } from './silentAudio.js';

/** The primary <script> tag may be blocked (ad-blocker/offline CDN). */
const PEERJS_FALLBACKS = [
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js',
];

function peerConstructorValid() {
  const P = globalThis.Peer;
  return typeof P === 'function' && typeof P.prototype?.on === 'function';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('load failed'));
    document.head.appendChild(s);
  });
}

/**
 * Ensure a working PeerJS constructor, trying fallback CDNs if the
 * primary script tag was blocked or delivered a stub.
 * @returns {Promise<Function>} the Peer constructor
 */
export async function ensurePeerJS() {
  if (peerConstructorValid()) return globalThis.Peer;
  for (const url of PEERJS_FALLBACKS) {
    try {
      await loadScript(url);
    } catch (_) {
      continue;
    }
    if (peerConstructorValid()) return globalThis.Peer;
  }
  const P = globalThis.Peer;
  const desc = P ? `${typeof P} (${P.name || 'anonymous'})` : 'missing';
  throw new Error(
    `PeerJS library failed to load (window.Peer is ${desc}). ` +
    'Disable any ad-blocker for this page, check your connection, then reload.',
  );
}

function buildPeer(id) {
  const PeerCtor = globalThis.Peer;
  const peer = id ? new PeerCtor(id) : new PeerCtor();
  if (!peer || typeof peer.on !== 'function') {
    const desc = peer ? typeof peer : 'missing';
    throw new Error(
      `PeerJS initialized incorrectly (instance is ${desc}). Reload the page and retry.`,
    );
  }
  return peer;
}

export const MAX_USERNAME_LENGTH = 40;
export const MAX_MESSAGE_LENGTH = 2000;
/** Host drops clients silent longer than this (no close event on mobile kills). */
const CLIENT_PRUNE_MS = 15000;
const PRUNE_CHECK_MS = 5000;

export class PeerManager {
  /**
   * @param {object} cbs
   * @param {(text:string,color?:string)=>void} cbs.onStatus
   * @param {(text:string)=>void} cbs.onSystemMessage
   * @param {(sender:string,text:string,isSelf:boolean)=>void} cbs.onChatMessage
   * @param {(view:object,isHost:boolean,myId:string)=>void} cbs.onHostPeerList
   * @param {(users:Array,locked:boolean,myId:string)=>void} cbs.onClientPeerList
   * @param {(isHost:boolean,hostId:string)=>void} cbs.onRoleChanged
   * @param {(username:string)=>void} [cbs.onTyping]
   * @param {(locked:boolean)=>void} [cbs.onLockChanged]
   * @param {(username:string,fromId:string)=>void} [cbs.onNudge]
   * @param {(msg:object)=>void} [cbs.onCallSignal]
   * @param {(msg:object)=>void} [cbs.onFileSignal]
   * @param {(call:any)=>void} [cbs.onIncomingMediaCall]
   * @param {()=>void} [cbs.onDenied]
   * @param {()=>void} [cbs.onE2EEError]
   * @param {(active:boolean)=>void} [cbs.onKeepAlive]
   */
  constructor(cbs = {}) {
    this.cbs = cbs;
    this.peer = null;
    /** peerId -> { conn, username, joinedAt, hasJoined } (real remote peers only) */
    this.connections = Object.create(null);
    this.myId = '';
    this.myUsername = '';
    this.isHost = false;
    /** Active host/relay id. For a host this equals myId. */
    this.hostId = '';
    /** Ordered roster: [{ id, username, joinedAt, isHost }] */
    this.roster = [];
    this.roomPeersList = []; // last user-list seen as a client
    this.cryptoKey = null;
    this.passphrase = '';
    this.hadKeyInUrl = false;
    // --- room password gate (hashes only; plaintext never stored) ---
    this.roomLocked = false;
    this.roomSalt = '';
    this.passwordVerifier = null;
    this._pwHash = null; // this client's salted verifier, sent on join
    this._joinPassword = '';
    // --- host epoch (stale-takeover protection) ---
    this.hostEpoch = 0;
    this.mesh = null;
    this._msgCounter = 0;
    this._seenMsgIds = new Set();
    this._failoverWaitTimer = null;
    this._pruneTimer = null;
    this._joinTimer = null;
    this._lastTypingSent = 0;
    this._lastDecryptWarn = 0;
    // --- stable room link (survives the original host leaving) ---
    /** Original room id from the invite link — the one permanent link. */
    this.roomId = '';
    /** Second Peer holding the room id after a promotion (entry point for late joiners). */
    this.aliasPeer = null;
    this._aliasTimer = null;
    this._aliasTries = 0;
    /** Join-side resilience: redials + redirect follows. */
    this._joinTries = 0;
    this._redirectHops = 0;

    this.status = (t, c) => this.cbs.onStatus?.(t, c);
    this.system = (t) => this.cbs.onSystemMessage?.(t);
  }

  /* ================= crypto ================= */

  async _initCrypto() {
    const hadKeyInUrl = !!getRoomPassphrase();
    const { key, passphrase } = await getOrCreateRoomKey();
    this.cryptoKey = key;
    this.passphrase = passphrase;
    this.hadKeyInUrl = hadKeyInUrl;
    return { hadKeyInUrl };
  }

  /* ================= mesh wiring ================= */

  _createMesh() {
    if (this.mesh) this.mesh.stop();
    this.mesh = new MeshNetwork({
      getMyId: () => this.myId,
      getHostId: () => this.hostId,
      getRoster: () => this.roster,
      amIHost: () => this.isHost,
      sendToAll: (msg) => this._sendRawToAll(msg),
      connectToPeer: (id) => {
        if (this.isHost) this._dialAsHost(id);
        else this._dialAsClient(id);
      },
      onPromotedToHost: () => this.promoteToHost(),
      onHostChanged: (newHostId, epoch) => this.adoptNewHost(newHostId, epoch),
      onLog: (t) => this.system(t),
    });
  }

  _peerErrorMessage(err) {
    switch (err?.type) {
      case 'browser-incompatible': return 'This browser does not support WebRTC.';
      case 'network':
      case 'server-error':
      case 'socket-error': return 'Network issue reaching the signalling server. Retrying...';
      case 'peer-unavailable': return 'Peer could not be reached (it may have left).';
      default: return 'Peer error: ' + (err?.type || 'unknown');
    }
  }

  _handlePeerError(err, { unavailableIsFatal } = {}) {
    if (err?.type === 'peer-unavailable' && !unavailableIsFatal) {
      // Expected when (re)dialling dead roster entries during failover.
      this.system('A peer could not be reached (it may have left).');
      return;
    }
    if (err?.type === 'peer-unavailable') {
      this.status('Connection Failed', 'text-red-400');
      this.system('Connection failed: could not find room. Check the Room Code.');
      return;
    }
    this.status('Error: ' + (err?.type || 'unknown'), 'text-red-400');
    this.system(this._peerErrorMessage(err));
  }

  /* ================= room lifecycle ================= */

  async createRoom(username, opts = {}) {
    if (!username) throw new Error('Username required');
    await ensurePeerJS();
    this.myUsername = username;
    this.isHost = true;
    this._joinPassword = String(opts.password || '');
    this.status('Creating P2P Room...', 'text-amber-400');

    await this._initCrypto();
    this._createMesh();

    this.peer = buildPeer();

    this.peer.on('open', async (id) => {
      this.myId = id;
      this.hostId = id;
      this.roomId = id; // the permanent room link id
      this.roomSalt = id;
      this.hostEpoch = 0;
      // Derive the password verifier now; the plaintext is dropped immediately.
      if (this._joinPassword) {
        try {
          this.passwordVerifier = await passwordVerifier(this._joinPassword, this.roomSalt);
          this.roomLocked = true;
        } catch (_) {
          this.system('Password setup failed — room left unlocked.');
        }
      }
      this._joinPassword = '';
      this.roster = [{ id, username: `${username} (Host)`, joinedAt: 0, isHost: true }];
      this.mesh.start();
      enableMobileKeepAlive();
      this.cbs.onKeepAlive?.(true);
      this.status('Room Active (Hosting)', 'text-emerald-400');
      this.cbs.onRoleChanged?.(true, id);
      this._startHostPrune();
      this._renderHostList();
      this.system('Room created successfully. Share your Room Code + invite link!');
      this.cbs.onReady?.(id, true);
    });

    this.peer.on('connection', (incomingConn) => {
      // Late/duplicate dials from an already-connected peer: drop the extra.
      const existing = this.connections[incomingConn.peer];
      if (existing && existing.conn && existing.conn.open) {
        try { incomingConn.on('open', () => incomingConn.close()); } catch (_) {}
        return;
      }
      this._attachHostSide(incomingConn);
    });

    this.peer.on('call', (call) => this.cbs.onIncomingMediaCall?.(call));

    this.peer.on('disconnected', () => {
      this.status('Lost signalling connection — reconnecting...', 'text-amber-400');
      try { this.peer.reconnect(); } catch (_) {}
    });

    this.peer.on('error', (err) => this._handlePeerError(err));
  }

  async joinRoom(username, roomCode, opts = {}) {
    if (!username) throw new Error('Username required');
    if (!roomCode) throw new Error('Room code required');
    await ensurePeerJS();
    this.myUsername = username;
    this.isHost = false;
    this.hostId = roomCode;
    this.roomId = roomCode; // the permanent link id (may outlive the original host)
    this._joinPassword = String(opts.password || '');
    this._joinTries = 0;
    this._redirectHops = 0;
    this.status('Connecting to Host...', 'text-amber-400');

    const { hadKeyInUrl } = await this._initCrypto();
    this._createMesh();

    this.peer = buildPeer();

    this.peer.on('open', (id) => {
      this.myId = id;
      // Seed the roster so failover ordering works even before user-list.
      this.roster = [
        { id: roomCode, username: 'Host', joinedAt: 0, isHost: true },
        { id, username, joinedAt: Date.now(), isHost: false },
      ];
      this.mesh.start();
      this.mesh.updateRoster(this.roster);
      enableMobileKeepAlive();
      this.cbs.onKeepAlive?.(true);
      this._dialAsClient(roomCode);
      if (!hadKeyInUrl) {
        this.system('No encryption key in link — ask the host for the full invite link, or messages may fail to decrypt.');
      }
    });

    this.peer.on('connection', (incomingConn) => {
      // After a host migration the new host dials us: treat inbound as host-side link.
      // Drop duplicates if we already hold an open link to this peer.
      const existing = this.connections[incomingConn.peer];
      if (existing && existing.conn && existing.conn.open) {
        try { incomingConn.on('open', () => incomingConn.close()); } catch (_) {}
        return;
      }
      this._attachClientSide(incomingConn);
    });

    this.peer.on('call', (call) => this.cbs.onIncomingMediaCall?.(call));

    this.peer.on('disconnected', () => {
      this.status('Lost signalling connection — reconnecting...', 'text-amber-400');
      try { this.peer.reconnect(); } catch (_) {}
    });

    this.peer.on('error', (err) => {
      // The room id may be briefly unclaimed while a new host takes over
      // after the original host left — redial a few times before giving up.
      // Redials go back to the room alias (not a possibly-dead personal id)
      // so chained migrations still converge on whoever is live.
      if (err?.type === 'peer-unavailable' && !this.isHost && this._joinTries < 3) {
        const hostConn = this.connections[this.hostId]?.conn;
        if (!hostConn || !hostConn.open) {
          this._joinTries += 1;
          this.status(`Host is switching over — retrying... (${this._joinTries}/3)`, 'text-amber-400');
          setTimeout(() => {
            if (!this.isHost && (!this.connections[this.hostId] || !this.connections[this.hostId].conn?.open)) {
              try { this._dialAsClient(this.roomId || this.hostId); } catch (_) {}
            }
          }, 2500);
          return;
        }
      }
      this._handlePeerError(err, { unavailableIsFatal: true });
    });
  }

  /* ================= connection attach ================= */

  _attachHostSide(conn) {
    conn.on('data', (data) => this.handleHostData(conn, data));
    conn.on('open', () => {
      // Greet diallers with the salt + lock state so they can join
      // without ever sending the password in clear.
      if (this.isHost && conn.open) {
        try { conn.send({ type: 'welcome', salt: this.roomSalt, locked: this.roomLocked }); } catch (_) {}
      }
    });
    conn.on('close', () => this._removeClient(conn.peer));
    conn.on('error', () => this._removeClient(conn.peer));
  }

  _sendJoin(conn, salt) {
    if (!conn || this.isHost) return;
    const s = salt || this.hostId;
    const send = () => {
      try { conn.send({ type: 'join', username: this.myUsername, pwHash: this._pwHash }); } catch (_) {}
    };
    if (this._joinPassword) {
      passwordVerifier(this._joinPassword, s).then(
        (h) => { this._pwHash = h; this._joinPassword = ''; send(); },
        () => { this._pwHash = null; send(); },
      );
    } else {
      this._pwHash = null;
      send();
    }
  }

  _attachClientSide(conn) {
    conn.on('open', () => {
      if (this.isHost) return; // role changed while dial in flight
      // Prefer the host's welcome (carries the true salt); fall back to a
      // room-code-salted join if the greeting never arrives.
      if (this._joinTimer) clearTimeout(this._joinTimer);
      this._joinTimer = setTimeout(() => this._sendJoin(conn, this.hostId), 4000);
    });
    conn.on('data', (data) => this.handleClientData(data, conn.peer));
    conn.on('close', () => this._handleHostLinkClosed(conn.peer));
    conn.on('error', () => this._handleHostLinkClosed(conn.peer));
  }

  _dialAsHost(peerId) {
    if (!peerId || peerId === this.myId) return;
    const existing = this.connections[peerId];
    if (existing && existing.conn && existing.conn.open) return;
    try {
      const conn = this.peer.connect(peerId, { reliable: true });
      this.connections[peerId] = { conn, username: 'Peer', joinedAt: Date.now() };
      this._attachHostSide(conn);
      conn.on('open', () => {
        // Re-assert relay state to freshly dialled peers.
        try {
          conn.send({ type: 'HOST_PROMOTED', newHostId: this.myId, epoch: this.hostEpoch });
          this._sendUserListTo(conn);
        } catch (_) {}
      });
    } catch (_) {}
  }

  _dialAsClient(hostId) {
    if (!hostId || hostId === this.myId) return;
    try {
      const conn = this.peer.connect(hostId, { reliable: true });
      this.connections[hostId] = { conn, username: 'Host', joinedAt: 0 };
      this._attachClientSide(conn);
      // Fail-safe: if the host link never opens, surface it (mesh still watches).
      setTimeout(() => {
        if (!conn.open && !this.isHost && this.hostId === hostId) {
          this.status('Still connecting... (host may be unreachable)', 'text-amber-400');
        }
      }, 6000);
    } catch (_) {}
  }

  _removeClient(peerId) {
    const entry = this.connections[peerId];
    if (!entry) return;
    delete this.connections[peerId];
    const idx = this.roster.findIndex((m) => m.id === peerId);
    const name = idx >= 0 ? this.roster[idx].username : entry.username || 'Peer';
    if (idx >= 0) this.roster.splice(idx, 1);
    if (this.isHost) {
      this.system(`${name} left the room.`);
      this.broadcastUserList();
      this._renderHostList();
    }
  }

  _handleHostLinkClosed(peerId) {
    // Our link to ( who we think is ) the host dropped. Don't reload like the
    // legacy build — wait for mesh failover / HOST_PROMOTED first.
    delete this.connections[peerId];
    if (this.isHost) return; // stale link, ignore
    if (peerId !== this.hostId) return; // a duplicate/old link, ignore
    this.status('Host connection lost — waiting for failover...', 'text-amber-400');
    this.system('Host connection lost. Waiting for a new host to take over...');
    if (this._failoverWaitTimer) clearTimeout(this._failoverWaitTimer);
    this._failoverWaitTimer = setTimeout(() => {
      if (!this.isHost && (!this.connections[this.hostId] || !this.connections[this.hostId].conn?.open)) {
        this.status('Disconnected from room', 'text-red-400');
        this.system('Could not reach a new host. You can leave and rejoin with a fresh code.');
      }
    }, 12000);
  }

  /* ================= nudge + call signalling ================= */

  /** Room-wide attention buzz (relayed to every peer). Returns false if nobody is connected. */
  sendNudge() {
    const username = this.isHost ? `${this.myUsername} (Host)` : this.myUsername;
    if (!username) return false;
    if (!Object.keys(this.connections).length) return false;
    this._sendRawToAll({ type: 'nudge', from: this.myId, username });
    return true;
  }

  /**
   * 1:1 call signalling. Hosts send direct; guests route via the host
   * (`to` field) which forwards to the target.
   */
  sendCallSignal(partial) {
    const msg = {
      ...partial,
      from: this.myId,
      username: this.isHost ? `${this.myUsername} (Host)` : this.myUsername,
    };
    if (!msg.to) return false;
    if (this.isHost) {
      const c = this.connections[msg.to]?.conn;
      if (c && c.open) {
        try { c.send(msg); return true; } catch (_) { return false; }
      }
      return false;
    }
    const h = this.connections[this.hostId]?.conn;
    if (h && h.open) {
      try { h.send(msg); return true; } catch (_) { return false; }
    }
    return false;
  }

  _relayCallSignal(data) {
    // Host side: deliver to self or forward to the target peer.
    if (data.to === this.myId) {
      this.cbs.onCallSignal?.(data);
      return;
    }
    const c = data.to && this.connections[data.to]?.conn;
    if (c && c.open) {
      try { c.send(data); } catch (_) {}
    }
  }

  /**
   * 1:1 file signalling + chunks. Same routing as calls: hosts send
   * direct, guests route via the host (`to` field) which forwards.
   */
  sendFileSignal(partial) {
    const msg = {
      ...partial,
      from: this.myId,
      username: this.isHost ? `${this.myUsername} (Host)` : this.myUsername,
    };
    if (!msg.to) return false;
    if (this.isHost) {
      if (msg.to === this.myId) {
        this.cbs.onFileSignal?.(msg);
        return true;
      }
      const c = this.connections[msg.to]?.conn;
      if (c && c.open) {
        try { c.send(msg); return true; } catch (_) { return false; }
      }
      return false;
    }
    const h = this.connections[this.hostId]?.conn;
    if (h && h.open) {
      try { h.send(msg); return true; } catch (_) { return false; }
    }
    return false;
  }

  _relayFileSignal(data) {
    // Host side: deliver to self or forward to the target peer.
    if (data.to === this.myId) {
      this.cbs.onFileSignal?.(data);
      return;
    }
    const c = data.to && this.connections[data.to]?.conn;
    if (c && c.open) {
      try { c.send(data); } catch (_) {}
    }
  }

  /* ================= data handlers ================= */

  async handleHostData(incomingConn, data) {
    if (!data || typeof data.type !== 'string') return;
    this.mesh?.recordActivity(incomingConn.peer);
    if (this.mesh?.handleMessage(data, incomingConn.peer)) return; // PING / HOST_PROMOTED

    if (data.type === 'nudge') {
      const who = String(data.username || 'Someone').slice(0, MAX_USERNAME_LENGTH);
      for (const peerId in this.connections) {
        if (peerId === incomingConn.peer) continue;
        const c = this.connections[peerId].conn;
        if (c && c.open) {
          try { c.send(data); } catch (_) {}
        }
      }
      this.cbs.onNudge?.(who, incomingConn.peer);
      return;
    }
    if (data.type.startsWith('call-')) {
      this._relayCallSignal(data);
      return;
    }
    if (data.type.startsWith('file-')) {
      this._relayFileSignal(data);
      return;
    }

    if (data.type === 'join') {
      const username = String(data.username || 'Anonymous').slice(0, MAX_USERNAME_LENGTH);
      // Password gate: compare salted verifiers, plaintext never crosses the wire.
      if (this.roomLocked) {
        const ok = verifiersEqual(data.pwHash, this.passwordVerifier);
        if (!ok) {
          try { incomingConn.send({ type: 'denied', reason: 'wrong-password' }); } catch (_) {}
          setTimeout(() => { try { incomingConn.close(); } catch (_) {} }, 400);
          this.system(`Rejected join from ${username} (wrong password).`);
          return;
        }
      }
      const isRejoin = !!this.connections[incomingConn.peer]?.hasJoined;
      this.connections[incomingConn.peer] = {
        conn: incomingConn,
        username,
        joinedAt: this.connections[incomingConn.peer]?.joinedAt || Date.now(),
        hasJoined: true,
      };
      this.mesh?.recordActivity(incomingConn.peer);
      this._upsertRoster(incomingConn.peer, username, false);
      if (!isRejoin) this.system(`${username} joined the room.`);
      this.broadcastUserList();
      this._renderHostList();
    } else if (data.type === 'chat') {
      const text = await this._decryptChatPayload(data);
      if (text === null) return; // error already surfaced
      const sender = String(data.username || 'Anonymous').slice(0, MAX_USERNAME_LENGTH);
      const senderId = typeof data.from === 'string' ? data.from : '';
      const msgId = data.msgId;
      if (msgId) {
        if (this._seenMsgIds.has(msgId)) return;
        this._rememberMsgId(msgId);
      }
      // Relay ciphertext (not plaintext) so the relay never needs the key in clear.
      const relay = { type: 'chat', username: sender, from: senderId, msgId };
      if (data.encrypted) relay.encrypted = data.encrypted;
      else relay.text = text; // legacy plaintext peer
      const self = senderId ? senderId === this.myId : sender === `${this.myUsername} (Host)`;
      this.cbs.onChatMessage?.(sender, text, self);
      for (const peerId in this.connections) {
        const c = this.connections[peerId].conn;
        if (c && c.open) {
          try { c.send(relay); } catch (_) {} // relay to all, incl. sender (legacy parity)
        }
      }
    } else if (data.type === 'leave') {
      this._removeClient(incomingConn.peer);
    } else if (data.type === 'typing') {
      const who = String(data.username || 'Someone').slice(0, MAX_USERNAME_LENGTH);
      // Relay to everyone else so all guests see it.
      for (const peerId in this.connections) {
        if (peerId === incomingConn.peer) continue;
        const c = this.connections[peerId].conn;
        if (c && c.open) {
          try { c.send({ type: 'typing', username: who }); } catch (_) {}
        }
      }
      this.cbs.onTyping?.(who);
    }
  }

  async handleClientData(data, fromId) {
    if (!data || typeof data.type !== 'string') return;
    this.mesh?.recordActivity(fromId || this.hostId);
    if (this.mesh?.handleMessage(data, fromId || this.hostId)) return;

    if (data.type === 'nudge') {
      const who = String(data.username || 'Someone').slice(0, MAX_USERNAME_LENGTH);
      this.cbs.onNudge?.(who, data.from || fromId);
      return;
    }
    if (data.type.startsWith('call-')) {
      if (!data.to || data.to === this.myId) this.cbs.onCallSignal?.(data);
      return;
    }
    if (data.type.startsWith('file-')) {
      if (!data.to || data.to === this.myId) this.cbs.onFileSignal?.(data);
      return;
    }

    if (data.type === 'chat') {
      const text = await this._decryptChatPayload(data);
      if (text === null) return;
      const sender = String(data.username || 'Anonymous');
      const senderId = typeof data.from === 'string' ? data.from : '';
      const msgId = data.msgId;
      if (msgId) {
        if (this._seenMsgIds.has(msgId)) return;
        this._rememberMsgId(msgId);
      }
      const self = senderId ? senderId === this.myId : sender === this.myUsername;
      this.cbs.onChatMessage?.(sender, text, self);
    } else if (data.type === 'user-list') {
      if (Array.isArray(data.roster) && data.roster.length) {
        this.roster = data.roster;
      } else if (Array.isArray(data.users)) {
        this.roster = data.users.map((u, i) => ({
          id: u.id ?? `idx-${i}`,
          username: u.username ?? 'Peer',
          joinedAt: u.joinedAt ?? i,
          isHost: !!u.isHost,
        }));
      }
      if (data.hostId) this.hostId = data.hostId;
      if (typeof data.epoch === 'number') this.hostEpoch = Math.max(this.hostEpoch, data.epoch);
      if (data.salt) this.roomSalt = data.salt;
      if (typeof data.pwVerifier === 'string') {
        this.passwordVerifier = data.pwVerifier;
        this.roomLocked = true;
      } else if (typeof data.locked === 'boolean') {
        this.roomLocked = data.locked;
      }
      this.roomPeersList = data.users || [];
      this.mesh?.recordActivity(this.hostId);
      this.mesh?.updateRoster(this.roster);
      this._redirectHops = 0; // joined cleanly — redirect budget restored
      this.cbs.onClientPeerList?.(this.roomPeersList, this.roomLocked, this.myId);
    } else if (data.type === 'welcome') {
      // Host greeting: join using the room's true salt (post-migration safe).
      // Only honored from the active host or a known roster member.
      const known = fromId === this.hostId || this.roster.some((m) => m.id === fromId);
      if (!known || this.isHost) return;
      if (this._joinTimer) clearTimeout(this._joinTimer);
      const conn = this.connections[fromId]?.conn;
      if (conn) this._sendJoin(conn, data.salt || this.hostId);
      if (typeof data.locked === 'boolean') {
        this.roomLocked = data.locked;
        this.cbs.onLockChanged?.(data.locked);
      }
    } else if (data.type === 'typing') {
      this.cbs.onTyping?.(String(data.username || 'Someone').slice(0, MAX_USERNAME_LENGTH));
    } else if (data.type === 'denied') {
      this.system('Join rejected by host.');
      this.cbs.onDenied?.(data.reason || 'denied');
    } else if (data.type === 'redirect') {
      // Late join on the permanent room link: the alias holder points us
      // at the live host. Follow it (capped) instead of joining the alias.
      const target = typeof data.hostId === 'string' ? data.hostId : '';
      if (!target || target === this.myId || this.isHost) return;
      if (this._redirectHops >= 4 || target === this.hostId) return;
      this._redirectHops += 1;
      if (this._joinTimer) clearTimeout(this._joinTimer);
      const oldHost = this.hostId;
      const old = this.connections[oldHost];
      try { old?.conn?.close(); } catch (_) {}
      delete this.connections[oldHost];
      this.hostId = target;
      // Reseed ordering around the live host so failover keeps working.
      this.roster = [
        { id: target, username: 'Host', joinedAt: 0, isHost: true },
        { id: this.myId, username: this.myUsername, joinedAt: Date.now(), isHost: false },
      ];
      this.mesh?.updateRoster(this.roster);
      this.status('Found the live host — connecting...', 'text-amber-400');
      this._dialAsClient(target);
    } else if (data.type === 'kick') {
      this.system('You have been kicked by the host.');
      this.cbs.onKicked?.();
    }
  }

  async _decryptChatPayload(data) {
    try {
      if (data.encrypted) {
        if (!this.cryptoKey) throw new Error('no key');
        return await decryptMessage(data.encrypted, this.cryptoKey);
      }
      if (typeof data.text === 'string') return data.text; // legacy plaintext
      throw new Error('empty payload');
    } catch (_) {
      // Throttle: a flood of bad ciphertext must not spam the log.
      const now = Date.now();
      if (now - this._lastDecryptWarn > 5000) {
        this._lastDecryptWarn = now;
        this.system('Could not decrypt a message (wrong room key?). Open the full invite link.');
        this.cbs.onE2EEError?.();
      }
      return null;
    }
  }

  _rememberMsgId(id) {
    this._seenMsgIds.add(id);
    if (this._seenMsgIds.size > 300) {
      const first = this._seenMsgIds.values().next().value;
      this._seenMsgIds.delete(first);
    }
  }

  /* ================= messaging ================= */

  async sendChatMessage(text) {
    const clean = String(text || '').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!clean) return;
    if (!this.cryptoKey) {
      this.system('Encryption not ready yet — try again in a moment.');
      return;
    }
    const msgId = `${this.myId || 'me'}-${Date.now()}-${this._msgCounter++}`;
    let encrypted = null;
    try {
      encrypted = await encryptMessage(clean, this.cryptoKey);
    } catch (_) {
      this.system('Encryption failed in this browser.');
      return;
    }

    if (this.isHost) {
      const displayName = `${this.myUsername} (Host)`;
      this.cbs.onChatMessage?.(displayName, clean, true);
      this._rememberMsgId(msgId);
      const payload = { type: 'chat', username: displayName, from: this.myId, encrypted, msgId };
      for (const peerId in this.connections) {
        const c = this.connections[peerId].conn;
        if (c && c.open) {
          try { c.send(payload); } catch (_) {}
        }
      }
    } else {
      const payload = { type: 'chat', username: this.myUsername, from: this.myId, encrypted, msgId };
      const hostConn = this.connections[this.hostId]?.conn;
      if (hostConn && hostConn.open) {
        try {
          hostConn.send(payload);
          // Optimistic echo: the relay echo carries the same msgId and is
          // dropped by dedup, so this can never double-render.
          this._rememberMsgId(msgId);
          this.cbs.onChatMessage?.(this.myUsername, clean, true);
        } catch (_) {
          this.system('Not connected to host — message not sent.');
        }
      } else {
        this.system('Not connected to host — message not sent.');
      }
    }
  }

  /** Throttled "is typing" ping (relayed by the host to all guests). */
  sendTyping() {
    const now = Date.now();
    if (now - this._lastTypingSent < 2500) return;
    this._lastTypingSent = now;
    const name = this.isHost ? `${this.myUsername} (Host)` : this.myUsername;
    if (!name) return;
    this._sendRawToAll({ type: 'typing', username: name });
  }

  /* ================= roster / user list ================= */

  _upsertRoster(id, username, isHost, joinedAt = Date.now()) {
    const existing = this.roster.find((m) => m.id === id);
    if (existing) {
      existing.username = username;
      existing.isHost = isHost;
    } else {
      this.roster.push({ id, username, joinedAt, isHost });
    }
    this.roster.sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
  }

  broadcastUserList() {
    if (!this.isHost) return;
    // Rebuild roster from live connections to drop ghosts.
    const fresh = [{ id: this.myId, username: `${this.myUsername} (Host)`, joinedAt: 0, isHost: true }];
    for (const peerId in this.connections) {
      const e = this.connections[peerId];
      if (e.conn) {
        fresh.push({ id: peerId, username: e.username || 'Peer', joinedAt: e.joinedAt || Date.now(), isHost: false });
      }
    }
    fresh.sort((a, b) => a.joinedAt - b.joinedAt);
    this.roster = fresh;
    const users = fresh.map((m) => ({ id: m.id, username: m.username, isHost: m.isHost, joinedAt: m.joinedAt }));
    const payload = {
      type: 'user-list', users, roster: fresh, hostId: this.myId,
      locked: this.roomLocked, salt: this.roomSalt,
      pwVerifier: this.passwordVerifier, epoch: this.hostEpoch,
    };
    for (const peerId in this.connections) {
      const c = this.connections[peerId].conn;
      if (c && c.open) {
        try { c.send(payload); } catch (_) {}
      }
    }
    this.mesh?.updateRoster(this.roster);
  }

  _sendUserListTo(conn) {
    if (!this.isHost || !conn || !conn.open) return;
    const users = this.roster.map((m) => ({ id: m.id, username: m.username, isHost: m.isHost, joinedAt: m.joinedAt }));
    try {
      conn.send({
        type: 'user-list', users, roster: this.roster, hostId: this.myId,
        locked: this.roomLocked, salt: this.roomSalt,
        pwVerifier: this.passwordVerifier, epoch: this.hostEpoch,
      });
    } catch (_) {}
  }

  _renderHostList() {
    // Show only self + peers with a live connection object (no ghosts,
    // no dead Kick buttons).
    const view = { [this.myId]: { username: `${this.myUsername} (Host)`, isHost: true } };
    for (const m of this.roster) {
      if (m.id !== this.myId && this.connections[m.id]) {
        view[m.id] = { username: m.username || 'Peer', isHost: false };
      }
    }
    this.cbs.onHostPeerList?.(view, this.isHost, this.myId);
  }

  /* ================= stale-client pruning (host only) ================= */

  _startHostPrune() {
    this._stopHostPrune();
    this._pruneTimer = setInterval(() => {
      if (!this.isHost || !this.mesh) return;
      const now = Date.now();
      let changed = false;
      for (const peerId in this.connections) {
        const last = this.mesh.lastSeen.get(peerId) || 0;
        if (now - last > CLIENT_PRUNE_MS) {
          const name = this.connections[peerId].username || 'Peer';
          try { this.connections[peerId].conn?.close(); } catch (_) {}
          delete this.connections[peerId];
          this.roster = this.roster.filter((m) => m.id !== peerId);
          this.system(`${name} timed out and was removed.`);
          changed = true;
        }
      }
      if (changed) {
        this.broadcastUserList();
        this._renderHostList();
      }
    }, PRUNE_CHECK_MS);
  }

  _stopHostPrune() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    this._pruneTimer = null;
  }

  /* ================= host migration ================= */

  /**
   * Keep the ONE shared invite link working after the original host leaves.
   * The promoted host claims the original room id with a second Peer and
   * redirects late joiners to its live id. Retries with backoff: the id
   * frees up a few seconds after the old host disconnects, and only one
   * claimant can hold it.
   */
  holdRoomAlias() {
    if (!this.isHost || !this.roomId || this.roomId === this.myId) return;
    this.releaseRoomAlias();
    this._aliasTries = 0;
    const claim = () => {
      if (!this.isHost || this.aliasPeer) return;
      let peer = null;
      try {
        peer = buildPeer(this.roomId);
      } catch (_) {
        return;
      }
      this.aliasPeer = peer;
      peer.on('open', () => {
        this._aliasTries = 0;
      });
      peer.on('connection', (conn) => {
        // Entry point only: point the late joiner at the live host id.
        try {
          conn.on('open', () => {
            try {
              conn.send({ type: 'redirect', hostId: this.myId, epoch: this.hostEpoch, roomId: this.roomId });
            } catch (_) {}
            setTimeout(() => { try { conn.close(); } catch (_) {} }, 800);
          });
        } catch (_) {}
      });
      peer.on('disconnected', () => {
        try { peer.reconnect(); } catch (_) {}
      });
      peer.on('error', (err) => {
        if (err?.type === 'unavailable-id') {
          // Someone else holds the room id (original host still alive or a
          // racing successor won). Back off and retry while we're host.
          try { peer.destroy(); } catch (_) {}
          if (this.aliasPeer === peer) this.aliasPeer = null;
          this._aliasTries += 1;
          if (this.isHost && this._aliasTries <= 6) {
            if (this._aliasTimer) clearTimeout(this._aliasTimer);
            const delay = 2000 * this._aliasTries + Math.floor(Math.random() * 1000);
            this._aliasTimer = setTimeout(claim, delay);
          }
          return;
        }
        // Other alias errors are non-fatal (main peer is unaffected).
      });
    };
    claim();
  }

  releaseRoomAlias() {
    if (this._aliasTimer) clearTimeout(this._aliasTimer);
    this._aliasTimer = null;
    if (this.aliasPeer) {
      try { this.aliasPeer.destroy(); } catch (_) {}
      this.aliasPeer = null;
    }
  }

  promoteToHost() {
    if (this.isHost) return;
    if (this._failoverWaitTimer) clearTimeout(this._failoverWaitTimer);
    const oldHost = this.hostId;
    delete this.connections[oldHost];
    this.isHost = true;
    this.hostId = this.myId;
    // Mark self as host in roster, keep original join order.
    let selfEntry = this.roster.find((m) => m.id === this.myId);
    if (!selfEntry) {
      selfEntry = { id: this.myId, username: `${this.myUsername} (Host)`, joinedAt: Date.now(), isHost: true };
      this.roster.push(selfEntry);
    } else {
      selfEntry.username = `${this.myUsername} (Host)`;
      selfEntry.isHost = true;
    }
    for (const m of this.roster) {
      if (m.id !== this.myId) m.isHost = false;
    }
    // Drop the dead host from ordering so future failovers chain correctly.
    this.roster = this.roster.filter((m) => m.id !== oldHost);
    this.roster.sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));

    this.mesh?.recordActivity(this.myId);
    this.hostEpoch += 1; // outrank any stale announcements in flight
    this.status('Room Active (Hosting — promoted)', 'text-emerald-400');
    this.cbs.onRoleChanged?.(true, this.myId);
    this.system(`Host lost. ${this.myUsername} is now hosting 👑`);
    this._startHostPrune();

    // Dial every surviving roster peer, then announce.
    for (const m of this.roster) {
      if (m.id !== this.myId) this._dialAsHost(m.id);
    }
    this.mesh?.announcePromotion(this.myId, this.hostEpoch);
    this.broadcastUserList();
    this._renderHostList();
    // Hold the permanent room link so late joiners with the old invite
    // still land here (redirected from the room id to this live host).
    this.holdRoomAlias();
    // Re-announce shortly after dials open (dials complete async).
    setTimeout(() => {
      this.mesh?.announcePromotion(this.myId, this.hostEpoch);
      this.broadcastUserList();
    }, 1500);
  }

  adoptNewHost(newHostId, epoch = 0) {
    if (!newHostId || newHostId === this.myId || newHostId === this.hostId) return;
    if (this.isHost) return; // two hosts should never happen; ignore foreign claims
    this.releaseRoomAlias(); // only the live host holds the room entry point
    // Light anti-spoofing: only adopt hosts already in our roster.
    if (this.roster.length && !this.roster.some((m) => m.id === newHostId)) return;
    // Stale-takeover protection: ignore announcements older than our host,
    // tie-break equal epochs deterministically by peer id.
    if (epoch < this.hostEpoch) return;
    if (epoch === this.hostEpoch && newHostId < this.hostId) return;
    this.hostEpoch = Math.max(this.hostEpoch, epoch);
    if (this._failoverWaitTimer) clearTimeout(this._failoverWaitTimer);
    const oldHost = this.hostId;
    delete this.connections[oldHost];
    this.hostId = newHostId;
    for (const m of this.roster) m.isHost = m.id === newHostId;
    if (!this.roster.some((m) => m.id === newHostId)) {
      this.roster.push({ id: newHostId, username: 'Host', joinedAt: 1, isHost: true });
      this.roster.sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
    }
    this.mesh?.recordActivity(newHostId);
    this.status('Connected to Room (new host)', 'text-emerald-400');
    this.system('New host took over 👑 Reconnecting...');
    // Connect to the new relay if we aren't already linked.
    const existing = this.connections[newHostId];
    if (!existing || !existing.conn || !existing.conn.open) {
      this._dialAsClient(newHostId);
    }
  }

  /* ================= admin ================= */

  kickUser(peerId) {
    if (!this.isHost) return;
    const entry = this.connections[peerId];
    if (entry && entry.conn) {
      try { entry.conn.send({ type: 'kick' }); } catch (_) {}
      try { entry.conn.close(); } catch (_) {}
      const name = entry.username || peerId;
      delete this.connections[peerId];
      this.roster = this.roster.filter((m) => m.id !== peerId);
      this.system(`Kicked ${name}.`);
      this.broadcastUserList();
      this._renderHostList();
    }
  }

  _sendRawToAll(msg) {
    if (this.isHost) {
      for (const peerId in this.connections) {
        const c = this.connections[peerId].conn;
        if (c && c.open) {
          try { c.send(msg); } catch (_) {}
        }
      }
    } else {
      const hostConn = this.connections[this.hostId]?.conn;
      if (hostConn && hostConn.open) {
        try { hostConn.send(msg); } catch (_) {}
      }
      // Also ping any half-open links so a migrating host hears us.
      for (const peerId in this.connections) {
        if (peerId === this.hostId) continue;
        const c = this.connections[peerId].conn;
        if (c && c.open && msg.type === 'PING') {
          try { c.send(msg); } catch (_) {}
        }
      }
    }
  }

  leaveRoom() {
    try {
      if (!this.isHost && this.connections[this.hostId]?.conn?.open) {
        try { this.connections[this.hostId].conn.send({ type: 'leave' }); } catch (_) {}
      }
    } catch (_) {}
    try { this.mesh?.stop(); } catch (_) {}
    this._stopHostPrune();
    this.releaseRoomAlias();
    if (this._failoverWaitTimer) clearTimeout(this._failoverWaitTimer);
    if (this._joinTimer) clearTimeout(this._joinTimer);
    this._joinPassword = '';
    this._pwHash = null;
    try { disableMobileKeepAlive(); } catch (_) {}
    this.cbs.onKeepAlive?.(false);
    try { this.peer?.destroy(); } catch (_) {}
    clearCachedKey();
    clearRoomHash();
    this.peer = null;
    this.connections = Object.create(null);
  }
}
