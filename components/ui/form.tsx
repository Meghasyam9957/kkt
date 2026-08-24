'use client';
/**
 * Form controls — Srivillu design system.
 *
 * One family: Field wraps label + control + help + error with correct associations;
 * Input/Select/Textarea/DatePicker/CurrencyInput are the controls. Native elements
 * throughout — a styled <select> and <input type="date"> beat a reimplementation on
 * keyboards, screen readers and phones.
 *
 * Money rule: CurrencyInput formats DIGITS for reading (en-IN grouping). It performs no
 * arithmetic and never derives a figure — formatting is presentation, calculation is the
 * workbook's. The submitted value is the plain number string.
 *
 * INPUT vs CALCULATED: only INPUT fields render as controls. A calculated figure is
 * shown with <CalculatedValue>, visibly locked — never a disabled input, which reads as
 * "temporarily unavailable" rather than "owned by the workbook".
 */
import {
  useId, useState,
  type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode,
} from 'react';
import { Icon } from './icons';

/* ------------------------------------------------------------------ *
 * Field wrapper
 * ------------------------------------------------------------------ */

export interface FieldProps {
  label: string;
  /** The control, rendered with id/aria wiring via render prop. */
  children: (wiring: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
  }) => ReactNode;
  help?: string;
  error?: string;
  required?: boolean;
}

export function Field({ label, children, help, error, required }: FieldProps) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`sv-field ${error ? 'sv-field--invalid' : ''}`}>
      <label className="sv-field__label" htmlFor={id}>
        {label}
        {required ? <span className="sv-field__required" aria-hidden="true"> *</span> : null}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error ? (
        <p className="sv-field__error" id={errorId} role="alert">
          <Icon name="warning" size={14} /> {error}
        </p>
      ) : null}
      {help ? <p className="sv-field__help" id={helpId}>{help}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="sv-input" {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="sv-input sv-input--textarea" rows={props.rows ?? 3} {...props} />;
}

export function Select({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="sv-select">
      <select className="sv-input sv-input--select" {...rest}>{children}</select>
      <span className="sv-select__chevron"><Icon name="chevronDown" size={16} /></span>
    </span>
  );
}

/** Native date input: correct keyboard, correct mobile pickers, zero JS. Value is ISO. */
export function DatePicker(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="date" className="sv-input sv-input--date" {...props} />;
}

/**
 * Rupee amount entry. Shows the ₹ and Indian-system grouping while reading; the value
 * handed to forms/handlers is the plain digits string. No arithmetic happens here.
 */
export function CurrencyInput({
  value, onValueChange, name, ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  /** Plain number string, e.g. "43000". */
  value: string;
  onValueChange: (plain: string) => void;
  name?: string;
}) {
  const [focused, setFocused] = useState(false);
  const plain = value.replace(/[^\d]/g, '');
  const display = focused || plain === ''
    ? plain
    : new Intl.NumberFormat('en-IN').format(Number(plain));
  return (
    <span className="sv-currency">
      <span className="sv-currency__symbol" aria-hidden="true">₹</span>
      <input
        className="sv-input sv-input--currency numeric"
        inputMode="numeric"
        autoComplete="off"
        value={display}
        onChange={(e) => onValueChange(e.target.value.replace(/[^\d]/g, ''))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...rest}
      />
      {/* The submitted value is always the plain number, whatever is being displayed. */}
      {name ? <input type="hidden" name={name} value={plain} /> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Calculated / read-only display
 * ------------------------------------------------------------------ */

/**
 * A figure the workbook owns. Rendered as a value with a lock note, never as a disabled
 * input. `sourceNote` defaults to the one true sentence.
 */
export function CalculatedValue({ label, children, sourceNote = 'Calculated by the workbook' }: {
  label: string; children: ReactNode; sourceNote?: string;
}) {
  return (
    <div className="sv-field sv-field--calculated">
      <span className="sv-field__label">{label}</span>
      <span className="sv-calculated">
        <span className="sv-calculated__value numeric">{children}</span>
        <span className="sv-calculated__note">{sourceNote}</span>
      </span>
    </div>
  );
}
