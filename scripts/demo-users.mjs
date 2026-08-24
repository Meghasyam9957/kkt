/**
 * DEMO USERS — create the four demonstration accounts in the DEMO Supabase project.
 *
 *   node scripts/demo-users.mjs            create missing users, never touch existing
 *   node scripts/demo-users.mjs --rotate   also set a fresh password on existing users
 *
 * What it does, and why it replaces migration 0002's manual steps:
 *   1. Creates each account through Supabase Auth's admin API with a PASSWORD GENERATED
 *      HERE, AT RUN TIME — printed once to this console and stored nowhere. No password
 *      is hard-coded, committed, or written to disk.
 *   2. Upserts the matching `app_users` row with the REAL auth id, so the manual
 *      invite-then-edit-the-uuid step in 0002_demo_identities.sql is unnecessary.
 *
 * SAFETY:
 *   - reads DEMO_SUPABASE_URL / DEMO_SUPABASE_SERVICE_ROLE_KEY only — production
 *     variables are never consulted, and the run refuses if the demo URL equals
 *     PRODUCTION_SUPABASE_URL;
 *   - refuses to run against a project whose `app_users` already holds any account
 *     outside @srivillu.demo — that is what a production project looks like;
 *   - every account is fictional: `@srivillu.demo` is not a real mail domain.
 */
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const DEMO_ACCOUNTS = [
  { email: 'admin.demo@srivillu.demo',      role: 'ADMIN',      investorId: null },
  { email: 'operations.demo@srivillu.demo', role: 'OPERATIONS', investorId: null },
  { email: 'investor.demo.a@srivillu.demo', role: 'INVESTOR',   investorId: 'INV-001' },
  { email: 'investor.demo.b@srivillu.demo', role: 'INVESTOR',   investorId: 'INV-002' },
];

/** 20 chars from a 62-symbol alphabet — ~119 bits, far beyond any demo threat model. */
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(20), (b) => alphabet[b % alphabet.length]).join('');
}

async function main() {
  const rotate = process.argv.includes('--rotate');
  const url = process.env.DEMO_SUPABASE_URL?.trim();
  const serviceRole = process.env.DEMO_SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRole) {
    console.error('DEMO_SUPABASE_URL and DEMO_SUPABASE_SERVICE_ROLE_KEY must be set.');
    console.error('This script provisions the DEMO project only; see docs/DEMO_PROVISIONING.md.');
    process.exit(2);
  }
  if (process.env.PRODUCTION_SUPABASE_URL?.trim() === url) {
    console.error('Refusing to run: DEMO_SUPABASE_URL equals PRODUCTION_SUPABASE_URL.');
    process.exit(2);
  }

  const supabase = createClient(url, serviceRole, { auth: { persistSession: false } });

  // The same guard migration 0002 carries: a project with real accounts is not demo.
  const { data: strangers, error: guardError } = await supabase
    .from('app_users').select('email').not('email', 'like', '%@srivillu.demo').limit(1);
  if (guardError) {
    console.error(`Could not inspect app_users (${guardError.message}).`);
    console.error('Run supabase/migrations/0001_identity_audit_ids.sql and 0003_operations.sql first.');
    process.exit(2);
  }
  if (strangers.length > 0) {
    console.error('Refusing to run: app_users contains non-demo accounts. This looks like a');
    console.error('real project, and demo accounts must never be created in one.');
    process.exit(2);
  }

  console.log(`DEMO USERS — ${new URL(url).hostname}\n`);
  const credentials = [];

  for (const account of DEMO_ACCOUNTS) {
    // listUsers has no email filter this SDK version can rely on; four accounts, one page.
    const { data: page, error: listError } = await supabase.auth.admin.listUsers({ perPage: 200 });
    if (listError) throw new Error(`listUsers failed: ${listError.message}`);
    const existing = page.users.find((u) => u.email?.toLowerCase() === account.email);

    let userId;
    if (existing && !rotate) {
      userId = existing.id;
      console.log(`  kept      ${account.email} (existing — password unchanged)`);
    } else if (existing && rotate) {
      const password = generatePassword();
      const { error } = await supabase.auth.admin.updateUserById(existing.id, { password });
      if (error) throw new Error(`password rotation failed for ${account.email}: ${error.message}`);
      userId = existing.id;
      credentials.push({ email: account.email, password });
      console.log(`  rotated   ${account.email}`);
    } else {
      const password = generatePassword();
      const { data, error } = await supabase.auth.admin.createUser({
        email: account.email,
        password,
        email_confirm: true,   // @srivillu.demo receives no mail; confirm at creation
      });
      if (error) throw new Error(`createUser failed for ${account.email}: ${error.message}`);
      userId = data.user.id;
      credentials.push({ email: account.email, password });
      console.log(`  created   ${account.email}`);
    }

    const { error: upsertError } = await supabase.from('app_users').upsert({
      id: userId,
      email: account.email,
      role: account.role,
      investor_id: account.investorId,
      status: 'ACTIVE',
    });
    if (upsertError) throw new Error(`app_users upsert failed for ${account.email}: ${upsertError.message}`);
  }

  if (credentials.length > 0) {
    console.log('\nPASSWORDS — shown once, stored nowhere. Put them in a password manager now.');
    console.log('(Re-run with --rotate any time to invalidate these and mint fresh ones.)\n');
    for (const { email, password } of credentials) {
      console.log(`  ${email.padEnd(34)} ${password}`);
    }
  } else {
    console.log('\nAll four accounts already existed. Passwords unchanged (use --rotate to reset).');
  }
  console.log('\nDone. Sign-in now uses real Supabase authentication for these accounts.');
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
