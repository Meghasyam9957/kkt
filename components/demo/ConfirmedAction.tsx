'use client';
/**
 * A destructive-looking action behind an explicit confirmation.
 *
 * The confirmation exists because "Reset" next to a dashboard full of figures reads as
 * dangerous even when it is not — so the dialog says plainly what is and is not affected
 * before anything happens. Someone who clicks it during a demonstration should be able to
 * read the sentence and relax.
 *
 * The confirmation is a convenience, not a control. The real protection is the environment
 * guard on the server, which refuses the operation in production before it looks at who is
 * asking. This component only makes the intent deliberate.
 */
import { useState } from 'react';

export function ConfirmedAction({
  action, name, value, label, confirmTitle, confirmBody, confirmLabel,
}: {
  action: string;
  name: string;
  value: string;
  label: string;
  confirmTitle: string;
  confirmBody: string;
  confirmLabel: string;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        className="sv-btn sv-btn--danger"
        onClick={() => setConfirming(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="sv-confirm" role="group" aria-labelledby="sv-confirm-title">
      <p className="sv-confirm__title" id="sv-confirm-title">{confirmTitle}</p>
      <p className="sv-confirm__body">{confirmBody}</p>
      <div className="sv-confirm__actions">
        <form method="post" action={action}>
          <input type="hidden" name={name} value={value} />
          <button type="submit" className="sv-btn sv-btn--danger">{confirmLabel}</button>
        </form>
        <button type="button" className="sv-btn sv-btn--secondary" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
