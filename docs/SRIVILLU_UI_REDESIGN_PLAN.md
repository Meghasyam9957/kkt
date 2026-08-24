# Srivillu UI Redesign Plan

**Status:** DRAFT v1 — awaiting approval. No production UI code has been changed.
**Companion:** `SRIVILLU_DESIGN_SYSTEM.md` (the rules). This document is the work.
**Invariant:** business behaviour is identical before and after. Everything here is presentation, navigation and interaction.

---

## 1. Current UI audit

### 1.1 Method

- Read every file under `app/`, `components/`, `styles/` and the shared navigation/role/brand modules.
- Ran six parallel code audits (shell, dashboard, ledger pages, operations, investor/AI/sign-in/demo, tests-and-providers) and a design-director critique over the combined result.
- Opened the running DEMO app in the in-app browser at 1440×900 (light and dark) and 390×844, as admin and as an investor, and measured layout with DOM scripts. Screenshots were taken of the dashboard, operations today, Copilot, sign-in, access-denied and portfolio.

### 1.2 What is already good (keep verbatim)

- **The honesty architecture.** `KPICard` has first-class value / loading / unavailable states; "Not configured" and "Not tracked" are never ₹0. `FreshnessIndicator` never claims "Live" when stale. The DEMO / UAT badge is gated on `environment.banner` so production structurally cannot show it.
- **Token foundation** in `styles/tokens.css`: light and dark palettes, reduced-motion zeroing, tabular numerals, status colours deliberately distinct from brand green.
- **Accessibility scaffolding**: skip link, breadcrumb landmark, `role="group"` filters, `region` table scrollers, hidden chart tables, live regions, status never by colour alone.
- **RBAC layering**: `checkPageAccess` before any data read; nav filtering is convenience, the guard is the control; investor scope only from the session; operations view carries zero money fields by construction.
- **Server-first architecture**: every page reads through `getDataProvider()`; client components only `import type`. Charts are library-free SVG.
- **Logo contract**: height pinned, width from the file, three-step fallback; the app never redraws the badge.

### 1.3 Problems found (ranked)

| # | Problem | Where | Severity |
|---|---|---|---|
| 1 | **Fabricated alert count.** `alertCount={4}` is a literal, shown as a red badge to every role including investors, on a bell with no click handler. | `app/admin/layout.tsx:89`, `AppShell.tsx:146` | High |
| 2 | **Investor lands on "Not available for your role."** Post-sign-in redirect goes to `/admin/dashboard` regardless of role; AccessDenied's only escape goes there too. Seen live. | `api/session/route.ts`, `AccessDenied.tsx` | High |
| 3 | **Sign-in wordmark is invisible.** `.sv-logo__word` is cream `#FAF6EC` on a white card (measured). The lockup was only styled for the green sidebar. | `styles/app.css` sign-in | High |
| 4 | **Page scrolls sideways on phones.** At 390px `scrollWidth` 541: the top-bar right cluster overflows. | `.sv-topbar__right` | High |
| 5 | **Four nav items active at once** on Operations › Today; breadcrumb reads "Housekeeping". Housekeeping/Maintenance/Inventory alias `/admin/operations`; Compliance/Audit alias `/admin/settings`. Seven promised screens do not exist. | `lib/shared/navigation.ts:47–53, 86–90` | High |
| 6 | **Mobile drawer is not accessible**: no focus trap, no Escape, no scroll lock, hidden rail stays in tab order. | `AppShell.tsx` | High |
| 7 | **Charts are mouse-only** and scale 10px SVG text to ~5px on phones (fixed 720 viewBox). | `components/charts/Charts.tsx` | High |
| 8 | **No hierarchy on the dashboard.** Fourteen equal tiles; "Today" (attention) starts at 901px on a 900px viewport; on a phone the page is 4,823px tall before property performance. Open maintenance appears twice. | `DashboardView.tsx` | High |
| 9 | **Sub-legible type tier**: 9px and 10px labels at reduced opacity (env facts, scenario chip, nav badges, section titles). | `app.css` | Medium |
| 10 | **Generic SaaS silhouette**: dark sidebar + white 56px top bar + cream well; emoji "☰"/"🔔" as icons; text-only 20-item nav; identical white tiles everywhere; Material-style pastel pills. | shell, KPI, board | Medium |
| 11 | **Roadmap language on client screens**: "Phase 7", "Phase 8" badges; Investor Reports is a permanent empty state; Forecast is a redirect; Copilot prompt "chips" are non-interactive `<div>`s. | nav, reports, ai | Medium |
| 12 | **Copy addressed to an auditor**: "computed by the shared business engine", "Nothing here is entered by hand", "marker M1". | dashboard, ops, demo | Medium |
| 13 | **Raw identifiers where names belong**: `HYD-501` as option text and column values; ISO dates "Departs 2027-01-21". | FilterBar, views | Medium |
| 14 | **Two button systems, two badge systems, spacer-`<div>` rhythm, inline styles** with decimal opacities and `rgba(79,95,44,0.07)` in TSX. | primitives, pnl, distributions | Medium |
| 15 | **Investor portal is the admin console with the menu removed**: dark rail with one link, "Admin › Portfolio", bell, "Switch". | portfolio, shell | Medium |
| 16 | **Invalid HTML** `<li>` children of `<dl>` on every financial page. | `DemoAssumptionsNotice.tsx` | Low |
| 17 | **No public website at all** — `/` redirects to the admin dashboard. | `app/page.tsx` | — (scope) |
| 18 | **No brand artwork on disk**; `public/brand/` holds only the README. | — | Blocker for brand moments |
| 19 | **No screenshot or visual-regression tooling.** | `package.json` | — (QA) |

### 1.4 Information architecture vs the target sidebar

| Target | Today | Action |
|---|---|---|
| Dashboard | `/admin/dashboard` ✓ | Redesign |
| Properties, Reservations | ✓ list pages | Redesign; add detail drawers |
| Today | `/admin/operations/today` ✓ | Redesign |
| Housekeeping, Maintenance, Inventory | aliases of Today | Real routes `/admin/operations/{housekeeping,maintenance,inventory}` rendering the existing board slices; each with its own `capability` |
| Guest Requests | no route | New route `/admin/operations/requests`; primary production state is "Not tracked" (live provider declares `guestRequests` unavailable) |
| Revenue, Expenses, Cash Flow, P&L | ✓ | Redesign (statement mode for P&L) |
| Investors, Distributions | ✓ | Redesign |
| Reports | shell with empty state | Redesign the empty state honestly; no new data |
| Performance | ✓ | Redesign |
| Forecast | redirect to Performance | Honest "Forecasting is not yet available" page with what it will show; no fake numbers |
| Srivillu Copilot | inert shell | Redesign as §8 of the plan; still not connected |
| Compliance, Settings, Audit | aliases of Settings | `/admin/settings` keeps Settings; Compliance and Audit become anchored sections of a System page, or real routes if the data exists — decision below |
| Portfolio (investor) | ✓ | Own shell |

---

## 2. Srivillu design direction

**Name: The Verandah Ledger.** Fully specified in `SRIVILLU_DESIGN_SYSTEM.md` §1–§9. In one paragraph:

Cream paper, olive ink, a single gold rule, terracotta where the guest is. Serif for the things that matter — the headline, the number that leads — and a quiet sans for everything that works. Surfaces are separated by hairlines and space, not by floating white panels. The public site is a verandah: photography, light, slow reveals. The product is a ledger: aligned figures, one hero number, nothing between the reader and the truth. The mark is never redrawn; the logo is never stretched; the demo badge is never hidden.

What changes visibly on day one of implementation: the dark sidebar becomes a cream rail with line icons; the white top bar becomes a masthead inside the page; fourteen tiles become one hero figure, a ledger row of five, and an attention strip; emoji become icons; 9px type disappears.

---

## 3. Page-by-page redesign plan

### 3.1 Public website (new, `app/(public)/`)

| Route | Purpose |
|---|---|
| `/` | Hero → story → featured stays → experience → amenities → reviews → stay journey → FAQ → enquire |
| `/stays` | Discovery: four editorial property cards with filters by bedrooms |
| `/stays/[slug]` | One residence: gallery placeholder, facts, amenities, location, enquire |
| `/enquire` | Contact options; no backend form in this phase |

`app/page.tsx` stops redirecting to the admin; the public home is the root. `/signin` is linked from the public footer ("Owner & team sign in"). The root layout splits: `(public)` gets `public.css` and no admin fonts beyond the shared two; `admin` keeps its layout.

### 3.2 Admin

| Route | Redesign |
|---|---|
| `/admin/dashboard` | See §7. Masthead with lead sentence → Pulse ledger row (hero Revenue + Occupancy, Operating Profit, ADR, RevPAR, Cash) → Attention strip → Property performance (4 object cards) → Financial trend (3 charts) → Position ledger (units, receivables, payables, pending distributions, open tickets) → Insights plate |
| `/admin/properties` | Four object cards (same component as dashboard, expanded) + ledger table; click → drawer with the unit's facts and current guest (minimised) |
| `/admin/reservations` | Ledger table with sticky ID column, status pills, stacked mobile layout; drawer per booking |
| `/admin/finance/revenue`, `expenses`, `cashflow` | Ledger tables; masthead hero = period total; filters as a ledger row |
| `/admin/finance/pnl` | Statement mode: sections, subtotal ink rules, double-rule total; hero = operating profit and margin |
| `/admin/investors` | Register as ledger; object card per investor with participation |
| `/admin/investors/distributions` | Waterfall as a statement; "Configuration required" plate when terms are unset (string pinned) |
| `/admin/investors/reports` | Honest empty: what reports will be, when; no badge |
| `/admin/analytics/performance` | Two charts + KPI ledger; resizable charts |
| `/admin/analytics/forecast` (new, replaces redirect) | Honest "not available" plate |
| `/admin/ai` | Copilot shell, §8 |
| `/admin/settings` | Read-only ledger of business, rules, channels; Compliance and Audit as anchored sections with honest states |
| `/admin/operations/*` | §9 |

### 3.3 Investor (`/admin/portfolio`)

Own shell (`ShellVariant="investor"`): no rail, masthead with lockup + name + "Statement as at February 2027", sections: Your position · This period · Distribution history · Portfolio performance · Reports. Demo notice with `scope="investor"`. No forms, no buttons (pinned). Sign-out in the masthead is a link to `/api/session` DELETE via a plain anchor-free method — see risk note in §16.

### 3.4 Guest portal (future-ready, `app/(guest)/stay/[token]`)

Built against the demo guest-journey data only in this phase; no live provider. Sections per §26 of the design system. The existing `/admin/demo/guest-journey` becomes a presenter's preview that embeds the same components.

### 3.5 Sign-in

Split layout on desktop: left, a cream panel with the lockup and a line of the story; right, the form. The demo identity chooser becomes four object cards with role and a one-line description — the "₹12,00,000 invested · INV-001" detail moves out of the card body. The wordmark is visible. Post-sign-in redirect goes to `/admin` (the role-aware landing), fixing the investor dead end.

---

## 4. Component system plan

Build order inside `components/ui/`:

1. `icons.tsx` — bespoke set (design system §8).
2. `layout.tsx` — `Stack`, `Cluster`, `Grid`, `Masthead`, `Section` (replacing spacer divs).
3. `Button` — one system; `.sv-button` removed.
4. `Card` with `variant="ledger|object|plate"`.
5. `KPICard` with `emphasis`, source line, ledger-row layout; `KPIRow`.
6. `StatusPill`, `Tag`, `Chip`.
7. `DataTable` with density, statement mode, sticky column, stacked mobile, sorting.
8. `Popover`, `Drawer`, `Dialog`, `Command` (one focus-management utility shared by all four).
9. `Charts` — measured viewBox, keyboard points, tooltip, draw-in.
10. `PropertyCard` (dashboard + properties + public variant via a `surface="product|public"` prop; the public variant uses the guest-facing name and never shows money).
11. `AttentionStrip`, `Timeline`, `RequestCard` (operations).
12. `Statement` (investor / P&L), `ProvenanceChip`, `Notifications`, `UserMenu`.
13. Public: `Hero`, `StorySection`, `Gallery` (placeholder-aware), `ReviewMark`, `JourneyLine`, `FAQ`, `EnquireBar`.

CSS: `app.css` split into `shell.css`, `ledger.css`, `ops.css`, `investor.css`, `guest.css`, `public.css`, `motion.css`; test-pinned class names kept (design system Appendix B). Inline styles with decimal opacities moved to CSS.

---

## 5. Motion system

Specified in the design system §19. Implementation decisions:

- **No GSAP, no Lenis by default.** Reasons: (1) the storyboard's reveals, stagger and parallax are achievable with CSS `animation-timeline: view()` (Chromium, Safari 26+) plus a 1.2KB IntersectionObserver fallback; (2) Lenis replaces native scrolling, which harms accessibility and mobile feel, and the brief asks for a site that is easy to navigate on mobile; (3) GSAP + ScrollTrigger is ~70KB of JS that the admin must never pay for and the public site does not need. **Re-evaluate only** if the pinned "stay journey" sequence cannot be done cleanly with CSS; that decision is made in Phase C with a working prototype, not assumed now.
- One hook (`useReveal`) and one counter (`useCounter`) are the only JavaScript motion.
- Admin route transitions: content fade only.
- Every animated element is `transform`/`opacity`/`clip-path`; no layout animation.
- Reduced motion zeroes all tokens, removes parallax, counters and reveals.

---

## 6. Public website storyboard

Scroll position is given as a fraction of the page; each beat names its motion primitive.

| Beat | Section | What the visitor sees | Motion |
|---|---|---|---|
| 0.00 | **Hero** | Full-bleed photograph (placeholder-labelled until real), olive scrim at the base, the lockup top-left, headline "Stay somewhere that feels like home." in display serif, sub "A refined short-stay experience in Hyderabad.", CTAs "Explore Stays" (primary) and "Plan Your Stay" (secondary). A thin gold rule under the eyebrow "Srivillu Home Stays · Hyderabad". | Headline `.m-reveal` then CTAs `.m-slide` (stagger); image `.m-parallax` ±6%; a one-line scroll cue that fades out on first scroll |
| 0.12 | **01 — Home** (story) | Two-column: left an editorial paragraph about the house and the people; right a photograph. The word "home" sits large in serif italic as a pull quote. | `.m-reveal` on the image, `.m-fade` on text, once |
| 0.24 | **02 — The rooms** | Horizontal band of three photographs with captions (bedroom, living, kitchen). | Stagger reveal as the band enters; no carousel autoplay |
| 0.34 | **03 — Comfort** (amenities) | A ledger of amenities in two columns with line icons: Wi-Fi, kitchen, linen, air-conditioning, housekeeping, parking. | `.m-stagger` fade, capped |
| 0.44 | **Featured stays** | Four property cards: photograph placeholder, guest-facing name, bedrooms, guests, "From ₹— / night" only if approved (otherwise "Enquire for rates"), "View residence". | Cards `.m-slide` stagger; hover lifts the photo with `--shadow-photo` |
| 0.56 | **04 — The neighbourhood** | Map-style illustration placeholder (no third-party map embed) + three short notes on what is nearby. | `.m-fade` |
| 0.66 | **What guests say** | Three review marks in serif italic, with first name and month. Placeholder copy clearly marked "Sample review" until real reviews are supplied. | `.m-reveal` |
| 0.76 | **The stay journey** | A vertical line with five stops: Enquire → Confirm → Arrive → Stay → Depart. Each stop lights as it enters the viewport; the line draws. The one scroll-driven sequence. | `animation-timeline: view()` on the line; IO fallback |
| 0.88 | **FAQ** | Six disclosures (check-in, Wi-Fi, parking, pets, cancellations, long stays). | Native `<details>` with a `--m-medium` height transition |
| 0.96 | **Book your stay at Srivillu** | Olive-deep band, cream serif headline, contact options (call, WhatsApp, email) as large secondary buttons. | `.m-fade` |
| 1.00 | **Footer** | Lockup, address, contact, "Owner & team sign in". | none |

Mobile: hero 70svh; the rooms band scrolls horizontally by touch; stays stack; parallax off; the journey line still draws (cheap).

---

## 7. Admin UX structure

### 7.1 Shell

Rail (232px, cream-deep, icons + labels, one active item) · Masthead (breadcrumb, serif title, context cluster) · Content (max 1360). Command palette on `Ctrl/⌘+K`. Notifications from data or hidden.

### 7.2 Dashboard — the story from "what is happening" to "what should I do"

| Order | Block | Answers |
|---|---|---|
| 1 | **Masthead lead sentence** — "February 2027 · ₹2,43,433 revenue, 79.5% occupancy, operating profit up 37.6% on January. 3 items need attention." Composed from the KPIs the page already receives; no new arithmetic (the sentence only formats `KpiValue`s). | How is the business performing? |
| 2 | **Pulse** — ledger row: hero Revenue (2-col, counter on first paint), Occupancy, Operating Profit, ADR, RevPAR, Cash position | The six figures the brief names |
| 3 | **Attention** — plate with the urgent list (critical → high → watch), each with property, one-line action, and a drawer link. Heading "Today" (pinned string, exactly once). | What needs attention? Is anything urgent? |
| 4 | **Unit performance** (pinned heading) — four property object cards: name + ID, BHK, status pill, occupancy, revenue, profit, ADR, RevPAR, current issue; "Best performer this month" / "Weakest performer this month" markers (pinned strings, once each) | Which property is doing best? |
| 5 | **Money in, money out** — Revenue trend (first, pinned order), Occupancy trend, Revenue/expenses/profit | What came in, what went out, why? |
| 6 | **Position** — secondary ledger: total/occupied/available units, receivables, payables, pending investor distributions, open maintenance tickets (once, not twice) | Detail |
| 7 | **Insights** — plate with three Copilot-style statements derived from the same figures ("Occupancy improved 13% while ADR fell 17% — volume is up, rate is down") with "Ask Copilot" chips. Marked "Derived from this month's figures" — not AI. | What should I do? |

The first viewport at 1440×900 contains blocks 1–3. At 390 it contains 1 and the hero of 2.

---

## 8. Copilot shell (`/admin/ai`)

Not connected. Redesigned as a premium assistant surface:

- Two-pane: conversation (left, 2/3) and context (right, 1/3).
- Conversation opens with a serif greeting and four suggested questions as real `Chip` buttons: "What needs attention today?", "Which property is performing best?", "Why did profit change?", "What should I focus on this week?". Clicking one inserts it into the composer (no request is sent; the composer stays disabled with a quiet note "Copilot is not connected yet").
- Messages, when they exist, are not bubbles: a ledger of turns — eyebrow "You" / "Srivillu Copilot", body text, and for assistant turns a **sources line** ("From 99_CALC · February 2027 · updated 4 min ago") and a hairline. System data quoted inside an answer is set in the numeric style with a left ink rule so it is visibly distinct from prose.
- Context panel: the current filters (month, property, platform), data freshness, and "What Copilot can see" (the provider methods, in plain words).
- The page source keeps "Phase 7" in a comment and `disabled` on the composer (pinned).

---

## 9. Operations UX structure

### 9.1 Today (`/admin/operations/today`)

- Masthead: "Thursday 19 February" + property filter only.
- **Attention plate** first (pinned "Needs attention" hidden text in toned tiles).
- **Timeline** for the day: a vertical line with time-ordered stops — check-outs (morning), cleaning windows, check-ins (afternoon), maintenance visits, guest requests as they arrive. Each stop: time, property, what, status pill, priority, a quick action (secondary button → drawer).
- **Counts** as a compact ledger row: Check-ins · Check-outs · Cleaning · Maintenance · Guest requests · Inventory — each linking to its section or route; "Not tracked" plate for unavailable keys.
- No money; no margins; no investor language (provider-guaranteed).

### 9.2 Housekeeping, Maintenance, Inventory, Guest Requests

Real routes rendering the board slices that already exist in `OperationsBoardView`: turnover list with cleaner and inspection status; open tickets by priority with age; stock lines below minimum; requests with status. Each a ledger with status pills and a drawer. Each declares its own `capability` (`housekeeping.read`, `maintenance.read`, `inventory.read`; guest requests under `operations.view`) so `page-access` tests keep passing and only one nav item is active.

### 9.3 Mobile

One column, 44px targets, the timeline as the primary view, filters as a bottom sheet, no charts.

---

## 10. Investor UX structure

"A private wealth statement, not a trading terminal."

1. **Masthead** — lockup, "Anand Rao", "Statement as at February 2027", gold ornament rule.
2. **Your position** — three serif figures in a ledger row: capital, participation, status.
3. **This period** — your share of the distribution pool with the calculation shown as a short statement (pool → your participation → your share), "Pending" status; "Configuration required" plate when terms are unset.
4. **Distribution history** — statement table, ink rule above total paid.
5. **Portfolio performance** — approved portfolio KPIs only (net revenue, operating profit, occupancy) as a ledger; one calm chart.
6. **Reports** — list of approved reports with date; honest empty state.
7. Demo assumptions notice (`scope="investor"`), muted, at the top of the money sections.

Constraints kept: no form or button in the page source; scope from the session only; no search params.

---

## 11. Guest UX structure

`/stay/[token]` (future), built on demo journey data now.

1. **Welcome** — "Welcome to Srivillu, Priya." serif, the residence name, dates, a terracotta accent line.
2. **Your stay** — check-in/out times, door code (when provided), host contact.
3. **Wi-Fi** — name and password in a large copyable plate.
4. **Amenities** — icon ledger.
5. **House rules** — short, warm, numbered.
6. **Around you** — three recommendations with distance.
7. **Need something?** — one-field request with large submit (demo: fixed response; live: deferred).
8. **Your host** — name, photo placeholder, call/WhatsApp.
9. **Checkout** — time, three-item checklist, "Thank you for staying".

Language warm, second person; never platform, payout, fee, investor, expense, margin, revenue (pinned by the demo-journey test).

---

## 12. Asset requirements and contract

### 12.1 Brand (blocker for brand moments)

`public/brand/srivillu-logo.png` (master) and `public/brand/srivillu-mark.svg` are **not on disk**. Nothing was attached to the redesign brief that the tooling can read. Until they arrive the shell runs in the typographic fallback, which the redesign makes presentable (visible wordmark on every surface) but which is **not the brand**. Please drop the two files in; the app detects them on the next request and `tests/brand.test.tsx` measures them.

### 12.2 Property photography contract (new)

```
public/properties/HYD-501/manifest.json   { "hero": "hero.jpg", "gallery": ["01.jpg", ...], "alt": {...} }
public/properties/HYD-501/hero.jpg
public/properties/HYD-501/01.jpg …
(same for HYD-502, HYD-601, HYD-602)
```

A resolver `lib/server/properties/media.ts` mirrors `lib/server/brand/assets.ts`: reads what exists, measures dimensions, returns `null` for missing files. Components render a labelled placeholder for `null`. When photography arrives, no code changes. Images served through `next/image` with AVIF/WebP and explicit sizes; the hero uses `priority`.

### 12.3 Guest-facing names

One map in `lib/shared/properties.ts` (not in fixtures — `app/` and `components/` may not import fixtures):

| Internal | Public |
|---|---|
| HYD-501 | Srivillu 2-Bedroom Residence · Fifth Floor |
| HYD-502 | Srivillu 1-Bedroom Residence · Fifth Floor |
| HYD-601 | Srivillu 2-Bedroom Residence · Sixth Floor |
| HYD-602 | Srivillu 1-Bedroom Residence · Sixth Floor |

Admin shows both (`HYD-501 · Fifth Floor 2BHK`); public and guest surfaces show only the public name.

### 12.4 Copy assets

Hero headline and sub (given). Story paragraph, amenities list, house rules, FAQ answers, review samples: drafted in Phase C as placeholders marked "Sample copy", for the business to replace.

---

## 13. Skills and plugins

Checked `ListSkills`, `SearchSkills`, `ListPlugins`, `~/.claude/skills`, `~/.claude/plugins`, and both project `.claude/` directories.

- **Installed:** docx, pptx, xlsx, pdf, skill-creator, import-memory, morning. None is a frontend, design, scroll, animation or visual-QA skill.
- **"Scrollcraft", "Lume", a premium-frontend or cinematic-scroll skill: not installed and not available to add** from the skill search. No such skill will be claimed.
- **What will actually be used:** this design system (authored from first principles in this document set), the in-app Browser pane for live visual inspection (already used for the audit), and optionally Playwright as a dev dependency for file-backed screenshots (§15). No GSAP/Lenis by default (§5).

---

## 14. Performance risks

| Risk | Mitigation |
|---|---|
| Public-site JS leaking into the admin bundle | Route groups with separate layouts; public components live under `components/public/` and are never imported by admin routes; `next build` route sizes checked per phase |
| Hero image LCP | `next/image` with `priority`, ≤220KB AVIF, explicit `sizes`; placeholder until real photography |
| Scroll-driven animation cost on low-end phones | Parallax disabled <1024; reveals are `transform`/`opacity`; `will-change` only on the hero image |
| Chart `ResizeObserver` re-render | Debounced at 100ms; SVG reuses paths |
| Two font families, italic added | Subsets `latin`, `display: swap`, italic 500 only |
| Drawer/URL state | `router.replace` with `scroll: false`, as the filter bar already does |
| Dark theme doubling CSS | Tokens only; no per-component dark rules |
| Admin route fade | CSS only, no view-transitions API dependency |

Budgets: public first load ≤180KB JS; admin first load unchanged or lower than today (87KB shared); CLS 0 on logo (already pinned by the asset contract); Lighthouse mobile ≥90 on `/`.

---

## 15. Accessibility risks

| Risk | Mitigation |
|---|---|
| Cream-on-cream contrast at the hairline/sunken boundaries | Only text contrast is a WCAG requirement; text tokens verified ≥4.5:1 (design system §2) |
| Gold used as text by habit | Rule + lint: `--gold` may not appear in a `color:` declaration; only `--gold-deep` |
| Drawer and rail focus | One shared focus utility; tested with keyboard in QA |
| Scroll-driven reveals hiding content from AT or from reduced-motion users | Content is in the DOM and visible at rest; reveal only animates from opacity 0 when motion is allowed; `prefers-reduced-motion` makes it static |
| Chart tooltips | Keyboard focusable points, `role="tooltip"`, hidden table retained |
| Minimum text size | 11px floor enforced in tokens; old 9/10px classes deleted |
| Status by colour | Pills always carry words; deltas keep hidden verbs |
| Icon-only controls | `aria-label` required; lint on `IconButton` |
| Public `<details>` FAQ | Native semantics; no custom accordion |

---

## 16. Visual QA method

Mandatory per phase, not only at the end.

1. Start `srivillu-web` (`.claude/launch.json`, port 3210).
2. **In-app Browser pane**: each major page at 375, 390, 768, 1024, 1440, 1920; light and dark (`colorScheme`); reduced motion via a DevTools emulation class toggled by script. Inspect layout, logo alignment, typography, spacing, motion timing, overflow (`scrollWidth === clientWidth` asserted by script), loading (throttled provider), empty (filter to an empty month), error (provider forced to fail in demo), access-denied.
3. **File-backed screenshots** (recommended): add `@playwright/test` as a dev dependency and `scripts/visual-qa.mjs` that captures the same matrix into `reports/visual/<phase>/` and a contact sheet, so the review is repeatable and the before/after is kept. This is the one new tool proposed; it is dev-only and has no runtime cost. If declined, the Browser pane alone is used and that limitation is stated in the phase report.
4. **Design-spec check**: a checklist per page generated from the design system sections (type sizes present, no 9/10px, no gold text, one active nav item, no horizontal scroll, hero figure present, motion tokens only).
5. **Human-design test** (brief §26) answered in writing per phase with screenshots attached.
6. Regression: `npm run gate` (contract, typecheck, lint, test, build) after every phase.

---

## 17. Implementation order

| Phase | Scope | Exit criteria |
|---|---|---|
| **A** Audit | This document | Approved |
| **B** Design system | Tokens, motion, icons, layout primitives, Button/Card/Pill/Tag/Chip, KPI, DataTable, overlays, Charts; `app.css` split; inline styles removed; the five high-severity defects fixed (alert count, investor landing, sign-in wordmark, mobile overflow, nav aliasing) | Gate green; no visual regression on existing pages beyond the intended retune |
| **C** Public landing | `(public)` routes, storyboard §6, placeholder media and copy, motion baseline | Lighthouse mobile ≥90; 6-width screenshots |
| **D** Admin shell + dashboard | Rail, masthead, command palette, notifications-from-data, dashboard §7 | First viewport answers the seven questions; tests pass unchanged |
| **E** Operations | Today timeline; Housekeeping/Maintenance/Inventory/Guest Requests routes; drawers | OPERATIONS role sees no money; one active nav item |
| **F** Investor | Investor shell and statement | Portfolio source still has no form/button; investor isolation tests pass |
| **G** Guest portal | `(guest)` routes on demo data; presenter preview | Guest copy test passes |
| **H** AI shell | Copilot surface §8 | Source still matches `disabled` and contains "Phase 7" |
| **I** Motion and responsive refinement | Tune timings, reduced motion, 375–1920 pass, dark theme pass | No horizontal scroll anywhere; reduced-motion static |
| **J** Browser visual QA | §16 matrix, before/after sheets, human-design test | Written sign-off per page |
| **K** Regression | Full suite, contract, RBAC, isolation, audit, atomic IDs, providers, build | 652+ tests green; no business behaviour change |

Each phase is a separate change set, reviewed with screenshots before the next begins.

---

## 18. Decisions required before Phase B

1. **Playwright as a dev dependency** for file-backed screenshots (recommended) — yes / no.
2. **Compliance and Audit**: anchored sections on the System page (no new data) — or wait until audit-log reading exists and keep the items pointing at Settings?
3. **Public root**: confirm `/` becomes the public home and signed-in staff use `/admin` and `/signin`.
4. **Status palette retune** (design system §2.4): approve the warmer semantic values, or keep the current Sheets-derived ones.
5. **Rates on the public site**: "From ₹—/night" requires approved pricing; until then cards say "Enquire for rates". Confirm.
6. **Brand artwork**: please add `srivillu-logo.png` and `srivillu-mark.svg` to `public/brand/` so Phase B can verify the real lockup.
