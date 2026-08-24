/**
 * GATE B — BRAND ASSET INTEGRATION.
 *
 * What these tests are actually protecting:
 *
 *   - the logo is never redrawn in code — when artwork exists it is rendered as a file,
 *     and the inline placeholder disappears entirely rather than being composited;
 *   - the aspect ratio comes from the FILE, so no layout change can stretch it;
 *   - a missing or broken asset degrades to the typographic lockup instead of a broken
 *     image icon, in both the server-detected and browser-failure cases.
 *
 * Where the real artwork is already present the tests measure THAT, rather than a
 * synthetic stand-in — so delivering the logo strengthens this suite instead of
 * bypassing it.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

import {
  readPngSize, readSvgSize, measureBrandAsset, resolveBrandAssets,
  __resetBrandAssetCache, brandAssetsMissing,
} from '@/lib/server/brand/assets';
import { BRAND, BRAND_ASSET_SPECS, NO_BRAND_ASSETS, type BrandAssetSet } from '@/lib/shared/brand';
import { SrivilluLogo, SrivilluMark } from '@/components/shell/Logo';

const ROOT = process.cwd();
const BRAND_DIR = path.join(ROOT, 'public', 'brand');

/** Minimal but structurally real PNG: signature + IHDR carrying the dimensions. */
function pngWithSize(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** Files this test created, removed afterwards. Real artwork is never touched. */
const created: string[] = [];

function placeIfAbsent(relativePath: string, contents: Buffer | string): boolean {
  const file = path.join(ROOT, 'public', relativePath.replace(/^\//, ''));
  if (fs.existsSync(file)) return false;          // real artwork present — leave it alone
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  created.push(file);
  return true;
}

beforeEach(() => { __resetBrandAssetCache(); });

afterEach(() => {
  cleanup();
  while (created.length) {
    const file = created.pop()!;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  __resetBrandAssetCache();
});

/* ================================================================== *
 * Intrinsic dimensions — the ratio comes from the artwork
 * ================================================================== */

describe('brand · intrinsic dimensions are read from the file', () => {
  it('reads width and height out of a PNG header', () => {
    expect(readPngSize(pngWithSize(1200, 400))).toEqual({ width: 1200, height: 400 });
    expect(readPngSize(pngWithSize(512, 512))).toEqual({ width: 512, height: 512 });
  });

  it('rejects anything that is not a measurable PNG', () => {
    expect(readPngSize(Buffer.alloc(0))).toBeNull();
    expect(readPngSize(Buffer.from('not a png at all, just text here'))).toBeNull();
    expect(readPngSize(pngWithSize(100, 50).subarray(0, 20))).toBeNull();   // truncated
    expect(readPngSize(pngWithSize(0, 0))).toBeNull();                      // nonsense size
  });

  it('prefers the SVG viewBox over the width attribute', () => {
    // A responsive logo often declares width="100%", which says nothing about proportion.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 320 96"></svg>';
    expect(readSvgSize(svg)).toEqual({ width: 320, height: 96 });
  });

  it('falls back to explicit pixel width and height', () => {
    expect(readSvgSize('<svg width="64px" height="48px"></svg>')).toEqual({ width: 64, height: 48 });
  });

  it('returns null when an SVG declares no usable size', () => {
    expect(readSvgSize('<svg width="100%" height="auto"></svg>')).toBeNull();
    expect(readSvgSize('<html><body>not an svg</body></html>')).toBeNull();
  });

  it('an unmeasurable file is treated as absent, not rendered blind', () => {
    // Rendering a file whose proportions we cannot determine is how logos get squashed.
    const placed = placeIfAbsent('/brand/srivillu-logo.png', Buffer.from('corrupt bytes'));
    if (!placed) return;                        // real artwork present; nothing to prove here
    expect(measureBrandAsset('/brand/srivillu-logo.png')).toBeNull();
  });

  it('measures a file that is actually on disk', () => {
    const placed = placeIfAbsent('/brand/srivillu-logo.png', pngWithSize(1024, 256));
    const asset = measureBrandAsset('/brand/srivillu-logo.png');
    expect(asset).not.toBeNull();
    if (placed) {
      expect(asset!.width).toBe(1024);
      expect(asset!.height).toBe(256);
      expect(asset!.aspectRatio).toBeCloseTo(4, 6);
    }
    // Whatever the file is, the ratio is derived from its own dimensions.
    expect(asset!.aspectRatio).toBeCloseTo(asset!.width / asset!.height, 9);
  });
});

/* ================================================================== *
 * Resolution — presence, candidate order, absence
 * ================================================================== */

describe('brand · asset resolution', () => {
  it('reports both roles as absent when nothing has been delivered', () => {
    const assets = resolveBrandAssets();
    const anyRealFileExists = ['srivillu-logo.png', 'srivillu-logo.svg', 'srivillu-mark.svg', 'srivillu-mark.png']
      .some((f) => fs.existsSync(path.join(BRAND_DIR, f)));
    if (anyRealFileExists) {
      // Artwork has been delivered — then resolution must FIND it.
      expect(brandAssetsMissing(assets)).toBe(false);
    } else {
      expect(assets.logo).toBeNull();
      expect(assets.mark).toBeNull();
      expect(brandAssetsMissing(assets)).toBe(true);
    }
  });

  it('prefers the vector logo when both formats are supplied', () => {
    const svgPlaced = placeIfAbsent('/brand/srivillu-logo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"></svg>');
    const pngPlaced = placeIfAbsent('/brand/srivillu-logo.png', pngWithSize(1200, 400));
    if (!svgPlaced || !pngPlaced) return;       // real artwork present; ordering not ours to assert

    __resetBrandAssetCache();
    const assets = resolveBrandAssets();
    expect(assets.logo?.src).toBe('/brand/srivillu-logo.svg');
    // The candidate list is the contract; the resolver must follow it in order.
    expect(BRAND_ASSET_SPECS.logo.candidates[0]).toBe('/brand/srivillu-logo.svg');
  });

  it('resolves the mark independently of the full logo', () => {
    const placed = placeIfAbsent('/brand/srivillu-mark.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>');
    __resetBrandAssetCache();
    const assets = resolveBrandAssets();
    expect(assets.mark).not.toBeNull();
    if (placed) expect(assets.mark!.aspectRatio).toBeCloseTo(1, 6);
  });

  it('the expected drop location is documented for whoever supplies the artwork', () => {
    const readme = fs.readFileSync(path.join(BRAND_DIR, 'README.md'), 'utf8');
    expect(readme).toContain('srivillu-logo.png');
    expect(readme).toContain('srivillu-mark.svg');
  });
});

/* ================================================================== *
 * Rendering — no distortion, no redrawing, graceful failure
 * ================================================================== */

const LOGO: BrandAssetSet = {
  logo: { src: '/brand/srivillu-logo.png', width: 1000, height: 250, aspectRatio: 4 },
  mark: { src: '/brand/srivillu-mark.svg', width: 64, height: 64, aspectRatio: 1 },
};

describe('brand · rendering', () => {
  it('renders the supplied artwork as an image, not as drawn shapes', () => {
    const { container } = render(<SrivilluLogo assets={LOGO} />);
    const img = container.querySelector('img.sv-logo__image') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('/brand/srivillu-logo.png');
    expect(img.getAttribute('alt')).toBe(BRAND.name);
    // The placeholder mark must be gone entirely — not hidden, not layered underneath.
    expect(container.querySelector('svg.sv-mark')).toBeNull();
  });

  it('pins height and leaves width automatic, so the file ratio always wins', () => {
    const { container } = render(<SrivilluLogo assets={LOGO} />);
    const img = container.querySelector('img.sv-logo__image') as HTMLImageElement;

    // Intrinsic size is declared, so the browser reserves the correct box before load.
    expect(img.getAttribute('width')).toBe('1000');
    expect(img.getAttribute('height')).toBe('250');

    expect(img.style.height).toBe(`${BRAND_ASSET_SPECS.logo.renderHeight}px`);
    expect(img.style.width).toBe('auto');
    expect(img.style.aspectRatio.replace(/\s/g, '')).toBe('1000/250');
  });

  it('uses the compact mark in compact contexts, never the full lockup scaled down', () => {
    const { container } = render(<SrivilluLogo assets={LOGO} compact />);
    const img = container.querySelector('img.sv-logo__image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/brand/srivillu-mark.svg');
    expect(img.style.height).toBe(`${BRAND_ASSET_SPECS.mark.renderHeight}px`);
    // The wordmark is not rendered at compact size — it would be illegible.
    expect(screen.queryByText(BRAND.tagline)).toBeNull();
  });

  it('falls back to the typographic lockup when nothing is delivered', () => {
    render(<SrivilluLogo assets={NO_BRAND_ASSETS} />);
    expect(screen.getByText(BRAND.wordmark)).toBeInTheDocument();
    expect(screen.getByText(BRAND.tagline)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: BRAND.name })).toBeInTheDocument();
  });

  it('defaults to the fallback when no assets prop is supplied at all', () => {
    render(<SrivilluLogo />);
    expect(screen.getByText(BRAND.wordmark)).toBeInTheDocument();
  });

  it('degrades in steps when a file fails to load in the browser', () => {
    const { container } = render(<SrivilluLogo assets={LOGO} />);

    // Step 1 — the full lockup fails. The wordmark becomes real text, and the mark (a
    // different file, which may well still be reachable) carries the identity.
    fireEvent.error(container.querySelector('img.sv-logo__image')!);
    expect(screen.getByText(BRAND.wordmark)).toBeInTheDocument();
    expect(screen.getByText(BRAND.tagline)).toBeInTheDocument();
    const remaining = container.querySelector('img.sv-logo__image') as HTMLImageElement;
    expect(remaining.getAttribute('src')).toBe('/brand/srivillu-mark.svg');

    // Step 2 — the mark fails too (the whole asset path is unreachable). Only now does
    // the drawn placeholder appear, and the brand is still legible as text.
    fireEvent.error(remaining);
    expect(container.querySelector('img.sv-logo__image')).toBeNull();
    expect(container.querySelector('svg.sv-mark')).not.toBeNull();
    expect(screen.getByText(BRAND.wordmark)).toBeInTheDocument();
  });

  it('the compact mark also degrades gracefully', () => {
    const { container } = render(<SrivilluMark size={24} assets={LOGO} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('svg.sv-mark')).not.toBeNull();
  });

  it('the fallback mark is a neutral placeholder, not a reconstruction of the badge', () => {
    const { container } = render(<SrivilluMark size={32} />);
    const svg = container.querySelector('svg.sv-mark')!;
    // A redrawn badge would need far more geometry than this. Keep it plainly a stand-in.
    expect(svg.querySelectorAll('path, circle, rect, polygon, ellipse').length).toBeLessThanOrEqual(6);
    expect(svg.getAttribute('viewBox')).toBe('0 0 40 40');
    expect(svg.getAttribute('aria-label')).toBe(BRAND.name);
  });

  it('the fallback uses palette tokens rather than hard-coded colour', () => {
    const { container } = render(<SrivilluMark size={32} />);
    const markup = container.innerHTML;
    expect(markup).toContain('var(--brand-');
    expect(markup).not.toMatch(/fill="#[0-9a-f]{3,6}"/i);
  });
});

/* ================================================================== *
 * Wiring — the favicon follows what is actually on disk
 * ================================================================== */

describe('brand · favicon wiring', () => {
  it('the root layout only declares an icon when the mark exists', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app', 'layout.tsx'), 'utf8');
    expect(source).toContain('resolveBrandAssets');
    // Conditional, so an undelivered asset does not become a 404 on every page load.
    expect(source).toMatch(/if\s*\(assets\.mark\)/);
  });

  it('the app shell passes resolved assets down rather than importing them itself', () => {
    const shell = fs.readFileSync(path.join(ROOT, 'components', 'shell', 'AppShell.tsx'), 'utf8');
    expect(shell).toContain('brandAssets');
    // A client component must not reach into the filesystem to find the artwork.
    expect(shell).not.toContain('lib/server/brand/assets');
  });
});
