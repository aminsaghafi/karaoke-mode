/**
 * LyricsView -- renders the scrolling lyric column.
 *
 * Two rules drive the design, both about it being used in a moving car:
 *   1. The active line is always vertically centred, so the driver's eyes
 *      never hunt for it. Everything scrolls under a fixed focal point.
 *   2. Never re-render on every frame. Lines are built once per song; each
 *      frame only moves a transform and swaps a class. That keeps it smooth
 *      on the older Chromium builds in pre-2022 cars.
 */

import { activeIndexAt } from '../lyrics/lrc.js';
import { CONFIG } from '../config.js';

export function LyricsView(root) {
  this.root = root;
  this.scroller = document.createElement('div');
  this.scroller.className = 'lyrics-scroller';
  this.root.appendChild(this.scroller);

  this.lines = [];
  this.nodes = [];
  this.activeIndex = -2;      // -2 forces the first update to paint
  this.unsynced = false;
  this.onSeekToLine = null;   // set by the app for tap-to-sync
}

/** Load a new set of lines. Rebuilds the DOM once. */
LyricsView.prototype.setLyrics = function (result) {
  var self = this;
  this.scroller.innerHTML = '';
  this.nodes = [];
  this.activeIndex = -2;
  this.lines = (result && result.lines) || [];
  this.unsynced = Boolean(result && result.synced === false);

  this.root.classList.toggle('is-unsynced', this.unsynced);

  if (!this.lines.length) return;

  // Spacers let the first and last lines reach the centre of the screen.
  var top = document.createElement('div');
  top.className = 'lyrics-spacer';
  this.scroller.appendChild(top);

  for (var i = 0; i < this.lines.length; i++) {
    var line = this.lines[i];
    var el = document.createElement('div');
    el.className = 'lyric-line';

    if (!line.text) {
      // A timestamped blank is an instrumental beat, not a missing line.
      el.classList.add('is-break');
      el.textContent = '♪';
    } else {
      el.textContent = line.text;
    }

    if (!this.unsynced) {
      el.setAttribute('data-index', String(i));
      // Tapping a line is how the driver re-syncs a drifting manual track.
      el.addEventListener('click', (function (idx) {
        return function () {
          if (self.onSeekToLine) self.onSeekToLine(self.lines[idx].timeMs, idx);
        };
      })(i));
    }

    this.scroller.appendChild(el);
    this.nodes.push(el);
  }

  var bottom = document.createElement('div');
  bottom.className = 'lyrics-spacer';
  this.scroller.appendChild(bottom);

  if (this.unsynced) {
    // No timings to follow, so just show it as a static readable column.
    this.scroller.style.transform = 'translateY(0)';
  }
};

/**
 * Advance to `positionMs`. Called every frame; must stay cheap.
 * Returns info the caller uses to drive the instrumental indicator.
 */
LyricsView.prototype.update = function (positionMs) {
  if (this.unsynced || !this.lines.length) return null;

  var idx = activeIndexAt(this.lines, positionMs + CONFIG.ui.leadMs);

  if (idx !== this.activeIndex) {
    this._setActive(idx);
    this.activeIndex = idx;
  }

  return this._gapInfo(idx, positionMs);
};

LyricsView.prototype._setActive = function (idx) {
  // Only touch the nodes whose state actually changed.
  var prev = this.activeIndex;
  if (prev >= 0 && this.nodes[prev]) {
    this.nodes[prev].classList.remove('is-active');
  }
  // Clear the old proximity classes.
  for (var d = 1; d <= 2; d++) {
    if (prev - d >= 0 && this.nodes[prev - d]) this.nodes[prev - d].classList.remove('is-near', 'is-far');
    if (this.nodes[prev + d]) this.nodes[prev + d].classList.remove('is-near', 'is-far');
  }

  if (idx >= 0 && this.nodes[idx]) {
    this.nodes[idx].classList.add('is-active');
    if (this.nodes[idx - 1]) this.nodes[idx - 1].classList.add('is-near');
    if (this.nodes[idx + 1]) this.nodes[idx + 1].classList.add('is-near');
    if (this.nodes[idx - 2]) this.nodes[idx - 2].classList.add('is-far');
    if (this.nodes[idx + 2]) this.nodes[idx + 2].classList.add('is-far');
  }

  this._scrollTo(idx);
};

/**
 * Centre the active line. Measured from live offsetTop rather than assuming a
 * fixed line height, because lines wrap to two or three rows on long lyrics.
 */
LyricsView.prototype._scrollTo = function (idx) {
  var y = 0;
  if (idx >= 0 && this.nodes[idx]) {
    var node = this.nodes[idx];
    y = node.offsetTop + (node.offsetHeight / 2) - (this.root.clientHeight / 2);
  } else if (this.nodes.length) {
    // Before the first line: park just above it.
    y = this.nodes[0].offsetTop - (this.root.clientHeight / 2);
  }
  this.scroller.style.transform = 'translateY(' + (-Math.round(y)) + 'px)';
};

/** How long until the next line, so the UI can show an instrumental countdown. */
LyricsView.prototype._gapInfo = function (idx, positionMs) {
  var nextIdx = idx + 1;
  if (nextIdx >= this.lines.length) {
    return { inGap: false, untilNextMs: 0, atEnd: true };
  }
  var nextAt = this.lines[nextIdx].timeMs;
  var currentAt = (idx >= 0) ? this.lines[idx].timeMs : 0;
  var gapLength = nextAt - currentAt;
  var until = nextAt - positionMs;

  // Only call it instrumental if the whole gap is long AND the current line
  // is silent or we are before the song's first line.
  //
  // Note this runs right up to the next line (until > 0) rather than cutting
  // out early. The count-in needs those last seconds -- they are the whole
  // point of it -- so stopping short would strand the final beat.
  var currentIsBlank = (idx < 0) || !this.lines[idx].text;
  var inGap = currentIsBlank && gapLength > CONFIG.ui.instrumentalGapMs && until > 0;

  return { inGap: inGap, untilNextMs: until, atEnd: false };
};

/** Recentre after a resize or a font-size change. */
LyricsView.prototype.relayout = function () {
  if (!this.unsynced) this._scrollTo(this.activeIndex);
};

LyricsView.prototype.clear = function () {
  this.scroller.innerHTML = '';
  this.nodes = [];
  this.lines = [];
  this.activeIndex = -2;
};
