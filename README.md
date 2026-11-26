# Wigwam

A YouTube player for kids that only plays videos a grown-up has approved.

- **No algorithm.** There are no recommendations, autoplay, "up next" or endless scrolling. Kids pick a channel, then a video, from finite pages.
- **A whitelist per kid.** You approve single videos, whole channels (new uploads appear automatically) or playlists. You can hide any single video.
- **Filters.** YouTube Shorts are left out unless you allow them, either everywhere or for one channel. A list of blocked words (a starter list is included) hides matching videos from approved channels and playlists.
- **Nothing hosted.** Videos play through YouTube's own embed player (`youtube-nocookie.com`). The site is static, on GitHub Pages, and a GitHub Action refreshes the video list every night.
- **Works on an iPad, a computer or a TV browser.** Add it to an iPad's home screen as an app, and drive it with arrow keys or a TV remote.

```
data/whitelist.json  ← what you approve (edited from admin.html)
        │  GitHub Action: on every change + nightly
        ▼
data/catalog.json    ← every approved video, with titles and lengths
        │  GitHub Pages
        ▼
index.html (kids)    admin.html (grown-ups)
```

## Setup (about 15 minutes)

1. **Create a GitHub repo** (for example `wigwam`) and push this folder to its `main` branch.
   GitHub Pages on a free account needs a **public** repo, so your whitelist is visible to anyone who looks. Use nicknames for the kids, not real names.
2. **Turn on Pages.** In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. **Run the first build.** Go to **Actions → Build catalog & deploy → Run workflow**. A minute later the site is live at `https://<you>.github.io/<repo>/`.
4. **Connect the admin page.** Open `https://<you>.github.io/<repo>/admin.html` on *your* phone or computer and follow the steps on screen. You'll create a fine-grained GitHub token that can access only this repo, with **Contents: Read and write**. If you also grant **Actions: Read-only**, the page can show build progress. The token is stored only in that browser.
5. **Recommended: add a YouTube API key.** Without one, Wigwam runs in *free mode* and sees only each channel's newest ~15 videos, though the list grows every night. With a key it gets every video, plus lengths, and skips videos that can't be embedded.
   1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
   2. Go to **Credentials → Create credentials → API key**. Restricting it to the YouTube Data API v3 is a good idea.
   3. In the GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add it with the name `YOUTUBE_API_KEY`. Then run the workflow again.

   The free quota is 10,000 units a day, and Wigwam uses roughly 1 unit per 50 videos. Nightly updates cost a handful of units.

## Using it

**Grown-ups (admin.html):**
- Paste any YouTube link. Wigwam works out whether it's a video, channel or playlist. For a video link you can choose *just this video*, *the whole channel*, or *hide this video*.
- Tap the kid chips to choose who gets it, then **Approve**.
- Every item in the lists has per-kid toggles. Use *What Fox sees* to view everything one kid can watch.
- Tap a channel or playlist (or its **Videos** button) to open it. Every video is there, newest first. Tap a picture to hide it, tap again to show it. Search the titles to find videos, and **Hide all** or **Unhide all** of the matches at once. **Watch ↗** previews a video on YouTube.
- **Filters → YouTube Shorts** switches Shorts on or off for every channel. Each channel's **Shorts** button overrides that for just that channel. Playlists and single videos always show what you picked, even if it's a Short.
- **Filters → Blocked words** hides any channel or playlist video whose title contains one of the words. In API mode, YouTube tags are checked too.
  - Matching is by whole word and ignores capitals and accents, so *kill* doesn't block *skill* or *Killer Whales*.
  - A `*` matches any ending: *prank\** blocks *pranks* and *pranking*.
  - The page shows straight away which videos your words would hide. Use **Allow anyway** to make an exception for one of them.
  - Videos you approve one at a time are always shown; you'll get a heads-up if one matches a blocked word.
- Changes collect in the bar at the bottom. Press **Publish** when you're done, and the kids' app updates about a minute later.
- On a computer, drag the **＋ Wigwam** bookmarklet (under "Tip" on the admin page) to your bookmarks bar. Clicking it on any YouTube page opens the admin page with that link already filled in.

**Kids (index.html):** pick your face, pick a channel, pick a video. When a video ends you get *Watch again* or *Back*, and nothing plays by itself. Watched videos get a ✓, and long videos resume where you left off.

## Locking down the device

Wigwam shows only approved videos, but it can't stop a kid leaving the app and opening YouTube. The device has to do that:

- **iPad / iPhone:**
  1. In Safari, open the site, tap **Share → Add to Home Screen**, and use that icon from then on.
  2. Turn on **Settings → Accessibility → Guided Access**. Open Wigwam and triple-click the side or home button to lock the iPad into it.
  3. Use **Screen Time → Content & Privacy → Allowed Apps** to hide the YouTube app and other browsers.
- **Android tablet:** install the Wigwam app (below), then use **App pinning** or a Family Link profile to keep kids in it.
- **Laptop / Chromebook:** run Chrome in kiosk mode (`chrome --kiosk https://<you>.github.io/<repo>/`), or use a supervised profile with a site allowlist.
- **TV:** open the site in the TV's browser (Fire TV Silk, Google TV, or a smart-TV browser) and use the remote's arrow keys. A laptop on HDMI also works. **Don't cast to the YouTube TV app**, because that brings back autoplay and recommendations.

Before relying on a content filter that blocks `youtube.com`, test that videos still play. The embed player loads from YouTube's domains.

## Android app

`android/` holds a small Android app that opens the site full screen with no address bar. It only loads Wigwam's own pages: links to YouTube or anywhere else are ignored, and the grown-ups page is blocked inside it. The tablet's Back button acts as Wigwam's Back, and the screen stays awake while a video plays. It isn't in any app store; you install it over USB.

1. Install a JDK 17+ and the Android SDK (Android Studio installs both). On the tablet, turn on **Developer options → USB debugging** and plug it in.
2. Run `bash android/build.sh --install` (Git Bash on Windows). To point it at a different site, pass the URL: `bash android/build.sh https://you.github.io/repo/ --install`.

## How the player works

- Videos play in YouTube's own embed player, with YouTube's own controls, on the privacy-enhanced `youtube-nocookie.com` host (`rel=0`, `iv_load_policy=3`, `fs=0`).
- When a video is paused or ends, a Wigwam card covers YouTube's "More videos" and end-screen suggestions. Kids get *Keep watching*, *Watch again* or *Back*, and nothing plays by itself.
- YouTube's full-screen button is turned off, because the card can't cover suggestions inside YouTube's full screen. The Android app and the iPad home-screen app are already full screen.
- The player only accepts video IDs that are in the kid's own approved list.
- YouTube's title, channel icon and logo still link to YouTube. **The Android app ignores those taps.** In a normal browser they open YouTube, so lock the device down as described above.

This is meant for your own family's use. YouTube's developer policies don't allow covering parts of its player, so don't publish it as a product.

## Running locally

```
start.bat                                   # serves http://localhost:8080 (needs Python)
node scripts/build-catalog.mjs              # rebuild data/catalog.json (free mode)
set YOUTUBE_API_KEY=... && node scripts/build-catalog.mjs --full
```

On `localhost` the admin page works without a token: it edits a local copy, and **Download whitelist.json** saves the result for you to drop into `data/`.

## Files

| File | What it does |
|---|---|
| `index.html`, `app.js`, `styles.css` | Kids' app: profiles → channels → finite video pages |
| `player.js` | YouTube's player with a Back bar and pause/end covers |
| `nav.js` | Arrow-key navigation for keyboards and TV remotes |
| `admin.html`, `admin.js` | Grown-ups' page; saves to GitHub through the Contents API |
| `data/whitelist.json` | Source of truth: settings (Shorts, blocked words, exceptions), profiles, channels, playlists, videos, hidden videos |
| `data/catalog.json` | Generated; don't edit. Hidden videos stay in the lists but are marked in `hidden`, so un-hiding one is instant |
| `data/kids/` | Generated; one small file per kid with just their videos, plus `index.json`, which the kids' app checks to see whether anything changed |
| `data/tags.json` | Generated; YouTube tags used for blocked-word matching (API mode) |
| `shared.js` | Helpers, plus the blocked-word matcher and starter list (`SUGGESTED_TERMS`) |
| `scripts/build-catalog.mjs` | Builds the catalog: YouTube Data API with a key, RSS feeds without one |
| `.github/workflows/build.yml` | Builds on every push, nightly (incremental) and weekly (full), then deploys Pages |
| `scripts/make-icons.py` | Makes the app icons from `icons/wigwam-source.webp` (needs Python and Pillow) |
