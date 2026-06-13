"use strict";

// chrome.storage.session survives service-worker restarts within the browser
// session but is cleared when the browser closes.  We use it to map the
// chrome.downloads integer ID to our internal dl_ entry so progress events
// can be attributed to the right panel item even after a worker restart.
async function getMap() {
  const r = await chrome.storage.session.get("_dlMap");
  return r._dlMap || {};
}
async function saveMap(map) {
  await chrome.storage.session.set({ _dlMap: map });
}

// ── Message dispatch ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "bgDownload") {
    bgDownload(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep channel open for async response
  }
  if (msg.action === "bgCancel") {
    bgCancel(msg.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── Download ──────────────────────────────────────────────────────────────────

async function bgDownload({ id, url, filename }) {
  const key  = "dl_" + id;
  const name = (filename || url).split("/").pop().split("?")[0] || "media";

  await chrome.storage.local.set({
    [key]: { id, name, url, state: "queued", received: 0, total: 0, ts: Date.now() },
  });

  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename: filename || name, conflictAction: "uniquify", saveAs: false },
      async (downloadId) => {
        if (chrome.runtime.lastError || downloadId == null) {
          const err = chrome.runtime.lastError?.message || "Erreur de téléchargement";
          await chrome.storage.local.set({
            [key]: { id, name, url, state: "error", error: err, received: 0, total: 0, ts: Date.now() },
          });
          resolve({ ok: false });
          return;
        }
        const map = await getMap();
        map[String(downloadId)] = { key, id, name, url };
        await saveMap(map);
        await chrome.storage.local.set({
          [key]: { id, name, url, state: "fetching", received: 0, total: 0, ts: Date.now() },
        });
        resolve({ ok: true });
      }
    );
  });
}

// ── Cancel ────────────────────────────────────────────────────────────────────

async function bgCancel(id) {
  const map = await getMap();
  for (const [dlId, info] of Object.entries(map)) {
    if (info.id === id) {
      await new Promise((r) => chrome.downloads.cancel(Number(dlId), r));
      break;
    }
  }
}

// ── Progress / completion ─────────────────────────────────────────────────────

chrome.downloads.onChanged.addListener(async (delta) => {
  const map  = await getMap();
  const info = map[String(delta.id)];
  if (!info) return;

  const { key, id, name, url } = info;

  // State transitions take priority — handle them first and return.
  if (delta.state) {
    if (delta.state.current === "complete") {
      const [dl] = await chrome.downloads.search({ id: delta.id });
      const sz   = dl?.fileSize || dl?.bytesReceived || 0;
      await chrome.storage.local.set({
        [key]: { id, name, url, state: "done", received: sz, total: sz, ts: Date.now() },
      });
      const m = await getMap();
      delete m[String(delta.id)];
      await saveMap(m);
    } else if (delta.state.current === "interrupted") {
      const error = delta.error?.current || "Interrompu";
      await chrome.storage.local.set({
        [key]: { id, name, url, state: "error", error, received: 0, total: 0, ts: Date.now() },
      });
      const m = await getMap();
      delete m[String(delta.id)];
      await saveMap(m);
    }
    return;
  }

  // Progress update: bytesReceived or totalBytes changed.
  if (delta.bytesReceived != null || delta.totalBytes != null) {
    const [dl] = await chrome.downloads.search({ id: delta.id });
    if (!dl || dl.state !== "in_progress") return;
    await chrome.storage.local.set({
      [key]: {
        id, name, url, state: "fetching",
        received: dl.bytesReceived || 0,
        total:    dl.totalBytes > 0 ? dl.totalBytes : 0,
        ts: Date.now(),
      },
    });
  }
});
