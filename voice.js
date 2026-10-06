/* TV FACILE voice assistant.
 *
 * - Listens to the microphone with a tiny AudioWorklet that spots a finger
 *   snap or a hand clap: a short, sharp, high-pitched sound well above the
 *   room's background level that dies away within ~60 ms.
 * - After a snap (or while an alert is ringing) it recognises a short French
 *   command, either fully offline with Vosk (a 41 MB model cached on the
 *   phone, restricted to the command words, which works in Brave) or with
 *   the browser's Google speech service when that is available.
 *
 * Exposes window.TVVoice. app.js decides what each command does.
 */
(function () {
  "use strict";

  const BASE = new URL(".", document.currentScript.src).href;
  const MODEL_URL = BASE + "voice/model-fr.tar.gz";
  const VOSK_URL = BASE + "voice/vosk.js";
  const CACHE_NAME = "tvf-voice-v1";
  const MIN_CONFIDENCE = 0.5;

  // Words the offline recogniser is allowed to hear. A closed list is what
  // makes a small model reliable: anything else comes back as [unk].
  const GRAMMAR = [
    "arrête", "arrêter", "arrêt", "stop", "pause", "attends", "silence", "coupe",
    "joue", "jouer", "lance", "lancer", "lecture", "regarde", "regarder",
    "vas-y", "continue", "démarre", "mets", "allume",
    "suivant", "suivante", "après", "la suite",
    "recommence", "début", "encore", "rejoue",
    "recule", "avance",
    "plus fort", "monte", "augmente", "moins fort", "baisse", "diminue",
    "c'est quoi", "quoi", "quelle émission", "quelle heure", "heure",
    "quel jour", "date", "combien", "il reste", "aide",
    "équinoxe", "canal", "deux", "canal deux", "info", "télé", "info télé",
    "vision", "quatre", "vision quatre",
    "merci", "ok", "d'accord", "c'est bon", "oui", "non",
    "quelle heure est-il", "il est quelle heure", "on est quel jour",
    // Everyday words give other speech somewhere to land instead of being
    // forced onto a command (tested: without them, "le président de la
    // République" came out as a command).
    "bonjour", "bonsoir", "comment", "ça va", "mon", "ma", "mes", "ami", "je",
    "tu", "il", "elle", "on", "nous", "vous", "ils", "est", "sont", "pas", "ne",
    "le", "la", "les", "un", "une", "des", "du", "de", "au", "aux", "et", "ou",
    "mais", "que", "qui", "dans", "pour", "avec", "sur", "par", "bien", "là",
    "ici", "ce", "cette", "ces", "son", "sa", "ses", "leur", "tout", "tous",
    "a", "ai", "as", "avait", "été", "être", "avoir", "va", "vais", "veux",
    "peut", "faut", "dit", "dis", "fait", "faire", "voir", "venir", "viens",
    "reviens", "prendre", "donne", "manger", "boire", "maman", "papa",
    "président", "république", "représentants", "gouvernement", "ministre", "pays", "ville",
    "école", "matin", "soir", "hier", "demain", "maintenant", "quelque",
    "chose", "temps", "jour", "année", "monde", "gens", "homme", "femme",
    "enfant", "enfants", "eau", "argent", "travail", "très", "trop", "aussi",
    "alors", "donc", "parce", "comme", "quand", "où", "si", "y",
    "[unk]"
  ];

  // Checked in order; the first rule with a matching phrase wins. Phrases are
  // compared on normalised text (lower case, no accents, single spaces).
  const RULES = [
    { intent: "time", words: ["quelle heure", "l heure", "heure"] },
    { intent: "date", words: ["quel jour", "la date", "date", "aujourd hui"] },
    { intent: "left", words: ["combien", "il reste", "reste", "liste", "programme"] },
    { intent: "what", words: ["c est quoi", "qu est ce", "quelle emission", "quoi"] },
    { intent: "help", words: ["aide", "aidez"] },
    { intent: "channel", channel: "EQUINOXE TV", words: ["equinoxe"] },
    { intent: "channel", channel: "CANAL 2", words: ["canal"] },
    { intent: "channel", channel: "INFO TV", words: ["info"] },
    { intent: "channel", channel: "VISION 4", words: ["vision"] },
    { intent: "quieter", words: ["moins fort", "baisse", "diminue", "doucement"] },
    { intent: "louder", words: ["plus fort", "monte", "augmente", "fort"] },
    { intent: "next", words: ["suivant", "suivante", "apres", "la suite", "passe", "change"] },
    { intent: "restart", words: ["recommence", "debut", "encore", "rejoue"] },
    { intent: "back", words: ["recule", "arriere"] },
    { intent: "forward", words: ["avance"] },
    { intent: "stop", words: ["arrete", "arreter", "arret", "stop", "pause", "attends", "attend", "silence", "tais toi", "coupe", "c est bon", "d accord", "ok", "merci"] },
    { intent: "play", words: ["joue", "jouer", "lance", "lancer", "lecture", "regarde", "regarder", "vas y", "va y", "play", "continue", "demarre", "mets", "met", "allume", "oui"] }
  ];

  // k: how many times louder than the background (amplitude) a snap must
  // be; floor: minimum high-frequency peak, so a silent room is not twitchy.
  const SENSITIVITY = {
    low: { k: 6, floor: 0.05 },
    medium: { k: 4, floor: 0.025 },
    high: { k: 2.8, floor: 0.012 }
  };

  // Runs on the audio thread. Kept as a string so it can be loaded from a
  // Blob without another file.
  const WORKLET = `
// Finger snaps and claps are loud above ~2.5 kHz, rise in under a
// millisecond and are gone within ~60 ms. TV speech coming out of the phone
// has little energy that high and lasts longer. So: high-pass the signal,
// look for a block far above both the long-term level and the last ~20 ms,
// then check that it died away.
class TvfSnap extends AudioWorkletProcessor {
  constructor() {
    super();
    const w = 2 * Math.PI * 2500 / sampleRate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
    this.a1 = -2 * cos / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.bg = 1e-7;
    this.recent = new Float32Array(8);
    this.r = 0;
    this.hold = 0;
    this.k = 4;
    this.floor = 0.02;
    this.mute = false;
    this.listen = false;
    this.meter = false;
    this.meterAcc = 0;
    this.meterN = 0;
    this.pending = null;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.port.onmessage = (event) => Object.assign(this, event.data);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.listen) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage({ audio: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    let e = 0, peak = 0, raw = 0;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      e += y * y;
      raw += x * x;
      const a = y < 0 ? -y : y;
      if (a > peak) peak = a;
    }
    e /= ch.length;
    if (this.meter) {
      this.meterAcc += raw / ch.length;
      if (++this.meterN >= 30) {
        this.port.postMessage({ level: Math.sqrt(this.meterAcc / this.meterN), bg: Math.sqrt(this.bg) });
        this.meterAcc = 0;
        this.meterN = 0;
      }
    }
    if (this.pending) {
      const p = this.pending;
      p.blocks++;
      if (p.blocks > p.skip) { p.after += e; p.afterN++; }
      if (p.blocks >= p.skip + p.window) {
        if (p.after / p.afterN < p.e * 0.25) {
          if (!this.mute) this.port.postMessage({ snap: Math.sqrt(p.e), bg: Math.sqrt(this.bg) });
          this.hold = Math.round(0.25 * sampleRate);
        }
        this.pending = null;
      }
      return true;
    }
    let before = 0;
    for (let i = 0; i < this.recent.length; i++) before += this.recent[i];
    before /= this.recent.length;
    this.recent[this.r] = e;
    this.r = (this.r + 1) % this.recent.length;
    if (this.hold > 0) {
      this.hold -= ch.length;
    } else if (!this.mute && peak > this.floor && e > this.k * this.k * Math.max(this.bg, before)) {
      const blocksPerMs = sampleRate / ch.length / 1000;
      this.pending = { e, blocks: 0, after: 0, afterN: 0, skip: Math.round(25 * blocksPerMs), window: Math.round(50 * blocksPerMs) };
      return true;
    }
    this.bg = this.bg * 0.999 + e * 0.001;
    return true;
  }
}
registerProcessor("tvf-snap", TvfSnap);
`;

  const state = {
    status: "off",
    error: "",
    engine: "vosk",
    trigger: "single",
    sensitivity: "medium",
    aec: false,
    ctx: null,
    stream: null,
    source: null,
    node: null,
    model: null,
    session: null,
    lastSnap: 0,
    startToken: 0,
    onTrigger: null,
    onLevel: null,
    onStatus: null
  };

  function setStatus(status, error) {
    state.status = status;
    state.error = error || "";
    if (state.onStatus) state.onStatus(status, state.error);
  }

  function normalize(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function parse(texts) {
    for (const raw of texts || []) {
      const text = " " + normalize(raw) + " ";
      if (!text.trim()) continue;
      for (const rule of RULES) {
        if (rule.words.some((w) => text.includes(" " + w + " "))) {
          return { intent: rule.intent, channel: rule.channel || null, text: raw.trim() };
        }
      }
    }
    return null;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Vosk) return resolve();
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error("vosk.js introuvable"));
      document.head.appendChild(script);
    });
  }

  // The model is fetched once and kept in the Cache API, then handed to the
  // Vosk worker as a blob: URL so it never downloads twice.
  async function cachedBlobUrl(url) {
    let response = null;
    let cache = null;
    try {
      cache = await caches.open(CACHE_NAME);
      response = await cache.match(url);
    } catch (error) {
      cache = null;
    }
    if (!response) {
      response = await fetch(url);
      if (!response.ok) throw new Error("modèle vocal: HTTP " + response.status);
      if (cache) {
        try {
          await cache.put(url, response.clone());
        } catch (error) {
          // Storage full: still usable for this session.
        }
      }
    }
    return URL.createObjectURL(await response.blob());
  }

  async function loadVosk() {
    if (state.model) return;
    await loadScript(VOSK_URL);
    const url = await cachedBlobUrl(MODEL_URL);
    state.model = await window.Vosk.createModel(url, -1);
    URL.revokeObjectURL(url);
  }

  async function startMic() {
    if (state.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: state.aec,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
    const ctx = state.ctx;
    if (!state.node) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      state.node = new AudioWorkletNode(ctx, "tvf-snap", { numberOfInputs: 1, numberOfOutputs: 0 });
      state.node.port.onmessage = onWorkletMessage;
      applySensitivity();
    }
    state.stream = stream;
    state.source = ctx.createMediaStreamSource(stream);
    state.source.connect(state.node);
  }

  function stopMic() {
    if (state.source) {
      try {
        state.source.disconnect();
      } catch (error) {
        // Already disconnected.
      }
    }
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.source = null;
    state.stream = null;
  }

  function onWorkletMessage(event) {
    const data = event.data;
    if (data.audio) {
      const session = state.session;
      if (session && session.rec && !session.done) {
        session.rec.acceptWaveformFloat(data.audio, state.ctx.sampleRate);
      }
      return;
    }
    if (data.level !== undefined && state.onLevel) {
      state.onLevel(data.level, data.bg);
      return;
    }
    if (data.snap !== undefined) onSnap(data.snap);
  }

  function onSnap(level) {
    if (state.session) return;
    const now = performance.now();
    if (state.onLevel) state.onLevel(null, null, level);
    if (state.trigger === "double") {
      const gap = now - state.lastSnap;
      state.lastSnap = now;
      if (gap < 120 || gap > 900) return;
      state.lastSnap = 0;
    }
    if (state.onTrigger) state.onTrigger();
  }

  function applySensitivity() {
    if (state.node) state.node.port.postMessage(SENSITIVITY[state.sensitivity] || SENSITIVITY.medium);
  }

  function post(message) {
    if (state.node) state.node.port.postMessage(message);
  }

  // A fresh recogniser per session, so words from one session can never
  // leak into the next one.
  function openSession(sampleRate, resolve) {
    const rec = new state.model.KaldiRecognizer(sampleRate, JSON.stringify(GRAMMAR));
    rec.setWords(true);
    const session = {
      rec, resolve, texts: [], raw: [], done: false, flushing: false,
      timer: 0, events: 0, lastEvent: 0
    };
    rec.on("result", (message) => onVoskResult(session, message));
    state.session = session;
    return session;
  }

  function onVoskResult(session, message) {
    session.lastEvent = performance.now();
    session.events++;
    if (session.done && !session.flushing) return;
    const result = message.result || {};
    const words = (result.result || [])
      .filter((w) => w.word !== "[unk]" && w.conf >= MIN_CONFIDENCE)
      .map((w) => w.word);
    const text = words.join(" ");
    if (!text) return;
    session.raw.push(result.result);
    // Commands are short; a long run of words is conversation or TV.
    if (words.length > 6) return;
    session.texts.push(text);
    if (!session.flushing && parse([text])) finishSession(session, false);
  }

  function finishSession(session, flush) {
    if (session.done) return;
    session.done = true;
    clearTimeout(session.timer);
    post({ listen: false });
    if (state.session === session) state.session = null;

    const settle = () => {
      session.flushing = false;
      if (session.rec) session.rec.remove();
      session.resolve({ texts: session.texts, raw: session.raw, command: parse(session.texts) });
    };
    if (!flush || !session.rec) {
      settle();
      return;
    }

    // Let the recogniser work through queued audio: done once a result has
    // arrived after the flush and nothing new came for 300 ms.
    session.flushing = true;
    session.events = 0;
    const started = performance.now();
    session.rec.retrieveFinalResult();
    const poll = setInterval(() => {
      const now = performance.now();
      if ((session.events > 0 && now - session.lastEvent > 300) || now - started > 3000) {
        clearInterval(poll);
        settle();
      }
    }, 50);
  }

  function listenVosk(ms) {
    return new Promise((resolve) => {
      const session = openSession(state.ctx.sampleRate, resolve);
      post({ listen: true });
      session.timer = setTimeout(() => finishSession(session, true), ms);
    });
  }

  // Android's recogniser needs the microphone for itself, so ours is released
  // while it listens.
  function listenGoogle(ms) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return Promise.resolve({ texts: [], command: null, error: "absent" });
    stopMic();
    return new Promise((resolve) => {
      const recognition = new Recognition();
      recognition.lang = "fr-FR";
      recognition.maxAlternatives = 5;
      recognition.interimResults = false;
      recognition.continuous = false;
      const texts = [];
      let done = false;
      let error = "";
      const session = { texts, done: false, timer: 0, resolve: null };
      state.session = session;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          recognition.abort();
        } catch (e) {
          // Already stopped.
        }
        state.session = null;
        startMic().catch(() => {}).then(() => resolve({ texts, command: parse(texts), error }));
      };
      recognition.onresult = (event) => {
        for (const result of event.results) {
          for (let i = 0; i < result.length; i++) texts.push(result[i].transcript);
        }
        finish();
      };
      recognition.onerror = (event) => {
        error = event.error || "erreur";
        finish();
      };
      recognition.onend = finish;
      const timer = setTimeout(finish, ms + 2000);
      try {
        recognition.start();
      } catch (e) {
        error = "start";
        finish();
      }
    });
  }

  window.TVVoice = {
    GRAMMAR,
    parse,
    normalize,

    get status() {
      return state.status;
    },
    get error() {
      return state.error;
    },
    get listening() {
      return Boolean(state.session);
    },

    configure(options) {
      Object.assign(state, {
        engine: options.engine || state.engine,
        trigger: options.trigger || state.trigger,
        sensitivity: options.sensitivity || state.sensitivity,
        aec: options.aec === undefined ? state.aec : Boolean(options.aec),
        onTrigger: options.onTrigger || state.onTrigger,
        onLevel: options.onLevel === undefined ? state.onLevel : options.onLevel,
        onStatus: options.onStatus || state.onStatus
      });
      applySensitivity();
    },

    // Must be called after a tap (AudioContext + microphone permission).
    async start(ctx) {
      if (state.status === "ready" || state.status === "loading") return;
      state.ctx = ctx;
      setStatus("loading");
      const token = ++state.startToken;
      try {
        await startMic();
        if (state.engine === "vosk") await loadVosk();
        if (token !== state.startToken) {
          // stop() was called while loading.
          stopMic();
          return;
        }
        setStatus("ready");
      } catch (error) {
        stopMic();
        setStatus("error", error && error.name === "NotAllowedError"
          ? "micro refusé"
          : String((error && error.message) || error));
      }
    },

    stop() {
      state.startToken++;
      if (state.session) finishSession(state.session, false);
      stopMic();
      setStatus("off");
    },

    // Ignore snaps while the app itself makes noise.
    mute(value) {
      post({ mute: Boolean(value) });
    },

    meter(value) {
      post({ meter: Boolean(value) });
    },

    listen(ms) {
      if (state.status !== "ready") return Promise.resolve({ texts: [], command: null });
      if (state.session) finishSession(state.session, false);
      return state.engine === "google" ? listenGoogle(ms) : listenVosk(ms);
    },

    // Test hook: run recorded audio through the offline recogniser.
    async recognizeSamples(samples, sampleRate) {
      await loadVosk();
      return new Promise((resolve) => {
        const session = openSession(sampleRate, resolve);
        for (let i = 0; i < samples.length; i += 4096) {
          session.rec.acceptWaveformFloat(samples.slice(i, i + 4096), sampleRate);
        }
        finishSession(session, true);
      });
    }
  };
})();
