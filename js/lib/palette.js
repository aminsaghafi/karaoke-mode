/**
 * Pull a small colour palette out of album artwork.
 *
 * Drawn to a tiny canvas and sampled -- 24x24 is plenty, since we want the
 * broad character of the sleeve, not detail. Downscaling also does the
 * averaging for us for free.
 *
 * CORS: reading pixels back requires the image to be served with permissive
 * headers AND requested with crossOrigin set. If either fails the canvas is
 * "tainted" and getImageData throws a SecurityError. That is not recoverable,
 * so every path here falls back to a neutral palette rather than throwing --
 * a missing glow is fine, a crashed render loop is not.
 */

var SIZE = 24;

// Used when there is no artwork, or when the canvas comes back tainted.
var FALLBACK = ['#3a3a3a', '#5a5a5a', '#2a2a2a'];

var cache = {};   // url -> palette

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h = 0, s = 0, l = (max + min) / 2;
  var d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function toHex(r, g, b) {
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Rank sampled colours by how well they would work as a glow.
 *
 * Frequency alone picks the background, which on most sleeves is a muddy
 * near-black that glows into nothing. Weighting by saturation surfaces the
 * colour a person would actually name if asked about the cover.
 */
function pickColors(data) {
  var buckets = {};

  for (var i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;               // transparent
    var r = data[i], g = data[i + 1], b = data[i + 2];

    // Quantise to 4 bits per channel so near-identical pixels group up.
    var key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    if (!buckets[key]) buckets[key] = { r: 0, g: 0, b: 0, n: 0 };
    var bk = buckets[key];
    bk.r += r; bk.g += g; bk.b += b; bk.n++;
  }

  var scored = [];
  for (var k in buckets) {
    if (!Object.prototype.hasOwnProperty.call(buckets, k)) continue;
    var bu = buckets[k];
    var r2 = Math.round(bu.r / bu.n);
    var g2 = Math.round(bu.g / bu.n);
    var b2 = Math.round(bu.b / bu.n);

    var hsl = rgbToHsl(r2, g2, b2);
    var sat = hsl[1], lum = hsl[2];

    // Skip anything too dark or too washed out to read as a glow.
    if (lum < 0.12 || lum > 0.94) continue;

    // Frequency matters, but saturation matters more.
    var score = bu.n * (0.25 + sat * 1.9) * (1 - Math.abs(lum - 0.5) * 0.55);
    scored.push({ hex: toHex(r2, g2, b2), score: score, h: hsl[0] });
  }

  if (!scored.length) return null;
  scored.sort(function (a, b) { return b.score - a.score; });

  // Spread the picks around the wheel so the glow is not three shades of one
  // colour. 0.08 of the hue circle is roughly 29 degrees.
  var out = [];
  for (var j = 0; j < scored.length && out.length < 3; j++) {
    var cand = scored[j];
    var tooClose = false;
    for (var m = 0; m < out.length; m++) {
      var dh = Math.abs(out[m].h - cand.h);
      if (Math.min(dh, 1 - dh) < 0.08) { tooClose = true; break; }
    }
    if (!tooClose) out.push(cand);
  }

  // A very monochrome sleeve may not yield three distinct hues; pad it out.
  while (out.length < 3 && scored.length) {
    out.push(scored[Math.min(out.length, scored.length - 1)]);
  }

  return out.map(function (c) { return c.hex; });
}

/**
 * @param {string} url artwork URL
 * @returns {Promise<string[]>} three hex colours; never rejects
 */
export function extractPalette(url) {
  if (!url) return Promise.resolve(FALLBACK.slice());
  if (cache[url]) return Promise.resolve(cache[url].slice());

  return new Promise(function (resolve) {
    var img = new Image();
    var settled = false;

    function done(palette) {
      if (settled) return;
      settled = true;
      cache[url] = palette;
      resolve(palette.slice());
    }

    // A slow or hanging image must not leave the glow uninitialised forever.
    var timer = window.setTimeout(function () { done(FALLBACK.slice()); }, 6000);

    img.crossOrigin = 'anonymous';

    img.onload = function () {
      window.clearTimeout(timer);
      try {
        var canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, SIZE, SIZE);

        // Throws if the host did not allow cross-origin reads.
        var data = ctx.getImageData(0, 0, SIZE, SIZE).data;
        var picked = pickColors(data);
        done(picked || FALLBACK.slice());
      } catch (e) {
        console.warn('[palette] canvas read blocked, using fallback', e && e.name);
        done(FALLBACK.slice());
      }
    };

    img.onerror = function () {
      window.clearTimeout(timer);
      done(FALLBACK.slice());
    };

    img.src = url;
  });
}

export function fallbackPalette() {
  return FALLBACK.slice();
}
