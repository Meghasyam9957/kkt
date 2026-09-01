/**
 * Brand tokens — MAKAM Home Stays.
 *
 * The product was previously branded Srivillu; MAKAM is the current user-facing brand.
 * This object is the ONLY place the name is written — page titles, the shell, the
 * sign-in screen and the live business-name fallback all derive from it, so a future
 * rename is one edit here rather than a sweep.
 *
 * The palette is unchanged by the rename: it was sampled from the badge and re-approved
 * as the Verandah Ledger system, which is an internal design-system name and stays.
 * Confirm against the master artwork before print; if a brand guide exists, that wins.
 *
 * These are the ONLY places colour is defined. Components consume the tokens, never hex.
 */

export const BRAND = {
  name: 'MAKAM Home Stays',
  shortName: 'MAKAM',
  wordmark: 'MAKAM',
  tagline: 'Home Stays',
  city: 'Hyderabad',
} as const;

/** Core palette, sampled from the badge. */
export const BRAND_COLORS = {
  /** Deep olive green — the wordmark, arc and foliage. Primary brand colour. */
  green: '#4F5F2C',
  greenDark: '#3A4620',
  greenLight: '#6E8140',
  /** Ivory/cream field the badge sits on. The app's default page background. */
  cream: '#FAF6EC',
  creamDeep: '#F1EADA',
  /** Gold used for the diya flames and the divider ornament. Accent only — never body text. */
  gold: '#C9A227',
  goldLight: '#E0C46A',
  /** Terracotta roof tiles. Secondary accent, good for occupancy/warning states. */
  terracotta: '#B5651D',
  ink: '#2B2B26',
  inkMuted: '#6B6B60',
} as const;

/**
 * Semantic status colours for operational UI.
 *
 * Deliberately NOT the brand green: "available" must not be mistaken for branding, and an
 * operator scanning a board needs status colour to carry only one meaning. The brand green
 * stays for chrome and identity.
 */
export const STATUS_COLORS = {
  available: '#2F6B3A',
  occupied: '#2C5A8A',
  cleaning: '#8F5700',
  maintenance: '#A8322D',
  blocked: '#6B6B60',
  neutral: '#6B6B60',
} as const;

/**
 * Semantic status colours, warmed in Phase B (approved) to sit with olive and cream while
 * keeping each hue unmistakable. Every fg is >= 4.5:1 on cream, cream-deep and white.
 * One hue, one meaning — the brand palette never carries status, and vice versa.
 */
export const SEMANTIC_COLORS = {
  good: { fg: '#2F6B3A', bg: '#E9F1E4' },
  warn: { fg: '#8F5700', bg: '#FBF0D9' },
  bad: { fg: '#A8322D', bg: '#F8E3E0' },
  info: { fg: '#2C5A8A', bg: '#E6EDF5' },
} as const;

export const BRAND_TYPOGRAPHY = {
  /** The logo wordmark is a high-contrast serif; pair headings to it, not compete. */
  display: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
  body: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  /** Financial tables need aligned digits — tabular numerals are not optional here. */
  numeric: '"Inter", system-ui, sans-serif',
  numericFeatureSettings: '"tnum" 1, "lnum" 1',
} as const;

export const BRAND_ASSETS = {
  logo: '/brand/makam-logo.png',
  logoSvg: '/brand/makam-logo.svg',
  mark: '/brand/makam-mark.svg',
  ogImage: '/brand/og-image.png',
} as const;

/* ------------------------------------------------------------------ *
 * BRAND ASSET CONTRACT
 *
 * The artwork is supplied by the business; the app never redraws it. What the app owns is
 * *where* each file is expected, *which context* it serves, and what to show when the file
 * is not there. Those three things are the contract below.
 *
 * Sizing rule: every render pins HEIGHT and lets width follow the file's own intrinsic
 * ratio. That is what makes distortion structurally impossible rather than merely
 * avoided — no code path can set both dimensions independently.
 * ------------------------------------------------------------------ */

export type BrandAssetRole = 'logo' | 'mark';

export interface BrandAsset {
  /** Public URL, e.g. '/brand/makam-logo.png'. */
  src: string;
  /** Intrinsic pixel size read from the file itself. Used to reserve space (no CLS). */
  width: number;
  height: number;
  /** width ÷ height, from the file — never assumed. */
  aspectRatio: number;
}

export interface BrandAssetSet {
  /** Full lockup for large contexts: sidebar header, sign-in, print. Null when absent. */
  logo: BrandAsset | null;
  /** Compact mark: collapsed sidebar, mobile bar, favicon. Null when absent. */
  mark: BrandAsset | null;
}

/** Nothing available — the state the app runs in until the artwork is delivered. */
export const NO_BRAND_ASSETS: BrandAssetSet = { logo: null, mark: null };

/**
 * Where each file must be dropped, and which contexts it serves. `preferred` is tried
 * first (vector stays crisp at any size), then `fallbackSrc`, then the typographic lockup.
 */
export const BRAND_ASSET_SPECS = {
  logo: {
    role: 'logo' as const,
    /** Vector first when supplied; the PNG is the guaranteed master. */
    candidates: ['/brand/makam-logo.svg', '/brand/makam-logo.png'],
    contexts: ['sidebar header', 'sign-in screen', 'printed statements'],
    /**
     * Rendered height in the app shell, in px. Width follows the intrinsic ratio.
     *
     * Left at 40, which fits every context with room to spare: the widest demand is the
     * mobile drawer's brand row, where the 44px close control and a 12px gap share ~200px
     * with the lockup (the rail's scrollbar narrows it further than the 248px rail
     * suggests). At 40 the lockup is 120px and never shrinks, so the box always matches
     * the file's own 2048x682 ratio.
     *
     * Worth knowing when judging the result: the delivered wordmark carries ~35%
     * transparent padding above and below its letterforms, so only 29% of this height is
     * ink — about 12px on screen. Raising this number is the lever if the brand should
     * read larger, but the ceiling is ~47px before the drawer row starts squeezing it;
     * a tighter-cropped export would buy far more. Not changed here, because that is a
     * brand decision rather than a wiring one.
     */
    renderHeight: 40,
    minHeight: 28,
  },
  mark: {
    role: 'mark' as const,
    candidates: ['/brand/makam-mark.svg', '/brand/makam-mark.png'],
    contexts: ['collapsed sidebar', 'mobile top bar', 'favicon', 'avatar'],
    renderHeight: 28,
    minHeight: 16,
  },
} as const;
