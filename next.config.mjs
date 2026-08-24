/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { dirs: ['app', 'components', 'lib'] },
  env: {
    // Phase 4: fixtures only. Flipping this without a configured adapter must fail loudly,
    // never fall back to demo data silently (enforced in lib/data/providers/index.ts).
    NEXT_PUBLIC_LIVE_DATA_ENABLED: process.env.LIVE_DATA_ENABLED ?? 'false',
  },
};
export default nextConfig;
