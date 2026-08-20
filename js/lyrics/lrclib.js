/**
 * LRCLIB client.
 *
 * lrclib.net is a free, open, no-auth community database of synced lyrics.
 * It sends permissive CORS headers, so the car can query it directly with no
 * server of ours in the middle. Nothing is stored in this repo: every line
 * shown is fetched at runtime from LRCLIB.
 */

import { CONFIG } from '../config.js';
import { parseLrc, parsePlain } from './lrc.js';

var cache = {};       // key -> result
var cacheOrder = [];  // eviction order
var inflight = {};    // key -> Promise, so a re-render cannot double-fetch

function cacheKey(t) {
  return [t.title, t.artist, t.album, Math.round((t.durationMs || 0) / 1000)]
    .join(' ')
    .toLowerCase();
}

function remember(key, value) {
  if (!(key in cache)) {
    cacheOrder.push(key);
    while (cacheOrder.length > CONFIG.lrclib.cacheSize) {
      delete cache[cacheOrder.shift()];
    }
  }
  cache[key] = value;
}

function getJson(url) {
  return fetch(url, { headers: { 'Accept': 'application/json' } })
    .then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('LRCLIB ' + res.status);
      return res.json();
    });
}

function toResult(record, source) {
  if (!record) return null;
  if (record.syncedLyrics) {
    var parsed = parseLrc(record.syncedLyrics);
    if (parsed.lines.length) {
      return {
        synced: true,
        lines: parsed.lines,
        meta: parsed.meta,
        source: source,
        record: record
      };
    }
  }
  if (record.plainLyrics) {
    var plain = parsePlain(record.plainLyrics);
    return { synced: false, lines: plain.lines, meta: {}, source: source, record: record };
  }
  if (record.instrumental) {
    return { synced: true, lines: [], instrumental: true, source: source, record: record };
  }
  return null;
}

/**
 * Score a search hit against the track we actually want. LRCLIB search is
 * fuzzy, and a wrong-but-plausible match (a live version, a cover, a remix of
 * very different length) is worse than showing nothing at all.
 */
function scoreCandidate(rec, track) {
  var score = 0;
  if (rec.syncedLyrics) score += 100;           // synced always beats plain

  var wantSec = Math.round((track.durationMs || 0) / 1000);
  if (wantSec && rec.duration) {
    var diff = Math.abs(rec.duration - wantSec);
    if (diff <= 2) score += 60;
    else if (diff <= 5) score += 35;
    else if (diff <= 12) score += 10;
    else score -= diff;                          // very different length
  }

  var a = String(rec.artistName || '').toLowerCase();
  var b = String(track.artist || '').toLowerCase();
  if (a && b && a === b) score += 25;
  else if (a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) score += 12;

  var ta = String(rec.trackName || '').toLowerCase();
  var tb = String(track.title || '').toLowerCase();
  if (ta && tb && ta === tb) score += 25;
  else if (ta && tb && (ta.indexOf(tb) >= 0 || tb.indexOf(ta) >= 0)) score += 12;

  return score;
}

/**
 * Look up lyrics for a track.
 * @param {{title:string, artist:string, album?:string, durationMs?:number}} track
 * @returns {Promise<null|Object>}
 */
export function fetchLyrics(track) {
  if (!track || !track.title) return Promise.resolve(null);

  var key = cacheKey(track);
  if (key in cache) return Promise.resolve(cache[key]);
  if (key in inflight) return inflight[key];

  var base = CONFIG.lrclib.base;
  var durSec = Math.round((track.durationMs || 0) / 1000);

  // Exact endpoint first: it matches on duration too, so when it hits it is
  // almost certainly the right recording.
  var exactUrl = base + '/get'
    + '?artist_name=' + encodeURIComponent(track.artist || '')
    + '&track_name=' + encodeURIComponent(track.title || '')
    + '&album_name=' + encodeURIComponent(track.album || '')
    + (durSec ? '&duration=' + durSec : '');

  var p = getJson(exactUrl)
    .then(function (rec) {
      var exact = toResult(rec, 'exact');
      if (exact) return exact;

      // Fall back to fuzzy search, then pick the best-scoring candidate.
      var searchUrl = base + '/search'
        + '?track_name=' + encodeURIComponent(track.title || '')
        + '&artist_name=' + encodeURIComponent(track.artist || '');

      return getJson(searchUrl).then(function (list) {
        if (!list || !list.length) return null;
        var best = null;
        var bestScore = -1e9;
        for (var i = 0; i < list.length; i++) {
          var s = scoreCandidate(list[i], track);
          if (s > bestScore) { bestScore = s; best = list[i]; }
        }
        // Too weak a match is worse than an honest "not found".
        if (bestScore < 40) return null;
        return toResult(best, 'search');
      });
    })
    .then(function (result) {
      remember(key, result);
      delete inflight[key];
      return result;
    })
    .catch(function (err) {
      delete inflight[key];
      // Network blip in a tunnel: do not cache the failure.
      console.warn('[lrclib] lookup failed', err);
      return null;
    });

  inflight[key] = p;
  return p;
}

/** Free-text search, used by the manual source's picker. */
export function searchLyrics(query) {
  if (!query || !query.trim()) return Promise.resolve([]);
  var url = CONFIG.lrclib.base + '/search?q=' + encodeURIComponent(query.trim());
  return getJson(url)
    .then(function (list) { return list || []; })
    .catch(function () { return []; });
}

/** Turn a raw LRCLIB search record into our internal lyrics result. */
export function recordToLyrics(record) {
  return toResult(record, 'manual');
}
