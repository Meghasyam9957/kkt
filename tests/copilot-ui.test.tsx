/**
 * COPILOT CONSOLE — the browser side, exercised against a stubbed transport.
 *
 * `fetch` is the only seam. Everything below drives the real component and asserts what a
 * person would actually see, so a test passes because the screen is right rather than
 * because a helper returned the expected object.
 *
 * The properties that matter most here are the ones a chat interface gets wrong quietly:
 * a stub's reply presented as an assistant's answer, a refusal rendered as an empty
 * conversation, a double-click billing twice, and model text mixed into the region that
 * states where the figures came from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';

import { CopilotConsole, EXAMPLE_PROMPTS } from '@/components/copilot/CopilotConsole';
import { capabilitiesFor, type Role } from '@/lib/server/auth/roles';
import { canLoadRoute } from '@/lib/server/auth/guard';
import { MOCK_REPLY } from '@/lib/server/ai/mock-provider';
import type { CopilotAnswer } from '@/lib/server/ai/copilot';

const ROOT = process.cwd();
const readSource = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/* ------------------------------------------------------------------ *
 * A server response, shaped exactly as the route returns one
 * ------------------------------------------------------------------ */

const answerFixture = (over: Partial<CopilotAnswer> = {}): CopilotAnswer => ({
  outcome: 'OK',
  reason: null,
  answer: MOCK_REPLY,
  period: '2027-02',
  source: 'FIXTURE',
  asOf: '2027-02-19T06:00:00.000Z',
  tools: ['getAlerts', 'getKpis'],
  omitted: [],
  ungrounded: [],
  message: null,
  budgetState: 'OK',
  simulated: true,
  usage: {
    feature: 'copilot', model: 'mock-copilot', promptTokens: 120, completionTokens: 30,
    cost: 0, currency: 'USD', latencyMs: 4, userId: 'user-1', outcome: 'OK',
  },
  ...over,
});

/** Stub the transport. Returns the recorded calls and a resolver for pending requests. */
function stubFetch(reply: () => { ok: boolean; body: unknown } | Promise<{ ok: boolean; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const { ok, body } = await reply();
    return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal('fetch', impl);
  return { calls };
}

const ask = async (question = 'What needs attention today?') => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/ask the copilot/i), question);
  await user.click(screen.getByRole('button', { name: /send/i }));
  return user;
};

beforeEach(() => { cleanup(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/* ================================================================== *
 * Rendering and submitting
 * ================================================================== */

describe('copilot console · the idle screen', () => {
  it('renders the composer and the example prompts', () => {
    render(<CopilotConsole />);
    expect(screen.getByLabelText(/ask the copilot/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /send/i })).toBeTruthy();
    for (const prompt of EXAMPLE_PROMPTS) {
      expect(screen.getByText(prompt)).toBeTruthy();
    }
  });

  it('cannot submit an empty question', () => {
    render(<CopilotConsole />);
    expect(screen.getByRole('button', { name: /send/i }).hasAttribute('disabled')).toBe(true);
  });

  it('sends one server-mediated POST, and never reaches a model directly', async () => {
    const { calls } = stubFetch(() => ({ ok: true, body: answerFixture() }));
    render(<CopilotConsole />);
    await ask('Which property performed best?');

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toBe('/api/ai/copilot');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ question: 'Which property performed best?' });
    // The only host this component may name is its own origin.
    expect(calls[0]!.url).not.toMatch(/^https?:/);
  });

  it('trims the question before sending it', async () => {
    const { calls } = stubFetch(() => ({ ok: true, body: answerFixture() }));
    render(<CopilotConsole />);
    await ask('   spaced out   ');
    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String(calls[0]!.init.body)).question).toBe('spaced out');
  });
});

/* ================================================================== *
 * Loading, and not billing twice for one intent
 * ================================================================== */

describe('copilot console · while a question is in flight', () => {
  it('shows a loading state and disables the composer', async () => {
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    stubFetch(async () => { await pending; return { ok: true, body: answerFixture() }; });

    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText('Asking the copilot')).toBeTruthy());
    expect(screen.getByRole('button', { name: /asking/i }).hasAttribute('disabled')).toBe(true);
    expect((screen.getByLabelText(/ask the copilot/i) as HTMLInputElement).disabled).toBe(true);
    // No optimistic answer: nothing claims a result before the server returns one.
    expect(screen.queryByText(MOCK_REPLY)).toBeNull();

    release!();
    await waitFor(() => expect(screen.getByText(MOCK_REPLY)).toBeTruthy());
  });

  it('two submits in the SAME tick produce one request', async () => {
    /*
     * The case the disabled attribute cannot cover. Disabling the button is an
     * affordance; it takes effect on the next render, and two submits dispatched before
     * that render both see `loading === false`. Only the ref — mutated synchronously
     * before the first await — closes that window.
     *
     * Written this way after the first version of this test turned out to prove nothing:
     * it drove the disabled input, so removing the guard entirely still passed.
     */
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { calls } = stubFetch(async () => { await pending; return { ok: true, body: answerFixture() }; });

    const { container } = render(<CopilotConsole />);
    const input = screen.getByLabelText(/ask the copilot/i);
    fireEvent.change(input, { target: { value: 'double asked' } });

    const form = container.querySelector('form')!;
    const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => { submit(); submit(); });

    release!();
    await waitFor(() => expect(screen.getByText(MOCK_REPLY)).toBeTruthy());
    // One question asked, one request made — a duplicate would be a second charge.
    expect(calls.length).toBe(1);
  });

  it('the disabled composer is the affordance, not the guard', async () => {
    // Both matter, and they are asserted separately so neither can stand in for the
    // other: this one is about what a person can see and click.
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    stubFetch(async () => { await pending; return { ok: true, body: answerFixture() }; });

    render(<CopilotConsole />);
    await ask();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /asking/i }).hasAttribute('disabled')).toBe(true);
    });
    release!();
    await waitFor(() => expect(screen.getByText(MOCK_REPLY)).toBeTruthy());
  });
});

/* ================================================================== *
 * A stub is never dressed as an assistant
 * ================================================================== */

describe('copilot console · an answer', () => {
  it('renders the server text and labels a simulated provider', async () => {
    stubFetch(() => ({ ok: true, body: answerFixture() }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText(MOCK_REPLY)).toBeTruthy());
    // The property that stops a demo from misleading: a mock says it is a mock.
    expect(screen.getByText(/simulated/i)).toBeTruthy();
  });

  it('does not claim a simulation when the provider is real', async () => {
    stubFetch(() => ({ ok: true, body: answerFixture({ simulated: false, answer: 'Occupancy held steady.' }) }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText('Occupancy held steady.')).toBeTruthy());
    expect(screen.queryByText(/simulated/i)).toBeNull();
  });

  it('preserves provenance beside every answer', async () => {
    stubFetch(() => ({ ok: true, body: answerFixture() }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText('2027-02')).toBeTruthy());
    expect(screen.getByText('FIXTURE')).toBeTruthy();
    expect(screen.getByText('2027-02-19T06:00:00.000Z')).toBeTruthy();
    expect(screen.getByText(/getAlerts/)).toBeTruthy();
  });

  it('keeps model text out of the provenance region, and provenance out of the answer', async () => {
    // Requirement 8: system/data facts and AI explanation are different claims and must
    // not share a container. Asserted structurally — the answer element must not contain
    // the facts list, and the facts list must not contain the model's sentence.
    stubFetch(() => ({ ok: true, body: answerFixture() }));
    const { container } = render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText(MOCK_REPLY)).toBeTruthy());
    const answerBox = container.querySelector('.sv-copilot__answer')!;
    const facts = container.querySelector('.sv-copilot__facts')!;
    expect(answerBox.textContent).toContain(MOCK_REPLY);
    expect(answerBox.querySelector('.sv-copilot__facts')).toBeNull();
    expect(facts.textContent).not.toContain(MOCK_REPLY);
    expect(facts.textContent).toContain('FIXTURE');
  });

  it('flags figures the retrieved facts never contained (§8.2 rule 1)', async () => {
    stubFetch(() => ({
      ok: true,
      body: answerFixture({ outcome: 'FLAGGED', answer: 'Revenue was 999999.', ungrounded: ['999999'] }),
    }));
    const { container } = render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText(/unverified figures/i)).toBeTruthy());
    // The figure appears twice on purpose — once in the model's sentence, once in the
    // flag — so this asserts the flag specifically rather than either occurrence.
    expect(container.querySelector('.sv-copilot__flags')!.textContent).toContain('999999');
  });

  it('shows what a role was not entitled to retrieve', async () => {
    // OPERATIONS reaches exactly getAlerts; the rest are withheld, and the screen says so
    // rather than silently answering a narrower question.
    stubFetch(() => ({
      ok: true,
      body: answerFixture({
        tools: ['getAlerts'],
        omitted: [{ tool: 'getKpis', capability: 'analytics.read', message: 'Not permitted.' }],
      }),
    }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText(/Withheld/i)).toBeTruthy());
    expect(screen.getByText(/getKpis \(needs analytics\.read\)/)).toBeTruthy();
  });
});

/* ================================================================== *
 * Refusals, in the server's own words
 * ================================================================== */

describe('copilot console · refusals use the server’s codes and messages', () => {
  it('renders a configuration-required state when the deployment has no AI', async () => {
    const message = 'AI is not enabled in this deployment.';
    stubFetch(() => ({
      ok: true,
      body: answerFixture({
        outcome: 'REFUSED', reason: 'INTEGRATION_DISABLED', answer: null, message,
      }),
    }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText('Configuration required')).toBeTruthy());
    expect(screen.getByText(message)).toBeTruthy();
    // A refusal is never an answer, and nothing stands in for one.
    expect(document.querySelector('.sv-copilot__answer')).toBeNull();
  });

  it('renders a spent budget with its code, not an invented sentence', async () => {
    const message = 'The monthly AI budget is exhausted.';
    stubFetch(() => ({
      ok: true,
      body: answerFixture({
        outcome: 'REFUSED', reason: 'BUDGET_EXCEEDED', answer: null,
        message, budgetState: 'BREACHED',
      }),
    }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText('BUDGET_EXCEEDED')).toBeTruthy());
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByText('BREACHED')).toBeTruthy();
  });

  it('surfaces the §8.4 soft warning alongside an answer that still ran', async () => {
    stubFetch(() => ({ ok: true, body: answerFixture({ budgetState: 'WARNING' }) }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText('WARNING')).toBeTruthy());
    expect(screen.getByText(MOCK_REPLY)).toBeTruthy();
  });

  it('says nothing about the budget when it is simply fine', async () => {
    stubFetch(() => ({ ok: true, body: answerFixture({ budgetState: 'OK' }) }));
    render(<CopilotConsole />);
    await ask();
    await waitFor(() => expect(screen.getByText(MOCK_REPLY)).toBeTruthy());
    expect(screen.queryByText('Budget')).toBeNull();
  });

  it('reports a switched-off feature distinctly from an unconfigured deployment', async () => {
    stubFetch(() => ({
      ok: true,
      body: answerFixture({
        outcome: 'REFUSED', reason: 'FEATURE_SWITCHED_OFF', answer: null,
        message: 'This AI feature is switched off.',
      }),
    }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText('FEATURE_SWITCHED_OFF')).toBeTruthy());
    expect(screen.queryByText('Configuration required')).toBeNull();
  });

  it('reports a provider failure as a failure, not as an answer', async () => {
    stubFetch(() => ({
      ok: true,
      body: answerFixture({
        outcome: 'TIMEOUT', answer: null, message: 'The AI provider did not return an answer.',
      }),
    }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/TIMEOUT/)).toBeTruthy();
    expect(document.querySelector('.sv-copilot__answer')).toBeNull();
  });

  it('separates a request that never arrived from one the server declined', async () => {
    stubFetch(() => { throw new Error('offline'); });
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText(/NETWORK/)).toBeTruthy());
    // No provenance is claimed for a request that was never answered.
    expect(document.querySelector('.sv-copilot__facts')).toBeNull();
  });

  it('renders the router’s error envelope for a rejected request', async () => {
    stubFetch(() => ({
      ok: false,
      body: { error: { code: 'VALIDATION', message: 'The request does not match the expected shape.' } },
    }));
    render(<CopilotConsole />);
    await ask();

    await waitFor(() => expect(screen.getByText(/VALIDATION/)).toBeTruthy());
    expect(screen.getByText(/does not match the expected shape/)).toBeTruthy();
  });
});

/* ================================================================== *
 * Accessibility
 * ================================================================== */

describe('copilot console · keyboard and screen reader', () => {
  it('labels the input and submits from the keyboard alone', async () => {
    const { calls } = stubFetch(() => ({ ok: true, body: answerFixture() }));
    render(<CopilotConsole />);

    const user = userEvent.setup();
    const input = screen.getByLabelText(/ask the copilot/i);
    await user.click(input);
    await user.keyboard('occupancy this month{Enter}');

    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String(calls[0]!.init.body)).question).toBe('occupancy this month');
  });

  it('announces the outcome through one polite live region', async () => {
    stubFetch(() => ({ ok: true, body: answerFixture() }));
    const { container } = render(<CopilotConsole />);
    const live = container.querySelectorAll('[aria-live="polite"]');
    expect(live.length).toBe(1);
    expect(live[0]!.getAttribute('role')).toBe('status');

    await ask();
    await waitFor(() => expect(live[0]!.textContent).toContain(MOCK_REPLY));
  });

  it('marks the thread busy only while a request is open', async () => {
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    stubFetch(async () => { await pending; return { ok: true, body: answerFixture() }; });

    const { container } = render(<CopilotConsole />);
    const thread = () => container.querySelector('.sv-copilot__thread')!;
    expect(thread().getAttribute('aria-busy')).toBe('false');

    await ask();
    await waitFor(() => expect(thread().getAttribute('aria-busy')).toBe('true'));
    release!();
    await waitFor(() => expect(thread().getAttribute('aria-busy')).toBe('false'));
  });

  it('names the asked question for a screen reader', async () => {
    stubFetch(() => ({ ok: true, body: answerFixture() }));
    render(<CopilotConsole />);
    await ask('what changed this month');
    await waitFor(() => expect(screen.getByText(/You asked:/)).toBeTruthy());
  });
});

/* ================================================================== *
 * Layout — asserted against the stylesheet, since jsdom does not lay out
 * ================================================================== */

describe('copilot console · responsive and overflow-safe', () => {
  const css = () => readSource('styles/app.css');

  it('collapses to one column below the sidebar breakpoint', () => {
    expect(css()).toMatch(/@media \(max-width: 1100px\)[\s\S]{0,200}\.sv-copilot \{ grid-template-columns: 1fr; \}/);
  });

  it('lets a long question wrap instead of scrolling the page sideways', () => {
    // The three places an unbroken string could widen the layout: the echoed question,
    // the answer, and the provenance values.
    for (const selector of [
      '.sv-copilot__asked', '.sv-copilot__answer-text', '.sv-copilot__facts dd',
    ]) {
      const block = css().split(selector)[1] ?? '';
      expect(block.slice(0, 400), selector).toContain('overflow-wrap: anywhere');
    }
  });

  it('keeps the composer input from forcing the row wider than its container', () => {
    // A flex item defaults to min-width:auto, which is the usual cause of a composer
    // that scrolls a narrow screen horizontally.
    const block = css().split('.sv-copilot__input {')[1] ?? '';
    expect(block.slice(0, 300)).toContain('min-width: 0');
  });
});

/* ================================================================== *
 * Authorization and secrets
 * ================================================================== */

describe('copilot console · who may reach it, and what it may hold', () => {
  it('only roles holding ai.copilot can load the page', () => {
    const allowed: Role[] = ['SUPER_ADMIN', 'ADMIN'];
    for (const role of ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'INVESTOR'] as Role[]) {
      const holds = capabilitiesFor(role).includes('ai.copilot');
      expect(holds, role).toBe(allowed.includes(role));
      expect(canLoadRoute(role, '/admin/ai'), role).toBe(allowed.includes(role));
    }
  });

  it('INVESTOR holds neither copilot capability', () => {
    const caps = capabilitiesFor('INVESTOR');
    expect(caps).toEqual(['investor.self.read']);
    expect(caps).not.toContain('ai.copilot');
    expect(caps).not.toContain('ai.operations');
  });

  it('names no credential, model or provider anywhere in the client tree', () => {
    for (const file of ['components/copilot/CopilotConsole.tsx', 'app/admin/ai/page.tsx']) {
      const source = readSource(file);
      expect(source, file).not.toMatch(/OPENAI|sk-[A-Za-z0-9_-]{8,}|apiKey/i);
      // No host but our own origin may be named — the browser has no path to a provider.
      expect(source, file).not.toMatch(/https?:\/\/(?!localhost)/);
    }
  });

  it('imports nothing from lib/server except types', () => {
    const source = readSource('components/copilot/CopilotConsole.tsx');
    for (const line of source.split('\n').filter((l) => l.includes('@/lib/server'))) {
      expect(line.trim(), line).toMatch(/^import type /);
    }
  });

  it('never renders the §8.4 usage row', () => {
    // Model id, token counts, computed cost and latency are operator reporting. They
    // arrive on the response and must not reach the screen.
    const source = readSource('components/copilot/CopilotConsole.tsx');
    expect(source).not.toMatch(/answer\.usage/);
  });
});
