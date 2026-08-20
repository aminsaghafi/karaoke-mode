/**
 * Theme resolution: dark, light, or automatic.
 *
 * "Auto" tries three sources in descending order of trustworthiness:
 *
 *   1. Real sunrise/sunset for the car's position. The only one that is
 *      actually correct year-round, so it wins whenever a position is known.
 *   2. prefers-color-scheme. Free if the browser reports it, but whether
 *      Tesla wires its display setting through to the media query is not
 *      something we can rely on -- hence second, not first.
 *   3. A fixed clock window. Crude, but better than nothing when there is no
 *      position and the browser expresses no preference.
 *
 * CSS only ever sees data-theme="dark" or "light"; the auto case is resolved
 * here so no stylesheet has to duplicate itself inside a media query.
 */

import * as store from './store.js';
import { isDaylightAt, isDaylightByClock } from './daylight.js';

var K_PREF = 'theme';           // 'dark' | 'light' | 'auto'
var K_COORDS = 'theme.coords';  // { lat, lng, at }

// Position is cached rather than requested repeatedly. Sunset moves by about
// a minute a day, so a stale fix is still fine for days; refresh occasionally
// only so a long trip across time zones eventually corrects itself.
var COORD_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function getPreference() {
  return store.get(K_PREF, 'auto');
}

export function setPreference(pref) {
  store.set(K_PREF, pref);
}

function cachedCoords() {
  return store.get(K_COORDS, null);
}

/** True once we have a cached fix, so auto can use real solar times. */
export function hasPosition() {
  return Boolean(cachedCoords());
}

/** Resolve the stored preference to a concrete theme. */
export function resolveTheme() {
  var pref = getPreference();
  if (pref === 'dark' || pref === 'light') return pref;

  var c = cachedCoords();
  if (c) {
    var day = isDaylightAt(new Date(), c.lat, c.lng);
    if (day !== null) return day ? 'light' : 'dark';
  }

  if (window.matchMedia) {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  }

  return isDaylightByClock(new Date()) ? 'light' : 'dark';
}

/** Write the resolved theme onto <html>. Returns what it settled on. */
export function applyTheme() {
  var theme = resolveTheme();
  document.documentElement.setAttribute('data-theme', theme);
  return theme;
}

/**
 * Ask for the car's position so auto mode can use real solar times.
 *
 * Only ever called when the driver actively chooses Auto -- a location prompt
 * on first load, before anyone has asked for anything, would be rude. Never
 * rejects: no permission simply means auto falls through to its lesser
 * sources.
 */
export function ensurePosition() {
  var c = cachedCoords();
  if (c && (Date.now() - c.at) < COORD_MAX_AGE_MS) return Promise.resolve(c);

  return new Promise(function (done) {
    if (!navigator.geolocation) return done(null);

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var fresh = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          at: Date.now()
        };
        store.set(K_COORDS, fresh);
        done(fresh);
      },
      function () { done(null); },          // denied, unavailable, or timed out
      { timeout: 8000, maximumAge: 3600000, enableHighAccuracy: false }
    );
  });
}

/**
 * Keep the theme honest while the app sits open.
 *
 * A drive can easily straddle sunset, and the app may be open for hours, so
 * a one-shot decision at load is not enough. One minute is far finer than
 * needed to catch a transition without being noticeable work.
 */
export function watchTheme(onChange) {
  var current = applyTheme();

  window.setInterval(function () {
    var next = resolveTheme();
    if (next !== current) {
      current = next;
      document.documentElement.setAttribute('data-theme', next);
      if (onChange) onChange(next);
    }
  }, 60000);

  // Also react immediately if the browser's own preference flips.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var handler = function () {
      var next = resolveTheme();
      if (next !== current) {
        current = next;
        document.documentElement.setAttribute('data-theme', next);
        if (onChange) onChange(next);
      }
    };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
  }
}
