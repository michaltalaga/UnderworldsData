import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MODEL,
  ProviderFailure,
  emptyUsage,
  toContentParts,
  type AiProvider,
  type Availability,
  type ChatMessage,
  type CompletionRequest,
} from './types';

/** USD per million tokens (input, output), for the cost total. Cache reads cost a twentieth of input. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
};

/** Tokens added to every request's max_tokens for the model's thinking. */
const THINKING_HEADROOM = 16_000;

/** Provider 1: the Anthropic Messages API, authenticated with ANTHROPIC_API_KEY. */
export class AnthropicApiProvider implements AiProvider {
  readonly id = 'api' as const;
  readonly label = 'Anthropic API (ANTHROPIC_API_KEY)';
  readonly usage = emptyUsage();
  private client: Anthropic | null = null;

  async checkAvailability(): Promise<Availability> {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, reason: 'ANTHROPIC_API_KEY is not set' };
    }
    try {
      // Listing models costs no tokens and fails fast on a bad key.
      await this.getClient().models.list({ limit: 1 });
      return { ok: true, detail: 'API key accepted' };
    } catch (err) {
      return { ok: false, reason: describeApiError(err) };
    }
  }

  async complete(request: CompletionRequest): Promise<string> {
    try {
      // Current models always think before they answer, and the thinking counts toward
      // max_tokens, so the reply gets that much room on top of its own limit. Streaming keeps
      // a long thinking turn from hitting the HTTP timeout of a single non-streamed request.
      const response = await this.getClient()
        .messages.stream({
          model: request.model ?? DEFAULT_MODEL,
          max_tokens: request.maxTokens + THINKING_HEADROOM,
          messages: request.messages.map(toApiMessage),
        })
        .finalMessage();
      this.addUsage(response);
      if (response.stop_reason === 'max_tokens') throw new Error('reply was cut off at max_tokens');
      return response.content.find((b) => b.type === 'text')?.text ?? '';
    } catch (err) {
      if (isProviderLevelError(err)) {
        throw new ProviderFailure(this.id, describeApiError(err), { cause: err });
      }
      throw err;
    }
  }

  private addUsage(response: Anthropic.Message): void {
    const u = response.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    this.usage.inputTokens += u.input_tokens + cacheRead + cacheWrite;
    this.usage.outputTokens += u.output_tokens;
    const price = PRICES[response.model] ?? PRICES[DEFAULT_MODEL];
    this.usage.costUsd +=
      ((u.input_tokens + cacheWrite * 1.25 + cacheRead * 0.05) * price.input + u.output_tokens * price.output) / 1e6;
  }

  private getClient(): Anthropic {
    // More retries than the SDK's default 2, so a short burst of 429s from parallel jobs
    // (--jobs) is waited out instead of counting as the provider failing.
    this.client ??= new Anthropic({ maxRetries: 5 });
    return this.client;
  }
}

function toApiMessage(message: ChatMessage): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: toContentParts(message.content).map((part) =>
      part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: part.mediaType, data: part.data.toString('base64') },
          },
    ),
  };
}

/** Errors that mean the API as a whole is unusable right now, not just this request. */
function isProviderLevelError(err: unknown): boolean {
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError
  ) {
    return true;
  }
  // Running out of credits comes back as a 400.
  return err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message);
}

function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'API key was rejected (401)';
  if (err instanceof Anthropic.PermissionDeniedError) return 'API key lacks permission (403)';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited (429)';
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
    return 'credit balance is too low';
  }
  if (err instanceof Anthropic.APIConnectionError) return `cannot reach the API (${err.message})`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ''}: ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}
