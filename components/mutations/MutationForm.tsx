'use client';
/**
 * MutationForm — the one form engine every write flow uses.
 *
 * A form is DATA: an array of field specs derived (on the server page) from the V1
 * contract's input columns and LISTS vocabularies, passed in as props. Only `role: in`
 * fields can ever appear here, because the specs are authored beside the mutation
 * definitions the server enforces; calculated figures are shown with <CalculatedValue>
 * elsewhere, never as inputs.
 *
 * Validation philosophy: the SERVER is the validator. The browser contributes only
 * native required/type hints; every business refusal (422) is rendered verbatim as the
 * sentences the pipeline produced, with the operation id attached. No rule lives twice.
 *
 * Button truthfulness: SAVE → APPLYING… → VERIFIED. The verified state names the
 * record that now exists ("EXP-2026-0021 recorded"). Failure keeps the message and the
 * operation id on screen until the person dismisses or resubmits.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Field, Input, Select, Textarea, DatePicker, CurrencyInput } from '@/components/ui/form';
import { Button } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { useMutation, type MutationPhase } from './useMutation';

export interface FieldOption { value: string; label?: string }

export interface FieldSpec {
  name: string;
  label: string;
  /**
   * `boolean` renders as Yes/No with a blank third option meaning "leave it as it is".
   * The workbook's Early In / Late Out / Maint. Req. columns are `bool`, so the wire
   * value is a real boolean rather than the string "Yes" — the column type and the
   * payload type say the same thing.
   */
  type: 'text' | 'textarea' | 'currency' | 'number' | 'date' | 'time' | 'select' | 'boolean';
  options?: FieldOption[];
  required?: boolean;
  help?: string;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
}

export interface MutationFormProps {
  endpoint: string;
  method?: 'POST' | 'PATCH';
  fields: FieldSpec[];
  submitLabel: string;
  /**
   * Success toast template. '{id}' is replaced with the verified record's identifier
   * (a string, because server components cannot hand functions to the client).
   */
  successTemplate: string;
  /** Which record field carries the identifier, e.g. 'ExpenseID'. */
  idField?: string;
  /** Fixed values merged into every payload (e.g. a status transition). */
  constants?: Record<string, unknown>;
  onVerified?: (record: Record<string, unknown>) => void;
  /** Extra content above the buttons (e.g. a CalculatedValue explainer). */
  children?: ReactNode;
}

/**
 * Place a value at a DOTTED PATH inside the payload.
 *
 * `lines.0.itemRef` means "the itemRef of the first line", and a numeric segment builds an
 * array rather than an object — which is what a purchase request, a purchase order and a
 * goods receipt all need, because each of them carries lines.
 *
 * A name with no dot is written exactly where it always was, so every existing form is
 * untouched by this. Dotted names could not have worked before: they would have reached the
 * server as a literal key and been refused by a strict schema, which is why nothing depends
 * on the old behaviour.
 */
function place(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i]!;
    const nextIsIndex = /^\d+$/.test(segments[i + 1]!);
    const container = cursor as Record<string, unknown>;
    if (container[key] === undefined) container[key] = nextIsIndex ? [] : {};
    cursor = container[key] as Record<string, unknown> | unknown[];
  }
  (cursor as Record<string, unknown>)[segments[segments.length - 1]!] = value;
}

function coerce(spec: FieldSpec, raw: string): unknown {
  if (raw === '') return undefined;                 // omitted optional — never an empty write
  switch (spec.type) {
    case 'currency':
    case 'number': return Number(raw);
    // '' was already returned as undefined above, so only a real choice reaches here.
    case 'boolean': return raw === 'true';
    default: return raw;
  }
}

export function MutationForm({
  endpoint, method = 'POST', fields, submitLabel, successTemplate, idField, constants, onVerified, children,
}: MutationFormProps) {
  const { phase, failure, submit, reset } = useMutation(endpoint, method);
  const toast = useToast();
  const initial = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ''])),
    [fields],
  );
  const [values, setValues] = useState<Record<string, string>>(initial);

  // A fresh mount is a fresh intent.
  useEffect(() => { reset(); setValues(initial); }, [reset, initial]);

  const set = (name: string) => (value: string) =>
    setValues((v) => ({ ...v, [name]: value }));

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (phase === 'applying' || phase === 'verified') return;
    const payload: Record<string, unknown> = { ...constants };
    for (const spec of fields) {
      const value = coerce(spec, values[spec.name] ?? '');
      if (value !== undefined) place(payload, spec.name, value);
    }
    const outcome = await submit(payload);
    if (outcome.ok && outcome.record) {
      const id = idField ? String(outcome.record[idField] ?? '') : '';
      toast.push({ tone: 'success', title: successTemplate.replace('{id}', id) });
      onVerified?.(outcome.record);
    }
  };

  return (
    <form className="sv-mutation-form" onSubmit={onSubmit} noValidate={false}>
      <div className="sv-mutation-form__fields">
        {fields.map((spec) => (
          <Field key={spec.name} label={spec.label} required={spec.required} help={spec.help}>
            {(wiring) => renderControl(spec, values[spec.name] ?? '', set(spec.name), wiring)}
          </Field>
        ))}
      </div>

      {children}

      {failure ? (
        <div className="sv-mutation-form__failure" role="alert">
          <p className="sv-mutation-form__failure-title">
            <Icon name="warning" size={16} /> {failure.message}
          </p>
          {failure.details?.length ? (
            <ul className="sv-mutation-form__failure-list">
              {failure.details.map((d) => <li key={d}>{d}</li>)}
            </ul>
          ) : null}
          <p className="sv-mutation-form__failure-meta">Operation {failure.operationId}</p>
        </div>
      ) : null}

      <div className="sv-mutation-form__actions">
        <SubmitButton phase={phase} label={submitLabel} />
      </div>
    </form>
  );
}

function renderControl(
  spec: FieldSpec,
  value: string,
  onChange: (v: string) => void,
  wiring: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': true | undefined },
) {
  const common = { ...wiring, required: spec.required, placeholder: spec.placeholder };
  switch (spec.type) {
    case 'select':
      return (
        <Select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled={spec.required}>{spec.placeholder ?? 'Choose…'}</option>
          {(spec.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label ?? o.value}</option>
          ))}
        </Select>
      );
    case 'boolean':
      return (
        <Select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          {/* Blank is not "No". Leaving it alone must leave the cell alone — the panel
              renders an unrecorded flag as "Not recorded", and so must the form. */}
          <option value="" disabled={spec.required}>{spec.placeholder ?? 'Leave unchanged'}</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      );
    case 'textarea':
      return <Textarea {...common} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'currency':
      return <CurrencyInput {...common} value={value} onValueChange={onChange} />;
    case 'number':
      return (
        <Input
          {...common} type="number" inputMode="numeric" value={value}
          min={spec.min} max={spec.max}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return <DatePicker {...common} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'time':
      return <Input {...common} type="time" value={value} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <Input {...common} type="text" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** SAVE → APPLYING… → VERIFIED — the truthful button. */
export function SubmitButton({ phase, label }: { phase: MutationPhase; label: string }) {
  const text = phase === 'applying' ? 'Applying…'
    : phase === 'verified' ? 'Verified'
      : label;
  return (
    <Button
      type="submit"
      variant="primary"
      disabled={phase === 'applying' || phase === 'verified'}
      aria-live="polite"
      data-phase={phase}
    >
      {phase === 'verified' ? <Icon name="check" size={16} /> : null}
      {text}
    </Button>
  );
}
