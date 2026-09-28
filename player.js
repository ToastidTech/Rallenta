/* Rallenta wind-down player — play/pause, scrub, 15/30/45/60-min timer with 30s fade-out, seamless loop, never autoplay. */
'use strict';

class RallentaPlayer {
  constructor() {
    this.tracks = [];
    this.index = -1;
    this.audio = new Audio();
    this.audio.loop = true;      // seamless loop
    this.audio.preload = 'metadata';
    this.audio.volume = 1;
    this.timerMin = 0;
    this._sleepTimeout = null;
    this._fadeInterval = null;
    this._listeners = {};
    this._base = ''; // base URL of the loaded manifest; track `file` values resolve against it
  }

  on(evt, fn) {
    (this._listeners[evt] = this._listeners[evt] || []).push(fn);
  }
  _emit(evt, data) {
    (this._listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) {} });
  }

  async loadManifest(url = 'audio/manifest.json') {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('manifest ' + res.status);
      const json = await res.json();
      this.tracks = Array.isArray(json.tracks) ? json.tracks : [];
      // Track `file` fields in the manifest are relative to the manifest itself.
      this._base = url.slice(0, url.lastIndexOf('/') + 1);
    } catch (e) {
      this.tracks = [];
    }
    this._emit('tracks', this.tracks);
    return this.tracks;
  }

  get current() { return this.tracks[this.index] || null; }
  get playing() { return !this.audio.paused && !this.audio.ended; }

  playTrack(i) {
    const t = this.tracks[i];
    if (!t) return;
    if (i !== this.index) {
      this._clearTimer();
      this.index = i;
      this.audio.volume = 1;
      this.audio.src = (this._base || '') + (t.file || '');
      this.audio.load();
    }
    // Never autoplay: only called from a user gesture.
    this.audio.play().catch(() => {});
    this._emit('change', this.current);
    this._armTimer();
  }

  toggle() {
    if (this.playing) { this.pause(); }
    else if (this.index >= 0) { this.audio.play().catch(() => {}); this._emit('change', this.current); }
    else if (this.tracks.length) { this.playTrack(0); }
  }

  pause() {
    this.audio.pause();
    this._clearTimer();
    this._emit('change', this.current);
  }

  stop() {
    this._clearTimer();
    this.audio.pause();
    this.audio.volume = 1;
    this.index = -1;
    this._emit('change', null);
  }

  seekTo(seconds) {
    if (!isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration || 0));
  }

  setSleepTimer(minutes) {
    this.timerMin = minutes | 0;
    this._armTimer();
    this._emit('timer', this.timerMin);
  }

  _armTimer() {
    this._clearTimer();
    if (!this.timerMin || this.timerMin <= 0) return;
    const fadeLeadMs = 30000; // 30s fade-out
    const totalMs = this.timerMin * 60 * 1000;
    const startFadeAt = Math.max(0, totalMs - fadeLeadMs);
    this._sleepTimeout = setTimeout(() => {
      this._fadeOut(fadeLeadMs, () => {
        this.audio.pause();
        this.audio.volume = 1;
        this._emit('change', this.current);
        this._emit('timerdone');
      });
    }, startFadeAt);
  }

  _fadeOut(ms, done) {
    const steps = 30;
    const startVol = this.audio.volume;
    let n = 0;
    this._fadeInterval = setInterval(() => {
      n += 1;
      const k = 1 - n / steps;
      this.audio.volume = Math.max(0, startVol * k * k); // ease-out curve
      if (n >= steps) {
        clearInterval(this._fadeInterval);
        this._fadeInterval = null;
        done();
      }
    }, ms / steps);
  }

  _clearTimer() {
    if (this._sleepTimeout) { clearTimeout(this._sleepTimeout); this._sleepTimeout = null; }
    if (this._fadeInterval) { clearInterval(this._fadeInterval); this._fadeInterval = null; }
  }
}

window.RallentaPlayer = RallentaPlayer;
