import '@/lib/server/only';
/**
 * MOCK AI PROVIDER — a local backend that answers without a model.
 *
 * It exists so the whole path around a model can be built and tested before there is one:
 * the guardrails, the cost accounting, the usage log, the failure handling and §8.2's
 * post-response check all need something on the other end of `AiProvider` to be exercised
 * at all. This is that something, and nothing more.
 *
 * Two properties make it a test double rather than a pretend assistant.
 *
 * **It never invents a figure.** The default reply contains no digits at all, so it cannot
 * pass §8.2's first rule by luck. A test that wants an ungrounded figure has to ask for
 * one explicitly, which is exactly the shape a rule test should have.
 *
 * **It is deterministic.** The same request produces the same text, the same token counts
 * and the same finish reason, every time. Nothing here reads a clock, a random number, a
 * credential or a socket — the isolation suite asserts the last two for the whole layer.
 */
import {
  AiProviderError, estimateTokens,
  type AiCompletionRequest, type AiCompletionResult, type AiProvider, type AiProviderFailure,
} from '@/lib/server/ai/provider';

/**
 * What a mock says when nobody has told it what to say.
 *
 * Deliberately free of digits, and deliberately unmistakable for an answer: a stub that
 * reads like a real assistant is a stub somebody eventually ships.
 */
export const MOCK_REPLY =
  'No language model is connected in this deployment. The question was received and the '
  + 'retrieved facts were assembled, but a mock provider cannot answer it.';

export interface MockAiProviderOptions {
  /** Override the reply. Pure, and given the whole request so a test can echo from it. */
  reply?: (request: AiCompletionRequest) => string;
  /** Fail every call this way instead of answering. */
  fail?: AiProviderFailure;
  finishReason?: string;
}

export class MockAiProvider implements AiProvider {
  readonly id = 'mock';
  /** Local. It costs nothing, which is why its pricing is zero rather than unknown. */
  readonly external = false;

  /** Every request it has been given, in order — the assertion surface for a test. */
  readonly calls: AiCompletionRequest[] = [];

  constructor(private readonly options: MockAiProviderOptions = {}) {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.calls.push(request);
    if (this.options.fail) throw new AiProviderError(this.options.fail);

    const text = this.options.reply ? this.options.reply(request) : MOCK_REPLY;
    /*
     * Estimated, and labelled as such at the definition. A mock has no tokeniser, and the
     * counts still have to be plausible enough that the cost arithmetic and the budget
     * accumulation above it can be tested against something that moves with input size.
     */
    const promptTokens = estimateTokens(
      request.system + request.question + JSON.stringify(request.payload.contents),
    );
    return {
      text,
      usage: { promptTokens, completionTokens: estimateTokens(text) },
      model: request.model,
      finishReason: this.options.finishReason ?? 'stop',
    };
  }
}
