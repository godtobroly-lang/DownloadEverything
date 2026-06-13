"use strict";

function collectMedia() {
  const vpW = window.innerWidth || 1280;
  const vpH = window.innerHeight || 720;
  const vpArea = vpW * vpH || 1;

  // Minimum rendered size to qualify as "main"
  const MAIN_MIN_W = 150;
  const MAIN_MIN_H = 100;
  // Score threshold (% of viewport area, after bonuses/penalties)
  const MAIN_SCORE_THRESHOLD = 1.2;

  const SEMANTIC_SEL = 'main, article, [role="main"], .post, .entry, .content, .article, figure, .hero, .banner, .story, .gallery-item';
  const EXCLUSION_SEL = 'nav, footer, [role="navigation"], [role="contentinfo"], .nav, .footer, .sidebar, .widget, .ad, .advertisement';
  const UI_CLASS_PAT = /\b(logo|icon|avatar|sprite|btn|button|thumb|emoji|badge|star|rating|flag|arrow|bullet|dot|menu|burger|close|search|social)\b/i;

  // ── Image scoring ───────────────────────────────────────────────────────────

  function scoreImgEl(el) {
    if (el.getAttribute("aria-hidden") === "true") return 0;
    if (el.getAttribute("role") === "presentation") return 0;

    const rect = el.getBoundingClientRect();
    const rw = rect.width;
    const rh = rect.height;
    if (rw < MAIN_MIN_W || rh < MAIN_MIN_H) return 0;

    let score = (rw * rh / vpArea) * 100;

    try {
      if (el.closest(SEMANTIC_SEL)) score *= 1.5;
      if (el.closest(EXCLUSION_SEL)) score *= 0.2;
      // header is OK if image is large (hero)
      if (el.closest("header") && rw >= 400) score *= 1.2;
    } catch {}

    const classId = String(el.className || "") + " " + String(el.id || "");
    if (UI_CLASS_PAT.test(classId)) score *= 0.1;

    return score;
  }

  function scoreBgEl(el) {
    if (el.getAttribute("aria-hidden") === "true") return 0;
    const rect = el.getBoundingClientRect();
    const rw = rect.width;
    const rh = rect.height;
    if (rw < MAIN_MIN_W || rh < MAIN_MIN_H) return 0;

    let score = (rw * rh / vpArea) * 100;

    try {
      if (el.closest(SEMANTIC_SEL)) score *= 1.4;
      if (el.closest(EXCLUSION_SEL)) score *= 0.15;
    } catch {}

    const classId = String(el.className || "") + " " + String(el.id || "");
    if (UI_CLASS_PAT.test(classId)) score *= 0.1;

    return score;
  }

  // ── Collect images ──────────────────────────────────────────────────────────

  const imgMap = new Map();

  document.querySelectorAll("img").forEach((el) => {
    const src = el.currentSrc || el.src;
    if (!src || !src.startsWith("http")) return;

    const score = scoreImgEl(el);
    const rect = el.getBoundingClientRect();
    const entry = {
      url: src,
      alt: el.alt || "",
      renderedW: Math.round(rect.width),
      renderedH: Math.round(rect.height),
      naturalW: el.naturalWidth || 0,
      naturalH: el.naturalHeight || 0,
      score,
      isMain: score >= MAIN_SCORE_THRESHOLD,
    };

    if (!imgMap.has(src) || imgMap.get(src).score < score) {
      imgMap.set(src, entry);
    }

    // Best candidate from srcset
    if (el.currentSrc && el.currentSrc !== el.src && el.src && el.src.startsWith("http")) {
      // already captured currentSrc above
    }
  });

  // CSS background images
  document.querySelectorAll("*").forEach((el) => {
    const bg = window.getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") return;
    const matches = bg.matchAll(/url\(["']?(https?[^"')]+)["']?\)/g);
    for (const m of matches) {
      const url = m[1];
      const score = scoreBgEl(el);
      const rect = el.getBoundingClientRect();
      if (!imgMap.has(url) || imgMap.get(url).score < score) {
        imgMap.set(url, {
          url,
          alt: "",
          renderedW: Math.round(rect.width),
          renderedH: Math.round(rect.height),
          naturalW: 0,
          naturalH: 0,
          score,
          isMain: score >= MAIN_SCORE_THRESHOLD,
        });
      }
    }
  });

  // <picture> / <source> — use the img element score since <source> has no rect
  // (already captured via currentSrc on <img> above)

  // og:image / twitter:image — always "main"
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((meta) => {
    const url = meta.getAttribute("content");
    if (!url || !url.startsWith("http")) return;
    if (imgMap.has(url)) {
      imgMap.get(url).isMain = true;
      imgMap.get(url).score = Math.max(imgMap.get(url).score, 50);
    } else {
      imgMap.set(url, {
        url,
        alt: "og:image",
        renderedW: 0,
        renderedH: 0,
        naturalW: 0,
        naturalH: 0,
        score: 50,
        isMain: true,
      });
    }
  });

  // <a> href links pointing to image files — never auto-classified as main
  const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|svg)(\?.*)?$/i;
  const VIDEO_EXTS = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v)(\?.*)?$/i;

  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href;
    if (!href || !href.startsWith("http")) return;
    if (IMAGE_EXTS.test(href) && !imgMap.has(href)) {
      imgMap.set(href, {
        url: href,
        alt: a.textContent.trim().slice(0, 60),
        renderedW: 0,
        renderedH: 0,
        naturalW: 0,
        naturalH: 0,
        score: 0,
        isMain: false,
      });
    }
  });

  // ── Collect videos ──────────────────────────────────────────────────────────

  const vidMap = new Map();

  document.querySelectorAll("video").forEach((el) => {
    const rect = el.getBoundingClientRect();
    const rw = rect.width;
    const rh = rect.height;
    const score = (rw * rh / vpArea) * 100;
    const isMain = rw >= 200 && rh >= 100;

    const srcs = [];
    const cur = el.currentSrc || el.src;
    if (cur) srcs.push(cur);
    el.querySelectorAll("source[src]").forEach((s) => { if (s.src) srcs.push(s.src); });

    srcs
      .filter((s) => s.startsWith("http"))
      .forEach((url) => {
        if (!vidMap.has(url)) {
          vidMap.set(url, {
            url,
            poster: el.poster || "",
            duration: isFinite(el.duration) ? el.duration : 0,
            renderedW: Math.round(rw),
            renderedH: Math.round(rh),
            score,
            isMain,
          });
        }
      });
  });

  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href;
    if (!href || !href.startsWith("http")) return;
    if (VIDEO_EXTS.test(href) && !vidMap.has(href)) {
      vidMap.set(href, {
        url: href,
        poster: "",
        duration: 0,
        renderedW: 0,
        renderedH: 0,
        score: 0,
        isMain: false,
      });
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
