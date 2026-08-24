import '@/lib/server/only';
/**
 * LIVE SHEETS CONFIGURATION — the only place a Google credential is read.
 *
 * It lives under `lib/server/**` for a structural reason, not a stylistic one: the
 * security suite asserts that no client-reachable module mentions
 * `GOOGLE_SERVICE_ACCOUNT_*`. Keeping the read here means a component or a shared helper
 * cannot acquire the credential even by accident, and the browser bundle cannot contain
 * the code path that would.
 *
 * WHICH credential it reads is decided entirely by the resolved environment. DEMO reads
 * `DEMO_GOOGLE_*`; PRODUCTION reads `PRODUCTION_GOOGLE_*`. No code path reads the other
 * environment's variables, so "demo cannot open the production workbook" is a property of
 * the configuration shape rather than of a check somebody remembered to write.
 */
import { GoogleSheetsApiClient, type GoogleSheetsClient } from './client';
import type { EnvLike } from '@/lib/shared/env';
import { resolveEnvironment, requireSheets, type ResolvedEnvironment } from '@/lib/server/environment/config';

export interface LiveSheetsConfigStatus {
  configured: boolean;
  /** Which required variables are absent. Names only — never values. */
  missing: string[];
  /** Last six characters of the spreadsheet id, enough to confirm which workbook is in use. */
  spreadsheetIdSuffix: string | null;
  /** Which environment's workbook this describes. */
  environment: string;
}

export function liveSheetsConfigStatus(env: EnvLike = process.env): LiveSheetsConfigStatus {
  const resolved = resolveEnvironment(env);
  return {
    configured: resolved.sheets !== null,
    missing: resolved.missing.filter((name) => name.includes('GOOGLE')),
    spreadsheetIdSuffix: resolved.sheets ? resolved.sheets.spreadsheetId.slice(-6) : null,
    environment: resolved.descriptor.name,
  };
}

/**
 * Build the live client for the ACTIVE environment, or throw a message an operator can
 * act on.
 *
 * The failure is deliberately loud, and it never reaches for another environment's
 * credentials. A silent fall back — to fixtures, or worse, to the other environment's
 * workbook — is the one outcome worse than an outage.
 */
export function createLiveSheetsClient(
  envOrResolved: EnvLike | ResolvedEnvironment = process.env,
): GoogleSheetsClient {
  const resolved = isResolved(envOrResolved) ? envOrResolved : resolveEnvironment(envOrResolved);
  const credentials = requireSheets(resolved);
  return new GoogleSheetsApiClient({
    spreadsheetId: credentials.spreadsheetId,
    serviceAccountJsonBase64: credentials.serviceAccountJsonBase64,
  });
}

function isResolved(value: EnvLike | ResolvedEnvironment): value is ResolvedEnvironment {
  return typeof (value as ResolvedEnvironment).env === 'string'
    && 'descriptor' in (value as ResolvedEnvironment);
}
