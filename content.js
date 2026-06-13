function collectMedia() {
  const images = new Map();
  const videos = new Map();
  const pageUrl = window.location.href;

  // Collect <img> elements
  document.querySelectorAll("img").forEach((img) => {
    const src = img.src || img.currentSrc;
    if (src && src.startsWith("http") && !images.has(src)) {
      images.set(src, {
        url: src,
        alt: img.alt || "",
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
      });
    }
    // srcset
    if (img.srcset) {
      img.srcset.split(",").forEach((entry) => {
        const url = entry.trim().split(/\s+/)[0];
        if (url && url.startsWith("http") && !images.has(url)) {
          images.set(url, { url, alt: img.alt || "", width: 0, height: 0 });
        }
      });
    }
  });

  // Collect CSS background images
  document.querySelectorAll("*").forEach((el) => {
    const style = window.getComputedStyle(el);
    const bg = style.backgroundImage;
    if (bg && bg !== "none") {
      const matches = bg.matchAll(/url\(["']?(https?[^"')]+)["']?\)/g);
      for (const m of matches) {
        const url = m[1];
        if (!images.has(url)) {
          images.set(url, { url, alt: "", width: 0, height: 0 });
        }
      }
    }
  });

  // Collect <picture> / <source> elements
  document.querySelectorAll("source").forEach((source) => {
    const srcset = source.srcset || source.src;
    if (srcset) {
      srcset.split(",").forEach((entry) => {
        const url = entry.trim().split(/\s+/)[0];
        if (url && url.startsWith("http") && !images.has(url)) {
          images.set(url, { url, alt: "", width: 0, height: 0 });
        }
      });
    }
  });

  // Collect Open Graph / meta images
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((meta) => {
    const url = meta.getAttribute("content");
    if (url && url.startsWith("http") && !images.has(url)) {
      images.set(url, { url, alt: "og:image", width: 0, height: 0 });
    }
  });

  // Collect <video> elements
  document.querySelectorAll("video").forEach((video) => {
    const src = video.src || video.currentSrc;
    if (src && src.startsWith("http") && !videos.has(src)) {
      videos.set(src, {
        url: src,
        poster: video.poster || "",
        duration: video.duration || 0,
      });
    }
    video.querySelectorAll("source").forEach((source) => {
      const vsrc = source.src;
      if (vsrc && vsrc.startsWith("http") && !videos.has(vsrc)) {
        videos.set(vsrc, { url: vsrc, poster: video.poster || "", duration: video.duration || 0 });
      }
    });
  });

  // Collect <a> links pointing to media files
  const imageExts = /\.(jpg|jpeg|png|gif|webp|svg|avif|bmp|ico|tiff?)(\?.*)?$/i;
  const videoExts = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v)(\?.*)?$/i;
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href;
    if (!href || !href.startsWith("http")) return;
    if (imageExts.test(href) && !images.has(href)) {
      images.set(href, { url: href, alt: a.textContent.trim() || "", width: 0, height: 0 });
    } else if (videoExts.test(href) && !videos.has(href)) {
      videos.set(href, { url: href, poster: "", duration: 0 });
    }
  });

  return {
    images: Array.from(images.values()),
    videos: Array.from(videos.values()),
    pageTitle: document.title,
    pageUrl,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getMedia") {
    sendResponse(collectMedia());
  }
  return true;
});
