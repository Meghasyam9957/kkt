/**
 * Where LIVE parity gets its workbook id and its credential.
 *
 * Two rules shape this module:
 *
 *  1. **The workbook identifier is parity-specific.** `PARITY_SHEET_ID`, not a generic
 *     `GOOGLE_SHEET_ID` that a deployment script might already have set to production.
 *     A variable that only parity reads cannot be pointed at the real workbook by
 *     accident.
 *  2. **Nothing here is ever logged.** The private key is decoded and passed on; the only
 *     things printed anywhere are the service-account email (not secret — the operator
 *     needs it to share the sheet) and the last six characters of the spreadsheet id.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Accepted names, most-preferred first. The legacy names still work, and say so. */
export const ENV_NAMES = {
  sheetId: ['PARITY_SHEET_ID', 'GOOGLE_SHEET_ID'],
  keyFile: ['PARITY_SERVICE_ACCOUNT_FILE'],
  keyBase64: ['PARITY_SERVICE_ACCOUNT_JSON_BASE64', 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64'],
  /** Set these and the refusal below becomes structural rather than a judgement call. */
  forbiddenSheetIds: ['PRODUCTION_GOOGLE_SHEET_ID', 'DEMO_GOOGLE_SHEET_ID'],
  titleOverride: 'PARITY_TITLE_CONFIRMED_NOT_PRODUCTION',
};

/**
 * A plain string map. Typed explicitly rather than as Node's `ProcessEnv`, so tests can
 * pass a small object instead of having to fake the whole environment.
 *
 * @typedef {Record<string, string | undefined>} EnvLike
 */

/** @param {readonly string[]} names @param {EnvLike} env */
const first = (names, env) => {
  for (const name of names) {
    const value = (env[name] ?? '').trim();
    if (value) return { name, value };
  }
  return null;
};

/** Last six characters only — enough to tell two workbooks apart, useless on its own. */
export const maskSheetId = (id) => (id ? `…${id.slice(-6)}` : '(none)');

/**
 * Resolve the parity workbook id and service-account credential.
 *
 * Returns `{ configured, sheetId, credentials, problems, notes, base64 }`.
 * `configured: false` means the operator has not set parity up yet — a reported state,
 * not an error. `problems` is non-empty only when something IS set and is wrong.
 *
 * @param {EnvLike} [env]
 * @param {{ cwd?: string }} [options]
 */
export function resolveParityEnv(env = /** @type {EnvLike} */ (process.env), { cwd = process.cwd() } = {}) {
  const problems = [];
  const notes = [];

  const sheet = first(ENV_NAMES.sheetId, env);
  if (sheet && sheet.name !== ENV_NAMES.sheetId[0]) {
    notes.push(`Using legacy ${sheet.name}. Prefer ${ENV_NAMES.sheetId[0]} — a parity-only `
      + 'name cannot be set to the production workbook by a deployment script.');
  }

  /* ---- credential: a file path, or base64 JSON text ---------------------- */
  const keyFile = first(ENV_NAMES.keyFile, env);
  const keyBase64 = first(ENV_NAMES.keyBase64, env);

  let credentials = null;
  let base64 = null;
  let credentialFrom = null;

  if (keyFile) {
    const resolved = path.isAbsolute(keyFile.value) ? keyFile.value : path.resolve(cwd, keyFile.value);
    credentialFrom = `${keyFile.name} (file)`;
    if (!fs.existsSync(resolved)) {
      problems.push(`${keyFile.name} points at a file that does not exist:\n      ${resolved}`);
    } else {
      try {
        const raw = fs.readFileSync(resolved, 'utf8');
        credentials = JSON.parse(raw);
        base64 = Buffer.from(raw, 'utf8').toString('base64');
      } catch (error) {
        problems.push(`${keyFile.name} is not readable JSON: ${error.message}`);
      }
    }
  } else if (keyBase64) {
    credentialFrom = `${keyBase64.name} (base64 text)`;
    if (keyBase64.name !== ENV_NAMES.keyBase64[0]) {
      notes.push(`Using legacy ${keyBase64.name}. Prefer ${ENV_NAMES.keyBase64[0]}, or `
        + `${ENV_NAMES.keyFile[0]} with a path to the key file — which is far easier to get `
        + 'right on Windows.');
    }
    try {
      const raw = Buffer.from(keyBase64.value, 'base64').toString('utf8');
      credentials = JSON.parse(raw);
      base64 = keyBase64.value;
    } catch {
      problems.push(`${keyBase64.name} is not valid base64-encoded JSON. On Windows the `
        + `usual cause is a line break in the value — use ${ENV_NAMES.keyFile[0]} instead.`);
    }
  }

  if (credentials && !credentials.private_key) {
    problems.push('The service-account JSON has no "private_key". Download the key again: '
      + 'Cloud Console ▸ Service Accounts ▸ Keys ▸ Add key ▸ Create new key ▸ JSON.');
    credentials = null;
  }

  const configured = Boolean(sheet && credentials);

  return {
    configured,
    sheetId: sheet?.value ?? null,
    sheetIdFrom: sheet?.name ?? null,
    credentials,
    credentialFrom,
    clientEmail: credentials?.client_email ?? null,
    base64,
    problems,
    notes,
    /** Which of the required inputs are still missing, for the "not configured" message. */
    missing: [
      ...(sheet ? [] : [ENV_NAMES.sheetId[0]]),
      ...(credentials ? [] : [`${ENV_NAMES.keyFile[0]} (or ${ENV_NAMES.keyBase64[0]})`]),
    ],
  };
}

/**
 * Workbook identifiers parity must refuse outright, from the environment namespaces.
 * Returns the names that match, so the refusal can say which one.
 *
 * @param {string | null} sheetId
 * @param {EnvLike} [env]
 */
export function forbiddenMatches(sheetId, env = /** @type {EnvLike} */ (process.env)) {
  return ENV_NAMES.forbiddenSheetIds.filter((name) => {
    const value = (env[name] ?? '').trim();
    return value !== '' && value === sheetId;
  });
}

/**
 * The canonical environment the LIVE suite reads, whatever names the operator used.
 *
 * @param {ReturnType<typeof resolveParityEnv>} resolved
 * @param {EnvLike} [env]
 */
export function childEnv(resolved, env = /** @type {EnvLike} */ (process.env)) {
  return {
    ...env,
    GOOGLE_SHEET_ID: resolved.sheetId ?? '',
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: resolved.base64 ?? '',
  };
}
