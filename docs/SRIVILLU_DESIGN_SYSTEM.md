# Srivillu Design System

**Status:** DRAFT v1 — for approval before any production UI code changes.
**Scope:** presentation and interaction only. The V1 workbook contract, KPI engine, RBAC, providers, parity, audit, atomic IDs and environment isolation are approved and are not touched by anything in this document.

---

## 0. How to read this

Every rule here answers one of three questions:

1. **What does Srivillu look like?** — §1–§9 (philosophy, colour, type, space, shape, line, icon).
2. **How is it built?** — §10–§19 (components, navigation, overlays, motion, responsive, accessibility).
3. **How does each audience experience it?** — §20–§24 (public, admin, operations, investor, guest).

Where a rule exists because a test pins it, the test is named. Where a rule overrides what the code does today, the current behaviour is named so the change is deliberate.

---

## 1. Brand philosophy

### 1.1 What Srivillu is

A four-unit homestay in Hyderabad run by people who care about the house, the guest and the numbers — in that order. The digital product must feel like the house does: warm, unhurried, cared for, precise where precision matters.

### 1.2 The design idea: **the verandah ledger**

Two objects sit at the heart of the system.

- **The verandah** — cream plaster, olive shutters, a terracotta floor, brass and cotton, afternoon light. Calm, generous, human. This is the atmosphere of every surface: cream ground, wide margins, unhurried type, warmth in the accents.
- **The ledger** — a hand-ruled account book: hairline rules, aligned figures, small capitals for headings, numbers in a dignified serif. This is the discipline of every data surface: one hairline, one column of figures, nothing decorative between the reader and the number.

Everything in the system is one of these two or their meeting point. The public site is mostly verandah. The operations board is mostly ledger. The dashboard is where they meet.

### 1.3 Principles

1. **Paper, not panels.** The page is a cream sheet. Content sits on it separated by hairlines and space — not by floating white cards with shadows. A card is used only when a thing is genuinely an object (a property, a statement, a request).
2. **Ink, rule, ornament.** Olive is ink — text, icons, strokes. Gold is a rule or an ornament — never a fill, never text. Terracotta is warmth — hospitality moments, the guest, the home.
3. **One number leads.** Every screen has a headline figure or headline sentence. Fourteen equal tiles is not a design.
4. **Status means one thing.** Green is good, amber is attention, red is bad, blue is informational. Brand colours never carry status; status colours never decorate.
5. **Honesty is a visual property.** "Not configured", "Not tracked", "Stale" and "Demo" are designed states with their own typography, not afterthoughts. Nothing is shown as ₹0 when the truth is "unknown".
6. **Motion explains, never performs.** Inside the product, motion tells you what changed and where it went. On the public site, motion paces a story. Nowhere does it loop, bounce or glow.
7. **Indian, not themed.** Heritage shows in warmth of palette, classical typography, the diya-arc of the mark, the language of the copy and the photography. No pattern wallpaper, no paisley borders, no ornamental frames.

### 1.4 The two experiences

| | Public website | Operations platform |
|---|---|---|
| Purpose | Make someone want to stay | Help someone run the house |
| Ground | Cream with photography | Cream with figures |
| Type | Serif leads | Sans leads, serif for headline numbers |
| Motion | Cinematic, paced | Subtle, informative |
| Density | Sparse | Compact |
| Colour | Full palette incl. terracotta | Olive ink + semantic status |

They share tokens, typefaces, the mark, the icon set, buttons and forms. They do not share layouts.

---

## 2. Colour

### 2.1 Brand palette (approved, unchanged)

| Token | Value | Role |
|---|---|---|
| `--olive` | `#4F5F2C` | Primary identity. Ink, strokes, primary button, active states. |
| `--olive-deep` | `#3A4620` | Inverse surfaces (public footer, hero scrim). |
| `--olive-soft` | `#6E8140` | Hover ink, chart secondary series. |
| `--cream` | `#FAF6EC` | The page. |
| `--cream-deep` | `#F1EADA` | Sunken regions, rails, table heads. |
| `--gold` | `#C9A227` | Ornament and rule. **Never text, never a fill behind text.** |
| `--gold-deep` | `#8C6D12` | The only gold permitted as text (4.5:1 on cream), for small labels in brand moments. |
| `--terracotta` | `#B5651D` | Warm accent: guest, home, hospitality. Large text (≥19px) only. |
| `--terracotta-deep` | `#8F4E14` | Terracotta as small text. |

Contrast on cream `#FAF6EC`: olive 6.5 · ink 13.2 · ink-muted 5.0 · gold-deep 4.5 · terracotta 4.0 (large only) · terracotta-deep 6.0. **Brand gold `#C9A227` is 2.6:1 on cream and is therefore non-text by rule, not by taste.**

### 2.2 Ink

| Token | Value | Use |
|---|---|---|
| `--ink` | `#2B2B26` | Body, figures, headings. |
| `--ink-muted` | `#6B6B60` | Secondary text, metadata. Minimum for any text ≥12px. |
| `--ink-soft` | `#8A8878` | Decorative only (dividers in text, disabled). 3.3:1 — not for readable text. |
| `--ink-inverse` | `#FAF6EC` | Text on olive. |

### 2.3 Surface and line

| Token | Value | Use |
|---|---|---|
| `--surface-page` | cream | Everything. |
| `--surface-raised` | `#FFFFFF` | Objects (property card, statement, drawer). Sparingly. |
| `--surface-sunken` | cream-deep | Rails, table heads, input wells. |
| `--surface-inverse` | olive-deep | Public footer, hero overlays. |
| `--line` | `#E6DFCB` | The hairline. 1px. The default separator everywhere. |
| `--line-strong` | `#CBBFA0` | Table rules under headings, input borders. |
| `--line-ink` | olive | Section rules in editorial layouts (public site, investor statement). |
| `--rule-gold` | gold | A 1px ornament rule. Used once per screen at most. |

### 2.4 Semantic status (one meaning each)

Retuned from the current Google-Sheets-derived values to sit with olive and cream while keeping each hue unmistakable. All pass 4.5:1 on cream, cream-deep and white.

| Token | fg | bg | Meaning — and nothing else |
|---|---|---|---|
| `--good` | `#2F6B3A` | `#E9F1E4` | Completed, paid, received, improved, available |
| `--warn` | `#8F5700` | `#FBF0D9` | Attention, pending, stale, cleaning, due soon |
| `--bad` | `#A8322D` | `#F8E3E0` | Overdue, failed, maintenance, worsened, error |
| `--info` | `#2C5A8A` | `#E6EDF5` | Occupied, in house, informational |
| `--neutral` | `#6B6B60` | `#EFEBE0` | Blocked, not tracked, n/a |

Operational status map (unchanged in meaning from `STATUS_COLORS`): available → good · occupied → info · cleaning → warn · maintenance → bad · blocked → neutral.

Rules: the brand palette never appears in a status pill, delta, dot or tint. A status is always colour **plus** a word (`StatusPill` keeps its text; deltas keep their visually-hidden "improved by / worsened by").

### 2.5 Dark theme

Kept, as the current tokens already define it. Dark is an admin/operations convenience (night housekeeping, investor reading on a phone), not a brand statement. The public site is light only. Dark surfaces derive from olive-deep: page `#17190F`, raised `#1F2216`, sunken `#131509`, line `#2E3323`, ink `#ECE7D8`, brand ink `#A8BC72`. Status bg/fg pairs as currently defined in `tokens.css`.

### 2.6 What is banned

Gradients (except a single photographic scrim on the public hero), glassmorphism, glow, neon, blue/purple anything, status colours as decoration, brand colours as status, drop shadows on resting surfaces.

---

## 3. Typography

### 3.1 Faces

| Role | Face | Loaded by |
|---|---|---|
| Display | **Cormorant Garamond** 500 / 600 / 700, plus 500 italic (new — public editorial moments) | `next/font/google`, already wired as `--font-display-loaded` |
| Text / UI | **Inter** 400 / 500 / 600 | already wired as `--font-body-loaded` |
| Figures | Inter with `tnum lnum` (the existing `.numeric` utility) | — |

Inter is kept over DM Sans: it is already loaded, its tabular figures are excellent, and the brand's distinctiveness comes from the serif, the palette and the layout — not from the body face.

### 3.2 Where serif is allowed

- Page and section headings (h1, h2).
- Brand moments: wordmark lockup, public hero, investor statement title.
- **Headline figures**: the hero KPI, KPI values, the "count" in an attention tile, unit IDs on property cards.
- Public-site pull quotes and review text (italic 500).

Serif is **not** used for: navigation, table cells, filter labels, buttons, form fields, metadata, badges, chart axes, body copy in the product.

### 3.3 Scale

Two scales, one per experience. Both use `clamp()` so nothing is fixed-pixel between breakpoints.

**Product (admin / ops / investor / guest)**

| Token | Size / line | Face | Use |
|---|---|---|---|
| `--t-hero` | clamp(2.25rem, 1.6rem + 1.8vw, 3rem) / 1.05 | serif 600 | One per screen: the lead figure or sentence |
| `--t-h1` | 1.875rem / 1.15 | serif 600 | Page title |
| `--t-h2` | 1.25rem / 1.25 | serif 600 | Section title |
| `--t-kpi` | 1.75rem / 1.1 | serif 600 | KPI value |
| `--t-body` | 0.9375rem (15px) / 1.5 | sans 400 | Default |
| `--t-small` | 0.8125rem (13px) / 1.45 | sans 400 | Table cells, metadata |
| `--t-label` | 0.6875rem (11px) / 1.2, letter-spacing 0.08em, uppercase | sans 500 | Labels, column heads, section eyebrows — **the minimum size in the product** |

The current 9px and 10px tiers (`.sv-envstatus__fact dt`, `.sv-scenario-chip__label`, `.sv-nav__badge`, `.sv-nav__section-title`) are removed. Nothing readable is below 11px.

**Public**

| Token | Size | Face |
|---|---|---|
| `--p-display` | clamp(2.75rem, 1.5rem + 4.5vw, 5.25rem) / 1.0 | serif 500 |
| `--p-h2` | clamp(2rem, 1.4rem + 2vw, 3rem) / 1.08 | serif 500 |
| `--p-h3` | 1.5rem / 1.2 | serif 600 |
| `--p-lead` | 1.25rem / 1.5 | sans 400 |
| `--p-body` | 1.0625rem (17px) / 1.65 | sans 400 |
| `--p-eyebrow` | 0.75rem / 1, 0.14em tracking, uppercase | sans 500 |

### 3.4 Rules

- Headline figures use `font-variant-numeric: lining-nums` and the Indian grouping the formatter already produces (₹2,43,433).
- Labels are uppercase with tracking; nothing else is uppercase.
- Max line length for prose: 68ch product, 60ch public.
- Serif is never set below 18px.

---

## 4. Spacing

4px base. Tokens replace the spacer `<div>`s currently used for rhythm.

| Token | px | Use |
|---|---|---|
| `--s-1` | 4 | Icon-to-label, pill padding |
| `--s-2` | 8 | Inside compact controls |
| `--s-3` | 12 | Cell padding, stacked labels |
| `--s-4` | 16 | Default gap |
| `--s-5` | 24 | Card padding, between related blocks |
| `--s-6` | 32 | Between sections (product) |
| `--s-7` | 48 | Section padding (product), between groups (public) |
| `--s-8` | 64 | Public section spacing (mobile) |
| `--s-9` | 96 | Public section spacing (desktop) |
| `--s-10` | 160 | Public hero breathing room |

Composition primitives (new): `Stack` (vertical gap), `Cluster` (inline wrap gap), `Grid` (responsive columns), `Masthead`. Inline-style spacers are removed.

---

## 5. Radii

| Token | px | Use |
|---|---|---|
| `--r-1` | 3 | Inputs, buttons, pills, chips |
| `--r-2` | 6 | Cards, drawers, popovers |
| `--r-3` | 12 | Photography corners on the public site, guest-portal cards |
| `--r-pill` | 999 | Status pills, avatar |

The product is squarer than it is today (8→6, 12→unused). Rounded-everything is a SaaS tell.

---

## 6. Elevation and shadow

Resting surfaces have **no shadow**. Separation is by hairline and by surface tone (cream / cream-deep / white).

| Token | Value | Use |
|---|---|---|
| `--shadow-float` | `0 8px 24px rgba(43,43,38,.10), 0 1px 2px rgba(43,43,38,.06)` | Popovers, dropdown menus, command palette |
| `--shadow-drawer` | `-12px 0 40px rgba(43,43,38,.14)` | Side drawers |
| `--shadow-photo` | `0 12px 32px rgba(58,70,32,.18)` | Public-site photography cards on hover, only |

Decimal opacities live in CSS, never in TSX inline styles (tests/ui.test.tsx:519 scans TSX for `0.15|0.18|0.65|0.60|0.40|0.05`).

---

## 7. Borders and rules

- **Hairline** `1px solid var(--line)` is the default separator: between table rows, list items, sections in a ledger.
- **Strong line** under table headings and around inputs.
- **Ink rule** `1px solid var(--olive)` above a major editorial section (public) or above a statement total (investor).
- **Gold rule**: a single 1px gold line, 40–64px wide, used as an ornament under a section eyebrow on the public site and on the investor statement masthead. At most one per screen.
- Focus ring: `2px solid var(--olive)`, offset 2px — unchanged.

---

## 8. Iconography

A bespoke inline-SVG set, `components/ui/icons.tsx`. No icon library (a client-side library import is both a bundle cost and a test risk: client files may not value-import outside `lib/shared` — tests/security.test.ts:166).

- 20×20 grid, 1.5px stroke, round caps and joins, `currentColor`, `aria-hidden` by default; `role="img"` + descriptive `aria-label` (>10 chars, tests/ui.test.tsx:653) when an icon stands alone.
- Restrained set (~26): dashboard, property, reservation, today, housekeeping, maintenance, inventory, guest-request, revenue, expense, cashflow, pnl, investor, distribution, report, performance, forecast, copilot, compliance, settings, audit, bell, search, menu, close, chevron, arrow, check, warning, info, external, filter, calendar, wifi, key, phone, message.
- The emoji glyphs "☰" and "🔔" in `AppShell.tsx` are replaced.
- Icons are never coloured by status unless inside a status pill; they are olive ink or inherit.

The **mark** (cottage-and-arc) is never redrawn. The inline placeholder `svg.sv-mark` remains the fallback exactly as specified by `tests/brand.test.tsx`.

---

## 9. Imagery

- Photography is the public site's voice. Direction: natural light, morning and late afternoon; cotton, brass, terracotta floors, plants, the city seen from a balcony. No staged hotel-stock, no HDR, no people's faces in hero shots.
- Treatment: no filters; a single olive-deep scrim (`linear-gradient(to top, rgba(58,70,32,.55), transparent 60%)`) is permitted on the hero to carry cream text.
- Corners `--r-3` on cards, square in full-bleed sections.
- **Until real photography exists, placeholders are explicit**: a cream-deep block with a thin olive hairline frame and the label "Photography to follow · HYD-501 · hero" in `--t-label`. Never a stock image pretending to be the house. See `SRIVILLU_UI_REDESIGN_PLAN.md` §11 for the asset contract.

---

## 10. Buttons

One system. `.sv-btn` and `.sv-button` are merged into `Button` with variants:

| Variant | Look | Use |
|---|---|---|
| `primary` | olive fill, cream text, 3px radius | The one main action on a screen |
| `secondary` | cream fill, olive text, 1px olive border | Supporting actions |
| `ghost` | no fill, olive text, hairline on hover | Toolbars, cards |
| `link` | olive text, underline on hover | Inline |
| `danger` | cream fill, `--bad` text and border | Destructive — confirms via dialog |

Sizes: `sm` 32px, `md` 40px, `lg` 48px (public CTAs and guest portal). Min 44px touch target on any coarse pointer via `@media (pointer: coarse)`.

States: hover darkens/lightens one step (`--olive-deep` / `--cream-deep`), active translates 0 (no press animation), focus ring, disabled 50% with `cursor: not-allowed`, loading shows an inline spinner and keeps the width.

Public-site CTAs: `primary lg` and a `secondary lg` with a trailing arrow icon that slides 2px on hover — the only decorative hover in the system.

The `ErrorState` "Retry" button keeps its accessible name exactly "Retry" (tests/ui.test.tsx:337).

---

## 11. Cards and surfaces

Three surface patterns, used deliberately:

1. **Ledger block** (default in the product): no background, hairline above and below, heading row in `--t-label`. Used for KPI rows, tables, lists, settings.
2. **Object card**: `--surface-raised`, hairline border, `--r-2`, `--s-5` padding. Used when the thing is an entity — a property, a statement, a guest request, a conversation. Hover: border darkens to `--line-strong`; no lift.
3. **Plate**: `--surface-sunken`, no border, `--r-2`. Used for attention strips, demo notices, empty states, the guest-portal welcome.

The `Card / CardHeader / CardBody` primitives remain; `Card` gains `variant="ledger|object|plate"`. The current uniform "white tile with border" recipe on `.sv-kpi`, `.sv-today__tile`, `.sv-board__card`, `.sv-filters`, `.sv-copilot__prompt` is retired in favour of the right one of these three.

---

## 12. KPI component

`KPICard` keeps its contract (receives a `KpiValue`, never computes) and its three states (value / loading `aria-busy` / unavailable "Not configured" — tests/ui.test.tsx:304, 542). It gains:

- `emphasis="hero" | "primary" | "secondary"`. Hero: `--t-hero` figure, full-width or 2-col span, one per screen. Primary: `--t-kpi`. Secondary: `--t-body` figure in a ledger row.
- Anatomy (top to bottom): label (`--t-label`) · value (serif, `.sv-kpi__value` — class name pinned by tests/ui.test.tsx:121) · period (`formatMonthLong`) · change (`▲/▼` decorative + signed %, classes `sv-kpi__delta--up/--down/--flat` pinned by tests/ui.test.tsx:163) · source/freshness line (new, `--t-label`, muted: "From 99_CALC · updated 4 min ago").
- Hint text must never contain "%" when `changeRatio` is null (tests/ui.test.tsx:155).
- No sparklines by default. A sparkline may be passed as a child for the hero only.
- Layout: primary KPIs sit in a **ledger row** — a single hairline-bounded band with vertical hairlines between cells, not six separate tiles.

---

## 13. Tables

`DataTable` keeps `<caption class="sv-visually-hidden">`, `th[scope]`, and the `TableScroller` region. It gains:

- Heading row in `--t-label` on `--surface-sunken`, strong line beneath.
- Figures right-aligned with `.numeric`; text left; status pills centre-left.
- Row hairlines; hover tint `--cream-deep`; no zebra.
- Density `comfortable` (44px rows) default for admin, `compact` (36px) for ledgers.
- Statement mode (new) for P&L and the distribution waterfall: subtotal rows get an ink rule above, total rows get a double rule — replacing the per-row inline `style={{fontWeight, background}}` currently in `pnl/page.tsx` and `distributions/page.tsx`.
- Sticky first column on horizontal scroll.
- Mobile: tables ≤640px switch to a stacked "record" layout where each row becomes a small ledger block with label/value pairs. Never an unusable 8-column squeeze.
- Sorting on column heads where the data is a plain list (client-side, aria-sort). Not on statements.

---

## 14. Forms and inputs

- Inputs: 40px, cream-deep well, strong-line border, 3px radius, olive focus ring. Labels above in `--t-label`. Help text in `--ink-muted`. Error in `--bad` with an icon and text.
- Native `<select>` stays (FilterBar) with a custom chevron icon and the same well.
- Checkbox and radio: 18px, olive check.
- Guest-portal forms: 48px controls, one field per screen-width row, large submit.
- Filter bar becomes a single ledger row: label + control pairs with hairlines, "Reset filters" as a `link` button. Property options show the internal ID in the product (`HYD-501`), and the guest-facing name on public/guest surfaces only.

---

## 15. Charts

Library-free SVG, as today (`components/charts/Charts.tsx`). Changes:

- `viewBox` derived from a `ResizeObserver`-measured width, not a fixed 720, so text is never scaled below 11px on phones.
- Series palette: olive (primary), olive-soft (secondary), terracotta-deep (tertiary), ink-muted (reference). Status colours are not chart colours.
- Grid: hairlines only; no axis box; baseline in `--line-strong`.
- Every chart keeps `role="img"` + `aria-label` and the hidden `<table class="sv-visually-hidden">` (tests/ui.test.tsx:636–656).
- Points and bars gain `tabIndex=0`, `onFocus` mirrors `onMouseEnter`, tooltip is a positioned `<div role="tooltip">`; touch shows the tooltip on tap.
- Enter transition: bars grow from baseline, lines draw via `stroke-dashoffset`, both at `--m-slow` — once, on first paint, and not at all under reduced motion.
- Chart order on the dashboard keeps revenue trend first (tests/ui.test.tsx:639).

---

## 16. Badges, pills and chips

Merged into one family:

- `StatusPill` — status colour bg/fg, dot + text. The only pill that uses semantic colour.
- `Tag` (replaces `Badge`) — neutral: cream-deep bg, ink-muted text, `--t-label`. For metadata (BHK, platform, period).
- `Chip` — interactive (filter, suggested prompt): cream-deep bg, olive text, hairline, hover to white, `aria-pressed` where toggled. The Copilot's prompt "chips" become real `<button>`s.
- Environment badge "DEMO / UAT" — `--warn` bg/fg, bold `--t-label`, 1px border; unchanged in copy and gate (`environment.banner` non-null only — tests/ui.test.tsx:222–239).
- Roadmap badges ("Phase 7", "Phase 8") are removed from navigation and screens. Where a test pins the string (`app/admin/ai/page.tsx` must contain "Phase 7" — tests/ui.test.tsx:436), it moves to a footnote or code comment, not a badge.

---

## 17. Navigation

### 17.1 Product shell

A light shell replaces the dark-sidebar-plus-white-topbar silhouette.

- **Rail** (sidebar): 232px, `--surface-sunken` (cream-deep), hairline on the right. Logo lockup at top on cream. Sections with `--t-label` eyebrows. Items: 20px icon + label, 36px tall, olive text; active = olive 600 weight + 2px olive rule on the left edge; hover = `--cream`. Collapsible to 64px (icons only, tooltips) on ≥1024; off-canvas drawer below 1024 with focus trap, `Escape`, scroll lock and `inert` on the closed state.
- **Masthead** replaces the 56px top bar: lives inside the content column. Row 1: breadcrumb (small, muted). Row 2: page title (serif h1) on the left; on the right, the **context cluster** — environment badge (when demo), provenance chip ("Demo Workbook · updated 4 min ago", click → popover with Environment / Data source / Last synced as a `dl`, preserving the exact strings tests pin), scenario chip (demo only; keeps `sv-scenario-chip` + `href="/admin/demo"` — tests/demo-hardening.test.ts:351), notifications, user menu.
- **Notifications**: the bell shows a count only when the count comes from data (the attention list the dashboard already computes). The hard-coded `alertCount={4}` is removed. Clicking opens a popover listing the items; the count is hidden for roles without `operations.view`.
- **User menu**: avatar + name + role; menu with "Sign out" (not "Switch"), theme, and in demo "Switch demo identity".
- Navigation model stays in `lib/shared/navigation.ts` (labels/hrefs/capabilities pinned by tests/ui.test.tsx:359–389 and tests/page-access.test.ts). Aliased destinations (Housekeeping/Maintenance/Inventory → Today; Compliance/Audit → Settings) become anchored sections or real routes so that only one item is ever active (see the plan, §3).

### 17.2 Public site

Top bar: logo left, 4 links (Stays · Story · Experience · Contact), "Enquire" primary button; transparent over the hero, cream with hairline once scrolled. Mobile: logo + menu button → full-screen cream menu with serif links. Footer on olive-deep: lockup, address, contact, "Owner & team sign in" link to `/signin`.

### 17.3 Investor and guest

No rail. A masthead with the lockup and the person's name; sections stacked; a short sticky anchor strip on long screens. See §23–§24.

---

## 18. Overlays: modal, drawer, popover, command

| Pattern | When | Behaviour |
|---|---|---|
| **Popover** | Provenance, notifications, user menu, chart tooltip | Anchored, `--shadow-float`, closes on outside click/Escape, returns focus |
| **Drawer** | Contextual detail (a reservation, a property, a guest request) without leaving the list | Right side, 420–560px, `--surface-raised`, `--shadow-drawer`, focus trapped, URL updates (`?view=BK-…`) so it is shareable, `Escape` closes |
| **Dialog** | Confirmations only (demo reset, sign out in production) | Centred, ≤480px, title + body + two actions, `role="dialog"` `aria-modal` |
| **Command** | `Ctrl/⌘+K` quick actions on the product | Popover-style palette: navigate, switch month, switch property, open Copilot. Read-only actions only in this phase |

All overlays: enter `--m-medium` fade + 8px slide, exit `--m-fast`, no backdrop blur, scrim `rgba(23,25,15,.45)`. Body scroll locked while open. Reduced motion: instant.

---

## 19. Motion

One system in `styles/motion.css` + one hook. Components never invent timings.

### 19.1 Tokens

| Token | Value | Use |
|---|---|---|
| `--m-fast` | 120ms | Hover, focus, toggles |
| `--m-medium` | 220ms | Overlays, page transitions, state changes |
| `--m-slow` | 420ms | Chart draw, reveal, counters |
| `--m-cinematic` | 900ms | Public site only |
| `--e-standard` | cubic-bezier(.2,0,.2,1) | Default |
| `--e-enter` | cubic-bezier(0,0,.2,1) | Things arriving |
| `--e-exit` | cubic-bezier(.4,0,1,1) | Things leaving |
| `--e-editorial` | cubic-bezier(.16,1,.3,1) | Public reveals |

### 19.2 Primitives

| Class / hook | What | Where |
|---|---|---|
| `.m-fade` | opacity 0→1 | Everywhere |
| `.m-slide` | translateY 8px→0 + fade | Overlays, list items |
| `.m-scale` | scale .98→1 + fade | Popovers, dialogs |
| `.m-reveal` | clip-path inset 0 0 100% 0 → 0 | Public images, headings |
| `.m-stagger` | children delayed 40ms each, capped at 8 | Lists, KPI rows, property cards |
| `.m-parallax` | translateY driven by scroll, ±6% max | Public hero and story images only |
| `useReveal()` | IntersectionObserver that adds `.is-in` once | Public sections; admin only for charts |
| `useCounter()` | number tween over `--m-slow` | Hero KPI on first paint only |

Scroll-driven animation uses CSS `animation-timeline: view()` where supported, with the IO hook as the fallback — no scroll library by default (see the plan, §5 for the GSAP/Lenis decision).

### 19.3 Rules

1. Animate `transform` and `opacity` only. `clip-path` is permitted for reveals.
2. `@media (prefers-reduced-motion: reduce)` sets every `--m-*` to 0ms, disables parallax and counters, and makes `.m-reveal` static. Already partly in `tokens.css`; extended to the new tokens.
3. Nothing loops. Nothing is perpetual. Skeletons shimmer once per 1.6s and stop after 8s.
4. No entrance animation on every card. Staggered reveal happens once per route load for the KPI row and property cards; nothing else on the admin animates on load.
5. Motion communicates hierarchy (what arrived first), causality (what I clicked produced this) or state (this number changed). If it does none of those, it is removed.
6. Intensity by experience: public = cinematic; admin = subtle; operations = minimal (overlays only); investor = refined (reveal on statement sections); guest = warm/subtle (fade and slide only).
7. Page transitions in the product: content fades in over `--m-medium`; the rail and masthead do not move.

---

## 20. Responsive

Mobile-first tokens; breakpoints are intentional and few.

| Name | Width | Shell |
|---|---|---|
| `phone` | <640 | Single column; rail is a drawer; tables stack; KPIs 2-up; hero KPI full width |
| `tablet` | 640–1023 | Two columns; rail is a drawer; tables scroll with sticky first column |
| `desktop` | 1024–1439 | Rail collapsible; content max 1360 |
| `wide` | ≥1440 | Rail expanded; content max 1360 centred, margins grow |

Test widths: 375, 390, 768, 1024, 1440, 1920.

Rules: no horizontal page scroll ever (the top-bar cluster currently overflows at 390 — fixed by the masthead); every tap target ≥44px on coarse pointers; the public hero is `min(100svh, 820px)` on desktop and `70svh` on phones; motion on phones is reduced to fade/slide regardless of preference (parallax off below 1024).

---

## 21. Accessibility

Kept from the current build (it is good): skip link, landmark roles, `aria-current`, `role="group"` filters, `region` table scrollers, hidden captions and chart tables, `status`/`alert` live regions, status never by colour alone, visually-hidden change verbs.

Added:

- Minimum text size 11px; minimum contrast 4.5:1 for all text, 3:1 for large; verified for every token pair in §2.
- Drawer/menu focus management: trap, `Escape`, return focus, `inert` on hidden rail.
- Keyboard-reachable chart points and tooltips.
- Every icon-only control has an `aria-label`; every decorative icon is `aria-hidden`.
- Reduced motion honoured for the new motion tokens, parallax and counters.
- Visible focus on dark and light surfaces (olive ring on cream, gold-light ring on olive).
- Headings form a strict outline (one h1 per page; h2 sections; no skipped levels).
- Forms: label association, error text linked via `aria-describedby`, no placeholder-only labels.
- Language: `lang="en-IN"`; currency read by screen readers as "rupees".
- Valid HTML: the `<li>` inside `<dl>` in `DemoAssumptionsNotice` becomes `<div>` pairs (keeping the pinned guard line `if (resolveEnvironment().env !== 'demo') return null;` — tests/demo-hardening.test.ts:89).

---

## 22. Public-site rules

- Serif leads; sans supports. Sections are numbered in the eyebrow ("02 — The house").
- Full palette: terracotta returns here as the warm accent (hero CTA hover, review marks, the stay-journey line).
- Photography is the voice; placeholders are labelled until it arrives.
- Scroll story is linear and skippable: every section is reachable from the top-bar links; no section is pinned longer than one viewport; nothing blocks scrolling.
- Copy is addressed to a guest ("you"), never to an auditor. No internal IDs, no financial or operational language.
- Property names are guest-facing (`Srivillu 2-Bedroom Residence · Fifth Floor`), mapped from internal IDs in one place.
- No forms post to the product backend in this phase; "Enquire" opens contact options (call, WhatsApp, email) — honest about what exists.
- Performance budget: first view ≤ 180KB JS, LCP image ≤ 220KB responsive AVIF/WebP with `priority`, all other images lazy.

## 23. Admin rules

- Cream ground, ledger blocks, one hero figure per screen, object cards only for entities.
- The first viewport of every screen answers the question the screen exists for.
- Provenance (environment, source, freshness) is always one click away and never louder than the content; the DEMO / UAT badge is the one exception and stays prominent.
- Internal IDs are shown next to names (`HYD-501 · Fifth Floor 2BHK`); IDs remain in the DOM where tests expect them.
- Copy describes the business, not the engine ("Operating position for February 2027", not "computed by the shared business engine").
- Motion: subtle; overlays and first-paint stagger only.
- No "Phase" language anywhere a user can see.

## 24. Operations rules

- Minimal motion; maximum legibility; 44px targets; works one-handed on a phone.
- No money, no margins, no investor language on any operations screen (provider already guarantees this — tests/demo-hardening.test.ts:148–194).
- A timeline for the day, status chips with words, priority by position and by pill, quick actions as secondary buttons that open a drawer (read-only in this phase).
- Guest names stay minimised ("Priya M.").
- "Not tracked" is a designed state with its own plate, never a zero.

## 25. Investor rules

- Calm editorial statement: masthead with lockup and name, serif totals, ledger rows, ink rules above totals, one gold ornament rule.
- Only the investor's own figures and approved portfolio KPIs; nothing operational, no guests, no vendors, no other investors. Scope from the session only (tests/page-access.test.ts:182).
- No forms, no buttons on the portfolio page (tests/demo-hardening.test.ts:380) — downloads and period choice are deferred until that constraint is revisited.
- Demo assumptions notice present with `scope="investor"`.
- Motion: section reveal on scroll only.

## 26. Guest rules

- Warm, large, simple. `--r-3` cards, 48px controls, terracotta accents, serif welcome.
- Sections in order: Welcome · Your stay · Wi-Fi · Amenities · House rules · Around you · Need something? · Your host · Checkout.
- One action per card. Minimal forms (a request is one field and one button).
- Never shows platform, payout, fee, investor, expense, margin or revenue language (tests/demo.test.ts:473–526 for the demo journey).
- Motion: fade and slide only.

---

## Appendix A — Token file plan

`styles/tokens.css` is extended, not replaced: brand palette unchanged; ink/surface/line/status retuned as §2; type scale §3; spacing §4; radii §5; shadows §6; motion §19. `lib/shared/brand.ts` mirrors the same values (it is the source; CSS is its projection). A new `styles/motion.css` holds the primitives; `styles/public.css` holds public-only layout. `app.css` is split by surface (`shell.css`, `ledger.css`, `ops.css`, `investor.css`, `guest.css`) but class names that tests pin are kept verbatim (Appendix B).

## Appendix B — Class names and strings pinned by tests (do not rename)

`sv-kpi__value`, `sv-kpi__delta--up`, `sv-kpi__delta--down`, `sv-skeleton`, `sv-visually-hidden` (incl. `table.sv-visually-hidden` and the "Needs attention" span), `sv-today__tile--attention`, `sv-today__tile--urgent`, `sv-logo__image` on `<img>`, `sv-mark` on the inline `<svg>`, `sv-scenario-chip` and `href="/admin/demo"` in `AppShell.tsx`, `[aria-busy="true"]` on loading KPI, `role="alert"` on error state with a button named "Retry", `role="status"` on loading block.

Strings: "DEMO / UAT", "Environment", "DEMO", "PRODUCTION", "Data source", "Demo Workbook (fixtures)", "Srivillu Operations Workbook", "Last synced", "Not configured", "Management rules not configured", "Nothing to show", "No properties match this filter", "Today", "Unit performance", "MTD Revenue", "Best performer this month", "Weakest performer this month", "Revenue trend", "Occupancy trend", "Revenue, expenses and profit", "Property performance", "Needs attention", "Not available for your role", "Phase 7" (ai page source), "resets fictional demonstration data only", "not a security control", navigation labels per role.
