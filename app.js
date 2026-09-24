const DATA_URL = "data.json";
const STORAGE_DATA = "tvfacile_static_data_v7";

const homeView = document.getElementById("homeView");
const channelView = document.getElementById("channelView");
const showsList = document.getElementById("showsList");
const channelTitle = document.getElementById("channelTitle");
const syncStatus = document.getElementById("syncStatus");

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

function showHome() {
  showOnly(homeView);
}

function fallbackData() {
  try {
    const cached = localStorage.getItem(STORAGE_DATA);
    if (cached) return JSON.parse(cached);
  } catch (_) {}
  return {shows: []};
}

async function loadData({quiet=false} = {}) {
  if (!quiet) syncStatus.textContent = "ACTUALISATION…";

  try {
    const response = await fetch(DATA_URL + "?t=" + Date.now(), {
      cache: "no-store"
    });
    if (!response.ok) throw new Error("data.json inaccessible");
    const data = await response.json();
    if (!data || !Array.isArray(data.shows)) throw new Error("données invalides");

    appData = data;
    localStorage.setItem(STORAGE_DATA, JSON.stringify(data));

    if (data.generatedAt) {
      const d = new Date(data.generatedAt);
      syncStatus.textContent = "MISE À JOUR AUTOMATIQUE OK";
    } else {
      syncStatus.textContent = "ÉMISSIONS PRÊTES";
    }

    if (currentSection && !channelView.classList.contains("hidden")) {
      renderChannel(currentSection);
    }
  } catch (err) {
    if (!appData) appData = fallbackData();
    syncStatus.textContent = "MODE HORS LIGNE — TOUCHEZ UNE CHAÎNE";
  }
}

function sectionShows(section) {
  if (!appData || !Array.isArray(appData.shows)) return [];
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
    empty.textContent = "ACTUALISEZ L'APPLICATION";
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
      : "OUVRIR LA RECHERCHE";

    const button = document.createElement("button");
    button.className = "watch-button";
    button.textContent = show.found ? "▶ REGARDER" : "▶ OUVRIR";
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

async function startApp() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("service-worker.js?v=7"); } catch (_) {}
  }

  appData = fallbackData();
  showHome();
  await loadData({quiet:true});
}

startApp();
  if (!shows.length) {
    const empty = document.createElement("div");
    empty.className = "loading-box";
    empty.textContent = "ACTUALISEZ L'APPLICATION";
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
      : "OUVRIR LA RECHERCHE";

    const button = document.createElement("button");
    button.className = "watch-button";
    button.textContent = show.found ? "▶ REGARDER" : "▶ OUVRIR";
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

async function startApp() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("service-worker.js?v=7"); } catch (_) {}
  }

  appData = fallbackData();
  showHome();
  await loadData({quiet:true});
}

startApp();
  if (!shows.length) {
    const empty = document.createElement("div");
    empty.className = "loading-box";
    empty.textContent = "ACTUALISEZ L'APPLICATION";
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
      : "OUVRIR LA RECHERCHE";

    const button = document.createElement("button");
    button.className = "watch-button";
    button.textContent = show.found ? "▶ REGARDER" : "▶ OUVRIR";
    button.addEventListener("click", () => openPlayer(show));

    body.append(title, meta, button);
    card.append(thumbWrap, body);
    showsList.appendChild(card);
  });

  showOnly(channelView);
  window.scrollTo(0, 0);
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


// Explicit global functions used directly by the large HTML buttons.
window.openSection = function(section) {
  renderChannel(section);
};

window.goHome = function() {
  currentSection = null;
  showHome();
  window.scrollTo(0, 0);
};

window.refreshShows = function() {
  loadData();
};

window.closePlayer = closePlayer;

async function startApp() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("service-worker.js?v=81"); } catch (_) {}
  }

  appData = fallbackData();
  showHome();
  await loadData({quiet:true});
}

startApp();

  if (!shows.length) {
    const empty = document.createElement("div");
    empty.className = "loading-box";
    empty.textContent = "ACTUALISEZ L'APPLICATION";
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
      : "OUVRIR LA RECHERCHE";

    const button = document.createElement("button");
    button.className = "watch-button";
    button.textContent = show.found ? "▶ REGARDER" : "▶ OUVRIR";
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

async function startApp() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("service-worker.js?v=7"); } catch (_) {}
  }

  appData = fallbackData();
  showHome();
  await loadData({quiet:true});
}

startApp();
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
