/**
 * meshNetwork.js — Decentralized mesh heartbeat + dynamic host failover.
 *
 * Protocol:
 *  1. The host maintains an ordered roster sorted by join timestamp:
 *       [Host(joinedAt=0), Peer2, Peer3, ...]
 *     The roster is distributed inside every `user-list` broadcast.
 *  2. Every peer sends a lightweight `{ type: 'PING', from }` every 2 s.
 *  3. Every peer records `lastSeen` for the active host on ANY incoming
 *     packet (PING, chat, user-list, ...). If the host is silent for
 *     > 5 s (frozen by the mobile OS, tab closed, crash), the next peer
 *     in the ordered array promotes itself to the new Host/Relay.
 *  4. The new host dials all surviving roster peers and broadcasts
 *       `{ type: 'HOST_PROMOTED', newHostId }`.
 *
 * This module is transport-agnostic: all PeerJS I/O is injected via
 * callbacks so there is no circular import with peerManager.js.
 */

export const PING_INTERVAL_MS = 2000;
export const HOST_TIMEOUT_MS = 5000;
const CHECK_INTERVAL_MS = 1000;

export class MeshNetwork {
  /**
   * @param {object} deps
   * @param {() => string} deps.getMyId
   * @param {() => string} deps.getHostId
   * @param {() => Array<{id:string,username:string,joinedAt:number,isHost?:boolean}>} deps.getRoster
   * @param {() => boolean} deps.amIHost
   * @param {(msg: object) => void} deps.sendToAll - raw (unencrypted) send
   * @param {(peerId: string) => void} deps.connectToPeer - dial a peer
   * @param {() => void} deps.onPromotedToHost - this node must become host
   * @param {(newHostId: string) => void} deps.onHostChanged - adopt a new host
   * @param {(text: string) => void} [deps.onLog]
   */
  constructor(deps) {
    this.deps = deps;
    this.lastSeen = new Map(); // peerId -> ms timestamp
    this._pingTimer = null;
    this._checkTimer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.recordActivity(this.deps.getMyId());
    const hostId = this.deps.getHostId();
    if (hostId) this.recordActivity(hostId);
    this._pingTimer = setInterval(() => this._sendPing(), PING_INTERVAL_MS);
    this._checkTimer = setInterval(() => this._checkHostTimeout(), CHECK_INTERVAL_MS);
  }

  stop() {
    this._running = false;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._checkTimer) clearInterval(this._checkTimer);
    this._pingTimer = null;
    this._checkTimer = null;
  }

  /** Mark a peer as recently alive (call on ANY valid packet). */
  recordActivity(peerId) {
    if (peerId) this.lastSeen.set(peerId, Date.now());
  }

  /** Replace/merge liveness info when a fresh roster arrives. */
  updateRoster(roster) {
    const now = Date.now();
    // Seed unknown roster members so a brand-new client doesn't instantly
    // consider the host dead before the first PING arrives.
    for (const m of roster || []) {
      if (m && m.id && !this.lastSeen.has(m.id)) this.lastSeen.set(m.id, now);
    }
    // Drop entries for peers no longer in the roster (except self + host).
    const alive = new Set((roster || []).map((m) => m.id));
    const hostId = this.deps.getHostId();
    for (const id of [...this.lastSeen.keys()]) {
      if (id !== this.deps.getMyId() && id !== hostId && !alive.has(id)) {
        this.lastSeen.delete(id);
      }
    }
  }

  /** Ordered peer ids, host first, then by join time. */
  getOrderedIds() {
    const roster = this.deps.getRoster() || [];
    return [...roster]
      .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0))
      .map((m) => m.id);
  }

  /**
   * Entry point for incoming signalling messages.
   * @returns {boolean} true if the message was a mesh control packet.
   */
  handleMessage(msg, fromId) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'PING') {
      this.recordActivity(msg.from || fromId);
      return true;
    }
    if (msg.type === 'HOST_PROMOTED') {
      this.recordActivity(fromId);
      if (msg.newHostId) {
        this.recordActivity(msg.newHostId);
        this.deps.onHostChanged(msg.newHostId);
      }
      return true;
    }
    return false;
  }

  _sendPing() {
    if (!this._running) return;
    try {
      const myId = this.deps.getMyId();
      if (!myId) return;
      this.recordActivity(myId);
      this.deps.sendToAll({ type: 'PING', from: myId });
    } catch (_) { /* transport not ready yet */ }
  }

  _checkHostTimeout() {
    if (!this._running || this.deps.amIHost()) return;
    const hostId = this.deps.getHostId();
    const myId = this.deps.getMyId();
    if (!hostId || !myId) return;
    const last = this.lastSeen.get(hostId) || 0;
    if (Date.now() - last <= HOST_TIMEOUT_MS) return;

    // Host is dead — only the next peer in the ordered array may promote.
    const ordered = this.getOrderedIds();
    const hostIdx = ordered.indexOf(hostId);
    const myIdx = ordered.indexOf(myId);
    if (myIdx === -1) return; // not in roster yet, wait for user-list
    const expectedIdx = hostIdx === -1 ? 0 : hostIdx + 1;

    if (myIdx === expectedIdx) {
      this.deps.onLog?.(`Host ${hostId} timed out — promoting ${myId}`);
      // Prevent double-promotion while dials complete.
      this.recordActivity(hostId);
      this.deps.onPromotedToHost();
    }
    // Otherwise: not our turn; wait for the new host's HOST_PROMOTED.
  }

  /** Broadcast a promotion announcement (called by the new host). */
  announcePromotion(newHostId) {
    try {
      this.deps.sendToAll({ type: 'HOST_PROMOTED', newHostId });
    } catch (_) { /* ignore */ }
  }
}
