# Phase 9 (AI Copilot) — readiness

What is built, what is blocked, and what is blocked **on a decision rather than on work**.

Phase 9 in [ARCHITECTURE.md](ARCHITECTURE.md) §11 is "Tools, guardrails, logging, usage
dashboard, budget cap", with the note *"Must sit on proven data; otherwise it lies
confidently."* This document is the audit of how close that is.

No OpenAI integration exists. `aiEnabled()` returns `false`, `dispatchToAi()` throws, no
file anywhere reads an `OPENAI` environment variable, no AI SDK is installed, and no
`/api/ai/*` route is declared. All five statements are asserted by
[`tests/ai-isolation.test.ts`](../tests/ai-isolation.test.ts).

---

## 1 · Readiness matrix

| # | Item | Status | Where it is specified | What is missing |
|---|---|---|---|---|
| 1 | **Monthly budget cap** | 🔴 **Decision** | §13 Q6, §8.4, §10.2 | The figure. §10.2 *recommends* $25; §13 marks Q6 "Blocks Phase 9". A recommendation is not an answer. `budgetState()` treats an unset cap as `UNCONFIGURED` and refuses every feature, so this is now mechanically enforced. |
| 2 | **OpenAI credentials** | 🔴 **External** | §1.1 #2, §10.1 | A paid account and a server-side key, per environment (`DEMO_*` / `PRODUCTION_*` namespacing already exists). Not a code task. |
| 3 | **LIVE parity** | 🟠 **Credential** | §11 phase 9, §2 gate | Offline parity passes 212/212. LIVE parity is `PENDING` for want of `PARITY_SHEET_ID` and `PARITY_SERVICE_ACCOUNT_FILE`. §11 makes proven data a precondition for AI, so this must go green first. |
| 4 | **Isolation boundary** | 🟢 **Built** | §8.1 | Copilot half complete: [`copilot-context.ts`](../lib/server/ai/copilot-context.ts) + 45 tests. Guest half not built — see row 8. |
| 5 | **Supabase AI logging** | 🟠 **Partial — decision** | §1.3, §8.4 | Field list for the *usage* log is specified and typed (`AiUsageRecord`). No table exists. Retention is specified nowhere. See §2 below. |
| 6 | **Kill switches** | 🟡 **Contract built** | §8.4 | The four features and the precedence rule are implemented in [`guardrails.ts`](../lib/server/ai/guardrails.ts). Where the switch positions are *stored* is undecided — §8.4 says "admin settings", and this app has no writable settings store (§13 Q5 was answered workbook-only). |
| 7 | **Allowed copilot tools** | 🟢 **Built** | §8.1, §8.3 | Seven tools, each inheriting its route's capability from the registry. §8.1 names five; the two forecast reads are §8.2 rule 4's precondition. |
| 8 | **Guest assistant** | 🔴 **Unspecified** | §8.1, §8.3, §11 phase 10 | Not startable. See §3 below. |
| 9 | **Model / provider** | 🔴 **Decision** | §8.4, §10.2 | Provider is decided (OpenAI, §1.2/§10.1). Model **IDs** are not: §8.4 says only "cheapest capable model … mid-tier for the copilot's analytical questions" and "Model IDs live in config". Neither the ids nor the config location is stated. |
| 10 | **Token / cost accounting** | 🟡 **Contract built** | §8.4, §10.2 | `AiUsageRecord` pins §8.4's eight fields. Per-token pricing is listed in §10.2 as "assumptions to confirm at build time", so no pricing table exists and none should be invented. Currency is unstated (§10.2 quotes USD; the business runs in INR). |
| 11 | **Retention** | 🔴 **Decision** | §1.3, R11, §13 Q7 | No retention period is specified for **any** Supabase table, AI logs included. §13 Q7 covers *guest* data (Phase 10) and R11 names retention a management/legal decision. This blocks the migration in §2. |
| 12 | **Error / fallback** | 🟠 **Partial** | §8.2 rule 3, §8.4 | "No data → say so" is carried into context (`unavailable`, `omitted`). Budget-breach degradation is implemented. Behaviour on a **model** failure — timeout, provider error, rate limit — is specified nowhere, and §10.3's ~10 s Netlify function limit makes it a real case. |
| 13 | **Authorization / RBAC** | 🟢 **Built** | §4, §7, §8.1 | Every tool inherits its route capability; a role with neither `ai.copilot` nor `ai.operations` is refused before any read. §7's "OPS: ops-scoped" falls out of the existing model — OPERATIONS reaches exactly `getAlerts`. |
| 14 | **PII sanitization** | 🟢 **Built** | §8.3 | Guest names stripped at the copilot boundary; the alerts API is unchanged for its own consumers. Contact details are structurally absent — no operations view carries them. |
| 15 | **Forecast restriction** | 🟢 **Built** | §8.2 rule 4, §9 | Estimates arrive computed, labelled `ESTIMATE`, with method and status; the `inputs` block is withheld. No AI module may import a calculation engine. |
| 16 | **Tests before enabling** | 🟡 **Partly built** | §8.1, §8.2 | See §4 below. |

🟢 built · 🟡 contract built, feature work remains · 🟠 partial or credential-blocked · 🔴 blocked on a decision

---

## 2 · Proposed AI log schema — **NOT APPLIED**

§1.3 permits Supabase to hold *"AI conversation + token logs"*. The migration is **not**
written, for one reason that applies to both tables and one that applies to the first.

**Retention is unspecified.** No existing migration carries a retention or purge policy —
not `audit_log`, not `operations`. For audit that is defensible; for AI logs it is not,
because they accumulate the text of questions people asked about the business. R11 names
retention a management decision and §13 Q7 asks it only for guest data in Phase 10. A
migration that silently keeps conversation text forever would be answering that question
by omission.

**Conversation shape is unspecified.** §1.3 names "AI conversation" logs; nothing states
what a conversation row holds — whether the question and answer text are stored at all,
whether tool payloads are, or how §8.3's guest-name rule applies to text an admin typed.
Those are product and privacy decisions, so no table is proposed for it here.

The usage log *is* fully specified as to fields, so this is what it should look like once
the retention question is answered:

```sql
-- PROPOSED — do not apply. Blocked on: retention period, cost currency, outcome vocabulary.
create table if not exists ai_usage (
  id                uuid primary key default gen_random_uuid(),
  occurred_at       timestamptz not null default now(),
  feature           text        not null,   -- copilot | guest | reviews | summaries (§8.4)
  model             text        not null,   -- the id from config (§8.4); not chosen here
  prompt_tokens     integer     not null,
  completion_tokens integer     not null,
  cost              numeric(12,6) not null, -- computed by the caller from pricing in force
  currency          char(3)     not null,   -- UNDECIDED: §10.2 quotes USD, business is INR
  latency_ms        integer     not null,
  user_id           uuid        references app_users(id),
  outcome           text        not null,   -- UNDECIDED: §8.4 names it, enumerates nothing
  constraint ai_usage_tokens_non_negative
    check (prompt_tokens >= 0 and completion_tokens >= 0 and latency_ms >= 0)
);

create index if not exists ai_usage_occurred_at_idx on ai_usage (occurred_at desc);
create index if not exists ai_usage_feature_idx     on ai_usage (feature, occurred_at desc);
create index if not exists ai_usage_user_idx        on ai_usage (user_id, occurred_at desc);

-- Same posture as audit_log: service-role only, append-only from any client's view.
alter table ai_usage enable row level security;
revoke update, delete on ai_usage from authenticated, anon;

-- MISSING: a retention/purge policy. Nothing in the architecture states one.
```

It holds no business data, so it satisfies §1.3's test: wiping it would lose usage history
and nothing about the business.

**To unblock:** answer the retention period for AI usage and conversation logs; state the
cost currency; enumerate the `outcome` values; decide whether conversation text is stored
at all and, if so, under what redaction.

---

## 3 · Guest assistant — audited, deliberately not built

§8.1 describes it as *"a separate service with its own system prompt, its own tool registry
and its own repository facade"*, and §11 places it at **phase 10**, after the copilot.

What the architecture gives: four tool names (`getStayInfo`, `getHouseRules`,
`getAmenities`, `createGuestRequest`), the rule that the repository facade returns
"whitelisted fields ONLY", the §8.3 row for what a guest may never see, and `POST
/api/ai/guest` authorised by a booking token.

What it does not give, and what cannot be invented:

- **The whitelist itself.** §8.1's assertion is that "every guest tool returns only
  whitelisted fields". The fields are not enumerated anywhere for any of the four tools.
- **House rules, amenities and approved FAQ have no source.** None of them is a workbook
  sheet in the generated contract, and no repository reads them.
- **The booking token.** `GuestSession` exists as a domain type, but §13 Q13 — how the
  link reaches the guest — is unanswered, and no token issue/verify path exists.
- **`createGuestRequest` is a write.** Every mutation in this application is capability-
  gated, idempotent and audited; a token-scoped writer fits none of those patterns yet.
- **Retention and DPDP ownership** (§13 Q7) are unanswered, and this is the surface they
  were asked about.

Building any of it now would mean inventing a guest-facing data contract. Instead,
`tests/ai-isolation.test.ts` carries a tripwire: the day a guest tool registry or an
`/api/ai/guest` route appears, it fails until §8.1's whitelist assertions land with it.

---

## 4 · Tests required before AI is switched on

Built, and passing today:

| Test | Covers |
|---|---|
| `tests/ai-isolation.test.ts` | §8.1 whitelist, §8.3 minimisation, §8.2 rule 4, RBAC, no network, no credential, no route |
| `tests/ai-guardrails.test.ts` | §8.4 kill switches and budget precedence, §8.2 rule 1 numeric grounding |
| `tests/environment.test.ts` | Invariants 5 & 6 — a payload cannot cross environments |
| `tests/security.test.ts` | No credential reachable from client code; `OPENAI_API_KEY` included |
| `tests/rbac.test.ts` | Every route × every role, so a new `/api/ai/*` route is covered the moment it is declared |

Still required, and only writable once the corresponding decision is made:

| Test | Blocked on |
|---|---|
| Budget breach disables the live feature end to end | the cap (Q6) and the spend source |
| Per-feature switch honoured by the running handler | where switches are stored (row 6) |
| §8.2 rule 2 — every financial answer cites period and sheet | what "sheet" means for a server-computed figure |
| §8.2 rule 5 — untrusted text fenced, tools restricted for that turn | the fencing format; not specified |
| Usage row written for every call | the schema in §2 |
| Rate limits per user and per role | the limits; §8.4 names neither |
| Context caps enforced before the call | the per-feature token caps; §8.4 names none |
| Guest tool whitelist (§8.1's own words) | the whitelist itself — see §3 |

---

## 5 · The short list for management

1. **Monthly OpenAI budget cap** (§13 Q6) — the one item §13 itself marks as blocking.
2. **Retention period for AI usage and conversation logs**, and whether conversation text
   is stored at all.
3. **Model ids per tier**, and where that config lives.
4. **Cost currency**, and confirmation of the per-token pricing assumed (§10.2).
5. **Rate limits and per-feature token caps** (§8.4 names both without values).
6. **Where per-feature kill switches are stored**, given settings are workbook-owned.

Until 1 and 2 are answered, no AI feature can run: the guardrail refuses an unconfigured
cap by design, and there is nowhere to log a call that is made.
