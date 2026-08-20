/**
 * PlaybackClock -- turns occasional, laggy position samples into a smooth
 * millisecond-accurate playhead.
 *
 * The problem: a remote source (Spotify) tells us "position was 84200ms" but
 * that reading is already stale by the network round-trip, and we only get a
 * new one every few seconds. Naively re-reading it every poll makes lyrics
 * visibly jerk backwards and forwards.
 *
 * The fix: run a local monotonic clock between samples, and when a fresh
 * sample disagrees, *ease* onto it instead of snapping -- unless the
 * disagreement is big enough to be a real seek, in which case snap at once.
 */

var SNAP_THRESHOLD_MS = 1500;   // beyond this, assume a seek/skip, not drift
var EASE_RATE = 0.12;           // fraction of remaining error absorbed per frame

export function PlaybackClock() {
  this._basePos = 0;        // position at the last accepted sample
  this._baseAt = now();     // monotonic timestamp of that sample
  this._playing = false;
  this._error = 0;          // outstanding drift still being eased away
  this._lastEaseAt = now();
  this._offsetMs = 0;       // user-tunable nudge
  this._hasSample = false;
}

function now() {
  return (window.performance && window.performance.now)
    ? window.performance.now()
    : Date.now();
}

/**
 * Feed a fresh reading from the music source.
 * @param {number} positionMs  reported playhead
 * @param {boolean} isPlaying
 * @param {number} latencyMs   estimated age of the reading (half the RTT)
 */
PlaybackClock.prototype.sync = function (positionMs, isPlaying, latencyMs) {
  var t = now();
  // The reading describes the past; advance it to the present.
  var corrected = positionMs + (isPlaying ? (latencyMs || 0) : 0);
  var predicted = this._rawAt(t);

  if (!this._hasSample || this._playing !== isPlaying) {
    // First sample, or a play/pause edge -- no smoothing, just take it.
    this._basePos = corrected;
    this._baseAt = t;
    this._error = 0;
  } else {
    var delta = corrected - predicted;
    if (Math.abs(delta) > SNAP_THRESHOLD_MS) {
      // A real seek, a track change, or we lost time while backgrounded.
      this._basePos = corrected;
      this._baseAt = t;
      this._error = 0;
    } else {
      // Ordinary drift. Keep the smooth clock, absorb the error gradually.
      this._error = delta;
    }
  }

  this._playing = isPlaying;
  this._hasSample = true;
};

/** Position with no easing applied -- internal use. */
PlaybackClock.prototype._rawAt = function (t) {
  if (!this._playing) return this._basePos;
  return this._basePos + (t - this._baseAt);
};

/** The current playhead in ms, including user offset. Call this every frame. */
PlaybackClock.prototype.position = function () {
  var t = now();

  // Bleed off accumulated drift a little each frame so it is imperceptible.
  if (this._error !== 0) {
    var dt = t - this._lastEaseAt;
    var step = this._error * Math.min(1, EASE_RATE * (dt / 16.7));
    this._basePos += step;
    this._error -= step;
    if (Math.abs(this._error) < 1) this._error = 0;
  }
  this._lastEaseAt = t;

  return this._rawAt(t) + this._offsetMs;
};

/** Hard reset -- use on track change so the new song starts clean. */
PlaybackClock.prototype.reset = function (positionMs, isPlaying) {
  this._basePos = positionMs || 0;
  this._baseAt = now();
  this._playing = Boolean(isPlaying);
  this._error = 0;
  this._hasSample = true;
};

PlaybackClock.prototype.isPlaying = function () { return this._playing; };
PlaybackClock.prototype.setOffset = function (ms) { this._offsetMs = ms; };
PlaybackClock.prototype.offset = function () { return this._offsetMs; };

/**
 * True when we have gone a long time with no fresh sample -- the local clock
 * has been free-running and should no longer be trusted.
 */
PlaybackClock.prototype.isStale = function (maxAgeMs) {
  return this._hasSample && (now() - this._baseAt) > maxAgeMs;
};
