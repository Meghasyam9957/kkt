import '@/lib/server/only';
/**
 * BRAND ASSET RESOLUTION.
 *
 * The logo is artwork the business supplies, not something this codebase draws. This
 * module answers one question for the renderer: *is the file actually there, and what
 * shape is it?*
 *
 * Why read the intrinsic size instead of hard-coding it: the file has not been delivered
 * yet, so any dimension written here would be a guess — and a guessed aspect ratio is
 * exactly how logos get stretched. Reading the PNG header (or the SVG viewBox) means the
 * ratio comes from the artwork itself, whatever the business ends up supplying.
 *
 * Absence is a normal state, not an error. Every caller gets `null` and renders the
 * typographic lockup instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BRAND_ASSET_SPECS, NO_BRAND_ASSETS,
  type BrandAsset, type BrandAssetSet, type BrandAssetRole,
} from '@/lib/shared/brand';

const PUBLIC_DIR = path.join(process.cwd(), 'public');

/* ------------------------------------------------------------------ *
 * Intrinsic dimensions
 * ------------------------------------------------------------------ */

/**
 * PNG: the IHDR chunk is always first, at a fixed offset — 8-byte signature, 4-byte
 * length, 4-byte type, then width and height as big-endian uint32.
 */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * SVG: prefer the viewBox — it is the true coordinate space, and a `width="100%"` on the
 * root element says nothing about proportion. Fall back to explicit px width/height.
 */
export function readSvgSize(source: string): { width: number; height: number } | null {
  const head = source.slice(0, 4000);

  const viewBox = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*["']/
    .exec(head);
  if (viewBox) {
    const width = Number(viewBox[3]);
    const height = Number(viewBox[4]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  // Static patterns rather than a built-from-a-string regex: the escaping in a dynamic
  // pattern is easy to get subtly wrong, and a silently non-matching regex here would
  // look exactly like "the file has no size".
  const WIDTH = /<svg\b[^>]*?\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i;
  const HEIGHT = /<svg\b[^>]*?\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i;
  const attr = (pattern: RegExp): number | null => {
    const m = pattern.exec(head);
    const value = m ? Number(m[1]) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const width = attr(WIDTH);
  const height = attr(HEIGHT);
  return width !== null && height !== null ? { width, height } : null;
}

/**
 * Measure one public asset. Exported so a test can prove the measurement is real —
 * that the ratio comes from the file rather than from a constant somewhere.
 */
export function measureBrandAsset(publicPath: string): BrandAsset | null {
  const file = path.join(PUBLIC_DIR, publicPath.replace(/^\//, ''));
  let buffer: Buffer;
  try {
    if (!fs.existsSync(file)) return null;
    buffer = fs.readFileSync(file);
  } catch {
    // Unreadable is the same as absent, as far as the renderer is concerned.
    return null;
  }
  if (buffer.length === 0) return null;

  const extension = path.extname(file).toLowerCase();
  const size = extension === '.png' ? readPngSize(buffer)
    : extension === '.svg' ? readSvgSize(buffer.toString('utf8'))
      : null;
  // A file we cannot measure is a file we cannot render without risking distortion.
  if (!size) return null;

  return {
    src: publicPath,
    width: size.width,
    height: size.height,
    aspectRatio: size.width / size.height,
  };
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

function resolveRole(role: BrandAssetRole): BrandAsset | null {
  for (const candidate of BRAND_ASSET_SPECS[role].candidates) {
    const asset = measureBrandAsset(candidate);
    if (asset) return asset;
  }
  return null;
}

let cache: BrandAssetSet | null = null;

/**
 * Resolve the brand asset set.
 *
 * Cached in production (the files cannot change under a running server) and re-read in
 * development, so dropping the artwork into `public/brand/` takes effect on the next
 * request without a restart.
 */
export function resolveBrandAssets(): BrandAssetSet {
  if (cache && process.env.NODE_ENV === 'production') return cache;
  const resolved: BrandAssetSet = { logo: resolveRole('logo'), mark: resolveRole('mark') };
  cache = resolved;
  return resolved;
}

/** Test seam — forget any cached resolution. */
export function __resetBrandAssetCache(): void {
  cache = null;
}

/** True when nothing has been delivered yet; the shell then runs on the fallback lockup. */
export function brandAssetsMissing(assets: BrandAssetSet = resolveBrandAssets()): boolean {
  return assets.logo === null && assets.mark === null;
}

export { NO_BRAND_ASSETS };
