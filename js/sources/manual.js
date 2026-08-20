/**
 * Manual source (LOCAL CLOCK shape).
 *
 * A fallback for anything the app cannot observe: FM radio, USB sticks, a
 * phone over Bluetooth, or Apple Music before a real MusicKit integration
 * exists. The driver picks the song, taps play when the first line lands, and
 * nudges the offset if it drifts.
 *
 * There is no audio and no remote API here. This source just runs a stopwatch
 * and reports it in the same PlaybackState shape as everything else, so the
 * rest of the app cannot tell the difference.
 */

import { emptyState } from './source.js';

function now() {
  return (window.performance && window.performance.now)
    ? window.performance.now()
    : Date.now();
}

var track = null;      // { trackId, title, artist, album, durationMs, artworkUrl }
var running = false;
var startedAt = 0;     // monotonic timestamp when the stopwatch last started
var accumulated = 0;   // ms banked from previous runs, for pause/resume

export var manualSource = {
  id: 'manual',
  name: 'Manual',

  capabilities: {
    isLocalPlayer: false,
    canControl: true,     // we own the clock, so transport controls are real
    autoDetect: false     // the driver has to say what is playing
  },

  isConfigured: function () { return true; },
  isConnected: function () { return true; },
  connect: function () { return Promise.resolve(); },
  disconnect: function () {
    track = null;
    running = false;
    accumulated = 0;
    return Promise.resolve();
  },

  // Polling is nearly free here; the UI's own frame loop does the real work.
  pollInterval: function () { return 1000; },

  poll: function () {
    if (!track) return Promise.resolve(null);

    var state = emptyState();
    state.trackId = track.trackId;
    state.title = track.title;
    state.artist = track.artist;
    state.album = track.album || '';
    state.durationMs = track.durationMs || 0;
    state.positionMs = manualSource.position();
    state.isPlaying = running;
    state.artworkUrl = track.artworkUrl || null;
    state.latencyMs = 0;   // local clock, no network lag
    return Promise.resolve(state);
  },

  /* ------------------------------------------------ manual-only controls */

  /** Load a track chosen from the search picker. Starts paused at zero. */
  setTrack: function (t) {
    track = {
      trackId: 'manual:' + (t.id || (t.title + '|' + t.artist)),
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      durationMs: t.durationMs || 0,
      artworkUrl: t.artworkUrl || null
    };
    running = false;
    accumulated = 0;
    startedAt = now();
  },

  currentTrack: function () { return track; },

  position: function () {
    if (!track) return 0;
    return running ? (accumulated + (now() - startedAt)) : accumulated;
  },

  play: function () {
    if (!track || running) return;
    startedAt = now();
    running = true;
  },

  pause: function () {
    if (!track || !running) return;
    accumulated += now() - startedAt;
    running = false;
  },

  toggle: function () {
    if (running) manualSource.pause(); else manualSource.play();
  },

  /** Jump to an absolute position, clamped to the track. */
  seek: function (ms) {
    if (!track) return;
    var clamped = Math.max(0, track.durationMs ? Math.min(ms, track.durationMs) : ms);
    accumulated = clamped;
    startedAt = now();
  },

  /** Relative jog, used by the -5s / +5s buttons. */
  nudge: function (deltaMs) {
    manualSource.seek(manualSource.position() + deltaMs);
  },

  /**
   * "Start now" -- the driver taps exactly as a known line is sung, and we
   * snap the clock to that line's timestamp. Far more accurate than trying to
   * hit play at the very top of the song.
   */
  syncToLine: function (lineTimeMs) {
    manualSource.seek(lineTimeMs);
    manualSource.play();
  }
};
