/**
 * Thin localStorage wrapper.
 *
 * The Tesla browser will happily throw on storage access in some states
 * (private-ish contexts, quota, an in-progress software update), and a
 * throw here would take the whole app down mid-drive. Every access is
 * guarded and falls back to an in-memory map.
 */

var PREFIX = 'tl.';
var memory = {};
var available = (function () {
  try {
    var k = PREFIX + '__probe';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
})();

export function get(key, fallback) {
  var raw;
  try {
    raw = available ? window.localStorage.getItem(PREFIX + key) : memory[key];
  } catch (e) {
    raw = memory[key];
  }
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function set(key, value) {
  var raw = JSON.stringify(value);
  memory[key] = raw;
  if (!available) return;
  try {
    window.localStorage.setItem(PREFIX + key, raw);
  } catch (e) {
    // Quota or a locked store. The in-memory copy keeps this session working.
  }
}

export function remove(key) {
  delete memory[key];
  if (!available) return;
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch (e) {}
}

export function storageAvailable() {
  return available;
}
