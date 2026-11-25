import { spawnSync } from 'child_process';
import { join } from 'path';
import { takeProviderOption } from './ai';
import { ROOT, readJson } from './lib/data';
import { collectStatus, printStatus, scriptsWithGaps, type FixScript } from './lib/status';

/**
 * Brings all data up to date, running only the steps that have something to do.
 *
 *   npm run sync                      fill every gap
 *   npm run sync -- --provider cli    force an AI provider for the AI steps
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

function runStep(step: Step, provider: string | undefined): boolean {
  const args = [...(step.args ?? []), ...(step.ai && provider ? ['--provider', provider] : [])];
  console.log(`\n>>> npm run ${step.script}${args.length ? ` -- ${args.join(' ')}` : ''}   (${step.why})`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptFile(step.script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error) console.log(`<<< ${step.script} could not start: ${result.error.message}`);
  else if (result.status !== 0) console.log(`<<< ${step.script} finished with exit code ${result.status}`);
  return !result.error && result.status === 0;
}

function main() {
  const { provider, args } = takeProviderOption(process.argv.slice(2));
  const dryRun = args.includes('--dry-run');

  if (dryRun) {
    const gaps = scriptsWithGaps(collectStatus());
    printStatus(collectStatus());
    console.log('  Steps that would run:');
    for (const step of STEPS) {
      if (step.always || gaps.has(step.script)) console.log(`    npm run ${step.script}   (${step.why})`);
    }
    console.log('  New warbands or decks found by the first two steps may add more.\n');
    return;
  }

  const failedSteps: string[] = [];
  for (const step of STEPS) {
    if (!step.always && !scriptsWithGaps(collectStatus()).has(step.script)) continue;
    if (!runStep(step, provider)) failedSteps.push(step.script);
  }

  console.log('\n>>> Final status');
  const sections = collectStatus();
  printStatus(sections);
  if (failedSteps.length) console.log(`  Steps that reported failures: ${failedSteps.join(', ')}\n`);
  if (failedSteps.length || scriptsWithGaps(sections).size > 0) process.exitCode = 1;
}

main();
