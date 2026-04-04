import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface WarbandMeta {
  slug: string;
  name: string;
  fighters: number;
  opLegal: boolean;
  grandAlliance: string;
}

const WARBANDS_DIR = join(import.meta.dirname, '..', 'warbands');
const BASE_URL = 'https://www.underworldsdb.com/cards/fighters';

const EXTRACTION_PROMPT = `You are extracting structured data from a Warhammer Underworlds warscroll card image.

Extract ALL text from this warscroll card and return it as valid JSON matching this exact schema.
All text fields are plain English strings (no translation wrappers):

{
  "id": "<warband-slug>",
  "name": "<Warband Name as shown on card>",
  "version": "<version number if shown, e.g. '1.2', or null>",
  "grandAlliance": "<Grand Alliance>",
  "inspire": "<Full inspire condition text>",
  "reactions": [
    {
      "name": "<reaction name>",
      "type": "reaction",
      "trigger": "<trigger text if separate from effect>",
      "flavorText": "<italic flavor text if any>",
      "rulesText": "<rules text>"
    }
  ],
  "abilities": [
    {
      "name": "<ability name>",
      "type": "<passive|action|reaction>",
      "flavorText": "<italic flavor text>",
      "rulesText": "<full rules text>"
    }
  ]
}

Important rules:
- Preserve ALL original wording exactly as written on the card
- Use {icon:name} tokens for game icons (e.g. {icon:leader}, {icon:minion}, {icon:destined}, {icon:dodge}, {icon:shield}, {icon:fury}, {icon:crit}, {icon:cleave}, {icon:ensnare}, {icon:grievous}, {icon:skull}, {icon:hex})
- Separate reactions (used in response to triggers) from passive/action abilities
- If an ability box on the LEFT side of the card contains a named ability with a trigger condition, classify it as a reaction
- Abilities on the RIGHT side are typically passive or action abilities
- "type" for abilities: "passive" if always in effect, "action" if you use it during a power step, "reaction" if triggered by an event
- Keep \\n for paragraph breaks within a field
- Return ONLY valid JSON, no markdown code fences or explanation`;

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function extractWarscroll(
  client: Anthropic,
  imageData: Buffer,
  meta: WarbandMeta,
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: imageData.toString('base64'),
            },
          },
          {
            type: 'text',
            text: `${EXTRACTION_PROMPT}\n\nWarband metadata:\n- slug: "${meta.slug}"\n- grandAlliance: "${meta.grandAlliance}"`,
          },
        ],
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
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npx tsx scripts/extract.ts [batchSize]');
    process.exit(1);
  }

  const client = new Anthropic();

  const index: WarbandMeta[] = JSON.parse(
    readFileSync(join(WARBANDS_DIR, 'index.json'), 'utf8'),
  );

  // Find what's already extracted
  const pending = index.filter((wb) => {
    const wbDir = join(WARBANDS_DIR, wb.slug);
    return !existsSync(join(wbDir, 'warscroll.json'));
  });

  const extracted = index.length - pending.length;
  console.log(`Total: ${index.length} | Extracted: ${extracted} | Remaining: ${pending.length}`);

  if (pending.length === 0) {
    console.log('All warscrolls have been extracted!');
    return;
  }

  const batch = pending.slice(0, batchSize);
  console.log(`\nProcessing batch of ${batch.length}...\n`);

  let success = 0;
  let failed = 0;

  for (const meta of batch) {
    process.stdout.write(`  ${meta.name} ... `);

    const wbDir = join(WARBANDS_DIR, meta.slug);
    mkdirSync(wbDir, { recursive: true });

    // Get image: from warband folder or download
    const localImage = join(wbDir, 'warscroll.png');
    let imageData: Buffer | null = null;

    if (existsSync(localImage)) {
      imageData = readFileSync(localImage);
    } else {
      const url = meta.opLegal
        ? `${BASE_URL}/${meta.slug}-0.png?v=1.14`
        : `${BASE_URL}/${meta.grandAlliance}-01.png?v=1.14`;
      imageData = await downloadImage(url);
      if (imageData) {
        writeFileSync(localImage, imageData);
      }
    }

    if (!imageData || imageData.length < 1000) {
      console.log('SKIP (no image or too small)');
      failed++;
      continue;
    }

    try {
      const raw = await extractWarscroll(client, imageData, meta);

      const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      const data = JSON.parse(jsonStr);

      data.id = meta.slug;
      data.grandAlliance = meta.grandAlliance;

      writeFileSync(
        join(wbDir, 'warscroll.json'),
        JSON.stringify(data, null, 2),
      );

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
