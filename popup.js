"use strict";

// ── State ─────────────────────────────────────────────────────────────────────

let data = { images: [], mainImages: [], videos: [], mainVideos: [] };
let currentTab   = "images";
let showMainOnly = true;

// Single modal callback — avoids mixed onclick/addEventListener conflicts
let modalCallback = null;

const $ = (id) => document.getElementById(id);

// ── Utilities ─────────────────────────────────────────────────────────────────

function filename(url) {
  try {
    const p = new URL(url).pathname;
    let name = decodeURIComponent(p.substring(p.lastIndexOf("/") + 1).split("?")[0]);
    // Remove characters forbidden in filenames
    name = name.replace(/[<>:"|?*\\]/g, "_").trim();
    if (!name || !name.includes(".")) name = "media_" + Date.now();
    return name;
  } catch {
    return "media_" + Date.now();
  }
}

function sanitizeFolder(raw) {
  return (raw || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.\.+/g, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\/+/g, "/");
}

function buildFilename(url, folder) {
  const name = filename(url);
  return folder ? `${folder}/${name}` : name;
}

function formatDuration(sec) {
  if (!sec || !isFinite(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function showToast(msg, type = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = "toast hidden"; }, 3000);
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
  chrome.storage.local.set({ folder: folder || "" });
}

function getCurrentFolder() {
  return sanitizeFolder($("input-folder").value);
}

// ── Download ──────────────────────────────────────────────────────────────────

let _activeTabId = null;
async function getActiveTabId() {
  if (_activeTabId != null) return _activeTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  _activeTabId = tab?.id ?? null;
  return _activeTabId;
}

// Content-script fallback: triggers download inside the page context so the
// request carries the page's Referer and session cookies.
async function downloadViaContentScript(url, folder) {
  try {
    const tabId = await getActiveTabId();
    if (tabId == null) return false;
    const resp = await chrome.tabs.sendMessage(tabId, {
      action: "downloadViaLink",
      url,
      filename: buildFilename(url, folder),
    });
    return resp?.ok === true;
  } catch {
    return false;
  }
}

// Wait for a download to reach a terminal state (complete / interrupted).
// Resolves with true on success, false on failure.
// Times out after `ms` milliseconds and assumes success (avoids blocking forever).
function waitForDownload(id, ms = 60_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(true); // timed out — assume in progress / success
    }, ms);

    function listener(delta) {
      if (delta.id !== id) return;
      const state = delta.state?.current;
      if (state === "complete") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        resolve(true);
      } else if (state === "interrupted") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        resolve(false);
      }
    }

    chrome.downloads.onChanged.addListener(listener);
  });
}

async function downloadOne(url, folder) {
  // 1. Attempt chrome.downloads (supports folder targeting, shows in download bar).
  const { id, startErr } = await new Promise((resolve) => {
    chrome.downloads.download({
      url,
      filename: buildFilename(url, folder),
      saveAs: false,
      conflictAction: "uniquify",
    }, (id) => {
      resolve({ id, startErr: chrome.runtime.lastError?.message || null });
    });
  });

  if (startErr || id == null) {
    // Couldn't even start — go straight to fallback.
    return downloadViaContentScript(url, folder);
  }

  // 2. Monitor the download. chrome.downloads returns a valid id even when the
  //    server subsequently returns 404 — we must watch onChanged to detect that.
  const success = await waitForDownload(id);
  if (success) return true;

  console.warn("chrome.downloads interrupted for:", url, "— using content-script fallback");

  // 3. Fallback: page-context anchor click (correct Referer + cookies).
  //    Note: folder targeting is best-effort for cross-origin resources because
  //    browsers ignore the `download` attribute path for cross-origin URLs.
  return downloadViaContentScript(url, folder);
}

async function downloadBatch(items, folder) {
  let ok = 0;
  for (const item of items) {
    if (await downloadOne(item.url, folder)) ok++;
    await new Promise((r) => setTimeout(r, 200));
  }
  return ok;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openModal(prefill, cb) {
  modalCallback = cb;
  $("modal-folder-input").value = prefill;
  $("modal-overlay").classList.remove("hidden");
  setTimeout(() => {
    $("modal-folder-input").focus();
    $("modal-folder-input").select();
  }, 50);
}

function closeModal() {
  $("modal-overlay").classList.add("hidden");
  modalCallback = null;
}

// Central confirm handler — registered once
$("btn-modal-confirm").addEventListener("click", () => {
  if (!modalCallback) return;
  const folder = sanitizeFolder($("modal-folder-input").value);
  const cb = modalCallback;
  closeModal(); // clears modalCallback, but cb is already captured

  // Sync folder bar
  $("input-folder").value = folder;
  $("btn-clear-folder").style.display = folder ? "flex" : "none";
  saveFolder(folder);

  cb(folder);
});

$("btn-modal-cancel").addEventListener("click", closeModal);

$("modal-folder-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter")  $("btn-modal-confirm").click();
  if (e.key === "Escape") closeModal();
});

$("modal-overlay").addEventListener("click", (e) => {
  if (e.target === $("modal-overlay")) closeModal();
});

// ── Trigger helpers ───────────────────────────────────────────────────────────

async function triggerBatchDownload(items) {
  const folder = getCurrentFolder();
  if (!folder) {
    openModal("", async (f) => {
      await runBatch(items, f);
    });
    return;
  }
  await runBatch(items, folder);
}

async function runBatch(items, folder) {
  const btn = $("btn-download-selected");
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:13px;height:13px;border-width:2px;margin:0 2px 0 0"></div>Téléchargement…`;

  const ok = await downloadBatch(items, folder);
  const dest = folder ? `Téléchargements/${folder}` : "Téléchargements";
  showToast(`${ok} fichier(s) → ${dest}`, ok > 0 ? "success" : "error");

  resetBatchButton();
  // Deselect all cards
  document.querySelectorAll(".media-card").forEach((c) => {
    const chk = c.querySelector("input[type=checkbox]");
    if (chk) { chk.checked = false; c.classList.remove("selected"); }
  });
  updateSelectedCount();
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
      showToast("Erreur de téléchargement", "error");
    }
  }

  if (!folder) {
    openModal("", async (f) => { await doDownload(f); });
  } else {
    await doDownload(folder);
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────

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
  const isImg = currentTab === "images";
  if (showMainOnly) {
    return { main: isImg ? data.mainImages : data.mainVideos, secondary: [] };
  }
  const all = isImg ? data.images : data.videos;
  const mainUrls = new Set((isImg ? data.mainImages : data.mainVideos).map((i) => i.url));
  return {
    main:      all.filter((i) =>  mainUrls.has(i.url)),
    secondary: all.filter((i) => !mainUrls.has(i.url)),
  };
}

function makeCard(item, isSecondary) {
  const isImg  = currentTab === "images";
  const name   = filename(item.url);

  const thumbHtml = isImg
    ? `<img src="${item.url}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : item.poster
      ? `<img src="${item.poster}" alt="" loading="lazy"><div class="play-badge">▶</div>`
      : `<svg class="video-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
           <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
         </svg>`;

  const metaParts = [];
  if (isImg) {
    if (item.renderedW && item.renderedH) metaParts.push(`${item.renderedW}×${item.renderedH}`);
    if (item.naturalW && item.naturalH && `${item.naturalW}×${item.naturalH}` !== `${item.renderedW}×${item.renderedH}`)
      metaParts.push(`natif: ${item.naturalW}×${item.naturalH}`);
  } else {
    const dur = formatDuration(item.duration);
    if (dur) metaParts.push(dur);
    if (item.renderedW && item.renderedH) metaParts.push(`${item.renderedW}×${item.renderedH}`);
  }

  const card = document.createElement("div");
  card.className = "media-card" + (isSecondary ? " secondary" : "");

  card.innerHTML = `
    <input type="checkbox" data-url="${item.url}" />
    <div class="thumb-wrap">${thumbHtml}</div>
    <div class="media-info">
      <div class="media-name-row">
        <div class="media-name" title="${item.url}">${name}</div>
        ${!isSecondary ? `<span class="main-star">★</span>` : ""}
      </div>
      <div class="media-meta">${metaParts.join(" · ") || (isImg ? "image" : "vidéo")}</div>
    </div>
    <button class="btn-dl" title="Télécharger">${downloadSvg()}</button>
  `;

  card.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
    card.classList.toggle("selected", e.target.checked);
    updateSelectedCount();
  });

  card.querySelector(".btn-dl").addEventListener("click", (e) => {
    triggerSingleDownload(item.url, e.currentTarget);
  });

  return card;
}

function sectionLabel(text, cls) {
  const el = document.createElement("div");
  el.className = `section-label ${cls}`;
  el.textContent = text;
  return el;
}

function renderList() {
  const list = $("media-list");
  list.innerHTML = "";

  const { main, secondary } = getDisplayItems();

  if (main.length === 0 && secondary.length === 0) {
    const allCount = currentTab === "images" ? data.images.length : data.videos.length;
    const hint = showMainOnly && allCount > 0
      ? `<small>Essayez "Tout voir" pour afficher les ${allCount} médias détectés.</small>`
      : "<small>Actualisez la page et réessayez.</small>";
    list.innerHTML = `<div class="empty">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Aucun média${showMainOnly ? " principal" : ""} trouvé.<br>${hint}
    </div>`;
    resetBatchButton();
    return;
  }

  if (main.length > 0) {
    if (secondary.length > 0) list.appendChild(sectionLabel(`Principaux (${main.length})`, "main-label"));
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
  const btn   = $("btn-toggle-view");
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

// ── SVG helpers ───────────────────────────────────────────────────────────────

function checkSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
}

function downloadSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
}

function resetBatchButton() {
  const btn = $("btn-download-selected");
  btn.innerHTML = `${downloadSvg()} Télécharger (<span id="selected-count">0</span>)`;
  btn.disabled = true;
  $("chk-select-all").checked = false;
  $("chk-select-all").indeterminate = false;
}

// ── Load media ────────────────────────────────────────────────────────────────

async function loadMedia() {
  $("media-list").innerHTML = `<div class="loading"><div class="spinner"></div>Analyse de la page…</div>`;
  resetBatchButton();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    }).catch(() => {});

    const result = await chrome.tabs.sendMessage(tab.id, { action: "getMedia" });
    data = {
      images:     result.images     || [],
      mainImages: result.mainImages || [],
      videos:     result.videos     || [],
      mainVideos: result.mainVideos || [],
    };
    updateCounts();
    renderList();
  } catch (err) {
    $("media-list").innerHTML = `<div class="empty">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      Impossible d'analyser cette page.<br><small>Actualisez la page et réessayez.</small>
    </div>`;
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    renderList();
  });
});

$("btn-toggle-view").addEventListener("click", () => {
  showMainOnly = !showMainOnly;
  updateToggleBtn();
  renderList();
});

$("btn-refresh").addEventListener("click", loadMedia);

$("input-folder").addEventListener("input", (e) => {
  const val = e.target.value.trim();
  $("btn-clear-folder").style.display = val ? "flex" : "none";
  saveFolder(sanitizeFolder(val));
});

$("btn-clear-folder").addEventListener("click", () => {
  $("input-folder").value = "";
  $("btn-clear-folder").style.display = "none";
  saveFolder("");
});

$("chk-select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".media-card").forEach((card) => {
    const chk = card.querySelector("input[type=checkbox]");
    if (chk) { chk.checked = e.target.checked; card.classList.toggle("selected", e.target.checked); }
  });
  updateSelectedCount();
});

$("btn-download-selected").addEventListener("click", async () => {
  const checked = document.querySelectorAll(".media-card input[type=checkbox]:checked");
  if (!checked.length) return;
  const items = Array.from(checked).map((chk) => ({ url: chk.dataset.url }));
  await triggerBatchDownload(items);
});

// ── Init ──────────────────────────────────────────────────────────────────────

updateToggleBtn();
loadSavedFolder();
loadMedia();
