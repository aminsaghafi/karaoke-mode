/**
 * Source registry.
 *
 * Add a new backend by importing it and pushing it into SOURCES. Order here is
 * the order shown on the setup screen.
 */

import { spotifySource } from './spotify.js';
import { manualSource } from './manual.js';
import { appleMusicSource } from './applemusic.js';
import * as store from '../lib/store.js';

var K_ACTIVE = 'activeSource';

export var SOURCES = [
  spotifySource,
  manualSource,
  appleMusicSource
];

export function getSource(id) {
  for (var i = 0; i < SOURCES.length; i++) {
    if (SOURCES[i].id === id) return SOURCES[i];
  }
  return null;
}

/** Sources worth offering: configured, or configurable from the setup screen. */
export function availableSources() {
  return SOURCES.filter(function (s) {
    return s.id === 'spotify' || s.id === 'manual' || s.isConfigured();
  });
}

export function activeSourceId() {
  return store.get(K_ACTIVE, null);
}

export function setActiveSourceId(id) {
  store.set(K_ACTIVE, id);
}
