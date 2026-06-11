// Detect card/box images shot on a white or near-white background (sealed
// boxes, slabs photographed on white) and blend them cleanly into the UI.
//
// Mechanism: a CORS-safe probe image samples the four corners on a small
// canvas.  When all corners are near-white, the rendered <img> gets
// mix-blend-multiply and its container a light backdrop — multiply needs a
// light surface behind it (against the app's near-black panels it would
// crush the whole image), and the result is the white product photo melting
// into a deliberate light tile instead of a harsh white rectangle.
//
// Failures (CORS-tainted canvas, broken probe) are silent: the image simply
// renders as-is.
export function blendIfLightBackground(imgEl) {
  const url = imgEl?.currentSrc || imgEl?.src;
  if (!imgEl || !url) return;

  const probe = new Image();
  probe.crossOrigin = 'anonymous';
  probe.onload = () => {
    try {
      const s = 12;
      const canvas = document.createElement('canvas');
      canvas.width = s;
      canvas.height = s;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(probe, 0, 0, s, s);
      const d = ctx.getImageData(0, 0, s, s).data;
      const corners = [0, (s - 1) * 4, s * (s - 1) * 4, (s * s - 1) * 4];
      const light = corners.every(i => d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225);
      if (light) {
        imgEl.classList.add('mix-blend-multiply');
        if (imgEl.parentElement) {
          imgEl.parentElement.style.backgroundColor = '#e4e4e7'; // zinc-200
        }
      }
    } catch {
      /* CORS-tainted canvas — keep the image untouched */
    }
  };
  probe.onerror = () => { /* no probe, no blend */ };
  probe.src = url;
}
