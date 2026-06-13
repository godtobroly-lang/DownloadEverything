"use strict";

// ── Media collection ──────────────────────────────────────────────────────────

function collectMedia() {
  const vpW = window.innerWidth || 1280;
  const vpH = window.innerHeight || 720;
  const vpArea = vpW * vpH || 1;

  const MAIN_MIN_LONG  = 350;
  const MAIN_MIN_SHORT = 180;
  const MAIN_SCORE_THRESHOLD = 3.0;

  const SEMANTIC_SEL  = 'main, article, [role="main"], .post, .entry, .content, .article, figure, .hero, .banner, .story, .gallery-item, .product-image';
  const EXCLUSION_SEL = 'nav, footer, [role="navigation"], [role="contentinfo"], .nav, .footer, .sidebar, .widget, .ad, .advertisement';
  const UI_CLASS_PAT  = /\b(logo|icon|avatar|sprite|btn|button|thumb|emoji|badge|star|rating|flag|arrow|bullet|dot|menu|burger|close|search|social)\b/i;

  // Common lazy-loading data attributes (lazyload.js, lozad, vanilla-lazyload, etc.)
  const LAZY_ATTRS        = ["data-src", "data-original", "data-lazy", "data-lazy-src",
                             "data-full-url", "data-large", "data-hi-res-src", "data-url"];
  const LAZY_SRCSET_ATTRS = ["data-srcset", "data-original-set", "data-lazy-srcset"];

  // Resolve any URL (relative or absolute) to an absolute http/https URL
  function abs(url) {
    if (!url || typeof url !== "string") return null;
    url = url.trim();
    if (!url) return null;
    try {
      const resolved = new URL(url, window.location.href).href;
      return resolved.startsWith("http") ? resolved : null;
    } catch {
      return null;
    }
  }

  // Pick the widest / highest-density source from an HTML srcset string
  function bestSrcset(srcset) {
    if (!srcset) return null;
    let best = null, bestW = 0;
    for (const part of srcset.split(",")) {
      const [u, d = ""] = part.trim().split(/\s+/);
      if (!u) continue;
      const w = d.endsWith("w") ? (parseInt(d) || 0) : (parseFloat(d) || 1) * 1000;
      if (w > bestW) { best = u; bestW = w; }
    }
    return best ? abs(best) : null;
  }

  // ── Image scoring ─────────────────────────────────────────────────────────

  function sizeOk(rw, rh) {
    return Math.max(rw, rh) >= MAIN_MIN_LONG && Math.min(rw, rh) >= MAIN_MIN_SHORT;
  }

  function applyContext(score, el) {
    try {
      if (el.closest(SEMANTIC_SEL))  score *= 1.4;
      if (el.closest(EXCLUSION_SEL)) score *= 0.2;
      if (el.closest("header") && el.getBoundingClientRect().width >= 500) score *= 1.2;
    } catch {}
    const classId = String(el.className || "") + " " + String(el.id || "");
    if (UI_CLASS_PAT.test(classId)) score *= 0.1;
    return score;
  }

  function scoreImgEl(el) {
    if (el.getAttribute("aria-hidden") === "true") return 0;
    if (el.getAttribute("role") === "presentation") return 0;
    const rect = el.getBoundingClientRect();
    if (!sizeOk(rect.width, rect.height)) return 0;
    return applyContext((rect.width * rect.height / vpArea) * 100, el);
  }

  function scoreBgEl(el) {
    if (el.getAttribute("aria-hidden") === "true") return 0;
    const rect = el.getBoundingClientRect();
    if (!sizeOk(rect.width, rect.height)) return 0;
    return applyContext((rect.width * rect.height / vpArea) * 100, el);
  }

  // ── Images ────────────────────────────────────────────────────────────────

  const imgMap = new Map();

  function addImg(url, extra, score) {
    if (!url) return;
    const existing = imgMap.get(url);
    if (!existing || existing.score < score) {
      imgMap.set(url, { url, ...extra, score, isMain: score >= MAIN_SCORE_THRESHOLD });
    }
  }

  function processImgEl(el) {
    const src   = abs(el.currentSrc || el.src);
    const score = scoreImgEl(el);
    const rect  = el.getBoundingClientRect();
    const extra = {
      alt:      el.alt || "",
      renderedW: Math.round(rect.width),
      renderedH: Math.round(rect.height),
      naturalW:  el.naturalWidth  || 0,
      naturalH:  el.naturalHeight || 0,
    };

    if (src) addImg(src, extra, score);

    // Best candidate from srcset (picks widest descriptor for higher resolution)
    const hires = bestSrcset(el.getAttribute("srcset") || "")
               || bestSrcset(el.getAttribute("data-srcset") || "");
    if (hires && hires !== src) addImg(hires, extra, score);

    // Lazy-load plain URL attrs
    for (const attr of LAZY_ATTRS) {
      const u = abs(el.getAttribute(attr));
      if (u && u !== src && u !== hires) addImg(u, extra, score);
    }

    // Lazy-load srcset attrs
    for (const attr of LAZY_SRCSET_ATTRS) {
      const h = bestSrcset(el.getAttribute(attr) || "");
      if (h && h !== src && h !== hires) addImg(h, extra, score);
    }
  }

  document.querySelectorAll("img").forEach(processImgEl);

  document.querySelectorAll("*").forEach((el) => {
    const bg = window.getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") return;
    for (const m of bg.matchAll(/url\(["']?(https?[^"')]+)["']?\)/g)) {
      const url = m[1];
      if (!url) continue;
      const score = scoreBgEl(el);
      const rect  = el.getBoundingClientRect();
      addImg(url, { alt: "", renderedW: Math.round(rect.width), renderedH: Math.round(rect.height), naturalW: 0, naturalH: 0 }, score);
    }
  });

  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((meta) => {
    const url = abs(meta.getAttribute("content"));
    if (!url) return;
    if (imgMap.has(url)) {
      imgMap.get(url).isMain = true;
      if (imgMap.get(url).score < 50) imgMap.get(url).score = 50;
    } else {
      addImg(url, { alt: "og:image", renderedW: 0, renderedH: 0, naturalW: 0, naturalH: 0 }, 50);
      if (imgMap.has(url)) imgMap.get(url).isMain = true;
    }
  });

  const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|svg)(\?.*)?$/i;
  const VIDEO_EXTS = /\.(mp4|webm|ogg|ogv|mov|avi|mkv|flv|wmv|m4v|ts|m3u8|mpd)(\?.*)?$/i;
  const HLS_PAT    = /\.(m3u8|mpd)(\?.*)?$/i;

  const STREAMING_PAGE_PAT = /\b(youtube\.com\/(watch|embed|shorts|live)|youtu\.be\/|player\.vimeo\.com\/|vimeo\.com\/(video\/\d+|channels|groups|album)|dailymotion\.com\/(video|embed\/video)|twitch\.tv\/|facebook\.com\/watch|instagram\.com\/reel)\b/i;

  function isStreamingPage(url) {
    return !VIDEO_EXTS.test(url) && STREAMING_PAGE_PAT.test(url);
  }

  document.querySelectorAll("a[href]").forEach((a) => {
    const href = abs(a.href);
    if (!href) return;
    if (IMAGE_EXTS.test(href) && !imgMap.has(href)) {
      addImg(href, { alt: a.textContent.trim().slice(0, 60), renderedW: 0, renderedH: 0, naturalW: 0, naturalH: 0 }, 0);
    }
  });

  // ── Videos ────────────────────────────────────────────────────────────────

  const vidMap = new Map();
  const fromVideoElement = new Set();

  function addVid(url, entry) {
    if (!url || isStreamingPage(url)) return;
    if (vidMap.has(url)) return;
    // HLS/DASH manifests (.m3u8, .mpd) are not standalone video files —
    // they're playlists. Detect but exclude from "Principaux" to avoid
    // misleading the user into downloading a text manifest.
    const isHLS = HLS_PAT.test(url);
    vidMap.set(url, { ...entry, url, ...(isHLS && { isHLS: true, isMain: false }) });
  }

  // --- <video> elements ---
  document.querySelectorAll("video").forEach((el) => {
    const rect     = el.getBoundingClientRect();
    const rw = rect.width, rh = rect.height;
    const score    = Math.max((rw * rh / vpArea) * 100, 10);
    const poster   = abs(el.poster) || abs(el.getAttribute("poster")) || "";
    const duration = isFinite(el.duration) ? el.duration : 0;
    const base     = { poster, duration, renderedW: Math.round(rw), renderedH: Math.round(rh), score, isMain: true };

    const raw = [
      el.getAttribute("src"), el.src, el.currentSrc,
      el.dataset.src, el.dataset.videoSrc, el.dataset.videoUrl,
      el.dataset.mp4, el.dataset.webm, el.dataset.hlsSrc,
      el.dataset.manifest, el.dataset.file, el.dataset.source,
      (() => {
        try { return JSON.parse(el.getAttribute("data-setup") || "{}").sources?.[0]?.src; } catch { return null; }
      })(),
    ];
    el.querySelectorAll("source").forEach((s) => {
      raw.push(s.getAttribute("src"), s.src, s.dataset.src, s.dataset.srcMp4, s.dataset.srcWebm);
    });

    const seen = new Set();
    raw.forEach((v) => {
      const u = abs(v);
      if (u && !seen.has(u)) { seen.add(u); fromVideoElement.add(u); addVid(u, base); }
    });
  });

  // --- og:video ---
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').forEach((meta) => {
    const url = abs(meta.getAttribute("content"));
    if (url && !isStreamingPage(url)) {
      addVid(url, { poster: "", duration: 0, renderedW: 0, renderedH: 0, score: 50, isMain: true });
    }
  });

  // --- JSON-LD VideoObject ---
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const parsed = JSON.parse(script.textContent);
      const items  = Array.isArray(parsed) ? parsed : [parsed];
      const check  = (item) => {
        if (!item || typeof item !== "object") return;
        const t = item["@type"];
        if (t === "VideoObject" || t === "Video") {
          [item.contentUrl, item.embedUrl].forEach((u) => {
            const r = abs(u);
            if (r) addVid(r, { poster: abs(item.thumbnailUrl) || "", duration: 0, renderedW: 0, renderedH: 0, score: 50, isMain: true });
          });
        }
        Object.values(item).forEach((v) => {
          if (Array.isArray(v)) v.forEach(check);
          else if (v && typeof v === "object") check(v);
        });
      };
      items.forEach(check);
    } catch {}
  });

  // --- Inline <script> tags: video URL literals ---
  const INLINE_VID_PAT = /["'`](https?:\/\/[^"'`\s]{4,}\.(mp4|webm|m3u8|mpd|ogg|ogv|mov|m4v|ts)(?:\?[^"'`\s]*)?)[`'"]/g;
  document.querySelectorAll("script:not([src])").forEach((script) => {
    for (const m of script.textContent.matchAll(INLINE_VID_PAT)) {
      const url = abs(m[1]);
      if (!url || vidMap.has(url)) continue;
      const isMain = fromVideoElement.has(url);
      addVid(url, { poster: "", duration: 0, renderedW: 0, renderedH: 0, score: isMain ? 10 : 5, isMain });
    }
  });

  // --- <a> links to video files ---
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = abs(a.href);
    if (href && VIDEO_EXTS.test(href) && !vidMap.has(href)) {
      addVid(href, { poster: "", duration: 0, renderedW: 0, renderedH: 0, score: 0, isMain: false });
    }
  });

  // ── Shadow DOM scan ───────────────────────────────────────────────────────
  // querySelectorAll does not cross shadow boundaries, so we walk each element
  // that exposes a shadowRoot and repeat the img/video scan inside it.

  document.querySelectorAll("*").forEach((host) => {
    const root = host.shadowRoot;
    if (!root) return;

    root.querySelectorAll("img").forEach(processImgEl);

    root.querySelectorAll("video").forEach((el) => {
      const rect     = el.getBoundingClientRect();
      const rw = rect.width, rh = rect.height;
      const score    = Math.max((rw * rh / vpArea) * 100, 10);
      const base     = {
        poster:    abs(el.poster) || "",
        duration:  isFinite(el.duration) ? el.duration : 0,
        renderedW: Math.round(rw), renderedH: Math.round(rh), score, isMain: true,
      };
      [el.getAttribute("src"), el.src, el.currentSrc].forEach((v) => {
        const u = abs(v);
        if (u) { fromVideoElement.add(u); addVid(u, base); }
      });
      el.querySelectorAll("source").forEach((s) => {
        const u = abs(s.src || s.getAttribute("src"));
        if (u) { fromVideoElement.add(u); addVid(u, base); }
      });
    });
  });

  // ── Results ───────────────────────────────────────────────────────────────

  const allImages = Array.from(imgMap.values()).sort((a, b) => b.score - a.score);
  const allVideos = Array.from(vidMap.values()).sort((a, b) => b.score - a.score);

  return {
    images:     allImages,
    mainImages: allImages.filter((i) => i.isMain),
    videos:     allVideos,
    mainVideos: allVideos.filter((v) => v.isMain),
    pageTitle:  document.title,
    pageUrl:    window.location.href,
  };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getMedia") {
    sendResponse(collectMedia());
    return true;
  }
});
