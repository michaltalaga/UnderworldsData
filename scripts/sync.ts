import { spawnSync } from 'child_process';
import { join } from 'path';
import { takeAiOptions } from './ai';
import { ROOT, readJson } from './lib/data';
import { collectStatus, printStatus, scriptsWithGaps, type FixScript } from './lib/status';

/**
 * Brings all data up to date, running only the steps that have something to do.
 *
 *   npm run sync                      fill every gap
 *   npm run sync -- --provider cli    force an AI provider for the AI steps
 *   npm run sync -- --jobs 4          run up to 4 AI requests at once in each AI step (default 1)
 *   npm run sync -- --dry-run         show the gaps and the steps that would run
 *
 * The two discovery steps always run, because only they can find new warbands or
 * decks on underworldsdb.com. Every other step runs only when the status check says
 * it has a gap to fill, and the status is re-checked before each one.
 */

interface Step {
  script: FixScript;
  why: string;
  always?: boolean;
  ai?: boolean;
  args?: string[];
}

const STEPS: Step[] = [
  { script: 'download', always: true, why: 'sync warband index, download missing warscroll images' },
  { script: 'rivals:sync', always: true, why: 'sync Rivals deck index and deck data' },
  { script: 'download:icons', why: 'download missing icons' },
  { script: 'icons', why: 'draw the icon SVGs again (missing faction runemarks)' },
  { script: 'download:fighters', why: 'download missing fighter cards' },
  { script: 'extract', ai: true, args: ['1000'], why: 'extract missing warscrolls' },
  { script: 'extract:fighters', ai: true, why: 'extract missing fighter stats' },
  { script: 'translate', ai: true, args: ['1000'], why: 'translate missing warscrolls' },
  { script: 'rivals:translate', ai: true, why: 'translate missing Rivals decks' },
  { script: 'pairings', ai: true, why: 'generate missing playstyles, deck strategies, ratings and their Polish versions' },
];

function scriptFile(script: FixScript): string {
  const command = readJson<{ scripts: Record<string, string> }>(join(ROOT, 'package.json')).scripts[script];
  const match = command?.match(/^tsx (\S+\.ts)$/);
  if (!match) throw new Error(`package.json script "${script}" is not a plain "tsx <file>" command`);
  return join(ROOT, match[1]);
}

function runStep(step: Step, provider: string | undefined, jobs: number): boolean {
  const aiArgs = step.ai ? [...(provider ? ['--provider', provider] : []), '--jobs', String(jobs)] : [];
  const args = [...(step.args ?? []), ...aiArgs];
  console.log(`\n>>> [${clock()}] npm run ${step.script}${args.length ? ` -- ${args.join(' ')}` : ''}   (${step.why})`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptFile(step.script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const took = duration(Date.now() - started);
  if (result.error) console.log(`<<< ${step.script} could not start: ${result.error.message}`);
  else if (result.status !== 0) console.log(`<<< ${step.script} finished with exit code ${result.status} after ${took}`);
  else console.log(`<<< ${step.script} done in ${took}`);
  return !result.error && result.status === 0;
}

const clock = () => new Date().toLocaleTimeString('en-GB');

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function main() {
  const { provider, jobs, args } = takeAiOptions(process.argv.slice(2));
  // In PowerShell, npm.ps1 drops the `--` of `npm run sync -- --dry-run`, so npm takes
  // --dry-run as its own flag (and still runs the script): it arrives as npm_config_dry_run.
  const dryRun = args.includes('--dry-run') || process.env.npm_config_dry_run === 'true';

  if (dryRun) {
    const gaps = scriptsWithGaps(collectStatus());
    printStatus(collectStatus());
    console.log(`  Steps that would run (AI steps with ${jobs} job${jobs === 1 ? '' : 's'} in parallel):`);
    for (const step of STEPS) {
      if (step.always || gaps.has(step.script)) console.log(`    npm run ${step.script}   (${step.why})`);
    }
    console.log('  New warbands or decks found by the first two steps may add more.\n');
    return;
  }

  const syncStarted = Date.now();
  const failedSteps: string[] = [];
  for (const step of STEPS) {
    if (!step.always && !scriptsWithGaps(collectStatus()).has(step.script)) {
      console.log(`\n--- npm run ${step.script}: nothing to do`);
      continue;
    }
    if (!runStep(step, provider, jobs)) failedSteps.push(step.script);
  }

  console.log(`\n>>> Final status (sync took ${duration(Date.now() - syncStarted)})`);
  const sections = collectStatus();
  printStatus(sections);
  if (failedSteps.length) console.log(`  Steps that reported failures: ${failedSteps.join(', ')}\n`);
  if (failedSteps.length || scriptsWithGaps(sections).size > 0) process.exitCode = 1;
}

main();
