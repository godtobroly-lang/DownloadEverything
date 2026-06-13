"use strict";

function collectMedia() {
  const vpW = window.innerWidth || 1280;
  const vpH = window.innerHeight || 720;
  const vpArea = vpW * vpH || 1;

  // Absolute minimum rendered dimensions to qualify as "main"
  const MAIN_MIN_LONG  = 350; // larger side must be >= this
  const MAIN_MIN_SHORT = 180; // smaller side must be >= this
  // Score threshold (% of viewport area, after bonuses/penalties)
  const MAIN_SCORE_THRESHOLD = 3.0;

  const SEMANTIC_SEL  = 'main, article, [role="main"], .post, .entry, .content, .article, figure, .hero, .banner, .story, .gallery-item, .product-image';
  const EXCLUSION_SEL = 'nav, footer, [role="navigation"], [role="contentinfo"], .nav, .footer, .sidebar, .widget, .ad, .advertisement';
  const UI_CLASS_PAT  = /\b(logo|icon|avatar|sprite|btn|button|thumb|emoji|badge|star|rating|flag|arrow|bullet|dot|menu|burger|close|search|social)\b/i;

  function abs(url) {
    if (!url) return null;
    try { return new URL(url, window.location.href).href; } catch { return null; }
  }

  // ── Image scoring ───────────────────────────────────────────────────────────

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

  // ── Collect images ──────────────────────────────────────────────────────────

  const imgMap = new Map();

  function addImg(url, extra, score) {
    const existing = imgMap.get(url);
    if (!existing || existing.score < score) {
      imgMap.set(url, { url, ...extra, score, isMain: score >= MAIN_SCORE_THRESHOLD });
    }
  }

  document.querySelectorAll("img").forEach((el) => {
    const src = el.currentSrc || el.src;
    if (!src || !src.startsWith("http")) return;
    const score = scoreImgEl(el);
    const rect = el.getBoundingClientRect();
    addImg(src, {
      alt: el.alt || "",
      renderedW: Math.round(rect.width),
      renderedH: Math.round(rect.height),
      naturalW: el.naturalWidth || 0,
      naturalH: el.naturalHeight || 0,
    }, score);
  });

  // CSS background images
  document.querySelectorAll("*").forEach((el) => {
    const bg = window.getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") return;
    for (const m of bg.matchAll(/url\(["']?(https?[^"')]+)["']?\)/g)) {
      const url = m[1];
      const score = scoreBgEl(el);
      const rect = el.getBoundingClientRect();
      addImg(url, {
        alt: "", renderedW: Math.round(rect.width), renderedH: Math.round(rect.height),
        naturalW: 0, naturalH: 0,
      }, score);
    }
  });

  // og:image / twitter:image → always main
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((meta) => {
    const url = meta.getAttribute("content");
    if (!url || !url.startsWith("http")) return;
    if (imgMap.has(url)) {
      imgMap.get(url).isMain = true;
      if (imgMap.get(url).score < 50) imgMap.get(url).score = 50;
    } else {
      addImg(url, { alt: "og:image", renderedW: 0, renderedH: 0, naturalW: 0, naturalH: 0 }, 50);
      imgMap.get(url).isMain = true;
    }
  });

  // <a> links to image files
  const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|svg)(\?.*)?$/i;
  const VIDEO_EXTS = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|ts|m3u8)(\?.*)?$/i;

  document.querySelectorAll("a[href]").forEach((a) => {
    const href = abs(a.href);
    if (!href || !href.startsWith("http")) return;
    if (IMAGE_EXTS.test(href) && !imgMap.has(href)) {
      addImg(href, { alt: a.textContent.trim().slice(0, 60), renderedW: 0, renderedH: 0, naturalW: 0, naturalH: 0 }, 0);
    }
  });

  // ── Collect videos ──────────────────────────────────────────────────────────

  const vidMap = new Map();

  function addVid(url, entry) {
    if (!url || !url.startsWith("http") || vidMap.has(url)) return;
    vidMap.set(url, entry);
  }

  document.querySelectorAll("video").forEach((el) => {
    const rect = el.getBoundingClientRect();
    const rw = rect.width, rh = rect.height;
    const score = (rw * rh / vpArea) * 100;
    const isMain = rw >= 200 && rh >= 100;

    const candidates = new Set();

    // Multiple ways a video source can be specified
    [el.src, el.currentSrc, el.getAttribute("src"), el.dataset.src, el.dataset.videoSrc]
      .map((s) => abs(s)).filter(Boolean).forEach((u) => candidates.add(u));

    el.querySelectorAll("source").forEach((s) => {
      [s.src, s.getAttribute("src"), s.dataset.src]
        .map((v) => abs(v)).filter(Boolean).forEach((u) => candidates.add(u));
    });

    // data-* attributes on the video element for common players
    Object.values(el.dataset).forEach((val) => {
      if (VIDEO_EXTS.test(val)) {
        const u = abs(val);
        if (u) candidates.add(u);
      }
    });

    candidates.forEach((url) => {
      if (url.startsWith("http")) {
        addVid(url, {
          url,
          poster: abs(el.poster) || "",
          duration: isFinite(el.duration) ? el.duration : 0,
          renderedW: Math.round(rw),
          renderedH: Math.round(rh),
          score,
          isMain,
        });
      }
    });
  });

  // og:video → always main
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]').forEach((meta) => {
    const url = abs(meta.getAttribute("content"));
    if (url && url.startsWith("http")) {
      addVid(url, { url, poster: "", duration: 0, renderedW: 0, renderedH: 0, score: 50, isMain: true });
    }
  });

  // JSON-LD VideoObject
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const parsed = JSON.parse(script.textContent);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      items.forEach((item) => {
        if (item["@type"] === "VideoObject" || item["@type"] === "Video") {
          const url = abs(item.contentUrl || item.embedUrl);
          if (url && url.startsWith("http")) {
            addVid(url, {
              url,
              poster: abs(item.thumbnailUrl || "") || "",
              duration: item.duration ? 0 : 0,
              renderedW: 0, renderedH: 0,
              score: 50, isMain: true,
            });
          }
        }
      });
    } catch {}
  });

  // <a> links to video files
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = abs(a.href);
    if (!href || !href.startsWith("http")) return;
    if (VIDEO_EXTS.test(href) && !vidMap.has(href)) {
      addVid(href, { url: href, poster: "", duration: 0, renderedW: 0, renderedH: 0, score: 0, isMain: false });
    }
  });

  const allImages = Array.from(imgMap.values()).sort((a, b) => b.score - a.score);
  const allVideos = Array.from(vidMap.values()).sort((a, b) => b.score - a.score);

  return {
    images: allImages,
    mainImages: allImages.filter((i) => i.isMain),
    videos: allVideos,
    mainVideos: allVideos.filter((v) => v.isMain),
    pageTitle: document.title,
    pageUrl: window.location.href,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getMedia") {
    sendResponse(collectMedia());
  }
  return true;
});
