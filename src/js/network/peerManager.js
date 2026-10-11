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
} from '../crypto/crypto.js';
import { MeshNetwork } from './meshNetwork.js';
import { enableMobileKeepAlive, disableMobileKeepAlive } from './silentAudio.js';

function peerJSGlobal() {
  return globalThis.Peer;
}

export class PeerManager {
  /**
   * @param {object} cbs
   * @param {(text:string,color?:string)=>void} cbs.onStatus
   * @param {(text:string)=>void} cbs.onSystemMessage
   * @param {(sender:string,text:string,isSelf:boolean)=>void} cbs.onChatMessage
   * @param {(view:object,isHost:boolean)=>void} cbs.onHostPeerList
   * @param {(users:Array)=>void} cbs.onClientPeerList
   * @param {(isHost:boolean,hostId:string)=>void} cbs.onRoleChanged
   * @param {(active:boolean)=>void} [cbs.onKeepAlive]
   */
  constructor(cbs = {}) {
    this.cbs = cbs;
    this.peer = null;
    /** peerId -> { conn, username, joinedAt } (real remote peers only) */
    this.connections = {};
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
    this.mesh = null;
    this._msgCounter = 0;
    this._seenMsgIds = new Set();
    this._failoverWaitTimer = null;

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
      onHostChanged: (newHostId) => this.adoptNewHost(newHostId),
      onLog: (t) => this.system(t),
    });
  }

  /* ================= room lifecycle ================= */

  async createRoom(username) {
    if (!username) throw new Error('Username required');
    if (!peerJSGlobal()) throw new Error('PeerJS failed to load (check network/CDN).');
    this.myUsername = username;
    this.isHost = true;
    this.status('Creating P2P Room...', 'text-amber-400');

    await this._initCrypto();
    this._createMesh();

    this.peer = new peerJSGlobal();

    this.peer.on('open', (id) => {
      this.myId = id;
      this.hostId = id;
      this.roster = [{ id, username: `${username} (Host)`, joinedAt: 0, isHost: true }];
      this.mesh.start();
      enableMobileKeepAlive();
      this.cbs.onKeepAlive?.(true);
      this.status('Room Active (Hosting)', 'text-emerald-400');
      this.cbs.onRoleChanged?.(true, id);
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

    this.peer.on('disconnected', () => {
      this.status('Lost signalling connection — reconnecting...', 'text-amber-400');
      try { this.peer.reconnect(); } catch (_) {}
    });

    this.peer.on('error', (err) => {
      this.status('Error: ' + (err?.type || 'unknown'), 'text-red-400');
      this.system('Peer error: ' + (err?.type || 'unknown'));
    });
  }

  async joinRoom(username, roomCode) {
    if (!username) throw new Error('Username required');
    if (!roomCode) throw new Error('Room code required');
    if (!peerJSGlobal()) throw new Error('PeerJS failed to load (check network/CDN).');
    this.myUsername = username;
    this.isHost = false;
    this.hostId = roomCode;
    this.status('Connecting to Host...', 'text-amber-400');

    const { hadKeyInUrl } = await this._initCrypto();
    this._createMesh();

    this.peer = new peerJSGlobal();

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

    this.peer.on('disconnected', () => {
      this.status('Lost signalling connection — reconnecting...', 'text-amber-400');
      try { this.peer.reconnect(); } catch (_) {}
    });

    this.peer.on('error', (err) => {
      if (err?.type === 'peer-unavailable') {
        this.status('Connection Failed', 'text-red-400');
        this.system('Connection failed: could not find room. Check the Room Code.');
      } else {
        this.status('Error: ' + (err?.type || 'unknown'), 'text-red-400');
      }
    });
  }

  /* ================= connection attach ================= */

  _attachHostSide(conn) {
    conn.on('data', (data) => this.handleHostData(conn, data));
    conn.on('open', () => {
      // Outgoing dials from a (possibly newly promoted) host complete here.
      // The client will send `join`; nothing to send yet.
    });
    conn.on('close', () => this._removeClient(conn.peer));
    conn.on('error', () => this._removeClient(conn.peer));
  }

  _attachClientSide(conn) {
    conn.on('open', () => {
      if (this.isHost) return; // role changed while dial in flight
      try { conn.send({ type: 'join', username: this.myUsername }); } catch (_) {}
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
          conn.send({ type: 'HOST_PROMOTED', newHostId: this.myId });
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

  /* ================= data handlers ================= */

  async handleHostData(incomingConn, data) {
    if (!data || typeof data.type !== 'string') return;
    this.mesh?.recordActivity(incomingConn.peer);
    if (this.mesh?.handleMessage(data, incomingConn.peer)) return; // PING / HOST_PROMOTED

    if (data.type === 'join') {
      const username = String(data.username || 'Anonymous').slice(0, 40);
      this.connections[incomingConn.peer] = {
        conn: incomingConn,
        username,
        joinedAt: Date.now(),
      };
      this.mesh?.recordActivity(incomingConn.peer);
      this._upsertRoster(incomingConn.peer, username, false);
      this.system(`${username} joined the room.`);
      this.broadcastUserList();
      this._renderHostList();
    } else if (data.type === 'chat') {
      const text = await this._decryptChatPayload(data);
      if (text === null) return; // error already surfaced
      const sender = String(data.username || 'Anonymous').slice(0, 40);
      const msgId = data.msgId;
      if (msgId) {
        if (this._seenMsgIds.has(msgId)) return;
        this._rememberMsgId(msgId);
      }
      // Relay ciphertext (not plaintext) so the relay never needs the key in clear.
      const relay = { type: 'chat', username: sender, msgId };
      if (data.encrypted) relay.encrypted = data.encrypted;
      else relay.text = text; // legacy plaintext peer
      this.cbs.onChatMessage?.(sender, text, sender === `${this.myUsername} (Host)` || sender === this.myUsername);
      for (const peerId in this.connections) {
        const c = this.connections[peerId].conn;
        if (c && c.open && peerId !== incomingConn.peer) {
          try { c.send(relay); } catch (_) {}
        } else if (c && c.open && peerId === incomingConn.peer) {
          try { c.send(relay); } catch (_) {} // echo incl. sender (legacy parity)
        }
      }
    } else if (data.type === 'leave') {
      this._removeClient(incomingConn.peer);
    }
  }

  async handleClientData(data, fromId) {
    if (!data || typeof data.type !== 'string') return;
    this.mesh?.recordActivity(fromId || this.hostId);
    if (this.mesh?.handleMessage(data, fromId || this.hostId)) return;

    if (data.type === 'chat') {
      const text = await this._decryptChatPayload(data);
      if (text === null) return;
      const sender = String(data.username || 'Anonymous');
      const msgId = data.msgId;
      if (msgId) {
        if (this._seenMsgIds.has(msgId)) return;
        this._rememberMsgId(msgId);
      }
      this.cbs.onChatMessage?.(sender, text, sender === this.myUsername);
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
      this.roomPeersList = data.users || [];
      this.mesh?.recordActivity(this.hostId);
      this.mesh?.updateRoster(this.roster);
      this.cbs.onClientPeerList?.(this.roomPeersList);
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
      this.system('Could not decrypt a message (wrong room key?). Open the full invite link.');
      this.cbs.onE2EEError?.();
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
    const clean = String(text || '').trim();
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
      const payload = { type: 'chat', username: displayName, encrypted, msgId };
      for (const peerId in this.connections) {
        const c = this.connections[peerId].conn;
        if (c && c.open) {
          try { c.send(payload); } catch (_) {}
        }
      }
    } else {
      const payload = { type: 'chat', username: this.myUsername, encrypted, msgId };
      const hostConn = this.connections[this.hostId]?.conn;
      if (hostConn && hostConn.open) {
        try { hostConn.send(payload); } catch (_) {}
        // Optimistic local echo would double up with the host relay echo;
        // legacy build waited for the relay, so we do the same.
      } else {
        this.system('Not connected to host — message not sent.');
      }
    }
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
      if (e.conn && (e.conn.open || !e.conn.open)) {
        fresh.push({ id: peerId, username: e.username || 'Peer', joinedAt: e.joinedAt || Date.now(), isHost: false });
      }
    }
    fresh.sort((a, b) => a.joinedAt - b.joinedAt);
    this.roster = fresh;
    const users = fresh.map((m) => ({ id: m.id, username: m.username, isHost: m.isHost, joinedAt: m.joinedAt }));
    const payload = { type: 'user-list', users, roster: fresh, hostId: this.myId };
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
    try { conn.send({ type: 'user-list', users, roster: this.roster, hostId: this.myId }); } catch (_) {}
  }

  _renderHostList() {
    const view = {};
    for (const m of this.roster) {
      if (m.id === this.myId) view[m.id] = { username: m.username, isHost: true };
      else view[m.id] = { username: m.username || 'Peer', isHost: false };
    }
    // Legacy shape compat: also expose raw conns for kick buttons.
    this.cbs.onHostPeerList?.(view, this.isHost);
  }

  /* ================= host migration ================= */

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
    this.status('Room Active (Hosting — promoted)', 'text-emerald-400');
    this.cbs.onRoleChanged?.(true, this.myId);
    this.system(`Host lost. ${this.myUsername} is now hosting 👑`);

    // Dial every surviving roster peer, then announce.
    for (const m of this.roster) {
      if (m.id !== this.myId) this._dialAsHost(m.id);
    }
    this.mesh?.announcePromotion(this.myId);
    this.broadcastUserList();
    this._renderHostList();
    // Re-announce shortly after dials open (dials complete async).
    setTimeout(() => {
      this.mesh?.announcePromotion(this.myId);
      this.broadcastUserList();
    }, 1500);
  }

  adoptNewHost(newHostId) {
    if (!newHostId || newHostId === this.myId || newHostId === this.hostId) return;
    if (this.isHost) return; // two hosts should never happen; ignore foreign claims
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
    try { disableMobileKeepAlive(); } catch (_) {}
    this.cbs.onKeepAlive?.(false);
    try { this.peer?.destroy(); } catch (_) {}
    clearCachedKey();
    this.peer = null;
    this.connections = {};
  }
}
