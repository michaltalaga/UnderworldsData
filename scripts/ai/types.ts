export type ProviderId = 'api' | 'cli';

export const PROVIDER_IDS: readonly ProviderId[] = ['api', 'cli'];

/** Model used by every provider unless a request asks for another one. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: Buffer };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Upper bound on the reply length. Providers that cannot enforce it ignore it. */
  maxTokens: number;
  model?: string;
}

export type Availability = { ok: true; detail: string } | { ok: false; reason: string };

/** Tokens and cost a provider has used so far. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });

export interface AiProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Cheap check (no tokens spent) that this provider is set up and can take requests. */
  checkAvailability(): Promise<Availability>;
  /** Sends one request and returns the reply text. */
  complete(request: CompletionRequest): Promise<string>;
  /** Running total for the requests this provider has served. */
  readonly usage: Usage;
}

/**
 * Thrown by a provider when the provider itself stopped working (bad credentials,
 * no credits, rate limited, service down), as opposed to a problem with one request.
 * The client falls back to the next provider when it sees this error.
 */
export class ProviderFailure extends Error {
  constructor(
    readonly providerId: ProviderId,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderFailure';
  }
}

/** Every provider has failed, so the rest of the run cannot succeed either. Scripts stop on it. */
export class NoProviderLeftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProviderLeftError';
  }
}

export function toContentParts(content: ChatMessage['content']): ContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}
