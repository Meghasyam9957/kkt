'use client';
/**
 * Toast — how a mutation's outcome reaches the person who asked for it.
 *
 * Rules:
 *   - a success toast states WHAT was written and WHERE ("EXP-2026-0187 recorded"),
 *     because "Saved!" is a claim, not information;
 *   - a failure toast carries the operation ID so it can be found in the audit log;
 *   - `role="status"` for successes (polite), `role="alert"` for failures;
 *   - toasts dismiss themselves after 6s (successes) but failures stay until dismissed —
 *     an error that disappears on its own was never really shown;
 *   - nothing loops or bounces; enter is one slide, per the motion system.
 */
import {
  createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { Icon } from './icons';

export interface ToastInput {
  tone: 'success' | 'error' | 'info' | 'warning';
  title: string;
  detail?: string;
  /** Shown on failures so support can find the attempt in the audit log. */
  operationId?: string;
}

interface ToastItem extends ToastInput { id: number }

const ToastContext = createContext<{ push: (toast: ToastInput) => void } | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const SUCCESS_DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { ...toast, id }]);
    if (toast.tone !== 'error') {
      setTimeout(() => dismiss(id), SUCCESS_DISMISS_MS);
    }
  }, [dismiss]);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sv-toasts" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`sv-toast sv-toast--${toast.tone} m-overlay-enter`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <span className="sv-toast__icon">
              <Icon
                name={toast.tone === 'success' ? 'check' : toast.tone === 'info' ? 'info' : 'warning'}
                size={16}
              />
            </span>
            <div className="sv-toast__text">
              <p className="sv-toast__title">{toast.title}</p>
              {toast.detail ? <p className="sv-toast__detail">{toast.detail}</p> : null}
              {toast.operationId ? (
                <p className="sv-toast__meta">Operation {toast.operationId}</p>
              ) : null}
            </div>
            <button type="button" className="sv-toast__dismiss" onClick={() => dismiss(toast.id)}>
              <Icon name="close" size={14} label="Dismiss this notification" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
