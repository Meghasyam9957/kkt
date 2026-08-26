# Phase 9 (AI Copilot) — readiness

What is built, what is blocked, and what is blocked **on a decision rather than on work**.

Phase 9 in [ARCHITECTURE.md](ARCHITECTURE.md) §11 is "Tools, guardrails, logging, usage
dashboard, budget cap", with the note *"Must sit on proven data; otherwise it lies
confidently."* This document is the audit of how close that is.

A real OpenAI provider adapter now exists behind the `AiProvider` seam, and
`POST /api/ai/copilot` is declared and wired. **Nothing calls out.** `aiEnabled()` reads
configuration and answers `false` in every environment, because none is configured: no
enable flag, no provider, no key, no model, no pricing, no cap. No AI SDK is installed,
exactly one module may read the environment, exactly one may reach the network, and it may
reach exactly one host — all asserted by
[`tests/ai-isolation.test.ts`](../tests/ai-isolation.test.ts).

---

## 1 · Readiness matrix

| # | Item | Status | Where it is specified | What is missing |
|---|---|---|---|---|
| 1 | **Monthly budget cap** | 🔴 **Decision** | §13 Q6, §8.4, §10.2 | The figure. §10.2 *recommends* $25; §13 marks Q6 "Blocks Phase 9". A recommendation is not an answer. `budgetState()` treats an unset cap as `UNCONFIGURED` and refuses every feature, so this is now mechanically enforced. |
| 2 | **OpenAI credentials** | 🔴 **External** | §1.1 #2, §10.1 | The exact variable names now exist, are documented in `.env.example` and are read only by `config.ts` — see §9.1. What is missing is outside the repository: an authorised **project-scoped** key set in the deployment's secret configuration by its owner. Not a code task, and deliberately not one this repository can complete. |
| 3 | **LIVE parity** | 🟠 **Credential** | §11 phase 9, §2 gate | Offline parity passes 212/212. LIVE parity is `PENDING` for want of `PARITY_SHEET_ID` and `PARITY_SERVICE_ACCOUNT_FILE`. §11 makes proven data a precondition for AI, so this must go green first. |
| 4 | **Isolation boundary** | 🟢 **Built** | §8.1 | Copilot half complete: [`copilot-context.ts`](../lib/server/ai/copilot-context.ts) + 45 tests. Guest half not built — see row 8. |
| 5 | **Supabase AI logging** | 🟠 **Partial — decision** | §1.3, §8.4 | Field list typed (`AiUsageRecord`), and the `AiUsageSink` seam now exists with an in-memory implementation the dispatcher writes to on every call, refusals included. The **table** does not exist: retention is specified nowhere. See §2. |
| 6 | **Kill switches** | 🟡 **Contract built** | §8.4 | The four features and the precedence rule are implemented in [`guardrails.ts`](../lib/server/ai/guardrails.ts). Where the switch positions are *stored* is undecided — §8.4 says "admin settings", and this app has no writable settings store. §4.4 establishes that architecture: "Business rules stay editable in the workbook only." §13 Q5 asks the same question of management and remains **open**; §4.4 fixes the current architecture, which is not the same as Q5 being answered. |
| 7 | **Allowed copilot tools** | 🟢 **Built** | §8.1, §8.3 | Seven tools, each inheriting its route's capability from the registry. §8.1 names five; the two forecast reads are §8.2 rule 4's precondition. The whole path is assembled in [`copilot.ts`](../lib/server/ai/copilot.ts) — see §5. |
| 8 | **Guest assistant** | 🔴 **Unspecified** | §8.1, §8.3, §11 phase 10 | Not startable. See §3 below. |
| 9 | **Model / provider** | 🟡 **Adapter built — ids undecided** | §8.4, §10.2 | The `AiProvider` interface, the registry, a local mock and the real OpenAI adapter all exist; see §5 and §8. Configuration now rejects an unknown provider id by name (`UNKNOWN_PROVIDER`) rather than resolving it to nothing, and validates the model id's shape. Model **ids** are still undecided: §8.4 says only "cheapest capable model … mid-tier for the copilot's analytical questions" and "Model IDs live in config", naming neither the ids nor the config location. No module names a model — it arrives as data on the request. |
| 10 | **Token / cost accounting** | 🟡 **Built — rates undecided** | §8.4, §10.2 | `AiUsageRecord` pins §8.4's eight fields; `AiTokenPricing` + `computeCost` complete the arithmetic, and a call with no pricing configured is **refused** — an uncostable call cannot be capped. Published per-million rates are converted to the internal per-token contract in one place, with a test pinning the conversion, and a provider currency that differs from the budget currency is refused rather than converted. Rates and currency remain undecided (§10.2 lists them as "assumptions to confirm at build time"), and a test asserts no rate literal exists anywhere in the AI layer. |
| 11 | **Retention** | 🔴 **Decision** | §1.3, R11, §13 Q7 | No retention period is specified for **any** Supabase table, AI logs included. §13 Q7 covers *guest* data (Phase 10) and R11 names retention a management/legal decision. This blocks the migration in §2. |
| 12 | **Error / fallback** | 🟡 **Handled — policy undecided** | §8.2 rule 3, §8.4, §10.3 | "No data → say so" is carried into context; budget-breach degradation is implemented; provider failure is now caught and classified into four kinds (`TIMEOUT`, `RATE_LIMITED`, `UNAVAILABLE`, `INVALID_RESPONSE`), each returned as an outcome with a message and a usage row rather than thrown. **§8 enumerates none of this** — it is a technical taxonomy, not a product one. What the *person* sees, and whether a retryable failure is retried, is still undecided. |
| 13 | **Authorization / RBAC** | 🟢 **Built** | §4, §7, §8.1 | Every tool inherits its route capability; a role with neither `ai.copilot` nor `ai.operations` is refused before any read. §7's "OPS: ops-scoped" falls out of the existing model — OPERATIONS reaches exactly `getAlerts`. |
| 14 | **PII sanitization** | 🟢 **Built** | §8.3 | Guest names stripped at the copilot boundary; the alerts API is unchanged for its own consumers. Contact details are structurally absent — no operations view carries them. |
| 15 | **Forecast restriction** | 🟢 **Built** | §8.2 rule 4, §9 | Estimates arrive computed, labelled `ESTIMATE`, with method and status; the `inputs` block is withheld. No AI module may import a calculation engine. |
| 16 | **Tests before enabling** | 🟡 **Partly built** | §8.1, §8.2 | See §4 below. |
| 17 | **`POST /api/ai/copilot`** | 🟢 **Built** | §7, write governance | Declared, guarded by `ai.operations`, wired to the copilot service on the mock provider. The write-governance rule was re-expressed rather than exempted — see §6. |
| 18 | **§8.4 soft warning surfaced** | 🟡 **TECH — follow-up** | §8.4 | The budget state (`UNCONFIGURED`/`OK`/`WARNING`/`BREACHED`) is now propagated through `AiDispatchResult` and `CopilotAnswer`, so it reaches the HTTP response. **No human-facing surface and no audit destination exist yet**, and the warning stays unreachable in the current production configuration because neither a cap nor a spend source is configured. **No decision is needed for the remaining work** — §8.4 names the threshold and the breach behaviour but no destination for the warning itself, so where it should surface is an engineering choice, not a management one. |

| 19 | **Rate limits** | 🟡 **Interface built — policy undecided** | §8.4 | `AiRateLimiter` and `AiRateLimitState` exist in [`rate-limit.ts`](../lib/server/ai/rate-limit.ts). **No limit value is chosen and no environment variable is declared for one**, because a limit is a number and naming `…_PER_HOUR` would already have picked the window. Demo runs `UnenforcedAiRateLimiter`, which allows everything and reports `state: 'none'`; it throws if constructed in production. Production is refused `NO_RATE_LIMIT_POLICY` — a gate that outlives the retention decision, since a durable spend source does not supply a rate-limit policy. |
| 20 | **DEMO/UAT activation** | 🟡 **Path built — values external** | §8.4, §13 Q6 | The full configuration contract, its validation rules and every named refusal are in §9. A demo can be switched on once four values exist: credential, model id, pricing, cap. Nothing degrades into a mock, an unlimited budget or an unpriced call. |

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
8. **Rate limits per user and per role** (§8.4). The *interface* now exists; the numbers
   and the window do not, and their absence is what refuses production with
   `NO_RATE_LIMIT_POLICY`. Item 5 asks the same question — they are one decision.

Until 1 and 2 are answered, no AI feature can run: the guardrail refuses an unconfigured
cap by design, and there is nowhere to log a call that is made.

---

## 8 · Provider facts, and where they came from

Verified against the official documentation on **2026-08-26** rather than from memory, as
required before selecting an implementation. No model id and no price is written into
source; both are configuration, so a change at OpenAI is a configuration change here.

| What was verified | Source |
|---|---|
| Recommended API surface for new integrations — the Responses API, and its request fields (`model`, `instructions`, `input`) | `developers.openai.com/api/docs/guides/migrate-to-responses`, `.../api/reference/typescript` |
| Token usage field names — `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `total_tokens` | `developers.openai.com/api/docs/guides/prompt-caching`; corroborated by `openai-python/src/openai/types/responses/response_usage.py` |
| Current text model line and the cost-optimised member | `developers.openai.com/api/docs/models` |
| Published pricing, stated per **1M tokens**, with a separate cached-input rate | `developers.openai.com/api/docs/pricing` |
| Error statuses and types — 400, 401, 403, 429 (including project/organization spend limits), 500, 503 | `developers.openai.com/api/docs/guides/error-codes` |
| Key handling and project separation — environment variables or a secret manager, never in code or a repository; separate projects for separate environments | `developers.openai.com/api/docs/guides/production-best-practices` |

**The official Node SDK is deliberately not installed.** It retries twice by default, and
§8 defines no retry policy; a retry is a second charge against a budget somebody has to
answer for. The adapter calls the documented REST endpoint once, so "one request in, one
call out" holds by construction rather than by remembering to disable a default. It also
keeps the dependency count and the client-bundle surface unchanged.

**A leak the tests caught before it shipped.** The adapter originally relayed the
provider's own `error.type` through a conservative-looking pattern. A key is letters,
digits and hyphens and matches that pattern, so a provider echoing something key-shaped
would have had it repeated into an operator-facing message. Only literals from an
allowlist the adapter owns are emitted now, so relaying cannot leak by construction.

---

## 9 · Activation — DEMO/UAT is reachable, PRODUCTION is not

**Phase 9 is not production-ready and nothing below makes it so.** What follows separates
the part that a person with an authorised credential can switch on this week from the part
that is waiting on decisions nobody has taken.

### 9.1 The configuration contract

Every name is the environment's own `<PREFIX>` convention — `DEMO_` for demonstration,
`PRODUCTION_` for production — so a demo credential and a production credential are
different variables and neither environment has a code path that reads the other's. The
proposed `DEMO_OPENAI_API_KEY` is exactly what the code reads: `AI_ENV_VARS.apiKey` is
`OPENAI_API_KEY`, and `readAiApiKey` prefixes it. No new convention was invented.

| Variable (shown with the `DEMO_` prefix) | What it is | Validation | Refusal when absent or wrong |
|---|---|---|---|
| `DEMO_AI_ENABLED` | The activation switch | The literal string `true`, trimmed and lowercased. Anything else is off | `NOT_ENABLED` |
| `DEMO_AI_PROVIDER` | Which adapter | Must be one of `SELECTABLE_AI_PROVIDERS` — `openai` or `mock` | `NO_PROVIDER` / `UNKNOWN_PROVIDER` |
| `DEMO_OPENAI_API_KEY` | The credential | Presence only. **The value never enters `AiRuntimeConfig`** | `NO_API_KEY` |
| `DEMO_AI_MODEL_COPILOT` | The model id | Shape check: no whitespace, quotes or control characters. Admits dated snapshots and `ft:…::…` | `NO_MODEL` |
| `DEMO_AI_PRICE_INPUT_PER_MTOK` | Published input price | A non-negative number, **per million tokens** | `NO_PRICING` |
| `DEMO_AI_PRICE_OUTPUT_PER_MTOK` | Published output price | Same | `NO_PRICING` |
| `DEMO_AI_PRICE_CACHED_INPUT_PER_MTOK` | Published cached-input price | Optional. Absent means cached input is charged at the full input rate — an overstatement, which can only trip a cap early | — |
| `DEMO_AI_PRICE_CURRENCY` | What the provider bills in | Compared case-insensitively with the budget currency | `NO_PRICING` |
| `DEMO_AI_BUDGET_CURRENCY` | What the cap is expressed in | Must match the price currency | `CURRENCY_MISMATCH` |
| `DEMO_AI_BUDGET_CAP` | The approved monthly cap | A non-negative number. Absent is `UNCONFIGURED`, **never unlimited** | `NO_BUDGET_CAP` |
| `PRODUCTION_AI_PRODUCTION_APPROVED` | Production's second lock | The literal string `true`, mirroring `PRODUCTION_WRITES_ENABLED` | `PRODUCTION_NOT_APPROVED` |

Two refusals cannot be configured away at all, and both are production-only:
`NO_SPEND_SOURCE` and `NO_RATE_LIMIT_POLICY`. See §9.4.

**No rate-limit variable is declared.** §8.4 requires per-user and per-role limits but
names no number and no window, and naming a variable like `AI_MAX_CALLS_PER_HOUR` would
already have chosen the window even with the value left blank. The interface exists in
`lib/server/ai/rate-limit.ts`; the policy does not.

### 9.2 Where the credential is supplied

Never in this repository, never in a commit, never in a document, and never pasted into a
conversation. Three places, depending on where the code is running:

| Running where | Supplied how |
|---|---|
| **Local demo/UAT** | `.env.local` in the project root. `.gitignore` now covers `.env*` with a single exception for `.env.example`, so every dotenv variant Next.js reads — `.env.production` included — is untrackable |
| **Deployed demo/UAT** | Netlify → Site configuration → Environment variables, scoped to the deploy context. ARCHITECTURE §10.1 names Netlify as the host (Next.js runtime, route handlers as Netlify Functions); that is the existing target and no second one was introduced |
| **Production** | The same Netlify mechanism under `PRODUCTION_` names, plus `PRODUCTION_AI_PRODUCTION_APPROVED`. Still refused today — §9.4 |

Use a **project-scoped** key (`sk-proj-…`). OpenAI's own production guidance recommends a
separate project per environment so usage, rate limits and spend are attributable and
cappable per project rather than pooled across an account. It also means revoking the demo
key cannot disturb anything else, and that the credential owner can see this project's
spend without it being mixed into somebody else's.

### 9.3 What each environment does today

| | DEMO / UAT | PRODUCTION | Parity harness |
|---|---|---|---|
| Can a real provider run? | Yes, once §9.1 is fully configured | **No** — two refusals stand regardless of configuration | No — it has no AI code path at all |
| Spend accounting | Process-local accumulator on the usage sink | None | — |
| Rate limiting | `UnenforcedAiRateLimiter` — allows everything and reports `state: 'none'` | No limiter; `aiRateLimiterFor('production')` returns `null` | — |
| Durable usage log | None. The in-process array holds no question text, writes nothing to disk, and is gone on restart | Blocked on retention | — |
| The switch | `DEMO_AI_ENABLED=true` | `PRODUCTION_AI_ENABLED=true` **and** `PRODUCTION_AI_PRODUCTION_APPROVED=true`, and still refused | — |

The parity harness reads only `PARITY_*` variables and imports nothing from
`lib/server/ai/`. A `PARITY_OPENAI_API_KEY` would be read by nothing — asserted, not
assumed, in `tests/ai-activation.test.ts`.

**The demo spend source is process-local, and that is not production-safe accounting.** It
is correct for one instance and wrong for several: a restart resets the total, and two
instances each count only their own. For a demonstration — a handful of invited people, a
small explicit cap, someone watching — that is a known and bounded gap. For production it
is the silent overspend §8.4's hard cap exists to prevent, which is why production is
refused rather than approximated.

### 9.4 What is still blocking

**DEMO/UAT needs four values**, all management decisions, none of them inventable here:

1. An authorised project-scoped credential, set in the environment by its owner.
2. An approved model id (§8.4 fixes the *policy* — cheapest capable model for routine work,
   mid-tier for the copilot's analytical questions; the *identifiers* are not fixed).
3. Published pricing for that model, per million tokens.
4. An approved monthly cap (§13 Q6), in the same currency as the pricing.

**PRODUCTION needs all of the above and three more**, and only the first two are gates the
code can see:

5. A **durable spend source** — a shared store that survives a restart and is visible to
   every instance. Blocked on the retention decision, because that is what the `ai_usage`
   table in §2 is waiting for. Until then: `NO_SPEND_SOURCE`.
6. A **rate-limit policy** — actual per-user and per-role numbers, and a limiter enforcing
   them. Until then: `NO_RATE_LIMIT_POLICY`. Note that solving (5) does not supply this;
   with a durable store in place the gate simply names this one instead.
7. A **retention and privacy decision** for what is logged: whether question text is
   stored at all, for how long, and under whose access. §1.3 permits Supabase to hold AI
   usage logs; it fixes no period, so the table stays proposed rather than created.

### 9.5 The interface is still not connected

`app/admin/ai/page.tsx` is unchanged and remains inert: a server component with no client
state, no `fetch`, no reference to `/api/ai/copilot`, and a disabled composer. Its
precondition for connection — a credential, a model, a budget and pricing configured in
DEMO/UAT — is not met, so connecting it would mean building a conversation surface with
nothing behind it.

What *was* settled is the part that does not require connecting anything:
`lib/shared/ai-copilot-view.ts` fixes the states a composer must handle — `idle`,
`loading`, `answered`, `flagged`, `refused`, `unavailable`, `failed` — mapped exhaustively
from the server contract. `refused` and `unavailable` are deliberately distinct: one is
"not this turn", the other is "no AI on this deployment", and collapsing them is how an
unconfigured demo comes to look like a broken feature.

It contains **no user-facing wording**, asserted by a test that rejects any string literal
with a space in it. Refusal copy is an open decision, and a placeholder sentence written
here would quietly answer it. Its imports from `lib/server` are type-only and erased at
compile time, so a client component can use it without any path existing by which a
credential, a provider error body or a usage row could reach a browser.

---
