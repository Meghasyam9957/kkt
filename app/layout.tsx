import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, Inter } from 'next/font/google';
import '@/styles/app.css';
import { BRAND } from '@/lib/shared/brand';
import { resolveBrandAssets } from '@/lib/server/brand/assets';

const display = Cormorant_Garamond({
  subsets: ['latin'], weight: ['500', '600', '700'],
  variable: '--font-display-loaded', display: 'swap',
});
const body = Inter({
  subsets: ['latin'], weight: ['400', '500', '600'],
  variable: '--font-body-loaded', display: 'swap',
});

/**
 * Metadata is generated rather than static so the favicon reflects what is actually on
 * disk. Pointing at an asset that has not been delivered would emit a 404 icon request on
 * every page load; omitting it lets the browser fall back to its default, which is the
 * graceful behaviour.
 */
export async function generateMetadata(): Promise<Metadata> {
  const assets = resolveBrandAssets();
  const metadata: Metadata = {
    title: `${BRAND.name} — Operations`,
    description: `Property operations and intelligence for ${BRAND.name}, ${BRAND.city}.`,
  };
  if (assets.mark) metadata.icons = { icon: assets.mark.src };
  return metadata;
}

export const viewport: Viewport = {
  /*
   * The colour a phone paints around the application, and it must be the colour the
   * application actually starts with.
   *
   * This was `#4F5F2C` — the dark olive of a navigation rail that no longer exists; the
   * stylesheet's own note records that the slab "read as a heavy admin tool" and was
   * removed. What survived was the metadata, so on Android Chrome and iOS Safari a cream
   * product was framed by a dark olive header nothing on screen matched.
   *
   * `--surface-page` is what `.sv-topbar` renders, so the frame and the first row of the
   * application are now the same colour and the seam disappears.
   */
  themeColor: '#FAF6EC',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
