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
    totalFrames:   163,
    framePath:     'framesWebp/frame_',  // maps to framesWebp/frame_0001.webp
    frameExt:      '.webp',
    parallelLoads: 8,                    // simultaneous fetch/decode workers

    /* Cinematic timing (seconds) */
    cinematicDuration: 6.0,             // 163 frames / 6s ≈ 27fps — faster, still cinematic
    fadeInDuration:    1.3,             // kept (unused now — no fade-in tween)
    fadeOutStart:      4.8,             // fade-to-black at 80% through the 6s run
    fadeOutDuration:   1.0,             // slightly tighter fade
    blackHold:         0.4,             // brief hold before website

    /* Camera zoom during cinematic — slow push-in for depth */
    zoomStart: 1.0,
    zoomEnd:   1.28,

    /* Grain canvas */
    grainScale:   0.25,    // render at 25% resolution → 16× fewer pixels
    grainFPS:     12,      // renders/sec — grain looks authentic at low fps
    grainOpacity: 0.055,   // very subtle; blend mode adds perceived intensity
    grainMobileFPS: 8,     // drop to 8fps on mobile for battery/perf
  };

  /* ─────────────────────────────────────────────────────────────────
     AUDIO CONFIGURATION
     ───────────────────────────────────────────────────────────────── */
  const AUDIO = {
    bgMusicPath:     'music/backgroud.mp3',
    jumpscarePath:   'music/jumpscare.mp3',
    buttonClickPath: 'music/buttonclick1.mp3',
    bgVolume:        0.35,
    bgFadeMs:        2800,              // slow fade-in for atmospheric buildup
    jumpscareVolume: 0.85,
    jumpscareFrame:  120,               // frame index at which jumpscare fires
    jumpscareTol:    4,                 // ±4-frame window to catch the beat
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
    preloader:        document.getElementById('preloader'),
    preloaderBar:     document.getElementById('preloaderBar'),
    preloaderPercent: document.getElementById('preloaderPercent'),
    preloaderProg:    document.getElementById('preloaderProgress'),

    introLayer:       document.getElementById('introLayer'),
    introCta:         document.getElementById('introCta'),
    introLogo:        document.querySelector('.intro-logo'),
    introEyebrow:     document.querySelector('.intro-eyebrow'),
    introRule:        document.querySelector('.intro-rule'),
    grainCanvas:      document.getElementById('grainCanvas'),

    cinematicLayer:   document.getElementById('cinematicLayer'),
    frameCanvas:      document.getElementById('frameCanvas'),
    cinematicOverlay: document.getElementById('cinematicOverlay'),

    audioToggle:      document.getElementById('audioToggle'),
    contentSections:  document.getElementById('contentSections'),
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
  let canvasW  = 0;
  let canvasH  = 0;

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
      let queued  = 0;
      const total = CONFIG.totalFrames;
      const par   = IS_MOBILE
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
              premultiplyAlpha:     'none', // opaque frames: skip premultiplication
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
    dom.frameCanvas.width  = Math.round(canvasW * dpr);
    dom.frameCanvas.height = Math.round(canvasH * dpr);
    dom.frameCanvas.style.width  = canvasW + 'px';
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

    const maxIdx  = CONFIG.totalFrames - 1;
    const clamped = Math.max(0, Math.min(maxIdx, floatIndex));
    const frameA  = Math.floor(clamped);
    const frameB  = Math.min(frameA + 1, maxIdx);
    const frac    = clamped - frameA;

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

    const imgR    = w / h;
    const canvasR = canvasW / canvasH;
    let dW, dH;
    if (canvasR > imgR) { dW = canvasW;   dH = canvasW / imgR; }
    else                { dH = canvasH;   dW = canvasH * imgR;  }

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
    let rafId    = null;
    let lastTime = 0;
    let grainCtx = null;
    const targetFPS = IS_MOBILE ? CONFIG.grainMobileFPS : CONFIG.grainFPS;
    const interval  = 1000 / targetFPS;

    function resize() {
      const c = dom.grainCanvas;
      c.width  = Math.ceil(window.innerWidth  * CONFIG.grainScale);
      c.height = Math.ceil(window.innerHeight * CONFIG.grainScale);
    }

    function render(timestamp) {
      if (!rafId) return;
      rafId = requestAnimationFrame(render);

      // Throttle to targetFPS — skip frames in between
      if (timestamp - lastTime < interval) return;
      lastTime = timestamp;

      const c  = dom.grainCanvas;
      const w  = c.width;
      const h  = c.height;
      const id = grainCtx.createImageData(w, h);
      const d  = id.data;

      /*
       * Each pixel: random luminance in range [0, 55].
       * Alpha at ~28 (~11%) — combined with CSS opacity: 0.055
       * and mix-blend-mode: overlay the grain is extremely subtle.
       * Intensity can be tuned via the alpha value here.
       */
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() * 55) | 0;
        d[i]   = n;     // R
        d[i+1] = n;     // G
        d[i+2] = n;     // B
        d[i+3] = 28;    // A
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
        rafId    = requestAnimationFrame(render);
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
    let bgMusic        = null;
    let jumpscareAudio = null;
    let clickAudio     = null;
    let isMuted        = false;
    let bgStarted      = false;
    let userInteracted = false;

    // Zone-based jumpscare state — prevents re-firing on the same crossing
    let jsArmed  = true;
    let jsInZone = false;

    /**
     * RAF-based volume fade — aligned to display refresh rate.
     * Smoother than setInterval (which fires at imprecise intervals)
     * and avoids audible stepping.
     */
    function fadeVolume(audio, target, durationMs) {
      const start    = audio.volume;
      const t0       = performance.now();
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
        bgMusic.loop    = true;
        bgMusic.volume  = 0;
        bgMusic.preload = 'auto';

        jumpscareAudio = new Audio(AUDIO.jumpscarePath);
        jumpscareAudio.loop    = false;
        jumpscareAudio.volume  = AUDIO.jumpscareVolume;
        jumpscareAudio.preload = 'auto';

        clickAudio = new Audio(AUDIO.buttonClickPath);
        clickAudio.loop    = false;
        clickAudio.volume  = 1.0;
        clickAudio.preload = 'auto';

        // Bind interaction listeners for browsers that block autoplay
        const onInteract = () => {
          if (userInteracted) return;
          userInteracted = true;
          this.startBgMusic();
          document.removeEventListener('click',      onInteract);
          document.removeEventListener('touchstart', onInteract);
          document.removeEventListener('keydown',    onInteract);
        };
        document.addEventListener('click',      onInteract, { passive: true });
        document.addEventListener('touchstart', onInteract, { passive: true });
        document.addEventListener('keydown',    onInteract, { passive: true });
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
        const lo     = AUDIO.jumpscareFrame - AUDIO.jumpscareTol;
        const hi     = AUDIO.jumpscareFrame + AUDIO.jumpscareTol;
        const inZone = currentFrame >= lo && currentFrame <= hi;

        if (inZone && !jsInZone) {
          jsInZone = true;
          if (jsArmed) {
            jsArmed = false;
            // Hard stop before play — prevents stacking if seeking back
            jumpscareAudio.pause();
            jumpscareAudio.currentTime = 0;
            jumpscareAudio.play().catch(() => {});
          }
        } else if (!inZone && jsInZone) {
          jsInZone = false;
          jsArmed  = true; // re-arm for next zone entry
        }
      },

      playClick() {
        if (clickAudio && !isMuted) {
          clickAudio.currentTime = 0;
          clickAudio.play().catch(() => {});
        }
      },

      toggleMute() {
        isMuted = !isMuted;
        if (isMuted) {
          if (bgMusic)        fadeVolume(bgMusic, 0, 400);
          setTimeout(() => { if (bgMusic) bgMusic.pause(); }, 450);
          if (jumpscareAudio) { jumpscareAudio.pause(); jumpscareAudio.currentTime = 0; }
          bgStarted = false;
        } else if (bgMusic) {
          bgMusic.volume = 0;
          bgMusic.play()
            .then(() => { bgStarted = true; fadeVolume(bgMusic, AUDIO.bgVolume, AUDIO.bgFadeMs); })
            .catch(() => {});
        }
        return isMuted;
      },

      get isMuted()  { return isMuted; },
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
      .to(dom.introLogo,    { opacity: 0.88, duration: 2.2, ease: 'power2.out' }, 0.8)
      .to(dom.introRule,    { opacity: 1, scaleX: 1, duration: 1.4, ease: 'power2.out' }, 1.5)
      .to(dom.introCta,     { opacity: 1, duration: 1.8, ease: 'power2.out' }, 2.2);

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

    dom.introCta.addEventListener('click',      handleActivation);
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
      .to(dom.introLayer, { opacity: 1,    duration: 0.10, ease: 'none' })

      // CTA text dissolves first — the invitation is gone
      .to(dom.introCta,     { opacity: 0, y: -10, duration: 0.5, ease: 'power2.in' }, 0.08)

      // Rule collapses inward
      .to(dom.introRule,    { opacity: 0, scaleX: 0, duration: 0.4, ease: 'power2.in' }, 0.15)

      // Logo fades slowly — manor name lingers before darkness
      .to(dom.introLogo,    { opacity: 0, duration: 0.9, ease: 'power2.in' }, 0.25)
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
      zoom:  CONFIG.zoomStart,
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
        frame:    CONFIG.totalFrames - 1,
        ease:     'none',
        duration: dur,
      }, 0)

      // ── Zoom: slow push-in, eased for depth ──
      .to(playhead, {
        zoom:     CONFIG.zoomEnd,
        ease:     'power1.inOut',
        duration: dur,
      }, 0)

      // ── Fade OUT: black returns to set up website transition ──
      .to(dom.cinematicOverlay, {
        opacity:  1,
        duration: CONFIG.fadeOutDuration,
        ease:     'power2.inOut',
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
    gsap.to(dom.cinematicLayer, { opacity: 0, duration: 1.0, ease: 'power2.out' });

    // Reveal main content container (hero elements will be animated up)
    dom.contentSections.removeAttribute('aria-hidden');
    gsap.set(dom.contentSections, { opacity: 1 });

    // Movie outro animation for the first scene
    const heroElements = document.querySelectorAll('.hero-section .section-eyebrow, .hero-title, .hero-subtitle, .hero-cta');
    
    const outroTl = gsap.timeline({
      onComplete: () => {
        // Restore scroll after text settles
        document.body.style.overflow = '';
      }
    });

    // Animate from way below the screen to position without fading in
    outroTl.fromTo(heroElements,
      { opacity: 1, y: window.innerHeight },
      { opacity: 1, y: 0, duration: 2.8, ease: 'power3.out', stagger: 0.15 }
    );

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
          opacity:  1,
          y:        0,
          duration: opts.duration || 0.9,
          delay:    opts.stagger ? i * opts.stagger : 0,
          ease:     'power3.out',
          scrollTrigger: {
            trigger:       el,
            start:         opts.start || 'top 88%',
            toggleActions: 'play none none none',
          },
        });
      });
    }

    // Story
    reveal('#storySection .section-eyebrow');
    reveal('#storySection .section-title');
    reveal('#storySection .section-text',  { stagger: 0.15 });
    reveal('#storySection .lore-card',     { duration: 1.1 });

    // Gameplay
    reveal('#gameplaySection .section-eyebrow');
    reveal('#gameplaySection .section-title');
    reveal('.feature-card', { stagger: 0.12, start: 'top 92%' });

    // Stats (with animated counters)
    reveal('#statsSection .section-eyebrow');
    reveal('#statsSection .section-title');
    reveal('.stat', { stagger: 0.1, start: 'top 90%' });

    document.querySelectorAll('.stat-number').forEach((el) => {
      const target = parseInt(el.dataset.target, 10);
      const obj    = { val: 0 };
      gsap.to(obj, {
        val:      target,
        duration: 2,
        ease:     'power2.out',
        scrollTrigger: {
          trigger:       el,
          start:         'top 90%',
          toggleActions: 'play none none none',
        },
        onUpdate: () => { el.textContent = Math.round(obj.val); },
      });
    });

    // Footer
    reveal('#footerSection .section-eyebrow');
    reveal('#footerSection .section-title');
    reveal('#footerSection .section-text');
    reveal('#footerSection .btn-lg');
  }

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
      dom.cinematicLayer.setAttribute('aria-hidden', 'true');
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
      opacity:         0,
      scaleX:          0,
      transformOrigin: 'center center',
    });
    gsap.set(dom.introLayer,      { opacity: 1 });
    /*
     * cinematicLayer is ALWAYS visible (opacity 1) so frame 0 shows
     * through the transparent intro layer as the background.
     * cinematicOverlay starts at opacity 0 — no black cover over the frame.
     */
    gsap.set(dom.cinematicLayer,  { opacity: 1 });
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
