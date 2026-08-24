import '@/lib/server/only';
/**
 * PII REDACTION for audit metadata.
 *
 * The audit log answers "who did what to which record". It does not need to know a
 * guest's name, phone or email — and storing those would spread personal data into a
 * long-retention table that is read by administrators, which is precisely what data
 * minimisation exists to prevent.
 *
 * Redaction is applied inside AuditLogger, so it cannot be skipped by a forgetful caller.
 */

/** Field names carrying personal data. Matched case- and separator-insensitively. */
const PII_KEYS: readonly string[] = [
  'guestname', 'guest', 'name', 'firstname', 'lastname', 'fullname',
  'email', 'emailaddress', 'phone', 'phonenumber', 'mobile', 'contact', 'contactnumber',
  'address', 'street', 'postcode', 'zip',
  'passport', 'aadhaar', 'aadhar', 'pan', 'idnumber', 'nationalid', 'dob', 'dateofbirth',
  'password', 'token', 'accesstoken', 'refreshtoken', 'apikey', 'secret', 'authorization',
  'cardnumber', 'cvv', 'iban', 'accountnumber',
];

/**
 * Keys that are safe despite looking sensitive — business identifiers, not people.
 *
 * Their values are tokens this system mints (a UUID, `EXP-2026-0001`, `HYD-501`), never
 * free text and never guest input. They are still swept and still capped — but as
 * identifiers rather than as prose, which spares them the phone rule that corrupts them.
 * See `redactValue`.
 */
const ALLOWLIST: readonly string[] = [
  // Identifiers this application mints.
  'entityid', 'bookingid', 'investorid', 'propertyid', 'expenseid', 'revenueid',
  'requestid', 'userid', 'actorid', 'ticketid', 'taskid', 'capexid', 'txnid', 'itemid',
  'operationid', 'recordid', 'assetid', 'complianceid', 'refid',
  // The atomic ID allocator audits the batch it minted under `ids`.
  'ids',
  // References minted ELSEWHERE and recorded here — an invoice number, a UPI payment
  // reference, an OTA booking code. These routinely carry ten or more consecutive
  // digits, which is exactly what the phone rule matches: `UPI123456789012` was being
  // audited as `UPI[REDACTED]`, and a payment reference nobody can read cannot be
  // reconciled against a bank statement.
  'invoiceref', 'paymentref', 'agreementref', 'documentref',
  'platformresid', 'airbnblistingid', 'bookingcomlistingid',
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_STRING = 512;
/** Entries kept from any array. The log records what happened, not a bulk export. */
const MAX_ARRAY = 50;

function normalize(key: string): string {
  return key.replace(/[\s_\-.]+/g, '').toLowerCase();
}

export function isPiiKey(key: string): boolean {
  const k = normalize(key);
  if (ALLOWLIST.includes(k)) return false;
  return PII_KEYS.includes(k);
}

/** True for a key whose value is an identifier this system minted, not prose. */
export function isIdentifierKey(key: string): boolean {
  return ALLOWLIST.includes(normalize(key));
}

/** The log is not a data dump: every stored string is capped. */
function cap(value: string): string {
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
}

/**
 * Value-level sweep for personal data that arrives under an innocuous key.
 * Emails and long digit strings (phone / ID numbers) are the realistic cases.
 *
 * `identifier` marks a value this system minted rather than prose. Such a value still
 * has its email rule applied — an identifier never contains one, so the check is free —
 * but NOT the phone rule: that matches any run of ten or more digits, which is a sound
 * heuristic for prose and a corrupting one for a token. It mangles roughly one UUID in
 * eleven, which silently destroyed the operation id that makes a write traceable.
 */
function redactValue(value: string, identifier = false): string {
  let out = value;
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED);            // email
  if (!identifier) {
    out = out.replace(/(?<!\d)(?:\+?\d[ -]?){10,}(?!\d)/g, REDACTED);  // phone / long id runs
  }
  return cap(out);
}

export function redactMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return REDACTED;
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string') return redactValue(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => walk(v, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (isPiiKey(key)) { out[key] = REDACTED; continue; }
        // A minted identifier is swept as an identifier, not as prose — see redactValue.
        // A LIST of them is treated the same: `ids: ['EXP-2026-0001', …]` is what the
        // atomic allocator audits, and one identifier per key behaving differently from
        // several under one key would be an accident of shape, not a decision.
        //
        // Only scalar strings take this path. Nested objects still walk normally, so PII
        // cannot hide one level down inside a field merely named like an id.
        if (isIdentifierKey(key)) {
          if (typeof child === 'string') { out[key] = redactValue(child, true); continue; }
          if (Array.isArray(child) && child.every((v) => typeof v === 'string')) {
            out[key] = child.slice(0, MAX_ARRAY).map((v) => redactValue(v as string, true));
            continue;
          }
        }
        out[key] = walk(child, depth + 1);
      }
      return out;
    }
    return REDACTED;   // functions, symbols, anything unexpected
  };

  return walk(input, 0) as Record<string, unknown>;
}
