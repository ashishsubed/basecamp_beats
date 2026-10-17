/**
 * Shrink guest/costume photos in the browser before upload.
 * Caps the long edge and writes JPEG so the slideshow is not 8–12MB originals.
 */
async function compressImageFile(file, opts) {
  const maxEdge = (opts && opts.maxEdge) || 1600;
  const quality = (opts && opts.quality) || 0.78;
  if (!file || !(file instanceof Blob)) return file;
  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      bitmap = await createImageBitmap(file);
    }
    const w = bitmap.width;
    const h = bitmap.height;
    if (!w || !h) return file;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return file;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return file;
    if (blob.size >= file.size && scale === 1 && file.type === 'image/jpeg') return file;
    const base = String(file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  } catch (_) {
    return file;
  }
}
