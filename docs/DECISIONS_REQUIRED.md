# Phase 9 — decisions required

Phase 9 (AI copilot) is built to the edge of every decision nobody has made. This is that
list, and nothing else: each item is evidenced from [ARCHITECTURE.md](ARCHITECTURE.md) or
from the code as it stands at `fc826e4`.

**Nothing here is a recommendation to adopt.** Where the architecture already recommends a
value it is quoted as a recommendation, not carried forward as an answer.

Current state: `aiEnabled()` returns `false`, no OpenAI SDK is installed, no file reads an
`OPENAI` environment variable, no external call is made, and the only executable provider
is a local mock. `POST /api/ai/copilot` is declared and wired; every request today refuses
with `INTEGRATION_DISABLED`. See [PHASE9_READINESS.md](PHASE9_READINESS.md) for the full
readiness matrix.

## How to read the classification

| Tag | Meaning |
|---|---|
| **FIXED** | Already settled by the architecture. Not open for decision; listed only so it is not re-litigated. |
| **TECH** | An implementation choice. Engineering can make it once the decisions it depends on exist. |
| **MGMT** | A business, product, legal or cost decision. **Needs you.** |
| **CRED** | Requires a credential or authorisation from whoever owns it. Cannot be resolved by writing code. |

---

## ⚠️ Credential rule, before anything below

**No existing office or organisation OpenAI account may be assumed usable for this
project.** Using an employer's, client's or shared API credential requires **explicit
authorisation from the credential owner and the project authority**, recorded — cost is
billed to that account, and prompts sent under it may fall under that organisation's data
handling terms rather than this project's.

No secret has been requested, inspected, copied, committed or configured, and none will be.
When a credential is authorised it is set as an environment variable by the person who owns
it; it is never pasted into a conversation, a file or a commit.

---

## 1 · Monthly OpenAI budget cap — **MGMT**

| | |
|---|---|
| **Evidence** | §13 Q6: *"Monthly OpenAI budget cap? (Recommend $25 to start.)"* — the **only** row in §13 whose "Blocks" column names Phase 9. §10.2: *"**Recommend a hard cap of $25/month** initially — roughly 2× the estimate, so a bug cannot become a bill."* §8.4 requires a hard cap with a soft warning at 70%. |
| **Enforced now** | The 70% soft-warning ratio is computed (it is the architecture's number) and the resulting budget state now travels through the dispatch result into the copilot response. **It still reaches no operator and no audit destination**, and it cannot occur in the current production configuration, which has neither a cap nor a source of accumulated spend. Surfacing it to a person is outstanding engineering work, not a decision. The cap is **not defaulted**: an unset cap resolves to `UNCONFIGURED` and refuses every AI feature with `BUDGET_UNCONFIGURED`. A test asserts the guardrails module supplies no cap of its own (`tests/ai-guardrails.test.ts`, which scans that one file). |
| **Missing** | The figure. Also its period boundary — calendar month or billing month — which §8.4 does not state. |
| **Blocks** | **Every AI call.** Nothing runs while the cap is unset, by design: reading a missing cap as "no limit" is precisely the silent overspend §8.4 forbids. |

## 2 · AI usage and conversation retention period — **MGMT** (legal)

| | |
|---|---|
| **Evidence** | §1.3 permits Supabase to hold *"AI conversation + token logs"*. **No retention or purge clause exists in any of the three migrations** — not `audit_log`, not `operations`. R11 names retention a management decision requiring legal review. §13 Q7 asks a retention question only for *guest* data, at Phase 10. |
| **Enforced now** | No table exists. Production wires `DiscardingAiUsageSink`, which discards while AI is off — honest, since the only records are refusals of calls that never happened — and **throws if `aiEnabled()` ever returns true**, so enabling AI requires providing a real sink rather than remembering to. |
| **Missing** | The retention period for usage rows and for conversation rows, and the compliance owner. |
| **Blocks** | Creating the `ai_usage` table — **no migration file exists**, only a proposed DDL block in PHASE9_READINESS §2 marked *do not apply*. That in turn blocks the `/admin/ai` usage dashboard and §8.4's *"every call logged"*. |

## 3 · Whether question/answer text is stored, and its redaction — **MGMT** (privacy)

| | |
|---|---|
| **Evidence** | §1.3 names *"AI conversation"* logs but specifies no fields for them. §8.3: *"Guest names are stripped from copilot context by default."* That rule governs the **context assembled for the model** — it says nothing about text a member of staff typed. |
| **Enforced now** | Guest names are stripped at the copilot context boundary; contact details are structurally absent from every view the copilot can reach. **No question or answer text is persisted**, and the usage record is discarded. The audit log *does* record that a person asked the copilot, when, and from what IP — `audit_log` receives a row for every guarded request, including this route's `ai.copilot.ask`. |
| **Missing** | Whether the question and the answer are stored; if so, what redaction applies to a question an admin typed, which may name a guest freely. Whether tool payloads are retained alongside. |
| **Blocks** | Any conversation table, and conversation history in the copilot page. |

## 4 · Model ID per tier, and where model config lives — **MGMT** (cost) + **TECH**

| | |
|---|---|
| **Evidence** | §8.4 fixes the **policy**: cheapest capable model for classification/extraction/summaries, a mid-tier reasoning model only for the copilot's analytical questions, no flagship model for routine work. It also fixes that *"Model IDs live in config, changeable without a deploy."* The **policy is FIXED**; the identifiers are not. |
| **Enforced now** | No module in the AI layer names a model. The model arrives as data on each request; production passes an empty string, and no call is made. |
| **Missing** | The identifier per tier, and where that config lives — environment, Supabase, or workbook settings. §8.4 says "config" without locating it. |
| **Blocks** | Any real provider call. |

## 5 · Cost currency and confirmed per-token pricing — **MGMT**

| | |
|---|---|
| **Evidence** | §10.2: *"Assumptions to confirm at build time: current per-token pricing, and average context sizes after the caps in §8.4."* §10.2 states both the estimate and the recommended cap in **dollars**; the business's own figures are in **rupees**. Nothing reconciles the two, or states which currency an *enforced* cap and a logged cost would use. |
| **Enforced now** | Pricing is a parameter (`AiTokenPricing`, per token — no per-thousand or per-million convention to guess at). `computeCost` is pure. A test scans every module in the AI layer for a numeric rate assigned to the pricing fields (`tests/ai-provider.test.ts`) — a tripwire on those field names, not a proof that no number anywhere is a rate. A call with no pricing configured is **refused** with `NO_PRICING`: a call whose cost cannot be computed is a call the hard cap cannot bound. |
| **Missing** | The currency, and the confirmed rates per model. |
| **Blocks** | Cost accounting → the budget cap → every call. Item 1 cannot be enforced meaningfully without this one. |

## 6 · Per-feature token / context caps — **MGMT** (cost) + **TECH** (enforcement)

| | |
|---|---|
| **Evidence** | §8.4: *"Context caps: max input tokens per feature, enforced before the call."* No values are given for any feature. |
| **Enforced now** | **Nothing.** `estimateTokens` exists and is explicitly marked an approximation for sizing and the mock only, never for billing. The request body deliberately carries **no length bound**: the specified control is a token cap, and a character limit would pre-empt this decision in a different unit. |
| **Missing** | The maximum input tokens per feature. |
| **Blocks** | Pre-call enforcement. Until then a question is unbounded in length. |

## 7 · Kill-switch storage location — **MGMT** + **TECH**

| | |
|---|---|
| **Evidence** | §8.4: *"Per-feature kill switches (copilot / guest / reviews / summaries) **in admin settings**."* This application has no writable settings store. §4.4 settles it: *"**Business rules stay editable in the workbook only.** The web app displays them read-only."* (§13 Q5 asks the same question and is still **open** — it is §4.4, not Q5, that fixes the position.) |
| **Enforced now** | The four features are named exactly as §8.4 names them. The precedence rule is implemented — integration gate outranks budget, budget outranks switch — and `ALL_FEATURES_OFF` is the frozen default. Positions are passed in; no home for them is invented. |
| **Missing** | Where switch positions live, and who may flip them. |
| **Blocks** | Operating the switches at all. Today they can only be set in process by a caller. |

## 8 · User-facing wording for each refusal outcome — **MGMT** (product)

| | |
|---|---|
| **Evidence** | §8.4 requires that on breach features degrade *"with a clear message — never a silent overspend"*. §8 specifies **no text for the person who asked**, and the UI redesign plan documents no error rendering for a connected copilot. |
| **Enforced now** | Six refusal codes exist — `INTEGRATION_DISABLED`, `BUDGET_UNCONFIGURED`, `BUDGET_EXCEEDED`, `FEATURE_SWITCHED_OFF`, `NO_PROVIDER`, `NO_PRICING` — each carrying an operator-facing message, returned unchanged over HTTP. No user-facing mapping is written. |
| **Missing** | The wording per code, and its audience. *"No monthly AI budget cap is configured"* is an operator's sentence, not a manager's. |
| **Blocks** | Connecting the copilot page, which currently stays inert by its own documented contract. |

## 9 · Rate limits per user and per role — **MGMT** (values) + **TECH** (mechanism)

| | |
|---|---|
| **Evidence** | §8.4: *"Rate limits per user and per role; stricter for the guest endpoint."* §1.3 permits Supabase to hold rate-limit counters. No values are given. |
| **Enforced now** | **Nothing limits this application's own callers** — no middleware, no limiter dependency, no rate-limit table in any migration, and `reports/security.json` lists "rate limiting" under `notYetImplemented`. (Retry-and-backoff code does exist for Google's 429s in `lib/server/sheets/client.ts`; that is *outbound* quota handling, not inbound limiting.) |
| **Missing** | The limits per user and per role. |
| **Blocks** | Exposing the route to real traffic. §11 places rate limits in **Phase 12** ("Security & QA hardening"), so this is a Phase 9 gap only in the sense that the route would be live before its limiter exists. |

## 10 · Guest assistant specification and whitelist — **MGMT** + specification

| | |
|---|---|
| **Evidence** | §8.1 names four tools — `getStayInfo`, `getHouseRules`, `getAmenities`, `createGuestRequest` — and the rule that its facade returns *"Whitelisted fields ONLY"*, but **never the whitelist**. §11 places it at Phase 10. §13 Q13 (how the link reaches the guest) and Q7 (retention and DPDP owner) are unanswered. |
| **Enforced now** | Not built, deliberately. Two tripwires fail the day a guest tool registry or an `/api/ai/guest` route appears without §8.1's whitelist assertions landing beside them. |
| **Missing** | The field whitelist per tool. A data source for house rules, amenities and approved FAQ — **none of them is a sheet in the generated contract**. The booking-token issue and verify path. A mutation contract for `createGuestRequest`, which fits none of this application's existing write patterns. |
| **Blocks** | Phase 10 in its entirety. |

---

## Credential and authorisation items — **CRED**

| Item | What is needed | Note |
|---|---|---|
| **OpenAI credential** | A project-authorised account and a server-side key per environment (`DEMO_*` / `PRODUCTION_*` namespacing already exists) | See the credential rule above. **An office or shared account requires explicit authorisation from its owner.** Not a code task. |
| **LIVE parity** | `PARITY_SHEET_ID` and `PARITY_SERVICE_ACCOUNT_FILE` (or `..._JSON_BASE64`) | Offline parity passes 212/212; LIVE is `PENDING`. The two variables are **step 6 of six** in [LIVE_PARITY_GATE.md](LIVE_PARITY_GATE.md) — a PARITY copy of the workbook, seeded fictional data, `CFG_REPORT_MONTH` and the parity business rules set inside it, a service account, and the copy shared as Viewer all come first. §11 makes proven data a precondition for AI: *"Must sit on proven data; otherwise it lies confidently."* |

---

## READY AFTER APPROVAL

Phase 9 can be completed when every line below is ticked. Each maps to a numbered item above.

- [ ] **Approved budget** — cap figure and period boundary *(item 1)*
- [ ] **Approved retention / data policy** — retention periods, whether conversation text is stored, redaction, compliance owner *(items 2, 3)*
- [ ] **Approved models** — model ID per tier and the config location *(item 4)*
- [ ] **Approved pricing / currency** — confirmed per-token rates and the currency *(item 5)*
- [ ] **Approved rate and token limits** — per-feature context caps, per-user and per-role rate limits *(items 6, 9)*
- [ ] **Approved kill-switch location** — where positions live and who may flip them *(item 7)*
- [ ] **Approved refusal wording** — user-facing text for each of the six codes *(item 8)*
- [ ] **Approved OpenAI / project credential** — authorised by the credential owner and the project authority, set as an environment variable by them *(CRED)*
- [ ] **LIVE parity credentials** — `PARITY_SHEET_ID` + service account, and the gate green *(CRED)*
- [ ] **Approved guest-assistant specification** — field whitelist per tool, data sources, token path, request-creation contract *(item 10)*

**Five of these gate the whole phase, and they are checked in this order.** Anything above
refuses before anything below it is consulted.

1. **The integration gate.** `aiEnabled()` is `false` and no provider is configured, so
   every request refuses with `INTEGRATION_DISABLED` today — regardless of the cap. This
   is the credential line, and it is the operative gate right now.
2. **The budget cap** (item 1) — an unset cap refuses every feature.
3. **Pricing** (item 5) — an uncostable call cannot be capped, so it is refused.
4. **A usage sink**, which depends on retention (item 2) — the production sink *throws* if
   AI is ever enabled without a real one.
5. **A model ID** (item 4) — needed for any real provider call.

Items 3, 6, 7, 8, 9 and 10 block a specific capability rather than the phase.
