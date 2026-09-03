/**
 * 404 — MAKAM's own, because the framework's is a dark page.
 *
 * Next ships a default not-found screen whose inline stylesheet carries
 * `@media (prefers-color-scheme: dark) { body { color: #fff; background: #000 } }`. In a
 * product that is now light by construction, that meant one mistyped URL dropped a visitor
 * whose operating system prefers dark onto a pure-black page with no brand, no navigation
 * and no way back — the single largest dark surface left anywhere in MAKAM, and the one
 * nobody sees until something has already gone wrong.
 *
 * This is a route, not a redesign: it reads the same tokens as every other surface, so it
 * follows the theme rather than declaring one.
 */
import Link from 'next/link';

export const metadata = { title: 'Page not found — MAKAM Home Stays' };

export default function NotFound() {
  return (
    <main className="sv-signin">
      <div className="sv-signin__card">
        <p className="sv-signin__meta">404 · Page not found</p>
        <h1 className="sv-signin__title">This page isn’t here</h1>
        <p className="sv-signin__lead">
          The address may have changed, or the record it pointed at may have been closed.
          Nothing has been altered.
        </p>
        <p>
          <Link className="sv-btn sv-btn--primary" href="/admin/dashboard">
            Back to the dashboard
          </Link>
        </p>
      </div>
    </main>
  );
}
