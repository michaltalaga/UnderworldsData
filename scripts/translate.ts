import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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

function cleanJson(raw: string): string {
  return raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
}

function parseJsonSafe(raw: string): Record<string, unknown> | null {
  const cleaned = cleanJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function translateWarscroll(
  client: Anthropic,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = JSON.stringify(data, null, 2);

  // Attempt 1: normal translation
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `${TRANSLATION_PROMPT}\n\nHere is the English warscroll JSON to translate:\n\n${input}`,
      },
    ],
  });

  const rawText = response.content.find((b) => b.type === 'text')?.text ?? '';
  const parsed = parseJsonSafe(rawText);
  if (parsed) return parsed;

  // Attempt 2: ask the API to fix its own broken JSON
  console.log('(retrying with repair) ... ');
  const repairResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `${TRANSLATION_PROMPT}\n\nHere is the English warscroll JSON to translate:\n\n${input}`,
      },
      {
        role: 'assistant',
        content: rawText,
      },
      {
        role: 'user',
        content: 'Your JSON output was invalid and failed to parse. Please return the same translation but as valid JSON. Make sure all quotes and special characters inside strings are properly escaped. Return ONLY the fixed JSON.',
      },
    ],
  });

  const repairText = repairResponse.content.find((b) => b.type === 'text')?.text ?? '';
  const repaired = parseJsonSafe(repairText);
  if (repaired) return repaired;

  throw new Error(`Invalid JSON after retry. Last parse error at: ${repairText.substring(0, 200)}...`);
}

async function translateGaWarscrolls(client: Anthropic) {
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
      const translated = await translateWarscroll(client, data);

      if (!translated.inspire && !translated.abilities) {
        throw new Error('Invalid structure in response');
      }

      writeFileSync(join(GA_DIR, `${key}.pl.json`), JSON.stringify(translated, null, 2));
      console.log('OK');
      success++;
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\n  GA done. Success: ${success} | Failed: ${failed}`);
}

async function main() {
  const batchSize = parseInt(process.argv[2] || '5', 10);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npx tsx scripts/translate.ts [batchSize]');
    process.exit(1);
  }

  const client = new Anthropic();

  // Translate GA warscrolls first
  await translateGaWarscrolls(client);

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
      const translated = await translateWarscroll(client, data);

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

main();
