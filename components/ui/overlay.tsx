'use client';
/**
 * Overlays — Modal, Drawer, ConfirmationDialog. One focus implementation (focus.ts),
 * one scrim, one set of motion classes. Per the design system §18:
 *   Dialog  — confirmations only, centred, <=480px
 *   Drawer  — contextual detail beside a list, right side, focus-trapped
 * Both: Escape closes, scrim click closes, focus returns to the opener, body scroll
 * locked, no backdrop blur, reduced motion renders instantly (motion.css).
 */
import { useRef, type ReactNode } from 'react';
import { useFocusTrap } from './focus';
import { Icon } from './icons';
import { Button } from './primitives';

function Scrim({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="sv-scrim m-scrim-enter"
      aria-label="Close and return to the page"
      onClick={onClose}
    />
  );
}

export function Modal({ open, onClose, title, children, footer }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useFocusTrap(surface, open, { onClose });
  if (!open) return null;
  return (
    <div className="sv-overlay" role="presentation">
      <Scrim onClose={onClose} />
      <div
        ref={surface}
        className="sv-modal m-scale"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="sv-modal__header">
          <h2 className="sv-modal__title">{title}</h2>
          <button type="button" className="sv-overlay__close" onClick={onClose}>
            <Icon name="close" size={18} label="Close this dialog" />
          </button>
        </header>
        <div className="sv-modal__body">{children}</div>
        {footer ? <footer className="sv-modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, footer, wide = false }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** 560px instead of 420px — statements, long records. */
  wide?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useFocusTrap(surface, open, { onClose });
  if (!open) return null;
  return (
    <div className="sv-overlay" role="presentation">
      <Scrim onClose={onClose} />
      <div
        ref={surface}
        className={`sv-drawer m-drawer-enter ${wide ? 'sv-drawer--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="sv-drawer__header">
          <h2 className="sv-drawer__title">{title}</h2>
          <button type="button" className="sv-overlay__close" onClick={onClose}>
            <Icon name="close" size={18} label="Close this panel" />
          </button>
        </header>
        <div className="sv-drawer__body">{children}</div>
        {footer ? <footer className="sv-drawer__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * Confirmation for consequential actions (a cancellation, a close-out). Two buttons,
 * the destructive one named for what it does — never just "OK".
 */
export function ConfirmationDialog({
  open, onClose, onConfirm, title, body, confirmLabel, tone = 'danger', busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  /** Names the action: "Cancel this booking", "Close the ticket". */
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Keep as it is</Button>
          <Button variant={tone} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      )}
    >
      {body}
    </Modal>
  );
}
