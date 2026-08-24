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
  themeColor: '#4F5F2C',
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
