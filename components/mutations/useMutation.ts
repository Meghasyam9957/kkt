'use client';
/**
 * useMutation — the browser side of the write pipeline. Transport only.
 *
 * Contract with the server (Phase B2):
 *   - ONE operation id per user INTENT, minted when the flow opens — not on click.
 *     Every retry of the same intent reuses it, so a double-click, a nervous resubmit
 *     or a network retry can never create a second business row.
 *   - NO optimistic UI. The phase walks idle → applying → verified/failed, and nothing
 *     claims success before the server's read-after-write verification returns.
 *   - a failure keeps the operation id visible so the attempt can be found in the
 *     audit log; a NEW intent (after success, or after an explicit reset) gets a new id.
 */
import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export type MutationPhase = 'idle' | 'applying' | 'verified' | 'failed';

export interface MutationFailure {
  code: string;
  message: string;
  details?: string[];
  operationId: string;
}

export interface MutationOutcome {
  ok: boolean;
  record?: Record<string, unknown>;
  failure?: MutationFailure;
}

export function useMutation(endpoint: string, method: 'POST' | 'PATCH' = 'POST') {
  const [phase, setPhase] = useState<MutationPhase>('idle');
  const [failure, setFailure] = useState<MutationFailure | null>(null);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const operationId = useRef<string>(crypto.randomUUID());
  const router = useRouter();

  const submit = useCallback(async (payload: Record<string, unknown>): Promise<MutationOutcome> => {
    setPhase('applying');
    setFailure(null);
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: operationId.current, ...payload }),
      });
      const body = await response.json().catch(() => ({}));

      if (response.ok) {
        /*
         * WHAT COUNTS AS THE RECORD.
         *
         * A workbook mutation answers `{ record: … }` — the sheet row as it stands after
         * read-after-write verification. The relational domains (finance, people, operations,
         * inventory) answer with the projected entity itself, because there is no sheet row
         * to echo back. Both are "what was written".
         *
         * Treating only the first as a record meant a successful assignment produced no
         * success toast and left its drawer open, which reads on screen as a write that
         * failed. It had not; nothing said so.
         */
        const written = body && typeof body === 'object' && !Array.isArray(body)
          ? ((body as { record?: Record<string, unknown> }).record ?? body) as Record<string, unknown>
          : null;
        setRecord(written);
        setPhase('verified');
        // The server verified the write; the pages re-read through the provider, whose
        // version key has moved. Nothing on this screen invents the new state.
        router.refresh();
        return { ok: true, ...(written ? { record: written } : {}) };
      }

      const error = body?.error ?? {};
      const failed: MutationFailure = {
        code: String(error.code ?? 'ERROR'),
        message: String(error.message ?? 'The request was not applied.'),
        details: Array.isArray(error.details) ? error.details.map(String) : undefined,
        operationId: operationId.current,
      };
      setFailure(failed);
      setPhase('failed');
      return { ok: false, failure: failed };
    } catch {
      const failed: MutationFailure = {
        code: 'NETWORK',
        message: 'The request did not reach the server. Nothing has been saved — submit again.',
        operationId: operationId.current,
      };
      setFailure(failed);
      setPhase('failed');
      return { ok: false, failure: failed };
    }
  }, [endpoint, method, router]);

  /** New INTENT: fresh operation id, clean slate. Called when a form reopens. */
  const reset = useCallback(() => {
    operationId.current = crypto.randomUUID();
    setPhase('idle');
    setFailure(null);
    setRecord(null);
  }, []);

  return { phase, failure, record, submit, reset, operationId };
}
