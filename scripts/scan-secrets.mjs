/**
 * COMMITTED-SECRET SCANNER.
 *
 *   node scripts/scan-secrets.mjs          scan the tracked working tree
 *
 * Exits non-zero when something that looks like a live credential is tracked by git. It
 * scans what git tracks, not what is on disk, because an ignored `.env.local` is exactly
 * where a secret is SUPPOSED to live — flagging it would train everyone to pass `--force`.
 *
 * IT NEVER PRINTS THE MATCH. A scanner that echoes the secret it found puts that secret into
 * the CI log, which is a place secrets outlive the commit that leaked them. Findings are
 * reported as file, line and the NAME of the rule that fired; the operator can look.
 *
 * The rules deliberately match SHAPE rather than name. `SUPABASE_SERVICE_ROLE_KEY=` in
 * `.env.example` with nothing after it is correct and must stay; a JWT-shaped string
 * anywhere in tracked source is not, whatever the variable is called.
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  {
    name: 'supabase-jwt',
    // A JWT: three base64url segments. Supabase anon and service-role keys are both JWTs,
    // and the anon key is publishable — but a service-role key is indistinguishable by
    // shape, so neither belongs in tracked source.
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'supabase-secret-key',
    pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}\b/,
  },
  {
    name: 'postgres-url-with-password',
    // A connection string carrying credentials. `postgres://user@host` is fine.
    pattern: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@([^\s:/?#'"`]*)/,
    /*
     * A password against a host that CANNOT be a real machine is a documentation example,
     * not a leak — and every such host is reserved for precisely that purpose:
     *
     *   RFC 2606   example.com/net/org, and the .example/.invalid/.test/.localhost TLDs
     *   loopback   localhost, 127.0.0.1
     *   one label  `db`, `postgres` — a service name on a container network, which has no
     *              public DNS meaning and so cannot be reached from outside it
     *
     * Refining by SHAPE keeps the rule honest. The alternative is a list of files allowed
     * to contain credentials, and that list only ever grows — right up until it covers the
     * file the real leak lands in.
     */
    ignore: (match) => {
      const host = (match[1] ?? '').toLowerCase();
      if (host === '' || host === 'localhost' || host === '127.0.0.1') return true;
      if (/(^|\.)example\.(com|net|org)$/.test(host)) return true;
      if (/\.(example|invalid|test|localhost)$/.test(host)) return true;
      // No dot at all: a container/service name, not a routable host.
      return !host.includes('.');
    },
  },
  {
    name: 'openai-key',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
  },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: 'google-service-account',
    // The one field that makes a service-account JSON usable.
    pattern: /"private_key"\s*:\s*"-----BEGIN/,
  },
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
];

/**
 * Paths whose CONTENT is documentation about secrets rather than a secret.
 *
 * Kept to a minimum and matched exactly: an allow-list of paths is the thing that quietly
 * grows until it covers the file the leak eventually lands in.
 */
const ALLOWED = new Set([
  'scripts/scan-secrets.mjs',   // the patterns themselves
  'lib/server/audit/reason.ts', // the token-stripping patterns
]);

const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|woff2?|ttf|eot|mp4|xlsx)$/i;

function trackedFiles() {
  return execSync('git ls-files -z', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

/**
 * The size guard lives in the DEFAULT reader, not in `scan`.
 *
 * `scan` takes an injectable reader so tests can hand it a string without writing a file to
 * disk — and a `statSync` in the loop would defeat that, failing on a path that was never
 * meant to exist and silently scanning nothing. Which is exactly the shape of bug a secret
 * scanner must not have: it would report a clean tree because it read no files at all.
 */
const readFile = (f) => (statSync(f).size > 2 * 1024 * 1024 ? '' : readFileSync(f, 'utf8'));

export function scan(files, read = readFile) {
  const findings = [];
  for (const file of files) {
    if (ALLOWED.has(file) || BINARY.test(file)) continue;
    let text;
    try {
      text = read(file);
    } catch { continue; }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      for (const rule of RULES) {
        const match = rule.pattern.exec(lines[i]);
        if (!match) continue;
        if (rule.ignore && rule.ignore(match)) continue;
        // file, line, rule name. Never the matched text.
        findings.push({ file, line: i + 1, rule: rule.name });
      }
    }
  }
  return findings;
}

export { RULES };

// Only run when invoked directly, so the test can import `scan` without scanning.
if (process.argv[1] && process.argv[1].endsWith('scan-secrets.mjs')) {
  const files = trackedFiles();
  const findings = scan(files);
  if (findings.length === 0) {
    console.log(`No committed secrets found across ${files.length} tracked files.`);
    process.exit(0);
  }
  console.error(`\nPOSSIBLE COMMITTED SECRETS — ${findings.length} finding(s):\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
  console.error(
    '\nThe matched text is deliberately not printed. Open the file and look.\n'
    + 'If it is a real credential: rotate it first, then remove it from the tree.\n'
    + 'Rotate before rewriting history — the value is already in the reflog and in any clone.\n');
  process.exit(1);
}
