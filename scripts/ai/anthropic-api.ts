import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MODEL,
  ProviderFailure,
  toContentParts,
  type AiProvider,
  type Availability,
  type ChatMessage,
  type CompletionRequest,
} from './types';

/** Provider 1: the Anthropic Messages API, authenticated with ANTHROPIC_API_KEY. */
export class AnthropicApiProvider implements AiProvider {
  readonly id = 'api' as const;
  readonly label = 'Anthropic API (ANTHROPIC_API_KEY)';
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
      const response = await this.getClient().messages.create({
        model: request.model ?? DEFAULT_MODEL,
        max_tokens: request.maxTokens,
        messages: request.messages.map(toApiMessage),
      });
      return response.content.find((b) => b.type === 'text')?.text ?? '';
    } catch (err) {
      if (isProviderLevelError(err)) {
        throw new ProviderFailure(this.id, describeApiError(err), { cause: err });
      }
      throw err;
    }
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
