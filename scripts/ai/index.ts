import { AnthropicApiProvider } from './anthropic-api';
import { ClaudeCliProvider } from './claude-cli';
import { takeJobsOption } from './jobs';
import {
  NoProviderLeftError,
  PROVIDER_IDS,
  ProviderFailure,
  emptyUsage,
  type AiProvider,
  type CompletionRequest,
  type ProviderId,
  type Usage,
} from './types';

export * from './types';
export { runJobs } from './jobs';

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
  /** The switch to the next provider in progress, shared by every request that saw the old one fail. */
  private switching: Promise<boolean> | null = null;

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

  /** Requests sent so far (each attempt counts, retries after a provider switch included) and how many of them failed. */
  readonly stats = { calls: 0, failed: 0 };

  /** Tokens and cost used so far, over every provider this client has used. */
  usage(): Usage {
    const total = emptyUsage();
    for (const p of this.providers) {
      total.inputTokens += p.usage.inputTokens;
      total.outputTokens += p.usage.outputTokens;
      total.costUsd += p.usage.costUsd;
    }
    return total;
  }

  /** Label of the provider serving requests now. */
  get providerLabel(): string {
    return this.providers[this.index]?.label ?? 'none';
  }

  async complete(request: CompletionRequest): Promise<string> {
    for (;;) {
      if (this.switching) await this.switching;
      const index = this.index;
      const provider = this.providers[index];
      if (!provider) throw new NoProviderLeftError('no AI provider left to fall back to');
      this.stats.calls++;
      try {
        return await provider.complete(request);
      } catch (err) {
        this.stats.failed++;
        if (!(err instanceof ProviderFailure)) throw err;
        if (!(await this.switchFrom(index, `${provider.label} failed: ${err.message}`))) {
          throw new NoProviderLeftError(`no AI provider left to fall back to (${provider.label}: ${err.message})`);
        }
      }
    }
  }

  /**
   * Moves past the provider at `index` after it failed. With parallel requests several can
   * see the same provider fail; only the first one switches, and the rest wait for that
   * switch (or find it already done) and retry on whichever provider it settled on.
   */
  private switchFrom(index: number, reason: string): Promise<boolean> {
    if (this.switching) return this.switching;
    if (this.index !== index) return Promise.resolve(this.index < this.providers.length);
    console.log(`  ! ${reason}`);
    this.switching = this.advance().finally(() => {
      this.switching = null;
    });
    return this.switching;
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
 * Pulls the options every AI script takes out of its arguments: `--provider <api|cli>` (see
 * takeProviderOption) and `--jobs <n>`, how many AI requests may run at once (default 1).
 */
export function takeAiOptions(argv: string[]): { provider?: ProviderId; jobs: number; args: string[] } {
  const { provider, args: rest } = takeProviderOption(argv);
  const { jobs, args } = takeJobsOption(rest);
  return { provider, jobs, args };
}

/**
 * Pulls `--provider <api|cli>` (or `--provider=<id>`) out of the CLI arguments, falling
 * back to the AI_PROVIDER environment variable. Returns the remaining arguments.
 */
export function takeProviderOption(argv: string[]): { provider?: ProviderId; args: string[] } {
  const args: string[] = [];
  let value: string | undefined;
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
  value ??= providerFromNpmConfig(args) ?? (process.env.AI_PROVIDER || undefined);
  if (value === undefined) return { args };
  if (!PROVIDER_IDS.includes(value as ProviderId)) {
    throw new Error(`Unknown AI provider "${value}". Use one of: ${PROVIDER_IDS.join(', ')}.`);
  }
  return { provider: value as ProviderId, args };
}

/**
 * In PowerShell, npm.ps1 drops the `--` of `npm run x -- --provider cli`, so npm takes the
 * flag as its own config instead of passing it on: `--provider=cli` arrives as
 * npm_config_provider=cli, and `--provider cli` as npm_config_provider=true with "cli"
 * left among the plain arguments (taken out of `args` here).
 */
function providerFromNpmConfig(args: string[]): string | undefined {
  const npmValue = process.env.npm_config_provider;
  if (!npmValue) return undefined;
  if (npmValue !== 'true') return npmValue;
  const at = args.findIndex((arg) => PROVIDER_IDS.includes(arg as ProviderId));
  return at >= 0 ? args.splice(at, 1)[0] : undefined;
}
