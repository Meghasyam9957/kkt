'use client';
/**
 * The error boundary, for the same reason as `not-found.tsx`.
 *
 * Next's built-in error screen carries the same `prefers-color-scheme: dark` inline styles,
 * so an unhandled render error dropped an operator onto a black page. This keeps them inside
 * the product: same tokens, same brand, and a way forward.
 *
 * IT SHOWS NO DIAGNOSTIC. `error.message` from a server component can carry an upstream
 * detail, and this file has no way to know whether a given message is one the product
 * authored or one Postgres did — the same rule `safeReason` applies on the audit trail. The
 * digest is shown because it is exactly what somebody needs to quote to find the log line,
 * and it reveals nothing on its own.
 */
import { useEffect } from 'react';

export default function AppError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server log is where the detail belongs; the screen gets the reference only.
    console.error('[app] unhandled error:', error);
  }, [error]);

  return (
    <main className="sv-signin">
      <div className="sv-signin__card">
        <p className="sv-signin__meta">Something went wrong</p>
        <h1 className="sv-signin__title">This screen didn’t load</h1>
        <p className="sv-signin__lead">
          Nothing you were doing has been saved or changed. Try again — if it keeps
          happening, quote the reference below.
        </p>
        {error.digest ? (
          <p className="sv-signin__meta">
            Reference <code className="numeric">{error.digest}</code>
          </p>
        ) : null}
        <p>
          <button type="button" className="sv-btn sv-btn--primary" onClick={reset}>
            Try again
          </button>
        </p>
      </div>
    </main>
  );
}
