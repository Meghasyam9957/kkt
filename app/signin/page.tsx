/**
 * SIGN IN.
 *
 * Which form appears is decided entirely on the server. In production there is exactly one
 * option — Supabase email and password — and the demonstration chooser is not rendered,
 * not disabled: the branch that produces it is unreachable.
 *
 * In demo, before the Supabase project exists, the chooser lets a demonstrator pick who
 * they are presenting as. It asks for no password because there is nothing to protect: the
 * data behind every one of these accounts is fictional.
 */
import Link from 'next/link';
import { resolveEnvironment, publicEnvironmentInfo } from '@/lib/server/environment/config';
import { authMode, supabaseStatus } from '@/lib/server/auth/shell-session';
import { DEMO_IDENTITIES } from '@/lib/server/auth/demo-identities';
import { isLiveDataEnabled } from '@/lib/data/providers';
import { resolveBrandAssets } from '@/lib/server/brand/assets';
import { MakamLogo } from '@/components/shell/Logo';

const ERRORS: Record<string, string> = {
  invalid: 'That email address and password combination was not accepted.',
  'missing-credentials': 'Enter both an email address and a password.',
  'unknown-identity': 'That demonstration account does not exist.',
  'anon-key-missing': 'Supabase is configured but its anon key is not set, so password '
    + 'sign-in cannot run. Set the SUPABASE_ANON_KEY variable for this environment.',
};

/**
 * Never statically generated. Every page in this tree depends on the signed-in session and,
 * in demo, on mutable server state — prerendering one would bake in a stranger's view of
 * the application at build time.
 */
export const dynamic = 'force-dynamic';

export default function SignInPage({ searchParams }: { searchParams: { error?: string } }) {
  const resolved = resolveEnvironment();
  const environment = publicEnvironmentInfo(resolved, !isLiveDataEnabled());
  const mode = authMode();
  const supabase = supabaseStatus();
  const brandAssets = resolveBrandAssets();
  const error = searchParams.error ? ERRORS[searchParams.error] ?? 'Sign-in failed.' : null;

  return (
    <main className="sv-signin">
      <div className="sv-signin__card">
        <div className="sv-signin__brand">
          <MakamLogo assets={brandAssets} />
        </div>

        {environment.banner ? (
          <p className="sv-signin__banner">
            <span className="sv-demo-badge">{environment.banner}</span>
            <span>Fictional demonstration data. No real guest, investor or payment information.</span>
          </p>
        ) : null}

        <h1 className="sv-signin__title">Sign in</h1>
        <p className="sv-signin__meta">
          Environment <strong>{environment.name}</strong> · Data source {environment.dataSourceLabel}
        </p>

        {error ? <p className="sv-signin__error" role="alert">{error}</p> : null}

        {mode === 'demo-identity' ? (
          <>
            <p className="sv-signin__lead">
              Choose the account to demonstrate as. No password — these accounts guard
              nothing, because everything behind them is fictional.
            </p>
            <ul className="sv-signin__identities">
              {DEMO_IDENTITIES.map((identity) => (
                <li key={identity.key}>
                  <form method="post" action="/api/session">
                    <input type="hidden" name="identity" value={identity.key} />
                    <button type="submit" className="sv-signin__identity">
                      <span className="sv-signin__identity-name">{identity.name}</span>
                      <span className="sv-signin__identity-role">
                        {identity.role.replace('_', ' ')}
                        {identity.investorId ? ` · ${identity.investorId}` : ''}
                      </span>
                      <span className="sv-signin__identity-purpose">{identity.purpose}</span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            <p className="sv-signin__note">
              Once the {supabase.environment.toLowerCase()} Supabase project is configured,
              this chooser is replaced by real authentication and passwords are set through
              Supabase&rsquo;s own invitation flow.
            </p>
          </>
        ) : (
          <form method="post" action="/api/session" className="sv-signin__form">
            <label className="sv-field">
              <span className="sv-field__label">Email address</span>
              <input className="sv-field__input" type="email" name="email" autoComplete="username" required />
            </label>
            <label className="sv-field">
              <span className="sv-field__label">Password</span>
              <input
                className="sv-field__input" type="password" name="password"
                autoComplete="current-password" required
              />
            </label>
            <button type="submit" className="sv-btn sv-btn--primary">Sign in</button>
            {!supabase.configured ? (
              <p className="sv-signin__error" role="alert">
                Supabase is not configured for {supabase.environment}. Missing:{' '}
                {supabase.missing.join(', ')}. Sign-in cannot succeed until these are set.
              </p>
            ) : null}
          </form>
        )}

        <p className="sv-signin__foot">
          <Link href="/admin">Return to the dashboard</Link>
        </p>
      </div>
    </main>
  );
}
