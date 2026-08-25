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
| 5 | **Supabase AI logging** | 🟠 **Partial — decision** | §1.3, §8.4 | Field list typed (`AiUsageRecord`), and the `AiUsageSink` seam now exists with an in-memory implementation the dispatcher writes to on every call, refusals included. The **table** does not exist: retention is specified nowhere. See §2. |
| 6 | **Kill switches** | 🟡 **Contract built** | §8.4 | The four features and the precedence rule are implemented in [`guardrails.ts`](../lib/server/ai/guardrails.ts). Where the switch positions are *stored* is undecided — §8.4 says "admin settings", and this app has no writable settings store. §4.4 establishes that architecture: "Business rules stay editable in the workbook only." §13 Q5 asks the same question of management and remains **open**; §4.4 fixes the current architecture, which is not the same as Q5 being answered. |
| 7 | **Allowed copilot tools** | 🟢 **Built** | §8.1, §8.3 | Seven tools, each inheriting its route's capability from the registry. §8.1 names five; the two forecast reads are §8.2 rule 4's precondition. The whole path is assembled in [`copilot.ts`](../lib/server/ai/copilot.ts) — see §5. |
| 8 | **Guest assistant** | 🔴 **Unspecified** | §8.1, §8.3, §11 phase 10 | Not startable. See §3 below. |
| 9 | **Model / provider** | 🟡 **Seam built — ids undecided** | §8.4, §10.2 | The `AiProvider` interface, the registry and a local mock exist; see §5. Model **ids** are still undecided: §8.4 says only "cheapest capable model … mid-tier for the copilot's analytical questions" and "Model IDs live in config", naming neither the ids nor the config location. No module names a model — it arrives as data on the request. |
| 10 | **Token / cost accounting** | 🟡 **Built — rates undecided** | §8.4, §10.2 | `AiUsageRecord` pins §8.4's eight fields; `AiTokenPricing` + `computeCost` complete the arithmetic, and a call with no pricing configured is **refused** — an uncostable call cannot be capped. Rates and currency remain undecided (§10.2 lists them as "assumptions to confirm at build time"), and a test asserts no rate literal exists anywhere in the AI layer. |
| 11 | **Retention** | 🔴 **Decision** | §1.3, R11, §13 Q7 | No retention period is specified for **any** Supabase table, AI logs included. §13 Q7 covers *guest* data (Phase 10) and R11 names retention a management/legal decision. This blocks the migration in §2. |
| 12 | **Error / fallback** | 🟡 **Handled — policy undecided** | §8.2 rule 3, §8.4, §10.3 | "No data → say so" is carried into context; budget-breach degradation is implemented; provider failure is now caught and classified into four kinds (`TIMEOUT`, `RATE_LIMITED`, `UNAVAILABLE`, `INVALID_RESPONSE`), each returned as an outcome with a message and a usage row rather than thrown. **§8 enumerates none of this** — it is a technical taxonomy, not a product one. What the *person* sees, and whether a retryable failure is retried, is still undecided. |
| 13 | **Authorization / RBAC** | 🟢 **Built** | §4, §7, §8.1 | Every tool inherits its route capability; a role with neither `ai.copilot` nor `ai.operations` is refused before any read. §7's "OPS: ops-scoped" falls out of the existing model — OPERATIONS reaches exactly `getAlerts`. |
| 14 | **PII sanitization** | 🟢 **Built** | §8.3 | Guest names stripped at the copilot boundary; the alerts API is unchanged for its own consumers. Contact details are structurally absent — no operations view carries them. |
| 15 | **Forecast restriction** | 🟢 **Built** | §8.2 rule 4, §9 | Estimates arrive computed, labelled `ESTIMATE`, with method and status; the `inputs` block is withheld. No AI module may import a calculation engine. |
| 16 | **Tests before enabling** | 🟡 **Partly built** | §8.1, §8.2 | See §4 below. |
| 17 | **`POST /api/ai/copilot`** | 🟢 **Built** | §7, write governance | Declared, guarded by `ai.operations`, wired to the copilot service on the mock provider. The write-governance rule was re-expressed rather than exempted — see §6. |
| 18 | **§8.4 soft warning surfaced** | 🟡 **TECH — follow-up** | §8.4 | `aiFeatureStatus` computes the 70% warning state, but nothing consumes it: it reaches no operator, log line or response. **No decision is needed** — §8.4 names the threshold and the breach behaviour but no destination for the warning itself, so where it should surface is an engineering choice, not a management one. |

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
  outcome           text        not null,   -- code emits OK | FLAGGED | REFUSED | TIMEOUT |
                                            -- RATE_LIMITED | UNAVAILABLE | INVALID_RESPONSE.
                                            -- §8.4 names the field and enumerates nothing, so
                                            -- the dashboard's vocabulary needs confirming.
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
| `tests/ai-provider.test.ts` | The provider seam end to end against the mock: refusals, cost, usage logging, failure classification, gate ordering, environment isolation |
| `tests/ai-copilot.test.ts` | The copilot path end to end: RBAC, ops-scoping, guest-name stripping, forecast restriction, anti-fabrication, one usage record per attempt, determinism, no network |
| `tests/copilot-api.test.ts` | The HTTP route: authorization, validation, every outcome over the wire, transitive read reach, production wiring |
| `tests/environment.test.ts` | Invariants 5 & 6 — a payload cannot cross environments |
| `tests/security.test.ts` | No credential reachable from client code; `OPENAI_API_KEY` included |
| `tests/rbac.test.ts` | Every route × every role, so a new `/api/ai/*` route is covered the moment it is declared |

Still required, and only writable once the corresponding decision is made:

| Test | Blocked on |
|---|---|
| Budget breach against a **real** spend figure | the cap (Q6) and where accumulated spend is read from |
| Per-feature switch honoured by the running handler | where switches are stored (row 6) |
| §8.2 rule 2 — every financial answer cites period and sheet | what "sheet" means for a server-computed figure |
| §8.2 rule 5 — untrusted text fenced, tools restricted for that turn | the fencing format; not specified |
| Usage row **persisted** for every call | the schema in §2 (in-memory recording is tested today) |
| Rate limits per user and per role | the limits; §8.4 names neither |
| Context caps enforced before the call | the per-feature token caps; §8.4 names none |
| Guest tool whitelist (§8.1's own words) | the whitelist itself — see §3 |

---

## 5 · The provider seam

A model backend is reached through one interface, and adding the authorised OpenAI one is
meant to be configuration rather than surgery.

| Module | What it is |
|---|---|
| [`provider.ts`](../lib/server/ai/provider.ts) | `AiProvider`, the request/result shapes, the failure taxonomy, token estimation, `AiTokenPricing` + `computeCost`, and the `AiUsageSink` seam |
| [`mock-provider.ts`](../lib/server/ai/mock-provider.ts) | A local, deterministic backend that answers without a model. Its default reply contains no digits, so it cannot satisfy §8.2 rule 1 by coincidence |
| [`dispatch.ts`](../lib/server/ai/dispatch.ts) | The provider registry, and the one path a question travels |
| [`copilot.ts`](../lib/server/ai/copilot.ts) | The copilot turn: authorise, build context, dispatch, shape §8.1's "answer + source period + provenance". Holds §8.2's five rules as the system prompt, transcribed |
| [`../api/copilot-service.ts`](../lib/server/api/copilot-service.ts) | The HTTP handler: validate a body, resolve the period, delegate. Nothing else |

Every gate sits in the dispatcher rather than in a caller, in a fixed order:

1. **environment** — a demonstration payload can never reach a production model; this
   *throws*, following `dispatchToAi`'s stated reasoning, and logs nothing;
2. **may this feature run** (§8.4) — integration, then budget, then kill switch;
3. **is there a provider, and can the call be costed** — no pricing means no cost, and no
   cost means the hard cap cannot be enforced, so it is refused;
4. **the call**, with provider failures classified rather than thrown;
5. **§8.2 rule 1** — the answer is read back against the facts that produced it.

Every one of those records exactly one usage row, refusals included: a month of refusals
should not look like a month of silence.

### What adding the real provider takes

1. A module implementing `AiProvider.complete` against the OpenAI API, reporting **its**
   token counts rather than the estimate.
2. One line in the registry in `dispatch.ts`.
3. Configuration: the provider id, the model ids, the pricing, the cap, the switches.

Nothing above it changes — not the context boundary, not the guardrails, not their tests.

### Two things that will fail deliberately when it lands

- **`tests/ai-isolation.test.ts` → "no AI module can reach the network"**. A real adapter
  must open a socket, so that scan will fail. It should be **narrowed to exempt exactly
  that one adapter file**, not deleted: the point is that no *other* AI module gains
  network reach.
- **`tests/ai-provider.test.ts` → "nothing external is registered"**. Registering a backend
  that costs money is a deliberate act, and this makes someone read this document first.

---

## 6 · `POST /api/ai/copilot` — declared, and why this POST is non-mutating

§7 lists the route: **`POST /api/ai/copilot` — ADMIN (OPS: ops-scoped)**. It is now
declared and wired. The obstacle was never the route; it was a rule that had outgrown its
own wording.

### The invariant that changed

The registry required every **non-GET** route to declare `mutates: true` and carry a
capability ending in `.write`. Two of the three suites enforcing it already named the real
invariant in their own titles — *"every **write path** is declared, flagged and
capability-gated"* — and inferred one from the HTTP verb because, until now, every non-GET
route was a write.

So the classification is now **declared rather than inferred**, and the rule reads:

> Every non-GET route declares **exactly one** of `mutates: true` or `nonMutating: true`.

That is **stricter than what it replaced**, not weaker: a POST declaring neither used to be
inexpressible and is now an explicit failure. Nothing about a genuine business write
changed — a mutating route still needs its flag, its `.write` capability, its
`MUTATION_DEFINITIONS` entry, its idempotency, its allocated id and its audit entity.

The rule lives in one place, [`assertWriteGovernance`](../lib/server/api/routes.ts), called
by `tests/security.test.ts`, `tests/rbac.test.ts` and `tests/environment.test.ts`, so the
three cannot drift apart.

### Why a copilot question is not a business-data mutation

It allocates no id, writes no sheet cell, has no entity, is not idempotent and creates no
record. Calling it a write would put a false statement in the registry and hand it a
`.write` capability — and `WRITE_CAPABILITIES` is defined as the set INVESTOR must hold
none of, so an AI capability inside it would misstate what that list means.

### What keeps the exemption narrow

A flag is a claim; these are the checks that the claim is true.

| Guard | Where |
|---|---|
| The non-mutating set is **exactly** `['POST /api/ai/copilot']`, derived from the registry | `assertWriteGovernance` |
| A non-mutating route may only be `POST` — never `PATCH`, never `DELETE` | `assertWriteGovernance` |
| It must carry no `.write` capability, no `entityType`, no investor scoping | `assertWriteGovernance` |
| Its path must start with `/api/ai/` | `assertWriteGovernance` |
| The declared AI surface is exactly this one route | `tests/ai-isolation.test.ts` |
| Its capability holders are exactly SUPER_ADMIN + ADMIN + OPERATIONS | `tests/rbac.test.ts` |
| Its handler module imports no repository, Sheets client or mutation path | `tests/security.test.ts` |
| **A whole request touches only whitelisted reads** — measured through a proxied provider, so transitive reach is covered rather than one file's imports | `tests/copilot-api.test.ts` |
| The route is actually bound in the production router, not merely declared | `tests/copilot-api.test.ts` |

### The contract

`POST /api/ai/copilot`, capability `ai.operations`, action `ai.copilot.ask`.

**Request body** is exactly `{ "question": string }`, `.strict()` so an unexpected key is a
422 rather than a silently confirmed contract. There is deliberately no length bound:
§8.4's control for input size is "context caps: max input tokens per feature", whose values
are unspecified, and a character limit here would pre-empt that decision in a different
unit. The period comes from §7's existing query filter conventions via the helper every
analytics read shares.

**Response** is the `CopilotAnswer` the service already produces — §8.1's *"answer + source
period + provenance"* — returned unchanged. A refusal is a **200 with an outcome**, not an
HTTP error: the caller was authorised, and §8.4 asks for a clear message rather than a
status code standing in for one. The six internal refusal codes are preserved as they are.

**Today every request refuses with `INTEGRATION_DISABLED`**, because the composition root
configures no provider, no pricing, no cap and no switches. Each absence is a named
refusal rather than a default.

### Still missing on this route

- **Rate limits.** §8.4 requires them "per user and per role". No rate-limiting
  infrastructure exists anywhere in this repository, and no values are specified.
- **A usage sink that retains anything.** Production wires `DiscardingAiUsageSink`, which
  discards while AI is off and **throws if `aiEnabled()` ever returns true** — so enabling
  AI requires providing a real sink rather than remembering to. The table itself is still
  blocked on retention (§2).
- **User-facing wording for a refusal.** Unchanged: the codes exist and carry an
  operator's message; §8 specifies no text for the person who asked.

### The copilot page

Still unchanged. Its documented contract in the UI redesign plan says the composer is inert
and no request is sent, and no contract is documented for a connected one — no loading
state, no error rendering, no refusal wording.

---

## 7 · The short list for management

1. **Monthly OpenAI budget cap** (§13 Q6) — the one item §13 itself marks as blocking.
2. **Retention period for AI usage and conversation logs**, and whether conversation text
   is stored at all.
3. **Model ids per tier**, and where that config lives.
4. **Cost currency**, and confirmation of the per-token pricing assumed (§10.2).
5. **Rate limits and per-feature token caps** (§8.4 names both without values).
6. **Where per-feature kill switches are stored**, given settings are workbook-owned.
7. **What a refused copilot turn says to the person who asked** — the codes exist, the
   user-facing wording is unspecified.
8. **Rate limits per user and per role** (§8.4), for which no infrastructure and no values
   exist.

Until 1 and 2 are answered, no AI feature can run: the guardrail refuses an unconfigured
cap by design, and there is nowhere to log a call that is made.
