'use client';
/**
 * Write-flow entry points:
 *
 *   NewRecordButton  — "+ New Expense" → Drawer → MutationForm. Create flows.
 *   RowActionButton  — "Check In", "Mark Clean", "Resolve" on a row. Zero-field actions
 *                      submit directly with the truthful phase on the button itself;
 *                      actions that need words (a cancellation reason, a resolution
 *                      date) open a small dialog with exactly those fields.
 *
 * Both run the same useMutation contract: one operation id per opened intent, no
 * optimistic state, failures stay visible with the operation id attached.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Drawer, Modal } from '@/components/ui/overlay';
import { Button } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { MutationForm, type FieldSpec } from './MutationForm';
import { useMutation } from './useMutation';

/* ------------------------------------------------------------------ *
 * Create flows
 * ------------------------------------------------------------------ */

export function NewRecordButton({
  label, title, endpoint, fields, submitLabel, successTemplate, idField, constants, wide, children,
  onOpenChange,
}: {
  /** Button text, e.g. "+ New Expense". */
  label: string;
  /** Drawer heading, e.g. "Record an expense". */
  title: string;
  endpoint: string;
  fields: FieldSpec[];
  submitLabel: string;
  successTemplate: string;
  idField?: string;
  constants?: Record<string, unknown>;
  wide?: boolean;
  children?: ReactNode;
  /**
   * Told when the drawer opens and closes. Presentation only — it exists so a list can
   * mark WHICH row the open form belongs to, which a form floating over a list of four
   * identical-looking units otherwise cannot say.
   */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  // Remount the form per opening: a reopened drawer is a NEW intent with a new
  // operation id — reusing the old one would replay the previous submission.
  const [intent, setIntent] = useState(0);

  return (
    <>
      <Button variant="primary" onClick={() => { setIntent((n) => n + 1); setOpenState(true); }}>
        {label}
      </Button>
      <Drawer open={open} onClose={() => setOpenState(false)} title={title} wide={wide}>
        <MutationForm
          key={intent}
          endpoint={endpoint}
          fields={fields}
          submitLabel={submitLabel}
          successTemplate={successTemplate}
          idField={idField}
          constants={constants}
          onVerified={() => setOpenState(false)}
        >
          {children}
        </MutationForm>
      </Drawer>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Row actions
 * ------------------------------------------------------------------ */

export function RowActionButton({
  label, endpoint, method = 'POST', successTemplate, idField, fields, confirmTitle,
  variant = 'secondary', size = 'sm', surface = 'modal', context, constants,
}: {
  label: string;
  endpoint: string;
  method?: 'POST' | 'PATCH';
  successTemplate: string;
  idField?: string;
  /**
   * When present, the action opens a dialog carrying exactly these fields (a reason,
   * a date) before anything is sent. Absent → one click, one submission.
   */
  fields?: FieldSpec[];
  confirmTitle?: string;
  variant?: 'secondary' | 'ghost' | 'danger' | 'primary';
  size?: 'sm' | 'md';
  /**
   * Where the fields are asked for. A centred dialog suits a one-line confirmation; a
   * side drawer (bottom sheet on a phone) suits a front-office action that needs the
   * booking in front of the person before they commit. Same mutation path either way.
   */
  surface?: 'modal' | 'drawer';
  /**
   * Read-only detail shown ABOVE the fields — who is arriving, which unit, how long.
   * Context only: nothing here is submitted, and it never carries a financial figure on
   * an operational surface (the caller passes a role-projected row).
   */
  context?: ReactNode;
  /**
   * Values the ACTION carries rather than the person — a status transition, a no-show
   * flag. Merged into every submission, with or without fields, so an action whose
   * meaning is fixed does not have to ask a person to restate it.
   */
  constants?: Record<string, unknown>;
}) {
  const { phase, failure, submit, reset } = useMutation(endpoint, method);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState(0);

  const fire = useCallback(async () => {
    const outcome = await submit({ ...constants });
    if (outcome.ok && outcome.record) {
      const id = idField ? String(outcome.record[idField] ?? '') : '';
      toast.push({ tone: 'success', title: successTemplate.replace('{id}', id) });
    } else if (outcome.failure) {
      toast.push({
        tone: 'error',
        title: outcome.failure.message,
        detail: outcome.failure.details?.join(' '),
        operationId: outcome.failure.operationId,
      });
      reset();      // a refused row action is over; the next click is a fresh intent
    }
  }, [submit, toast, successTemplate, idField, reset, constants]);

  if (!fields || fields.length === 0) {
    const text = phase === 'applying' ? 'Applying…' : phase === 'verified' ? 'Done' : label;
    return (
      <Button
        variant={variant} size={size} data-phase={phase}
        disabled={phase === 'applying' || phase === 'verified'}
        onClick={fire}
      >
        {phase === 'verified' ? <Icon name="check" size={14} /> : null}
        {text}
      </Button>
    );
  }

  const Surface = surface === 'drawer' ? Drawer : Modal;
  return (
    <>
      <Button variant={variant} size={size} onClick={() => { setIntent((n) => n + 1); setOpen(true); }}>
        {label}
      </Button>
      <Surface open={open} onClose={() => setOpen(false)} title={confirmTitle ?? label}>
        {context ? <div className="sv-action-context">{context}</div> : null}
        <MutationForm
          key={intent}
          endpoint={endpoint}
          method={method}
          fields={fields}
          submitLabel={label}
          successTemplate={successTemplate}
          idField={idField}
          constants={constants}
          onVerified={() => setOpen(false)}
        />
      </Surface>
    </>
  );
  void failure;
}
