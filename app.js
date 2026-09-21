const BACKEND_URL = "https://script.google.com/macros/s/AKfycbz9Aw2EUSZTbUy8KHc8aLr-5p_pYc8tnPbDcTMB83VE9E5OHNYX4G81rXeqYev0rgf7bg/exec";
const STORAGE_DATA = "tvfacile_data_v4";

const homeView = document.getElementById("homeView");
const channelView = document.getElementById("channelView");
const loadingBox = document.getElementById("loadingBox");
const errorBox = document.getElementById("errorBox");
const homeContent = document.getElementById("homeContent");
const showsList = document.getElementById("showsList");
const channelTitle = document.getElementById("channelTitle");

const playerView = document.getElementById("playerView");
const playerTitle = document.getElementById("playerTitle");
const playerMessage = document.getElementById("playerMessage");
const videoFrame = document.getElementById("videoFrame");
const openBraveLink = document.getElementById("openBraveLink");

let appData = null;
let currentSection = null;

function showOnly(view) {
  [homeView, channelView].forEach(v => v.classList.add("hidden"));
  view.classList.remove("hidden");
}

function showLoading() {
  showOnly(homeView);
  loadingBox.classList.remove("hidden");
  errorBox.classList.add("hidden");
  homeContent.classList.add("hidden");
}

function showError() {
  showOnly(homeView);
  loadingBox.classList.add("hidden");
  homeContent.classList.add("hidden");
  errorBox.classList.remove("hidden");
}

function showHome() {
  showOnly(homeView);
  loadingBox.classList.add("hidden");
  errorBox.classList.add("hidden");
  homeContent.classList.remove("hidden");
}

function bridgeLoad(url) {
  return new Promise((resolve, reject) => {
    const nonce =
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2);

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");

    const timer = setTimeout(() => cleanup(new Error("Délai dépassé")), 30000);

    function cleanup(error, data) {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.remove();

      if (error) reject(error);
      else resolve(data);
    }

    function onMessage(event) {
      const msg = event.data;

      if (!msg || msg.type !== "tvfacile-data" || msg.nonce !== nonce) {
        return;
      }

      if (msg.error) {
        cleanup(new Error(msg.error));
        return;
      }

      cleanup(null, msg.payload);
    }

    window.addEventListener("message", onMessage);

    const separator = url.includes("?") ? "&" : "?";
    iframe.src =
      url +
      separator +
      "bridge=1&nonce=" +
      encodeURIComponent(nonce) +
      "&t=" +
      Date.now();

    document.body.appendChild(iframe);
  });
}

async function loadData({quiet = false} = {}) {
  if (!quiet) showLoading();

  try {
    const data = await bridgeLoad(BACKEND_URL);

    if (!data || !Array.isArray(data.shows)) {
      throw new Error("Réponse invalide");
    }

    appData = data;
    localStorage.setItem(STORAGE_DATA, JSON.stringify(data));

    if (currentSection && !channelView.classList.contains("hidden")) {
      renderChannel(currentSection);
    } else {
      showHome();
    }
  } catch (err) {
    console.error("TV Facile backend error:", err);

    const cached = localStorage.getItem(STORAGE_DATA);
    if (cached) {
      try {
        appData = JSON.parse(cached);
        if (currentSection) renderChannel(currentSection);
        else showHome();
        return;
      } catch (_) {}
    }

    showError();
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
        thumbWrap.innerHTML =
          `<div class="thumb-fallback">${initials(show.label)}</div>`;
      };
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.innerHTML =
        `<div class="thumb-fallback">${initials(show.label)}</div>`;
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
    if (show.watchUrl) {
      window.open(show.watchUrl, "_blank", "noopener");
    }
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
document.getElementById("retryBtn").addEventListener("click", () => loadData());

async function startApp() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("service-worker.js?v=4");
    } catch (_) {}
  }

  const cached = localStorage.getItem(STORAGE_DATA);

  if (cached) {
    try {
      appData = JSON.parse(cached);
      showHome();
      loadData({quiet: true});
      return;
    } catch (_) {}
  }

  loadData();
}

startApp();
