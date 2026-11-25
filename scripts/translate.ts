import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { AiClient, NoProviderLeftError, takeProviderOption } from './ai';
import { completeJson } from './ai/json';

const WARBANDS_DIR = join(import.meta.dirname, '..', 'warbands');
const GA_DIR = join(WARBANDS_DIR, '_ga');

const TRANSLATION_PROMPT = `You are translating a Warhammer Underworlds warscroll from English to Polish.

You will receive an English warscroll JSON. Return a Polish translation JSON containing ONLY the translatable text fields (inspire, reactions, abilities with name/trigger/flavorText/rulesText). Do NOT include metadata fields (id, version, grandAlliance, type).

Translation rules:
- Translate ALL text fields: ability names, flavor text, rules text, inspire conditions, triggers
- Keep game terms that are proper nouns or keywords in their original form if they are commonly used untranslated in the Polish Warhammer community (e.g., "Inspire", "Power step", "Guard token"). However, translate descriptive text around them.
- Preserve {icon:name} tokens exactly as-is — do NOT translate the icon names
- Preserve \\n paragraph breaks
- Translate flavor text with appropriate literary style matching the dark fantasy tone
- For rules text, prioritize clarity and accuracy over literary style

Example output format:
{
  "inspire": "<Polish inspire text>",
  "reactions": [
    {
      "name": "<Polish name>",
      "trigger": "<Polish trigger>",
      "flavorText": "<Polish flavor>",
      "rulesText": "<Polish rules>"
    }
  ],
  "abilities": [
    {
      "name": "<Polish name>",
      "flavorText": "<Polish flavor>",
      "rulesText": "<Polish rules>"
    }
  ]
}

CRITICAL: Return ONLY valid JSON, no markdown code fences or explanation.
Properly escape special characters in JSON strings: use \\" for double quotes, \\\\ for backslashes.
If an English field contains single quotes like 'This is Mine', keep them as-is in the JSON string (single quotes don't need escaping in JSON).`;

async function translateWarscroll(
  ai: AiClient,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = JSON.stringify(data, null, 2);

  return completeJson<Record<string, unknown>>(ai, {
    prompt: `${TRANSLATION_PROMPT}\n\nHere is the English warscroll JSON to translate:\n\n${input}`,
    maxTokens: 8192,
    repairInstruction:
      'Your JSON output was invalid and failed to parse. Please return the same translation but as valid JSON. Make sure all quotes and special characters inside strings are properly escaped. Return ONLY the fixed JSON.',
  });
}

async function translateGaWarscrolls(ai: AiClient) {
  if (!existsSync(GA_DIR)) return;

  const alliances = ['chaos', 'death', 'destruction', 'order'];
  const pending: { key: string; data: Record<string, unknown> }[] = [];
  let alreadyDone = 0;

  for (const alliance of alliances) {
    for (const variant of [1, 2]) {
      const key = `${alliance}-${variant}`;
      const enFile = join(GA_DIR, `${key}.json`);
      const plFile = join(GA_DIR, `${key}.pl.json`);

      if (!existsSync(enFile)) continue;

      if (existsSync(plFile)) {
        alreadyDone++;
        continue;
      }

      const data = JSON.parse(readFileSync(enFile, 'utf8'));
      pending.push({ key, data });
    }
  }

  console.log(`\n  GA Warscroll Translation`);
  console.log(`  =======================\n`);
  console.log(`  Total: ${alreadyDone + pending.length} | Translated: ${alreadyDone} | Remaining: ${pending.length}`);

  if (pending.length === 0) {
    console.log('  All GA warscrolls translated!');
    return;
  }

  let success = 0;
  let failed = 0;

  for (const { key, data } of pending) {
    const name = (data as { name?: string }).name ?? key;
    process.stdout.write(`  ${name} ... `);

    try {
      const translated = await translateWarscroll(ai, data);

      if (!translated.inspire && !translated.abilities) {
        throw new Error('Invalid structure in response');
      }

      writeFileSync(join(GA_DIR, `${key}.pl.json`), JSON.stringify(translated, null, 2));
      console.log('OK');
      success++;
    } catch (err) {
      if (err instanceof NoProviderLeftError) throw err;
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\n  GA done. Success: ${success} | Failed: ${failed}`);
}

async function main() {
  const { provider, args } = takeProviderOption(process.argv.slice(2));
  const batchSize = parseInt(args[0] || '5', 10);

  const ai = await AiClient.create({ provider });

  // Translate GA warscrolls first
  await translateGaWarscrolls(ai);

  // Find warband folders with warscroll.json but no warscroll.pl.json (skip _ga)
  const entries = readdirSync(WARBANDS_DIR);
  const pending: { slug: string; data: Record<string, unknown> }[] = [];
  let alreadyDone = 0;

  for (const entry of entries) {
    if (entry === '_ga') continue;
    const wbDir = join(WARBANDS_DIR, entry);
    if (!statSync(wbDir).isDirectory()) continue;

    const enFile = join(wbDir, 'warscroll.json');
    const plFile = join(wbDir, 'warscroll.pl.json');

    if (!existsSync(enFile)) continue;

    if (existsSync(plFile)) {
      alreadyDone++;
      continue;
    }

    const data = JSON.parse(readFileSync(enFile, 'utf8'));
    pending.push({ slug: entry, data });
  }

  console.log(`\n  Warband Translation`);
  console.log(`  ===================\n`);
  console.log(`  Total with EN: ${alreadyDone + pending.length} | Already translated: ${alreadyDone} | Need translation: ${pending.length}`);

  if (pending.length === 0) {
    console.log('  All warscrolls are fully translated!');
    return;
  }

  const batch = pending.slice(0, batchSize);
  console.log(`  Processing batch of ${batch.length}...\n`);

  let success = 0;
  let failed = 0;

  for (const { slug, data } of batch) {
    const name = (data as { name?: string }).name ?? slug;
    process.stdout.write(`  ${name} ... `);

    try {
      const translated = await translateWarscroll(ai, data);

      if (!translated.inspire && !translated.abilities) {
        throw new Error('Invalid structure in response');
      }

      writeFileSync(
        join(WARBANDS_DIR, slug, 'warscroll.pl.json'),
        JSON.stringify(translated, null, 2),
      );
      console.log('OK');
      success++;
    } catch (err) {
      if (err instanceof NoProviderLeftError) throw err;
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  const remaining = pending.length - batch.length;
  console.log(`\n  Batch done. Success: ${success} | Failed: ${failed} | Still remaining: ${remaining}`);
  if (remaining > 0) {
    console.log('  Run this script again to process the next batch.');
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
