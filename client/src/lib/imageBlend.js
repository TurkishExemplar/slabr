import { API } from './api';

// Detect card/box images shot on a white or near-white background (sealed
// boxes, slabs photographed on white) and blend them cleanly into the UI.
//
// Mechanism: a probe image samples corners + edge midpoints on a small
// canvas.  When most are near-white, the rendered <img> gets the
// .img-white-bg class (mix-blend-mode: multiply) and its container a light
// backdrop — multiply needs a light surface behind it (against the app's
// near-black panels it would crush the whole image), and the result is the
// white product photo melting into a deliberate light tile.
//
// The PriceCharting CDN serves no CORS headers, so reading its pixels
// directly taints the canvas.  Remote images are probed through the
// same-origin /api/img proxy instead; data: URIs are probed directly.
// Any failure is silent — the image simply renders as-is.

const PROXYABLE_PREFIXES = [
  'https://storage.googleapis.com/images.pricecharting.com/',
  'https://i.ebayimg.com/',
];

function probeUrlFor(url) {
  if (url.startsWith('data:')) return url; // same-origin by definition
  if (PROXYABLE_PREFIXES.some(p => url.startsWith(p))) {
    return `${API}/api/img?url=${encodeURIComponent(url)}`;
  }
  return null; // unknown host — no safe way to read pixels
}

export function blendIfLightBackground(imgEl) {
  const url = imgEl?.currentSrc || imgEl?.src;
  if (!imgEl || !url || imgEl.dataset.blendChecked) return;
  imgEl.dataset.blendChecked = '1';

  const probeUrl = probeUrlFor(url);
  if (!probeUrl) return;

  const probe = new Image();
  probe.crossOrigin = 'anonymous';
  probe.onload = () => {
    try {
      const s = 16;
      const canvas = document.createElement('canvas');
      canvas.width = s;
      canvas.height = s;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(probe, 0, 0, s, s);
      const d = ctx.getImageData(0, 0, s, s).data;

      // Corners + edge midpoints — 8 samples beats 4 corners for boxes that
      // bleed to one edge
      const m = Math.floor(s / 2);
      const px = (x, y) => (y * s + x) * 4;
      const samples = [
        px(0, 0), px(s - 1, 0), px(0, s - 1), px(s - 1, s - 1),
        px(m, 0), px(m, s - 1), px(0, m), px(s - 1, m),
      ];
      const lightCount = samples.filter(i => d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225).length;

      if (lightCount >= 6) {
        imgEl.classList.add('img-white-bg');
        if (imgEl.parentElement) {
          imgEl.parentElement.style.backgroundColor = '#e4e4e7'; // zinc-200
        }
      }
    } catch {
      /* tainted canvas or decode failure — keep the image untouched */
    }
  };
  probe.onerror = () => { /* no probe, no blend */ };
  probe.src = probeUrl;
}
