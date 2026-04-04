import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WARSCROLLS_DIR = join(import.meta.dirname, '..', 'warbands', 'warscrolls');

const TRANSLATION_PROMPT = `You are translating a Warhammer Underworlds warscroll from English to Polish.

You will receive a warscroll JSON. For every object that has an "en" key but no "pl" key, add a "pl" key with the Polish translation.

Translation rules:
- Translate ALL text fields: ability names, flavor text, rules text, inspire conditions, triggers
- Keep game terms that are proper nouns or keywords in their original form if they are commonly used untranslated in the Polish Warhammer community (e.g., "Inspire", "Power step", "Guard token"). However, translate descriptive text around them.
- Preserve {icon:name} tokens exactly as-is — do NOT translate the icon names
- Preserve \\n paragraph breaks
- Keep the same JSON structure — only add "pl" keys alongside existing "en" keys
- Translate flavor text with appropriate literary style matching the dark fantasy tone
- For rules text, prioritize clarity and accuracy over literary style

Return the complete modified JSON with all "pl" translations added. Return ONLY valid JSON, no markdown code fences or explanation.`;

interface TranslatedField {
  en?: string;
  pl?: string;
}

function needsTranslation(data: Record<string, unknown>): boolean {
  const check = (obj: unknown): boolean => {
    if (obj === null || obj === undefined) return false;
    if (typeof obj !== 'object') return false;
    const o = obj as Record<string, unknown>;
    if ('en' in o && !('pl' in o)) return true;
    return Object.values(o).some(check);
  };
  return check(data);
}

async function translateWarscroll(
  client: Anthropic,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `${TRANSLATION_PROMPT}\n\nHere is the warscroll JSON to translate:\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

async function main() {
  const batchSize = parseInt(process.argv[2] || '5', 10);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npx tsx scripts/translate.ts [batchSize]');
    process.exit(1);
  }

  const client = new Anthropic();

  const files = readdirSync(WARSCROLLS_DIR).filter((f) => f.endsWith('.json'));

  // Find files that need translation
  const pending: { file: string; data: Record<string, unknown> }[] = [];
  let alreadyDone = 0;

  for (const file of files) {
    const data = JSON.parse(readFileSync(join(WARSCROLLS_DIR, file), 'utf8'));
    if (needsTranslation(data)) {
      pending.push({ file, data });
    } else {
      alreadyDone++;
    }
  }

  console.log(`Total warscrolls: ${files.length} | Already translated: ${alreadyDone} | Need translation: ${pending.length}`);

  if (pending.length === 0) {
    console.log('All warscrolls are fully translated!');
    return;
  }

  const batch = pending.slice(0, batchSize);
  console.log(`\nProcessing batch of ${batch.length}...\n`);

  let success = 0;
  let failed = 0;

  for (const { file, data } of batch) {
    const name = (data as { name?: string }).name ?? file;
    process.stdout.write(`  ${name} ... `);

    try {
      const raw = await translateWarscroll(client, data);
      const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      const translated = JSON.parse(jsonStr);

      // Validate that the structure is preserved
      if (!translated.id || !translated.abilities) {
        throw new Error('Invalid structure in response');
      }

      writeFileSync(join(WARSCROLLS_DIR, file), JSON.stringify(translated, null, 2));
      console.log('OK');
      success++;
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  const remaining = pending.length - batch.length;
  console.log(`\nBatch done. Success: ${success} | Failed: ${failed} | Still remaining: ${remaining}`);
  if (remaining > 0) {
    console.log('Run this script again to process the next batch.');
  }
}

main();
