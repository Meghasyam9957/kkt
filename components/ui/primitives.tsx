/**
 * UI PRIMITIVES — Srivillu design system.
 *
 * Restrained by intent: flat surfaces, one hairline border, generous whitespace, no
 * gradients, no heavy rounding, no decorative shadow. The brand green and gold are used
 * sparingly so that when colour appears it means something.
 *
 * Status colour is never the only signal — every status carries a label, and where an
 * icon is used it is accompanied by text.
 */
import type { ReactNode, HTMLAttributes, ButtonHTMLAttributes } from 'react';

/* ------------------------------------------------------------------ *
 * Surface
 * ------------------------------------------------------------------ */

/**
 * The surface system (§11). Three deliberate patterns instead of one recipe:
 *   `object` — raised white card; only for things that are genuinely entities.
 *   `ledger` — the product's default data surface: hairlines, no background.
 *   `plate`  — sunken region for notices, attention strips, designed empty states.
 * Omitting `variant` keeps the pre-foundation look (equivalent to `object`), so no
 * existing screen changes until it opts in.
 */
export type SurfaceVariant = 'object' | 'ledger' | 'plate';

export function Card({ children, className = '', variant, ...rest }: HTMLAttributes<HTMLDivElement> & {
  variant?: SurfaceVariant;
}) {
  return (
    <div className={`sv-card ${variant ? `sv-card--${variant}` : ''} ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title, subtitle, action, as: Heading = 'h2',
}: {
  title: ReactNode; subtitle?: ReactNode; action?: ReactNode;
  as?: 'h2' | 'h3' | 'h4';
}) {
  return (
    <div className="sv-card__header">
      <div className="sv-card__heading">
        <Heading className="sv-card__title">{title}</Heading>
        {subtitle ? <p className="sv-card__subtitle">{subtitle}</p> : null}
      </div>
      {action ? <div className="sv-card__action">{action}</div> : null}
    </div>
  );
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`sv-card__body ${className}`}>{children}</div>;
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/* §2.4 — one meaning per hue, and the brand palette never carries status. There is
   deliberately no 'brand' tone: a pill that wants olive is a pill saying "selected",
   "profit" or "ours" with a status vocabulary, which is exactly the confusion banned. */
export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

/**
 * A status pill. The dot is decorative (aria-hidden) — the text carries the meaning, so
 * the control still reads correctly without colour vision.
 */
export function StatusPill({ tone = 'neutral', children, dot = true }: {
  tone?: Tone; children: ReactNode; dot?: boolean;
}) {
  return (
    <span className={`sv-pill sv-pill--${tone}`}>
      {dot ? <span className="sv-pill__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`sv-badge sv-badge--${tone}`}>{children}</span>;
}

/**
 * Non-status metadata (§16): BHK, platform, period. Always neutral — a Tag that needs a
 * colour is a StatusPill wearing the wrong clothes.
 */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="sv-badge">{children}</span>;
}

/**
 * An interactive chip (§16): filter values, suggested prompts. A real <button>, so it is
 * keyboard- and screen-reader-real; `pressed` renders aria-pressed for toggles.
 */
export function Chip({ children, pressed, className = '', type = 'button', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return (
    <button
      type={type}
      className={`sv-chip ${className}`}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

/**
 * THE button. One system across sign-in, demo controls, forms and every ledger —
 * `.sv-button` no longer exists. `danger` is for consequential actions and is always
 * paired with a ConfirmationDialog by its caller; `link` is inline.
 */
export function Button({
  variant = 'secondary', size = 'md', children, className = '', type = 'button',
  loading = false, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'link' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /**
   * §10 — loading keeps the label and the width; the spinner is added beside it and the
   * state is announced via aria-busy. A loading button cannot be pressed again.
   */
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      className={`sv-btn sv-btn--${variant} ${size !== 'md' ? `sv-btn--${size}` : ''} ${className}`}
      disabled={loading || disabled}
      {...(loading ? { 'aria-busy': true as const } : {})}
      {...rest}
    >
      {loading ? <span className="sv-btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Data states — loading, empty, error.
 * Every data block uses one of these; a blank white box is never acceptable.
 * ------------------------------------------------------------------ */

export function Skeleton({ height = 16, width = '100%', radius = 4 }: {
  height?: number | string; width?: number | string; radius?: number;
}) {
  return (
    <span
      className="sv-skeleton"
      style={{ height, width, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

/** Skeleton for a data block, announced politely so screen readers know to wait. */
export function LoadingBlock({ rows = 3, label = 'Loading data' }: { rows?: number; label?: string }) {
  return (
    <div className="sv-state" role="status" aria-live="polite">
      <span className="sv-visually-hidden">{label}</span>
      <div className="sv-skeleton-stack">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} height={i === 0 ? 22 : 14} width={i === 0 ? '45%' : `${92 - i * 9}%`} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, message, action }: {
  title: string; message: string; action?: ReactNode;
}) {
  return (
    <div className="sv-state sv-state--empty">
      <p className="sv-state__title">{title}</p>
      <p className="sv-state__message">{message}</p>
      {action ? <div className="sv-state__action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="sv-state sv-state--error" role="alert">
      <p className="sv-state__title">Unable to load this section</p>
      <p className="sv-state__message">{message}</p>
      {onRetry ? (
        <div className="sv-state__action">
          <Button variant="secondary" onClick={onRetry}>Retry</Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * CONFIGURATION REQUIRED.
 *
 * Shown where a figure exists only once management approves a commercial rule. It must
 * never be rendered as ₹0 — a zero reads as "we earned nothing", which is a different
 * and much worse claim than "nobody has agreed the terms yet".
 */
export function ConfigurationRequired({ message, compact = false }: {
  message: string; compact?: boolean;
}) {
  return (
    <div className={`sv-config-required ${compact ? 'sv-config-required--compact' : ''}`}>
      <span className="sv-config-required__label">Configuration required</span>
      <p className="sv-config-required__message">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Layout helpers
 * ------------------------------------------------------------------ */

export function PageHeader({ title, description, actions, breadcrumb }: {
  title: string; description?: string; actions?: ReactNode; breadcrumb?: ReactNode;
}) {
  return (
    <header className="sv-page-header">
      {breadcrumb ? <div className="sv-page-header__breadcrumb">{breadcrumb}</div> : null}
      <div className="sv-page-header__row">
        <div>
          <h1 className="sv-page-header__title">{title}</h1>
          {description ? <p className="sv-page-header__description">{description}</p> : null}
        </div>
        {actions ? <div className="sv-page-header__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Section({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`sv-section ${className}`}>{children}</section>;
}

/** Wide content scrolls inside its own container; the page body never scrolls sideways. */
export function TableScroller({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="sv-table-scroller" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}
