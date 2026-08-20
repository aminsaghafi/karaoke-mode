/**
 * Static defaults. Anything the driver can change at runtime lives in
 * localStorage (see js/lib/store.js) so the app is configurable from the
 * car's touchscreen without editing and redeploying code.
 */
export var CONFIG = {
  appName: 'Karaoke Mode',

  spotify: {
    // Optional. If you bake your client ID in here it is prefilled on the
    // setup screen. A Spotify client ID is not a secret (PKCE has no secret),
    // so committing it is fine.
    clientId: '',
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    scopes: [
      'user-read-playback-state',
      'user-read-currently-playing'
    ],
    // Spotify's rolling limit is generous (~180 req/min). 2.5s keeps the
    // clock honest without burning quota on a long drive.
    pollMs: 2500,
    // Re-poll fast right after a track change so the next song's lyrics
    // appear near-instantly instead of up to pollMs later.
    fastPollMs: 700
  },

  appleMusic: {
    // See js/sources/applemusic.js. Requires a paid Apple Developer account
    // to mint a developer token; there is no free tier for MusicKit.
    developerToken: ''
  },

  lrclib: {
    base: 'https://lrclib.net/api',
    // A local cache stops us refetching the same LRC every time a song
    // repeats, and keeps lyrics alive through a tunnel/dead-zone.
    cacheSize: 120
  },

  ui: {
    // How far past a line's timestamp before we consider the next one active.
    // Slight negative bias makes lines land a touch early, which reads better
    // than lagging behind the vocal.
    leadMs: 180,
    // A gap longer than this between sung lines is treated as instrumental.
    instrumentalGapMs: 5000
  }
};
