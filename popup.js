"use strict";

let allImages = [];
let allVideos = [];
let currentTab = "images";
let minSize = 0;

const $ = (id) => document.getElementById(id);

// ── Utilities ──────────────────────────────────────────────────────────────

function filename(url) {
  try {
    const p = new URL(url).pathname;
    const name = p.substring(p.lastIndexOf("/") + 1).split("?")[0];
    return name || "media";
  } catch {
    return "media";
  }
}

function formatSize(w, h) {
  if (w && h) return `${w} × ${h}`;
  return "taille inconnue";
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function showToast(msg, type = "") {
  const toast = $("toast");
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toast.className = "toast hidden"), 3000);
}

// ── Download helpers ───────────────────────────────────────────────────────

async function downloadUrl(url, suggestedName) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename: suggestedName, saveAs: false }, (id) => {
      resolve(id != null);
    });
  });
}

async function downloadAll(items) {
  let ok = 0;
  for (const item of items) {
    const success = await downloadUrl(item.url, filename(item.url));
    if (success) ok++;
    // small delay to avoid flooding
    await new Promise((r) => setTimeout(r, 150));
  }
  return ok;
}

// ── Render ─────────────────────────────────────────────────────────────────

function filteredItems() {
  const items = currentTab === "images" ? allImages : allVideos;
  if (currentTab === "images" && minSize > 0) {
    return items.filter((it) => (it.width >= minSize || it.height >= minSize) || (it.width === 0 && it.height === 0));
  }
  return items;
}

function updateSelectedCount() {
  const checked = document.querySelectorAll(".media-card input[type=checkbox]:checked");
  const n = checked.length;
  $("selected-count").textContent = n;
  $("btn-download-selected").disabled = n === 0;

  const total = document.querySelectorAll(".media-card input[type=checkbox]").length;
  const allChk = $("chk-select-all");
  allChk.indeterminate = n > 0 && n < total;
  allChk.checked = total > 0 && n === total;
}

function renderList() {
  const list = $("media-list");
  const items = filteredItems();

  if (!items.length) {
    list.innerHTML = `<div class="empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Aucun média trouvé sur cette page.
    </div>`;
    $("btn-download-selected").disabled = true;
    $("chk-select-all").checked = false;
    $("selected-count").textContent = "0";
    return;
  }

  list.innerHTML = "";
  items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "media-card";
    card.dataset.idx = idx;

    const name = filename(item.url);
    const isImage = currentTab === "images";

    const thumbHtml = isImage
      ? `<img src="${item.url}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : item.poster
        ? `<img src="${item.poster}" alt="" loading="lazy"><div class="play-badge">▶</div>`
        : `<svg class="video-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
             <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
           </svg>`;

    const meta = isImage
      ? formatSize(item.width, item.height)
      : formatDuration(item.duration) || "vidéo";

    card.innerHTML = `
      <input type="checkbox" data-url="${item.url}" />
      <div class="thumb-wrap">${thumbHtml}</div>
      <div class="media-info">
        <div class="media-name" title="${item.url}">${name}</div>
        <div class="media-meta">${meta}</div>
      </div>
      <button class="btn-dl" data-url="${item.url}" title="Télécharger">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
    `;

    // checkbox toggle
    const chk = card.querySelector("input[type=checkbox]");
    chk.addEventListener("change", () => {
      card.classList.toggle("selected", chk.checked);
      updateSelectedCount();
    });

    // single download
    const dlBtn = card.querySelector(".btn-dl");
    dlBtn.addEventListener("click", async () => {
      dlBtn.disabled = true;
      const ok = await downloadUrl(item.url, name);
      if (ok) {
        dlBtn.classList.add("done");
        dlBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      } else {
        dlBtn.disabled = false;
        showToast("Erreur lors du téléchargement", "error");
      }
    });

    list.appendChild(card);
  });

  updateSelectedCount();
}

function updateCounts() {
  $("count-images").textContent = allImages.length;
  $("count-videos").textContent = allVideos.length;
}

// ── Load media from active tab ─────────────────────────────────────────────

async function loadMedia() {
  $("media-list").innerHTML = `<div class="loading"><div class="spinner"></div>Analyse de la page…</div>`;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Inject content script in case it missed (e.g. existing tabs before install)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    }).catch(() => {});

    const result = await chrome.tabs.sendMessage(tab.id, { action: "getMedia" });
    allImages = result.images || [];
    allVideos = result.videos || [];
    updateCounts();
    renderList();
  } catch (err) {
    $("media-list").innerHTML = `<div class="empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      Impossible d'analyser cette page.<br><small>Actualisez la page et réessayez.</small>
    </div>`;
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    renderList();
  });
});

$("btn-refresh").addEventListener("click", loadMedia);

$("min-size-filter").addEventListener("change", (e) => {
  minSize = parseInt(e.target.value, 10);
  renderList();
});

$("chk-select-all").addEventListener("change", (e) => {
  const checked = e.target.checked;
  document.querySelectorAll(".media-card").forEach((card) => {
    const chk = card.querySelector("input[type=checkbox]");
    chk.checked = checked;
    card.classList.toggle("selected", checked);
  });
  updateSelectedCount();
});

$("btn-download-selected").addEventListener("click", async () => {
  const checked = document.querySelectorAll(".media-card input[type=checkbox]:checked");
  if (!checked.length) return;

  const items = Array.from(checked).map((chk) => ({ url: chk.dataset.url }));
  $("btn-download-selected").disabled = true;
  $("btn-download-selected").textContent = `Téléchargement…`;

  const ok = await downloadAll(items);
  showToast(`${ok} fichier(s) téléchargé(s) !`, "success");

  // Reset button
  $("selected-count").textContent = "0";
  $("btn-download-selected").innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    Télécharger (<span id="selected-count">0</span>)
  `;
  $("btn-download-selected").disabled = true;
  $("chk-select-all").checked = false;
  document.querySelectorAll(".media-card").forEach((c) => {
    c.querySelector("input[type=checkbox]").checked = false;
    c.classList.remove("selected");
  });
});

// ── Init ───────────────────────────────────────────────────────────────────
loadMedia();
