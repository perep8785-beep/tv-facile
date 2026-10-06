/* TV FACILE: plays every new episode one after the other, inside set hours,
 * for someone who cannot see the screen well.
 *
 * - "LANCER LA TÉLÉ" plays the unwatched episodes channel by channel.
 *   An episode that has not been uploaded yet (data.json still shows
 *   yesterday's, already watched) is skipped and played once it appears.
 * - Outside the viewing hours it pauses and resumes by itself.
 * - The whole TV screen is one big button: two taps = pause / play,
 *   long press = "what am I watching". The screen turns black after a while
 *   but playback goes on.
 * - When everything is watched and a new episode arrives, it rings and
 *   says which one, for a few minutes, until "arrête" or "joue".
 * - Snap your fingers, then speak a command (voice.js).
 */
(function () {
  "use strict";

  const KEYS = {
    settings: "tvf-settings-v1",
    watched: "tvf-watched-v1",
    positions: "tvf-positions-v1",
    failed: "tvf-failed-v1",
    known: "tvf-known-v1",
    armed: "tvf-armed-v1",
    data: "tvf-data-v2"
  };

  const CHANNELS = [
    { section: "EQUINOXE TV", label: "ÉQUINOXE", spoken: "Équinoxe Télé" },
    { section: "CANAL 2", label: "CANAL 2", spoken: "Canal 2" },
    { section: "INFO TV", label: "INFO TV", spoken: "Info Télé" },
    { section: "VISION 4", label: "VISION 4", spoken: "Vision 4" }
  ];

  const DEFAULT_SETTINGS = {
    morningStart: "08:00",
    morningEnd: "14:00",
    eveningStart: "18:00",
    eveningEnd: "23:59",
    announce: true,
    blackAfter: 30,
    alertMinutes: 3,
    autoPlayNew: false,
    voice: true,
    trigger: "single",
    sensitivity: "medium",
    engine: "vosk",
    aec: false,
    disabledShows: []
  };

  const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  const DATA_REFRESH_MS = 5 * 60 * 1000;
  const FAIL_RETRY_MS = 30 * 60 * 1000;

  // ============================================================
  // SMALL HELPERS
  // ============================================================

  const $ = (id) => document.getElementById(id);

  const store = {
    get(key, fallback) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        return value === null ? fallback : value;
      } catch (error) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        // Private mode or full storage: the app still works for this visit.
      }
    }
  };

  // The debug clock lets tests jump to 14:00 or 18:00.
  let clockOffset = 0;
  const now = () => new Date(Date.now() + clockOffset);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isoDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function daysBetween(fromIso, toIso) {
    return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400000);
  }

  function minutesOf(hhmm) {
    const [h, m] = String(hhmm || "0:0").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function spokenTime(date) {
    const h = date.getHours();
    const m = date.getMinutes();
    if (h === 0 && m === 0) return "minuit";
    if (h === 12 && m === 0) return "midi";
    return `${h} heure${h > 1 ? "s" : ""}${m ? " " + m : ""}`;
  }

  function spokenClock(hhmm) {
    const minutes = minutesOf(hhmm);
    const d = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
    return spokenTime(d);
  }

  function spokenDate(date) {
    return date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  }

  function channelOf(section) {
    return CHANNELS.find((c) => c.section === section) || { section, label: section, spoken: section };
  }

  // ============================================================
  // SETTINGS AND PERSISTED STATE
  // ============================================================

  let settings = Object.assign({}, DEFAULT_SETTINGS, store.get(KEYS.settings, {}));

  function saveSettings() {
    store.set(KEYS.settings, settings);
  }

  const watched = store.get(KEYS.watched, {});
  const positions = store.get(KEYS.positions, {});
  const failed = store.get(KEYS.failed, {});

  (function prune() {
    const cutoff = Date.now() - 21 * 86400000;
    for (const id of Object.keys(watched)) if (watched[id] < cutoff) delete watched[id];
    for (const id of Object.keys(failed)) if (failed[id] < Date.now()) delete failed[id];
  })();

  function markWatched(id) {
    watched[id] = Date.now();
    delete positions[id];
    store.set(KEYS.watched, watched);
    store.set(KEYS.positions, positions);
  }

  function markFailed(id, permanent) {
    failed[id] = permanent ? Date.now() + 7 * 86400000 : Date.now() + FAIL_RETRY_MS;
    store.set(KEYS.failed, failed);
  }

  // ============================================================
  // DATA
  // ============================================================

  let data = { shows: [] };

  // Accepts the current data.json and the older single-video format.
  function normalizeShow(show) {
    const parts = Array.isArray(show.parts) && show.parts.length
      ? show.parts
      : show.found && show.videoId
        ? [{ videoId: show.videoId, title: show.videoTitle || "", durationSec: 0, publishedAt: show.publishedAt || "" }]
        : [];
    const published = show.publishedAt ? new Date(show.publishedAt) : null;
    return Object.assign({}, show, {
      section: show.section === "CANAL 2" && show.id === "clubelites" ? "VISION 4" : show.section,
      spoken: show.spoken || String(show.label || "").toLowerCase(),
      freq: show.freq || (["droitreponse", "pidgindebate", "canalpress", "clubelites"].includes(show.id) ? "weekly" : "daily"),
      episodeDate: show.episodeDate || (published && !isNaN(published) ? isoDate(published) : ""),
      parts: parts.filter((p) => /^[A-Za-z0-9_-]{11}$/.test(p.videoId || ""))
    });
  }

  function acceptData(value) {
    if (!value || !Array.isArray(value.shows) || !value.shows.length) return false;
    data = Object.assign({}, value, { shows: value.shows.map(normalizeShow) });
    return true;
  }

  async function fetchData() {
    try {
      const response = await fetch("./data.json?v=" + Date.now(), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const fresh = await response.json();
      if (!acceptData(fresh)) throw new Error("data.json invalide");
      store.set(KEYS.data, fresh);
      return true;
    } catch (error) {
      if (!data.shows.length) acceptData(store.get(KEYS.data, null));
      return false;
    }
  }

  function ageInDays(show) {
    if (!show.episodeDate) return Infinity;
    return daysBetween(show.episodeDate, isoDate(now()));
  }

  // Daily shows: today's or yesterday's episode. Weekly shows: the last 7 days.
  function isFresh(show) {
    const age = ageInDays(show);
    return age >= -1 && age <= (show.freq === "weekly" ? 7 : 1);
  }

  function orderedShows() {
    const rank = (section) => {
      const index = CHANNELS.findIndex((c) => c.section === section);
      return index < 0 ? 99 : index;
    };
    return data.shows
      .map((show, index) => ({ show, index }))
      .sort((a, b) => rank(a.show.section) - rank(b.show.section) || a.index - b.index)
      .map((entry) => entry.show);
  }

  function itemsOf(show) {
    return show.parts.map((part, index) => ({ show, part, index, id: part.videoId }));
  }

  // Everything that would be played today, watched or not.
  function playlist() {
    return orderedShows()
      .filter((show) => show.found && isFresh(show) && !settings.disabledShows.includes(show.id))
      .flatMap(itemsOf);
  }

  function isPending(item) {
    return !watched[item.id] && !(failed[item.id] > Date.now());
  }

  function pending() {
    return playlist().filter(isPending);
  }

  function pendingShowsCount(items) {
    return new Set(items.map((i) => i.show.id)).size;
  }

  // ============================================================
  // SOUND: tones and speech
  // ============================================================

  let audioCtx = null;
  let master = null;

  function audio() {
    if (!audioCtx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return null;
      audioCtx = new Context();
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.ratio.value = 8;
      master = audioCtx.createGain();
      master.gain.value = 1.4;
      master.connect(compressor).connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function bell(freq, start, length, gain) {
    const ctx = audio();
    if (!ctx) return;
    [[1, "triangle", 1], [2.76, "sine", 0.35], [1.0, "square", 0.08]].forEach(([ratio, type, level]) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq * ratio;
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(gain * level, start + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(env).connect(master);
      osc.start(start);
      osc.stop(start + length + 0.05);
    });
  }

  // Loud three-times ding-dong, about 2.6 s.
  function ringAlarm() {
    const ctx = audio();
    if (!ctx) return wait(2600);
    const t = ctx.currentTime + 0.05;
    for (let i = 0; i < 3; i++) {
      bell(1318, t + i * 0.85, 0.5, 0.9);
      bell(988, t + i * 0.85 + 0.38, 0.6, 0.9);
    }
    return wait(2700);
  }

  function chime() {
    const ctx = audio();
    if (!ctx) return wait(800);
    const t = ctx.currentTime + 0.03;
    bell(988, t, 0.45, 0.7);
    bell(1318, t + 0.3, 0.6, 0.7);
    return wait(900);
  }

  function beep(kind) {
    const ctx = audio();
    if (!ctx) return wait(300);
    const t = ctx.currentTime + 0.02;
    const notes = {
      listen: [[880, 0], [1320, 0.13]],
      fail: [[660, 0], [440, 0.16]],
      ok: [[1175, 0]],
      pause: [[784, 0], [523, 0.12]],
      play: [[523, 0], [784, 0.12]]
    }[kind] || [[880, 0]];
    notes.forEach(([freq, offset]) => bell(freq, t + offset, 0.22, 0.6));
    return wait(notes[notes.length - 1][1] * 1000 + 260);
  }

  let frenchVoice = null;
  let speaking = 0;

  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const voices = window.speechSynthesis.getVoices();
    frenchVoice =
      voices.find((v) => v.lang === "fr-FR" && v.localService) ||
      voices.find((v) => v.lang === "fr-FR") ||
      voices.find((v) => /^fr/i.test(v.lang)) ||
      null;
  }

  if ("speechSynthesis" in window) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }

  // Speaks in French, lowering the video while it talks. Always resolves,
  // even when the phone has no speech engine.
  function speak(text) {
    $("live").textContent = text;
    return new Promise((resolve) => {
      if (!text || !("speechSynthesis" in window)) {
        resolve();
        return;
      }
      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "fr-FR";
      if (frenchVoice) utterance.voice = frenchVoice;
      utterance.rate = 0.92;
      utterance.volume = 1;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        speaking = Math.max(0, speaking - 1);
        if (!speaking) {
          Player.duck(false);
          if (window.TVVoice) TVVoice.mute(false);
        }
        resolve();
      };
      const timer = setTimeout(finish, 3000 + text.length * 110);
      utterance.onend = finish;
      utterance.onerror = finish;

      speaking++;
      Player.duck(true);
      if (window.TVVoice) TVVoice.mute(true);
      // Android drops an utterance queued right after cancel(), so only
      // cancel when something is actually talking, then wait a moment.
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(() => synth.speak(utterance), 120);
      } else {
        synth.speak(utterance);
      }
    });
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (error) {
      // Not supported.
    }
  }

  let flashTimer = 0;
  function flash(icon) {
    const el = $("flash");
    el.querySelector("use").setAttribute("href", "#i-" + icon);
    el.classList.add("show");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove("show"), 900);
  }

  // ============================================================
  // YOUTUBE PLAYER
  // ============================================================

  const Player = {
    yt: null,
    ready: false,
    loading: false,
    state: YT_STATE.UNSTARTED,
    queued: null,
    loadedId: "",
    volume: 100,
    ducked: false,

    init() {
      if (this.yt || this.loading) return;
      this.loading = true;
      window.onYouTubeIframeAPIReady = () => this.create();
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => {
        this.loading = false;
        setTimeout(() => this.init(), 30000);
      };
      document.head.appendChild(script);
    },

    create() {
      this.yt = new YT.Player("ytplayer", {
        host: "https://www.youtube-nocookie.com",
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          playsinline: 1,
          rel: 0,
          hl: "fr",
          origin: location.origin
        },
        events: {
          onReady: () => {
            this.ready = true;
            this.applyVolume();
            if (this.queued) {
              const { id, start } = this.queued;
              this.queued = null;
              this.load(id, start);
            }
          },
          onStateChange: (event) => {
            this.state = event.data;
            onPlayerState(event.data);
          },
          onError: (event) => onPlayerError(event.data)
        }
      });
    },

    load(id, start) {
      this.loadedId = id;
      if (!this.ready) {
        this.queued = { id, start };
        this.init();
        return;
      }
      this.state = YT_STATE.UNSTARTED;
      this.yt.loadVideoById({ videoId: id, startSeconds: Math.max(0, Math.floor(start || 0)) });
      this.yt.unMute();
      this.applyVolume();
    },

    call(method, ...args) {
      if (!this.ready) return undefined;
      try {
        return this.yt[method](...args);
      } catch (error) {
        return undefined;
      }
    },

    play() { this.call("playVideo"); },
    pause() { this.call("pauseVideo"); },
    stop() { this.call("stopVideo"); },
    seek(seconds) { this.call("seekTo", Math.max(0, seconds), true); },
    time() { return Number(this.call("getCurrentTime")) || 0; },
    duration() { return Number(this.call("getDuration")) || 0; },

    duck(on) {
      this.ducked = on;
      this.applyVolume();
    },

    applyVolume() {
      this.call("setVolume", this.ducked ? Math.min(6, this.volume) : this.volume);
    }
  };

  // ============================================================
  // ENGINE STATE
  // ============================================================

  const S = {
    screen: "home",
    armed: false,
    current: null,
    status: "idle", // idle | loading | playing | paused | waiting (autoplay blocked)
    pause: null, // null | "user" | "schedule" | "system"
    pausedAt: 0,
    waitConfirm: false,
    manual: false,
    alert: null,
    listening: false,
    dark: false,
    lastTouch: Date.now(),
    loadStartedAt: 0,
    bufferingSince: 0,
    expectPauseUntil: 0,
    failStreak: 0,
    backoffUntil: 0,
    playToken: 0,
    wasInside: null,
    lastPositionSave: 0
  };

  function windows() {
    const end = (hhmm) => (hhmm === "23:59" ? 1440 : minutesOf(hhmm));
    return [
      { start: minutesOf(settings.morningStart), end: end(settings.morningEnd), label: settings.morningStart },
      { start: minutesOf(settings.eveningStart), end: end(settings.eveningEnd), label: settings.eveningStart }
    ].filter((w) => w.end > w.start);
  }

  function inWindow(date) {
    const d = date || now();
    const minute = d.getHours() * 60 + d.getMinutes();
    return windows().some((w) => minute >= w.start && minute < w.end);
  }

  function nextWindowStart(date) {
    const d = date || now();
    const minute = d.getHours() * 60 + d.getMinutes();
    const list = windows().sort((a, b) => a.start - b.start);
    const today = list.find((w) => w.start > minute);
    return today ? today.label : list.length ? list[0].label : "08:00";
  }

  // Between the morning and evening slots the phone stays awake so the
  // evening can start on its own; after the evening it may sleep.
  function isNight(date) {
    const d = date || now();
    const minute = d.getHours() * 60 + d.getMinutes();
    const list = windows().sort((a, b) => a.start - b.start);
    if (!list.length) return false;
    return minute < list[0].start || minute >= list[list.length - 1].end;
  }

  function canAutoPlay() {
    return (
      S.armed &&
      (inWindow() || S.manual) &&
      !S.pause &&
      !S.alert &&
      !S.waitConfirm &&
      Date.now() >= S.backoffUntil
    );
  }

  // ============================================================
  // PLAYBACK
  // ============================================================

  function introFor(item) {
    const show = item.show;
    if (item.index > 0) return "La suite.";
    const channel = channelOf(show.section).spoken;
    const age = ageInDays(show);
    let when = "";
    if (age === 1) when = " Émission d'hier.";
    else if (age > 1 && show.episodeDate) when = " Émission du " + spokenDate(new Date(show.episodeDate + "T12:00:00")) + ".";
    return `${channel}. ${show.spoken}.${when}`;
  }

  async function playItem(item, options) {
    const token = ++S.playToken;
    S.current = item;
    S.status = "loading";
    S.pause = null;
    S.loadStartedAt = Date.now();
    S.blockedPrompted = false;
    updateMediaSession();
    render();

    if (settings.announce && !(options && options.silent)) {
      await speak(introFor(item));
      if (token !== S.playToken || S.pause) return;
    }
    S.loadStartedAt = Date.now();
    Player.load(item.id, positions[item.id] || 0);
  }

  function playNext() {
    const queue = pending();
    if (!queue.length) {
      finishAll();
      return;
    }
    playItem(queue[0]);
  }

  function finishAll() {
    const hadSomething = Boolean(S.current) || S.status !== "idle";
    S.current = null;
    S.status = "idle";
    S.waitConfirm = true;
    S.manual = false;
    Player.stop();
    updateMediaSession();
    render();
    if (hadSomething || !S.finishedSaid) {
      S.finishedSaid = true;
      speak("C'est tout pour le moment. Je vous préviens dès qu'une nouvelle émission arrive.");
    }
  }

  function pauseCurrent(reason) {
    S.pause = reason;
    S.pausedAt = Date.now();
    S.expectPauseUntil = Date.now() + 4000;
    savePosition(true);
    if (S.current) S.status = "paused";
    S.playToken++;
    Player.pause();
    render();
  }

  function resumeCurrent() {
    if (!S.current) return;
    S.pause = null;
    S.status = "loading";
    S.loadStartedAt = Date.now();
    // After a long break YouTube's stream may have expired: reload at the
    // saved position instead of just pressing play.
    // Also reload when it was paused during the spoken intro, before the
    // video itself was loaded (the player still holds the previous one).
    if (
      Player.loadedId !== S.current.id ||
      Date.now() - S.pausedAt > 20 * 60 * 1000 ||
      Player.state === YT_STATE.UNSTARTED
    ) {
      Player.load(S.current.id, positions[S.current.id] || 0);
    } else {
      Player.play();
    }
    render();
  }

  function savePosition(force) {
    if (!S.current || S.status !== "playing") return;
    if (!force && Date.now() - S.lastPositionSave < 5000) return;
    S.lastPositionSave = Date.now();
    const time = Player.time();
    const duration = Player.duration();
    if (time > 15 && (!duration || time < duration - 20)) {
      positions[S.current.id] = Math.floor(time - 3);
      store.set(KEYS.positions, positions);
    }
  }

  function onPlayerState(state) {
    if (state === YT_STATE.PLAYING) {
      if (S.pause === "user" || S.pause === "schedule") {
        // Something outside the app pressed play (lock screen, headset).
        if (!inWindow() && S.pause === "schedule") {
          S.expectPauseUntil = Date.now() + 4000;
          Player.pause();
          return;
        }
      }
      S.status = "playing";
      S.pause = null;
      S.failStreak = 0;
      S.loadStartedAt = 0;
      S.bufferingSince = 0;
      $("tapBox").classList.add("hidden");
    } else if (state === YT_STATE.PAUSED) {
      if (S.status === "loading" && Date.now() > S.expectPauseUntil) {
        // Paused while starting: autoplay was refused. The watchdog asks for
        // a double tap.
      } else if (Date.now() <= S.expectPauseUntil) {
        S.status = S.current ? "paused" : "idle";
      } else if (document.hidden) {
        // Screen turned off and the browser paused the video. Try once to
        // carry on in the background; otherwise resume when it comes back.
        S.status = "paused";
        S.pause = "system";
        S.pausedAt = Date.now();
        setTimeout(() => {
          if (S.pause === "system") Player.play();
        }, 900);
      } else {
        // Paused from the lock screen, a headset, a phone call...
        S.status = "paused";
        S.pause = "user";
        S.pausedAt = Date.now();
      }
    } else if (state === YT_STATE.ENDED) {
      onEnded();
      return;
    } else if (state === YT_STATE.BUFFERING) {
      if (!S.bufferingSince) S.bufferingSince = Date.now();
    }
    if (state !== YT_STATE.BUFFERING) S.bufferingSince = 0;
    updateMediaSession();
    render();
  }

  function onEnded() {
    const item = S.current;
    if (!item) return;
    markWatched(item.id);
    S.current = null;
    S.status = "idle";
    updateMediaSession();
    if (S.manual && !inWindow()) {
      S.manual = false;
      const queue = pending();
      speak(queue.length
        ? "Fin de l'émission. La suite reprendra à " + spokenClock(nextWindowStart()) + "."
        : "Fin de l'émission.");
      render();
      return;
    }
    if (canAutoPlay()) playNext();
    else render();
  }

  function onPlayerError(code) {
    const item = S.current;
    if (!item) return;
    // 100: removed or private, 101/150: embedding refused by the channel.
    markFailed(item.id, code === 100 || code === 101 || code === 150);
    skipBroken("Cette vidéo ne marche pas. Je passe à la suivante.");
  }

  function skipBroken(message) {
    S.failStreak++;
    S.current = null;
    S.status = "idle";
    if (S.failStreak >= 3) {
      S.failStreak = 0;
      S.backoffUntil = Date.now() + 5 * 60 * 1000;
      speak("YouTube ne répond pas. Je réessaie dans cinq minutes.");
      render();
      return;
    }
    speak(message).then(() => {
      if (canAutoPlay()) playNext();
      else render();
    });
  }

  function watchdog() {
    if (S.status === "loading" && S.loadStartedAt) {
      const waited = Date.now() - S.loadStartedAt;
      const state = Player.state;
      const notStarted = state === YT_STATE.UNSTARTED || state === YT_STATE.CUED || state === YT_STATE.PAUSED;
      if (waited > 12000 && notStarted && Player.ready && !S.blockedPrompted) {
        // The browser refused to start the sound without a tap.
        S.blockedPrompted = true;
        S.status = "waiting";
        render();
        speak("Touchez deux fois l'écran pour lancer la vidéo.");
      } else if (waited > 60000) {
        if (S.current) markFailed(S.current.id, false);
        skipBroken("Cette vidéo ne se charge pas. Je passe à la suivante.");
      }
    }
    if (S.status === "playing" && S.bufferingSince && Date.now() - S.bufferingSince > 90000) {
      S.bufferingSince = 0;
      savePosition(true);
      if (S.current) markFailed(S.current.id, false);
      skipBroken("La connexion est trop lente pour cette vidéo. Je passe à la suivante.");
    }
  }

  // ============================================================
  // USER ACTIONS (taps and voice)
  // ============================================================

  function userTogglePause() {
    if (S.alert) {
      endAlert(true);
      speak("D'accord. Tapez encore deux fois pour regarder.");
      return;
    }
    if (S.status === "waiting") {
      S.status = "loading";
      S.loadStartedAt = Date.now();
      Player.play();
      render();
      return;
    }
    if (S.current && (S.status === "playing" || S.status === "loading")) {
      userPause();
      return;
    }
    userPlay();
  }

  function userPause() {
    if (!S.current || S.status === "paused") {
      speak("C'est déjà en pause.");
      return;
    }
    pauseCurrent("user");
    flash("pause");
    beep("pause");
    speak("Pause.");
  }

  function userPlay() {
    S.waitConfirm = false;
    S.backoffUntil = 0;
    if (!inWindow()) S.manual = true;
    if (S.current) {
      flash("play");
      beep("play");
      speak("Lecture.").then(resumeCurrent);
      return;
    }
    if (!pending().length) {
      speak("Il n'y a pas de nouvelle émission pour le moment.");
      return;
    }
    flash("play");
    playNext();
  }

  function userNext() {
    if (S.current) markWatched(S.current.id);
    S.current = null;
    S.status = "idle";
    S.waitConfirm = false;
    if (!inWindow()) S.manual = true;
    if (!pending().length) {
      finishAll();
      return;
    }
    flash("next");
    playNext();
  }

  function userRestart() {
    if (S.current) {
      Player.seek(0);
      Player.play();
      speak("Je reprends depuis le début.");
      return;
    }
    const last = playlist()
      .filter((item) => watched[item.id] && item.index === 0)
      .sort((a, b) => watched[b.id] - watched[a.id])[0];
    if (!last) {
      speak("Il n'y a rien à revoir.");
      return;
    }
    S.waitConfirm = false;
    if (!inWindow()) S.manual = true;
    playItem(last);
  }

  function playChannel(section) {
    const channel = channelOf(section);
    let item = pending().find((i) => i.show.section === section);
    if (!item) {
      // Nothing new there: replay its latest episode.
      item = orderedShows()
        .filter((show) => show.section === section && show.found)
        .flatMap(itemsOf)
        .filter((i) => i.index === 0)
        .sort((a, b) => (b.show.episodeDate || "").localeCompare(a.show.episodeDate || ""))[0];
    }
    if (!item) {
      speak("Rien de disponible sur " + channel.spoken + ".");
      return;
    }
    savePosition(true);
    S.waitConfirm = false;
    if (!inWindow()) S.manual = true;
    playItem(item);
  }

  function seekBy(seconds) {
    if (!S.current) return;
    Player.seek(Player.time() + seconds);
    speak(seconds < 0 ? "Je recule." : "J'avance.");
  }

  function changeVolume(delta) {
    const before = Player.volume;
    Player.volume = Math.max(10, Math.min(100, Player.volume + delta));
    Player.applyVolume();
    if (delta > 0 && before === 100) speak("Le son est déjà au maximum. Montez le volume du téléphone.");
    else speak(delta > 0 ? "Plus fort." : "Moins fort.");
  }

  function sayStatus() {
    const queue = pending().filter((i) => !S.current || i.id !== S.current.id);
    const left = pendingShowsCount(queue);
    let text = "";
    if (S.current) {
      text = `Vous regardez ${S.current.show.spoken}, sur ${channelOf(S.current.show.section).spoken}.`;
      if (S.pause) text += " C'est en pause.";
    } else if (S.alert) {
      text = "Une nouvelle émission est arrivée.";
    } else {
      text = "Aucune émission en cours.";
    }
    text += left ? ` Encore ${left} émission${left > 1 ? "s" : ""} après.` : " Pas d'autre émission pour l'instant.";
    text += ` Il est ${spokenTime(now())}.`;
    if (!inWindow()) text += ` Les émissions reprennent à ${spokenClock(nextWindowStart())}.`;
    speak(text);
  }

  function sayLeft() {
    const queue = pending();
    const names = [...new Set(queue.map((i) => i.show.spoken))];
    if (!names.length) {
      speak("Il ne reste aucune émission pour le moment.");
      return;
    }
    speak(`Il reste ${names.length} émission${names.length > 1 ? "s" : ""} : ${names.slice(0, 5).join(", ")}.`);
  }

  function runCommand(command) {
    switch (command.intent) {
      case "play": userPlay(); break;
      case "stop":
        if (S.current && S.status !== "paused") userPause();
        else speak("D'accord.");
        break;
      case "next": userNext(); break;
      case "restart": userRestart(); break;
      case "back": seekBy(-30); break;
      case "forward": seekBy(30); break;
      case "louder": changeVolume(20); break;
      case "quieter": changeVolume(-20); break;
      case "what": sayStatus(); break;
      case "time": speak(`Il est ${spokenTime(now())}.`); break;
      case "date": speak(`Nous sommes le ${spokenDate(now())}.`); break;
      case "left": sayLeft(); break;
      case "channel": playChannel(command.channel); break;
      case "help":
        speak("Claquez des doigts, puis dites : joue, pause, suivant, recommence, plus fort, moins fort, quelle heure, ou le nom d'une chaîne.");
        break;
      default:
        break;
    }
  }

  // ============================================================
  // NEW EPISODES AND THE ALERT
  // ============================================================

  function alertNames(items) {
    return [...new Set(items.map((i) => i.show.spoken))].join(", ");
  }

  async function startAlert(items) {
    if (S.alert) {
      S.alert.items.push(...items);
      render();
      return;
    }
    const alert = { items: items.slice(), until: Date.now() + settings.alertMinutes * 60000, round: 0 };
    S.alert = alert;
    S.dark = false;
    render();

    while (S.alert === alert && Date.now() < alert.until) {
      if (window.TVVoice) TVVoice.mute(true);
      await ringAlarm();
      if (S.alert !== alert) break;
      const names = alertNames(alert.items);
      await speak(alert.round === 0
        ? `Nouvelle émission : ${names}. Dites joue pour regarder, ou arrête pour couper la sonnerie.`
        : `Nouvelle émission : ${names}.`);
      if (S.alert !== alert) break;
      alert.round++;
      const command = await listenFor(7000);
      if (S.alert !== alert) break;
      if (command && command.intent === "play") {
        endAlert(true);
        userPlay();
        return;
      }
      if (command && command.intent === "stop") {
        endAlert(true);
        speak("D'accord. Claquez des doigts et dites joue quand vous voulez regarder.");
        return;
      }
    }
    if (S.alert === alert) endAlert(false);
  }

  function endAlert(byUser) {
    S.alert = null;
    if (window.TVVoice) TVVoice.mute(false);
    if (!byUser && settings.autoPlayNew) S.waitConfirm = false;
    render();
  }

  async function listenFor(ms) {
    if (!window.TVVoice || TVVoice.status !== "ready") {
      await wait(ms);
      return null;
    }
    const result = await TVVoice.listen(ms);
    return result && result.command;
  }

  async function shortNotice(items, waiting) {
    if (window.TVVoice) TVVoice.mute(true);
    Player.duck(true);
    await chime();
    await speak(`Nouvelle émission disponible : ${alertNames(items)}. ${waiting ? "Elle vous attend." : "Elle passera ensuite."}`);
    Player.duck(false);
  }

  function onNewItems(items) {
    if (!S.armed || S.screen !== "tv") return;
    if (!inWindow() && !S.manual) return;
    if (S.current && (S.status === "playing" || S.status === "loading")) {
      shortNotice(items, false);
    } else if (S.pause === "user") {
      shortNotice(items, true);
    } else if (S.waitConfirm || !S.current) {
      startAlert(items);
    }
  }

  async function refreshData() {
    const ok = await fetchData();
    const firstParts = pending().filter((i) => i.index === 0);
    const knownList = store.get(KEYS.known, null);
    const known = new Set(knownList || []);
    const fresh = firstParts.filter((i) => !known.has(i.id));
    store.set(KEYS.known, [...known, ...firstParts.map((i) => i.id)].slice(-400));
    if (ok && knownList && fresh.length) onNewItems(fresh);
    render();
  }

  // ============================================================
  // SCHEDULE TICK
  // ============================================================

  function tick() {
    const t = now();
    if (S.armed) {
      const inside = inWindow(t);
      if (inside !== S.wasInside) {
        const first = S.wasInside === null;
        S.wasInside = inside;
        if (!first) onWindowChange(inside, t);
      }
      if (inside || S.manual) {
        watchdog();
        if (canAutoPlay() && !["playing", "loading", "waiting"].includes(S.status)) {
          if (S.current && S.status === "paused") resumeCurrent();
          else if (!S.current) playNext();
        }
      }
      savePosition(false);
      if (S.screen === "tv" && settings.blackAfter > 0 && !S.dark && !S.alert &&
          Date.now() - S.lastTouch > settings.blackAfter * 1000) {
        S.dark = true;
        render();
      }
      keepAwake();
    }
    renderClock();
  }

  function onWindowChange(inside, t) {
    if (inside) {
      S.waitConfirm = false;
      S.manual = false;
      if (S.pause === "schedule") S.pause = null;
      if (pending().length) speak(`Il est ${spokenTime(t)}. C'est l'heure de vos émissions.`);
      return;
    }
    if (S.alert) endAlert(true);
    if (S.manual) return;
    const next = spokenClock(nextWindowStart(t));
    if (S.current && (S.status === "playing" || S.status === "loading")) {
      pauseCurrent("schedule");
      speak(`Il est ${spokenTime(t)}. Je mets en pause. Reprise à ${next}.`);
    } else if (isNight(t)) {
      speak(`Bonne nuit. Les émissions reprendront à ${next}.`);
    }
  }

  // ============================================================
  // KEEPING THE PHONE AWAKE AND PLAYING
  // ============================================================

  let wakeLock = null;

  async function keepAwake() {
    const want = S.armed && S.screen === "tv" && !document.hidden && !isNight();
    if (want && !wakeLock && "wakeLock" in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
        });
      } catch (error) {
        wakeLock = null;
      }
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
    }
  }

  // A near-silent sound loop on the page itself. It keeps the browser from
  // freezing the app when the screen goes off, so the schedule and the alert
  // keep running, and routes the lock-screen / headset buttons to the app.
  const KeepAlive = {
    el: null,
    start() {
      if (!this.el) {
        const rate = 8000;
        const samples = rate;
        const buffer = new ArrayBuffer(44 + samples * 2);
        const view = new DataView(buffer);
        const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
        text(0, "RIFF");
        view.setUint32(4, 36 + samples * 2, true);
        text(8, "WAVEfmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        text(36, "data");
        view.setUint32(40, samples * 2, true);
        for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * 24), true);
        this.el = new Audio(URL.createObjectURL(new Blob([buffer], { type: "audio/wav" })));
        this.el.loop = true;
      }
      this.el.play().catch(() => {});
    },
    stop() {
      if (this.el) this.el.pause();
    }
  };

  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const item = S.current;
    try {
      navigator.mediaSession.metadata = item
        ? new MediaMetadata({
            title: item.show.label,
            artist: channelOf(item.show.section).label,
            album: "TV Facile",
            artwork: [{ src: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`, sizes: "480x360", type: "image/jpeg" }]
          })
        : new MediaMetadata({ title: "TV Facile", artist: S.armed ? "En attente" : "" });
      navigator.mediaSession.playbackState = S.status === "playing" ? "playing" : "paused";
    } catch (error) {
      // Older browsers.
    }
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const handlers = {
      play: () => userPlay(),
      pause: () => { if (S.current && S.status !== "paused") pauseCurrent("user"); },
      nexttrack: () => userNext(),
      previoustrack: () => userRestart()
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (error) {
        // Action not supported.
      }
    }
  }

  // ============================================================
  // VOICE
  // ============================================================

  function startVoice() {
    if (!window.TVVoice) return;
    if (!settings.voice) {
      TVVoice.stop();
      return;
    }
    TVVoice.configure({
      engine: settings.engine,
      trigger: settings.trigger,
      sensitivity: settings.sensitivity,
      aec: settings.aec,
      onTrigger: onVoiceTrigger,
      onStatus: renderVoiceStatus
    });
    const ctx = audio();
    if (ctx) TVVoice.start(ctx);
  }

  async function onVoiceTrigger() {
    if (S.listening || S.alert || S.screen !== "tv" || speaking) return;
    S.listening = true;
    S.lastTouch = Date.now();
    render();
    Player.duck(true);
    TVVoice.mute(true);
    await beep("listen");
    TVVoice.mute(false);
    const result = await TVVoice.listen(5500);
    S.listening = false;
    render();
    const command = result && result.command;
    S.lastHeard = { at: Date.now(), texts: (result && result.texts) || [], intent: command && command.intent };
    if (!command) {
      await beep("fail");
      Player.duck(false);
      if (result && result.texts && result.texts.length) speak("Je n'ai pas compris. Dites aide pour la liste des mots.");
      return;
    }
    Player.duck(false);
    runCommand(command);
  }

  // ============================================================
  // GESTURES
  // ============================================================

  // One tap, two quick taps or a long press anywhere on an element.
  function bindGestures(el, handlers, ignore) {
    let down = null;
    let longTimer = 0;
    let singleTimer = 0;
    let lastTap = null;

    el.addEventListener("pointerdown", (event) => {
      if (ignore && ignore(event)) return;
      audio();
      down = { x: event.clientX, y: event.clientY, long: false };
      clearTimeout(longTimer);
      longTimer = setTimeout(() => {
        if (!down) return;
        down.long = true;
        vibrate(120);
        if (handlers.long) handlers.long();
      }, 800);
    });

    el.addEventListener("pointermove", (event) => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 40) clearTimeout(longTimer);
    });

    el.addEventListener("pointerup", (event) => {
      if (!down) return;
      clearTimeout(longTimer);
      const wasLong = down.long;
      down = null;
      if (wasLong) return;
      const t = Date.now();
      if (lastTap && t - lastTap.t < 450 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 90) {
        clearTimeout(singleTimer);
        lastTap = null;
        vibrate([40, 50, 40]);
        if (handlers.double) handlers.double();
        return;
      }
      lastTap = { t, x: event.clientX, y: event.clientY };
      clearTimeout(singleTimer);
      singleTimer = setTimeout(() => {
        if (handlers.single) handlers.single();
      }, 450);
    });

    el.addEventListener("pointercancel", () => {
      clearTimeout(longTimer);
      down = null;
    });
    el.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  // Press and hold for `ms`; a short tap only says what the button does.
  function bindHold(el, ms, onHold, onTap) {
    let timer = 0;
    let fired = false;
    el.style.setProperty("--hold-ms", ms + "ms");
    const cancel = () => {
      clearTimeout(timer);
      el.classList.remove("holding");
    };
    el.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      audio();
      fired = false;
      el.classList.add("holding");
      timer = setTimeout(() => {
        fired = true;
        el.classList.remove("holding");
        vibrate(150);
        onHold();
      }, ms);
    });
    el.addEventListener("pointerup", (event) => {
      event.stopPropagation();
      const wasFired = fired;
      cancel();
      if (!wasFired && onTap) onTap();
    });
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  function touched() {
    S.lastTouch = Date.now();
  }

  // ============================================================
  // SCREENS
  // ============================================================

  function showScreen(name) {
    S.screen = name;
    $("home").classList.toggle("hidden", name !== "home");
    $("channelView").classList.toggle("hidden", name !== "channel");
    $("tv").classList.toggle("hidden", name !== "tv");
    $("settings").classList.toggle("hidden", name !== "settings");
    document.body.style.overflow = name === "tv" ? "hidden" : "";
    window.scrollTo(0, 0);
    keepAwake();
    render();
  }

  function startTV(firstItem) {
    audio();
    S.armed = true;
    store.set(KEYS.armed, true);
    S.wasInside = inWindow();
    S.waitConfirm = false;
    S.pause = null;
    S.backoffUntil = 0;
    S.dark = false;
    S.finishedSaid = false;
    touched();
    showScreen("tv");
    Player.init();
    KeepAlive.start();
    startVoice();

    if (firstItem) {
      if (!inWindow()) S.manual = true;
      playItem(firstItem);
      return;
    }
    const queue = pending();
    if (!inWindow()) {
      if (queue.length) {
        S.manual = true;
        speak(`Bonjour. Je lance une émission maintenant. Les autres passeront à ${spokenClock(nextWindowStart())}.`)
          .then(() => playItem(queue[0]));
      } else {
        S.waitConfirm = true;
        speak(`Bonjour. Rien de nouveau pour le moment. Les émissions reprennent à ${spokenClock(nextWindowStart())}.`);
      }
      return;
    }
    if (!queue.length) {
      S.waitConfirm = true;
      S.finishedSaid = true;
      speak("Bonjour. Tout est déjà vu. Je vous préviens dès qu'une nouvelle émission arrive.");
      render();
      return;
    }
    const count = pendingShowsCount(queue);
    speak(`Bonjour. ${count} émission${count > 1 ? "s" : ""} à regarder.`).then(() => {
      if (S.armed && !S.current && !S.pause) playNext();
    });
  }

  function stopTV() {
    savePosition(true);
    S.playToken++;
    S.armed = false;
    store.set(KEYS.armed, false);
    if (S.alert) endAlert(true);
    S.current = null;
    S.status = "idle";
    S.pause = null;
    S.manual = false;
    Player.stop();
    KeepAlive.stop();
    if (window.TVVoice) TVVoice.stop();
    updateMediaSession();
    showScreen("home");
    speak("Télé arrêtée.");
  }

  // ============================================================
  // RENDERING
  // ============================================================

  function setIcon(svg, name) {
    svg.querySelector("use").setAttribute("href", "#i-" + name);
  }

  function render() {
    if (S.screen === "home") renderHome();
    if (S.screen === "channel") renderChannel(S.section);
    if (S.screen === "tv") renderTV();
  }

  function renderHome() {
    const queue = pending();
    const count = pendingShowsCount(queue);
    let info = count ? `${count} ÉMISSION${count > 1 ? "S" : ""} À VOIR` : "TOUT EST VU";
    if (!inWindow()) info += ` · REPRISE À ${nextWindowStart().replace(":", "H")}`;
    $("startInfo").textContent = info;

    const box = $("channels");
    if (!box.children.length) {
      CHANNELS.forEach((channel) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "channel";
        button.dataset.section = channel.section;
        button.innerHTML = '<span class="channel-name"></span><span class="channel-count"></span>';
        button.querySelector(".channel-name").textContent = channel.label;
        button.addEventListener("click", () => {
          audio();
          speak(channel.spoken);
          S.section = channel.section;
          showScreen("channel");
        });
        box.appendChild(button);
      });
    }
    for (const button of box.children) {
      const n = pendingShowsCount(queue.filter((i) => i.show.section === button.dataset.section));
      button.querySelector(".channel-count").textContent = n ? `${n} NOUVEAU${n > 1 ? "X" : ""}` : "";
    }
  }

  function dateLabel(show) {
    const age = ageInDays(show);
    if (age === 0) return "AUJOURD'HUI";
    if (age === 1) return "HIER";
    if (!show.episodeDate || !isFinite(age)) return "";
    return new Date(show.episodeDate + "T12:00:00")
      .toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })
      .toUpperCase();
  }

  function renderChannel(section) {
    $("channelTitle").textContent = channelOf(section).label;
    const cards = $("cards");
    cards.innerHTML = "";
    orderedShows()
      .filter((show) => show.section === section)
      .forEach((show) => {
        const first = show.parts[0];
        const seen = show.parts.length && show.parts.every((p) => watched[p.videoId]);
        const card = document.createElement("article");
        card.className = "card" + (seen ? " watched" : "");

        const thumb = document.createElement("button");
        thumb.type = "button";
        thumb.className = "thumb";
        if (first) {
          const img = document.createElement("img");
          img.src = `https://i.ytimg.com/vi/${first.videoId}/hqdefault.jpg`;
          img.alt = "";
          img.loading = "lazy";
          thumb.appendChild(img);
          if (seen) {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "✓ VU";
            thumb.appendChild(badge);
          }
        } else {
          thumb.innerHTML = '<div class="thumb-fallback"></div>';
          thumb.firstChild.textContent = show.label + " — PAS ENCORE DISPONIBLE";
          thumb.disabled = true;
        }

        const body = document.createElement("div");
        body.className = "card-body";
        const title = document.createElement("h3");
        title.textContent = show.label;
        const date = document.createElement("p");
        date.className = "card-date";
        date.textContent = dateLabel(show);
        const watch = document.createElement("button");
        watch.type = "button";
        watch.className = "watch-button";
        watch.textContent = first ? (seen ? "↺ REVOIR" : "▶ REGARDER") : "INDISPONIBLE";
        watch.disabled = !first;

        const open = () => {
          audio();
          const item = itemsOf(show).find((i) => !watched[i.id]) || itemsOf(show)[0];
          startTV(item);
        };
        if (first) {
          thumb.addEventListener("click", open);
          watch.addEventListener("click", open);
        }
        body.append(title, date, watch);
        card.append(thumb, body);
        cards.appendChild(card);
      });
  }

  function renderTV() {
    const item = S.current;
    const queue = pending().filter((i) => !item || i.id !== item.id);
    const left = pendingShowsCount(queue);

    $("tvChannel").textContent = item ? channelOf(item.show.section).label : "TV FACILE";
    $("tvTitle").textContent = item
      ? item.show.label + (item.show.parts.length > 1 ? ` (${item.index + 1}/${item.show.parts.length})` : "")
      : S.waitConfirm ? "TOUT EST VU" : "";

    let icon = "wait";
    let text = "";
    if (S.status === "playing") {
      icon = "play";
      text = "EN COURS";
    } else if (S.status === "loading") {
      text = "CHARGEMENT…";
    } else if (S.status === "waiting") {
      icon = "hand";
      text = "TOUCHEZ DEUX FOIS";
    } else if (S.current && S.pause === "schedule") {
      icon = "pause";
      text = "REPRISE À " + nextWindowStart().replace(":", "H");
    } else if (S.current) {
      icon = "pause";
      text = "EN PAUSE";
    } else if (!inWindow()) {
      icon = "wait";
      text = "REPRISE À " + nextWindowStart().replace(":", "H");
    } else {
      icon = "check";
      text = "EN ATTENTE";
    }
    setIcon($("tvIcon"), icon);
    $("tvState").textContent = text;
    $("tvCount").textContent = left ? `ENCORE ${left} APRÈS` : "";

    $("dark").classList.toggle("hidden", !S.dark);
    $("tapBox").classList.toggle("hidden", S.status !== "waiting");
    $("alertBox").classList.toggle("hidden", !S.alert);
    $("alertShows").textContent = S.alert
      ? [...new Set(S.alert.items.map((i) => i.show.label))].join(" · ")
      : "";
    $("listenBox").classList.toggle("hidden", !S.listening);
  }

  function renderClock() {
    if (S.screen === "home" && Date.now() - (S.homeRenderedAt || 0) > 30000) {
      S.homeRenderedAt = Date.now();
      renderHome();
    }
    if (S.screen === "tv") renderTV();
  }

  // ============================================================
  // SETTINGS SCREEN
  // ============================================================

  const FIELDS = ["morningStart", "morningEnd", "eveningStart", "eveningEnd", "announce", "blackAfter",
    "alertMinutes", "autoPlayNew", "voice", "trigger", "sensitivity", "engine", "aec"];

  function openSettings() {
    for (const key of FIELDS) {
      const el = $(key);
      if (el.type === "checkbox") el.checked = Boolean(settings[key]);
      else el.value = String(settings[key]);
    }
    const list = $("showList");
    list.innerHTML = "";
    orderedShows().forEach((show) => {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !settings.disabledShows.includes(show.id);
      box.addEventListener("change", () => {
        const off = new Set(settings.disabledShows);
        if (box.checked) off.delete(show.id);
        else off.add(show.id);
        settings.disabledShows = [...off];
        saveSettings();
      });
      label.append(box, document.createTextNode(`${channelOf(show.section).label} — ${show.label}`));
      list.appendChild(label);
    });
    renderDataStatus();
    renderVoiceStatus();
    S.settingsFrom = S.screen;
    showScreen("settings");
  }

  function readSettings() {
    for (const key of FIELDS) {
      const el = $(key);
      if (el.type === "checkbox") settings[key] = el.checked;
      else if (["blackAfter", "alertMinutes"].includes(key)) settings[key] = Number(el.value);
      else settings[key] = el.value;
    }
    saveSettings();
  }

  function closeSettings() {
    readSettings();
    if (window.TVVoice) TVVoice.meter(false);
    if (S.armed) startVoice();
    showScreen(S.armed ? "tv" : "home");
  }

  function renderDataStatus() {
    const checked = data.checkedAt || data.generatedAt;
    const found = data.shows.filter((s) => s.found).length;
    const when = checked ? new Date(checked).toLocaleString("fr-FR") : "inconnue";
    $("dataStatus").textContent =
      `Liste des émissions vérifiée le ${when} (${found}/${data.shows.length} trouvées` +
      `${data.source === "api" ? ", API YouTube" : ""}). ${pending().length} vidéo(s) à voir.`;
  }

  function renderVoiceStatus() {
    const el = $("voiceStatus");
    if (!el || !window.TVVoice) return;
    const labels = {
      off: "Assistant arrêté (il démarre avec la télé).",
      loading: "Chargement de l'assistant… (41 Mo la première fois, en Wi-Fi de préférence)",
      ready: "Assistant prêt : claquez des doigts puis parlez.",
      error: "Assistant indisponible : " + TVVoice.error
    };
    el.textContent = labels[TVVoice.status] || "";
  }

  async function testVoice() {
    readSettings();
    startVoice();
    const status = $("voiceStatus");
    for (let i = 0; i < 300 && TVVoice.status === "loading"; i++) await wait(200);
    if (TVVoice.status !== "ready") {
      renderVoiceStatus();
      return;
    }
    TVVoice.configure({
      onLevel: (level, bg, snap) => {
        if (snap) status.textContent = "Claquement entendu ✓  — maintenant dites une commande…";
        if (level !== null) $("meterBar").style.width = Math.min(100, Math.round(level * 400)) + "%";
      },
      onTrigger: async () => {
        await beep("listen");
        const result = await TVVoice.listen(5500);
        const heard = (result.texts || []).join(" / ") || "rien";
        status.textContent = `Entendu : « ${heard} » → ${result.command ? result.command.intent : "pas une commande"}. Claquez encore pour réessayer.`;
      }
    });
    TVVoice.meter(true);
    status.textContent = "Claquez des doigts près du téléphone…";
  }

  // ============================================================
  // WIRING
  // ============================================================

  function bindUI() {
    $("startButton").addEventListener("click", () => startTV());

    bindHold($("settingsButton"), 1500, openSettings, () => speak("Réglages. Restez appuyé."));
    $("homeButton").addEventListener("click", () => showScreen("home"));

    bindGestures($("tv"), {
      single: () => {
        touched();
        if (S.dark) {
          S.dark = false;
          render();
        }
      },
      double: () => {
        touched();
        userTogglePause();
      },
      long: () => {
        touched();
        sayStatus();
      }
    }, (event) => !S.dark && Boolean(event.target.closest(".tv-bar")));

    bindGestures($("nextButton"), {
      single: () => {
        touched();
        speak("Suivant. Tapez deux fois pour passer à l'émission suivante.");
      },
      double: () => {
        touched();
        userNext();
      }
    });

    bindHold($("menuButton"), 1200, stopTV, () => {
      touched();
      speak("Menu. Restez appuyé pour arrêter la télé.");
    });

    $("closeSettings").addEventListener("click", closeSettings);
    $("testVoice").addEventListener("click", testVoice);
    $("testAlert").addEventListener("click", async () => {
      readSettings();
      await ringAlarm();
      await speak("Nouvelle émission : le journal de Canal 2.");
    });
    $("markAll").addEventListener("click", () => {
      playlist().forEach((item) => markWatched(item.id));
      renderDataStatus();
    });
    $("resetWatched").addEventListener("click", () => {
      for (const id of Object.keys(watched)) delete watched[id];
      for (const id of Object.keys(failed)) delete failed[id];
      store.set(KEYS.watched, watched);
      store.set(KEYS.failed, failed);
      renderDataStatus();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        savePosition(true);
        return;
      }
      keepAwake();
      if (S.pause === "system") {
        S.pause = null;
        if (canAutoPlay()) resumeCurrent();
      }
      refreshData();
    });
    window.addEventListener("online", refreshData);
    window.addEventListener("pagehide", () => savePosition(true));
  }

  async function boot() {
    acceptData(store.get(KEYS.data, null));
    bindUI();
    setupMediaSession();
    render();
    await refreshData();

    // If the page was reloaded while the TV was on, go straight back to it.
    // Sound needs one tap first, so it waits for a double tap.
    if (store.get(KEYS.armed, false)) {
      S.armed = true;
      S.wasInside = inWindow();
      showScreen("tv");
      Player.init();
      if (canAutoPlay() && pending().length) {
        playNext();
      } else {
        S.waitConfirm = !pending().length;
      }
      document.addEventListener("pointerdown", function once() {
        document.removeEventListener("pointerdown", once, true);
        KeepAlive.start();
        startVoice();
      }, true);
    }

    setInterval(tick, 1000);
    setInterval(refreshData, DATA_REFRESH_MS);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./service-worker.js?v=20", { updateViaCache: "none" }).catch(() => {});
    }
  }

  // Test hooks (used by the automated checks, harmless otherwise).
  window.TVF = {
    S,
    Player,
    pending,
    playlist,
    refreshData,
    acceptData,
    onNewItems,
    runCommand,
    startVoice,
    setNow(iso) {
      clockOffset = new Date(iso).getTime() - Date.now();
    },
    get settings() {
      return settings;
    }
  };

  boot();
})();
