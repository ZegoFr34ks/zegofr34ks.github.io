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

  function normText(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s+/g, "")        // remove spaces
      .replace(/[^\p{L}\p{N}]/gu, ""); // remove symbols (unicode-safe)
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
    localStorage.setItem(key, JSON.stringify(value));
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

    // Theme + accent + motion
    document.documentElement.dataset.theme = s.themeMode;
    document.documentElement.dataset.accent = s.accent;
    document.documentElement.dataset.reducemotion = s.reduceMotion ? "1" : "0";
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

  /** -------------------------
   *  State
   *  ------------------------- */
  let songs = []; // will be loaded from index.json/meta.json
  const audio = $("#audio");
  const audioPreload = $("#audioPreload");

  // Audio deck routing
  // - masterAudio: the element considered "current" for playback/navigation
  // - preloadAudio: the element used for preloading (and becomes the fade-in deck during crossfade)
  let masterAudio = audio;
  let preloadAudio = audioPreload;

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

  function getUIAudio() {
    // During crossfade, UI (timeline) should follow the incoming deck (Spotify-like).
    return crossfade?.active ? preloadAudio : masterAudio;
  }

  function getControlAudio() {
    // Playback controls should operate on the track that is "current" in the UI.
    return getUIAudio();
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

  // Apply theme tokens ASAP (so refresh doesn't flash/keep old look)
  document.documentElement.dataset.theme = state.settings.themeMode;
  document.documentElement.dataset.accent = state.settings.accent;
  document.documentElement.dataset.reducemotion = state.settings.reduceMotion ? "1" : "0";


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
  const btnSheetClose = $("#btnSheetClose");

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
  const btnInfo = $("#btnInfo");

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

    if (!songs.length) toast("No songs found. Check assets/songs/catalog.json");
  }

  /** -------------------------
   *  Render
   *  ------------------------- */
  function getSongById(id) {
    return songs.find(s => s.id === id) || null;
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
              <svg viewBox="0 0 24 24"><path d="M12 21s-7-4.35-9.5-8.5C.68 9.01 2.4 6 5.7 6c1.86 0 3.06 1.02 3.8 2.02C10.24 7.02 11.44 6 13.3 6c3.3 0 5.02 3.01 3.2 6.5C19 16.65 12 21 12 21z"/></svg>
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
                <svg viewBox="0 0 24 24"><path d="M12 21s-7-4.35-9.5-8.5C.68 9.01 2.4 6 5.7 6c1.86 0 3.06 1.02 3.8 2.02C10.24 7.02 11.44 6 13.3 6c3.3 0 5.02 3.01 3.2 6.5C19 16.65 12 21 12 21z"/></svg>
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
    if (state.settings?.showDescriptions) {
      sheetDesc.style.display = "";
      if (sheetDesc) {
        if (state.settings?.showDescriptions) {
          sheetDesc.style.display = "";
          sheetDesc.textContent = song.description || "—";
        } else {
          sheetDesc.style.display = "none";
        }
      }
    } else {
      sheetDesc.style.display = "none";
    }

    miniLike.classList.toggle("like-on", isLiked(song.id));
    sheetLike.classList.toggle("like-on", isLiked(song.id));

    btnShuffle.style.boxShadow = state.shuffle ? "var(--glow)" : "";
    btnShuffle.classList.toggle("is-on", state.shuffle);

    btnLoop.style.boxShadow = state.loop !== "off" ? "var(--glow)" : "";
    btnLoop.classList.toggle("is-on", state.loop !== "off");

    btnSpeed.textContent = `${state.speed.toFixed(2).replace(/\.00$/, "")}×`;
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
    try { masterAudio.volume = 1; } catch {}
    try { preloadAudio.volume = 1; } catch {}
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
    try { outgoing.volume = 1; } catch {}
    try { incoming.volume = 1; } catch {}

    // Swap roles: incoming becomes master.
    masterAudio = incoming;
    preloadAudio = outgoing;

    // Ensure master has correct runtime properties.
    try {
      applyTapeSpeedMode?.();
      masterAudio.playbackRate = state.speed;
      masterAudio.loop = (state.loop === "one");
    } catch {}

    // Ensure the preload deck is idle/clean for future loads.
    try {
      preloadAudio.pause();
      preloadAudio.volume = 1;
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
      applyTapeSpeedMode?.();
      incomingEl.pause();
      incomingEl.volume = 0;
      incomingEl.loop = false;
      incomingEl.playbackRate = state.speed;
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
      try { masterAudio.volume = 1 - t; } catch {}
      try { preloadAudio.volume = t; } catch {}

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
      try { outgoing.volume = 1; } catch {}
      try { incoming.volume = 1; } catch {}

      // Swap roles: incoming becomes master, old master becomes the preload deck
      masterAudio = incoming;
      preloadAudio = outgoing;

      // Ensure master has the correct runtime properties
      try {
        applyTapeSpeedMode?.();
        masterAudio.playbackRate = state.speed;
        masterAudio.loop = (state.loop === "one");
      } catch {}

      // Leave the preload deck in a clean state for the next preload
      try {
        preloadAudio.pause();
        preloadAudio.volume = 1;
      } catch {}

      // Preload the next-up track for the *new* now-playing
      preloadNextTrack();
      updateUpNextUI();
    };

    crossfade.raf = requestAnimationFrame(tick);
  }

  function maybeStartCrossfade() {
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
    masterAudio.playbackRate = state.speed;
    masterAudio.loop = (state.loop === "one");

    // Keep preload deck idle when switching manually
    try {
      preloadAudio.pause();
      preloadAudio.volume = 1;
    } catch {}

    renderList();
    renderNowPlayingUI();
    preloadNextTrack();
    updateUpNextUI();

    if (autoplay) masterAudio.play().catch(() => {});
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
      if (!isAnyPlaying) masterAudio.play().catch(() => {});
      return;
    }

    const a = getControlAudio();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
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

  miniPlayer.addEventListener("click", (e) => {
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
      applyTapeSpeedMode?.();
      // Apply speed to both decks (order matters if decks swapped).
      try { masterAudio.playbackRate = state.speed; } catch {}
      try { preloadAudio.playbackRate = state.speed; } catch {}
      renderNowPlayingUI();
      toast(`Speed: ${state.speed}×`);
    });
  });

  sheetLike.addEventListener("click", () => {
    if (!state.currentSongId) return;
    setLiked(state.currentSongId, !isLiked(state.currentSongId));
  });

  // stubs for later
  $("#sheetTitle").addEventListener("click", () => toast("Song widget (next)"));
  $("#sheetArtist").addEventListener("click", () => toast("Artist widget (next)"));
  btnInfo.addEventListener("click", () => toast("Info tab (next)"));
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
    isSeeking = false;
  });

  /** -------------------------
   *  Audio events
   *  ------------------------- */
  function updatePlayIconsFromDecks() {
    const playing = (!masterAudio.paused) || (!preloadAudio.paused);
    setPlayIcons(playing);
  }

  [audio, audioPreload].forEach((el) => {
    if (!el) return;
    el.addEventListener("play", updatePlayIconsFromDecks);
    el.addEventListener("pause", updatePlayIconsFromDecks);
  });

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
This player is still in Beta so some things are still in development.

If you find any bugs please report them, thank you.


About:

This Player is a new, overhauled version of the old one.
New features include: Customization, Sorting/Filtering, Queuing, Liking, Crossfade, Looping, Formatting, Preload, and more...
Did you know you can swipe a song card to either queue or like them? Swipe -> queue | <- like


Coming Soon:

- Artist Page
- Song Page
- Clickable Title
- Clickable Artists
- Info Card for a Song
- Minor Design Overhaul


Known Bugs:

- Multiple Icons deformed
- Header disappearing after 100vh


LP3 Version: 011020260901 

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
          // Format switches mid-crossfade can desync decks; just abort transition.
          cancelCrossfade();

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

          masterAudio.src = src;
          applyTapeSpeedMode?.();
          masterAudio.playbackRate = state.speed;
          masterAudio.loop = (state.loop === "one");

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

        <div class="panel-row compact">
          <div class="panel-label">
            <div class="t1">Crossfade</div>
            <div class="t2" id="crossfadeStatus">${s.crossfadeEnabled ? `On • ${s.crossfadeSeconds}s` : "Off"}</div>
          </div>
          <button class="toggle ${s.crossfadeEnabled ? "on" : ""}" data-setting="crossfadeEnabled" aria-label="Crossfade"></button>
        </div>

        <div class="slider-row" id="crossfadeRow" style="${s.crossfadeEnabled ? "" : "display:none;"}">
          <div class="panel-label">
            <div class="t1">Crossfade duration</div>
            <div class="t2">3s to 12s</div>
          </div>
          <div class="slider-value" id="crossfadeVal">${s.crossfadeSeconds}s</div>
        </div>

        <input id="crossfadeSlider" class="seekbar settings-slider"
          type="range" min="3" max="12" step="1" value="${s.crossfadeSeconds}"
          style="${s.crossfadeEnabled ? "" : "display:none;"}" />
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

    // remove old handler to avoid stacking
    if (settingsPanelHandler) panelBody.removeEventListener("click", settingsPanelHandler);

    settingsPanelHandler = (e) => {
      const tgl = e.target.closest("[data-setting]");
      if (tgl) {
        const key = tgl.dataset.setting;

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
        if (where === "artists") toast("Artists panel (next)");
        if (where === "songs") toast("Songs & links (next)");
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
    rebuildPlayList();
    renderList();
    renderNowPlayingUI();
    setSeekVisualFromValue();
    setPlayIcons(false);

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        state.searchQuery = searchInput.value || "";
        searchClear.hidden = !searchInput.value;

        rebuildPlayList();
        renderList();
        preloadNextTrack?.();
        updateUpNextUI();
      });
    }

    if (searchClear) {
      searchClear.addEventListener("click", () => {
        searchInput.value = "";
        state.searchQuery = "";
        searchClear.hidden = true;

        rebuildPlayList();
        renderList();
        preloadNextTrack?.();
        updateUpNextUI();
        searchInput.focus();
      });
    }

    miniPlayer.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openSheet();
    });
  }

  init();
})();
