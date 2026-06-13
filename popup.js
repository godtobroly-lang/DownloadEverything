"use strict";

// ── State ─────────────────────────────────────────────────────────────────────

let data = { images: [], mainImages: [], videos: [], mainVideos: [] };
let currentTab = "images";   // "images" | "videos"
let showMainOnly = true;     // true = principaux, false = tout
let pendingDownloadItems = null; // items waiting for folder confirmation

const $ = (id) => document.getElementById(id);

// ── Utilities ─────────────────────────────────────────────────────────────────

function filename(url) {
  try {
    const p = new URL(url).pathname;
    const name = p.substring(p.lastIndexOf("/") + 1).split("?")[0];
    return name || "media";
  } catch {
    return "media";
  }
}

function sanitizeFolder(raw) {
  return raw
    .trim()
    .replace(/\\/g, "/")            // normalize backslashes
    .replace(/\.\.+/g, "")         // no parent traversal
    .replace(/^\/+/, "")           // no leading slash
    .replace(/\/+$/, "")           // no trailing slash
    .replace(/[<>:"|?*]/g, "_")    // invalid chars
    .replace(/\/+/g, "/");         // collapse slashes
}

function buildFilename(url, folder) {
  const name = filename(url);
  if (!folder) return name;
  return `${folder}/${name}`;
}

function formatDims(w, h) {
  if (w && h) return `${w} × ${h} px`;
  return "";
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function showToast(msg, type = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = "toast hidden"), 3000);
}

// ── Folder persistence ────────────────────────────────────────────────────────

function loadSavedFolder() {
  chrome.storage.local.get("folder", ({ folder }) => {
    if (folder) {
      $("input-folder").value = folder;
      $("btn-clear-folder").style.display = "flex";
    }
  });
}

function saveFolder(folder) {
  chrome.storage.local.set({ folder });
}

function getCurrentFolder() {
  return sanitizeFolder($("input-folder").value);
}

// ── Download helpers ──────────────────────────────────────────────────────────

async function downloadOne(url, folder) {
  const fname = buildFilename(url, folder);
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename: fname, saveAs: false }, (id) => {
      resolve(id != null);
    });
  });
}

async function downloadBatch(items, folder) {
  let ok = 0;
  for (const item of items) {
    const success = await downloadOne(item.url, folder);
    if (success) ok++;
    await new Promise((r) => setTimeout(r, 150));
  }
  return ok;
}

// ── Folder modal ──────────────────────────────────────────────────────────────

function openFolderModal(itemsToDownload) {
  pendingDownloadItems = itemsToDownload;
  $("modal-folder-input").value = getCurrentFolder();
  $("modal-overlay").classList.remove("hidden");
  $("modal-folder-input").focus();
  $("modal-folder-input").select();
}

function closeFolderModal() {
  $("modal-overlay").classList.add("hidden");
  pendingDownloadItems = null;
}

async function confirmModalDownload() {
  const folder = sanitizeFolder($("modal-folder-input").value);
  closeFolderModal();

  // Sync back to main folder input
  $("input-folder").value = folder;
  $("btn-clear-folder").style.display = folder ? "flex" : "none";
  saveFolder(folder);

  if (!pendingDownloadItems) return;
  await executeBatchDownload(pendingDownloadItems, folder);
}

// ── Trigger download (with folder check) ─────────────────────────────────────

async function triggerDownload(items) {
  const folder = getCurrentFolder();
  if (!folder) {
    // Ask for folder before proceeding
    openFolderModal(items);
    return;
  }
  await executeBatchDownload(items, folder);
}

async function triggerSingleDownload(url, btnEl) {
  const folder = getCurrentFolder();

  async function doDownload(f) {
    btnEl.disabled = true;
    const ok = await downloadOne(url, f);
    if (ok) {
      btnEl.classList.add("done");
      btnEl.innerHTML = checkSvg();
    } else {
      btnEl.disabled = false;
      showToast("Erreur lors du téléchargement", "error");
    }
  }

  if (!folder) {
    // Show modal for single download too
    pendingDownloadItems = [{ url }];
    $("modal-folder-input").value = "";
    $("modal-overlay").classList.remove("hidden");
    $("modal-folder-input").focus();

    // Override confirm to handle single download
    $("btn-modal-confirm").onclick = async () => {
      const f = sanitizeFolder($("modal-folder-input").value);
      closeFolderModal();
      $("input-folder").value = f;
      $("btn-clear-folder").style.display = f ? "flex" : "none";
      saveFolder(f);
      await doDownload(f);
      // Restore normal confirm handler
      $("btn-modal-confirm").onclick = confirmModalDownload;
    };
  } else {
    await doDownload(folder);
  }
}

async function executeBatchDownload(items, folder) {
  const btn = $("btn-download-selected");
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;margin:0"></div> Téléchargement…`;

  const ok = await downloadBatch(items, folder);
  const dest = folder ? `Téléchargements/${folder}` : "Téléchargements";
  showToast(`${ok} fichier(s) → ${dest}`, "success");

  resetDownloadButton();
  // Deselect all
  document.querySelectorAll(".media-card").forEach((c) => {
    const chk = c.querySelector("input[type=checkbox]");
    if (chk) { chk.checked = false; c.classList.remove("selected"); }
  });
  updateSelectedCount();
}

function checkSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
}

function downloadSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
}

function resetDownloadButton() {
  const btn = $("btn-download-selected");
  btn.innerHTML = `${downloadSvg()} Télécharger (<span id="selected-count">0</span>)`;
  btn.disabled = true;
  $("chk-select-all").checked = false;
  $("chk-select-all").indeterminate = false;
}

// ── Selection helpers ─────────────────────────────────────────────────────────

function updateSelectedCount() {
  const checked = document.querySelectorAll(".media-card input[type=checkbox]:checked");
  const n = checked.length;
  const countEl = $("selected-count");
  if (countEl) countEl.textContent = n;
  $("btn-download-selected").disabled = n === 0;

  const total = document.querySelectorAll(".media-card input[type=checkbox]").length;
  const allChk = $("chk-select-all");
  allChk.indeterminate = n > 0 && n < total;
  allChk.checked = total > 0 && n === total;
}

// ── Render ────────────────────────────────────────────────────────────────────

function getDisplayItems() {
  const isImages = currentTab === "images";
  if (showMainOnly) {
    return {
      main: isImages ? data.mainImages : data.mainVideos,
      secondary: [],
    };
  }
  const all = isImages ? data.images : data.videos;
  const mainSet = new Set((isImages ? data.mainImages : data.mainVideos).map((i) => i.url));
  return {
    main: all.filter((i) => mainSet.has(i.url)),
    secondary: all.filter((i) => !mainSet.has(i.url)),
  };
}

function makeCard(item, isSecondary = false) {
  const isImage = currentTab === "images";
  const name = filename(item.url);

  const thumbHtml = isImage
    ? `<img src="${item.url}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<svg width=22 height=22 viewBox=&quot;0 0 24 24&quot; fill=none stroke=currentColor stroke-width=1.5 opacity=.4><rect x=3 y=3 width=18 height=18 rx=2/><circle cx=8.5 cy=8.5 r=1.5/><polyline points=&quot;21 15 16 10 5 21&quot;/></svg>'">`
    : item.poster
      ? `<img src="${item.poster}" alt="" loading="lazy"><div class="play-badge">▶</div>`
      : `<svg class="video-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`;

  let metaParts = [];
  if (isImage) {
    const rendered = item.renderedW && item.renderedH ? `${item.renderedW}×${item.renderedH}` : "";
    const natural = item.naturalW && item.naturalH ? `${item.naturalW}×${item.naturalH}` : "";
    if (rendered) metaParts.push(`affiché: ${rendered}`);
    if (natural && natural !== rendered) metaParts.push(`natif: ${natural}`);
  } else {
    const dur = formatDuration(item.duration);
    if (dur) metaParts.push(dur);
    if (item.renderedW && item.renderedH) metaParts.push(`${item.renderedW}×${item.renderedH}`);
  }

  const mainBadge = !isSecondary ? `<span class="main-star">★ principal</span>` : "";

  const card = document.createElement("div");
  card.className = "media-card" + (isSecondary ? " secondary" : "");

  card.innerHTML = `
    <input type="checkbox" data-url="${item.url}" />
    <div class="thumb-wrap">${thumbHtml}</div>
    <div class="media-info">
      <div class="media-name-row">
        <div class="media-name" title="${item.url}">${name}</div>
        ${mainBadge}
      </div>
      <div class="media-meta">${metaParts.join(" · ") || "media"}</div>
    </div>
    <button class="btn-dl" title="Télécharger">${downloadSvg()}</button>
  `;

  const chk = card.querySelector("input[type=checkbox]");
  chk.addEventListener("change", () => {
    card.classList.toggle("selected", chk.checked);
    updateSelectedCount();
  });

  const dlBtn = card.querySelector(".btn-dl");
  dlBtn.addEventListener("click", () => triggerSingleDownload(item.url, dlBtn));

  return card;
}

function sectionLabel(text, cls = "") {
  const el = document.createElement("div");
  el.className = `section-label ${cls}`;
  el.textContent = text;
  return el;
}

function renderList() {
  const list = $("media-list");
  list.innerHTML = "";

  const { main, secondary } = getDisplayItems();
  const total = main.length + secondary.length;

  if (total === 0) {
    list.innerHTML = `<div class="empty">
      <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Aucun média${showMainOnly ? " principal" : ""} trouvé.<br>
      ${showMainOnly && (currentTab === "images" ? data.images.length : data.videos.length) > 0
        ? `<small>Essayez "Tout voir" pour afficher tous les médias.</small>`
        : "<small>Actualisez la page et réessayez.</small>"}
    </div>`;
    resetDownloadButton();
    return;
  }

  if (main.length > 0) {
    if (secondary.length > 0) {
      list.appendChild(sectionLabel(`Principaux (${main.length})`, "main-label"));
    }
    main.forEach((item) => list.appendChild(makeCard(item, false)));
  }

  if (secondary.length > 0) {
    list.appendChild(sectionLabel(`Secondaires (${secondary.length})`, "secondary-label"));
    secondary.forEach((item) => list.appendChild(makeCard(item, true)));
  }

  updateSelectedCount();
}

function updateCounts() {
  $("count-main-images").textContent = data.mainImages.length;
  $("count-main-videos").textContent = data.mainVideos.length;
}

function updateToggleBtn() {
  const btn = $("btn-toggle-view");
  const label = $("toggle-label");
  if (showMainOnly) {
    label.textContent = "Principaux";
    btn.classList.remove("showing-all");
    btn.title = "Afficher tous les médias";
  } else {
    label.textContent = "Tout voir";
    btn.classList.add("showing-all");
    btn.title = "Revenir aux médias principaux";
  }
}

// ── Load media from active tab ────────────────────────────────────────────────

async function loadMedia() {
  $("media-list").innerHTML = `<div class="loading"><div class="spinner"></div>Analyse de la page…</div>`;
  resetDownloadButton();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    }).catch(() => {});

    const result = await chrome.tabs.sendMessage(tab.id, { action: "getMedia" });
    data = {
      images: result.images || [],
      mainImages: result.mainImages || [],
      videos: result.videos || [],
      mainVideos: result.mainVideos || [],
    };
    updateCounts();
    renderList();
  } catch {
    $("media-list").innerHTML = `<div class="empty">
      <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      Impossible d'analyser cette page.<br><small>Actualisez la page et réessayez.</small>
    </div>`;
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Tabs
document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    renderList();
  });
});

// Main/All toggle
$("btn-toggle-view").addEventListener("click", () => {
  showMainOnly = !showMainOnly;
  updateToggleBtn();
  renderList();
});

// Refresh
$("btn-refresh").addEventListener("click", loadMedia);

// Folder input
$("input-folder").addEventListener("input", (e) => {
  const val = e.target.value.trim();
  $("btn-clear-folder").style.display = val ? "flex" : "none";
  if (val) saveFolder(sanitizeFolder(val));
});

$("btn-clear-folder").addEventListener("click", () => {
  $("input-folder").value = "";
  $("btn-clear-folder").style.display = "none";
  saveFolder("");
});

// Select all
$("chk-select-all").addEventListener("change", (e) => {
  const checked = e.target.checked;
  document.querySelectorAll(".media-card").forEach((card) => {
    const chk = card.querySelector("input[type=checkbox]");
    if (chk) { chk.checked = checked; card.classList.toggle("selected", checked); }
  });
  updateSelectedCount();
});

// Download selected
$("btn-download-selected").addEventListener("click", async () => {
  const checked = document.querySelectorAll(".media-card input[type=checkbox]:checked");
  if (!checked.length) return;
  const items = Array.from(checked).map((chk) => ({ url: chk.dataset.url }));
  await triggerDownload(items);
});

// Modal
$("btn-modal-confirm").addEventListener("click", confirmModalDownload);
$("btn-modal-cancel").addEventListener("click", () => {
  closeFolderModal();
  // Restore normal confirm handler in case it was overridden by single-download path
  $("btn-modal-confirm").onclick = null;
  $("btn-modal-confirm").addEventListener("click", confirmModalDownload);
});
$("modal-folder-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-modal-confirm").click();
  if (e.key === "Escape") $("btn-modal-cancel").click();
});
$("modal-overlay").addEventListener("click", (e) => {
  if (e.target === $("modal-overlay")) $("btn-modal-cancel").click();
});

// ── Init ──────────────────────────────────────────────────────────────────────

updateToggleBtn();
loadSavedFolder();
loadMedia();
