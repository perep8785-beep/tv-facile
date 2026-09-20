const STORAGE_BACKEND = "tvfacile_backend_v1";
const STORAGE_DATA = "tvfacile_data_v1";

const setupView = document.getElementById("setupView");
const homeView = document.getElementById("homeView");
const channelView = document.getElementById("channelView");
const loadingBox = document.getElementById("loadingBox");
const homeContent = document.getElementById("homeContent");
const backendInput = document.getElementById("backendInput");
const setupStatus = document.getElementById("setupStatus");
const showsList = document.getElementById("showsList");
const channelTitle = document.getElementById("channelTitle");

const playerView = document.getElementById("playerView");
const playerTitle = document.getElementById("playerTitle");
const playerMessage = document.getElementById("playerMessage");
const videoFrame = document.getElementById("videoFrame");
const openBraveLink = document.getElementById("openBraveLink");

let appData = null;
let currentSection = null;

function cleanBackendUrl(value) {
  return String(value || "").trim().replace(/[?#].*$/, "");
}

function getBackendUrl() {
  return cleanBackendUrl(localStorage.getItem(STORAGE_BACKEND));
}

function showOnly(view) {
  [setupView, homeView, channelView].forEach(v => v.classList.add("hidden"));
  view.classList.remove("hidden");
}

function showSetup(message = "") {
  backendInput.value = getBackendUrl();
  setupStatus.textContent = message;
  showOnly(setupView);
}

function showLoading() {
  showOnly(homeView);
  loadingBox.classList.remove("hidden");
  homeContent.classList.add("hidden");
}

function showHome() {
  showOnly(homeView);
  loadingBox.classList.add("hidden");
  homeContent.classList.remove("hidden");
}

function jsonpLoad(url) {
  return new Promise((resolve, reject) => {
    const callbackName = "__tvfacile_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
    const script = document.createElement("script");
    const timer = setTimeout(() => cleanup(new Error("Délai dépassé")), 20000);

    function cleanup(error, data) {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      if (error) reject(error);
      else resolve(data);
    }

    window[callbackName] = data => cleanup(null, data);
    script.onerror = () => cleanup(new Error("Impossible de joindre le service"));

    const separator = url.includes("?") ? "&" : "?";
    script.src = url + separator + "callback=" + encodeURIComponent(callbackName) + "&t=" + Date.now();
    document.head.appendChild(script);
  });
}

async function loadData({quiet = false} = {}) {
  const backend = getBackendUrl();
  if (!backend) {
    showSetup("Collez d’abord l’adresse /exec.");
    return;
  }

  if (!quiet) showLoading();

  try {
    const data = await jsonpLoad(backend);
    if (!data || !Array.isArray(data.shows)) throw new Error("Réponse invalide");
    appData = data;
    localStorage.setItem(STORAGE_DATA, JSON.stringify(data));
    if (currentSection && !channelView.classList.contains("hidden")) {
      renderChannel(currentSection);
    } else {
      showHome();
    }
  } catch (err) {
    const cached = localStorage.getItem(STORAGE_DATA);
    if (cached) {
      try {
        appData = JSON.parse(cached);
        if (currentSection) renderChannel(currentSection);
        else showHome();
        return;
      } catch (_) {}
    }
    showSetup("Connexion impossible. Vérifiez l’adresse /exec.");
  }
}

function sectionShows(section) {
  if (!appData) return [];
  return appData.shows.filter(s => s.section === section);
}

function initials(text) {
  return String(text || "TV")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0,2)
    .map(w => w[0])
    .join("")
    .toUpperCase();
}

function renderChannel(section) {
  currentSection = section;
  channelTitle.textContent = section;
  showsList.innerHTML = "";

  const shows = sectionShows(section);

  if (!shows.length) {
    const empty = document.createElement("div");
    empty.className = "loading-box";
    empty.textContent = "AUCUNE ÉMISSION TROUVÉE";
    showsList.appendChild(empty);
  }

  shows.forEach(show => {
    const card = document.createElement("article");
    card.className = "show-card" + (show.found ? "" : " not-found");

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "show-thumb-wrap";

    if (show.thumbnail) {
      const img = document.createElement("img");
      img.className = "show-thumb";
      img.alt = "";
      img.loading = "lazy";
      img.src = show.thumbnail;
      img.onerror = () => {
        thumbWrap.innerHTML = `<div class="thumb-fallback">${initials(show.label)}</div>`;
      };
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.innerHTML = `<div class="thumb-fallback">${initials(show.label)}</div>`;
    }

    const body = document.createElement("div");
    body.className = "show-body";

    const title = document.createElement("h3");
    title.className = "show-title";
    title.textContent = show.label;

    const meta = document.createElement("p");
    meta.className = "show-meta";
    meta.textContent = show.found
      ? "DERNIÈRE ÉMISSION DISPONIBLE"
      : "RECHERCHE DE L’ÉMISSION";

    const button = document.createElement("button");
    button.className = "watch-button";
    button.textContent = show.found ? "▶ REGARDER" : "▶ RECHERCHER";
    button.addEventListener("click", () => openPlayer(show));

    body.append(title, meta, button);
    card.append(thumbWrap, body);
    showsList.appendChild(card);
  });

  showOnly(channelView);
  window.scrollTo({top: 0, behavior: "instant"});
}

function openPlayer(show) {
  if (!show) return;

  if (!show.found || !show.embedUrl) {
    if (show.watchUrl) window.open(show.watchUrl, "_blank", "noopener");
    return;
  }

  playerTitle.textContent = show.label;
  playerMessage.textContent = "LECTURE DE LA DERNIÈRE ÉMISSION";
  videoFrame.src = show.embedUrl;
  openBraveLink.href = show.watchUrl || "#";
  openBraveLink.classList.remove("hidden");
  playerView.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closePlayer() {
  videoFrame.src = "";
  playerView.classList.add("hidden");
  document.body.style.overflow = "";
}

document.querySelectorAll(".channel-button").forEach(btn => {
  btn.addEventListener("click", () => renderChannel(btn.dataset.section));
});

document.getElementById("homeBtn").addEventListener("click", () => {
  currentSection = null;
  showHome();
  window.scrollTo({top: 0, behavior: "instant"});
});

document.getElementById("backToShowsBtn").addEventListener("click", closePlayer);
document.getElementById("refreshBtn").addEventListener("click", () => loadData());
document.getElementById("configBtn").addEventListener("click", () => showSetup());

document.getElementById("saveBackendBtn").addEventListener("click", async () => {
  const value = cleanBackendUrl(backendInput.value);
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/i.test(value)) {
    setupStatus.textContent = "L’adresse doit être une URL Apps Script qui finit par /exec.";
    return;
  }
  localStorage.setItem(STORAGE_BACKEND, value);
  setupStatus.textContent = "Enregistré. Vérification…";
  await loadData();
});

window.addEventListener("popstate", () => {
  if (!playerView.classList.contains("hidden")) closePlayer();
});

async function startApp() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("service-worker.js"); } catch (_) {}
  }

  if (!getBackendUrl()) {
    showSetup();
    return;
  }

  const cached = localStorage.getItem(STORAGE_DATA);
  if (cached) {
    try {
      appData = JSON.parse(cached);
      showHome();
      loadData({quiet:true});
      return;
    } catch (_) {}
  }

  loadData();
}

startApp();
