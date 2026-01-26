// assets/player.js
(() => {
  "use strict";

  /** -------------------------
   *  Helpers
   *  ------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const SETTINGS_KEY = "yzk_settings";
  const VERSION_STORAGE_KEY = "yzk_site_version";

  const RE_SPACES = /\s+/g;
  const RE_NON_WORD = /[^\p{L}\p{N}]/gu;

  function normText(s) {
    return String(s || "")
      .toLowerCase()
      .replace(RE_SPACES, "")
      .replace(RE_NON_WORD, "");
  }

  function handleVersionUpdate() {
    const siteVersion = document.documentElement.dataset.siteVersion || "1";
    let stored;
    try {
      stored = localStorage.getItem(VERSION_STORAGE_KEY);
      if (!stored) {
        localStorage.setItem(VERSION_STORAGE_KEY, siteVersion);
        return;
      }
      if (stored === siteVersion) return;
      localStorage.setItem(VERSION_STORAGE_KEY, siteVersion);
    } catch {
      // If storage is unavailable, skip auto-refresh to avoid loops.
      return;
    }

    // Clear Cache API entries (if any) to avoid stale assets.
    if ("caches" in window && typeof caches.keys === "function") {
      caches.keys().then((keys) => {
        keys.forEach((k) => caches.delete(k));
      }).catch(() => {});
    }

    const url = new URL(window.location.href);
    if (url.searchParams.get("v") !== siteVersion) {
      url.searchParams.set("v", siteVersion);
      window.location.replace(url.toString());
      return;
    }

    window.location.reload();
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setSeekVisualFromValue() {
    // seekBar value is 0..1000
    const pct = (Number(seekBar.value) / 1000) * 100;
    seekBar.style.setProperty("--seek-pct", `${pct}%`);
  }

  function storageJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function setStorageJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage might be unavailable (private mode / quota / blocked)
    }
  }

  const DEFAULT_SETTINGS = {
    themeMode: "dark",       // "dark" | "light"
    accent: "purple",        // "purple" | "red" | "green" | "rainbow"
    reduceMotion: false,

    showDescriptions: false,
    showUpNext: false,

    preloadEnabled: true,

    defaultFormat: "mp3",    // "mp3" | "wav"

    // Crossfade (Spotify-like)
    crossfadeEnabled: false,
    crossfadeSeconds: 10     // 3..12
  };

  function loadSettings() {
    const saved = storageJSON(SETTINGS_KEY, null);
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  }

  function getInitialSettings() {
    const s = loadSettings();

    // Migration: if an older format key exists, prefer it if settings didn't store one yet
    const oldFmt = storageJSON("yzk_format", null);
    if (oldFmt && !s.defaultFormat) s.defaultFormat = oldFmt;

    // Migration/safety: ensure crossfadeSeconds is always a valid number.
    // (Keeps default at 10s the first time the slider is revealed.)
    if (!Number.isFinite(s.crossfadeSeconds)) s.crossfadeSeconds = 10;
    s.crossfadeSeconds = clamp(Math.round(s.crossfadeSeconds), 3, 12);

    return s;
  }

  function saveSettings() {
    setStorageJSON(SETTINGS_KEY, state.settings);
  }

  function updateSettings(patch, { apply = true } = {}) {
    state.settings = { ...state.settings, ...patch };
    saveSettings();
    if (apply) applySettingsToRuntime();
  }

  function escapeHTML(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function applySettingsToRuntime() {
    const s = state.settings;

    // Enforce compatibility: Crossfade cannot be enabled while Speed is not 1x.
    if (!isDefaultSpeed() && s.crossfadeEnabled) {
      s.crossfadeEnabled = false;
      saveSettings();
      try { cancelCrossfade?.(); } catch {}
    }

    // Theme + accent + motion
    applyThemeTokens(s);
    // Default format (single source of truth)
    state.preferredFormat = s.defaultFormat;

    // Apply visibility instantly
    if (state.settings.showUpNext) {
      mountUpNextIfNeeded();
    } else {
      unmountUpNext();
    }
    updateUpNextUI?.();

    renderNowPlayingUI?.();

    // Preload toggle behavior
    if (s.preloadEnabled) {
      preloadNextTrack?.();
    } else {
      if (audioPreload?.src) audioPreload.removeAttribute("src");
      audioPreload?.load?.();
    }

    // If Settings is open, keep crossfade controls synced to the current Speed.
    syncCrossfadeLockUI();
  }

  function applyThemeTokens(settings) {
    document.documentElement.dataset.theme = settings.themeMode;
    document.documentElement.dataset.accent = settings.accent;
    document.documentElement.dataset.reducemotion = settings.reduceMotion ? "1" : "0";
  }

  function mountUpNextIfNeeded() {
    if (!state.settings?.showUpNext) return;

    const slot = document.getElementById("upNextSlot");
    if (!slot) return;

    // already mounted
    if (document.getElementById("upNext")) return;

    const wrap = document.createElement("div");
    wrap.className = "upnext";
    wrap.id = "upNext";
    wrap.innerHTML = `
      <span class="upnext-label">Up next:</span>
      <span class="upnext-title" id="upNextTitle"></span>
    `;

    slot.appendChild(wrap);
  }

  function unmountUpNext() {
    const el = document.getElementById("upNext");
    if (el) el.remove();
  }

  /** -------------------------
   *  Paths (since you put songs inside assets/)
   *  ------------------------- */
  const SONGS_BASE = "assets/songs"; // <-- your choice
  const CATALOG_URL = `${SONGS_BASE}/catalog.json`;
  const ARTISTS_URL = `${SONGS_BASE}/artists.json`;
  const SONGS_LINKS_URL = `${SONGS_BASE}/songs_links.json`;

  /** -------------------------
   *  State
   *  ------------------------- */
  let songs = []; // will be loaded from index.json/meta.json
  let songsById = new Map();
  const audio = $("#audio");
  const audioPreload = $("#audioPreload");

  // Audio deck routing
  // - masterAudio: the element considered "current" for playback/navigation
  // - preloadAudio: the element used for preloading (and becomes the fade-in deck during crossfade)
  let masterAudio = audio;
  let preloadAudio = audioPreload;

  /** -------------------------
   *  Cross-browser volume control (Safari/iOS-safe)
   *
   *  - On iOS Safari, HTMLMediaElement.volume is effectively ignored (hardware-controlled).
   *  - Some Safari builds are also flaky when fading two <audio> elements via .volume.
   *
   *  We therefore prefer a WebAudio GainNode mixer when available, and fall back to
   *  element.volume elsewhere.
   *
   *  IMPORTANT: The AudioContext MUST be created/resumed from a user gesture.
   *  We only initialize it lazily from user-driven actions (play/next/prev/format, etc.).
   *  ------------------------- */
  const audioMix = {
    ctx: null,
    ready: false,
    // Per element nodes
    nodes: new Map(), // el -> { source, gain }
  };

  function canUseWebAudioMixer() {
    return typeof window !== "undefined" &&
      (window.AudioContext || window.webkitAudioContext) &&
      typeof window.MediaElementAudioSourceNode !== "undefined";
  }

  function ensureAudioMixer() {
    // Only create inside a user gesture (call this from click handlers / user actions).
    if (audioMix.ready) return true;
    if (!canUseWebAudioMixer()) return false;

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!audioMix.ctx) {
        // iOS Safari can stutter when the AudioContext runs at 48kHz.
        // Prefer 44.1kHz when the constructor accepts options.
        try { audioMix.ctx = new Ctx({ sampleRate: 44100, latencyHint: "interactive" }); }
        catch { audioMix.ctx = new Ctx(); }
      }
      // Some browsers start in suspended state until a gesture.
      if (audioMix.ctx.state === "suspended") {
        // resume() is promise-based; we can fire-and-forget here.
        audioMix.ctx.resume().catch(() => {});
      }

      // Attach both decks once (MediaElementSource can only be created once per element)
      [audio, audioPreload].forEach((el) => {
        if (!el || audioMix.nodes.has(el)) return;
        const source = audioMix.ctx.createMediaElementSource(el);
        const gain = audioMix.ctx.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(audioMix.ctx.destination);
        audioMix.nodes.set(el, { source, gain });
      });

      audioMix.ready = true;
      return true;
    } catch (err) {
      // If creation fails (rare), just fall back to element.volume.
      console.warn("Audio mixer init failed, falling back to element.volume", err);
      audioMix.ctx = null;
      audioMix.ready = false;
      return false;
    }
  }


  function teardownAudioMixer() {
    if (!audioMix.ready) return;
    try {
      for (const n of audioMix.nodes.values()) {
        if (n && n.source) { try { n.source.disconnect(); } catch {} }
        if (n && n.gain) { try { n.gain.disconnect(); } catch {} }
      }
    } catch {}
    try { audioMix.nodes.clear(); } catch {}
    try { if (audioMix.ctx && audioMix.ctx.state !== "closed" && audioMix.ctx.close) { audioMix.ctx.close().catch(() => {}); } } catch {}
    audioMix.ctx = null;
    audioMix.ready = false;
  }

  // -------------------------
  // iOS background-play safety
  // -------------------------
  const IS_IOS = (() => {
    const ua = navigator.userAgent || "";
    const isIPhoneIPadIPod = /iPad|iPhone|iPod/.test(ua);
    const isIPadOS13Plus = ua.includes("Mac") && "ontouchend" in document; // iPadOS reports as Mac
    return isIPhoneIPadIPod || isIPadOS13Plus;
  })();

  function isSpeedSensitiveMode() {
    return IS_IOS && Number(state?.speed || 1) !== 1;
  }

  function isDefaultSpeed() {
    return Number(state?.speed || 1) === 1;
  }

  function crossfadeSpeedLockMessage() {
    return "Crossfade is unavailable while Speed is not 1x.";
  }

  function isSettingsPanelOpen() {
    return Boolean(panel) && !panel.hidden && (panelTitle?.textContent || "") === "Settings";
  }

  function syncCrossfadeLockUI() {
    if (!isSettingsPanelOpen()) return;

    const locked = !isDefaultSpeed();

    const row = panelBody?.querySelector?.('[data-lock="crossfadeSpeed"]');
    const tgl = panelBody?.querySelector?.('[data-setting="crossfadeEnabled"]');
    const st = panelBody?.querySelector?.('#crossfadeStatus');
    const sliderRow = panelBody?.querySelector?.('#crossfadeRow');
    const slider = panelBody?.querySelector?.('#crossfadeSlider');

    if (row) row.classList.toggle('is-locked', locked);
    if (tgl) {
      tgl.classList.toggle('is-locked', locked);
      tgl.setAttribute('aria-disabled', locked ? 'true' : 'false');
    }

    // Keep the status text helpful when locked.
    if (st && locked) {
      st.textContent = 'Unavailable (Speed active)';
    } else if (st && !locked) {
      st.textContent = state.settings.crossfadeEnabled ? `On • ${state.settings.crossfadeSeconds}s` : 'Off';
    }

    // When locked, crossfade controls should be hidden.
    if (sliderRow) sliderRow.style.display = (!locked && state.settings.crossfadeEnabled) ? '' : 'none';
    if (slider) slider.style.display = (!locked && state.settings.crossfadeEnabled) ? '' : 'none';
  }

  function enforceCrossfadeSpeedCompatibility({ announce = false } = {}) {
    const locked = !isDefaultSpeed();
    if (locked && state?.settings?.crossfadeEnabled) {
      try { cancelCrossfade?.(); } catch {}
      updateSettings({ crossfadeEnabled: false }, { apply: true });
      if (announce) toast('Crossfade disabled (unavailable while Speed is not 1x).');
    }
    syncCrossfadeLockUI();
  }


  /**
   * On iOS, routing <audio> through WebAudio (MediaElementSource -> AudioContext)
   * is a common reason playback goes silent in the background because iOS may
   * suspend the AudioContext. For background reliability:
   * - Prefer native <audio> output on iOS (no WebAudio) unless crossfade is enabled.
   * - Only create the mixer when it's truly needed (crossfade) and we're visible.
   */
  function ensurePlaybackPipeline() {
    const speedSensitive = isSpeedSensitiveMode();
    const needsMixer = Boolean(state?.settings?.crossfadeEnabled) && !speedSensitive;

    // If we're on iOS and crossfade is OFF, never create the mixer.
    // This keeps audio on the native media pipeline => best chance to keep playing in background.
    if (IS_IOS && !needsMixer) return false;

    // If we're hidden on iOS, don't create the mixer (avoid switching pipeline right before backgrounding).
    if (IS_IOS && document.visibilityState === "hidden") return false;

    return ensureAudioMixer();
  }

  // If we already have a context (e.g., crossfade enabled), try to resume it when returning to foreground.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    try { audioMix?.ctx?.resume?.().catch(() => {}); } catch {}
  });

  function setDeckGain(el, value) {
    const v = clamp(Number(value) || 0, 0, 1);
    if (audioMix.ready && !isSpeedSensitiveMode()) {
      const n = audioMix.nodes.get(el);
      if (n?.gain) {
        try { n.gain.gain.value = v; } catch {}
        return;
      }
    }
    // Fallback
    try { el.volume = v; } catch {}
  }

  function applyTapeSpeedMode() {
    // "false" = do NOT preserve pitch -> pitch changes with playbackRate
    // Apply to BOTH decks so speed effect is consistent during crossfade.
    [audio, audioPreload].forEach((el) => {
      if (!el) return;
      try { el.preservesPitch = false; } catch {}
      try { el.mozPreservesPitch = false; } catch {}
      try { el.webkitPreservesPitch = false; } catch {}
    });
  }


  // Robust speed+pitch handling (iOS Safari can try to preserve pitch unless explicitly disabled)
  // We want classic "tape" behavior: speed changes ALSO change pitch.
  const SPEED_MIN = 0.5;
  const SPEED_MAX = 4.0;

  function setTapeSpeed(el, rate) {
    if (!el) return;
    const r = clamp(Number(rate) || 1, SPEED_MIN, SPEED_MAX);

    const forceNoPreserve = () => {
      // 'false' = do NOT preserve pitch -> pitch changes with playbackRate
      // Safari uses the prefixed property; newer Safari also supports the unprefixed one.
      try { el.webkitPreservesPitch = false; } catch {}
      try { el.preservesPitch = false; } catch {}
      try { el.mozPreservesPitch = false; } catch {}
    };

    const applyRate = () => {
      // Setting BOTH helps on Safari (some builds key off defaultPlaybackRate).
      try { el.defaultPlaybackRate = r; } catch {}
      try { el.playbackRate = r; } catch {}
    };

    const wasPlaying = !el.paused && !el.ended;
    const t = Number(el.currentTime) || 0;

    // iOS Safari sometimes only applies 'no pitch preserve' + rate cleanly when the element is paused.
    // So we do a very fast pause/apply/resume when needed, but only on iOS.
    if (IS_IOS && wasPlaying) {
      try { el.pause(); } catch {}
    }

    // Apply in both orders (Safari can be finicky depending on decode state).
    forceNoPreserve();
    applyRate();
    forceNoPreserve();
    applyRate();

    // Verify (best-effort). If Safari re-flipped it, toggle and re-assert.
    try {
      const hasPP = ("preservesPitch" in el) || ("webkitPreservesPitch" in el);
      if (hasPP) {
        const v = ("preservesPitch" in el) ? el.preservesPitch : el.webkitPreservesPitch;
        if (v === true) {
          try { el.webkitPreservesPitch = true; } catch {}
          try { el.preservesPitch = true; } catch {}
          forceNoPreserve();
          applyRate();
        }
      }
    } catch {}

    if (IS_IOS) {
      requestAnimationFrame(() => {
        forceNoPreserve();
        applyRate();
      });
    }

    if (IS_IOS && wasPlaying) {
      // Best effort to continue seamlessly.
      try { el.currentTime = t; } catch {}
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  }

  function applySpeedToDecks(rate = state.speed) {
    setTapeSpeed(masterAudio, rate);
    setTapeSpeed(preloadAudio, rate);
  }

  function wireTapeSpeedGuards() {
    // Re-assert tape mode + speed after src swaps / metadata loads.
    // (iOS Safari may silently reset pitch-preservation flags on new sources.)
    [audio, audioPreload].forEach((el) => {
      if (!el) return;
      const reapply = () => {
        // Avoid loops: only reapply if something drifted.
        try {
          const desired = clamp(Number(state.speed) || 1, SPEED_MIN, SPEED_MAX);
          const cur = Number(el.playbackRate) || 1;
          let pp = null;
          try {
            if ("preservesPitch" in el) pp = el.preservesPitch;
            else if ("webkitPreservesPitch" in el) pp = el.webkitPreservesPitch;
          } catch {}
          if (Math.abs(cur - desired) > 1e-3 || pp === true) {
            setTapeSpeed(el, desired);
          }
        } catch {
          setTapeSpeed(el, state.speed);
        }
      };
      el.addEventListener("loadedmetadata", reapply);
      el.addEventListener("play", reapply);
      el.addEventListener("ratechange", reapply);

    });
  }

  function getUIAudio() {
    // During crossfade, UI (timeline) should follow the incoming deck (Spotify-like).
    return crossfade?.active ? preloadAudio : masterAudio;
  }

  function getControlAudio() {
    // Playback controls should operate on the track that is "current" in the UI.
    return getUIAudio();
  }

  /** -------------------------
   *  Media Session (Bluetooth/headset/car controls + metadata)
   *
   *  Notes:
   *  - Works in most Chromium-based browsers and modern Android WebView.
   *  - iOS Safari support is limited; metadata may not appear everywhere.
   *  - For best results, serve the site over HTTPS (not file://).
   *  ------------------------- */
  const mediaSession = {
    supported: typeof navigator !== "undefined" && "mediaSession" in navigator,
    wired: false,
    lastMetaKey: "",
  };

  function wireMediaSessionOnce() {
    if (!mediaSession.supported || mediaSession.wired) return;
    mediaSession.wired = true;

    const ms = navigator.mediaSession;
    const safeSetHandler = (action, handler) => {
      try { ms.setActionHandler(action, handler); } catch {}
    };

    safeSetHandler("play", () => {
      if (!state.currentSongId) {
        const first = getActiveSongs?.()?.[0];
        if (first) loadAndPlay(first.id, 0, true);
        return;
      }
      const a = getControlAudio();
      if (a?.paused) {
        ensurePlaybackPipeline();
        a.play().catch(() => {});
      }
    });

    safeSetHandler("pause", () => {
      const a = getControlAudio();
      try { a.pause(); } catch {}
    });

    safeSetHandler("previoustrack", () => prevTrack());
    safeSetHandler("nexttrack", () => nextTrack());

    safeSetHandler("seekto", (details) => {
      const a = getControlAudio();
      if (!a) return;
      const t = Number(details?.seekTime);
      if (!Number.isFinite(t)) return;
      try {
        if (details?.fastSeek && typeof a.fastSeek === "function") a.fastSeek(t);
        else a.currentTime = t;
      } catch {}
      updatePositionState?.();
    });

    safeSetHandler("seekbackward", (details) => {
      const a = getControlAudio();
      if (!a) return;
      const offset = Number(details?.seekOffset);
      const jump = Number.isFinite(offset) ? offset : 10;
      try { a.currentTime = Math.max(0, (a.currentTime || 0) - jump); } catch {}
      updatePositionState?.();
    });

    safeSetHandler("seekforward", (details) => {
      const a = getControlAudio();
      if (!a) return;
      const offset = Number(details?.seekOffset);
      const jump = Number.isFinite(offset) ? offset : 10;
      try { a.currentTime = Math.min(a.duration || Infinity, (a.currentTime || 0) + jump); } catch {}
      updatePositionState?.();
    });

    safeSetHandler("stop", () => {
      const a = getControlAudio();
      try { a.pause(); a.currentTime = 0; } catch {}
      updatePositionState?.();
    });
  }

  function updateMediaSessionMetadata() {
    if (!mediaSession.supported) return;
    const song = currentSong?.();
    if (!song) return;

    const artistsText = (song.artists || []).join(", ");
    const key = `${song.id}::${artistsText}::${song.title}::${song.cover}`;
    if (key === mediaSession.lastMetaKey) return;
    mediaSession.lastMetaKey = key;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title || "",
        artist: artistsText || "",
        album: "",
        artwork: song.cover ? [
          { src: song.cover, sizes: "96x96", type: "image/jpeg" },
          { src: song.cover, sizes: "192x192", type: "image/jpeg" },
          { src: song.cover, sizes: "512x512", type: "image/jpeg" }
        ] : []
      });
    } catch {}
  }

  function updateMediaSessionPlaybackState() {
    if (!mediaSession.supported) return;
    try {
      const isPlaying = (!masterAudio.paused) || (!preloadAudio.paused);
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    } catch {}
  }

  function updatePositionState() {
    if (!mediaSession.supported) return;
    const a = getUIAudio?.();
    if (!a) return;
    try {
      const dur = Number(a.duration);
      if (!Number.isFinite(dur) || dur <= 0) return;
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: Number(a.playbackRate) || 1,
        position: clamp(Number(a.currentTime) || 0, 0, dur)
      });
    } catch {}
  }


  const state = {
    shuffle: false,
    loop: "off", // off | one | all
    speed: 1.0,

    sortKey: "upload",       // "upload" | "title" (artist later)
    sortInvert: false,
    likedOnly: false,
    searchQuery: "",

    currentSongId: null,
    currentVersionIndex: 0,

    queue: [],
    liked: new Set(storageJSON("yzk_liked", [])),

    //preferredFormat: storageJSON("yzk_format", "mp3"), // "mp3" | "wav"

    playIndex: -1,
    playListIds: [],

    settings: getInitialSettings(),
    preferredFormat: null,
  };

  state.preferredFormat = state.settings.defaultFormat || "mp3";

  // Ensure version changes refresh assets before app logic runs.
  handleVersionUpdate();

  // Apply theme tokens ASAP (so refresh doesn't flash/keep old look)
  applyThemeTokens(state.settings);


  /** -------------------------
   *  Elements
   *  ------------------------- */
  const songListEl = $("#songList");

  const searchInput = $("#searchInput");
  const searchClear = $("#searchClear");

  const miniPlayer = $("#miniPlayer");
  const miniCover = $("#miniCover");
  const miniTitle = $("#miniTitle");
  const miniArtist = $("#miniArtist");
  const miniLike = $("#miniLike");
  const miniPlayPause = $("#miniPlayPause");
  const miniProgressFill = $("#miniProgressFill");
  const miniPlayIcon = $("#miniPlayIcon");

  const sheet = $("#playerSheet");
  const sheetBackdrop = $("#sheetBackdrop");

  const sheetCover = $("#sheetCover");
  const sheetTitle = $("#sheetTitle");
  const sheetArtist = $("#sheetArtist");
  const sheetDesc = $("#sheetDesc");
  const sheetLike = $("#sheetLike");

  const seekBar = $("#seekBar");
  const timeCurrent = $("#timeCurrent");
  const timeTotal = $("#timeTotal");

  const btnShuffle = $("#btnShuffle");
  const btnPrev = $("#btnPrev");
  const btnPlayPause = $("#btnPlayPause");
  const btnNext = $("#btnNext");
  const btnLoop = $("#btnLoop");
  const playIcon = $("#playIcon");

  const btnSpeed = $("#btnSpeed");
  const btnQueue = $("#btnQueue");
  const btnFormat = $("#btnFormat");

  const btnHome = $("#btnHome");
  const btnSort = $("#btnSort");
  const btnSettings = $("#btnSettings");

  const panelBackdrop = $("#panelBackdrop");
  const panel = $("#panel");
  const panelTitle = $("#panelTitle");
  const panelBody = $("#panelBody");
  const panelClose = $("#panelClose");

  /** -------------------------
   *  Data loading
   *  ------------------------- */
  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }


/** -------------------------
 *  Artists metadata (manual list + auto song scan)
 *  ------------------------- */
let artistsMeta = null; // { artists: [...] }

async function loadArtistsMeta() {
  if (artistsMeta) return artistsMeta;
  try {
    const data = await fetchJSON(ARTISTS_URL);
    const list = Array.isArray(data?.artists) ? data.artists : [];
    artistsMeta = {
      artists: list.map((a) => ({
        id: String(a.id || a.name || "").trim(),
        name: String(a.name || a.id || "").trim(),
        avatar: a.avatar ? String(a.avatar) : "",
        bio: a.bio ? String(a.bio) : "",
        links: (a.links && typeof a.links === "object") ? a.links : {},
        aliases: Array.isArray(a.aliases) ? a.aliases.map(String) : []
      })).filter(a => a.name)
    };
    return artistsMeta;
  } catch (err) {
    artistsMeta = { artists: [] };
    console.warn("Artists metadata missing or invalid:", err);
    return artistsMeta;
  }

}


/** -------------------------
 *  Songs & links metadata (manual list + catalog reference)
 *  ------------------------- */
let songsLinksMeta = null; // { songs: [...] }

async function loadSongsLinksMeta() {
  if (songsLinksMeta) return songsLinksMeta;
  try {
    const data = await fetchJSON(SONGS_LINKS_URL);
    const list = Array.isArray(data?.songs) ? data.songs : [];
    songsLinksMeta = {
      songs: list.map((s) => ({
        id: String(s.id || "").trim(),
        cover: s.cover ? String(s.cover) : "", // optional override
        links: (s.links && typeof s.links === "object") ? s.links : {}
      })).filter(s => s.id)
    };
    return songsLinksMeta;
  } catch (err) {
    songsLinksMeta = { songs: [] };
    console.warn("Songs & links metadata missing or invalid:", err);
    return songsLinksMeta;
  }
}


function artistMatchesName(entry, name) {
  const target = normText(name);
  if (!target) return false;
  if (normText(entry.name) === target) return true;
  if (entry.id && normText(entry.id) === target) return true;
  if (Array.isArray(entry.aliases) && entry.aliases.some(a => normText(a) === target)) return true;
  return false;
}

function getSongsForArtist(artistName) {
  const t = normText(artistName);
  return songs.filter(s => (s.artists || []).some(a => normText(a) === t));
}

function safeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  // Allow only http(s) to avoid accidental javascript: etc.
  if (/^https?:\/\//i.test(s)) return s;
  return "";
}

function openExternal(url) {
  const u = safeUrl(url);
  if (u) window.open(u, "_blank", "noopener");
}

function platformIconSvg(platform) {
  // Simple inline SVGs (monochrome; uses currentColor)
  if (platform === "spotify") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 .01 20.01A10 10 0 0 0 12 2Zm4.6 14.53a.75.75 0 0 1-1.03.25c-2.8-1.71-6.33-2.1-10.5-1.15a.75.75 0 0 1-.33-1.46c4.56-1.04 8.47-.59 11.6 1.34.35.21.46.68.26 1.02Zm1.48-3.12a.9.9 0 0 1-1.24.3c-3.2-1.97-8.07-2.54-11.85-1.39a.9.9 0 1 1-.52-1.72c4.33-1.31 9.72-.66 13.4 1.6.42.25.56.8.21 1.21Zm.13-3.3C14.5 7.9 8.6 7.72 5.14 8.78a1 1 0 0 1-.58-1.92c3.95-1.2 10.55-.97 14.74 1.53a1 1 0 1 1-1.09 1.72Z"/></svg>`;
  }
  if (platform === "apple") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.6 13.2c0 2.7 2.4 3.6 2.4 3.6s-1.8 5.2-4.3 5.2c-1.1 0-2-.7-3.2-.7s-2.1.7-3.2.7C5.8 22 3 16.9 3 12.9 3 9 5.5 7 7.8 7c1.2 0 2.3.8 3.2.8.9 0 2.2-.9 3.8-.9.6 0 2.5.1 3.7 1.9-3.2 1.8-2.9 4.4-2.9 4.4ZM14.2 4.9c.7-.9 1.2-2.1 1-3.4-1.1.1-2.4.8-3.2 1.7-.7.8-1.3 2.1-1.1 3.3 1.2.1 2.5-.6 3.3-1.6Z"/></svg>`;
  }
  if (platform === "youtube") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 7.2a3 3 0 0 0-2.1-2.1C17.7 4.6 12 4.6 12 4.6s-5.7 0-7.5.5A3 3 0 0 0 2.4 7.2 31 31 0 0 0 2 12a31 31 0 0 0 .4 4.8 3 3 0 0 0 2.1 2.1c1.8.5 7.5.5 7.5.5s5.7 0 7.5-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z"/></svg>`;
  }
  if (platform === "soundcloud") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.9 11.2a3.3 3.3 0 0 0-1.5.36 4.6 4.6 0 0 0-8.9 1.6v5.2h10.9a3.6 3.6 0 0 0 .5-7.16Zm-12.1 2.5c-.3 0-.5.2-.5.5v3.7c0 .3.2.5.5.5s.5-.2.5-.5v-3.7c0-.3-.2-.5-.5-.5Zm-2 0c-.3 0-.5.2-.5.5v3.7c0 .3.2.5.5.5s.5-.2.5-.5v-3.7c0-.3-.2-.5-.5-.5Z"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 .01 20.01A10 10 0 0 0 12 2Zm1 14h-2v-2h2v2Zm0-4h-2V6h2v6Z"/></svg>`;
}

let artistsPanelHandler = null;

function openArtists() {
  openArtistsList();
}

function openArtistsList() {
  loadArtistsMeta().then((meta) => {
    const items = meta.artists;

    const listHtml = items.length ? `
      <div class="artists-list">
        ${items.map((a) => {
          const count = getSongsForArtist(a.name).length;
          const initials = escapeHTML((a.name || "?").slice(0, 1).toUpperCase());
          const avatar = a.avatar
            ? `<img class="artist-avatar" src="${escapeHTML(a.avatar)}" alt="${escapeHTML(a.name)}" loading="lazy" />`
            : `<div class="artist-avatar ph" aria-hidden="true">${initials}</div>`;
          return `
            <button class="artist-row" type="button" data-artist="${escapeHTML(a.id || a.name)}">
              ${avatar}
              <div class="artist-row-meta">
                <div class="artist-row-name">${escapeHTML(a.name)}</div>
                <div class="artist-row-sub">${count ? `${count} song${count === 1 ? "" : "s"}` : "No songs yet"}</div>
              </div>
              <div class="artist-row-go" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M10 6l6 6-6 6-1.4-1.4L13.2 12 8.6 7.4 10 6z"/></svg>
              </div>
            </button>
          `;
        }).join("")}
      </div>
    ` : `<div class="panel-empty">No artists found. Add <code>assets/songs/artists.json</code>.</div>`;

    openFullPanel("Artists", `
      <div class="panel-note">All artists of <b>YZKSTUDIOS</b> are listed here. If you are one of those artists and want to modify your page, please contact your management. Songs are detected automatically.</div>
      ${listHtml}
    `);

    bindArtistsPanel();
  });
}

function openArtistDetail(artistKey) {
  loadArtistsMeta().then((meta) => {
    const entry =
      meta.artists.find(a => artistMatchesName(a, artistKey)) ||
      meta.artists.find(a => a.id === artistKey) ||
      null;

    if (!entry) {
      toast("Artist not found.");
      openArtistsList();
      return;
    }

    const links = {
      spotify: safeUrl(entry.links?.spotify),
      apple: safeUrl(entry.links?.apple),
      youtube: safeUrl(entry.links?.youtube),
      soundcloud: safeUrl(entry.links?.soundcloud),
    };

    const songsFor = getSongsForArtist(entry.name);

    const platformsHtml = `
      <div class="artist-platforms" role="group" aria-label="Platforms">
        ${["spotify","apple","youtube","soundcloud"].map((p) => {
          const url = links[p];
          const disabled = !url;
          return `
            <button class="platform-btn ${disabled ? "is-disabled" : ""}" type="button"
              data-platform="${p}" ${disabled ? "disabled" : ""} ${url ? `data-url="${escapeHTML(url)}"` : ""} aria-label="${p}">
              ${platformIconSvg(p)}
            </button>
          `;
        }).join("")}
      </div>
    `;

    const songsHtml = songsFor.length ? `
      <div class="artist-songs-grid">
        ${songsFor.map((s) => `
          <button class="tiny-song" type="button" data-song-id="${escapeHTML(s.id)}" aria-label="Play ${escapeHTML(s.title)}">
            <img class="tiny-cover" src="${escapeHTML(s.cover)}" alt="" loading="lazy" />
            <div class="tiny-meta">
              <div class="tiny-title">${escapeHTML(s.title)}</div>
              <div class="tiny-artist">${escapeHTML((s.artists || []).join(", "))}</div>
            </div>
          </button>
        `).join("")}
      </div>
    ` : `<div class="panel-empty">No songs found for this artist.</div>`;

    const avatarTop = entry.avatar
      ? `<img class="artist-hero-avatar" src="${escapeHTML(entry.avatar)}" alt="${escapeHTML(entry.name)}" loading="lazy" />`
      : `<div class="artist-hero-avatar ph" aria-hidden="true">${escapeHTML(entry.name.slice(0,1).toUpperCase())}</div>`;

    openFullPanel(entry.name, `
      <button class="back-row" type="button" data-artists-back>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 7 9 12l5 5-1.4 1.4L6.2 12l6.4-6.4L14 7z"/></svg>
        <span>Back to Artists</span>
      </button>

      <div class="artist-hero">
        ${avatarTop}
        <div class="artist-hero-text">
          <div class="artist-hero-name">${escapeHTML(entry.name)}</div>
          <div class="artist-hero-bio">${escapeHTML(entry.bio || "—")}</div>
        </div>
      </div>

      ${platformsHtml}

      <div class="artist-section-title">Songs</div>
      ${songsHtml}
    `);

    bindArtistsPanel();
  });
}

function bindArtistsPanel() {
  // remove old handler to avoid stacking as we re-render the panel body
  if (artistsPanelHandler) panelBody.removeEventListener("click", artistsPanelHandler);

  artistsPanelHandler = (e) => {
    const back = e.target.closest("[data-artists-back]");
    if (back) {
      e.preventDefault();
      openArtistsList();
      return;
    }

    const row = e.target.closest("[data-artist]");
    if (row) {
      e.preventDefault();
      openArtistDetail(row.dataset.artist);
      return;
    }

    const plat = e.target.closest("[data-url]");
    if (plat) {
      const url = plat.dataset.url;
      if (url) openExternal(url);
      return;
    }

    const songBtn = e.target.closest("[data-song-id]");
    if (songBtn) {
      const id = songBtn.dataset.songId;
      if (!id) return;
      // Keep the panel open; play in background.
      cancelCrossfade?.();
      loadAndPlay(id, 0, true);
      preloadNextTrack?.();
      updateUpNextUI?.();
      toast("Playing…");
      return;
    }
  };

  panelBody.addEventListener("click", artistsPanelHandler);
}

/** -------------------------
 *  Songs & links panel
 *  ------------------------- */
let songsLinksPanelHandler = null;

function openSongsLinks() {
  openSongsLinksList();
}

function openSongsLinksList() {
  loadSongsLinksMeta().then((meta) => {
    const items = meta.songs;

    const notice = `<div class="panel-note">Only the songs listed here are available on streaming platforms. All other songs in the player are <b>not</b> published anywhere.</div>`;

    const listHtml = items.length ? `
      <div class="songslinks-list">
        ${items.map((it) => {
          const song = getSongById(it.id);
          if (!song) {
            return `
              <button class="songlink-row missing" type="button" data-songlink-id="${escapeHTML(it.id)}">
                <div class="songlink-cover ph" aria-hidden="true">?</div>
                <div class="songlink-meta">
                  <div class="songlink-title">${escapeHTML(it.id)}</div>
                  <div class="songlink-sub">Not found in catalog.json</div>
                </div>
                <div class="songlink-go" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M10 6l6 6-6 6-1.4-1.4L13.2 12 8.6 7.4 10 6z"/></svg>
                </div>
              </button>
            `;
          }
          const cover = it.cover ? it.cover : song.cover;
          return `
            <button class="songlink-row" type="button" data-songlink-id="${escapeHTML(it.id)}">
              <img class="songlink-cover" src="${escapeHTML(cover)}" alt="" loading="lazy" />
              <div class="songlink-meta">
                <div class="songlink-title">${escapeHTML(song.title)}</div>
                <div class="songlink-sub">${escapeHTML((song.artists || []).join(", "))}</div>
              </div>
              <div class="songlink-go" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M10 6l6 6-6 6-1.4-1.4L13.2 12 8.6 7.4 10 6z"/></svg>
              </div>
            </button>
          `;
        }).join("")}
      </div>
    ` : `<div class="panel-empty">No songs listed. Add <code>assets/songs/songs_links.json</code>.</div>`;

    openFullPanel("Songs & links", `${notice}${listHtml}`);
    bindSongsLinksPanel();
  });
}

function openSongLinksDetail(songId) {
  loadSongsLinksMeta().then((meta) => {
    const it = meta.songs.find(x => x.id === songId) || null;
    const song = getSongById(songId);

    if (!it || !song) {
      toast("Song not found.");
      openSongsLinksList();
      return;
    }

    const links = {
      spotify: safeUrl(it.links?.spotify),
      apple: safeUrl(it.links?.apple),
      youtube: safeUrl(it.links?.youtube),
      soundcloud: safeUrl(it.links?.soundcloud),
    };

    const cover = it.cover ? it.cover : song.cover;

    const platformsHtml = `
      <div class="songlink-platforms" role="group" aria-label="Platforms">
        ${["spotify","apple","youtube","soundcloud"].map((p) => {
          const url = links[p];
          const disabled = !url;
          return `
            <button class="platform-btn ${disabled ? "is-disabled" : ""}" type="button"
              data-platform="${p}" ${disabled ? "disabled" : ""} ${url ? `data-url="${escapeHTML(url)}"` : ""} aria-label="${p}">
              ${platformIconSvg(p)}
            </button>
          `;
        }).join("")}
      </div>
    `;

    openFullPanel(song.title, `
      <button class="back-row" type="button" data-songslinks-back>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 7 9 12l5 5-1.4 1.4L6.2 12l6.4-6.4L14 7z"/></svg>
        <span>Back to Songs</span>
      </button>

      <div class="songlink-hero">
        <img class="songlink-hero-cover" src="${escapeHTML(cover)}" alt="" loading="lazy" />
        <div class="songlink-hero-text">
          <div class="songlink-hero-title">${escapeHTML(song.title)}</div>
          <div class="songlink-hero-artists">${escapeHTML((song.artists || []).join(", "))}</div>
        </div>
      </div>

      <div class="songlink-desc">${escapeHTML(song.description || "—")}</div>

      <div class="artist-section-title">Listen on</div>
      ${platformsHtml}
    `);

    bindSongsLinksPanel();
  });
}

function bindSongsLinksPanel() {
  if (songsLinksPanelHandler) panelBody.removeEventListener("click", songsLinksPanelHandler);

  songsLinksPanelHandler = (e) => {
    const back = e.target.closest("[data-songslinks-back]");
    if (back) {
      e.preventDefault();
      openSongsLinksList();
      return;
    }

    const row = e.target.closest("[data-songlink-id]");
    if (row) {
      e.preventDefault();
      openSongLinksDetail(row.dataset.songlinkId);
      return;
    }

    const plat = e.target.closest("[data-url]");
    if (plat) {
      const url = plat.dataset.url;
      if (url) openExternal(url);
      return;
    }
  };

  panelBody.addEventListener("click", songsLinksPanelHandler);
}



  function normalizeMetaToSong(folderId, meta) {
    // folder path: assets/songs/<id>/
    const base = `${SONGS_BASE}/${encodeURIComponent(folderId)}`;

    const coverFile = meta.cover || "cover.jpg";
    const cover = `${base}/${coverFile}`;

    const formats = meta.formats && typeof meta.formats === "object" ? meta.formats : null;

    // fallback if you still have old files:
    const resolvedFormats = formats || {
      mp3: meta.mp3 || null,
      wav: meta.wav || "v1.wav"
    };

    return {
      id: meta.id || folderId,
      folderId,
      title: meta.title || folderId,
      artists: Array.isArray(meta.artists) ? meta.artists : [],
      description: meta.description || "",
      cover,
      formats: {
        mp3: resolvedFormats.mp3 ? `${base}/${resolvedFormats.mp3}` : null,
        wav: resolvedFormats.wav ? `${base}/${resolvedFormats.wav}` : null
      }
    };
  }

  async function loadSongs() {
    const catalog = await fetchJSON(CATALOG_URL);
    const list = Array.isArray(catalog.songs) ? catalog.songs : [];

    songs = list.map(meta => normalizeMetaToSong(meta.id, meta));
    songsById = new Map(songs.map(s => [s.id, s]));

    if (!songs.length) toast("No songs found. Check assets/songs/catalog.json");
  }

  /** -------------------------
   *  Render
   *  ------------------------- */
  function getSongById(id) {
    return songsById.get(id) || null;
  }

  function currentSong() {
    return getSongById(state.currentSongId);
  }

  function isLiked(songId) {
    return state.liked.has(songId);
  }

  function setLiked(songId, on) {
    if (on) state.liked.add(songId);
    else state.liked.delete(songId);
    setStorageJSON("yzk_liked", Array.from(state.liked));
    renderList();
    renderNowPlayingUI();
  }

  function resetAllLikes() {
    // Clear in-memory + persisted likes
    state.liked.clear();
    setStorageJSON("yzk_liked", []);

    // Rebuild active playlist (important when in "liked only" mode)
    rebuildPlayList();

    // Refresh UI
    renderList();
    renderNowPlayingUI?.();
    updateUpNextUI?.();
    preloadNextTrack?.();

    toast("Liked songs reset.");
  }


  function getActiveSongs() {
    let list = [...songs];

    // Filter: liked only
    if (state.likedOnly) {
      list = list.filter(s => isLiked(s.id));
    }

    // Search filter (title + artists)
    const q = normText(state.searchQuery);
    if (q) {
      list = list.filter(s => {
        const hay = normText(s.title) + normText((s.artists || []).join(" "));
        return hay.includes(q);
      });
    }

    // Sort
    if (state.sortKey === "title") {
      list.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" })
      );
    } else {
      // "upload" = catalog order; keep as-is (already in songs array order)
      // no action needed
    }

    if (state.sortInvert) list.reverse();

    return list;
  }

  function rebuildPlayList() {
    // Active view is the list the player navigates through
    state.playListIds = getActiveSongs().map(s => s.id);

    if (state.currentSongId) {
      state.playIndex = state.playListIds.indexOf(state.currentSongId);
    } else {
      state.playIndex = -1;
    }
  }

  function renderSkeletonList(count = 9) {
    songListEl.innerHTML = Array.from({ length: count }).map(() => `
      <div class="skeleton-card">
        <div class="skeleton-inner">
          <div class="skel-cover"></div>
          <div class="skel-lines">
            <div class="skel-line long"></div>
            <div class="skel-line short"></div>
          </div>
          <div class="skel-actions">
            <div class="skel-btn"></div>
            <div class="skel-btn"></div>
          </div>
        </div>
      </div>
    `).join("");
  }

  function renderList() {
    const list = getActiveSongs();

    songListEl.innerHTML = list.map(song => {
      const likedClass = isLiked(song.id) ? "like-on" : "";
      const isPlaying = song.id === state.currentSongId;
      const playingClass = isPlaying ? "is-playing" : "";

      return `
        <article class="song-card ${playingClass}" data-song-id="${song.id}">
          <div class="swipe-bg" aria-hidden="true">
            <div class="swipe-right">
              <svg viewBox="0 0 24 24"><path d="M3 12h13l-5-5 1.4-1.4L20.8 14l-8.4 8.4L11 21l5-5H3z"/></svg>
              <span>Queue</span>
            </div>
            <div class="swipe-left">
              <span>Like</span>
              <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            </div>
          </div>

          <div class="card-inner">
            <img class="cover" src="${song.cover}" alt="Cover for ${escapeHTML(song.title)}" loading="lazy" />
            <div class="meta">
              <div class="title">${escapeHTML(song.title)}</div>
              <div class="artist">${escapeHTML((song.artists || []).join(", "))}</div>
            </div>

            <div class="card-actions">
              <button class="small-btn btn-queue" aria-label="Queue song">
                <svg viewBox="0 0 24 24"><path d="M3 10h14v2H3v-2zm0-4h14v2H3V6zm0 8h10v2H3v-2zm16 0v-3h2v3h3v2h-3v3h-2v-3h-3v-2h3z"/></svg>
              </button>
              <button class="small-btn btn-like ${likedClass}" aria-label="Like song">
                <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
              </button>
            </div>

            <div class="playing-badge" aria-hidden="true">
              <div class="bars"><span></span><span></span><span></span></div>
            </div>
          </div>
        </article>
      `;
    }).join("");

    attachSwipeHandlers();
  }

  function renderQueuePanel() {
    const now = currentSong();
    const qSongs = state.queue.map(id => getSongById(id)).filter(Boolean);

    const nowHtml = now ? `
      <div class="queue-section-title">Now Playing</div>
      <article class="song-card is-playing queue-card" data-song-id="${now.id}">
        <div class="card-inner">
          <img class="cover" src="${now.cover}" alt="Cover for ${escapeHTML(now.title)}" />
          <div class="meta">
            <div class="title">${escapeHTML(now.title)}</div>
            <div class="artist">${escapeHTML((now.artists || []).join(", "))}</div>
          </div>
          <div class="playing-badge" aria-hidden="true">
            <div class="bars"><span></span><span></span><span></span></div>
          </div>
        </div>
      </article>
    ` : "";

    const queueHtml = qSongs.length ? `
      <div class="queue-section-title">Queue (top → bottom)</div>
      <section class="song-list" id="queueList">
        ${qSongs.map((s, idx) => `
          <article class="song-card queue-card" data-queue-idx="${idx}" data-song-id="${s.id}">
            <div class="card-inner">
              <img class="cover" src="${s.cover}" alt="Cover for ${escapeHTML(s.title)}" loading="lazy" />
              <div class="meta">
                <div class="title">${escapeHTML(s.title)}</div>
                <div class="artist">${escapeHTML((s.artists || []).join(", "))}</div>
              </div>

              <div class="card-actions">
                <div class="drag-handle" role="button" aria-label="Reorder" title="Hold & drag">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h16v2H4V7zm0 5h16v2H4v-2zm0 5h16v2H4v-2z"></path>
                  </svg>
                </div>

                <button class="del-btn" data-del="${idx}" aria-label="Remove from queue">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.71 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29l6.3 6.3 6.29-6.3z"></path>
                  </svg>
                </button>
              </div>
            </div>
          </article>
        `).join("")}
      </section>
    ` : `<div class="queue-section-title">Queue</div><div class="queue-empty">Queue is empty. Swipe a song right or tap the + button to add one.</div>`;

    openFullPanel("Queue", `${nowHtml}${queueHtml}`);

    // Bind interactions for this panel instance
    bindQueuePanelInteractions();
  }

  function bindQueuePanelInteractions() {
    const queueList = $("#queueList");
    if (!queueList) return;

    // Tap on queued song = play immediately (and remove it from queue)
    queueList.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        const idx = Number(del.dataset.del);
        if (Number.isFinite(idx)) {
          state.queue.splice(idx, 1);
          renderQueuePanel();
          preloadNextTrack?.();
          updateUpNextUI();
        }
        return;
      }

      // Don't trigger play when pressing drag handle
      if (e.target.closest(".drag-handle")) return;

      const card = e.target.closest(".song-card");
      if (!card) return;

      const idx = Number(card.dataset.queueIdx);
      const songId = card.dataset.songId;

      // remove the tapped item from queue, then play it
      if (Number.isFinite(idx)) state.queue.splice(idx, 1);
      closePanel();
      loadAndPlay(songId, 0, true);
      preloadNextTrack?.();
      updateUpNextUI();
    });

    // Drag reorder (touch-friendly)
    enableQueueDragReorder(queueList);
  }

  function enableQueueDragReorder(queueList) {
    let draggingEl = null;
    let placeholder = null;
    let startY = 0;
    let offsetY = 0;
    let pointerId = null;

    function cards() {
      return Array.from(queueList.querySelectorAll(".song-card"));
    }

    function indexFromPlaceholder() {
      const arr = cards();
      return arr.indexOf(placeholder);
    }

    function commitQueueFromDOM() {
      const arr = cards();
      const newQueue = arr
        .map(el => el.dataset.songId)
        .filter(Boolean);
      state.queue = newQueue;
      preloadNextTrack?.();
      updateUpNextUI();
    }

    function onPointerDown(e) {
      const handle = e.target.closest(".drag-handle");
      if (!handle) return;

      const card = handle.closest(".song-card");
      if (!card) return;

      draggingEl = card;
      pointerId = e.pointerId;

      const rect = card.getBoundingClientRect();
      startY = e.clientY;
      offsetY = startY - rect.top;

      // placeholder keeps space in list
      placeholder = document.createElement("div");
      placeholder.style.height = `${rect.height}px`;
      placeholder.style.marginBottom = "10px";
      placeholder.style.borderRadius = "18px";
      placeholder.style.border = "1px dashed rgba(255,255,255,.18)";
      placeholder.style.background = "rgba(255,255,255,.02)";

      card.parentNode.insertBefore(placeholder, card.nextSibling);

      // make dragged element float
      card.style.width = `${rect.width}px`;
      card.style.position = "fixed";
      card.style.left = `${rect.left}px`;
      card.style.top = `${rect.top}px`;
      card.style.zIndex = "9999";
      card.style.pointerEvents = "none";
      card.style.opacity = "0.95";
      card.style.transform = "scale(1.01)";
      card.style.transition = "none";

      handle.setPointerCapture(pointerId);
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!draggingEl) return;

      const y = e.clientY;
      const newTop = y - offsetY;

      draggingEl.style.top = `${newTop}px`;

      // Decide where placeholder should go based on pointer position
      const arr = cards().filter(el => el !== draggingEl);
      const phRect = placeholder.getBoundingClientRect();
      const midY = y;

      for (const el of arr) {
        if (el === placeholder) continue;
        const r = el.getBoundingClientRect();
        const center = r.top + r.height / 2;

        // Insert placeholder before/after elements based on pointer crossing center
        if (midY < center) {
          if (placeholder !== el.previousSibling) {
            queueList.insertBefore(placeholder, el);
          }
          return;
        }
      }

      // If we're below all cards, move placeholder to end
      queueList.appendChild(placeholder);
    }

    function cleanupDrag() {
      if (!draggingEl) return;

      // Put dragged element back into flow where placeholder is
      draggingEl.style.position = "";
      draggingEl.style.left = "";
      draggingEl.style.top = "";
      draggingEl.style.width = "";
      draggingEl.style.zIndex = "";
      draggingEl.style.pointerEvents = "";
      draggingEl.style.opacity = "";
      draggingEl.style.transform = "";
      draggingEl.style.transition = "";

      queueList.insertBefore(draggingEl, placeholder);
      placeholder.remove();

      draggingEl = null;
      placeholder = null;
      pointerId = null;

      // Commit new queue order from DOM
      commitQueueFromDOM();

      // Re-render panel so delete indices are correct (safe + consistent)
      renderQueuePanel();
    }

    function onPointerUp() {
      cleanupDrag();
    }

    function onPointerCancel() {
      cleanupDrag();
    }

    queueList.addEventListener("pointerdown", onPointerDown, { passive: false });
    queueList.addEventListener("pointermove", onPointerMove, { passive: false });
    queueList.addEventListener("pointerup", onPointerUp);
    queueList.addEventListener("pointercancel", onPointerCancel);
  }

  function renderNowPlayingUI() {
    const song = currentSong();
    const visible = Boolean(song);
    miniPlayer.classList.toggle("is-visible", visible);

    if (!song) return;
    if (btnFormat) btnFormat.textContent = (state.preferredFormat || "mp3").toUpperCase();

    const artistsText = (song.artists || []).join(", ");
    miniCover.src = song.cover;
    miniTitle.textContent = song.title;
    miniArtist.textContent = artistsText;

    sheetCover.src = song.cover;
    sheetTitle.textContent = song.title;
    sheetArtist.textContent = artistsText;

    if (sheetDesc) {
      const showDesc = Boolean(state.settings?.showDescriptions);
      sheetDesc.style.display = showDesc ? "" : "none";
      if (showDesc) sheetDesc.textContent = song.description || "—";
    }

    miniLike.classList.toggle("like-on", isLiked(song.id));
    sheetLike.classList.toggle("like-on", isLiked(song.id));

    btnShuffle.style.boxShadow = state.shuffle ? "var(--glow)" : "";
    btnShuffle.classList.toggle("is-on", state.shuffle);

    btnLoop.style.boxShadow = state.loop !== "off" ? "var(--glow)" : "";
    btnLoop.classList.toggle("is-on", state.loop !== "off");

    btnSpeed.textContent = `${state.speed.toFixed(2).replace(/\.00$/, "")}×`;

    wireMediaSessionOnce();
    updateMediaSessionMetadata();
    updateMediaSessionPlaybackState();
    updatePositionState();
  }

  function updateUpNextUI() {
    // If setting is OFF: remove it and stop
    if (!state.settings?.showUpNext) {
      unmountUpNext();
      return;
    }

    // If setting is ON: make sure it exists
    mountUpNextIfNeeded();

    const upNext = document.getElementById("upNext");
    const upNextTitle = document.getElementById("upNextTitle");
    if (!upNext || !upNextTitle) return;

    const next = resolveNextUp?.();

    // Nothing to show yet (e.g. no current song): keep the element, just show placeholder
    if (!next || !next.id) {
      upNextTitle.textContent = "—";
      return;
    }

    const song = getSongById(next.id);
    if (!song) {
      upNextTitle.textContent = "—";
      return;
    }

    upNextTitle.textContent = song.title;
  }

  function setPlayIcons(isPlaying) {
    playIcon.innerHTML = isPlaying
      ? `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>`
      : `<path d="M8 5v14l11-7z"></path>`;
    miniPlayIcon.innerHTML = isPlaying
      ? `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>`
      : `<path d="M8 5v14l11-7z"></path>`;
  }

  /** -------------------------
   *  Playback (supports sources fallback)
   *  ------------------------- */
  function pickPlayableSource(version) {
    // If sources array exists, try in order.
    if (Array.isArray(version.sources) && version.sources.length) {
      // We can't perfectly detect support per file without MIME,
      // but we can try setting src and let it play.
      return version.sources[0];
    }
    return version.src;
  }

  // Remember the next pick when shuffle is on, so we can preload something deterministic.
  state.nextShufflePick = null;

  function resolveNextUp() {
    // 1) Queue has priority
    if (state.queue.length > 0) {
      return { id: state.queue[0], versionIndex: 0 };
    }

    // If nothing playing, we don't preload.
    if (!state.currentSongId) return null;

    // 2) Loop one => next is same track
    if (state.loop === "one") {
      return { id: state.currentSongId, versionIndex: state.currentVersionIndex || 0 };
    }

    // 3) Shuffle mode => keep a stable pick until consumed
    if (state.shuffle) {
      const ids = state.playListIds || [];
      if (ids.length <= 1) return null;

      // If we already decided a next shuffle pick, keep it.
      if (state.nextShufflePick && state.nextShufflePick !== state.currentSongId) {
        return { id: state.nextShufflePick, versionIndex: 0 };
      }

      // Otherwise pick a new one (not the current song)
      let pick = state.currentSongId;
      let guard = 0;
      while (pick === state.currentSongId && guard < 20) {
        pick = ids[Math.floor(Math.random() * ids.length)];
        guard++;
      }
      state.nextShufflePick = pick;
      return { id: pick, versionIndex: 0 };
    }

    // 4) Normal order
    const ids = state.playListIds || [];
    if (!ids.length) return null;

    const i = state.playIndex;
    const nextIndex = i + 1;

    if (nextIndex < ids.length) {
      return { id: ids[nextIndex], versionIndex: 0 };
    }

    // End reached
    if (state.loop === "all") {
      return { id: ids[0], versionIndex: 0 };
    }

    return null;
  }

  /** -------------------------
   *  Crossfade engine (uses <audio id="audio"> as the UI/master element
   *  and <audio id="audioPreload"> as the fade-in deck).
   *  ------------------------- */
  const crossfade = {
    active: false,
    raf: 0,
    startedAt: 0,
    durationMs: 0,
    target: null, // { id, versionIndex }
    src: null,
    // Guard against late events (e.g., canplay firing after user hits Next/Prev/Pause)
    token: 0,
    incomingEl: null,
    canplayHandler: null,
  };

  function canCrossfadeNow() {
    const s = state.settings;
    // iOS Safari + WebAudio (required for crossfade volume control) can become choppy at non-1x playback rates.
    // Prefer a correct/smooth speed effect over crossfade when rate != 1.
    if (IS_IOS && Number(state.speed || 1) !== 1) return false;
    return Boolean(s?.crossfadeEnabled) && state.loop !== "one";
  }

  function cancelCrossfade() {
    if (!crossfade.active) return;
    crossfade.active = false;
    if (crossfade.raf) cancelAnimationFrame(crossfade.raf);
    crossfade.raf = 0;
    crossfade.target = null;
    crossfade.src = null;

    // Invalidate any pending async work from this transition.
    crossfade.token++;
    if (crossfade.incomingEl && crossfade.canplayHandler) {
      try { crossfade.incomingEl.removeEventListener("canplay", crossfade.canplayHandler); } catch {}
    }
    crossfade.incomingEl = null;
    crossfade.canplayHandler = null;

    // Hard abort: stop BOTH decks so we never leave a "ghost" audio running.
    // (Used when user manually changes tracks / formats.)
    try { masterAudio.pause(); } catch {}
    try { preloadAudio.pause(); } catch {}
    setDeckGain(masterAudio, 1);
    setDeckGain(preloadAudio, 1);
  }

  function commitCrossfadeNow({ pause = false } = {}) {
    // When the user interacts (prev/next/pause) during a crossfade, the expectation is that
    // controls apply to the *incoming* track (the one shown in the UI). To guarantee that,
    // we instantly "finish" the transition by swapping decks with no reload.
    if (!crossfade.active) return;

    // Cancel any pending canplay->ensurePlay from the in-flight transition.
    crossfade.token++;
    if (crossfade.incomingEl && crossfade.canplayHandler) {
      try { crossfade.incomingEl.removeEventListener("canplay", crossfade.canplayHandler); } catch {}
    }
    crossfade.incomingEl = null;
    crossfade.canplayHandler = null;

    if (crossfade.raf) cancelAnimationFrame(crossfade.raf);
    crossfade.raf = 0;

    const incoming = preloadAudio;
    const outgoing = masterAudio;

    crossfade.active = false;
    crossfade.target = null;
    crossfade.src = null;

    try { outgoing.pause(); } catch {}
    setDeckGain(outgoing, 1);
    setDeckGain(incoming, 1);

    // Swap roles: incoming becomes master.
    masterAudio = incoming;
    preloadAudio = outgoing;

    // Ensure master has correct runtime properties.
    try {
      applyTapeSpeedMode?.();
      setTapeSpeed(masterAudio, state.speed);
      masterAudio.loop = (state.loop === "one");
    } catch {}

    // Ensure the preload deck is idle/clean for future loads.
    try {
      preloadAudio.pause();
      setDeckGain(preloadAudio, 1);
    } catch {}

    if (pause) {
      try { masterAudio.pause(); } catch {}
    }

    // Keep preloading consistent with the new current track
    preloadNextTrack();
    updateUpNextUI();
    updateTimelineUI();
  }

  function getBestSrcForSong(song, fmt) {
    if (!song) return null;
    let src = song.formats?.[fmt] || null;
    if (!src) src = song.formats?.mp3 || song.formats?.wav || null;
    return src;
  }

  function consumeNextPick(next) {
    if (!next) return null;

    // Queue: if we are about to play queue[0], consume it now.
    if (state.queue.length > 0 && state.queue[0] === next.id) {
      state.queue.shift();
    }

    // Shuffle: consume a fixed pick so a new one is chosen afterwards.
    if (state.shuffle) {
      state.nextShufflePick = null;
    }

    return next;
  }

  async function startCrossfadeTo(next) {
    if (IS_IOS && document.visibilityState === "hidden") return; // ✅ don't spin up mixer in background
    if (crossfade.active) return;
    if (!canCrossfadeNow()) return;
    if (!next || !state.currentSongId) return;

    const song = getSongById(next.id);
    if (!song) return;

    const fmt = state.preferredFormat || state.settings?.defaultFormat || "mp3";
    const src = getBestSrcForSong(song, fmt);
    if (!src) return;

    // Mark active + store data
    crossfade.active = true;
    crossfade.target = next;
    crossfade.src = src;
    crossfade.startedAt = performance.now();
    crossfade.durationMs = clamp(Number(state.settings?.crossfadeSeconds) || 10, 3, 12) * 1000;

    // Show the incoming track immediately (Spotify-like)
    state.currentSongId = next.id;
    state.currentVersionIndex = next.versionIndex ?? 0;
    rebuildPlayList();
    state.playIndex = state.playListIds.indexOf(next.id);
    renderList();
    renderNowPlayingUI();
    preloadNextTrack();
    updateUpNextUI();

    // Prep incoming deck (preloadAudio)
    // Create a token so late 'canplay' events can't start "ghost" playback
    // after the user presses Next/Prev/Pause.
    crossfade.token++;
    const myToken = crossfade.token;
    const incomingEl = preloadAudio;
    crossfade.incomingEl = incomingEl;
    crossfade.canplayHandler = null;

    try {
      // Prefer WebAudio gains when available (Safari/iOS-safe). This should already
      // be initialized from a prior user gesture; if not, we'll just fall back.
      ensurePlaybackPipeline();
      applyTapeSpeedMode?.();
      incomingEl.pause();
      setDeckGain(incomingEl, 0);
      incomingEl.loop = false;
      setTapeSpeed(incomingEl, state.speed);
    } catch {}

    // If preload deck already has the exact source, keep it.
    const already = incomingEl.src && incomingEl.src.endsWith(src);
    if (!already) {
      incomingEl.src = src;
      incomingEl.load();
    }

    // Start playback when ready
    const ensurePlay = async () => {
      // Abort if user changed state while we were waiting.
      if (!crossfade.active || crossfade.token !== myToken) return;
      try {
        incomingEl.currentTime = 0;
      } catch {}
      try {
        await incomingEl.play();
      } catch {
        // If the browser blocks a second simultaneous element, fall back to normal next.
        if (!crossfade.active || crossfade.token !== myToken) return;
        cancelCrossfade();
        loadAndPlay(next.id, next.versionIndex ?? 0, true);
        return;
      }
      if (!crossfade.active || crossfade.token !== myToken) return;
      animateCrossfade();
    };

    if (incomingEl.readyState >= 2) {
      ensurePlay();
    } else {
      const handler = () => {
        // Always remove, even if token changed.
        try { incomingEl.removeEventListener("canplay", handler); } catch {}
        if (!crossfade.active || crossfade.token !== myToken) return;
        ensurePlay();
      };
      crossfade.canplayHandler = handler;
      incomingEl.addEventListener("canplay", handler);
    }
  }

  function animateCrossfade() {
    if (!crossfade.active) return;

    const tick = () => {
      if (!crossfade.active) return;
      const now = performance.now();
      const t = clamp((now - crossfade.startedAt) / crossfade.durationMs, 0, 1);

      // Linear fade; keep it predictable (matches your clean UX)
      setDeckGain(masterAudio, 1 - t);
      setDeckGain(preloadAudio, t);

      if (t < 1) {
        crossfade.raf = requestAnimationFrame(tick);
        return;
      }

      // Commit: swap decks so playback continues with zero gaps.
      // (Avoids reloading the incoming src into the old master element, which caused the tiny pause.)
      const incoming = preloadAudio;
      const outgoing = masterAudio;

      crossfade.active = false;
      crossfade.raf = 0;
      crossfade.target = null;
      crossfade.src = null;

      // Stop outgoing deck and normalize volumes
      try { outgoing.pause(); } catch {}
      setDeckGain(outgoing, 1);
      setDeckGain(incoming, 1);

      // Swap roles: incoming becomes master, old master becomes the preload deck
      masterAudio = incoming;
      preloadAudio = outgoing;

      // Ensure master has the correct runtime properties
      try {
        applyTapeSpeedMode?.();
        setTapeSpeed(masterAudio, state.speed);
        masterAudio.loop = (state.loop === "one");
      } catch {}

      // Leave the preload deck in a clean state for the next preload
      try {
        preloadAudio.pause();
        setDeckGain(preloadAudio, 1);
      } catch {}

      // Preload the next-up track for the *new* now-playing
      preloadNextTrack();
      updateUpNextUI();
    };

    crossfade.raf = requestAnimationFrame(tick);
  }

  function maybeStartCrossfade() {
    if (IS_IOS && document.visibilityState === "hidden") return; // ✅ don't start on background
    if (!canCrossfadeNow()) return;
    if (crossfade.active) return;
    if (!state.currentSongId) return;

    const dur = masterAudio.duration || 0;
    const cur = masterAudio.currentTime || 0;
    if (!(dur > 0)) return;

    const seconds = clamp(Math.round(state.settings.crossfadeSeconds || 10), 3, 12);
    if (dur - cur > seconds) return;

    const next = consumeNextPick(resolveNextUp());
    if (!next) return;
    startCrossfadeTo(next);
  }

  function preloadNextTrack() {
    // Respect user setting
    if (state.settings && state.settings.preloadEnabled === false) return;
    if (!preloadAudio) return;
    // While crossfading, the preload deck is being used as a playback deck.
    if (crossfade.active) return;
    // iOS Safari: avoid decoding/preloading a second <audio> while using non-1x rates.
    // This reduces stutter and avoids repeated buffer churn that can momentarily reset playbackRate.
    if (isSpeedSensitiveMode()) {
      try { if (preloadAudio.src) preloadAudio.removeAttribute("src"); } catch {}
      try { preloadAudio.load(); } catch {}
      return;
    }


    const next = resolveNextUp();

    if (!next) {
      // Clear preload if nothing is next
      if (preloadAudio.src) preloadAudio.removeAttribute("src");
      preloadAudio.load();
      return;
    }

    const song = getSongById(next.id);
    if (!song) return;

    const fmt = state.preferredFormat || "mp3";
    let src = song.formats?.[fmt] || null;

    // Fallback if selected format missing
    if (!src) src = song.formats?.mp3 || song.formats?.wav || null;
    if (!src) return;

    // Avoid reloading same source (audioPreload.src becomes absolute URL)
    if (preloadAudio.src && preloadAudio.src.endsWith(src)) return;

    preloadAudio.src = src;
    preloadAudio.load();
  }

  function loadAndPlay(songId, versionIndex = 0, autoplay = true) {
    // If the user manually changes tracks mid-crossfade, abort the transition cleanly.
    cancelCrossfade();

    const song = getSongById(songId);
    if (!song) return;

    state.currentSongId = songId;

    rebuildPlayList();
    state.playIndex = state.playListIds.indexOf(songId);

    const fmt = state.preferredFormat || "mp3";
    let src = song.formats?.[fmt] || null;

    // fallback: if mp3 missing, try wav; if wav missing, try mp3
    if (!src) {
      src = song.formats?.mp3 || song.formats?.wav || null;
      if (!src) {
        toast("Missing audio files (mp3/wav) for this song.");
        return;
      }
    }

    // Load into the current master deck
    masterAudio.src = src;
    applyTapeSpeedMode?.();
    setTapeSpeed(masterAudio, state.speed);
    masterAudio.loop = (state.loop === "one");

    // Keep preload deck idle when switching manually
    try {
      preloadAudio.pause();
      setDeckGain(preloadAudio, 1);
    } catch {}

    renderList();
    renderNowPlayingUI();
    preloadNextTrack();
    updateUpNextUI();

    if (autoplay) {
      // Initialize WebAudio mixer from this user gesture when possible (Safari/iOS fade support)
      ensurePlaybackPipeline();
      masterAudio.play().catch(() => {});
    }
  }

  function togglePlay() {
    if (!state.currentSongId) {
      const first = getActiveSongs()[0];
      if (first) loadAndPlay(first.id, 0, true);
      return;
    }

    // If the user interacts mid-crossfade, controls should apply to the *incoming*
    // track (the one shown in the UI). We avoid weird state/desync by committing
    // the fade immediately before toggling.
    if (crossfade.active) {
      // During a fade there may be a brief moment where the incoming deck hasn't
      // started yet, but the outgoing deck is still playing. Treat the button as
      // "pause" if *either* deck is currently playing.
      const isAnyPlaying = (!masterAudio.paused) || (!preloadAudio.paused);
      commitCrossfadeNow({ pause: isAnyPlaying });
      if (!isAnyPlaying) {
        ensurePlaybackPipeline();
        masterAudio.play().catch(() => {});
      }
      return;
    }

    const a = getControlAudio();
    if (a.paused) {
      ensurePlaybackPipeline();
      a.play().catch(() => {});
    } else a.pause();
  }

  function nextTrack() {
    // If a crossfade is in progress, treat the incoming track as the current one.
    // Commit first so navigation is consistent and we don't skip/advance weirdly.
    if (crossfade.active) commitCrossfadeNow();
    if (state.queue.length > 0) {
      const nextId = state.queue.shift();
      loadAndPlay(nextId, 0, true);
      return;
    }
    if (!state.currentSongId) return;

    if (state.shuffle) {
      const next = resolveNextUp();
      if (!next) return;

      // Consume the shuffle pick so a new one is chosen afterwards
      state.nextShufflePick = null;

      loadAndPlay(next.id, next.versionIndex ?? 0, true);
      return;
    }

    const ids = state.playListIds;
    if (!ids.length) return;

    const i = state.playIndex;
    const nextIndex = i + 1;

    if (nextIndex < ids.length) loadAndPlay(ids[nextIndex], 0, true);
    else if (state.loop === "all") loadAndPlay(ids[0], 0, true);
  }

  function prevTrack() {
    // If a crossfade is in progress, operate on the incoming track.
    if (crossfade.active) commitCrossfadeNow();
    if (!state.currentSongId) return;

    const a = getControlAudio();
    if (a.currentTime > 3) {
      a.currentTime = 0;
      return;
    }

    const ids = state.playListIds;
    if (!ids.length) return;

    const i = state.playIndex;
    const prevIndex = i - 1;

    if (prevIndex >= 0) loadAndPlay(ids[prevIndex], 0, true);
    else if (state.loop === "all") loadAndPlay(ids[ids.length - 1], 0, true);
    else {
      try { getControlAudio().currentTime = 0; } catch {}
    }
  }

  function queueSong(songId) {
    if (!songId) return;
    if (state.queue[state.queue.length - 1] !== songId) {
      state.queue.push(songId);
    }
    toast(`Queued: ${getSongById(songId)?.title ?? ""}`);
    preloadNextTrack();
    updateUpNextUI();
  }

  /** -------------------------
   *  UI interactions
   *  ------------------------- */
  songListEl.addEventListener("click", (e) => {
    const card = e.target.closest(".song-card");
    if (!card) return;
    const songId = card.dataset.songId;

    if (e.target.closest(".btn-like")) {
      setLiked(songId, !isLiked(songId));
      return;
    }
    if (e.target.closest(".btn-queue")) {
      queueSong(songId);
      return;
    }
    loadAndPlay(songId, 0, true);
  });

  /** -------------------------
   *  Mini Player swipe (left = next, right = previous)
   *  - Prevents accidental "open sheet" tap when user swipes
   *  ------------------------- */
  const miniSwipe = { ignoreClick: false };

  function miniSwipeNext() {
    // For swipe navigation we intentionally do NOT loop/shuffle/queue.
    if (crossfade.active) commitCrossfadeNow();
    if (!state.currentSongId) return;

    rebuildPlayList();
    const ids = state.playListIds || [];
    const i = ids.indexOf(state.currentSongId);
    if (i < 0) return;

    const nextIndex = i + 1;
    if (nextIndex >= ids.length) return; // last song => do nothing
    loadAndPlay(ids[nextIndex], 0, true);
  }

  function miniSwipePrev() {
    if (crossfade.active) commitCrossfadeNow();
    if (!state.currentSongId) return;

    rebuildPlayList();
    const ids = state.playListIds || [];
    const i = ids.indexOf(state.currentSongId);
    if (i < 0) return;

    const prevIndex = i - 1;
    if (prevIndex < 0) return; // first song => do nothing
    loadAndPlay(ids[prevIndex], 0, true);
  }

  function attachMiniPlayerSwipe() {
    let active = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let dy = 0;
    let gesture = null; // null | "scroll" | "swipe"

    // Visual feedback (subtle horizontal drag on the mini card's inner sections)
    const maxVisual = 72;          // px, after this we apply resistance
    const hardClamp = 96;          // px, absolute cap
    const setSwipeX = (x) => miniPlayer.style.setProperty("--miniSwipeX", `${x}px`);
    // Immediate reset (no animation) — useful before starting a new gesture.
    const hardResetSwipeX = () => {
      miniPlayer.classList.remove("is-swiping");
      setSwipeX(0);
    };
    // Animated snap-back (remove is-swiping first so transitions are enabled, then set X to 0).
    const snapBackSwipeX = () => {
      miniPlayer.classList.remove("is-swiping");
      requestAnimationFrame(() => setSwipeX(0));
    };
    const applySwipeX = (rawDx) => {
      const sign = rawDx < 0 ? -1 : 1;
      const abs = Math.abs(rawDx);
      let x = abs;
      if (x > maxVisual) x = maxVisual + (x - maxVisual) * 0.22; // gentle resistance
      x = Math.min(hardClamp, x) * sign;
      setSwipeX(x);
    };

    const threshold = 55;    // action trigger
    const lockDistance = 8;  // decide swipe vs scroll

    const isInteractiveTarget = (t) =>
      Boolean(t.closest("#miniLike") || t.closest("#miniPlayPause"));

    const cleanup = () => {
      if (pointerId != null) {
        try { miniPlayer.releasePointerCapture(pointerId); } catch {}
      }
      active = false;
      pointerId = null;
      gesture = null;
      dx = 0;
      dy = 0;
    };

    const onDown = (e) => {
      // Only handle the primary pointer and ignore button taps (like/play).
      if (e.isPrimary === false) return;
      if (!state.currentSongId) return;
      if (isInteractiveTarget(e.target)) return;

      active = true;
      pointerId = e.pointerId;
      gesture = null;
      dx = 0;
      dy = 0;

      startX = e.clientX;
      startY = e.clientY;

      // Ensure we're visually reset before a new gesture.
      hardResetSwipeX();

      // Capture so we still get pointerup even if the finger drifts slightly.
      try { miniPlayer.setPointerCapture(pointerId); } catch {}
    };

    const onMove = (e) => {
      if (!active || e.pointerId !== pointerId) return;

      dx = e.clientX - startX;
      dy = e.clientY - startY;

      if (!gesture) {
        if (Math.abs(dx) < lockDistance && Math.abs(dy) < lockDistance) return;
        gesture = (Math.abs(dx) > Math.abs(dy)) ? "swipe" : "scroll";

        // Once we decide it's a swipe, suppress the following click-to-open.
        if (gesture === "swipe") {
          miniSwipe.ignoreClick = true;
          miniPlayer.classList.add("is-swiping");
        }
      }

      if (gesture !== "swipe") return;

      // Block the browser from treating this as a tap/scroll.
      e.preventDefault();

      // Visual: drag the inner content a bit.
      applySwipeX(dx);
    };

    const onUp = (e) => {
      if (!active || e.pointerId !== pointerId) return;

      const wasSwipe = (gesture === "swipe");
      const finalDx = dx;

      cleanup();

      // If it was a swipe gesture, prevent the click and run navigation if passed threshold.
      if (wasSwipe) {
        // Snap back with a soft transition.
        snapBackSwipeX();
        if (Math.abs(finalDx) >= threshold) {
          if (finalDx < 0) miniSwipeNext();
          else miniSwipePrev();
        }
        // Click fires after pointerup; clear on next tick after click handler checks it.
        setTimeout(() => { miniSwipe.ignoreClick = false; }, 0);
      } else {
        // Not a swipe => ensure no leftover transform.
        hardResetSwipeX();
      }
    };

    const onCancel = () => {
      const wasSwipe = (gesture === "swipe");
      cleanup();
      snapBackSwipeX();
      if (wasSwipe) setTimeout(() => { miniSwipe.ignoreClick = false; }, 0);
    };

    miniPlayer.addEventListener("pointerdown", onDown, { passive: true });
    miniPlayer.addEventListener("pointermove", onMove, { passive: false });
    miniPlayer.addEventListener("pointerup", onUp);
    miniPlayer.addEventListener("pointercancel", onCancel);
  }

  attachMiniPlayerSwipe();

  miniPlayer.addEventListener("click", (e) => {
    if (miniSwipe.ignoreClick) { miniSwipe.ignoreClick = false; return; }
    if (e.target.closest("#miniLike")) return;
    if (e.target.closest("#miniPlayPause")) return;
    openSheet();
  });


  miniLike.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!state.currentSongId) return;
    setLiked(state.currentSongId, !isLiked(state.currentSongId));
  });

  miniPlayPause.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });

  btnPlayPause.addEventListener("click", togglePlay);
  btnNext.addEventListener("click", nextTrack);
  btnPrev.addEventListener("click", prevTrack);

  btnShuffle.addEventListener("click", () => {
    state.shuffle = !state.shuffle;
    state.nextShufflePick = null;
    renderNowPlayingUI();
    preloadNextTrack();
    updateUpNextUI();
    toast(state.shuffle ? "Shuffle on" : "Shuffle off");
  });

  btnLoop.addEventListener("click", () => {
    state.loop = (state.loop === "off") ? "all" : (state.loop === "all") ? "one" : "off";
    try { masterAudio.loop = (state.loop === "one"); } catch {}
    renderNowPlayingUI();
    preloadNextTrack();
    updateUpNextUI();
    toast(`Loop: ${state.loop}`);
  });

  btnSpeed.addEventListener("click", () => {
    const steps = [
      { value: "0.80", label: "0.8×" },
      { value: "0.90", label: "0.9×" },
      { value: "1", label: "1× (Default)" },
      { value: "1.10", label: "1.1×" },
      { value: "1.20", label: "1.2×" }
    ];

    openSelect("Speed", steps, String(state.speed), (val) => {
      state.speed = Number(val);

      // Speed effect is incompatible with Crossfade:
      // - If Crossfade is currently enabled, disable it automatically and inform the user.
      // - While Speed != 1x, Crossfade stays locked in Settings.
      enforceCrossfadeSpeedCompatibility({ announce: true });
      applyTapeSpeedMode?.();
      // iOS Safari: playbackRate + pitch behaves incorrectly (and can stutter) when the media element
      // is routed through WebAudio (MediaElementAudioSourceNode). If the mixer was created earlier
      // (e.g. because crossfade was enabled), tear it down so native playbackRate works.
      if (isSpeedSensitiveMode() && audioMix.ready) {
        const wasPlaying = (!masterAudio.paused) && (!masterAudio.ended);
        const t = Number(masterAudio.currentTime) || 0;
        try { masterAudio.pause(); } catch {}
        try { preloadAudio.pause(); } catch {}
        teardownAudioMixer();
        try { masterAudio.currentTime = t; } catch {}
        if (wasPlaying) {
          const p = masterAudio.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
        // Also stop decoding the next track while in speed-sensitive mode.
        try { if (preloadAudio.src) preloadAudio.removeAttribute("src"); } catch {}
        try { preloadAudio.load(); } catch {}
      }

      // Apply speed to both decks (order matters if decks swapped).
      try { setTapeSpeed(masterAudio, state.speed); } catch {}
      try { setTapeSpeed(preloadAudio, state.speed); } catch {}
      renderNowPlayingUI();
      toast(`Speed: ${state.speed}×`);
    });
  });

  sheetLike.addEventListener("click", () => {
    if (!state.currentSongId) return;
    setLiked(state.currentSongId, !isLiked(state.currentSongId));
  });

  // stubs for later
  btnQueue.addEventListener("click", () => {
    renderQueuePanel();
  });

  btnHome.addEventListener("click", () => window.location.href = "index.html");
  btnSort.addEventListener("click", () => openSort());
  btnSettings.addEventListener("click", () => openSettings());

  // Sheet open/close
  $("#btnSheetClose").addEventListener("click", closeSheet);
  sheetBackdrop.addEventListener("click", closeSheet);

  // Panel close
  panelClose.addEventListener("click", closePanel);
  panelBackdrop.addEventListener("click", closePanel);

  // Seek
  let isSeeking = false;

  seekBar.addEventListener("input", () => {
    isSeeking = true;
    setSeekVisualFromValue();
    updatePositionStateThrottled();
    const deck = getUIAudio();
    const dur = deck?.duration || 0;
    const target = (Number(seekBar.value) / 1000) * dur;
    timeCurrent.textContent = formatTime(target);
  });

  seekBar.addEventListener("change", () => {
    const deck = getUIAudio();
    const dur = deck?.duration || 0;
    const target = (Number(seekBar.value) / 1000) * dur;
    try { deck.currentTime = target; } catch {}
    updatePositionState();
    isSeeking = false;
  });

  /** -------------------------
   *  Audio events
   *  ------------------------- */
  function updatePlayIconsFromDecks() {
    const playing = (!masterAudio.paused) || (!preloadAudio.paused);
    setPlayIcons(playing);
    updateMediaSessionPlaybackState();
  }

  [audio, audioPreload].forEach((el) => {
    if (!el) return;
    el.addEventListener("play", updatePlayIconsFromDecks);
    el.addEventListener("pause", updatePlayIconsFromDecks);
  });

  let _posStateLast = 0;

  function updatePositionStateThrottled() {
    const now = performance.now();
    if (now - _posStateLast < 1000) return; // 1 update per second
    _posStateLast = now;
    updatePositionState();
  }

  function updateTimelineUI() {
    const deck = getUIAudio();
    const dur = deck?.duration || 0;
    const cur = deck?.currentTime || 0;

    if (!isSeeking && dur > 0) {
      const v = Math.round((cur / dur) * 1000);
      seekBar.value = String(clamp(v, 0, 1000));
      setSeekVisualFromValue();
    }
    timeCurrent.textContent = formatTime(cur);
    timeTotal.textContent = formatTime(dur);

    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    miniProgressFill.style.width = `${pct}%`;
  }

  function onDeckTimeUpdate(el) {
    // Only the deck currently shown in the UI should drive timeline updates.
    if (el !== getUIAudio()) return;
    updateTimelineUI();
    if ("mediaSession" in navigator) updatePositionStateThrottled();

    // Auto-start crossfade near the end of the OUTGOING track (if enabled)
    // Use the current master deck timing as the reference.
    if (!crossfade.active) maybeStartCrossfade();
  }

  [audio, audioPreload].forEach((el) => {
    if (!el) return;
    el.addEventListener("timeupdate", () => onDeckTimeUpdate(el));
    el.addEventListener("loadedmetadata", () => {
      if (el !== getUIAudio()) return;
      timeTotal.textContent = formatTime(el.duration || 0);
      updatePositionState();
    });
    el.addEventListener("ended", () => {
      // Only the current master ending should advance.
      if (el !== masterAudio) return;
      if (crossfade.active) return;
      if (state.loop === "one") return;
      nextTrack();
    });
  });

  /** -------------------------
   *  Sheet
   *  ------------------------- */
  function openSheet() {
    if (!state.currentSongId) return;
    sheetBackdrop.hidden = false;
    sheet.classList.add("is-open");
  }

  function closeSheet() {
    sheet.classList.remove("is-open");
    sheetBackdrop.hidden = true;
  }

  /** -------------------------
   *  Panel (sort/settings)
   *  ------------------------- */
  function openPanel(title, html) {
    panelTitle.textContent = title;
    panelBody.innerHTML = html;
    panel.hidden = false;
    panelBackdrop.hidden = false;
  }

  function openFullPanel(title, html) {
    panel.classList.add("is-full");
    openPanel(title, html);
  }

  function closePanel() {
    panel.hidden = true;
    panelBackdrop.hidden = true;
    panelBody.innerHTML = "";
    panel.classList.remove("is-full")
  }

  function openSelect(title, options, currentValue, onPick) {
    openPanel(title, `
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${options.map(opt => `
          <button class="pill" data-value="${opt.value}"
            style="${opt.value === currentValue ? "border-color: rgba(168,85,247,.45); box-shadow: var(--glow);" : ""}">
            ${escapeHTML(opt.label)}
          </button>
        `).join("")}
      </div>
    `);

    panelBody.addEventListener("click", (e) => {
      const b = e.target.closest("[data-value]");
      if (!b) return;
      const val = b.dataset.value;
      closePanel();
      onPick(val);
    }, { once: true });
  }

  function openConfirm({ title, message, confirmText = "OK", cancelText = "Cancel", danger = false, onConfirm, onCancel } = {}) {
    openPanel(title || "Confirm", `
      <div class="confirm-msg">${escapeHTML(message || "")}</div>
      <div class="confirm-actions">
        <button class="pill" type="button" data-confirm-cancel>${escapeHTML(cancelText)}</button>
        <button class="${danger ? "danger-btn" : "pill"}" type="button" data-confirm-ok>${escapeHTML(confirmText)}</button>
      </div>
    `);

    const handler = (e) => {
      const ok = e.target.closest("[data-confirm-ok]");
      const cancel = e.target.closest("[data-confirm-cancel]");
      if (!ok && !cancel) return;
      e.preventDefault();
      e.stopPropagation();
      closePanel();
      if (ok) onConfirm?.();
      else onCancel?.();
    };

    // Use a one-off handler so repeated opens don’t stack listeners
    panelBody.addEventListener("click", handler, { once: true });
  }


  function openAboutPanel() {
    const txt = `Welcome to the Official YZK Leaks Player 3! 

About:

This Player is a new, overhauled version of the old one.
New features include: Customization, Sorting/Filtering, Queuing, Liking, Crossfade, Looping, Formatting, Preload, and more...
Did you know you can swipe a song card to either queue or like them? Swipe -> queue | <- like


LP3 Version: 202626010757

Created By Azryx (Github source code: https://github.com/ZegoFr34ks/zegofr34ks.github.io)

The songs are under Copyright © YZKSTUDIOS and shall not be uploaded without permission

Contact: contact.kavzego@gmail.com`;
    // Escape first, then turn new lines into <br> for nice wrapping
    let html = escapeHTML(txt).replace(/\n/g, "<br>");
    // Auto-link GitHub URL and email
    html = html
      .replace(/(https:\/\/github\.com\/[^<\s]+)/g, '<a class="about-link" href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi, '<a class="about-link" href="mailto:$1">$1</a>');

    openFullPanel("About this player", `<div class="about-text">${html}</div>`);
  }


  function openFormatPicker(mode = "player") {
    const s = state.settings;

    const currentValue =
      mode === "settings"
        ? s.defaultFormat
        : (state.preferredFormat || s.defaultFormat || "mp3");

    openSelect(
      mode === "settings" ? "Default format" : "Format",
      [
        { value: "mp3", label: "MP3 (recommended)" },
        { value: "wav", label: "WAV (highest quality)" }
      ],
      currentValue,
      (fmt) => {
        // Always apply immediately to the *current session* (player + preload)
        state.preferredFormat = fmt;

        // Only persist when changed from Settings
        if (mode === "settings") {
          s.defaultFormat = fmt;
          saveSettings();

          // Optional backwards-compat migration key:
          // keep it only for settings changes, never for player-only changes.
          setStorageJSON("yzk_format", fmt);
        }

        // If something is playing, switch source immediately at same time position
        if (state.currentSongId) {
          // If a crossfade is in progress, the "current" track is the fade-in deck.
          // We first commit the transition so format switching never targets the fade-out deck
          // (which caused random jumps / wrong track on format change).
          if (crossfade.active) {
            const wasAnyPlaying = (!masterAudio.paused) || (!preloadAudio.paused);
            // Commit without pausing so playback keeps going on the UI/incoming track.
            commitCrossfadeNow({ pause: false });
            // If both decks were paused (rare), preserve that.
            if (!wasAnyPlaying) {
              try { masterAudio.pause(); } catch {}
            }
          }

          const song = currentSong();
          const a = getControlAudio();
          const oldTime = a.currentTime || 0;
          const wasPlaying = !a.paused;

          const src =
            song?.formats?.[fmt] ||
            song?.formats?.mp3 ||
            song?.formats?.wav;

          if (!src) {
            toast("That format file is missing for this song.");
            return;
          }

          // Always apply to the current control deck (after commit, that's masterAudio).
          // Ensure mixer is ready so Safari/iOS can fade via WebAudio gains.
          ensurePlaybackPipeline();
          masterAudio.src = src;
          applyTapeSpeedMode?.();
          setTapeSpeed(masterAudio, state.speed);
          masterAudio.loop = (state.loop === "one");
          setDeckGain(masterAudio, 1);

          masterAudio.addEventListener("loadedmetadata", function once() {
            masterAudio.removeEventListener("loadedmetadata", once);
            masterAudio.currentTime = Math.min(oldTime, masterAudio.duration || oldTime);
            if (wasPlaying) masterAudio.play().catch(() => {});
          });
        }

        renderNowPlayingUI();
        preloadNextTrack?.();
        updateUpNextUI?.();

        toast(`${mode === "settings" ? "Default format" : "Format"}: ${fmt.toUpperCase()}`);

        // Refresh settings UI so the label updates
        if (mode === "settings") openSettings();
      }
    );
  }

  function applyViewAndPlaybackUpdate() {
    rebuildPlayList();
    renderList();
    preloadNextTrack?.();
    updateUpNextUI();
  }

  function resetSorting() {
    state.sortKey = "upload";
    state.sortInvert = false;
    state.likedOnly = false;

    applyViewAndPlaybackUpdate();
    toast("Sort reset");
  }

  let sortPanelHandler = null;

  function openSort() {
    const sortUploadActive = state.sortKey === "upload";
    const sortTitleActive = state.sortKey === "title";

    openPanel("Sort", `
      <div class="row" style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="pill ${sortUploadActive ? "is-active" : ""}" data-sort="upload">
          Upload
        </button>

        <button class="pill ${sortTitleActive ? "is-active" : ""}" data-sort="title">
          Title
        </button>
      </div>

      <div style="margin-top: 10px;">
        <div class="panel-row">
          <div class="panel-label">
            <div class="t1">Invert order</div>
            <div class="t2">Reverse the current sort</div>
          </div>
          <button class="toggle ${state.sortInvert ? "on" : ""}" data-toggle="invert" aria-label="Invert order"></button>
        </div>

        <div class="panel-row">
          <div class="panel-label">
            <div class="t1">Liked only</div>
            <div class="t2">Show favorites only</div>
          </div>
          <button class="toggle ${state.likedOnly ? "on" : ""}" data-toggle="liked" aria-label="Liked only"></button>
        </div>

        <button class="panel-reset" data-action="reset" type="button">Reset</button>
      </div>
    `);

    // Remove old handler if panel was opened before
    if (sortPanelHandler) {
      panelBody.removeEventListener("click", sortPanelHandler);
    }

    sortPanelHandler = (e) => {
      const sortBtn = e.target.closest("[data-sort]");
      if (sortBtn) {
        state.sortKey = sortBtn.dataset.sort;
        applyViewAndPlaybackUpdate();
        toast(`Sort: ${state.sortKey === "upload" ? "Upload" : "Title"}`);
        panelBody.querySelectorAll("[data-sort]").forEach(b => {
          b.classList.toggle("is-active", b.dataset.sort === state.sortKey);
        });
        return;
      }

      const tgl = e.target.closest("[data-toggle]");
      if (tgl) {
        const which = tgl.dataset.toggle;
        if (which === "invert") state.sortInvert = !state.sortInvert;
        if (which === "liked") state.likedOnly = !state.likedOnly;

        // update toggle UI in-place
        tgl.classList.toggle("on");

        applyViewAndPlaybackUpdate();
        return;
      }

      const act = e.target.closest("[data-action]");
      if (act?.dataset.action === "reset") {
        closePanel();
        resetSorting();
        return;
      }
    };

    panelBody.addEventListener("click", sortPanelHandler);

  }


  let settingsPanelHandler = null;

  function openSettings() {
    const s = state.settings;
    const speedLocked = !isDefaultSpeed();

    openFullPanel("Settings", `
      <div class="settings-section">
        <div class="settings-title">Appearance</div>

        <div class="panel-row compact">
          <div class="panel-label">
            <div class="t1">Theme mode</div>
            <div class="t2" id="themeModeVal">${s.themeMode === "dark" ? "Dark" : "Light"}</div>
          </div>
          <button class="toggle ${s.themeMode === "dark" ? "on" : ""}" data-setting="themeMode" aria-label="Theme mode"></button>
        </div>

        <div class="panel-row compact" style="align-items:flex-start;">
          <div class="panel-label">
            <div class="t1">Accent color</div>
            <div class="t2">Highlights & glow</div>
          </div>
        </div>

        <div class="accent-grid" role="group" aria-label="Accent color">
          <button class="accent-swatch ${s.accent === "purple" ? "active" : ""}" data-accent="purple" aria-label="Purple"></button>
          <button class="accent-swatch ${s.accent === "red" ? "active" : ""}" data-accent="red" aria-label="Red"></button>
          <button class="accent-swatch ${s.accent === "green" ? "active" : ""}" data-accent="green" aria-label="Green"></button>
          <button class="accent-swatch ${s.accent === "gold" ? "active" : ""}" data-accent="gold" aria-label="Gold"></button>
        </div>

        <div class="panel-row compact">
          <div class="panel-label">
            <div class="t1">Reduce motion</div>
            <div class="t2">Less animation</div>
          </div>
          <button class="toggle ${s.reduceMotion ? "on" : ""}" data-setting="reduceMotion" aria-label="Reduce motion"></button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-title">Playback</div>

        <div class="panel-row compact">
          <div class="panel-label">
            <div class="t1">Default format</div>
            <div class="t2">${s.defaultFormat.toUpperCase()}</div>
          </div>
          <button class="pill" data-action="formatPick" type="button">${s.defaultFormat.toUpperCase()}</button>
        </div>

        <div class="panel-row compact">
          <div class="panel-label">
            <div class="t1">Preload next track</div>
            <div class="t2">Smoother, uses more data</div>
          </div>
          <button class="toggle ${s.preloadEnabled ? "on" : ""}" data-setting="preloadEnabled" aria-label="Preload"></button>
        </div>

        <div class="panel-row compact">
          <div class="panel-label">
            <div class="t1">Show descriptions</div>
            <div class="t2">Inside the player</div>
          </div>
          <button class="toggle ${s.showDescriptions ? "on" : ""}" data-setting="showDescriptions" aria-label="Show descriptions"></button>
        </div>

        <div class="panel-row compact">
          <div class="panel-label">
            <div class="t1">Show “Up next”</div>
            <div class="t2">Upcoming track name</div>
          </div>
          <button class="toggle ${s.showUpNext ? "on" : ""}" data-setting="showUpNext" aria-label="Show up next"></button>
        </div>

        <div class="panel-row compact ${speedLocked ? "is-locked" : ""}" data-lock="crossfadeSpeed">
          <div class="panel-label">
            <div class="t1">Crossfade</div>
            <div class="t2" id="crossfadeStatus">${speedLocked ? "Unavailable (Speed active)" : (s.crossfadeEnabled ? `On • ${s.crossfadeSeconds}s` : "Off")}</div>
            <div class="t2 cf-warn">Crossfade isn't compatible with Speed effect</div>
          </div>
          <button class="toggle ${s.crossfadeEnabled ? "on" : ""} ${speedLocked ? "is-locked" : ""}" data-setting="crossfadeEnabled" aria-label="Crossfade" ${speedLocked ? 'aria-disabled="true"' : ""}></button>
        </div>

        <div class="slider-row" id="crossfadeRow" style="${(s.crossfadeEnabled && !speedLocked) ? "" : "display:none;"}">
          <div class="panel-label">
            <div class="t1">Crossfade duration</div>
            <div class="t2">3s to 12s</div>
          </div>
          <div class="slider-value" id="crossfadeVal">${s.crossfadeSeconds}s</div>
        </div>

        <input id="crossfadeSlider" class="seekbar settings-slider"
          type="range" min="3" max="12" step="1" value="${s.crossfadeSeconds}"
          style="${(s.crossfadeEnabled && !speedLocked) ? "" : "display:none;"}" />
      </div>

      <div class="settings-section">
        <div class="settings-title">Library</div>

        <button class="panel-reset" data-nav="artists" type="button">Artists</button>
        <button class="panel-reset" data-nav="songs" type="button">Songs & links</button>
      </div>

      <div class="settings-section">
        <div class="settings-title">Data</div>
        <button class="danger-btn" data-action="resetLikes" type="button">Reset liked songs</button>
      </div>

      <div class="settings-section">
        <div class="settings-title">About</div>
        <button class="panel-reset" data-nav="about" type="button">About this player</button>
      </div>
    `);

    // Crossfade is not compatible with Speed (tape) mode.
    // When Speed != 1x, we lock the Crossfade control and show a short explanation on tap.
    const lockRow = panelBody.querySelector('[data-lock="crossfadeSpeed"]');
    if (lockRow) {
      lockRow.addEventListener("click", (e) => {
        if (isDefaultSpeed()) return;
        e.preventDefault();
        e.stopPropagation();
        toast(crossfadeSpeedLockMessage());
      }, true);
    }

    syncCrossfadeLockUI();


    // Ensure the "Default format" pill is always clickable (no delegation edge cases)
    const formatBtn = panelBody.querySelector('[data-action="formatPick"]');
    if (formatBtn) {
      formatBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFormatPicker("settings");
      });
    }

    // Ensure "Reset liked songs" is always clickable (avoid any delegation/overlay quirks)
    const resetLikesBtn = panelBody.querySelector('[data-action="resetLikes"]');
    if (resetLikesBtn) {
      resetLikesBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        openConfirm({
          title: "Reset liked songs",
          message: "This will remove all your liked songs on this device. This can’t be undone.",
          confirmText: "Reset",
          cancelText: "Cancel",
          danger: true,
          onConfirm: () => {
            resetAllLikes();
            // Return user to Settings after action
            openSettings();
          },
          onCancel: () => {
            openSettings();
          }
        });
      });
    }


    // Ensure "About this player" is always clickable
    const aboutBtn = panelBody.querySelector('[data-nav="about"]');
    if (aboutBtn) {
      aboutBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openAboutPanel();
      });
    }

    // Ensure "Artists" is always clickable (avoids any delegation edge cases)
    const artistsBtn = panelBody.querySelector('[data-nav="artists"]');
    if (artistsBtn) {
      artistsBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openArtists();
      });
    }

    // Ensure "Songs & links" is always clickable (placeholder for later)
    const songsLinksBtn = panelBody.querySelector('[data-nav="songs"]');
    if (songsLinksBtn) {
      songsLinksBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSongsLinks();
      });
    }

    // remove old handler to avoid stacking
    if (settingsPanelHandler) panelBody.removeEventListener("click", settingsPanelHandler);

    settingsPanelHandler = (e) => {
      const tgl = e.target.closest("[data-setting]");
      if (tgl) {
        const key = tgl.dataset.setting;


        if (key === "crossfadeEnabled" && !isDefaultSpeed()) {
          toast(crossfadeSpeedLockMessage());
          return;
        }

        // compute the next value
        let nextValue;
        if (key === "themeMode") {
          nextValue = (s.themeMode === "dark") ? "light" : "dark";
        } else {
          nextValue = !Boolean(s[key]);
        }

        // update state
        s[key] = nextValue;

        // ✅ keep toggle UI correct (themeMode toggle should reflect dark=on)
        if (key === "themeMode") {
          tgl.classList.toggle("on", s.themeMode === "dark");
        } else {
          tgl.classList.toggle("on", Boolean(nextValue));
        }

        // ✅ save + apply immediately
        saveSettings();
        applySettingsToRuntime();

        const themeVal = panelBody.querySelector("#themeModeVal");
        if (themeVal && key === "themeMode") {
          themeVal.textContent = (s.themeMode === "dark") ? "Dark" : "Light";
        }

        // handle crossfade UI reveal
        if (key === "crossfadeEnabled") {
          const row = $("#crossfadeRow");
          const slider = $("#crossfadeSlider");
          const on = s.crossfadeEnabled;
          if (row) row.style.display = on ? "" : "none";
          if (slider) slider.style.display = on ? "" : "none";

          const st = panelBody.querySelector("#crossfadeStatus");
          if (st) st.textContent = on ? `On • ${s.crossfadeSeconds}s` : "Off";
        }

        // Respect Speed lock UI (greyed-out state)
        syncCrossfadeLockUI();

        // up next instantly hide/show
        updateUpNextUI?.();

        return;
      }

      const swatch = e.target.closest("[data-accent]");
      if (swatch) {
        s.accent = swatch.dataset.accent;
        panelBody.querySelectorAll("[data-accent]").forEach(el => el.classList.toggle("active", el.dataset.accent === s.accent));
        saveSettings();
        applySettingsToRuntime();
        return;
      }

      const act = e.target.closest("[data-action]");
      if (act?.dataset.action === "formatPick") {
        openFormatPicker("settings");
        return;
      }

      if (act?.dataset.action === "resetLikes") {
        // UI only for now: we’ll add confirmation + logic next
        toast("Reset likes (next)");
        return;
      }

      const nav = e.target.closest("[data-nav]");
      if (nav) {
        const where = nav.dataset.nav;
        if (where === "artists") { openArtists(); return; }
        if (where === "songs") { openSongsLinks(); return; }
        if (where === "about") { openAboutPanel(); return; }
        return;
      }
    };

    panelBody.addEventListener("click", settingsPanelHandler);

    // slider binding (inside openSettings because elements exist now)
    const slider = $("#crossfadeSlider");
    if (slider) {
      slider.addEventListener("input", () => {
      s.crossfadeSeconds = Number(slider.value);
      const v = $("#crossfadeVal");
      if (v) v.textContent = `${s.crossfadeSeconds}s`;
      const st = panelBody.querySelector("#crossfadeStatus");
      if (st) st.textContent = s.crossfadeEnabled ? `On • ${s.crossfadeSeconds}s` : "Off";
      saveSettings();
      // applySettingsToRuntime(); // optional for later when crossfade is implemented
    });
    }
  }

  btnFormat.addEventListener("click", () => openFormatPicker("player"));

  /** -------------------------
   *  Swipe
   *  ------------------------- */
  function attachSwipeHandlers() {
    $$(".song-card").forEach(card => {
      const inner = $(".card-inner", card);
      if (!inner) return;

      let startX = 0;
      let startY = 0;
      let curX = 0;

      let dragging = false;
      let gesture = null; // null | "scroll" | "swipe"

      const threshold = 70;   // action trigger
      const maxSlide = 95;    // visual cap
      const lockDistance = 10; // how far before we decide scroll vs swipe

      const onStart = (e) => {
        if (!e.touches || e.touches.length !== 1) return;

        dragging = true;
        gesture = null;
        curX = 0;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;

        inner.style.transition = "none";
      };

      const onMove = (e) => {
        if (!dragging) return;

        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;

        const dx = x - startX;
        const dy = y - startY;

        // Decide gesture direction once user moved enough
        if (!gesture) {
          if (Math.abs(dx) < lockDistance && Math.abs(dy) < lockDistance) {
            return; // not enough movement yet
          }

          // lock to whichever axis dominates
          gesture = (Math.abs(dx) > Math.abs(dy)) ? "swipe" : "scroll";
        }

        // If it's scrolling, do nothing (let the page scroll naturally)
        if (gesture === "scroll") {
          inner.style.transform = "translateX(0px)";
          return;
        }

        // It's a swipe: block scroll and translate card
        e.preventDefault();

        curX = dx;
        const slide = clamp(curX, -maxSlide, maxSlide);
        inner.style.transform = `translateX(${slide}px)`;
      };

      const onEnd = () => {
        if (!dragging) return;
        dragging = false;

        // If the user was scrolling, never trigger actions
        if (gesture !== "swipe") {
          inner.style.transition = "transform .18s ease";
          inner.style.transform = "translateX(0px)";
          return;
        }

        inner.style.transition = "transform .18s ease";
        inner.style.transform = "translateX(0px)";

        const songId = card.dataset.songId;
        if (curX > threshold) {
          queueSong(songId);
        } else if (curX < -threshold) {
          setLiked(songId, !isLiked(songId));
        }
      };

      // Important: passive must be false if we call preventDefault in touchmove.
      card.addEventListener("touchstart", onStart, { passive: true });
      card.addEventListener("touchmove", onMove, { passive: false });
      card.addEventListener("touchend", onEnd, { passive: true });
      card.addEventListener("touchcancel", onEnd, { passive: true });
    });
  }

  /** -------------------------
   *  Toast
   *  ------------------------- */
  let toastTimer = null;
  function toast(msg) {
    const elId = "yzkToast";
    let el = document.getElementById(elId);
    if (!el) {
      el = document.createElement("div");
      el.id = elId;
      el.style.position = "fixed";
      el.style.left = "50%";
      el.style.bottom = "110px";
      el.style.transform = "translateX(-50%)";
      el.style.zIndex = "999";
      el.style.padding = "10px 12px";
      el.style.borderRadius = "14px";
      el.style.border = "1px solid rgba(255,255,255,.10)";
      el.style.background = "rgba(15,15,27,.92)";
      el.style.backdropFilter = "blur(10px)";
      el.style.boxShadow = "0 10px 30px rgba(0,0,0,.45)";
      el.style.color = "rgba(255,255,255,.9)";
      el.style.fontWeight = "800";
      el.style.fontSize = "12px";
      el.style.opacity = "0";
      el.style.transition = "opacity .18s ease, transform .18s ease";
      el.style.pointerEvents = "none";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.transform = "translateX(-50%) translateY(0px)";

    clearTimeout(toastTimer);

    el.style.display = "block";
    el.style.opacity = "1";

    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => {
        el.style.display = "none"; // ✅ removes hitbox completely
      }, 180);
    }, 1200);
  }

  /** -------------------------
   *  Init
   *  ------------------------- */
  async function init() {
    applySettingsToRuntime();

    renderSkeletonList(10);
    try {
      await loadSongs();
    } catch (e) {
      console.error(e);
      toast("Failed to load songs index.");
      if (!songs || songs.length === 0) {
        songListEl.innerHTML = `
          <div class="queue-empty">
            Couldn’t load songs. Please check your connection and reload.
          </div>
        `;
        return;
      }
    }

    applyTapeSpeedMode();
    wireTapeSpeedGuards();
    rebuildPlayList();
    renderList();
    renderNowPlayingUI();
    setSeekVisualFromValue();
    setPlayIcons(false);

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        state.searchQuery = searchInput.value || "";
        searchClear.hidden = !searchInput.value;

        applyViewAndPlaybackUpdate();
      });
    }

    if (searchClear) {
      searchClear.addEventListener("click", () => {
        searchInput.value = "";
        state.searchQuery = "";
        searchClear.hidden = true;

        applyViewAndPlaybackUpdate();
        searchInput.focus();
      });
    }

    miniPlayer.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openSheet();
    });
  }

  init();
})();