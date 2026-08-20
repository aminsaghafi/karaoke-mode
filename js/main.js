/**
 * Karaoke Mode -- app orchestration.
 *
 * Shape of the thing:
 *
 *   poll loop  (every few seconds)   asks the active MusicSource what is playing
 *        |                            and feeds the reading into the clock
 *        v
 *   PlaybackClock                    interpolates a smooth playhead between polls
 *        |
 *        v
 *   frame loop (rAF)                 reads the clock, moves the lyric column
 *
 * The two loops are deliberately separate: network cadence and render cadence
 * have nothing to do with each other, and coupling them is what makes most
 * lyric apps stutter.
 */

import { CONFIG } from './config.js';
import * as store from './lib/store.js';
import { PlaybackClock } from './lib/clock.js';
import { isSecureContextOk } from './lib/pkce.js';
import { extractPalette } from './lib/palette.js';
import * as theme from './lib/theme.js';
import { LyricsView } from './ui/lyricsView.js';
import { fetchLyrics, searchLyrics, recordToLyrics } from './lyrics/lrclib.js';
import { isDifferentTrack } from './sources/source.js';
import { SOURCES, getSource, activeSourceId, setActiveSourceId } from './sources/index.js';
import * as spotify from './sources/spotify.js';
import { manualSource } from './sources/manual.js';

/* ----------------------------------------------------------------- state */

var app = {
  source: null,
  clock: new PlaybackClock(),
  view: null,
  state: null,          // last PlaybackState
  lyrics: null,         // last lyrics result
  lyricsForTrackId: null,
  lookupPending: false,
  // Lyrics the driver chose by hand. Keyed by track so the automatic LRCLIB
  // lookup can never race in and overwrite a deliberate choice.
  preset: null,         // { trackId, lyrics }
  pollTimer: null,
  frameHandle: null,
  screen: 'setup'
};

var el = {};

function $(id) { return document.getElementById(id); }

function cacheElements() {
  var ids = [
    'backdrop', 'screen-setup', 'screen-player', 'screen-search', 'screen-settings',
    'spotify-badge', 'spotify-config', 'client-id', 'redirect-uri',
    'btn-spotify-connect', 'btn-spotify-forget', 'setup-error', 'setup-insecure',
    'track-title', 'track-artist', 'btn-settings', 'lyrics',
    'vinyl', 'vinyl-art', 'unsynced-note', 'btn-find-synced',
    'overlay', 'overlay-icon', 'overlay-text', 'overlay-sub', 'overlay-action',
    'glow',
    'time-current', 'time-total', 'progress-fill',
    'transport', 'btn-back5', 'btn-play', 'btn-fwd5', 'btn-pick',
    'search-input', 'btn-search', 'btn-search-close', 'search-status', 'search-results',
    'btn-offset-down', 'btn-offset-up', 'offset-value', 'btn-backdrop',
    'btn-change-source', 'btn-settings-close', 'settings-source-name', 'theme-hint'
  ];
  for (var i = 0; i < ids.length; i++) {
    el[ids[i]] = $(ids[i]);
  }
}

/* --------------------------------------------------------------- screens */

function showScreen(name) {
  app.screen = name;
  var screens = ['setup', 'player', 'search', 'settings'];
  for (var i = 0; i < screens.length; i++) {
    var node = $('screen-' + screens[i]);
    if (node) node.classList.toggle('is-visible', screens[i] === name);
  }
  if (name === 'player' && app.view) {
    // Layout metrics are wrong while hidden; recentre once visible.
    window.setTimeout(function () { app.view.relayout(); }, 50);
  }
}

/* --------------------------------------------------------------- overlay */

function setOverlay(icon, text, sub, actionLabel, actionFn) {
  if (!text) {
    el['overlay'].classList.add('is-hidden');
    return;
  }
  el['overlay-icon'].textContent = icon || '';
  el['overlay-text'].textContent = text;
  el['overlay-sub'].textContent = sub || '';
  var btn = el['overlay-action'];
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.classList.remove('is-hidden');
    btn.onclick = actionFn || null;
  } else {
    btn.classList.add('is-hidden');
    btn.onclick = null;
  }
  el['overlay'].classList.remove('is-hidden');
}

/**
 * Explain a track that has words but no timestamps. LRCLIB stores plenty of
 * these, and without a note the column simply never scrolls -- which looks
 * exactly like the sync being broken.
 */
function setUnsyncedNote(show) {
  el['unsynced-note'].classList.toggle('is-hidden', !show);
}

/* ------------------------------------------------------------- settings */

var SIZES = { s: [32, 20], m: [44, 26], l: [56, 32], xl: [70, 40] };

function applyTextSize(key) {
  var size = SIZES[key] || SIZES.m;
  document.documentElement.style.setProperty('--lyric-size', size[0] + 'px');
  document.documentElement.style.setProperty('--lyric-gap', size[1] + 'px');
  store.set('textSize', key);

  var chips = document.querySelectorAll('[data-size]');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('is-on', chips[i].getAttribute('data-size') === key);
  }
  if (app.view) app.view.relayout();
}

/**
 * Apply a theme preference and reflect it in the settings row.
 *
 * Position is only requested when the driver actively picks Auto. Prompting
 * for location on first load -- before anyone has asked for anything -- would
 * be intrusive, so until then Auto falls back to the browser preference or a
 * clock window.
 */
function applyThemePref(pref, askForPosition) {
  theme.setPreference(pref);

  var chips = document.querySelectorAll('[data-theme-pref]');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('is-on', chips[i].getAttribute('data-theme-pref') === pref);
  }

  function finish() {
    var resolved = theme.applyTheme();
    var hint = el['theme-hint'];
    if (pref !== 'auto') {
      hint.textContent = 'Always ' + pref;
    } else if (theme.hasPosition()) {
      hint.textContent = 'Follows sunset \u2014 currently ' + resolved;
    } else {
      hint.textContent = 'Currently ' + resolved + ' \u2014 tap Auto to use sunset times';
    }
  }

  if (pref === 'auto' && askForPosition) {
    theme.ensurePosition().then(finish);
  } else {
    finish();
  }
}

function applyBackdropSetting(on) {
  store.set('backdrop', on);
  el['btn-backdrop'].textContent = on ? 'On' : 'Off';
  el['btn-backdrop'].classList.toggle('is-on', on);
  if (!on) el['backdrop'].classList.remove('is-on');
  else if (app.state && app.state.artworkUrl) setBackdrop(app.state.artworkUrl);
}

/**
 * Point the record at a new sleeve.
 *
 * The image fades in only once it has actually decoded -- swapping src
 * directly leaves a blank disc or, worse, the previous track's artwork
 * showing for however long the download takes.
 */
function setVinyl(url) {
  var img = el['vinyl-art'];
  if (!url) {
    // No artwork available: fall back to the etched blank disc.
    img.classList.remove('is-loaded');
    img.removeAttribute('src');
    return;
  }
  if (img.getAttribute('src') === url) return;

  img.classList.remove('is-loaded');
  img.onload = function () { img.classList.add('is-loaded'); };
  img.onerror = function () { img.classList.remove('is-loaded'); };
  img.setAttribute('src', url);
}

/**
 * Recolour the instrumental glow from the album art.
 *
 * extractPalette never rejects -- a blocked cross-origin read or a missing
 * sleeve resolves to a neutral grey palette instead, so the glow degrades to
 * something plain rather than disappearing or throwing mid-render.
 */
function applyPalette(url) {
  extractPalette(url).then(function (colors) {
    var root = document.documentElement.style;
    root.setProperty('--glow-1', colors[0]);
    root.setProperty('--glow-2', colors[1]);
    root.setProperty('--glow-3', colors[2]);
  });
}

/**
 * Show the glow, swelling as the vocal gets closer.
 *
 * This is the honest half of "reacts to the music": there is no audio in this
 * tab to analyse, so it cannot follow the beat. What it can follow is the
 * lyric timeline -- the glow builds over the last 12s of an instrumental, so
 * the room brightening actually means something is about to happen.
 */
/* How long the glow takes to bloom to full strength when a gap opens. */
var GLOW_BLOOM_MS = 1100;
var glowEnteredAt = 0;

function nowMs() {
  return (window.performance && window.performance.now)
    ? window.performance.now() : Date.now();
}

function setGlow(on, untilNextMs) {
  var wasOn = el['glow'].classList.contains('is-on');
  el['glow'].classList.toggle('is-on', Boolean(on));

  if (!on) {
    glowEnteredAt = 0;
    return;
  }
  if (!wasOn || !glowEnteredAt) glowEnteredAt = nowMs();

  // Broad swell across the last 12s, squared so most of the rise happens late
  // rather than creeping up linearly from the moment the gap opens.
  var t = Math.max(0, Math.min(1, 1 - (untilNextMs / 12000)));
  var intensity = 0.40 + (t * t) * 0.35;

  // Then a distinct surge over the final approach. This is what replaced the
  // three count-in pips -- same signal, carried by the light instead of by
  // another widget competing with the lyrics.
  if (untilNextMs < 3000) {
    intensity += (1 - (untilNextMs / 3000)) * 0.40;
  }

  // Bloom up over the first few seconds of the gap instead of arriving at
  // full strength. An interlude opening mid-song otherwise reads as a flash,
  // when what it should say is "settle back, this part is instrumental".
  // Smoothstep rather than linear so both ends of the fade are soft.
  var bloom = Math.max(0, Math.min(1, (nowMs() - glowEnteredAt) / GLOW_BLOOM_MS));
  bloom = bloom * bloom * (3 - 2 * bloom);
  intensity *= bloom;

  document.documentElement.style.setProperty(
    '--glow-intensity', Math.min(1, intensity).toFixed(3));
}

/** The record turns only while the music does. */
function setVinylSpinning(on) {
  el['vinyl'].classList.toggle('is-spinning', Boolean(on));
}

function setBackdrop(url) {
  if (!store.get('backdrop', true) || !url) {
    el['backdrop'].classList.remove('is-on');
    return;
  }
  el['backdrop'].style.backgroundImage = 'url("' + url + '")';
  el['backdrop'].classList.add('is-on');
}

function applyOffset(ms) {
  app.clock.setOffset(ms);
  store.set('offsetMs', ms);
  var s = (ms / 1000).toFixed(1);
  el['offset-value'].textContent = (ms > 0 ? '+' : '') + s + 's';
}

/* ------------------------------------------------------------ formatting */

function fmtTime(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  var total = Math.floor(ms / 1000);
  var m = Math.floor(total / 60);
  var s = total % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/* ------------------------------------------------------------ poll cycle */

function scheduleNextPoll(delayMs) {
  window.clearTimeout(app.pollTimer);
  var wait = delayMs;
  if (wait == null) {
    wait = app.source ? app.source.pollInterval() : 3000;
  }
  app.pollTimer = window.setTimeout(runPoll, wait);
}

function runPoll() {
  if (!app.source) return;

  app.source.poll().then(function (state) {
    handleState(state);
    scheduleNextPoll();
  }).catch(function (err) {
    console.warn('[poll] failed', err);
    handlePollError(err);
    // Back off a little on errors so a dead network does not hammer the API.
    scheduleNextPoll(5000);
  });
}

function handlePollError(err) {
  var msg = String((err && err.message) || err);
  if (/sign in|refresh|Not signed/i.test(msg)) {
    setOverlay('🔑', 'Signed out of Spotify', 'Your session expired. Sign in again to keep the lyrics rolling.',
      'Sign in', function () { showScreen('setup'); refreshSetupUi(); });
  } else {
    setOverlay('📡', 'No connection', 'Waiting for the network to come back.');
  }
}

/**
 * Fold a fresh reading into app state: detect track changes, drive the lyrics
 * lookup, and keep the clock honest.
 */
function handleState(state) {
  if (!state) {
    app.state = null;
    app.clock.reset(0, false);
    el['track-title'].textContent = 'Nothing playing';
    el['track-artist'].textContent = '';
    if (app.view) app.view.clear();
    el['backdrop'].classList.remove('is-on');
    setVinyl(null);
    setVinylSpinning(false);
    setUnsyncedNote(false);
    setGlow(false, 0);

    if (app.source && app.source.id === 'manual') {
      setOverlay('🎵', 'Pick a song', 'Search for what you are listening to, then tap to sync it up.',
        'Search', openSearch);
    } else {
      setOverlay('🎧', 'Nothing playing', 'Start a song in your car and the lyrics will follow automatically.');
    }
    return;
  }

  var changed = isDifferentTrack(app.state, state);
  app.state = state;

  if (changed) {
    el['track-title'].textContent = state.title || 'Unknown track';
    el['track-artist'].textContent = state.artist || '';
    el['time-total'].textContent = fmtTime(state.durationMs);
    setBackdrop(state.artworkUrl);
    setVinyl(state.artworkUrl);
    applyPalette(state.artworkUrl);

    // New song: wipe the old lines instantly so we never show the wrong
    // lyrics against the right audio, even for a frame.
    app.lyrics = null;
    app.lyricsForTrackId = null;
    if (app.view) app.view.clear();

    app.clock.reset(state.positionMs + (state.isPlaying ? state.latencyMs : 0), state.isPlaying);

    if (app.preset && app.preset.trackId === state.trackId) {
      // The driver picked these themselves; trust them over any lookup.
      app.lyrics = app.preset.lyrics;
      app.lyricsForTrackId = state.trackId;
      app.lookupPending = false;
      app.view.setLyrics(app.preset.lyrics);
    } else {
      loadLyricsFor(state);
    }

    // Come back quickly to tighten the clock on the new track.
    if (app.source && app.source.id === 'spotify') {
      scheduleNextPoll(CONFIG.spotify.fastPollMs);
    }
  } else {
    app.clock.sync(state.positionMs, state.isPlaying, state.latencyMs);
  }

  updateTransport(state.isPlaying);
  updateStatusOverlay();
}

/** Keep the play/pause glyph honest about what the clock is actually doing. */
function updateTransport(isPlaying) {
  el['btn-play'].textContent = isPlaying ? '❚❚' : '▶';
  setVinylSpinning(isPlaying);
}

function loadLyricsFor(state) {
  var forTrack = state.trackId;
  app.lookupPending = true;
  setOverlay('', '', '');

  fetchLyrics({
    title: state.title,
    artist: state.artist,
    album: state.album,
    durationMs: state.durationMs
  }).then(function (result) {
    // The song may have changed while we were fetching; discard stale results.
    if (!app.state || app.state.trackId !== forTrack) return;

    app.lookupPending = false;
    app.lyrics = result;
    app.lyricsForTrackId = forTrack;

    if (result && result.lines && result.lines.length) {
      app.view.setLyrics(result);
    } else if (app.view) {
      app.view.clear();
    }
    updateStatusOverlay();
  });
}

/** Decide which, if any, status message belongs on screen right now. */
function updateStatusOverlay() {
  var state = app.state;
  if (!state) return;

  if (app.lookupPending) {
    setUnsyncedNote(false);
    setOverlay('', '', '');   // brief; a spinner here would just flicker
    return;
  }

  setUnsyncedNote(app.lyrics && app.lyrics.synced === false);

  if (app.lyrics && app.lyrics.instrumental) {
    setOverlay('🎼', 'Instrumental', 'No lyrics for this one.');
    return;
  }

  if (!app.lyrics || !app.lyrics.lines.length) {
    setOverlay('🔍', 'No lyrics found',
      'LRCLIB has nothing for "' + (state.title || 'this track') + '".',
      'Search manually', openSearch);
    return;
  }

  if (app.lyrics.synced === false) {
    // Plain lyrics only -- honest about the downgrade rather than pretending.
    setOverlay('', '', '');
    return;
  }

  // Manual mode, cued up but never started: explain how to sync it. This is
  // derived from state rather than shown once, so the next poll tick cannot
  // wipe the hint a second after it appears.
  if (app.source && app.source.id === 'manual'
      && !app.clock.isPlaying() && app.clock.position() < 1000) {
    setOverlay('👆', 'Tap to sync',
      'Tap the line being sung right now, or press play as the song starts.');
    return;
  }

  setOverlay('', '', '');
}

/* ------------------------------------------------------------ frame loop */

function frame() {
  app.frameHandle = window.requestAnimationFrame(frame);
  renderNow();
}

/**
 * Paint one frame from the current playhead.
 *
 * Split out from the rAF loop so it can also be called directly -- the
 * browser pauses rAF entirely while the tab is hidden, so on the way back we
 * need one synchronous repaint rather than a stale screen until the next frame.
 */
function renderNow() {
  if (app.screen !== 'player' || !app.state) return;

  var pos = app.clock.position();
  var dur = app.state.durationMs || 0;

  // Progress bar + clock readout
  el['time-current'].textContent = fmtTime(pos);
  el['progress-fill'].style.width = dur ? Math.max(0, Math.min(100, (pos / dur) * 100)) + '%' : '0%';

  if (!app.lyrics || !app.lyrics.lines.length || app.lyrics.synced === false) {
    setGlow(false, 0);
    return;
  }

  var info = app.view.update(pos);

  // Instrumental filler, but only while actually playing -- a paused song
  // sitting in a gap should not dance at you.
  var showGap = Boolean(info && info.inGap && app.clock.isPlaying() && el['overlay'].classList.contains('is-hidden'));
  setGlow(showGap, info ? info.untilNextMs : 0);
}

/* ---------------------------------------------------------------- search */

function openSearch() {
  showScreen('search');
  el['search-status'].textContent = '';
  // Prefill from what is playing, so Spotify users searching a missed track
  // do not have to type it out on a car keyboard.
  if (app.state && app.state.title) {
    el['search-input'].value = app.state.title + ' ' + (app.state.artist || '');
  }
  window.setTimeout(function () { el['search-input'].focus(); }, 100);
}

function runSearch() {
  var q = el['search-input'].value;
  if (!q || !q.trim()) return;

  el['search-status'].textContent = 'Searching…';
  el['search-results'].innerHTML = '';

  searchLyrics(q).then(function (list) {
    if (!list.length) {
      el['search-status'].textContent = 'Nothing found. Try just the song title.';
      return;
    }
    // Synced results are the whole point, so float them to the top.
    list.sort(function (a, b) {
      return (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0);
    });
    el['search-status'].textContent = list.length + ' result' + (list.length === 1 ? '' : 's');
    renderResults(list.slice(0, 40));
  });
}

function renderResults(list) {
  var frag = document.createDocumentFragment();

  for (var i = 0; i < list.length; i++) {
    (function (rec) {
      var btn = document.createElement('button');
      btn.className = 'result';

      var main = document.createElement('div');
      main.className = 'result-main';

      var title = document.createElement('div');
      title.className = 'result-title';
      title.textContent = rec.trackName || 'Unknown';

      var artist = document.createElement('div');
      artist.className = 'result-artist';
      var bits = [];
      if (rec.artistName) bits.push(rec.artistName);
      if (rec.duration) bits.push(fmtTime(rec.duration * 1000));
      artist.textContent = bits.join('  ·  ');

      main.appendChild(title);
      main.appendChild(artist);

      var tag = document.createElement('span');
      tag.className = 'result-tag' + (rec.syncedLyrics ? ' is-synced' : '');
      tag.textContent = rec.syncedLyrics ? 'Synced' : 'Text only';

      btn.appendChild(main);
      btn.appendChild(tag);
      btn.addEventListener('click', function () { chooseResult(rec); });

      frag.appendChild(btn);
    })(list[i]);
  }

  el['search-results'].appendChild(frag);
}

/**
 * Take a search hit and play it in manual mode. Even a Spotify user lands here
 * when LRCLIB's automatic match misses -- manual becomes the escape hatch.
 */
function chooseResult(rec) {
  var lyrics = recordToLyrics(rec);
  if (!lyrics) {
    el['search-status'].textContent = 'That entry has no lyrics attached.';
    return;
  }

  manualSource.setTrack({
    id: rec.id,
    title: rec.trackName,
    artist: rec.artistName,
    album: rec.albumName,
    durationMs: (rec.duration || 0) * 1000
  });

  // Register the choice before any poll runs, so handleState picks it up
  // instead of firing an automatic lookup that could land on a different take.
  var track = manualSource.currentTrack();
  app.preset = { trackId: track.trackId, lyrics: lyrics };
  app.state = null;               // force handleState to treat this as new

  switchSource(manualSource);
  showScreen('player');

  // Paint immediately rather than waiting for the poll tick. The tap-to-sync
  // hint comes from updateStatusOverlay(), which derives it from state.
  app.source.poll().then(handleState);
}

/* ---------------------------------------------------------------- source */

function switchSource(source) {
  app.source = source;
  setActiveSourceId(source.id);

  var canControl = Boolean(source.capabilities.canControl);
  el['transport'].classList.toggle('is-hidden', !canControl);
  el['settings-source-name'].textContent = source.name;

  window.clearTimeout(app.pollTimer);
  scheduleNextPoll(0);
}

/* ------------------------------------------------------------ setup UI */

function refreshSetupUi() {
  el['redirect-uri'].textContent = spotify.redirectUri();
  el['client-id'].value = spotify.getClientId();

  var connected = spotify.spotifySource.isConnected();
  el['spotify-badge'].textContent = connected ? 'Connected' : 'Not connected';
  el['spotify-badge'].classList.toggle('is-good', connected);
  el['btn-spotify-forget'].classList.toggle('is-hidden', !connected);
  el['btn-spotify-connect'].textContent = connected ? 'Reconnect' : 'Connect Spotify';

  if (!isSecureContextOk()) {
    el['setup-insecure'].classList.remove('is-hidden');
  }
}

function showSetupError(message) {
  el['setup-error'].textContent = message;
  el['setup-error'].classList.remove('is-hidden');
}

/* ------------------------------------------------------------- wiring */

function wireEvents() {
  // --- setup
  var cards = document.querySelectorAll('.source-card');
  for (var i = 0; i < cards.length; i++) {
    (function (card) {
      card.addEventListener('click', function () {
        var id = card.getAttribute('data-source');
        if (id === 'spotify') {
          el['spotify-config'].classList.remove('is-hidden');
          for (var j = 0; j < cards.length; j++) cards[j].classList.remove('is-selected');
          card.classList.add('is-selected');
          refreshSetupUi();
        } else {
          switchSource(manualSource);
          showScreen('player');
        }
      });
    })(cards[i]);
  }

  el['client-id'].addEventListener('change', function () {
    spotify.setClientId(el['client-id'].value);
  });

  el['btn-spotify-connect'].addEventListener('click', function () {
    el['setup-error'].classList.add('is-hidden');
    spotify.setClientId(el['client-id'].value);

    if (!spotify.getClientId()) {
      showSetupError('Paste your Spotify client ID first.');
      return;
    }
    if (!isSecureContextOk()) {
      showSetupError('Spotify sign-in needs HTTPS. Open this page over https:// and try again.');
      return;
    }
    spotify.spotifySource.connect().catch(function (err) {
      showSetupError(err.message || String(err));
    });
  });

  el['btn-spotify-forget'].addEventListener('click', function () {
    spotify.spotifySource.disconnect().then(refreshSetupUi);
  });

  // --- player
  el['btn-settings'].addEventListener('click', function () {
    el['settings-source-name'].textContent = app.source ? app.source.name : '—';
    showScreen('settings');
  });

  el['btn-play'].addEventListener('click', function () {
    manualSource.toggle();
    // Poll straight away so the clock and the glyph reflect the new state
    // without waiting for the next tick.
    app.source.poll().then(handleState);
    setOverlay('', '', '');
  });

  el['btn-back5'].addEventListener('click', function () {
    manualSource.nudge(-5000);
    app.source.poll().then(handleState);
  });

  el['btn-fwd5'].addEventListener('click', function () {
    manualSource.nudge(5000);
    app.source.poll().then(handleState);
  });

  el['btn-pick'].addEventListener('click', openSearch);
  el['btn-find-synced'].addEventListener('click', openSearch);

  // --- search
  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    // Dismiss the soft keyboard so results are not hidden behind it.
    el['search-input'].blur();
    runSearch();
  });
  el['btn-search-close'].addEventListener('click', function () { showScreen('player'); });

  // --- settings
  el['btn-offset-down'].addEventListener('click', function () {
    applyOffset(app.clock.offset() - 250);
  });
  el['btn-offset-up'].addEventListener('click', function () {
    applyOffset(app.clock.offset() + 250);
  });

  var sizeChips = document.querySelectorAll('[data-size]');
  for (var k = 0; k < sizeChips.length; k++) {
    (function (chip) {
      chip.addEventListener('click', function () {
        applyTextSize(chip.getAttribute('data-size'));
      });
    })(sizeChips[k]);
  }

  var themeChips = document.querySelectorAll('[data-theme-pref]');
  for (var tc = 0; tc < themeChips.length; tc++) {
    (function (chip) {
      chip.addEventListener('click', function () {
        applyThemePref(chip.getAttribute('data-theme-pref'), true);
      });
    })(themeChips[tc]);
  }

  el['btn-backdrop'].addEventListener('click', function () {
    applyBackdropSetting(!store.get('backdrop', true));
  });

  el['btn-change-source'].addEventListener('click', function () {
    showScreen('setup');
    refreshSetupUi();
  });

  el['btn-settings-close'].addEventListener('click', function () { showScreen('player'); });

  // --- global
  window.addEventListener('resize', function () {
    if (app.view) app.view.relayout();
  });

  // The Tesla browser suspends timers when the tab is backgrounded or the
  // screen sleeps. On return, the local clock has been free-running against
  // nothing, so force an immediate resync rather than trusting it.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && app.source) {
      scheduleNextPoll(0);
      // Repaint from the current playhead straight away. Waiting for the
      // resync round-trip would leave a stale line highlighted for a beat,
      // which is exactly the moment the driver is looking back at the screen.
      renderNow();
      if (app.view) app.view.relayout();
    }
  });
}

/* ------------------------------------------------------------------ boot */

function boot() {
  cacheElements();
  wireEvents();

  app.view = new LyricsView(el['lyrics']);
  // Tapping a line re-syncs the clock -- the fastest way to fix manual drift.
  app.view.onSeekToLine = function (timeMs) {
    if (app.source && app.source.id === 'manual') {
      manualSource.syncToLine(timeMs);
      app.source.poll().then(handleState);
      setOverlay('', '', '');
    }
  };

  applyThemePref(theme.getPreference(), false);
  theme.watchTheme(function () { applyThemePref(theme.getPreference(), false); });

  applyTextSize(store.get('textSize', 'm'));
  applyBackdropSetting(store.get('backdrop', true));
  applyOffset(store.get('offsetMs', 0));

  el['redirect-uri'].textContent = spotify.redirectUri();

  // If we came back from the Spotify consent screen, finish the exchange
  // before deciding which screen to show.
  spotify.handleRedirect()
    .then(function (token) {
      if (token) {
        switchSource(spotify.spotifySource);
        showScreen('player');
        setOverlay('🎧', 'Connected', 'Start a song in your car and lyrics will appear.');
        return;
      }
      resumeLastSession();
    })
    .catch(function (err) {
      refreshSetupUi();
      el['spotify-config'].classList.remove('is-hidden');
      showSetupError(err.message || String(err));
      showScreen('setup');
    });

  frame();
}

/** Pick up where the driver left off, so the app is usable the moment it loads. */
function resumeLastSession() {
  var lastId = activeSourceId();
  var source = lastId ? getSource(lastId) : null;

  if (source && source.isConnected()) {
    switchSource(source);
    showScreen('player');
    return;
  }

  if (spotify.spotifySource.isConnected()) {
    switchSource(spotify.spotifySource);
    showScreen('player');
    return;
  }

  refreshSetupUi();
  showScreen('setup');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Handy for poking at state from the Tesla browser's console during setup.
// renderNow is exposed too so a frame can be forced by hand -- the browser
// pauses rAF whenever the tab is hidden, which makes the live view
// untestable from a console otherwise.
app.renderNow = renderNow;
app.updateStatusOverlay = updateStatusOverlay;
window.__lyrics = app;
