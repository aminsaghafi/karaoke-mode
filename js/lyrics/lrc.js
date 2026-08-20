/**
 * LRC parser.
 *
 * The format is a de-facto standard rather than a spec, so this is deliberately
 * permissive. Handles:
 *   [mm:ss.xx] / [mm:ss.xxx] / [mm:ss]   timestamps
 *   [00:12.00][01:40.00] shared line     repeated choruses on one line
 *   [ar:...] [ti:...] [offset:...]       ID3-style metadata tags
 *   blank text after a timestamp          instrumental / breath markers
 */

var TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
var META_TAG = /^\[([a-zA-Z]+):(.*)\]$/;

function toMs(min, sec, frac) {
  var ms = 0;
  if (frac) {
    // "5" -> 500ms, "05" -> 50ms, "005" -> 5ms
    ms = parseInt(frac, 10) * Math.pow(10, 3 - frac.length);
  }
  return (parseInt(min, 10) * 60000) + (parseInt(sec, 10) * 1000) + ms;
}

/**
 * @param {string} text raw .lrc contents
 * @returns {{lines: Array<{timeMs:number,text:string}>, meta: Object, offsetMs: number}}
 */
export function parseLrc(text) {
  var out = [];
  var meta = {};
  var offsetMs = 0;

  if (!text) return { lines: [], meta: meta, offsetMs: 0 };

  var rows = String(text).split(/\r\n|\n|\r/);

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row.trim()) continue;

    // Metadata lines look like timestamps but have a letter key.
    var m = row.trim().match(META_TAG);
    if (m && !/^\d+$/.test(m[1])) {
      var key = m[1].toLowerCase();
      var val = m[2].trim();
      meta[key] = val;
      if (key === 'offset') {
        var parsed = parseInt(val, 10);
        // Note the sign convention: a positive [offset:] means the lyrics
        // should appear *earlier*, so it subtracts from the timestamp.
        if (!isNaN(parsed)) offsetMs = -parsed;
      }
      continue;
    }

    TIME_TAG.lastIndex = 0;
    var stamps = [];
    var match;
    while ((match = TIME_TAG.exec(row)) !== null) {
      stamps.push(toMs(match[1], match[2], match[3]));
    }
    if (!stamps.length) continue;

    var content = row.replace(TIME_TAG, '').trim();
    for (var j = 0; j < stamps.length; j++) {
      out.push({ timeMs: stamps[j], text: content });
    }
  }

  out.sort(function (a, b) { return a.timeMs - b.timeMs; });

  if (offsetMs !== 0) {
    for (var k = 0; k < out.length; k++) out[k].timeMs += offsetMs;
  }

  return { lines: out, meta: meta, offsetMs: offsetMs };
}

/**
 * Index of the line that should be highlighted at `positionMs`, or -1 if the
 * song has not reached the first line yet.
 *
 * Binary search: called every animation frame, and some tracks have hundreds
 * of lines.
 */
export function activeIndexAt(lines, positionMs) {
  if (!lines || !lines.length) return -1;
  if (positionMs < lines[0].timeMs) return -1;

  var lo = 0;
  var hi = lines.length - 1;
  var best = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= positionMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Convert plain (unsynced) lyrics into the same shape, with no timings. */
export function parsePlain(text) {
  if (!text) return { lines: [], meta: {}, offsetMs: 0, unsynced: true };
  var rows = String(text).split(/\r\n|\n|\r/).map(function (r) {
    return { timeMs: -1, text: r.trim() };
  });
  return { lines: rows, meta: {}, offsetMs: 0, unsynced: true };
}
