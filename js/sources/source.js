/**
 * MusicSource -- the interface every playback backend implements.
 *
 * WHY THIS EXISTS
 * ---------------
 * Streaming services expose "what is playing" in two fundamentally different
 * shapes, and the app has to work with both:
 *
 *   OBSERVER  (Spotify)
 *     A remote API reports what is playing on *another* device. The Tesla
 *     browser plays no audio; it just watches the car's built-in Spotify and
 *     mirrors it. This is the good case: the driver touches nothing.
 *
 *   LOCAL PLAYER  (Apple Music / MusicKit JS)
 *     There is no remote now-playing API. The only way to know the playhead is
 *     for the browser itself to *be* the player and stream the audio. Audio
 *     then comes out of the browser tab rather than the car's media app.
 *
 * The `capabilities` block tells the UI which shape it is dealing with, so the
 * app can show transport controls for a local player and hide them for an
 * observer (where the car's own controls are the real ones).
 *
 * TO ADD A SOURCE
 * ---------------
 *   1. Implement the methods below.
 *   2. Register it in js/sources/index.js.
 * The rest of the app -- clock, lyrics lookup, rendering -- needs no changes.
 */

/**
 * @typedef {Object} PlaybackState
 * @property {string|null} trackId    stable per-track ID; a change means new song
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number} durationMs
 * @property {number} positionMs      playhead when this reading was taken
 * @property {boolean} isPlaying
 * @property {string|null} artworkUrl
 * @property {number} latencyMs       estimated age of the reading (half the RTT)
 */

/**
 * @typedef {Object} MusicSource
 * @property {string} id
 * @property {string} name
 * @property {Object} capabilities
 *   @property {boolean} capabilities.isLocalPlayer  browser emits the audio
 *   @property {boolean} capabilities.canControl     supports play/pause/seek
 *   @property {boolean} capabilities.autoDetect     finds the track by itself
 * @property {function(): boolean}          isConfigured   has its keys/setup
 * @property {function(): boolean}          isConnected    signed in and usable
 * @property {function(): Promise<void>}    connect
 * @property {function(): Promise<void>}    disconnect
 * @property {function(): Promise<?PlaybackState>} poll  null when nothing plays
 * @property {function(): number}           pollInterval  preferred ms between polls
 */

/** Shared empty state, so callers never have to null-check field by field. */
export function emptyState() {
  return {
    trackId: null,
    title: '',
    artist: '',
    album: '',
    durationMs: 0,
    positionMs: 0,
    isPlaying: false,
    artworkUrl: null,
    latencyMs: 0
  };
}

/**
 * True when two readings describe different songs. Compared by ID where one
 * exists, falling back to title+artist for sources without stable IDs.
 */
export function isDifferentTrack(a, b) {
  if (!a && !b) return false;
  if (!a || !b) return true;
  if (a.trackId && b.trackId) return a.trackId !== b.trackId;
  return (a.title !== b.title) || (a.artist !== b.artist);
}
