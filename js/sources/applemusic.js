/**
 * Apple Music source (LOCAL PLAYER shape) -- SCAFFOLD, NOT YET ACTIVE.
 *
 * READ THIS BEFORE BUILDING IT OUT. Apple Music is not a drop-in swap for the
 * Spotify source, and the difference is not a detail:
 *
 *   Spotify gives you a REMOTE now-playing API. The car plays the music and
 *   this browser tab just watches. Zero interaction while driving.
 *
 *   Apple gives you NO such API. MusicKit reports the playhead of the player
 *   *it* owns. There is no endpoint for "what is my Apple Music playing on
 *   some other device". So for Apple Music the browser tab has to BE the
 *   player: audio comes out of the Tesla browser, not the car's media app.
 *
 * Practical consequences of that:
 *   - The driver selects music inside this app, not the car's Media panel.
 *   - Steering-wheel controls and the car's own UI will not drive it.
 *   - Tesla may pause browser audio when the app loses focus or the car sleeps.
 *   - Audio routing quirks: browser audio and media audio are separate paths.
 *
 * WHAT YOU NEED
 *   1. Apple Developer Program membership (paid; no free tier for MusicKit).
 *   2. A MusicKit identifier and a private key, used to sign a developer JWT
 *      (ES256, max 180-day expiry).
 *   3. That JWT must be signed somewhere that is NOT the browser -- signing
 *      needs the private key, which cannot ship to the car. In practice: a
 *      tiny serverless endpoint that returns a short-lived token. This is the
 *      one place the "pure static site" property breaks.
 *   4. The listener needs an active Apple Music subscription; MusicKit's
 *      authorize() returns a Music User Token for their library.
 *
 * IMPLEMENTATION SKETCH
 *   Load https://js-cdn.music.apple.com/musickit/v3/musickit.js, then:
 *
 *     await MusicKit.configure({
 *       developerToken: <fetched JWT>,
 *       app: { name: 'Tesla Lyrics', build: '1.0' }
 *     });
 *     const music = MusicKit.getInstance();
 *     await music.authorize();
 *
 *   Then poll, mapping onto our PlaybackState:
 *     music.nowPlayingItem            -> title / artistName / albumName / id
 *     music.currentPlaybackTime       -> positionMs (SECONDS -- multiply by 1000)
 *     music.currentPlaybackDuration   -> durationMs (also seconds)
 *     music.isPlaying                 -> isPlaying
 *     latencyMs = 0                   -> it is a local player, no network lag
 *
 *   Set capabilities.isLocalPlayer = true and capabilities.canControl = true,
 *   and the app will render transport controls automatically.
 *
 * Everything downstream -- the clock, LRCLIB lookup, rendering -- already
 * works unchanged the moment poll() returns a valid PlaybackState.
 */

import { CONFIG } from '../config.js';
import { emptyState } from './source.js';

export var appleMusicSource = {
  id: 'apple',
  name: 'Apple Music',

  capabilities: {
    isLocalPlayer: true,
    canControl: true,
    autoDetect: false
  },

  /** Hidden from the UI until a developer token is wired up. */
  isConfigured: function () {
    return Boolean(CONFIG.appleMusic.developerToken);
  },

  isConnected: function () {
    return false;
  },

  connect: function () {
    return Promise.reject(new Error(
      'Apple Music is not wired up yet. It needs a paid Apple Developer ' +
      'account and a signed developer token -- see the notes at the top of ' +
      'js/sources/applemusic.js.'
    ));
  },

  disconnect: function () {
    return Promise.resolve();
  },

  pollInterval: function () {
    return 1000;   // local player, so polling is cheap
  },

  poll: function () {
    return Promise.resolve(null);
  },

  /** Referenced here only so the shape is obvious when you fill it in. */
  _mapNowPlaying: function (music) {
    var item = music.nowPlayingItem;
    if (!item) return null;

    var state = emptyState();
    state.trackId = item.id || null;
    state.title = item.title || '';
    state.artist = item.artistName || '';
    state.album = item.albumName || '';
    state.durationMs = Math.round((music.currentPlaybackDuration || 0) * 1000);
    state.positionMs = Math.round((music.currentPlaybackTime || 0) * 1000);
    state.isPlaying = Boolean(music.isPlaying);
    state.artworkUrl = (item.artwork && window.MusicKit)
      ? window.MusicKit.formatArtworkURL(item.artwork, 600, 600)
      : null;
    state.latencyMs = 0;
    return state;
  }
};
