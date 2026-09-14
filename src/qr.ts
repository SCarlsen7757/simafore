import qrcode from 'qrcode-generator';
import { safeLink } from './urls.js';

const cache = new Map<string, string>();
const MAX_CACHE = 200;

/**
 * URL -> inline SVG string, memoized.
 *
 * Built as a single <path> with horizontal run-length merging rather than one
 * <rect> per module: that is ~26 kB -> ~3 kB per code, which matters because every
 * hero item's QR is inlined into the page. `currentColor` lets CSS own the colour.
 */
export function qrSvg(text: string | null | undefined): string {
  if (!text) return '';
  text = safeLink(text);
  if (!text) return '';
  const hit = cache.get(text);
  if (hit) return hit;

  const qr = qrcode(0, 'M'); // type 0 = auto-size for the payload
  try {
    qr.addData(text);
    qr.make();
  } catch {
    // Bad feed links must not prevent the rest of the snapshot from rendering.
    return '';
  }

  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let len = 1;
      while (c + len < n && qr.isDark(r, c + len)) len++;
      d += `M${c} ${r}h${len}v1h-${len}z`;
      c += len;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code linking to the official Siemens advisory">` +
    `<path d="${d}" fill="currentColor"/></svg>`;

  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(text, svg);
  return svg;
}
