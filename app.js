/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE MANOR — Cinematic Experience Engine  v3
 *
 *  Architecture: 4-state machine
 *    loading   → preintro → trigger → cinematic → website
 *
 *  State responsibilities:
 *    loading   Preload all 163 WebP frames via createImageBitmap().
 *    preintro  Atmospheric entry: grain, motes, sparse logo, CTA.
 *    trigger   CTA click feedback: psychological pause before playback.
 *    cinematic GSAP master timeline plays frames at deterministic pace.
 *    website   Normal scroll-driven GSAP reveals. ScrollTrigger init here.
 *
 *  Why deterministic playback is smoother than scroll-driven:
 *    Scroll events are noisy. deltaY varies wildly per device/trackpad.
 *    Mapping raw scroll to frame index creates jitter, momentum-skip,
 *    and inconsistent pacing. GSAP's internal ticker is vsync-aligned
 *    and purely time-based — exactly like a video player. The result
 *    feels like cinema, not an interactive slideshow.
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
     DEBUG
     Set true to log state transitions, FPS, frame index to console.
     ───────────────────────────────────────────────────────────────── */
  const DEBUG = false;
  function dbg(...args) { if (DEBUG) console.log('[Manor]', ...args); }

  /* ─────────────────────────────────────────────────────────────────
     REDUCED MOTION
     Detected once at load. If true: skip preintro + cinematic entirely
     and enter the website state immediately after preloading.
     ───────────────────────────────────────────────────────────────── */
  const PREFERS_REDUCED_MOTION = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  /* ─────────────────────────────────────────────────────────────────
     CONFIGURATION
     ───────────────────────────────────────────────────────────────── */
  const CONFIG = {
    /* Frame sequence */
    totalFrames: 163,
    framePath: 'framesWebp/frame_',  // maps to framesWebp/frame_0001.webp
    frameExt: '.webp',
    parallelLoads: 8,                    // simultaneous fetch/decode workers

    /* Cinematic timing (seconds) */
    cinematicDuration: 6.0,             // 163 frames / 6s ≈ 27fps — faster, still cinematic
    fadeInDuration: 1.3,             // kept (unused now — no fade-in tween)
    fadeOutStart: 4.8,             // fade-to-black at 80% through the 6s run
    fadeOutDuration: 1.0,             // slightly tighter fade
    blackHold: 0.4,             // brief hold before website

    /* Camera zoom during cinematic — slow push-in for depth */
    zoomStart: 1.0,
    zoomEnd: 1.28,

    /* Grain canvas */
    grainScale: 0.25,    // render at 25% resolution → 16× fewer pixels
    grainFPS: 12,      // renders/sec — grain looks authentic at low fps
    grainOpacity: 0.055,   // very subtle; blend mode adds perceived intensity
    grainMobileFPS: 8,     // drop to 8fps on mobile for battery/perf
  };

  /* ─────────────────────────────────────────────────────────────────
     AUDIO CONFIGURATION
     ───────────────────────────────────────────────────────────────── */
  const AUDIO = {
    bgMusicPath: 'music/backgroud.mp3',
    jumpscarePath: 'music/jumpscare.mp3',
    buttonClickPath: 'music/buttonclick1.mp3',
    bgVolume: 0.35,
    bgFadeMs: 2800,              // slow fade-in for atmospheric buildup
    jumpscareVolume: 0.85,
    jumpscareFrame: 120,               // frame index at which jumpscare fires
    jumpscareTol: 4,                 // ±4-frame window to catch the beat
  };

  /* ─────────────────────────────────────────────────────────────────
     MOBILE DETECTION
     Used to throttle grain, adjust parallel loads, etc.
     ───────────────────────────────────────────────────────────────── */
  const IS_MOBILE = window.innerWidth <= 768
    || /Android|iPhone|iPad|iPod/.test(navigator.userAgent);

  /* ─────────────────────────────────────────────────────────────────
     DOM REFS — cached once; never queried again in hot paths
     ───────────────────────────────────────────────────────────────── */
  const dom = {
    preloader: document.getElementById('preloader'),
    preloaderBar: document.getElementById('preloaderBar'),
    preloaderPercent: document.getElementById('preloaderPercent'),
    preloaderProg: document.getElementById('preloaderProgress'),

    introLayer: document.getElementById('introLayer'),
    introCta: document.getElementById('introCta'),
    introLogo: document.querySelector('.intro-logo'),
    introEyebrow: document.querySelector('.intro-eyebrow'),
    introRule: document.querySelector('.intro-rule'),
    grainCanvas: document.getElementById('grainCanvas'),

    cinematicLayer: document.getElementById('cinematicLayer'),
    frameCanvas: document.getElementById('frameCanvas'),
    cinematicOverlay: document.getElementById('cinematicOverlay'),

    audioToggle: document.getElementById('audioToggle'),
    contentSections: document.getElementById('contentSections'),
  };

  /* ─────────────────────────────────────────────────────────────────
     APPLICATION STATE
     ───────────────────────────────────────────────────────────────── */
  let appState = 'loading'; // loading | preintro | trigger | cinematic | website

  /* ─────────────────────────────────────────────────────────────────
     FRAME CACHE
     Stores pre-decoded ImageBitmap objects for every frame.
     ImageBitmap is GPU-resident: drawImage() costs zero decode time.
     ───────────────────────────────────────────────────────────────── */
  const frames = new Array(CONFIG.totalFrames).fill(null);

  /* ─────────────────────────────────────────────────────────────────
     CANVAS STATE (frame renderer)
     ───────────────────────────────────────────────────────────────── */
  let frameCtx = null;
  let canvasW = 0;
  let canvasH = 0;

  /* ═══════════════════════════════════════════════════════════════════
     UTILITY
     ═══════════════════════════════════════════════════════════════════ */

  function padNum(n) {
    return String(n).padStart(4, '0');
  }

  function frameSrc(i) {
    return `${CONFIG.framePath}${padNum(i + 1)}${CONFIG.frameExt}`;
  }

  /* ═══════════════════════════════════════════════════════════════════
     PRELOADER / FRAME DECODER
     ═══════════════════════════════════════════════════════════════════ */

  /**
   * Loads all 163 frames before the experience begins.
   *
   * Strategy: fetch() → blob → createImageBitmap()
   *   • fetch() downloads the file (cacheable, resumable)
   *   • createImageBitmap() decodes the WebP off the main thread
   *   • The resulting ImageBitmap is GPU-ready; drawImage() is instant
   *
   * N parallel chains (CONFIG.parallelLoads) run concurrently.
   * Each chain self-refills: when one frame finishes, it immediately
   * starts the next queued index. This saturates bandwidth efficiently.
   *
   * Fallback: if createImageBitmap() fails (old Safari), an
   * HTMLImageElement is used instead. drawImage() with HTMLImageElement
   * decodes lazily on first draw, which can cause a one-time stutter —
   * acceptable as a last-resort fallback.
   */
  function preloadAllFrames() {
    return new Promise((resolve) => {
      let decoded = 0;
      let queued = 0;
      const total = CONFIG.totalFrames;
      const par = IS_MOBILE
        ? Math.min(4, CONFIG.parallelLoads)
        : CONFIG.parallelLoads;

      function updateProgress() {
        const pct = Math.round((decoded / total) * 100);
        dom.preloaderBar.style.width = pct + '%';
        dom.preloaderPercent.textContent = pct + '%';
        if (dom.preloaderProg) {
          dom.preloaderProg.setAttribute('aria-valuenow', pct);
        }
        dbg(`Frame ${decoded}/${total} (${pct}%)`);
      }

      function tryNext() {
        if (queued >= total) return;
        const idx = queued++;
        const src = frameSrc(idx);

        fetch(src)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status} for ${src}`);
            return r.blob();
          })
          .then((blob) =>
            createImageBitmap(blob, {
              premultiplyAlpha: 'none', // opaque frames: skip premultiplication
              colorSpaceConversion: 'none', // skip color management = faster
            })
          )
          .then((bmp) => {
            frames[idx] = bmp;
            decoded++;
            updateProgress();
            if (decoded === total) resolve();
            else tryNext(); // slot freed → load next immediately
          })
          .catch(() => {
            // Fallback: HTMLImageElement (lazy decode on first drawImage)
            const img = new Image();
            img.onload = img.onerror = () => {
              frames[idx] = img.complete ? img : null;
              decoded++;
              updateProgress();
              if (decoded === total) resolve();
              else tryNext();
            };
            img.src = src;
          });
      }

      // Kick off N parallel decode chains
      for (let i = 0; i < Math.min(par, total); i++) tryNext();
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     FRAME CANVAS — sizing & rendering
     ═══════════════════════════════════════════════════════════════════ */

  function initFrameCanvas() {
    /*
     * alpha: false — skips per-pixel alpha compositing on every draw.
     *   The canvas is fully opaque; no need to blend with the page behind it.
     *   Saves ~10-15% GPU fill-rate on every drawImage call.
     *
     * desynchronized: true — browser hint to skip vsync alignment on this
     *   canvas, allowing the GPU to present frames independently.
     *   Reduces latency on supported browsers (Chrome/Edge).
     */
    frameCtx = dom.frameCanvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });
    sizeFrameCanvas();
  }

  function sizeFrameCanvas() {
    /*
     * Cap DPR at 2. On 3× screens (iPhone 15 Pro etc.), DPR 3 means
     * the canvas is 9× the pixel area of the visible viewport.
     * DPR 2 is imperceptible at normal viewing distance and saves ~56%
     * GPU fill-rate cost on those devices.
     */
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasW = window.innerWidth;
    canvasH = window.innerHeight;
    dom.frameCanvas.width = Math.round(canvasW * dpr);
    dom.frameCanvas.height = Math.round(canvasH * dpr);
    dom.frameCanvas.style.width = canvasW + 'px';
    dom.frameCanvas.style.height = canvasH + 'px';
    frameCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * drawFrame — renders at a floating-point frame index with optional zoom.
   *
   * Cover-fit: scales the frame to fill the canvas (like CSS object-fit:cover).
   * Cross-dissolve blend: when frac is between 0.02 and 0.98, draws frameA at
   *   full opacity then frameB at (frac) alpha on top — smooth transition.
   *
   * Since alpha:false context, we must clear with fillRect (not clearRect).
   */
  function drawFrame(floatIndex, zoom) {
    if (!frameCtx) return;

    const maxIdx = CONFIG.totalFrames - 1;
    const clamped = Math.max(0, Math.min(maxIdx, floatIndex));
    const frameA = Math.floor(clamped);
    const frameB = Math.min(frameA + 1, maxIdx);
    const frac = clamped - frameA;

    // Black fill (required since alpha:false skips transparent clear)
    frameCtx.fillStyle = '#000';
    frameCtx.fillRect(0, 0, canvasW, canvasH);

    const blend = frac > 0.02 && frac < 0.98 && frameA !== frameB;
    if (blend) {
      drawCover(frames[frameA], zoom, 1);
      drawCover(frames[frameB], zoom, frac);
    } else {
      drawCover(frames[Math.round(clamped)], zoom, 1);
    }
  }

  function drawCover(frame, zoom, alpha) {
    if (!frame) return;
    const w = frame.width || frame.naturalWidth;
    const h = frame.height || frame.naturalHeight;
    if (!w || !h) return;

    frameCtx.save();
    if (alpha < 1) frameCtx.globalAlpha = alpha;

    const cx = canvasW / 2;
    const cy = canvasH / 2;
    frameCtx.translate(cx, cy);
    frameCtx.scale(zoom, zoom);
    frameCtx.translate(-cx, -cy);

    const imgR = w / h;
    const canvasR = canvasW / canvasH;
    let dW, dH;
    if (canvasR > imgR) { dW = canvasW; dH = canvasW / imgR; }
    else { dH = canvasH; dW = canvasH * imgR; }

    const dx = (canvasW - dW) / 2;
    const dy = (canvasH - dH) / 2;
    frameCtx.drawImage(frame, dx, dy, dW, dH);
    frameCtx.restore();
  }

  /* ═══════════════════════════════════════════════════════════════════
     GRAIN ENGINE
     ═══════════════════════════════════════════════════════════════════ */

  /**
   * Renders animated film grain on a small canvas (25% of window size),
   * then CSS stretches it to full viewport via width/height:100%.
   *
   * Why downscale?
   *   At 1920×1080, putImageData touches 2,073,600 pixels per frame.
   *   At 480×270 (25% scale), it's 129,600 pixels — 16× less work.
   *   The pixelated upscaling looks EXACTLY like film grain because
   *   grain is inherently a low-frequency texture when viewed at distance.
   *
   * mix-blend-mode: overlay (set in CSS) makes the grain interact with
   * the dark background to produce subtle luminance variation rather
   * than a flat white-noise pattern.
   */
  const GrainEngine = (function () {
    let rafId = null;
    let lastTime = 0;
    let grainCtx = null;
    const targetFPS = IS_MOBILE ? CONFIG.grainMobileFPS : CONFIG.grainFPS;
    const interval = 1000 / targetFPS;

    function resize() {
      const c = dom.grainCanvas;
      c.width = Math.ceil(window.innerWidth * CONFIG.grainScale);
      c.height = Math.ceil(window.innerHeight * CONFIG.grainScale);
    }

    function render(timestamp) {
      if (!rafId) return;
      rafId = requestAnimationFrame(render);

      // Throttle to targetFPS — skip frames in between
      if (timestamp - lastTime < interval) return;
      lastTime = timestamp;

      const c = dom.grainCanvas;
      const w = c.width;
      const h = c.height;
      const id = grainCtx.createImageData(w, h);
      const d = id.data;

      /*
       * Each pixel: random luminance in range [0, 55].
       * Alpha at ~28 (~11%) — combined with CSS opacity: 0.055
       * and mix-blend-mode: overlay the grain is extremely subtle.
       * Intensity can be tuned via the alpha value here.
       */
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() * 55) | 0;
        d[i] = n;     // R
        d[i + 1] = n;     // G
        d[i + 2] = n;     // B
        d[i + 3] = 28;    // A
      }

      grainCtx.putImageData(id, 0, 0);
    }

    return {
      init() {
        grainCtx = dom.grainCanvas.getContext('2d');
        dom.grainCanvas.style.opacity = CONFIG.grainOpacity;
        resize();
      },
      start() {
        if (rafId) return;
        lastTime = 0;
        rafId = requestAnimationFrame(render);
      },
      stop() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
      },
      resize,
    };
  }());

  /* ═══════════════════════════════════════════════════════════════════
     AUDIO ENGINE
     ═══════════════════════════════════════════════════════════════════ */

  const AudioEngine = (function () {
    let bgMusic = null;
    let jumpscareAudio = null;
    let clickAudio = null;
    let isMuted = false;
    let bgStarted = false;
    let userInteracted = false;

    // Zone-based jumpscare state — prevents re-firing on the same crossing
    let jsArmed = true;
    let jsInZone = false;

    /**
     * RAF-based volume fade — aligned to display refresh rate.
     * Smoother than setInterval (which fires at imprecise intervals)
     * and avoids audible stepping.
     */
    function fadeVolume(audio, target, durationMs) {
      const start = audio.volume;
      const t0 = performance.now();
      function tick(now) {
        const p = Math.min(1, (now - t0) / durationMs);
        audio.volume = Math.max(0, Math.min(1, start + (target - start) * p));
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    return {
      init() {
        bgMusic = new Audio(AUDIO.bgMusicPath);
        bgMusic.loop = true;
        bgMusic.volume = 0;
        bgMusic.preload = 'auto';

        jumpscareAudio = new Audio(AUDIO.jumpscarePath);
        jumpscareAudio.loop = false;
        jumpscareAudio.volume = AUDIO.jumpscareVolume;
        jumpscareAudio.preload = 'auto';

        clickAudio = new Audio(AUDIO.buttonClickPath);
        clickAudio.loop = false;
        clickAudio.volume = 1.0;
        clickAudio.preload = 'auto';

        // Bind interaction listeners for browsers that block autoplay
        const onInteract = () => {
          if (userInteracted) return;
          userInteracted = true;
          this.startBgMusic();
          document.removeEventListener('click', onInteract);
          document.removeEventListener('touchstart', onInteract);
          document.removeEventListener('keydown', onInteract);
        };
        document.addEventListener('click', onInteract, { passive: true });
        document.addEventListener('touchstart', onInteract, { passive: true });
        document.addEventListener('keydown', onInteract, { passive: true });
      },

      startBgMusic() {
        if (bgStarted || isMuted || !bgMusic) return;
        bgMusic.play()
          .then(() => {
            bgStarted = true;
            fadeVolume(bgMusic, AUDIO.bgVolume, AUDIO.bgFadeMs);
          })
          .catch(() => { /* Autoplay blocked — will retry on next interaction */ });
      },

      /**
       * Fires the jumpscare sound when playhead enters the trigger zone.
       * Zone-based: fires once on zone entry, re-arms on zone exit.
       * This handles forward/reverse/fast-scroll correctly.
       */
      checkJumpscareTrigger(currentFrame) {
        const lo = AUDIO.jumpscareFrame - AUDIO.jumpscareTol;
        const hi = AUDIO.jumpscareFrame + AUDIO.jumpscareTol;
        const inZone = currentFrame >= lo && currentFrame <= hi;

        if (inZone && !jsInZone) {
          jsInZone = true;
          if (jsArmed) {
            jsArmed = false;
            // Hard stop before play — prevents stacking if seeking back
            jumpscareAudio.pause();
            jumpscareAudio.currentTime = 0;
            jumpscareAudio.play().catch(() => { });
          }
        } else if (!inZone && jsInZone) {
          jsInZone = false;
          jsArmed = true; // re-arm for next zone entry
        }
      },

      playClick() {
        if (clickAudio && !isMuted) {
          clickAudio.currentTime = 0;
          clickAudio.play().catch(() => { });
        }
      },

      toggleMute() {
        isMuted = !isMuted;
        if (isMuted) {
          if (bgMusic) fadeVolume(bgMusic, 0, 400);
          setTimeout(() => { if (bgMusic) bgMusic.pause(); }, 450);
          if (jumpscareAudio) { jumpscareAudio.pause(); jumpscareAudio.currentTime = 0; }
          bgStarted = false;
        } else if (bgMusic) {
          bgMusic.volume = 0;
          bgMusic.play()
            .then(() => { bgStarted = true; fadeVolume(bgMusic, AUDIO.bgVolume, AUDIO.bgFadeMs); })
            .catch(() => { });
        }
        return isMuted;
      },

      get isMuted() { return isMuted; },
    };
  }());

  /* ═══════════════════════════════════════════════════════════════════
     STATE: PREINTRO
     Atmospheric entry. Grain runs. Motes drift (CSS). Identity
     elements fade in sequentially via a GSAP timeline.
     ═══════════════════════════════════════════════════════════════════ */

  function enterPreintro() {
    appState = 'preintro';
    dbg('→ preintro');

    dom.introLayer.removeAttribute('aria-hidden');
    dom.cinematicLayer.setAttribute('aria-hidden', 'true');
    dom.contentSections.setAttribute('aria-hidden', 'true');

    GrainEngine.start();

    /*
     * Staggered reveal of intro elements. Each element is at opacity:0
     * (set by GSAP in init()). The sequence is deliberately slow to
     * build atmosphere rather than instant gratification.
     */
    const tl = gsap.timeline();
    tl
      .to(dom.introEyebrow, { opacity: 0.35, duration: 1.8, ease: 'power2.out' }, 0.4)
      .to(dom.introLogo, { opacity: 0.88, duration: 2.2, ease: 'power2.out' }, 0.8)
      .to(dom.introRule, { opacity: 1, scaleX: 1, duration: 1.4, ease: 'power2.out' }, 1.5)
      .to(dom.introCta, { opacity: 1, duration: 1.8, ease: 'power2.out' }, 2.2);

    // Bind CTA interactions
    bindCtaEvents();
  }

  function bindCtaEvents() {
    function handleActivation(e) {
      if (appState !== 'preintro') return;
      // Prevent double-fire from touchstart + click sequence
      if (e.type === 'touchstart') e.preventDefault();
      onCtaActivated();
    }

    dom.introCta.addEventListener('click', handleActivation);
    dom.introCta.addEventListener('touchstart', handleActivation, { passive: false });
    dom.introCta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (appState === 'preintro') onCtaActivated();
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     STATE: TRIGGER
     The click feedback. Deliberately minimal — the restraint creates
     psychological tension. No glitch spam. One subtle pulse, then silence.
     ═══════════════════════════════════════════════════════════════════ */

  function onCtaActivated() {
    if (appState !== 'preintro') return;
    appState = 'trigger';
    dbg('→ trigger');

    // Play click sound
    AudioEngine.playClick();

    // Start background music early, right after button click
    AudioEngine.startBgMusic();

    // Lock scroll immediately
    document.body.style.overflow = 'hidden';

    /*
     * Trigger feedback timeline.
     *
     * Design intent: the interaction should feel like a decision was made,
     * not like the UI is being controlled. Very subtle pulse → elements
     * dissolve → hold on darkness → cinematic begins.
     *
     * No glitch. No flash. No spin. The absence of excess IS the effect.
     */
    const tl = gsap.timeline({ onComplete: enterCinematic });
    tl
      // Faint screen pulse — one brief brightness drop signals "something happened"
      .to(dom.introLayer, { opacity: 0.88, duration: 0.06, ease: 'none' })
      .to(dom.introLayer, { opacity: 1, duration: 0.10, ease: 'none' })

      // CTA text dissolves first — the invitation is gone
      .to(dom.introCta, { opacity: 0, y: -10, duration: 0.5, ease: 'power2.in' }, 0.08)

      // Rule collapses inward
      .to(dom.introRule, { opacity: 0, scaleX: 0, duration: 0.4, ease: 'power2.in' }, 0.15)

      // Logo fades slowly — manor name lingers before darkness
      .to(dom.introLogo, { opacity: 0, duration: 0.9, ease: 'power2.in' }, 0.25)
      .to(dom.introEyebrow, { opacity: 0, duration: 0.7, ease: 'power2.in' }, 0.30)

      // Hold on pure black — anticipation beat
      .to({}, { duration: 0.5 })

      // introLayer fades to transparent — cinematic layer below is revealed
      .to(dom.introLayer, { opacity: 0, duration: 0.7, ease: 'power2.inOut' })

      // Brief gap
      .to({}, { duration: 0.18 });
  }

  /* ═══════════════════════════════════════════════════════════════════
     STATE: CINEMATIC
     GSAP master timeline drives 163 WebP frames at a fixed pace.
     Audio engine fires jumpscare at the correct frame.
     ═══════════════════════════════════════════════════════════════════ */

  function enterCinematic() {
    appState = 'cinematic';
    dbg('→ cinematic');

    // Disable intro layer interactions and hide it cleanly
    dom.introLayer.style.pointerEvents = 'none';
    dom.introLayer.style.display = 'none';

    // Stop grain (intro state over; save CPU for frame rendering)
    GrainEngine.stop();

    /*
     * No gsap.set needed here — cinematicLayer is already opacity:1
     * and frame 0 is already drawn. The cinematic picks up seamlessly
     * from exactly where the intro background left off.
     * No fade-in tween needed — the frame is already visible.
     */

    // Show audio toggle
    setTimeout(() => {
      dom.audioToggle.classList.remove('hidden');
      dom.audioToggle.classList.add('playing');
    }, 400);

    /*
     * Cinematic GSAP timeline.
     *
     * playhead object is simultaneously animated by two tweens:
     *   • frame: linear 0→162 over cinematicDuration seconds
     *   • zoom:  eased 1.0→1.28 for slow cinematic push-in
     *
     * No fade-in at the start: frame 0 is already showing behind the
     * intro layer. The timeline begins playing immediately from frame 0.
     * Only the fade-out at the end is needed (to transition to website).
     */
    const playhead = {
      frame: 0,
      zoom: CONFIG.zoomStart,
    };

    const dur = CONFIG.cinematicDuration;

    const masterTl = gsap.timeline({
      onUpdate: function () {
        drawFrame(playhead.frame, playhead.zoom);
        AudioEngine.checkJumpscareTrigger(Math.round(playhead.frame));
        dbg(`frame ${playhead.frame.toFixed(1)} zoom ${playhead.zoom.toFixed(3)}`);
      },
      onComplete: enterWebsite,
    });

    masterTl

      // ── Frame playback: linear, 0 → 162 ──
      // ease:'none' = constant rate = 19fps = cinematic film feel
      .to(playhead, {
        frame: CONFIG.totalFrames - 1,
        ease: 'none',
        duration: dur,
      }, 0)

      // ── Zoom: slow push-in, eased for depth ──
      .to(playhead, {
        zoom: CONFIG.zoomEnd,
        ease: 'power1.inOut',
        duration: dur,
      }, 0)

      // ── Fade OUT: black returns to set up website transition ──
      .to(dom.cinematicOverlay, {
        opacity: 1,
        duration: CONFIG.fadeOutDuration,
        ease: 'power2.inOut',
      }, CONFIG.fadeOutStart)

      // ── Hold on black before transition ──
      .to({}, { duration: CONFIG.blackHold });
  }

  /* ═══════════════════════════════════════════════════════════════════
     STATE: WEBSITE
     Cinematic is done. Restore scroll, reveal content, init ScrollTrigger.
     ScrollTrigger is deliberately NOT initialised until this point —
     it has zero cost during the preintro and cinematic phases.
     ═══════════════════════════════════════════════════════════════════ */

  function enterWebsite() {
    appState = 'website';
    dbg('→ website');

    // Hide cinematic layer cleanly
    gsap.to(dom.cinematicLayer, {
      opacity: 0,
      duration: 1.0,
      ease: 'power2.out',
      onComplete: () => { dom.cinematicLayer.style.display = 'none'; }
    });

    // Ensure intro layer is fully disabled
    dom.introLayer.style.pointerEvents = 'none';
    dom.introLayer.style.display = 'none';

    // Reveal the content container immediately — no slide
    dom.contentSections.removeAttribute('aria-hidden');
    gsap.set(dom.contentSections, { opacity: 1 });

    /* ═══════════════════════════════════════════════════════════
       SMOKE REVEAL ENGINE
       Replaces the slide-up entirely. Hero content materialises
       from darkness and smoke with paranormal displacement warp.
       No positional movement — everything emerges in place.
       ═══════════════════════════════════════════════════════════ */

    const smokeLayer = document.getElementById('heroSmokeLayer');
    const smokeCanvas = document.getElementById('heroSmokeCanvas');
    const darknessVeil = document.getElementById('heroDarknessVeil');
    const turbEl = document.getElementById('heroTurbulence');
    const dispEl = document.getElementById('heroDisplace');
    const heroSection = document.getElementById('heroSection');

    // Individual hero elements for staggered materialisation
    const portrait = document.querySelector('.portrait-placeholder');
    const eyebrow = document.querySelector('.hero-text-col .section-eyebrow');
    const heroTitle = document.querySelector('.hero-title');
    const tagline = document.querySelector('.hero-tagline');
    const desc = document.querySelector('.hero-desc');

    // All hero elements start invisible, no Y offset — no slide
    gsap.set([portrait, eyebrow, heroTitle, tagline, desc], {
      opacity: 0,
      scale: 0.992,       // imperceptible scale — creates a subtle "materialise" not a zoom
      transformOrigin: 'center center',
    });

    /* ── SVG displacement warp tracker ────────────────────────
       warp.d is the feDisplacementMap scale (0 = no warp, 28 = peak).
       warp.fx/fy are the feTurbulence baseFrequency channels.
       GSAP animates these values; applyWarp() writes to SVG attrs.
       Direct attribute mutation is cheap — no layout recalc.
       ─────────────────────────────────────────────────────── */
    const warp = { d: 0, fx: 0.016, fy: 0.020 };

    function applyWarp() {
      if (!turbEl || !dispEl) return;
      turbEl.setAttribute('baseFrequency', `${warp.fx.toFixed(4)} ${warp.fy.toFixed(4)}`);
      dispEl.setAttribute('scale', warp.d.toFixed(2));
    }

    // Apply the SVG displacement filter to the hero section
    if (heroSection) heroSection.style.filter = 'url(#smokeDisplace)';

    /* ── Procedural smoke canvas ───────────────────────────────
       Emits soft wisp particles that drift upward and fade.
       Intentionally low FPS (≈10) — organic, not digital.
       ─────────────────────────────────────────────────────── */
    let sCtx = null;
    let sRaf = null;
    let sLast = 0;
    let sActive = true;
    let sParticles = [];
    const S_FPS = IS_MOBILE ? 8 : 11;
    const S_INT = 1000 / S_FPS;

    function sParticle(seed) {
      const cw = smokeCanvas.width, ch = smokeCanvas.height;
      return {
        x: seed ? Math.random() * cw : cw * 0.1 + Math.random() * cw * 0.8,
        y: seed ? Math.random() * ch : ch + 30,
        r: 55 + Math.random() * 130,
        a: 0.04 + Math.random() * 0.18,
        vx: (Math.random() - 0.5) * 0.30,
        vy: -(0.14 + Math.random() * 0.26),
        life: 0,
        max: 160 + Math.random() * 240,
        grow: 0.10 + Math.random() * 0.16,
      };
    }

    function sInit() {
      smokeCanvas.width = window.innerWidth;
      smokeCanvas.height = window.innerHeight;
      sCtx = smokeCanvas.getContext('2d');
      for (let i = 0; i < 26; i++) sParticles.push(sParticle(true));
    }

    function sTick(ts) {
      sRaf = requestAnimationFrame(sTick);
      if (ts - sLast < S_INT) return;
      sLast = ts;

      const cw = smokeCanvas.width, ch = smokeCanvas.height;
      sCtx.clearRect(0, 0, cw, ch);

      if (sActive && sParticles.length < 38)
        sParticles.push(sParticle(false));

      for (let i = sParticles.length - 1; i >= 0; i--) {
        const p = sParticles[i];
        p.life++; p.x += p.vx; p.y += p.vy; p.r += p.grow;

        const t = p.life / p.max;
        let alpha = p.a;
        if (t < 0.18) alpha *= t / 0.18;
        else if (t > 0.68) alpha *= (1 - t) / 0.32;

        const g = sCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, `rgba(5,3,2,${alpha})`);
        g.addColorStop(0.5, `rgba(3,2,1,${(alpha * 0.55).toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        sCtx.fillStyle = g;
        sCtx.beginPath();
        sCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        sCtx.fill();

        if (p.life >= p.max || p.y < -p.r * 2) sParticles.splice(i, 1);
      }
    }

    /* ── GSAP reveal timeline ──────────────────────────────────
     *
     *  SEQUENCE — entire reveal completes within 3 seconds
     *
     *   0.0   Darkness veil lifts. Warp distortion ramps up.
     *   0.2   Portrait materialises through the distortion.
     *   0.6   Warp peaks, begins resolving.
     *   0.8   Title emerges. Fog panels start thinning.
     *   1.1   Eyebrow → tagline → description appear.
     *   1.5   Smoke canvas fades. Warp fully resolved.
     *   2.2   Timeline complete → overlay fades out (0.8s).
     *   3.0   Full overlay removed. Scroll restored.
     *
     * ─────────────────────────────────────────────────────── */

    sInit();
    sRaf = requestAnimationFrame(sTick);

    const revTl = gsap.timeline({
      onComplete() {
        sActive = false;
        cancelAnimationFrame(sRaf);
        if (heroSection) heroSection.style.filter = '';
        gsap.to(smokeLayer, {
          opacity: 0, duration: 0.8, ease: 'power2.out',
          onComplete() {
            smokeLayer.style.display = 'none';
          }
        });
        document.body.style.overflow = '';
      }
    });

    revTl

      // 1. Darkness veil lifts — scene emerges from near-void
      .to(darknessVeil, {
        opacity: 0,
        duration: 1.6,
        ease: 'power1.inOut',
      }, 0)

      // 2. Displacement warp ramps up — paranormal distortion peaks fast
      .to(warp, {
        d: 26, fx: 0.020, fy: 0.026,
        duration: 0.6,
        ease: 'power2.inOut',
        onUpdate: applyWarp,
      }, 0)

      // 3. Portrait materialises first — face through the smoke
      .to(portrait, {
        opacity: 1, scale: 1,
        duration: 1.2,
        ease: 'power2.out',
      }, 0.2)

      // 4. Warp resolves — reality solidifies back into clarity
      .to(warp, {
        d: 0, fx: 0.016, fy: 0.020,
        duration: 1.4,
        ease: 'power3.inOut',
        onUpdate: applyWarp,
      }, 0.6)

      // 5. Fog panels thin independently — uneven, natural dissipation
      .to('.hero-fog-4', { opacity: 0, duration: 1.0, ease: 'power2.inOut' }, 0.8)
      .to('.hero-fog-1', { opacity: 0, duration: 1.3, ease: 'power1.inOut' }, 0.9)
      .to('.hero-fog-2', { opacity: 0, duration: 1.1, ease: 'power2.inOut' }, 1.0)
      .to('.hero-fog-3', { opacity: 0, duration: 0.9, ease: 'power2.inOut' }, 1.1)

      // 6. Title emerges — slightly warped still, feels intentional
      .to(heroTitle, {
        opacity: 1, scale: 1,
        duration: 1.0,
        ease: 'power2.out',
      }, 0.8)

      // 7. Eyebrow — first supporting text element
      .to(eyebrow, {
        opacity: 1, scale: 1,
        duration: 0.8,
        ease: 'power2.out',
      }, 1.1)

      // 8. Tagline — manuscript inscription solidifies
      .to(tagline, {
        opacity: 1, scale: 1,
        duration: 0.8,
        ease: 'power2.out',
      }, 1.3)

      // 9. Description — final clarity, all warp gone
      .to(desc, {
        opacity: 1, scale: 1,
        duration: 0.7,
        ease: 'power2.out',
      }, 1.5)

      // 10. Smoke canvas fades — wisps disperse as scene clarifies
      .to(smokeCanvas, {
        opacity: 0,
        duration: 1.0,
        ease: 'power1.inOut',
      }, 1.2);

    // Init GSAP scroll ecosystem
    gsap.registerPlugin(ScrollTrigger);

    /*
     * normalizeScroll: equalizes scroll delta across devices.
     * Without it, trackpad momentum sends huge deltaY spikes that
     * snap content jarringly. Disabled on iOS where native scroll
     * physics are the correct UX.
     */
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (!isIOS) {
      ScrollTrigger.normalizeScroll(true);
    }

    initContentAnimations();

    // Portrait eye-tracking delayed past the full reveal duration
    setTimeout(() => PortraitEyes.init(), 3000);
  }

  /* ═══════════════════════════════════════════════════════════════════
     CONTENT REVEAL ANIMATIONS (website state only)
     Standard scroll-driven GSAP reveals. These run AFTER the cinematic,
     so they never compete with frame rendering for CPU/GPU budget.
     ═══════════════════════════════════════════════════════════════════ */

  function initContentAnimations() {
    function reveal(selector, opts = {}) {
      document.querySelectorAll(selector).forEach((el, i) => {
        gsap.to(el, {
          opacity: 1,
          y: 0,
          duration: opts.duration || 0.95,
          delay: opts.stagger ? i * opts.stagger : 0,
          ease: 'power3.out',
          clearProps: 'transform',
          scrollTrigger: {
            trigger: el,
            start: opts.start || 'top 88%',
            toggleActions: 'play none none none',
          },
        });
      });
    }

    // About section
    reveal('#aboutSection .section-header');
    reveal('.about-card', { stagger: 0.13, start: 'top 92%', duration: 1.1 });

    // Screenshots section
    reveal('#screenshotsSection .section-header');
    reveal('.screenshot-card', { stagger: 0.1, start: 'top 90%', duration: 1.0 });

    // Atmosphere section
    reveal('#atmosphereSection .section-header');
    reveal('.atmosphere-card', { stagger: 0.14, start: 'top 90%', duration: 1.15 });

    // Developer section
    reveal('.developer-text', { duration: 1.0 });
    reveal('.developer-links', { duration: 1.0 });

    // Download section — vertical line first, then content cascades
    gsap.to('.download-eyebrow-line', {
      opacity: 0.4,
      scaleY: 1,
      duration: 1.2,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: '.download-section',
        start: 'top 85%',
        toggleActions: 'play none none none',
      },
    });
    reveal('.download-eyebrow', { duration: 0.9 });
    reveal('.download-title', { duration: 1.2 });
    reveal('.download-tagline', { duration: 1.0 });
    reveal('.download-meta', { duration: 1.0 });
    reveal('.copyright', { duration: 0.8 });
  }

  /* ═══════════════════════════════════════════════════════════════════
     PORTRAIT EYE TRACKING

     Architecture:
       • Both eyes move as a SINGLE RIGID PAIR — same delta, same direction.
       • A shared (dx, dy) offset is computed once from the cursor to the
         midpoint between both eyes, then applied identically to each pupil.
       • Eyes never cross inward; the natural inter-eye spacing is preserved.
       • Cursor position is smoothed with a slow lag lerp (CURSOR_LAG).
       • The computed pair offset is additionally smoothed with an even
         slower settling lerp (EYE_LAG) for a second "glide" stage.
       • Proximity gates opacity (shadows / vignette / pupils) — lerped
         independently so effects fade out slowly when the cursor leaves.
       • No GSAP: pure RAF for minimal overhead and full control.

     POSITIONING GUIDE — edit values below freely:
       Increase LEFT_EYE_X  → left pupil moves right  (Increase X to move right)
       Decrease LEFT_EYE_X  → left pupil moves left   (Decrease X to move left)
       Increase LEFT_EYE_Y  → left pupil moves down   (Increase Y to move down)
       Decrease LEFT_EYE_Y  → left pupil moves up     (Decrease Y to move up)
       (Same rules apply to RIGHT_EYE_X / RIGHT_EYE_Y)

     DEBUG MODE:
       Set DEBUG_EYES = true to render visible crosshair markers on each
       eye anchor position. Disable (false) for production.
     ═══════════════════════════════════════════════════════════════════ */

  const PortraitEyes = (function () {

    /* ── DEBUG ──────────────────────────────────────────────────────────
       Set true during development to see eye anchor markers.
       Set false for production — no markers, no console noise.
       ──────────────────────────────────────────────────────────────── */
    const DEBUG_EYES = false;

    /* ── EYE ANCHOR CONFIGURATION ───────────────────────────────────────
       Positions are expressed as a percentage (0–100) of the portrait's
       rendered width (X) and height (Y), matching the SVG viewBox scale.

       LEFT_EYE_X  — horizontal centre of the left pupil anchor
                     Increase X to move right | Decrease X to move left
       LEFT_EYE_Y  — vertical centre of the left pupil anchor
                     Increase Y to move down  | Decrease Y to move up

       RIGHT_EYE_X — horizontal centre of the right pupil anchor
                     Increase X to move right | Decrease X to move left
       RIGHT_EYE_Y — vertical centre of the right pupil anchor
                     Increase Y to move down  | Decrease Y to move up
       ──────────────────────────────────────────────────────────────── */
    const LEFT_EYE_X = 50.0;   // % of portrait width  (Increase → right, Decrease → left)
    const LEFT_EYE_Y = 25;   // % of portrait height (Increase → down,  Decrease → up)
    const RIGHT_EYE_X = 61.5;   // % of portrait width  (Increase → right, Decrease → left)
    const RIGHT_EYE_Y = 25;   // % of portrait height (Increase → down,  Decrease → up)

    /* ── MOVEMENT RANGE ────────────────────────────────────────────────
       Pixel limits for the shared eye-pair shift.
       These are converted to SVG units at runtime using the portrait's
       rendered pixel width, so they are resolution-independent.

       H_MAX_PX — maximum horizontal shift in px (both eyes together)
       V_MAX_PX — maximum vertical shift in px   (both eyes together)
       ──────────────────────────────────────────────────────────────── */
    const H_MAX_PX = 4;   // horizontal max: 4–8 px recommended
    const V_MAX_PX = 3;   // vertical max: smaller than horizontal

    /* ── SMOOTHING ──────────────────────────────────────────────────────
       CURSOR_LAG — lerp factor for raw → smooth cursor position.
                    Lower = more lag, more organic. Range: 0.04–0.12.
       EYE_LAG    — secondary lerp on the computed pair offset.
                    Adds a second "settling glide" after the cursor moves.
                    Lower = more glide. Range: 0.03–0.08.
       OPACITY_LAG— lerp factor for proximity-driven opacity effects.
       ──────────────────────────────────────────────────────────────── */
    const CURSOR_LAG = 0.055;  // cursor smooth-follow (lower = more lag)
    const EYE_LAG = 0.040;  // pair-offset settling glide
    const OPACITY_LAG = 0.038;  // opacity fade speed

    /* ── PROXIMITY THRESHOLDS ───────────────────────────────────────────
       PROX_FAR  — px from eye midpoint beyond which no effect occurs.
       PROX_NEAR — px from eye midpoint at which effect is at full strength.
       ──────────────────────────────────────────────────────────────── */
    const PROX_FAR = 520;
    const PROX_NEAR = 60;

    /* ── PEAK OPACITY INTENSITIES ───────────────────────────────────── */
    const SHADOW_MAX_OPACITY = 0.50;
    const VIGNETTE_MAX_OPACITY = 0.38;
    const PUPIL_MAX_OPACITY = 0.78;

    /* ── Internal eye descriptors (populated in init) ─────────────────
       Each entry holds references to the SVG pupil group and shadow
       element, plus the anchor coords (from the config above).
       ──────────────────────────────────────────────────────────────── */
    const EYES = [
      { el: null, shadowEl: null, cx: LEFT_EYE_X, cy: LEFT_EYE_Y },
      { el: null, shadowEl: null, cx: RIGHT_EYE_X, cy: RIGHT_EYE_Y },
    ];

    let vignetteEl = null;
    let rafId = null;
    let initialized = false;

    /* Raw cursor position */
    let cursorX = window.innerWidth / 2;
    let cursorY = window.innerHeight / 2;

    /* Smoothed cursor position (stage 1 lerp) */
    let smoothX = cursorX;
    let smoothY = cursorY;

    /* Shared pair offset — settled via a second lerp (stage 2) */
    const pairOffset = { x: 0, y: 0 };  // in SVG viewBox units
    let targetPairX = 0;
    let targetPairY = 0;

    /* Lerped opacity states */
    let shadowOpacity = 0;
    let vignetteOpacity = 0;
    let pupilOpacity = 0;

    /* Debug marker DOM nodes (created only when DEBUG_EYES = true) */
    const debugMarkers = [];

    function onMouseMove(e) {
      cursorX = e.clientX;
      cursorY = e.clientY;
    }

    /* ── Debug helpers ────────────────────────────────────────────── */
    function createDebugMarkers(portrait) {
      if (!DEBUG_EYES || debugMarkers.length) return;
      EYES.forEach((eye, i) => {
        const marker = document.createElement('div');
        marker.id = `eyeDebugMarker${i === 0 ? 'Left' : 'Right'}`;
        marker.style.cssText = [
          'position:fixed',
          'width:10px',
          'height:10px',
          'border:2px solid rgba(255,80,80,0.9)',
          'border-radius:50%',
          'pointer-events:none',
          'z-index:99999',
          'transform:translate(-50%,-50%)',
          'box-shadow:0 0 0 1px rgba(0,0,0,0.6)',
          'transition:none',
        ].join(';');
        document.body.appendChild(marker);
        debugMarkers.push({ marker, eye });
      });
    }

    function updateDebugMarkers(rect) {
      if (!DEBUG_EYES) return;
      debugMarkers.forEach(({ marker, eye }) => {
        const sx = rect.left + rect.width * (eye.cx / 100);
        const sy = rect.top + rect.height * (eye.cy / 100);
        marker.style.left = `${sx}px`;
        marker.style.top = `${sy}px`;
      });
    }

    /* ── Main RAF loop ────────────────────────────────────────────── */
    function loop() {
      rafId = requestAnimationFrame(loop);

      /* Stage 1: smooth raw cursor toward smoothed position */
      smoothX += (cursorX - smoothX) * CURSOR_LAG;
      smoothY += (cursorY - smoothY) * CURSOR_LAG;

      const portrait = document.getElementById('portraitPlaceholder');
      if (!portrait) return;

      const rect = portrait.getBoundingClientRect();

      /* Pixel width of the portrait — used to convert px limits → SVG units */
      const portraitPxW = rect.width;
      const svgUnitsPerPx = 100 / (portraitPxW || 1);

      /* Midpoint between both eye anchors in screen space */
      const midX = rect.left + rect.width * ((LEFT_EYE_X + RIGHT_EYE_X) / 200);
      const midY = rect.top + rect.height * ((LEFT_EYE_Y + RIGHT_EYE_Y) / 200);

      /* Vector from eye midpoint to smoothed cursor */
      const cdx = smoothX - midX;
      const cdy = smoothY - midY;

      /* Distance for proximity gating */
      const dist = Math.sqrt(cdx * cdx + cdy * cdy);

      /* Proximity factor: 0 (far/absent) → 1 (very close) */
      const prox = 1 - Math.min(1, Math.max(0,
        (dist - PROX_NEAR) / (PROX_FAR - PROX_NEAR)
      ));

      /* ── Shared pair offset (pixels → SVG units, clamped) ─────────
         Both eyes receive the EXACT SAME offset — they move together
         as a rigid pair. The natural inter-eye distance is preserved.
         ──────────────────────────────────────────────────────────── */
      const rawPxX = cdx * prox * prox;  // prox² → movement only when close
      const rawPxY = cdy * prox * prox;

      /* Clamp to H_MAX_PX / V_MAX_PX */
      const clampedPxX = Math.max(-H_MAX_PX, Math.min(H_MAX_PX, rawPxX));
      const clampedPxY = Math.max(-V_MAX_PX, Math.min(V_MAX_PX, rawPxY));

      /* Convert to SVG viewBox units */
      targetPairX = clampedPxX * svgUnitsPerPx;
      targetPairY = clampedPxY * svgUnitsPerPx;

      /* Stage 2: settling glide — pair offset follows its target slowly */
      pairOffset.x += (targetPairX - pairOffset.x) * EYE_LAG;
      pairOffset.y += (targetPairY - pairOffset.y) * EYE_LAG;

      /* ── Opacity lerps ─────────────────────────────────────────── */
      shadowOpacity += (prox * SHADOW_MAX_OPACITY - shadowOpacity) * OPACITY_LAG;
      vignetteOpacity += (prox * VIGNETTE_MAX_OPACITY - vignetteOpacity) * OPACITY_LAG;
      pupilOpacity += (prox * PUPIL_MAX_OPACITY - pupilOpacity) * OPACITY_LAG;

      if (vignetteEl) vignetteEl.style.opacity = vignetteOpacity.toFixed(4);

      /* ── Apply identical offset to both pupils ─────────────────── */
      EYES.forEach((eye) => {
        if (!eye.el) return;

        /* Both eyes share the exact same transform — rigid pair */
        eye.el.setAttribute('transform',
          `translate(${pairOffset.x.toFixed(3)}, ${pairOffset.y.toFixed(3)})`
        );

        eye.el.style.opacity = pupilOpacity.toFixed(4);

        if (eye.shadowEl) {
          eye.shadowEl.style.opacity = shadowOpacity.toFixed(4);
        }
      });

      /* ── Debug markers ─────────────────────────────────────────── */
      if (DEBUG_EYES) {
        createDebugMarkers(portrait);
        updateDebugMarkers(rect);
      }
    }

    return {
      init() {
        if (initialized) return;
        initialized = true;

        EYES[0].el = document.getElementById('eyePupilLeft');
        EYES[0].shadowEl = document.getElementById('eyeSocketShadowLeft');
        EYES[1].el = document.getElementById('eyePupilRight');
        EYES[1].shadowEl = document.getElementById('eyeSocketShadowRight');
        vignetteEl = document.getElementById('portraitVignette');

        if (!EYES[0].el || !EYES[1].el) return;

        window.addEventListener('mousemove', onMouseMove, { passive: true });
        loop();
      },

      destroy() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        window.removeEventListener('mousemove', onMouseMove);
        debugMarkers.forEach(({ marker }) => marker.remove());
        debugMarkers.length = 0;
      },
    };
  }());

  /* ═══════════════════════════════════════════════════════════════════
     AUDIO TOGGLE BUTTON
     ═══════════════════════════════════════════════════════════════════ */

  function initAudioToggle() {
    const btn = dom.audioToggle;
    if (!btn) return;
    btn.addEventListener('click', () => {
      const muted = AudioEngine.toggleMute();
      btn.classList.toggle('playing', !muted);
      btn.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     RESIZE HANDLER — debounced 150ms
     Prevents 50+ sizeCanvas calls during a drag-resize.
     Each call re-uploads a canvas texture; debouncing is critical.
     ═══════════════════════════════════════════════════════════════════ */

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      sizeFrameCanvas();
      GrainEngine.resize();
      if (appState === 'website') ScrollTrigger.refresh();
    }, 150);
  }

  /* ═══════════════════════════════════════════════════════════════════
     INIT — entry point
     ═══════════════════════════════════════════════════════════════════ */

  async function init() {
    appState = 'loading';

    /*
     * REDUCED MOTION path:
     * Skip everything — preintro, cinematic, audio — and go straight
     * to the website state. Users who set this preference have explicitly
     * asked for no large animations.
     */
    if (PREFERS_REDUCED_MOTION) {
      dom.preloader.classList.add('done');
      dom.introLayer.setAttribute('aria-hidden', 'true');
      dom.introLayer.style.pointerEvents = 'none';
      dom.introLayer.style.display = 'none';
      dom.cinematicLayer.setAttribute('aria-hidden', 'true');
      dom.cinematicLayer.style.display = 'none';
      gsap.set(dom.contentSections, { opacity: 1 });
      document.body.style.overflow = '';
      // Still register ScrollTrigger for content reveals
      gsap.registerPlugin(ScrollTrigger);
      initContentAnimations();
      return;
    }

    /*
     * Set all intro element initial states via GSAP (not CSS).
     * GSAP reads these on first animate — ensures correct start values
     * regardless of CSS load order.
     */
    gsap.set([dom.introEyebrow, dom.introLogo, dom.introCta], { opacity: 0 });
    gsap.set(dom.introRule, {
      opacity: 0,
      scaleX: 0,
      transformOrigin: 'center center',
    });
    gsap.set(dom.introLayer, { opacity: 1 });
    /*
     * cinematicLayer is ALWAYS visible (opacity 1) so frame 0 shows
     * through the transparent intro layer as the background.
     * cinematicOverlay starts at opacity 0 — no black cover over the frame.
     */
    gsap.set(dom.cinematicLayer, { opacity: 1 });
    gsap.set(dom.cinematicOverlay, { opacity: 0 });
    gsap.set(dom.contentSections, { opacity: 0 });

    // Init subsystems
    initFrameCanvas();
    GrainEngine.init();
    AudioEngine.init();
    initAudioToggle();
    window.addEventListener('resize', onResize, { passive: true });

    // ── Preload all 163 frames ──
    await preloadAllFrames();

    /*
     * Draw frame 0 BEFORE the preloader fades away.
     * When the preloader disappears, the introLayer becomes visible with
     * frame 0 already rendered behind it — no flicker, no black gap.
     */
    drawFrame(0, CONFIG.zoomStart);

    // Hide preloader with a short fade
    dom.preloader.classList.add('done');

    // Enter the atmospheric pre-intro state
    enterPreintro();
  }

  // Boot when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
