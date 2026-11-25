import { AnthropicApiProvider } from './anthropic-api';
import { ClaudeCliProvider } from './claude-cli';
import { PROVIDER_IDS, ProviderFailure, type AiProvider, type CompletionRequest, type ProviderId } from './types';

export * from './types';

/** Every provider has failed, so the rest of the run cannot succeed either. Scripts stop on it. */
export class NoProviderLeftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProviderLeftError';
  }
}

/** Providers in fallback order: the first usable one wins. */
function createProviders(): AiProvider[] {
  return [new AnthropicApiProvider(), new ClaudeCliProvider()];
}

/**
 * Sends requests to the first usable provider and falls back to the next one when a
 * provider stops working mid-run (see ProviderFailure). The request that hit the
 * failure is retried on the new provider, which then serves the rest of the run.
 */
export class AiClient {
  private index = -1;

  private constructor(private readonly providers: AiProvider[]) {}

  /** Picks the first usable provider, or only `provider` when one is forced. */
  static async create(options: { provider?: ProviderId } = {}): Promise<AiClient> {
    const providers = createProviders().filter((p) => !options.provider || p.id === options.provider);
    const client = new AiClient(providers);
    if (!(await client.advance())) {
      throw new Error(
        options.provider
          ? `AI provider "${options.provider}" is not usable (see the reason above).`
          : 'No AI provider is usable. Set ANTHROPIC_API_KEY, or log in to the Claude CLI with `claude auth login`.',
      );
    }
    return client;
  }

  async complete(request: CompletionRequest): Promise<string> {
    for (;;) {
      const provider = this.providers[this.index];
      try {
        return await provider.complete(request);
      } catch (err) {
        if (!(err instanceof ProviderFailure)) throw err;
        console.log(`\n  ! ${provider.label} failed: ${err.message}`);
        if (!(await this.advance())) {
          throw new NoProviderLeftError(`no AI provider left to fall back to (${provider.label}: ${err.message})`);
        }
      }
    }
  }

  /** Moves to the next usable provider. Returns false when none is left. */
  private async advance(): Promise<boolean> {
    while (++this.index < this.providers.length) {
      const provider = this.providers[this.index];
      const availability = await provider.checkAvailability();
      if (availability.ok) {
        console.log(`  AI provider: ${provider.label} - ${availability.detail}`);
        return true;
      }
      console.log(`  AI provider: skipping ${provider.label} - ${availability.reason}`);
    }
    return false;
  }
}

/**
 * Pulls `--provider <api|cli>` (or `--provider=<id>`) out of the CLI arguments, falling
 * back to the AI_PROVIDER environment variable. Returns the remaining arguments.
 */
export function takeProviderOption(argv: string[]): { provider?: ProviderId; args: string[] } {
  const args: string[] = [];
  let value = process.env.AI_PROVIDER || undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--provider') {
      value = argv[++i];
    } else if (arg.startsWith('--provider=')) {
      value = arg.slice('--provider='.length);
    } else {
      args.push(arg);
    }
  }
  if (value === undefined) return { args };
  if (!PROVIDER_IDS.includes(value as ProviderId)) {
    throw new Error(`Unknown AI provider "${value}". Use one of: ${PROVIDER_IDS.join(', ')}.`);
  }
  return { provider: value as ProviderId, args };
}
