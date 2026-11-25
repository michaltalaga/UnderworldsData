import { readFileSync, writeFileSync } from 'fs';
import { AiClient, runJobs, takeAiOptions } from './ai';
import { completeJson } from './ai/json';
import { fighterCardFiles, isFile, loadWarbands, readJson, warbandFile, type WarbandMeta } from './lib/data';

interface Weapon {
  name: string | null;
  reach: 'melee' | 'ranged';
  range: number;
  symbol: 'hammer' | 'swords';
  dice: number;
  damage: number;
  abilities: { name: string; critical: boolean }[];
}

interface FighterSide {
  move: number;
  save: { symbol: 'shield' | 'dodge'; dice: number };
  health: number;
  bounty: number;
  runemarks: string[];
  weapons: Weapon[];
}

interface Fighter {
  index: number;
  name: string;
  uninspired: FighterSide;
  inspired: FighterSide;
  cardRulesText: string | null;
}

const EXAMPLE_WARBAND = 'spiteclaws-swarm';

function extractionPrompt(wb: WarbandMeta, example: Fighter): string {
  return `You are extracting one Warhammer Underworlds fighter card (2024 Embergard card layout) from the "${wb.name}" warband.
The first image is the fighter's uninspired side, the second image is the inspired side.

Return JSON with this exact shape:
{
  "name": "<fighter name as printed on the card>",
  "uninspired": <side>,
  "inspired": <side>,
  "cardRulesText": "<any rules text printed on the card, or null>"
}

where each <side> is:
{
  "move": <integer Move characteristic>,
  "save": { "symbol": "shield" | "dodge", "dice": <integer number of Save dice> },
  "health": <integer Health characteristic>,
  "bounty": <integer Bounty>,
  "runemarks": ["<runemark>", ...],
  "weapons": [
    {
      "name": null,
      "reach": "melee" | "ranged",
      "range": <integer Range>,
      "symbol": "hammer" | "swords",
      "dice": <integer number of Attack dice>,
      "damage": <integer Damage>,
      "abilities": [{ "name": "<weapon ability>", "critical": <true if it only applies on a critical success> }]
    }
  ]
}

Rules:
- Read each side separately: inspired sides often have more Attack dice, Damage, Move or Save dice.
- Save symbol "shield" is the shield icon, "dodge" is the dodge icon. Weapon symbol "hammer" is the hammer icon, "swords" is the crossed swords icon.
- Runemarks use these names where they apply: "leader" (crown), "minion", "fly", "destined"; use "${wb.slug}" for this warband's own faction runemark; name any other runemark with a short lowercase kebab-case description.
- Weapon abilities use lowercase names such as "grievous", "stagger", "grapple", "brutal", "cleave", "ensnare", "volley"; name others in lowercase kebab-case.
- Weapon "name" is always null. List weapons top to bottom as printed.
- "cardRulesText" is null unless the card prints rules beyond the characteristics and weapons; use {icon:name} tokens for icons in it.

Example output for a different fighter (${example.name} from Spiteclaw's Swarm):
${JSON.stringify({ name: example.name, uninspired: example.uninspired, inspired: example.inspired, cardRulesText: example.cardRulesText })}

Return ONLY valid JSON, no markdown code fences or explanation.`;
}

function assertInt(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${field} is not a whole number`);
}

function validateSide(side: FighterSide, label: string): void {
  if (!side || typeof side !== 'object') throw new Error(`${label} side is missing`);
  for (const key of ['move', 'health', 'bounty'] as const) assertInt(side[key], `${label}.${key}`);
  if (!['shield', 'dodge'].includes(side.save?.symbol)) throw new Error(`${label}.save.symbol is invalid`);
  assertInt(side.save.dice, `${label}.save.dice`);
  if (!Array.isArray(side.runemarks) || side.runemarks.some((r) => typeof r !== 'string')) {
    throw new Error(`${label}.runemarks is invalid`);
  }
  if (!Array.isArray(side.weapons) || side.weapons.length === 0) throw new Error(`${label}.weapons is empty`);
  side.weapons.forEach((w, i) => {
    const at = `${label}.weapons[${i}]`;
    if (!['melee', 'ranged'].includes(w.reach)) throw new Error(`${at}.reach is invalid`);
    if (!['hammer', 'swords'].includes(w.symbol)) throw new Error(`${at}.symbol is invalid`);
    for (const key of ['range', 'dice', 'damage'] as const) assertInt(w[key], `${at}.${key}`);
    if (!Array.isArray(w.abilities) || w.abilities.some((a) => typeof a?.name !== 'string' || typeof a.critical !== 'boolean')) {
      throw new Error(`${at}.abilities is invalid`);
    }
  });
}

/** Key order matching the existing fighters.json files. */
function normalizeSide(side: FighterSide): FighterSide {
  return {
    move: side.move,
    save: { symbol: side.save.symbol, dice: side.save.dice },
    health: side.health,
    bounty: side.bounty,
    runemarks: side.runemarks,
    weapons: side.weapons.map((w) => ({
      name: null,
      reach: w.reach,
      range: w.range,
      symbol: w.symbol,
      dice: w.dice,
      damage: w.damage,
      abilities: w.abilities.map((a) => ({ name: a.name, critical: a.critical })),
    })),
  };
}

async function extractFighter(ai: AiClient, wb: WarbandMeta, index: number, example: Fighter): Promise<Fighter> {
  const raw = await completeJson<Omit<Fighter, 'index'>>(ai, {
    maxTokens: 4096,
    prompt: [
      { type: 'image', mediaType: 'image/png', data: readFileSync(warbandFile(wb.slug, `fighters/${index}.png`)) },
      { type: 'image', mediaType: 'image/png', data: readFileSync(warbandFile(wb.slug, `fighters/${index}-inspired.png`)) },
      { type: 'text', text: extractionPrompt(wb, example) },
    ],
  });
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('fighter name is missing');
  validateSide(raw.uninspired, 'uninspired');
  validateSide(raw.inspired, 'inspired');
  return {
    index,
    name: raw.name.trim(),
    uninspired: normalizeSide(raw.uninspired),
    inspired: normalizeSide(raw.inspired),
    cardRulesText: typeof raw.cardRulesText === 'string' && raw.cardRulesText.trim() ? raw.cardRulesText.trim() : null,
  };
}

/** Pretty JSON with save, runemarks and each weapon on one line, like most fighters.json files. */
function formatFighters(value: unknown, indent = 0, key?: string): string {
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (v && typeof v === 'object') {
      return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`;
    }
    return JSON.stringify(v);
  };
  if (key === 'save' || key === 'runemarks' || key === 'weapon') return inline(value);
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const itemKey = key === 'weapons' ? 'weapon' : undefined;
    return `[\n${value.map((v) => `${pad}  ${formatFighters(v, indent + 1, itemKey)}`).join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${formatFighters(v, indent + 1, k)}`);
    return `{\n${entries.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

async function main() {
  const { provider, jobs, args } = takeAiOptions(process.argv.slice(2));
  const filter = args[0]?.toLowerCase() ?? null;

  // Every warband, vaulted ones included: their fighter cards use the same layout.
  const warbands = loadWarbands();
  const pending = warbands.filter((wb) => !isFile(warbandFile(wb.slug, 'fighters.json')));
  const selected = pending.filter((wb) => !filter || wb.slug === filter || wb.name.toLowerCase() === filter);
  const ready = selected.filter((wb) => fighterCardFiles(wb).every(isFile));
  const noCards = selected.filter((wb) => !ready.includes(wb));

  console.log(`\n  Fighter Stats Extraction`);
  console.log(`  ========================\n`);
  console.log(`  Warbands: ${warbands.length} | Extracted: ${warbands.length - pending.length} | Remaining: ${pending.length}`);
  noCards.forEach((wb) => console.log(`  ${wb.name}: SKIP (fighter cards not downloaded; run npm run download:fighters)`));

  if (ready.length === 0) {
    console.log('  Nothing to extract.');
    return;
  }

  const example = readJson<{ fighters: Fighter[] }>(warbandFile(EXAMPLE_WARBAND, 'fighters.json')).fighters[0];
  const ai = await AiClient.create({ provider });

  // One job per fighter, so a warband's fighters can run in parallel (--jobs). A warband's
  // file is written as soon as its last fighter is in, and only if all of them succeeded.
  const extracted = new Map<string, Fighter[]>(ready.map((wb) => [wb.slug, []]));
  const tasks = ready.flatMap((wb) => Array.from({ length: wb.fighters }, (_, i) => ({ wb, index: i + 1 })));
  console.log('');
  await runJobs(tasks, jobs, ({ wb, index }) => `${wb.name}, fighter ${index}`, async ({ wb, index }) => {
    const fighter = await extractFighter(ai, wb, index, example);
    const fighters = extracted.get(wb.slug)!;
    fighters.push(fighter);
    if (fighters.length === wb.fighters) {
      fighters.sort((a, b) => a.index - b.index);
      writeFileSync(warbandFile(wb.slug, 'fighters.json'), `${formatFighters({ warband: wb.slug, fighters })}\n`);
      return `${fighter.name}; ${wb.name} complete, fighters.json written`;
    }
    return fighter.name;
  });

  const incomplete = ready.filter((wb) => extracted.get(wb.slug)!.length < wb.fighters);
  for (const wb of incomplete) {
    console.log(`  ${wb.name}: not written, ${wb.fighters - extracted.get(wb.slug)!.length} fighter(s) failed. Run again to retry.`);
  }
  const success = ready.length - incomplete.length;
  const failed = incomplete.length;

  console.log(`\n  Done. Warbands written: ${success} | Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
