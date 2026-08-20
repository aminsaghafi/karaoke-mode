# Tesla Lyrics

Time-synced lyrics in the Tesla browser. Karaoke-style: the current line is
large and white, the rest fall away, and the column scrolls itself.

No build step, no dependencies, no backend. Static files you can drop on
GitHub Pages.

---

## The one constraint that shapes everything

**The Tesla browser cannot see what the car's built-in media player is
playing.** There is no API for it. So the app needs another way to know the
song and the playhead. There are two shapes, and they are genuinely different:

| | How it works | Driver effort |
|---|---|---|
| **Spotify** | Your car's Spotify is a Spotify Connect device. The Web API reports what it is playing, from anywhere. The browser just watches. | None. It follows along by itself. |
| **Manual** | You search the song and tap to sync. Local stopwatch, no audio. | A few taps per song. |

Spotify is the mode worth having. Manual is the fallback for FM radio, USB, or
a phone over Bluetooth — anything with no API to observe.

---

## Setup

### 1. Create a Spotify app (one time, ~2 minutes)

1. Go to <https://developer.spotify.com/dashboard> and log in.
2. **Create app**. Name and description can be anything.
3. For **Redirect URI**, enter the URL where you will host this, with a
   trailing slash. For GitHub Pages that is:

   ```
   https://<your-username>.github.io/<repo-name>/
   ```

   It must match *byte for byte*, trailing slash included. The app shows you
   the exact string it will send on its setup screen — copy it from there if
   in doubt.
4. Under **APIs used**, tick **Web API**.
5. Save, then copy the **Client ID**. It is not a secret (this uses PKCE, which
   has no client secret), so it is safe in a browser or committed to the repo.

> **Dev mode limit:** a new Spotify app is in development mode and only works
> for accounts you explicitly allowlist. Add yourself under
> **Settings → User Management**, using the email on your Spotify account.
> Without this you will sign in fine and then see no playback data.

### 2. Deploy to GitHub Pages

```bash
git init && git add -A && git commit -m "Tesla Lyrics"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → `main` / `root`**.

HTTPS is required — Spotify's PKCE login needs `crypto.subtle`, which browsers
only expose on a secure origin. GitHub Pages gives you HTTPS automatically.

### 3. First run in the car

Open the URL in the Tesla browser, tap **Spotify**, paste your Client ID, and
tap **Connect**. You will approve once and land back in the app. Play something
and lyrics follow on their own.

Bookmark it — the Tesla browser keeps bookmarks on the home screen.

---

## Using it

- **Nothing to do in Spotify mode.** Start a song; lyrics appear.
- **Lines feel early or late?** Settings (⚙) → *Lyric timing*, nudge in 0.25s
  steps. It is remembered.
- **Text too small at a glance?** Settings → *Text size*, up to XL.
- **Automatic match wrong?** The "no lyrics found" screen has a manual search.
- **Manual mode:** tap the line being sung right now and the clock snaps to it.
  Far more accurate than trying to hit play at the exact top of the song.

---

## Where lyrics come from

[LRCLIB](https://lrclib.net) — a free, open, no-auth community database of
synced lyrics. The car queries it directly; nothing is proxied and no lyrics
are stored in this repo. Coverage is good for popular music and thinner for
obscure tracks, where you may get plain text or nothing.

---

## Adding Apple Music later

The code is built for this — `js/sources/source.js` defines the interface and
`js/sources/applemusic.js` is a documented stub. But read this before starting,
because it is **not** a drop-in swap for Spotify:

Apple has **no remote now-playing API**. MusicKit reports the playhead of the
player *it* owns. There is no way to ask "what is my Apple Music playing on
some other device." So Apple Music cannot be an observer the way Spotify is —
the browser tab would have to *be* the player, streaming the audio itself.

That means:

- Music gets picked inside this app, not the car's Media panel.
- Audio comes out of the browser, not the car's media path. Steering-wheel
  controls will not drive it.
- You need a **paid Apple Developer account** to mint a developer token, and
  the token must be signed somewhere that is not the browser — so you would
  need a small serverless endpoint. That breaks the "pure static site" property.

If the goal is hands-off lyrics while driving, Spotify is the mode that
delivers it. Manual mode already covers Apple Music today at the cost of a few
taps per song.

To wire it up anyway: implement `poll()` to return a `PlaybackState`, set
`capabilities.isLocalPlayer` and `canControl` to `true`, and the clock, lyrics
lookup, and rendering all work unchanged.

---

## Project layout

```
index.html            three screens: setup, player, search/settings
css/app.css           dark, high-contrast, big touch targets
js/config.js          tunables (poll rates, timing bias)
js/main.js            orchestration: poll loop + render loop
js/lib/clock.js       drift-corrected playhead  <- the sync quality lives here
js/lib/pkce.js        OAuth PKCE helpers
js/lib/store.js       localStorage, guarded
js/lyrics/lrc.js      .lrc parser + binary-search line lookup
js/lyrics/lrclib.js   LRCLIB client, match scoring, caching
js/sources/source.js  the MusicSource interface  <- read this first
js/sources/spotify.js observer implementation
js/sources/manual.js  local stopwatch implementation
js/sources/applemusic.js  documented stub
```

### How the sync actually works

Two loops, deliberately decoupled — coupling network cadence to render cadence
is what makes most lyric apps stutter:

- **Poll loop** (every ~2.5s) asks the source what is playing and feeds the
  reading into the clock.
- **Frame loop** (`requestAnimationFrame`) reads the clock and moves the column.

A reading from Spotify is already stale by half a network round-trip, and only
arrives every few seconds. `PlaybackClock` runs a local monotonic clock between
readings and *eases* onto each new one instead of snapping — unless the
disagreement exceeds 1.5s, which means a real seek or skip, and it snaps at
once. That is the difference between lyrics that glide and lyrics that twitch.

---

## Tesla browser notes

- It caches hard. `index.html` loads the CSS and `main.js` with a `?v=N` query
  — bump it after deploying changes. Note this does *not* cover the modules
  `main.js` imports, since ES imports do not inherit the parent's query string;
  GitHub Pages sends a ~10 minute `max-age`, so those refresh on their own
  shortly after. If you need a change immediately, close the browser tab in the
  car and reopen it.
- `requestAnimationFrame` stops entirely when the tab is hidden. Returning to
  the tab forces an immediate resync and repaint rather than trusting the
  free-running clock.
- Everything avoids optional chaining and nullish coalescing, so it runs on the
  older Chromium builds in pre-2022 cars.

## Local development

```bash
python3 -m http.server 8123
```

Manual mode works fully over `http://localhost`. Spotify sign-in does not —
it needs HTTPS, so test that on the deployed URL.

---

Set the parking brake before typing. This is for passengers and red lights.
