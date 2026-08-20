/**
 * Spotify source (OBSERVER shape).
 *
 * The car's built-in Spotify registers as a Spotify Connect device on your
 * account. That means /v1/me/player -- called from anywhere, including this
 * browser tab -- reports exactly what the car is playing and how far into it.
 * So the browser never touches audio; it just watches and mirrors.
 *
 * Auth is authorization-code + PKCE. There is no client secret, because
 * anything shipped to the car is public by definition.
 */

import { CONFIG } from '../config.js';
import * as store from '../lib/store.js';
import { randomVerifier, challengeFrom } from '../lib/pkce.js';
import { emptyState } from './source.js';

var K_TOKEN = 'spotify.token';       // { access_token, refresh_token, expires_at }
var K_VERIFIER = 'spotify.verifier';
var K_CLIENT_ID = 'spotify.clientId';

/** The redirect URI must match the dashboard entry byte for byte. */
export function redirectUri() {
  // Strip query and hash; keep the directory path so GitHub Pages project
  // sites (/user/repo/) work without hardcoding the repo name.
  var path = window.location.pathname;

  // Normalise to the directory form. Opening the page as ".../index.html"
  // would otherwise produce a URI that does not match the one registered in
  // the dashboard, and Spotify rejects the login with a mismatch error that
  // gives no hint about the cause.
  path = path.replace(/index\.html?$/i, '');
  if (path.charAt(path.length - 1) !== '/') path += '/';

  return window.location.origin + path;
}

export function getClientId() {
  return store.get(K_CLIENT_ID, CONFIG.spotify.clientId || '');
}

export function setClientId(id) {
  store.set(K_CLIENT_ID, String(id || '').trim());
}

function readToken() {
  return store.get(K_TOKEN, null);
}

function writeToken(tok, refreshFallback) {
  if (!tok || !tok.access_token) return null;
  var saved = {
    access_token: tok.access_token,
    // A refresh response may omit refresh_token, meaning "keep the old one".
    refresh_token: tok.refresh_token || refreshFallback || null,
    expires_at: Date.now() + ((tok.expires_in || 3600) * 1000)
  };
  store.set(K_TOKEN, saved);
  return saved;
}

function formBody(params) {
  var parts = [];
  for (var k in params) {
    if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  }
  return parts.join('&');
}

/* ------------------------------------------------------------------ auth */

/** Kick off the login redirect. Returns a promise that never resolves (we navigate away). */
export function beginAuth() {
  var clientId = getClientId();
  if (!clientId) return Promise.reject(new Error('No Spotify client ID set.'));

  var verifier = randomVerifier(64);
  store.set(K_VERIFIER, verifier);

  return challengeFrom(verifier).then(function (challenge) {
    var url = CONFIG.spotify.authorizeUrl + '?' + formBody({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: CONFIG.spotify.scopes.join(' ')
    });
    window.location.replace(url);
    return new Promise(function () {});
  });
}

/**
 * If we just came back from Spotify with ?code=..., trade it for a token.
 * Always clears the query string afterwards so a reload cannot replay a
 * one-time code (which would fail and look like a broken login).
 */
export function handleRedirect() {
  var params = new URLSearchParams(window.location.search);
  var code = params.get('code');
  var error = params.get('error');

  if (!code && !error) return Promise.resolve(null);

  var clean = function () {
    window.history.replaceState({}, document.title, redirectUri());
  };

  if (error) {
    clean();
    return Promise.reject(new Error('Spotify denied the request: ' + error));
  }

  var verifier = store.get(K_VERIFIER, null);
  if (!verifier) {
    clean();
    return Promise.reject(new Error('Login state was lost. Try signing in again.'));
  }

  return fetch(CONFIG.spotify.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri(),
      client_id: getClientId(),
      code_verifier: verifier
    })
  })
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error_description || body.error || 'Token exchange failed');
        return body;
      });
    })
    .then(function (body) {
      store.remove(K_VERIFIER);
      clean();
      return writeToken(body, null);
    })
    .catch(function (err) {
      clean();
      throw err;
    });
}

var refreshing = null;

function refreshToken() {
  if (refreshing) return refreshing;

  var tok = readToken();
  if (!tok || !tok.refresh_token) {
    return Promise.reject(new Error('No refresh token; sign in again.'));
  }

  refreshing = fetch(CONFIG.spotify.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: getClientId()
    })
  })
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error_description || body.error || 'Refresh failed');
        return body;
      });
    })
    .then(function (body) {
      refreshing = null;
      return writeToken(body, tok.refresh_token);
    })
    .catch(function (err) {
      refreshing = null;
      // A dead refresh token is unrecoverable: force a clean re-login.
      store.remove(K_TOKEN);
      throw err;
    });

  return refreshing;
}

/** Valid access token, refreshing 60s before expiry so no request races it. */
function validToken() {
  var tok = readToken();
  if (!tok) return Promise.reject(new Error('Not signed in.'));
  if (Date.now() < (tok.expires_at - 60000)) return Promise.resolve(tok);
  return refreshToken();
}

/* ------------------------------------------------------------------ api */

function apiGet(path) {
  return validToken().then(function (tok) {
    var startedAt = Date.now();
    return fetch('https://api.spotify.com/v1' + path, {
      headers: { 'Authorization': 'Bearer ' + tok.access_token }
    }).then(function (res) {
      var rtt = Date.now() - startedAt;
      if (res.status === 204) return { empty: true, rtt: rtt };
      if (res.status === 401) {
        // Token rejected despite looking fresh; refresh once and retry.
        return refreshToken().then(function (t2) {
          return fetch('https://api.spotify.com/v1' + path, {
            headers: { 'Authorization': 'Bearer ' + t2.access_token }
          }).then(function (r2) {
            if (r2.status === 204) return { empty: true, rtt: Date.now() - startedAt };
            if (!r2.ok) throw new Error('Spotify API ' + r2.status);
            return r2.json().then(function (j) {
              return { body: j, rtt: Date.now() - startedAt };
            });
          });
        });
      }
      if (res.status === 429) {
        var retry = parseInt(res.headers.get('Retry-After') || '3', 10);
        var e = new Error('Rate limited');
        e.retryAfterMs = retry * 1000;
        throw e;
      }
      if (!res.ok) throw new Error('Spotify API ' + res.status);
      return res.json().then(function (j) { return { body: j, rtt: rtt }; });
    });
  });
}

/* --------------------------------------------------------------- source */

var backoffUntil = 0;

export var spotifySource = {
  id: 'spotify',
  name: 'Spotify',

  capabilities: {
    isLocalPlayer: false,   // the car plays the audio; we only observe
    canControl: false,      // read-only scopes, so no transport controls
    autoDetect: true
  },

  isConfigured: function () {
    return Boolean(getClientId());
  },

  isConnected: function () {
    return Boolean(readToken());
  },

  connect: function () {
    return beginAuth();
  },

  disconnect: function () {
    store.remove(K_TOKEN);
    store.remove(K_VERIFIER);
    return Promise.resolve();
  },

  pollInterval: function () {
    return CONFIG.spotify.pollMs;
  },

  poll: function () {
    if (Date.now() < backoffUntil) return Promise.resolve(null);

    // /me/player (not /currently-playing) also tells us which device is
    // active, which is how we can say "playing on your Tesla".
    return apiGet('/me/player').then(function (res) {
      if (res.empty || !res.body || !res.body.item) return null;

      var b = res.body;
      var item = b.item;
      var art = null;
      if (item.album && item.album.images && item.album.images.length) {
        art = item.album.images[0].url;
      }

      var state = emptyState();
      state.trackId = item.id || (item.name + '|' + (item.artists ? item.artists[0].name : ''));
      state.title = item.name || '';
      state.artist = (item.artists || []).map(function (a) { return a.name; }).join(', ');
      state.album = (item.album && item.album.name) || '';
      state.durationMs = item.duration_ms || 0;
      state.positionMs = b.progress_ms || 0;
      state.isPlaying = Boolean(b.is_playing);
      state.artworkUrl = art;
      // The reading was taken roughly mid-flight, so it is about half an RTT old.
      state.latencyMs = Math.round(res.rtt / 2);
      state.deviceName = (b.device && b.device.name) || null;

      return state;
    }).catch(function (err) {
      if (err && err.retryAfterMs) {
        backoffUntil = Date.now() + err.retryAfterMs;
        console.warn('[spotify] rate limited, backing off', err.retryAfterMs);
        return null;
      }
      throw err;
    });
  }
};
