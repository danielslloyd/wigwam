// The video player: YouTube's own embed player with YouTube's own controls.
//
// Wigwam adds only three things around it:
//  - a slim bar above the video with a Back button and the title;
//  - a cover card whenever the video is paused or ends, which hides YouTube's
//    "More videos" and end-screen suggestions (Keep watching / Watch again / Back);
//  - an invisible tap-blocker over the bottom-right of YouTube's control bar, where
//    its "More videos" button (suggestions while playing) and logo sit;
//  - progress reporting, for "watched" ticks and resuming long videos.
// YouTube's full-screen button is turned off (fs=0), because in YouTube's full
// screen the cover can't sit on top of the suggestions. Nothing plays by itself
// after a video ends.

import { esc, thumbUrl } from './shared.js';

let apiPromise;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('offline')); };
    document.head.append(s);
  });
  return apiPromise;
}

const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const PAUSE_COVER_DELAY = 600; // ms; dragging YouTube's progress bar pauses briefly, so don't flash the cover

/**
 * @param {HTMLElement} root
 * @param {{ videoId: string, title: string, startAt?: number, onBack: () => void,
 *           onProgress?: (t: number, d: number) => void, onEnded?: () => void }} opts
 * @returns {() => void} destroy
 */
export function mountPlayer(root, opts) {
  const { videoId, title, onBack } = opts;

  root.innerHTML = `
    <div class="stage">
      <div class="topbar">
        <button class="pbtn back" id="back" aria-label="Back">←</button>
        <div class="ptitle">${esc(title)}</div>
      </div>
      <div class="frame">
        <div id="yt"></div>
        <div class="yt-guard" aria-hidden="true"></div>
        <div class="cover hidden" id="cover" style="--thumb:url('${thumbUrl(videoId, 'hqdefault')}')">
          <div class="cover-inner">
            <div class="cover-msg" id="cover-msg"></div>
            <div class="cover-actions" id="cover-actions"></div>
          </div>
        </div>
      </div>
    </div>`;

  const $ = (id) => root.querySelector('#' + id);
  const cover = $('cover');
  let player = null, ready = false, destroyed = false, state = S.UNSTARTED;
  let ticker = 0, pauseTimer = 0, resumeTimer = 0, lastProgress = 0;

  // In the Android app: keep the screen awake only while a video is actually playing.
  const keepAwake = (on) => { try { window.WigwamApp?.setPlaying(on); } catch {} };

  // ---- cover card
  function showCover(mode, msg = '') {
    $('cover-msg').textContent = msg;
    $('cover-actions').innerHTML = {
      paused: `<button class="cbtn primary" data-act="play">▶ Keep watching</button><button class="cbtn" data-act="back">← Back</button>`,
      ended: `<button class="cbtn primary" data-act="restart">↺ Watch again</button><button class="cbtn" data-act="back">← Back</button>`,
      error: `<button class="cbtn primary" data-act="back">← Back</button>`,
    }[mode];
    cover.dataset.mode = mode;
    cover.classList.remove('hidden');
    cover.querySelector('.cbtn')?.focus({ preventScroll: true });
  }
  const hideCover = () => cover.classList.add('hidden');

  cover.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') resume();
    else if (act === 'restart') { player?.seekTo(0, true); resume(); }
    else if (act === 'back') onBack();
  });
  $('back').addEventListener('click', onBack);

  function resume() {
    if (!ready) return;
    player.playVideo();
    // If the browser won't start playback from outside the player (sometimes iOS),
    // step aside so YouTube's own play button can be tapped.
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { if (state !== S.PLAYING && state !== S.BUFFERING) hideCover(); }, 1500);
  }

  // Play/pause from a keyboard or TV remote without having to focus the video.
  function onKey(e) {
    if (!ready || !cover.classList.contains('hidden')) return;
    const onButton = document.activeElement?.tagName === 'BUTTON';
    if (e.key === 'MediaPlayPause' || (e.key === ' ' && !onButton) || (e.key === 'Enter' && !onButton)) {
      e.preventDefault();
      if (state === S.PLAYING || state === S.BUFFERING) player.pauseVideo(); else player.playVideo();
    }
  }
  document.addEventListener('keydown', onKey);

  function tick() {
    if (!ready || !opts.onProgress) return;
    const t = player.getCurrentTime() || 0;
    if (Math.abs(t - lastProgress) >= 5) { lastProgress = t; opts.onProgress(t, player.getDuration() || 0); }
  }

  function onStateChange(e) {
    state = e.data;
    keepAwake(state === S.PLAYING || state === S.BUFFERING);
    clearTimeout(pauseTimer);
    if (state === S.PLAYING) { clearTimeout(resumeTimer); hideCover(); }
    if (state === S.PAUSED) {
      tick();
      pauseTimer = setTimeout(() => { if (state === S.PAUSED) showCover('paused'); }, PAUSE_COVER_DELAY);
    }
    if (state === S.ENDED) {
      const d = player.getDuration();
      opts.onProgress?.(d, d);
      opts.onEnded?.();
      showCover('ended', 'All done!');
    }
  }

  function onError(e) {
    const msg = { 2: "This video link doesn't work.", 100: 'This video was removed or made private.', 101: "This video can't be played here.", 150: "This video can't be played here." }[e.data]
      || "This video can't be played right now.";
    showCover('error', msg);
  }

  loadYouTubeApi().then((YT) => {
    if (destroyed) return;
    player = new YT.Player($('yt'), {
      host: 'https://www.youtube-nocookie.com',
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        controls: 1, fs: 0, rel: 0, iv_load_policy: 3, playsinline: 1, autoplay: 0,
        start: Math.floor(opts.startAt || 0), origin: location.origin,
      },
      events: {
        onReady() {
          if (destroyed) return;
          ready = true;
          ticker = setInterval(tick, 1000);
          player.playVideo(); // if the browser blocks this, YouTube's own big play button is showing
        },
        onStateChange,
        onError,
      },
    });
  }).catch(() => showCover('error', "Couldn't reach YouTube. Check the internet connection."));

  return function destroy() {
    destroyed = true;
    keepAwake(false);
    clearInterval(ticker); clearTimeout(pauseTimer); clearTimeout(resumeTimer);
    document.removeEventListener('keydown', onKey);
    if (ready) { try { const t = player.getCurrentTime(), d = player.getDuration(); opts.onProgress?.(t, d); } catch {} }
    try { player?.destroy(); } catch {}
  };
}
