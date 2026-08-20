/**
 * OAuth 2.0 PKCE helpers (RFC 7636).
 *
 * PKCE lets a pure browser app do the authorization-code flow with no client
 * secret, which is the only correct choice here: anything shipped to the car
 * is public. Requires crypto.subtle, which browsers only expose on a secure
 * origin -- hence the HTTPS hosting requirement.
 */

function base64UrlEncode(bytes) {
  var str = '';
  var arr = new Uint8Array(bytes);
  for (var i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return window.btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function randomVerifier(length) {
  var n = length || 64;
  var bytes = new Uint8Array(n);
  window.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes).slice(0, n);
}

export function challengeFrom(verifier) {
  var data = new TextEncoder().encode(verifier);
  return window.crypto.subtle.digest('SHA-256', data).then(base64UrlEncode);
}

export function isSecureContextOk() {
  return Boolean(window.isSecureContext && window.crypto && window.crypto.subtle);
}
