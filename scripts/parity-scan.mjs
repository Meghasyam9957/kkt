/**
 * Preparation-checklist scanners for the LIVE parity copy.
 *
 * These detect EVIDENCE of real data and of stored secrets. They cannot prove absence,
 * and the preflight says so out loud — but "we found a live email address in a workbook
 * that is supposed to be fictional" is a fact, and it should stop the run.
 *
 * Kept in its own module so the heuristics are unit-tested rather than only exercised on
 * an operator's machine at the moment they matter.
 */

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
/** Indian mobile numbers: 10 digits starting 6-9, optionally +91-prefixed. */
const PHONE = /(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/g;
/** Domains that mean "deliberately not a real person". */
const SAFE_EMAIL = /@(example\.(com|org|net)|test\.|demo\.|localhost)/i;

const SECRET_PATTERNS = [
  [/\bAIza[0-9A-Za-z_-]{20,}/, 'Google API key'],
  [/\bya29\.[0-9A-Za-z_-]{10,}/, 'Google OAuth token'],
  [/\bsk-[A-Za-z0-9]{16,}/, 'OpenAI-style secret key'],
  [/\bAKIA[0-9A-Z]{12,}/, 'AWS access key id'],
  [/\bxox[abpsr]-[0-9A-Za-z-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
];

/** Flatten sheet rows to the text worth scanning. */
export function textOf(rows) {
  return rows.flat().filter((v) => typeof v === 'string').join('\n');
}

/**
 * Contact-shaped strings that are not obviously fictional.
 * Returns de-duplicated raw matches; the caller masks before printing.
 */
export function findContactData(rows) {
  const blob = textOf(rows);
  const emails = [...blob.matchAll(EMAIL)].map((m) => m[0]).filter((e) => !SAFE_EMAIL.test(e));
  const phones = [...blob.matchAll(PHONE)].map((m) => m[0]);
  return [...new Set([...emails, ...phones])];
}

/** Names of the secret formats present in the text. */
export function findSecrets(rows) {
  const blob = typeof rows === 'string' ? rows : textOf(rows);
  return SECRET_PATTERNS.filter(([pattern]) => pattern.test(blob)).map(([, label]) => label);
}

/** Enough of a value to recognise, not enough to reuse. */
export function mask(value) {
  return value.includes('@')
    ? value.replace(/^[^@]+/, (user) => user.slice(0, 2) + '***')
    : value.slice(0, 3) + '*'.repeat(Math.max(0, value.length - 3));
}

/** Does this name read as deliberately fictional? */
export function looksFictional(name) {
  return /test|demo|fiction|sample|guest \d/i.test(name);
}

/** Does this workbook title identify itself as a parity copy? */
export function titleLooksLikeCopy(title) {
  return /parity|copy|test|sandbox/i.test(title ?? '');
}
