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

/**
 * Runs `run` for every item, at most `jobs` at a time, and prints one result line per item:
 * "label ... OK", "label ... OK (detail)" when `run` returns a detail, or "label ... FAILED: why"
 * when it throws. With one job the label is printed when the item starts, as the scripts
 * always did; with more, each line is printed whole when its item ends, so lines never mix.
 * A NoProviderLeftError stops new items from starting and is rethrown once the running ones end.
 */
export async function runJobs<T>(
  items: T[],
  jobs: number,
  label: (item: T) => string,
  run: (item: T) => Promise<string | void>,
): Promise<{ ok: number; failed: number }> {
  const result = { ok: 0, failed: 0 };
  let next = 0;
  let stop: NoProviderLeftError | null = null;
  if (jobs > 1 && items.length > 1) console.log(`  ${items.length} to do, up to ${jobs} at a time`);

  const worker = async () => {
    while (!stop && next < items.length) {
      const item = items[next++];
      const name = label(item);
      if (jobs === 1) process.stdout.write(`  ${name} ... `);
      let outcome: string;
      try {
        const detail = await run(item);
        outcome = detail ? `OK (${detail})` : 'OK';
        result.ok++;
      } catch (err) {
        if (err instanceof NoProviderLeftError) stop ??= err;
        else result.failed++;
        outcome = `FAILED: ${err instanceof Error ? err.message : err}`;
      }
      console.log(jobs === 1 ? outcome : `  ${name} ... ${outcome}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  if (stop) throw stop;
  return result;
}
