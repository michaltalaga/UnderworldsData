import { AsyncLocalStorage } from 'async_hooks';
import { clearLine, cursorTo } from 'readline';
import { NoProviderLeftError } from './types';

/**
 * Pulls `--jobs <n>` (or `--jobs=<n>`) out of the arguments: how many AI requests a script
 * may have running at once. Falls back to npm's config when PowerShell dropped the `--`
 * (see jobsFromNpmConfig), then to the AI_JOBS environment variable, then to 1.
 */
export function takeJobsOption(argv: string[]): { jobs: number; args: string[] } {
  const args: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--jobs') {
      value = argv[++i];
    } else if (arg.startsWith('--jobs=')) {
      value = arg.slice('--jobs='.length);
    } else {
      args.push(arg);
    }
  }
  value ??= jobsFromNpmConfig(args) ?? (process.env.AI_JOBS || undefined);
  if (value === undefined) return { jobs: 1, args };
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error(`--jobs must be a whole number of at least 1, got "${value}".`);
  }
  return { jobs, args };
}

/**
 * In PowerShell, npm.ps1 drops the `--` of `npm run x -- --jobs 4`, so npm takes the flag as
 * its own config: `--jobs=4` arrives as npm_config_jobs=4, and `--jobs 4` as
 * npm_config_jobs=true with "4" left as the first argument (taken out of `args` here).
 */
function jobsFromNpmConfig(args: string[]): string | undefined {
  const npmValue = process.env.npm_config_jobs;
  if (!npmValue) return undefined;
  if (npmValue !== 'true') return npmValue;
  return /^\d+$/.test(args[0] ?? '') ? args.shift() : undefined;
}

interface ActiveJob {
  name: string;
  started: number;
  note?: string;
}

function elapsed(job: ActiveJob): string {
  const seconds = Math.round((Date.now() - job.started) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Shows what runJobs is working on. In a terminal, a status line at the bottom lists the
 * running items with their elapsed time and refreshes every second; finished items print
 * above it. Anything else printed meanwhile (provider switches, warnings) also goes above
 * it. When output is not a terminal (a log file or pipe), each item prints a line when it
 * starts instead, since a status line cannot be redrawn there.
 */
class ProgressDisplay {
  private readonly active = new Set<ActiveJob>();
  private done = 0;
  private drawn = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private restoreConsole: (() => void) | undefined;
  private readonly live = Boolean(process.stdout.isTTY);

  constructor(private readonly total: number) {}

  start(): void {
    if (!this.live) return;
    const log = console.log.bind(console);
    const error = console.error.bind(console);
    console.log = (...args: unknown[]) => this.above(() => log(...args));
    console.error = (...args: unknown[]) => this.above(() => error(...args));
    this.restoreConsole = () => {
      console.log = log;
      console.error = error;
    };
    this.timer = setInterval(() => this.draw(), 1000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.clear();
    this.restoreConsole?.();
  }

  begin(job: ActiveJob): void {
    this.active.add(job);
    if (this.live) this.draw();
    else console.log(`  > ${job.name}`);
  }

  end(job: ActiveJob, outcome: string): void {
    this.active.delete(job);
    this.done++;
    console.log(`  [${this.done}/${this.total}] ${job.name} ... ${outcome} [${elapsed(job)}]`);
  }

  noteChanged(job: ActiveJob): void {
    if (this.live) this.draw();
    else console.log(`  ${job.name}: ${job.note}`);
  }

  private above(print: () => void): void {
    this.clear();
    print();
    this.draw();
  }

  private draw(): void {
    if (!this.live) return;
    const working = [...this.active].map((job) => `${job.name} (${elapsed(job)}${job.note ? `, ${job.note}` : ''})`);
    let line = `  [${this.done}/${this.total}] working on: ${working.join(' | ') || '-'}`;
    // One terminal row only: a wrapped status line could not be cleared.
    const width = (process.stdout.columns || 80) - 1;
    if (line.length > width) line = `${line.slice(0, width - 3)}...`;
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(line);
    this.drawn = true;
  }

  private clear(): void {
    if (!this.drawn) return;
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    this.drawn = false;
  }
}

const currentJob = new AsyncLocalStorage<ActiveJob>();
let display: ProgressDisplay | null = null;

/**
 * Notes what the item being worked on is doing right now (for example repairing an invalid
 * reply). It shows next to that item in the status line, or prints when no job is running.
 */
export function jobNote(note: string): void {
  const job = currentJob.getStore();
  if (job && display) {
    job.note = note;
    display.noteChanged(job);
  } else {
    console.log(`  ${note}`);
  }
}

/**
 * Runs `run` for every item, at most `jobs` at a time, showing what is being worked on (see
 * ProgressDisplay) and printing one result line per finished item: "[done/total] label ...
 * OK", "... OK (detail)" when `run` returns a detail, or "... FAILED: why" when it throws,
 * with the time it took. A NoProviderLeftError stops new items from starting and is rethrown
 * once the running ones end.
 */
export async function runJobs<T>(
  items: T[],
  jobs: number,
  label: (item: T) => string,
  run: (item: T) => Promise<string | void>,
): Promise<{ ok: number; failed: number }> {
  const result = { ok: 0, failed: 0 };
  if (items.length === 0) return result;
  let next = 0;
  let stop: NoProviderLeftError | null = null;
  console.log(`  ${items.length} to do${jobs > 1 && items.length > 1 ? `, up to ${jobs} at a time` : ''}`);

  const worker = async () => {
    while (!stop && next < items.length) {
      const item = items[next++];
      const job: ActiveJob = { name: label(item), started: Date.now() };
      display!.begin(job);
      let outcome: string;
      try {
        const detail = await currentJob.run(job, () => run(item));
        outcome = detail ? `OK (${detail})` : 'OK';
        result.ok++;
      } catch (err) {
        if (err instanceof NoProviderLeftError) stop ??= err;
        else result.failed++;
        outcome = `FAILED: ${err instanceof Error ? err.message : err}`;
      }
      display!.end(job, outcome);
    }
  };

  display = new ProgressDisplay(items.length);
  display.start();
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  } finally {
    display.stop();
    display = null;
  }
  if (stop) throw stop;
  return result;
}
