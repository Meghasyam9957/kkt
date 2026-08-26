'use client';
/**
 * COPILOT CONSOLE — the browser side of `POST /api/ai/copilot`. Transport and rendering only.
 *
 * Everything that decides anything happens on the server: which tools the asker's role
 * admits, which fields those tools project, whether guest names survive the boundary, what
 * period the answer describes, whether the budget permits the call, and whether the answer
 * states a figure the retrieved facts never contained. This file asks, waits, and renders
 * what came back.
 *
 * Three rules it follows that are easy to break in a chat interface:
 *
 *   **Nothing is optimistic.** There is no placeholder answer, no streamed guess and no
 *   "thinking…" text pretending to be a model. The thread shows the question, then a
 *   loading state, then whatever the server actually said.
 *
 *   **A stub is never dressed as an assistant.** `simulated` travels on the response, and
 *   when it is true the answer is labelled as coming from the local mock. A fixed string
 *   rendered as if a model reasoned its way to it is the most damaging thing this screen
 *   could do, because nobody looking at it could tell.
 *
 *   **System facts and model text are separate regions.** Period, source, freshness,
 *   which tools ran and which were withheld are the server's — they are true whether or
 *   not a model answered. The answer is the model's. They never share a container.
 *
 * No wording is invented for a refusal. §8.4 requires a clear message and the server
 * supplies one; this renders that message and the code beside it. Where a state has no
 * server message — an unreachable network, say — the text describes the transport, which
 * is this file's own business and not a product decision.
 */
import { useCallback, useId, useRef, useState } from 'react';
import {
  Badge, Button, ConfigurationRequired, ErrorState, LoadingBlock, StatusPill,
} from '@/components/ui/primitives';
import { SrivilluMark } from '@/components/shell/Logo';
import {
  copilotViewState, copilotShowsAnswer, copilotRefusalKind, copilotBudgetNotable,
  type CopilotViewState,
} from '@/lib/shared/ai-copilot-view';
import type { CopilotAnswer } from '@/lib/server/ai/copilot';

/**
 * What the server said, or why we never heard.
 *
 * `transport` is deliberately separate from a refusal: a request that did not arrive is a
 * different fact from one the server declined, and collapsing them would report a
 * deployment as misconfigured when the wifi dropped.
 */
type Turn =
  | { kind: 'answer'; question: string; answer: CopilotAnswer }
  | { kind: 'transport'; question: string; code: string; message: string };

export const EXAMPLE_PROMPTS = [
  'What needs attention today?',
  'Which property performed best this month?',
  'Why did revenue change compared with last month?',
  'What are our biggest expenses?',
  'Which channel brings the most profitable bookings?',
  'How many nights are already booked for next month?',
];

export function CopilotConsole() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  /*
   * The duplicate-submit guard, and the reason it is a ref rather than the `loading`
   * state: a second submit can arrive in the same tick as the first — Enter held down, a
   * double click, a form submitted while the button is being disabled — and state updates
   * are not synchronous. This closes before any of that can interleave.
   */
  const inFlight = useRef(false);
  const inputId = useId();

  const ask = useCallback(async (asked: string) => {
    const trimmed = asked.trim();
    if (trimmed === '' || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setTurn(null);

    try {
      const response = await fetch('/api/ai/copilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      const body = await response.json().catch(() => ({}));

      if (response.ok) {
        setTurn({ kind: 'answer', question: trimmed, answer: body as CopilotAnswer });
      } else {
        // The router's error envelope. Its message is the server's, not this file's.
        const error = (body as { error?: { code?: unknown; message?: unknown } })?.error ?? {};
        setTurn({
          kind: 'transport',
          question: trimmed,
          code: String(error.code ?? 'ERROR'),
          message: String(error.message ?? 'The request was refused.'),
        });
      }
    } catch {
      setTurn({
        kind: 'transport',
        question: trimmed,
        code: 'NETWORK',
        message: 'The request did not reach the server. Nothing was asked — try again.',
      });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  const state: CopilotViewState = loading
    ? 'loading'
    : turn === null ? 'idle'
      : turn.kind === 'transport' ? 'failed'
        : copilotViewState(turn.answer);

  return (
    <>
      <div
        className="sv-copilot__thread"
        data-state={state}
        aria-busy={loading}
      >
        {turn === null && !loading ? <Opening /> : null}

        {turn !== null ? (
          <p className="sv-copilot__asked">
            <span className="sv-visually-hidden">You asked: </span>
            {turn.question}
          </p>
        ) : null}

        {/*
          * One live region for every outcome. Announcing the result rather than the
          * request means a screen-reader user hears the answer, the refusal or the
          * failure exactly once, whichever arrives.
          */}
        <div className="sv-copilot__result" role="status" aria-live="polite">
          {loading ? <LoadingBlock rows={3} label="Asking the copilot" /> : null}
          {!loading && turn?.kind === 'transport' ? (
            <ErrorState message={`${turn.message} (${turn.code})`} />
          ) : null}
          {!loading && turn?.kind === 'answer' ? (
            <Outcome state={state} answer={turn.answer} />
          ) : null}
        </div>
      </div>

      <form
        className="sv-copilot__composer"
        onSubmit={(event) => { event.preventDefault(); void ask(question); }}
      >
        <label className="sv-visually-hidden" htmlFor={inputId}>
          Ask the copilot a question about the business
        </label>
        <input
          id={inputId}
          className="sv-copilot__input"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about the business"
          disabled={loading}
          autoComplete="off"
        />
        <Button type="submit" variant="primary" disabled={loading || question.trim() === ''}>
          {loading ? 'Asking…' : 'Send'}
        </Button>
      </form>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The empty state
 * ------------------------------------------------------------------ */

function Opening() {
  return (
    <>
      <SrivilluMark size={44} />
      <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 600 }}>
        Ask about the business
      </p>
      <p className="sv-muted" style={{ fontSize: '0.875rem', maxWidth: '48ch' }}>
        Every answer cites the period and the source it came from, and any figure it states
        has come from a retrieved record rather than the model.
      </p>
      <div className="sv-copilot__prompts">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <div key={prompt} className="sv-copilot__prompt">{prompt}</div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * One server response, rendered
 * ------------------------------------------------------------------ */

function Outcome({ state, answer }: { state: CopilotViewState; answer: CopilotAnswer }) {
  const showsAnswer = copilotShowsAnswer(state);

  return (
    <div className="sv-copilot__outcome">
      {/*
        * The model's text, and only when the server produced some. `unavailable` and
        * `refused` never reach here with text, and nothing substitutes for it.
        */}
      {showsAnswer && answer.answer !== null ? (
        <div className="sv-copilot__answer">
          {answer.simulated ? (
            <Badge tone="warn">Simulated — local mock, not a language model</Badge>
          ) : null}
          <p className="sv-copilot__answer-text">{answer.answer}</p>
          {answer.ungrounded.length > 0 ? (
            <p className="sv-copilot__flags" role="note">
              <strong>Unverified figures:</strong>{' '}
              {answer.ungrounded.join(', ')}
              {' — '}
              not present in the retrieved facts.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Refusals: the server's own code and message, in the system region. */}
      {(state === 'unavailable' || state === 'refused')
        ? <Refusal answer={answer} /> : null}

      {state === 'failed' ? (
        <ErrorState message={`${answer.message ?? 'The provider did not answer.'} (${answer.outcome})`} />
      ) : null}

      <Provenance answer={answer} />
    </div>
  );
}

function Refusal({ answer }: { answer: CopilotAnswer }) {
  const kind = copilotRefusalKind(answer.reason);
  const message = answer.message ?? '';

  if (kind === 'configuration') {
    return <ConfigurationRequired message={message} />;
  }
  return (
    <div className="sv-copilot__refusal" role="note">
      <StatusPill tone={kind === 'budget' ? 'warn' : 'neutral'}>
        {answer.reason ?? 'REFUSED'}
      </StatusPill>
      <p className="sv-copilot__refusal-text">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * §8.1's provenance — true whether or not a model answered
 * ------------------------------------------------------------------ */

function Provenance({ answer }: { answer: CopilotAnswer }) {
  return (
    <dl className="sv-copilot__facts">
      <div><dt>Period</dt><dd>{answer.period || '—'}</dd></div>
      <div><dt>Source</dt><dd>{answer.source}</dd></div>
      <div><dt>Read at</dt><dd>{answer.asOf}</dd></div>
      <div>
        <dt>Retrieved</dt>
        <dd>{answer.tools.length > 0 ? answer.tools.join(', ') : 'nothing'}</dd>
      </div>
      {answer.omitted.length > 0 ? (
        <div>
          {/*
            * §8.2 rule 3's other half: what was NOT retrieved, and why. A capability the
            * asker does not hold is a fact about the answer's completeness, so it is shown
            * rather than quietly narrowing the reply.
            */}
          <dt>Withheld</dt>
          <dd>{answer.omitted.map((o) => `${o.tool} (needs ${o.capability})`).join(', ')}</dd>
        </div>
      ) : null}
      {copilotBudgetNotable(answer.budgetState) ? (
        <div>
          <dt>Budget</dt>
          <dd>
            <StatusPill tone={answer.budgetState === 'BREACHED' ? 'bad' : 'warn'}>
              {answer.budgetState}
            </StatusPill>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
