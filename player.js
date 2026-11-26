// A locked-down YouTube player.
//
// The YouTube iframe sits underneath a transparent "shield", so nothing inside
// it (title, channel link, logo, "Watch on YouTube", suggested videos) can be
// tapped. We draw our own controls, and whenever the video is paused or ends
// an opaque cover hides YouTube's "More videos" / end-screen suggestions.
// Nothing ever plays automatically after a video finishes.

import { esc, fmtDuration, thumbUrl } from './shared.js';

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

/**
 * @param {HTMLElement} root
 * @param {{ videoId: string, title: string, startAt?: number, onBack: () => void,
 *           onProgress?: (t: number, d: number) => void, onEnded?: () => void }} opts
 * @returns {() => void} destroy
 */
export function mountPlayer(root, opts) {
  const { videoId, title, onBack } = opts;
  const canFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

  root.innerHTML = `
    <div class="stage" id="stage">
      <div class="frame"><div id="yt"></div></div>
      <div class="shield" id="shield"></div>
      <div class="topbar" id="topbar">
        <button class="pbtn back" id="back" aria-label="Back">←</button>
        <div class="ptitle">${esc(title)}</div>
      </div>
      <div class="controls" id="controls">
        <button class="pbtn" id="rew" aria-label="Back 10 seconds">⟲10</button>
        <button class="pbtn big" id="toggle" aria-label="Play">▶</button>
        <button class="pbtn" id="fwd" aria-label="Forward 10 seconds">10⟳</button>
        <input type="range" id="scrub" min="0" max="100" step="1" value="0" aria-label="Position">
        <span class="time" id="time">0:00</span>
        ${canFullscreen ? '<button class="pbtn" id="fs" aria-label="Full screen">⛶</button>' : ''}
      </div>
      <div class="cover" id="cover" style="--thumb:url('${thumbUrl(videoId, 'hqdefault')}')">
        <div class="cover-inner">
          <h2 class="cover-title">${esc(title)}</h2>
          <div class="cover-msg" id="cover-msg"></div>
          <div class="cover-actions" id="cover-actions"></div>
        </div>
      </div>
    </div>`;

  const $ = (id) => root.querySelector('#' + id);
  const stage = $('stage'), shield = $('shield'), cover = $('cover'), controls = $('controls'), topbar = $('topbar');
  const toggleBtn = $('toggle'), scrub = $('scrub'), timeEl = $('time');

  let player = null, ready = false, destroyed = false, state = S.UNSTARTED, scrubbing = false;
  let ticker = 0, hideTimer = 0, autoplayTimer = 0, lastProgress = 0;

  // ---- cover screens
  function showCover(mode, msg = '') {
    const actions = {
      loading: '',
      start: `<button class="cbtn primary" data-act="play">▶ Play</button><button class="cbtn" data-act="back">← Back</button>`,
      paused: `<button class="cbtn primary" data-act="play">▶ Keep watching</button><button class="cbtn" data-act="restart">↺ Start over</button><button class="cbtn" data-act="back">← Back</button>`,
      ended: `<button class="cbtn primary" data-act="restart">↺ Watch again</button><button class="cbtn" data-act="back">← Back</button>`,
      error: `<button class="cbtn primary" data-act="back">← Back</button>`,
    }[mode];
    cover.dataset.mode = mode;
    $('cover-msg').innerHTML = mode === 'loading' ? '<div class="spinner"></div>' : esc(msg);
    $('cover-actions').innerHTML = actions;
    cover.classList.remove('hidden');
    setControls(false);
    cover.querySelector('.cbtn')?.focus({ preventScroll: true });
  }
  const hideCover = () => cover.classList.add('hidden');

  cover.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') play();
    else if (act === 'restart') { player?.seekTo(0, true); play(); }
    else if (act === 'back') onBack();
  });

  // ---- controls visibility
  function setControls(show) {
    controls.classList.toggle('hidden', !show);
    topbar.classList.toggle('hidden', !show);
    clearTimeout(hideTimer);
    if (show && state === S.PLAYING) hideTimer = setTimeout(() => setControls(false), 3500);
  }
  const controlsShown = () => !controls.classList.contains('hidden');

  shield.addEventListener('click', () => { if (!controlsShown()) setControls(true); else togglePlay(); });
  stage.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && state === S.PLAYING) setControls(true); });
  stage.addEventListener('focusin', () => { if (state === S.PLAYING) setControls(true); });

  // ---- playback
  function play() {
    if (!ready) return;
    player.playVideo();
    // Some browsers (notably iOS Safari) refuse to start playback from outside
    // the iframe. If nothing happens, let one tap through to YouTube's own play
    // button; the shield comes back the moment playback starts.
    clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => {
      if (state !== S.PLAYING && state !== S.BUFFERING) {
        hideCover();
        shield.classList.add('tap-through');
        $('topbar').classList.remove('hidden');
      }
    }, 2000);
  }
  function togglePlay() {
    if (!ready) return;
    if (state === S.PLAYING || state === S.BUFFERING) player.pauseVideo(); else play();
  }
  function seekBy(d) {
    if (!ready) return;
    const t = Math.max(0, Math.min(player.getDuration() - 1, player.getCurrentTime() + d));
    player.seekTo(t, true);
    tick();
    setControls(true);
  }

  $('back').addEventListener('click', onBack);
  toggleBtn.addEventListener('click', togglePlay);
  $('rew').addEventListener('click', () => seekBy(-10));
  $('fwd').addEventListener('click', () => seekBy(10));
  scrub.addEventListener('input', () => { scrubbing = true; timeEl.textContent = `${fmtDuration(+scrub.value)} / ${fmtDuration(+scrub.max)}`; setControls(true); });
  scrub.addEventListener('change', () => { scrubbing = false; player?.seekTo(+scrub.value, true); });
  $('fs')?.addEventListener('click', toggleFullscreen);

  function toggleFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
  }

  function onKey(e) {
    if (e.key === ' ' || e.key === 'k' || e.key === 'MediaPlayPause') {
      if (document.activeElement?.tagName === 'BUTTON' && e.key === ' ') return; // let the focused button act
      e.preventDefault(); togglePlay();
    } else if (e.key === 'f' && canFullscreen) toggleFullscreen();
    else if (state === S.PLAYING && !controlsShown() && e.key.startsWith('Arrow')) {
      e.preventDefault(); e.stopImmediatePropagation();
      setControls(true); toggleBtn.focus({ preventScroll: true });
    }
  }
  document.addEventListener('keydown', onKey, true);

  function tick() {
    if (!ready || scrubbing) return;
    const t = player.getCurrentTime() || 0, d = player.getDuration() || 0;
    scrub.max = Math.floor(d) || 100;
    scrub.value = Math.floor(t);
    timeEl.textContent = `${fmtDuration(t)} / ${fmtDuration(d)}`;
    if (opts.onProgress && Math.abs(t - lastProgress) >= 5) { lastProgress = t; opts.onProgress(t, d); }
  }

  function onStateChange(e) {
    state = e.data;
    if (state === S.PLAYING) {
      clearTimeout(autoplayTimer);
      shield.classList.remove('tap-through');
      hideCover();
      toggleBtn.textContent = '⏸'; toggleBtn.setAttribute('aria-label', 'Pause');
      setControls(true);
    } else {
      toggleBtn.textContent = '▶'; toggleBtn.setAttribute('aria-label', 'Play');
    }
    if (state === S.PAUSED) { tick(); showCover('paused'); }
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

  showCover('loading');
  loadYouTubeApi().then((YT) => {
    if (destroyed) return;
    player = new YT.Player($('yt'), {
      host: 'https://www.youtube-nocookie.com',
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        controls: 0, rel: 0, fs: 0, disablekb: 1, iv_load_policy: 3, playsinline: 1,
        modestbranding: 1, cc_load_policy: 0, autoplay: 0,
        start: Math.floor(opts.startAt || 0), origin: location.origin,
      },
      events: {
        onReady() {
          if (destroyed) return;
          ready = true;
          ticker = setInterval(tick, 500);
          tick();
          // The tap that opened this video usually lets it start straight away;
          // if the browser blocks that, show a big Play button instead.
          player.playVideo();
          autoplayTimer = setTimeout(() => {
            if (state !== S.PLAYING && state !== S.BUFFERING) showCover('start', opts.startAt ? `Continue from ${fmtDuration(opts.startAt)}` : '');
          }, 1500);
        },
        onStateChange,
        onError,
      },
    });
  }).catch(() => showCover('error', "Couldn't reach YouTube. Check the internet connection."));

  return function destroy() {
    destroyed = true;
    clearInterval(ticker); clearTimeout(hideTimer); clearTimeout(autoplayTimer);
    document.removeEventListener('keydown', onKey, true);
    if (ready) { try { const t = player.getCurrentTime(), d = player.getDuration(); opts.onProgress?.(t, d); } catch {} }
    try { player?.destroy(); } catch {}
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  };
}
