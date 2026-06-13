"use strict";

// ── State ─────────────────────────────────────────────────────────────────────

let data = { images: [], mainImages: [], videos: [], mainVideos: [] };
let currentTab   = "images";
let showMainOnly = true;

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

async function getPageUrl() {
  const tabId = await getActiveTabId();
  if (tabId == null) return null;
  try { return (await chrome.tabs.get(tabId)).url || null; } catch { return null; }
}

// declarativeNetRequest injects the Referer at network layer so CDN hotlink
// checks pass for chrome.downloads requests.  We use per-host rule IDs
// (derived from a stable hash of the hostname) so up to RULE_ID_RANGE distinct
// CDN hosts can have live rules simultaneously during a batch download.
const RULE_ID_BASE  = 1037;
const RULE_ID_RANGE = 50; // rule IDs 1037 … 1086

function hostToRuleId(host) {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) & 0xffff;
  return RULE_ID_BASE + (h % RULE_ID_RANGE);
}

async function addRefererRule(host, referer) {
  const ruleId = hostToRuleId(host);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: referer },
        ],
      },
      condition: {
        requestDomains: [host],
        resourceTypes: ["xmlhttprequest", "media", "image", "other", "main_frame", "sub_frame"],
      },
    }],
  });
}

async function removeAllRefererRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const toRemove = existing
      .filter((r) => r.id >= RULE_ID_BASE && r.id < RULE_ID_BASE + RULE_ID_RANGE)
      .map((r) => r.id);
    if (toRemove.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: toRemove });
  } catch {}
}

function newDownloadId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function downloadOne(url, folder) {
  const pageUrl = await getPageUrl();
  let host = null;
  try { host = new URL(url).hostname; } catch {}

  // Inject Referer before the download request so CDN hotlink checks pass.
  if (host && pageUrl) await addRefererRule(host, pageUrl);

  const id   = newDownloadId();
  const full = buildFilename(url, folder);

  // Delegate the actual download to the background service worker which uses
  // chrome.downloads — no RAM accumulation, no popup-must-stay-open constraint,
  // and chrome.downloads handles filename deduplication automatically.
  const started = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "bgDownload", id, url, filename: full }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) { resolve(false); return; }
      resolve(true);
    });
  });

  return started;
}

async function downloadBatch(items, folder) {
  let ok = 0;
  for (const item of items) {
    if (await downloadOne(item.url, folder)) ok++;
    await new Promise((r) => setTimeout(r, 250));
  }
  return ok;
}

// ── Trigger helpers ───────────────────────────────────────────────────────────
// The folder bar at the top is the persistent destination; downloads always use
// it directly (saved in chrome.storage), so the user is never re-prompted.

async function triggerBatchDownload(items) {
  await runBatch(items, getCurrentFolder());
}

async function runBatch(items, folder) {
  const btn = $("btn-download-selected");
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:13px;height:13px;border-width:2px;margin:0 2px 0 0"></div>Téléchargement…`;

  const ok = await downloadBatch(items, folder);
  const dest = folder ? `Téléchargements/${folder}` : "Téléchargements";
  showToast(`${ok} téléchargement(s) lancé(s) → ${dest}`, ok > 0 ? "success" : "error");

  resetBatchButton();
  // Deselect all cards
  document.querySelectorAll(".media-card").forEach((c) => {
    const chk = c.querySelector("input[type=checkbox]");
    if (chk) { chk.checked = false; c.classList.remove("selected"); }
  });
  updateSelectedCount();
}

async function triggerSingleDownload(url, btnEl) {
  btnEl.disabled = true;
  const ok = await downloadOne(url, getCurrentFolder());
  if (ok) {
    btnEl.classList.add("done");
    btnEl.innerHTML = checkSvg();
  } else {
    btnEl.disabled = false;
    showToast("Erreur de téléchargement", "error");
  }
}

// ── Downloads status panel ──────────────────────────────────────────────────────

function formatBytes(b) {
  if (!b || b < 0) return "0 o";
  const u = ["o", "Ko", "Mo", "Go"];
  let n = b, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : (n < 10 ? 1 : 0))} ${u[i]}`;
}

const DL_STATE_LABEL = {
  queued:   "En attente…",
  fetching: "Téléchargement…",
  saving:   "Enregistrement…",
  done:     "Terminé",
  error:    "Échec",
};

function dlItemParts(e) {
  const pct   = e.total ? Math.min(100, Math.round((e.received / e.total) * 100)) : 0;
  const indet = (e.state === "fetching" || e.state === "queued") && !e.total;
  const badge = e.state === "done" ? "✓" : e.state === "error" ? "✕" : (e.total ? pct + "%" : "");
  const sub   = e.state === "error"
    ? (e.error || "Erreur")
    : e.total
      ? `${formatBytes(e.received)} / ${formatBytes(e.total)}`
      : (e.received ? formatBytes(e.received) : DL_STATE_LABEL[e.state] || "");
  const fillW = e.state === "done" ? 100 : pct;
  const active = e.state === "queued" || e.state === "fetching" || e.state === "saving";
  return { pct, indet, badge, sub, fillW, active };
}

function makeDlNode(e) {
  const { indet, badge, sub, fillW, active } = dlItemParts(e);

  const div = document.createElement("div");
  div.className = `dl-item state-${e.state}`;
  div.dataset.dlId = e.id;
  div.innerHTML = `
    <div class="dl-item-top">
      <span class="dl-name" title="${e.name}">${e.name}</span>
      <span class="dl-pct">${badge}</span>
      <button class="dl-cancel${active ? "" : " hidden"}" data-id="${e.id}" title="Annuler">✕</button>
    </div>
    <div class="dl-bar${indet ? " indeterminate" : ""}"><div class="dl-bar-fill" style="width:${fillW}%"></div></div>
    <div class="dl-sub">${sub}</div>`;
  return div;
}

function patchDlNode(node, e) {
  const { indet, badge, sub, fillW, active } = dlItemParts(e);

  node.className = `dl-item state-${e.state}`;
  const pctEl    = node.querySelector(".dl-pct");
  const barEl    = node.querySelector(".dl-bar");
  const fillEl   = node.querySelector(".dl-bar-fill");
  const subEl    = node.querySelector(".dl-sub");
  const cancelEl = node.querySelector(".dl-cancel");
  if (pctEl)    pctEl.textContent = badge;
  if (barEl)    barEl.classList.toggle("indeterminate", indet);
  if (fillEl)   fillEl.style.width = fillW + "%";
  if (subEl)    subEl.textContent = sub;
  if (cancelEl) cancelEl.classList.toggle("hidden", !active);
}

const EMPTY_DL_HTML = `<div class="empty">
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
  Aucun téléchargement pour l'instant.
</div>`;

// id → last-rendered entry snapshot (used to skip no-op patches)
const _dlRendered = new Map();

async function refreshDownloads() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.keys(all)
    .filter((k) => k.startsWith("dl_"))
    .map((k) => all[k])
    .filter(Boolean)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const list = $("dl-list");
  if (!list) return;

  if (entries.length === 0) {
    if (list.dataset.empty !== "1") {
      list.innerHTML = EMPTY_DL_HTML;
      list.dataset.empty = "1";
      _dlRendered.clear();
    }
  } else {
    list.dataset.empty = "0";

    // Determine whether the ordered id list has changed (add/remove/reorder)
    const renderedIds = [...list.querySelectorAll(".dl-item[data-dl-id]")].map((n) => n.dataset.dlId);
    const freshIds    = entries.map((e) => e.id);
    const sameOrder   = renderedIds.length === freshIds.length && freshIds.every((id, i) => id === renderedIds[i]);

    if (!sameOrder) {
      // Rebuild structure but reuse existing nodes where possible
      const nodeMap = new Map();
      list.querySelectorAll(".dl-item[data-dl-id]").forEach((n) => nodeMap.set(n.dataset.dlId, n));
      list.innerHTML = "";
      for (const e of entries) {
        const existing = nodeMap.get(e.id);
        if (existing) {
          patchDlNode(existing, e);
          list.appendChild(existing);
        } else {
          list.appendChild(makeDlNode(e));
        }
        _dlRendered.set(e.id, e);
      }
      // Remove stale cache entries
      for (const id of _dlRendered.keys()) {
        if (!freshIds.includes(id)) _dlRendered.delete(id);
      }
    } else {
      // Same items in same order — patch only what changed
      const nodes = list.querySelectorAll(".dl-item[data-dl-id]");
      entries.forEach((e, i) => {
        const prev = _dlRendered.get(e.id);
        if (!prev || prev.state !== e.state || prev.received !== e.received || prev.total !== e.total) {
          patchDlNode(nodes[i], e);
          _dlRendered.set(e.id, e);
        }
      });
    }
  }

  const active = entries.filter((e) => ["fetching", "saving", "queued"].includes(e.state)).length;
  const badge  = $("dl-active-count");
  if (badge) {
    badge.textContent = active;
    badge.classList.toggle("hidden", active === 0);
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
    if (item.isHLS) metaParts.push("HLS/DASH");
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

// Downloads panel
$("btn-downloads").addEventListener("click", () => {
  $("downloads-panel").classList.toggle("open");
  refreshDownloads();
});

$("btn-dl-close").addEventListener("click", () => {
  $("downloads-panel").classList.remove("open");
});

$("btn-dl-clear").addEventListener("click", async () => {
  const all  = await chrome.storage.local.get(null);
  const done = Object.keys(all).filter((k) => k.startsWith("dl_") && ["done", "error"].includes(all[k]?.state));
  if (done.length) await chrome.storage.local.remove(done);
  refreshDownloads();
});

// Cancel button — event delegation on the list so dynamic nodes work
$("dl-list").addEventListener("click", async (e) => {
  const btn = e.target.closest(".dl-cancel");
  if (!btn) return;
  const id = btn.dataset.id;
  // Optimistic UI update
  const r = await chrome.storage.local.get("dl_" + id);
  const entry = r["dl_" + id];
  if (entry && entry.state !== "done") {
    chrome.storage.local.set({ ["dl_" + id]: { ...entry, state: "error", error: "Annulé", ts: Date.now() } });
  }
  chrome.runtime.sendMessage({ action: "bgCancel", id });
});

// Auto-purge completed/failed entries older than 5 minutes
async function autopurge() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - 5 * 60 * 1000;
  const stale = Object.keys(all).filter((k) => {
    if (!k.startsWith("dl_")) return false;
    const e = all[k];
    return (e.state === "done" || e.state === "error") && (e.ts || 0) < cutoff;
  });
  if (stale.length) await chrome.storage.local.remove(stale);
}

// Live status updates — debounced so rapid storage writes (every 250ms from the
// content script) don't cause a full DOM rebuild on every tick.
let _dlRefreshTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!Object.keys(changes).some((k) => k.startsWith("dl_"))) return;
  clearTimeout(_dlRefreshTimer);
  _dlRefreshTimer = setTimeout(refreshDownloads, 200);
});

// ── Init ──────────────────────────────────────────────────────────────────────

// Clean up any Referer rules left over from a previous session
removeAllRefererRules();

autopurge();
updateToggleBtn();
loadSavedFolder();
loadMedia();
refreshDownloads();
