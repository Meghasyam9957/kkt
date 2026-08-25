/**
 * AI GUARDRAILS — ARCHITECTURE §8.2 and §8.4.
 *
 * The isolation suite proves the copilot cannot be told the wrong things. This one proves
 * the rules around the telling: that a feature cannot run without a budget, that a breach
 * stops it, and that a figure the tools never produced is caught after the fact.
 *
 * Every value the architecture leaves to a person — the cap, the model, the token limits —
 * is supplied by these tests rather than read from the module, because the module supplies
 * none of them. That is the property under test as much as any assertion below.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  AI_FEATURES, ALL_FEATURES_OFF, BUDGET_WARNING_RATIO,
  budgetState, aiFeatureStatus, assertAiFeatureEnabled, AiFeatureDisabledError,
  numericTokens, findUngroundedFigures,
  type AiFeatureContext, type AiUsageRecord,
} from '@/lib/server/ai/guardrails';
import { aiEnabled } from '@/lib/server/ai/guard';
import { buildCopilotContext } from '@/lib/server/ai/copilot-context';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';

const FIXED_NOW = new Date('2027-01-19T06:00:00.000Z');

/** A running deployment, so the rules under the integration gate can be exercised. */
const running = (
  overrides: Partial<AiFeatureContext> = {},
): AiFeatureContext => ({
  integrationEnabled: true,
  switches: { ...ALL_FEATURES_OFF, copilot: true },
  budget: { cap: 25, spent: 0 },
  ...overrides,
});

/* ================================================================== *
 * §8.4 · kill switches
 * ================================================================== */

describe('AI guardrails · per-feature kill switches (§8.4)', () => {
  it('the features are the four §8.4 names', () => {
    expect([...AI_FEATURES]).toEqual(['copilot', 'guest', 'reviews', 'summaries']);
  });

  it('nothing is on by default, and the default cannot be edited', () => {
    for (const feature of AI_FEATURES) expect(ALL_FEATURES_OFF[feature]).toBe(false);
    expect(Object.isFrozen(ALL_FEATURES_OFF)).toBe(true);
  });

  it('every feature is off in this phase, whatever the switches say', () => {
    expect(aiEnabled()).toBe(false);
    for (const feature of AI_FEATURES) {
      const status = aiFeatureStatus(feature, {
        // Deliberately the most permissive input possible: every switch on, budget clear.
        switches: { copilot: true, guest: true, reviews: true, summaries: true },
        budget: { cap: 25, spent: 0 },
      });
      expect(status.enabled, feature).toBe(false);
      expect(status.reason).toBe('INTEGRATION_DISABLED');
      expect(status.message).toMatch(/no key is read/i);
    }
  });

  it('a feature switched off is refused even in a running deployment', () => {
    const status = aiFeatureStatus('guest', running());
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('FEATURE_SWITCHED_OFF');
  });

  it('a feature switched on with a configured budget may run', () => {
    const status = aiFeatureStatus('copilot', running());
    expect(status.enabled).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.warning).toBe(false);
  });

  it('assertAiFeatureEnabled throws with the reason attached, rather than returning empty', () => {
    // A disabled feature that answers with nothing is indistinguishable from a broken one.
    try {
      assertAiFeatureEnabled('reviews', running());
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AiFeatureDisabledError);
      expect((error as AiFeatureDisabledError).reason).toBe('FEATURE_SWITCHED_OFF');
    }
    expect(() => assertAiFeatureEnabled('copilot', running())).not.toThrow();
  });
});

/* ================================================================== *
 * §8.4 · the budget cap
 * ================================================================== */

describe('AI guardrails · the monthly budget cap (§8.4)', () => {
  it('an unset cap is UNCONFIGURED, never treated as unlimited', () => {
    // §13's sixth question is unanswered and marked "Blocks Phase 9". Reading a missing
    // cap as "no limit" is precisely the silent overspend §8.4 forbids.
    expect(budgetState({ cap: null, spent: 0 })).toBe('UNCONFIGURED');
    expect(budgetState({ cap: null, spent: 1_000_000 })).toBe('UNCONFIGURED');
  });

  it('the soft warning is §8.4s 70%, and it warns rather than blocks', () => {
    expect(BUDGET_WARNING_RATIO).toBe(0.7);
    expect(budgetState({ cap: 100, spent: 69.99 })).toBe('OK');
    expect(budgetState({ cap: 100, spent: 70 })).toBe('WARNING');
    expect(budgetState({ cap: 100, spent: 99.99 })).toBe('WARNING');

    const warned = aiFeatureStatus('copilot', running({ budget: { cap: 100, spent: 85 } }));
    expect(warned.enabled).toBe(true);
    expect(warned.warning).toBe(true);
  });

  it('reaching the cap breaches it — the boundary is inclusive', () => {
    expect(budgetState({ cap: 100, spent: 100 })).toBe('BREACHED');
    expect(budgetState({ cap: 100, spent: 100.01 })).toBe('BREACHED');
  });

  it('a breach disables the feature however the switch is set', () => {
    const status = aiFeatureStatus('copilot', running({ budget: { cap: 25, spent: 25 } }));
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('BUDGET_EXCEEDED');
    expect(status.message).toMatch(/rather than continuing to spend/i);
  });

  it('a missing cap blocks a switched-on feature, and says so', () => {
    const status = aiFeatureStatus('copilot', running({ budget: { cap: null, spent: 0 } }));
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('BUDGET_UNCONFIGURED');
    expect(status.message).toMatch(/until a cap is set/i);
  });

  it('the blocking order is integration, then budget, then switch', () => {
    // Each rule is checked with the ones above it satisfied and the ones below it
    // violated, so the precedence is asserted rather than implied by a single case.
    // The copilot switch is off throughout, so each earlier rule is shown outranking it.
    const reason = (integrationEnabled: boolean, budget: { cap: number | null; spent: number }) =>
      aiFeatureStatus('copilot', { integrationEnabled, switches: ALL_FEATURES_OFF, budget }).reason;
    expect(reason(false, { cap: null, spent: 0 })).toBe('INTEGRATION_DISABLED');
    expect(reason(true, { cap: null, spent: 0 })).toBe('BUDGET_UNCONFIGURED');
    expect(reason(true, { cap: 10, spent: 10 })).toBe('BUDGET_EXCEEDED');
    expect(reason(true, { cap: 10, spent: 0 })).toBe('FEATURE_SWITCHED_OFF');
  });

  it('the module supplies no cap of its own', () => {
    // §10.2 recommends $25. A recommendation is not an answer, and a default here would
    // quietly turn one into the other.
    const source = fs.readFileSync('lib/server/ai/guardrails.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(source).not.toMatch(/cap\s*[:=]\s*\d/);
  });
});

/* ================================================================== *
 * §8.2 rule 1 · numbers may only come from tool results
 * ================================================================== */

describe('AI guardrails · numeric tokens (§8.2 rule 1)', () => {
  it('reads a figure through its formatting', () => {
    expect(numericTokens('₹1,84,300')).toEqual(['184300']);
    expect(numericTokens('$1,234.50 and 12')).toEqual(['1234.5', '12']);
  });

  it('keeps leading zeros, so a month key cannot ground a count', () => {
    // '2027-03' must not make a claim about '3' nights look sourced.
    expect(numericTokens('2027-03')).toEqual(['2027', '03']);
  });

  it('drops trailing zeros after a decimal point only', () => {
    expect(numericTokens('95.00 and 100 and 0.70')).toEqual(['95', '100', '0.7']);
  });

  it('finds nothing in text that has no figures', () => {
    expect(numericTokens('occupancy improved this month')).toEqual([]);
  });
});

describe('AI guardrails · ungrounded figures (§8.2 rule 1)', () => {
  const payload = { netRevenue: 184300, monthKey: '2027-03', unit: 'HYD-501' };

  it('a figure present in the tool payload is grounded, however it is written', () => {
    expect(findUngroundedFigures('Net revenue was ₹1,84,300.', payload)).toEqual([]);
  });

  it('a figure the tools never produced is flagged', () => {
    expect(findUngroundedFigures('Net revenue was ₹1,90,000.', payload)).toEqual(['190000']);
  });

  it('identifiers and periods in the payload ground the figures inside them', () => {
    expect(findUngroundedFigures('For 2027-03 at HYD-501.', payload)).toEqual([]);
  });

  it('a rounded or re-expressed figure is flagged too, because it is not in the payload', () => {
    // Reported, not judged. What a caller does with a flag is Phase 9's decision; §8.2
    // requires only that the figure be surfaced.
    expect(findUngroundedFigures('About ₹1.8 lakh.', payload)).toEqual(['1.8']);
    expect(findUngroundedFigures('Occupancy was 79%.', { occupancyPct: 0.7946 }))
      .toEqual(['79']);
  });

  it('each unsourced figure is reported once, however often it is repeated', () => {
    expect(findUngroundedFigures('₹5,000 then ₹5,000 again.', payload)).toEqual(['5000']);
  });

  it('an answer with no figures at all passes', () => {
    expect(findUngroundedFigures('There is insufficient data for that month.', payload))
      .toEqual([]);
  });

  it('holds against a real copilot context', async () => {
    // The strongest form of the rule: the payload is the one the boundary actually builds,
    // and the truthful answer quotes a figure taken out of it.
    const provider = new FixtureDashboardDataProvider({ now: () => FIXED_NOW });
    const months = await provider.getAvailableMonths();
    const context = (await buildCopilotContext(
      provider,
      { month: months[months.length - 1] ?? '', propertyId: null, platform: null },
      { role: 'ADMIN', now: FIXED_NOW },
    )).contents;

    const occupied = context.propertyPerformance![0]!.occupiedNights;
    expect(findUngroundedFigures(`That unit sold ${occupied} nights.`, context)).toEqual([]);
    expect(findUngroundedFigures('That unit sold 9999 nights.', context)).toEqual(['9999']);
  });
});

/* ================================================================== *
 * §8.4 · what every call must record
 * ================================================================== */

describe('AI guardrails · the usage record (§8.4)', () => {
  it('carries every field §8.4 lists, and nothing is optional', () => {
    const record: AiUsageRecord = {
      feature: 'copilot',
      model: 'model-id-from-config',
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      currency: 'USD',
      latencyMs: 0,
      userId: 'user-uuid',
      outcome: 'OK',
    };
    expect(Object.keys(record).sort()).toEqual([
      'completionTokens', 'cost', 'currency', 'feature', 'latencyMs', 'model',
      'outcome', 'promptTokens', 'userId',
    ]);
  });

  it('no pricing table exists in the AI layer', () => {
    // "Computed cost" needs per-token pricing, which §10.2 lists as an assumption to
    // confirm at build time. A rate hard-coded here would be a costing decision made by
    // a source file.
    const text = fs.readFileSync('lib/server/ai/guardrails.ts', 'utf8');
    expect(text).not.toMatch(/per(Token|_token)|pricePer|USD_PER|TOKEN_PRICE/i);
  });
});
