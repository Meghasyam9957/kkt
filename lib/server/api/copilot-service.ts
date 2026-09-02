import '@/lib/server/only';
import { requireTenant } from '@/lib/server/tenant/context';
import type { TenantProviderFactory } from './routes';
/**
 * COPILOT API — the HTTP surface for ARCHITECTURE §7's `POST /api/ai/copilot`.
 *
 * This file is deliberately almost empty. It validates a body, resolves the period the
 * question is about using the same helper every analytics read uses, and hands both to
 * `answerCopilotQuestion`. Everything that matters happened before or after it:
 *
 *   - the guard has already checked `ai.operations` and written the audit line;
 *   - the copilot service authorises the role against the tool whitelist, minimises the
 *     context, strips guest names, stamps the environment, applies §8.4's gates, checks
 *     the answer against the facts and records the usage.
 *
 * There is no calculation here, no forecasting, no PII filtering, no provider selection,
 * no pricing and no budget. Those all live where they are already tested, and a handler
 * that repeated any of them would be a second place for them to be wrong. The runtime —
 * provider, switches, budget, pricing, model, sink — is injected by the composition root
 * for the same reason the data provider is: it is configuration, and none of it is
 * decided in this phase.
 *
 * The route is declared `nonMutating` in the registry. A question allocates no id, writes
 * no sheet and has no entity; the security suite additionally asserts that this module
 * cannot import a repository, the Sheets client or the mutation pipeline, so the flag is
 * a checked claim rather than a promise.
 */
import { z } from 'zod';
import type { ApiRouter } from './router';
import { filtersFrom } from './analytics-service';
import { answerCopilotQuestion, type CopilotRuntime } from '@/lib/server/ai/copilot';
import type { DashboardDataProvider } from '@/lib/data/providers/types';

/**
 * The whole request body.
 *
 * `.strict()` follows the mutation schemas: an unexpected key is a caller who believes
 * this endpoint accepts something it does not, and answering anyway would confirm a
 * contract that does not exist. There is deliberately no length bound — §8.4's control
 * for input size is "context caps: max input tokens per feature", whose values are
 * unspecified, and inventing a character limit here would pre-empt that decision with a
 * different unit.
 */
export const CopilotAsk = z.object({
  question: z.string().trim().min(1, 'A question is required'),
}).strict();

/**
 * Bind the copilot read to the router.
 *
 * Both dependencies are functions, not instances, matching the analytics and forecast
 * handlers: the data provider resolves per request so a demonstration dataset switch is
 * reflected immediately, and the runtime resolves per request so a configuration change
 * does not need a restart to take effect.
 */
export function registerCopilotHandlers(
  router: ApiRouter,
  provider: TenantProviderFactory,
  runtime: () => CopilotRuntime,
): void {
  router.register('POST', '/api/ai/copilot', async (ctx) => {
    const parsed = CopilotAsk.safeParse(ctx.request.body ?? {});
    if (!parsed.success) {
      /*
       * The same 422 shape the mutation pipeline produces, and the same wording. The
       * `__mutationError` flag is the router's single channel for a handler to name a
       * status — its comment says so — and it is named for its first user rather than
       * for this one.
       */
      return {
        __mutationError: true,
        status: 422,
        code: 'VALIDATION',
        message: 'The request does not match the expected shape.',
        details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      };
    }

    // The AI context is assembled from THIS tenant's provider. A copilot answer can
    // therefore only ever describe the customer whose user asked the question.
    const data = await provider(requireTenant(ctx.auth, 'copilot'));
    // §7's filter conventions, resolved by the helper the analytics reads share: an
    // absent or unknown month falls back to the most recent one that carries data, and
    // the answer states which period it described.
    const filters = await filtersFrom(data, ctx.request);

    return answerCopilotQuestion(data, {
      // The role and the user id come from the verified session, never from the request.
      role: ctx.auth.role,
      userId: ctx.auth.userId,
      question: parsed.data.question,
      filters,
    }, runtime());
  });
}
