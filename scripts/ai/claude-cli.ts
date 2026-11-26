import { spawn } from 'child_process';
import { tmpdir } from 'os';
import {
  DEFAULT_MODEL,
  ProviderFailure,
  emptyUsage,
  toContentParts,
  type AiProvider,
  type Availability,
  type ChatMessage,
  type CompletionRequest,
  type ContentPart,
} from './types';

const CLI_COMMAND = process.env.CLAUDE_CLI_PATH || 'claude';
const CALL_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_MS) || 10 * 60_000;
const STATUS_TIMEOUT_MS = 30_000;

// Replaces Claude Code's coding-agent system prompt: these calls are plain model calls.
const SYSTEM_PROMPT =
  'You are a careful data extraction and translation assistant. ' +
  'Follow the instructions in the user message exactly and reply with only the requested output.';

// `error` values on assistant messages that mean the CLI itself cannot serve requests right now.
const PROVIDER_LEVEL_ERRORS = new Set(['authentication_failed', 'billing_error', 'rate_limit', 'server_error']);

/**
 * Provider 2: the Claude Code CLI (`claude -p`), authenticated with the CLI's own login
 * (a Claude subscription). Runs with no tools, no CLAUDE.md or plugins, and no saved
 * session, so each call is a single model turn. Images go in as base64 content blocks
 * over stream-json, so the CLI never has to open files.
 *
 * Overrides: CLAUDE_CLI_PATH (command to run), CLAUDE_CLI_TIMEOUT_MS (per call).
 */
export class ClaudeCliProvider implements AiProvider {
  readonly id = 'cli' as const;
  readonly label = 'Claude CLI (claude -p)';
  readonly usage = emptyUsage();

  async checkAvailability(): Promise<Availability> {
    let result: RunResult;
    try {
      result = await runCli(['auth', 'status', '--json'], null, STATUS_TIMEOUT_MS);
    } catch (err) {
      return { ok: false, reason: describeSpawnError(err) };
    }
    try {
      const status = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string };
      if (status.loggedIn) return { ok: true, detail: `logged in (${status.authMethod ?? 'unknown method'})` };
      return { ok: false, reason: 'claude CLI is not logged in (run `claude auth login` in a terminal)' };
    } catch {
      return { ok: false, reason: `could not read \`claude auth status\` output (exit code ${result.code})` };
    }
  }

  async complete(request: CompletionRequest): Promise<string> {
    const input = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: flattenToSingleTurn(request.messages).map(toCliContentBlock) },
    });
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', '',
      '--model', request.model ?? DEFAULT_MODEL,
      '--no-session-persistence',
      '--safe-mode',
      '--system-prompt', SYSTEM_PROMPT,
    ];

    let result: RunResult;
    try {
      result = await runCli(args, `${input}\n`, CALL_TIMEOUT_MS);
    } catch (err) {
      if (isSpawnNotFound(err)) throw new ProviderFailure(this.id, describeSpawnError(err), { cause: err });
      throw err;
    }

    const outcome = parseStreamOutput(result.stdout);
    if (outcome?.usage) {
      this.usage.inputTokens += outcome.usage.inputTokens;
      this.usage.outputTokens += outcome.usage.outputTokens;
      this.usage.costUsd += outcome.usage.costUsd;
    }
    if (!outcome) {
      const detail = result.stderr.trim().split('\n').slice(-3).join(' ') || 'no output';
      throw new ProviderFailure(this.id, `claude CLI exited with code ${result.code}: ${detail}`);
    }
    if (outcome.isError) {
      const message = `claude CLI: ${outcome.text || outcome.errorType || 'unknown error'}`;
      if (
        (outcome.errorType && PROVIDER_LEVEL_ERRORS.has(outcome.errorType)) ||
        /log ?in|authenticat|usage limit|credit balance/i.test(outcome.text)
      ) {
        throw new ProviderFailure(this.id, message);
      }
      throw new Error(message);
    }
    return outcome.text;
  }
}

/**
 * stream-json input only takes user messages, so a multi-turn request (for example a
 * "your JSON was invalid, fix it" follow-up) is folded into one user message that
 * quotes the earlier reply.
 */
function flattenToSingleTurn(messages: ChatMessage[]): ContentPart[] {
  if (messages.length === 1) return toContentParts(messages[0].content);
  return messages.flatMap((message): ContentPart[] => {
    if (message.role === 'user') return toContentParts(message.content);
    const reply = toContentParts(message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    return [{ type: 'text', text: `Your previous reply was:\n<previous_reply>\n${reply}\n</previous_reply>` }];
  });
}

function toCliContentBlock(part: ContentPart) {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data.toString('base64') } };
}

interface StreamOutcome {
  text: string;
  isError: boolean;
  errorType?: string;
  /** What the CLI reports for the call (with a subscription the cost is what it would have cost on the API). */
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

interface ResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Reads the final `result` event (and any assistant `error` tag) from stream-json output. */
export function parseStreamOutput(stdout: string): StreamOutcome | null {
  let errorType: string | undefined;
  let outcome: StreamOutcome | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event: {
      type?: string;
      error?: string;
      is_error?: boolean;
      result?: string;
      usage?: ResultUsage;
      total_cost_usd?: number;
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant' && event.error) errorType = event.error;
    if (event.type === 'result') {
      outcome = { text: event.result ?? '', isError: Boolean(event.is_error) };
      const u = event.usage;
      if (u || event.total_cost_usd) {
        outcome.usage = {
          inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
          outputTokens: u?.output_tokens ?? 0,
          costUsd: event.total_cost_usd ?? 0,
        };
      }
    }
  }
  if (outcome && errorType) outcome.errorType = errorType;
  return outcome;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], stdin: string | null, timeoutMs: number): Promise<RunResult> {
  try {
    return await spawnOnce(args, stdin, timeoutMs, false);
  } catch (err) {
    // An npm-installed CLI is a `claude.cmd` shim, which Windows only runs through a shell.
    if (process.platform === 'win32' && isSpawnNotFound(err)) {
      return spawnOnce(args, stdin, timeoutMs, true);
    }
    throw err;
  }
}

function spawnOnce(args: string[], stdin: string | null, timeoutMs: number, useShell: boolean): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Without the key the CLI uses its own login, so a rejected or empty key is not reused.
    delete env.ANTHROPIC_API_KEY;

    const child = useShell
      ? spawn([CLI_COMMAND, ...args].map(quoteForShell).join(' '), { shell: true, cwd: tmpdir(), env })
      : spawn(CLI_COMMAND, args, { cwd: tmpdir(), env });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.on('error', () => {
      // The process exited before reading stdin; the close handler reports it.
    });
    child.stdin.end(stdin ?? undefined);
  });
}

function quoteForShell(arg: string): string {
  return arg === '' || /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function isSpawnNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function describeSpawnError(err: unknown): string {
  if (isSpawnNotFound(err)) return `\`${CLI_COMMAND}\` was not found on PATH (set CLAUDE_CLI_PATH to override)`;
  return err instanceof Error ? err.message : String(err);
}
