/**
 * calls.js — 1:1 voice/video calls over PeerJS MediaConnections.
 * Signalling (invite/accept/decline/end) travels the chat relay;
 * media is peer-to-peer. Only one active call at a time.
 */

export class CallManager {
  /**
   * @param {object} deps
   * @param {() => any} deps.getPeer - the live PeerJS Peer (or null)
   * @param {(stream: MediaStream) => void} deps.onLocalStream
   * @param {(stream: MediaStream) => void} deps.onRemoteStream
   * @param {() => void} deps.onEnded
   */
  constructor(deps) {
    this.deps = deps;
    this.active = null; // { call, stream, withId, video }
    this._heldStream = null; // captured on Accept, used when the dial lands
    this.muted = false;
    this.cameraOff = false;
  }

  get inCall() {
    return !!this.active;
  }

  async _mic(video) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('No mic/camera API — use HTTPS or localhost.');
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 640 }, facingMode: 'user' } : false,
    });
  }

  /** Caller side: dial targetId after the callee accepted. */
  async startCall(targetId, video) {
    if (this.active) throw new Error('Already in a call');
    const peer = this.deps.getPeer();
    if (!peer) throw new Error('Voice/video not ready (no connection).');
    const stream = await this._mic(video);
    const call = peer.call(targetId, stream, { metadata: { video } });
    if (!call || typeof call.on !== 'function') {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Call failed to start.');
    }
    this.muted = false;
    this.cameraOff = false;
    this.active = { call, stream, withId: targetId, video: !!video };
    this._wire(call);
    this.deps.onLocalStream?.(stream);
    return call;
  }

  /** Callee side: capture mic/cam on Accept (user gesture), hold for dial. */
  async capture(video) {
    this.discardHeld();
    const stream = await this._mic(video);
    this._heldStream = stream;
    return stream;
  }

  discardHeld() {
    if (this._heldStream) {
      try { this._heldStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    }
    this._heldStream = null;
  }

  /** Callee side: answer the inbound MediaConnection with the held stream. */
  adoptIncoming(call, fromId, video) {
    if (this.active || !this._heldStream) {
      try { call.close(); } catch (_) {}
      return false;
    }
    const stream = this._heldStream;
    this._heldStream = null;
    this.muted = false;
    this.cameraOff = false;
    this.active = { call, stream, withId: fromId, video: !!video };
    this._wire(call);
    try {
      call.answer(stream);
    } catch (_) {
      this._cleanup();
      return false;
    }
    this.deps.onLocalStream?.(stream);
    return true;
  }

  hangup() {
    if (!this.active) {
      this.discardHeld();
      this.deps.onEnded?.();
      return;
    }
    try { this.active.call.close(); } catch (_) {}
    this._cleanup();
  }

  _wire(call) {
    try {
      call.on('stream', (remote) => this.deps.onRemoteStream?.(remote));
      call.on('close', () => this._cleanup());
      call.on('error', () => this._cleanup());
    } catch (_) { /* call already dead */ }
  }

  _cleanup() {
    if (this.active) {
      try { this.active.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    }
    this.discardHeld();
    this.active = null;
    this.deps.onEnded?.();
  }

  toggleMute() {
    if (!this.active) return false;
    this.muted = !this.muted;
    this.active.stream.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    return this.muted;
  }

  toggleCamera() {
    if (!this.active) return false;
    const tracks = this.active.stream.getVideoTracks();
    if (!tracks.length) return false; // voice call — nothing to toggle
    this.cameraOff = !this.cameraOff;
    tracks.forEach((t) => { t.enabled = !this.cameraOff; });
    return this.cameraOff;
  }

  /** Mobile-style rear/front camera flip (video calls only). */
  async switchCamera() {
    if (!this.active) throw new Error('No active call');
    const oldTrack = this.active.stream.getVideoTracks()[0];
    if (!oldTrack) throw new Error('No camera in this call');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('No camera API.');
    const cur = oldTrack.getSettings().facingMode || 'user';
    const next = cur === 'user' ? 'environment' : 'user';
    let ns = null;
    try {
      ns = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { exact: next } },
      });
    } catch (_) {
      // Device without that lens (e.g. desktop): try a plain re-acquire.
      ns = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
    const newTrack = ns.getVideoTracks()[0];
    if (!newTrack) throw new Error('Could not open camera.');
    try {
      const pc = this.active.call?.peerConnection;
      const sender = pc?.getSenders?.().find((s) => s.track && s.track.kind === 'video');
      if (sender?.replaceTrack) await sender.replaceTrack(newTrack);
    } catch (_) { /* keep the local preview even if replace fails */ }
    try {
      this.active.stream.removeTrack(oldTrack);
      oldTrack.stop();
    } catch (_) {}
    this.active.stream.addTrack(newTrack);
    this.cameraOff = false;
    this.deps.onLocalStream?.(this.active.stream);
    return next;
  }
}
