'use client';
/**
 * BRAND LOGO.
 *
 * Two rules govern this file.
 *
 * 1. The app never draws the logo. When the artwork is present it is rendered as-is;
 *    when it is absent a plainly typographic lockup stands in. The placeholder mark is a
 *    neutral shape in the brand palette — it is not, and must never become, a redrawing
 *    of the badge.
 *
 * 2. Height is pinned, width is never set. The intrinsic ratio comes from the file (see
 *    lib/server/brand/assets.ts), so the artwork cannot be stretched by a layout change.
 *
 * Failure handling is two-layered: the server reports whether the file exists (no flash
 * of fallback on a normal load), and `onError` catches the case where it exists at render
 * time but fails to load in the browser.
 */
import { useState } from 'react';
import { BRAND, BRAND_ASSET_SPECS, NO_BRAND_ASSETS, type BrandAsset, type BrandAssetSet } from '@/lib/shared/brand';

export interface LogoProps {
  /** Resolved server-side. Defaults to "nothing delivered", which renders the lockup. */
  assets?: BrandAssetSet;
  compact?: boolean;
}

export function SrivilluLogo({ assets = NO_BRAND_ASSETS, compact = false }: LogoProps) {
  // In the compact lockup only the mark shows, so that is the asset that matters there.
  const asset = compact ? assets.mark : assets.logo;
  const height = compact ? BRAND_ASSET_SPECS.mark.renderHeight : BRAND_ASSET_SPECS.logo.renderHeight;
  const [failed, setFailed] = useState(false);

  if (asset && !failed) {
    return (
      <span className={`sv-logo sv-logo--asset ${compact ? 'sv-logo--compact' : ''}`}>
        <BrandImage asset={asset} height={height} alt={BRAND.name} onFail={() => setFailed(true)} />
      </span>
    );
  }

  return (
    <span className={`sv-logo ${compact ? 'sv-logo--compact' : ''}`}>
      <SrivilluMark size={compact ? 28 : 36} assets={assets} />
      {!compact ? (
        <span className="sv-logo__text">
          <span className="sv-logo__word">{BRAND.wordmark}</span>
          <span className="sv-logo__tagline">{BRAND.tagline}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Compact mark for the collapsed sidebar, mobile header and favicon slot.
 * The full badge is illegible below ~48px, which is why this contract exists separately.
 */
export function SrivilluMark({ size = 32, assets = NO_BRAND_ASSETS }: {
  size?: number;
  assets?: BrandAssetSet;
}) {
  const [failed, setFailed] = useState(false);

  if (assets.mark && !failed) {
    return <BrandImage asset={assets.mark} height={size} alt={BRAND.name} onFail={() => setFailed(true)} />;
  }

  return (
    <svg
      width={size} height={size} viewBox="0 0 40 40" role="img"
      aria-label={BRAND.name} className="sv-mark"
    >
      <circle cx="20" cy="20" r="19" fill="var(--brand-cream)" stroke="var(--brand-green)" strokeWidth="1.5" />
      {/* Roofline and doorway — a neutral stand-in echoing the cottage in the badge. */}
      <path d="M11 20.5 L20 13 L29 20.5" fill="none" stroke="var(--brand-terracotta)"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 20.5 V28 H26.5 V20.5" fill="none" stroke="var(--brand-green)"
        strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="18" y="23" width="4" height="5" fill="var(--brand-green)" opacity="0.85" />
      <circle cx="20" cy="10" r="1.6" fill="var(--brand-gold)" />
    </svg>
  );
}

/**
 * The one place a brand file becomes a DOM element.
 *
 * A plain <img> rather than next/image: the source is a static public file of unknown
 * dimensions until it is delivered, and the optimiser adds nothing for a single small
 * logo while adding a build-time coupling to artwork that does not exist yet.
 *
 * `width`/`height` carry the file's real intrinsic size so the browser reserves the right
 * box before the image arrives; CSS then pins height and leaves width automatic, so the
 * rendered ratio is always the file's own.
 */
function BrandImage({ asset, height, alt, onFail }: {
  asset: BrandAsset;
  height: number;
  alt: string;
  onFail: () => void;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="sv-logo__image"
      src={asset.src}
      alt={alt}
      width={asset.width}
      height={asset.height}
      style={{ height: `${height}px`, width: 'auto', aspectRatio: `${asset.width} / ${asset.height}` }}
      onError={onFail}
    />
  );
}
