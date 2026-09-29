"""Remove the paper from a signature photo: transparent PNG, ink recoloured, specks dropped, cropped."""
import sys, numpy as np
from PIL import Image
from scipy import ndimage

def clean(src, dst, strength=0.5, ink=(28, 36, 130), max_w=900):
    im = Image.open(src).convert('RGB'); a = np.asarray(im).astype(np.float32)
    L = 0.299*a[..., 0] + 0.587*a[..., 1] + 0.114*a[..., 2]
    S = a.max(2) - a.min(2)
    H, W = L.shape; B = max(16, round(max(W, H) / 40))
    bh, bw = -(-H // B), -(-W // B)
    med = np.zeros((bh, bw), np.float32)
    for by in range(bh):
        for bx in range(bw):
            med[by, bx] = np.percentile(L[by*B:(by+1)*B, bx*B:(bx+1)*B], 70)
    bg = np.maximum(ndimage.maximum_filter(med, size=3), 60)
    bgf = np.array(Image.fromarray(bg).resize((W, H), Image.BILINEAR))
    d = (bgf - L) / bgf + np.where(S > 45, 0.06, 0)
    thr = 0.10 + 0.26 * strength
    alpha = np.clip((d - thr) / (thr * 0.9), 0, 1)
    # ruled / dashed paper lines and photo borders: rows whose ink runs across most of the page width
    inkm = alpha > 0.3
    band = ndimage.maximum_filter1d(inkm, size=15, axis=0)          # tolerate slightly tilted lines
    line_rows = []
    for y in range(H):
        xs_ = np.nonzero(band[y])[0]
        if len(xs_) and (xs_.max() - xs_.min()) >= 0.7 * W and len(xs_) >= 0.25 * W:
            line_rows.append(y)
    if line_rows:
        rows = np.zeros(H, bool); rows[line_rows] = True
        rows = ndimage.binary_dilation(rows, iterations=5)
        vert = ndimage.binary_opening(inkm, structure=np.ones((7, 1)))   # strokes that cross the line keep their pixels
        vert = ndimage.binary_dilation(vert, iterations=1)
        kill = rows[:, None] & inkm & ~vert
        alpha2 = np.where(kill, 0, alpha)
        # re-join strokes the line removal cut through: refill killed pixels that have ink just above and below
        joined = ndimage.binary_closing(alpha2 > 0.3, structure=np.ones((9, 1)))
        alpha = np.where(kill & joined, alpha, alpha2)
    lab, n = ndimage.label(alpha > 0.3, structure=np.ones((3, 3)))
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
    keep_ids = [i + 1 for i, s in enumerate(sizes) if s >= max(10, sizes.sum() * 0.004)]
    # drop small marks lying well away from the main signature (stray dots on the paper)
    big = max(keep_ids, key=lambda i: sizes[i - 1])
    core = ndimage.binary_dilation(lab == big, iterations=int(max(W, H) * 0.06))
    keep = [i for i in keep_ids if sizes[i - 1] > sizes.sum() * 0.03 or (core & (lab == i)).any()]
    mask = np.isin(lab, keep)
    near = ndimage.binary_dilation(mask, iterations=1)
    out = np.where(near, alpha, 0)
    ys, xs = np.nonzero(out > 0.05)
    pad = int(max(np.ptp(xs), np.ptp(ys)) * 0.04) + 4
    y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + pad + 1); x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + pad + 1)
    crop = out[y0:y1, x0:x1]
    rgba = np.zeros(crop.shape + (4,), np.uint8); rgba[..., :3] = ink; rgba[..., 3] = (crop * 255).round()
    res = Image.fromarray(rgba, 'RGBA')
    if res.width > max_w: res = res.resize((max_w, round(res.height * max_w / res.width)), Image.LANCZOS)
    res.save(dst); return res.size, len(keep), n

if __name__ == '__main__':
    print(clean(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 0.5))
