import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

interface RivalCard {
  id: string;
  name: string;
  type: string;
  faction: string;
  text: string | null;
  value: string | null;
  previewImageUrl: string | null;
}

interface RivalDeck {
  slug: string;
  code: string;
  name: string;
  faction: string;
  plot: string | null;
  cardCount: number;
  iconUrl: string | null;
  sourceUrl: string;
  cards: RivalCard[];
}

interface RivalCardTranslation {
  name?: string;
  text?: string | null;
}

interface RivalDeckTranslation {
  name?: string;
  plot?: string | null;
  cards?: RivalCardTranslation[];
}

const RIVALS_DIR = join(import.meta.dirname, '..', 'rivals');

const TRANSLATION_PROMPT = `You are translating a Warhammer Underworlds Rivals deck from English to Polish.

You will receive an English rival deck JSON. Return a Polish translation JSON containing ONLY the translatable text fields.
Do NOT include metadata fields such as slug, code, faction, cardCount, iconUrl, sourceUrl, id, type, value, or previewImageUrl.

Output schema:
{
  "name": "<Polish deck name>",
  "plot": "<Polish plot text or null>",
  "cards": [
    {
      "name": "<Polish card name>",
      "text": "<Polish card text or null>"
    }
  ]
}

Translation rules:
- Translate the deck name, plot text, card names, and card text
- Keep {icon:name} tokens exactly as-is - do NOT translate icon names
- Preserve \n paragraph breaks
- Keep common Warhammer Underworlds rules terminology in the form most natural to Polish players; if a keyword is commonly left in English, keep it in English
- If a source text field is null, return null for that field
- Preserve card order exactly as given in the input

CRITICAL: Return ONLY valid JSON, no markdown code fences or explanation.
Properly escape special characters in JSON strings: use \\" for double quotes and \\\\ for backslashes.`;

function cleanJson(raw: string): string {
  return raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
}

function parseJsonSafe(raw: string): RivalDeckTranslation | null {
  const cleaned = cleanJson(raw);
  try {
    return JSON.parse(cleaned) as RivalDeckTranslation;
  } catch {
    return null;
  }
}

function selectDecks(decks: RivalDeck[], filter: string | null): RivalDeck[] {
  if (!filter) return decks;

  const normalized = filter.toLowerCase();
  return decks.filter((deck) =>
    deck.slug.toLowerCase() === normalized ||
    deck.code.toLowerCase() === normalized ||
    deck.name.toLowerCase() === normalized,
  );
}

async function translateDeck(
  client: Anthropic,
  data: RivalDeck,
): Promise<RivalDeckTranslation> {
  const input = JSON.stringify(data, null, 2);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `${TRANSLATION_PROMPT}\n\nHere is the English rival deck JSON to translate:\n\n${input}`,
      },
    ],
  });

  const rawText = response.content.find((block) => block.type === 'text')?.text ?? '';
  const parsed = parseJsonSafe(rawText);
  if (parsed) return parsed;

  console.log('(retrying with repair) ... ');
  const repairResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `${TRANSLATION_PROMPT}\n\nHere is the English rival deck JSON to translate:\n\n${input}`,
      },
      {
        role: 'assistant',
        content: rawText,
      },
      {
        role: 'user',
        content: 'Your JSON output was invalid and failed to parse. Please return the same translation as valid JSON. Preserve the exact schema and return ONLY the fixed JSON.',
      },
    ],
  });

  const repairText = repairResponse.content.find((block) => block.type === 'text')?.text ?? '';
  const repaired = parseJsonSafe(repairText);
  if (repaired) return repaired;

  throw new Error(`Invalid JSON after retry. Last response starts with: ${repairText.substring(0, 200)}...`);
}

function validateTranslation(deck: RivalDeck, translated: RivalDeckTranslation) {
  if (!translated.name) {
    throw new Error('Translated deck name is missing');
  }

  if (!translated.cards || !Array.isArray(translated.cards)) {
    throw new Error('Translated cards array is missing');
  }

  if (translated.cards.length !== deck.cards.length) {
    throw new Error(`Translated cards count mismatch: expected ${deck.cards.length}, got ${translated.cards.length}`);
  }
}

async function main() {
  const filter = process.argv[2] ?? null;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npx tsx scripts/translate-rivals.ts [deckSlug|deckCode|deckName]');
    process.exit(1);
  }

  const client = new Anthropic();

  const pending: RivalDeck[] = [];
  let alreadyDone = 0;

  for (const entry of readdirSync(RIVALS_DIR)) {
    const deckDir = join(RIVALS_DIR, entry);
    if (!statSync(deckDir).isDirectory()) continue;

    const enFile = join(deckDir, 'deck.json');
    const plFile = join(deckDir, 'deck.pl.json');

    if (!existsSync(enFile)) continue;

    const data = JSON.parse(readFileSync(enFile, 'utf8')) as RivalDeck;

    if (existsSync(plFile)) {
      alreadyDone++;
      continue;
    }

    pending.push(data);
  }

  const selected = selectDecks(pending, filter);
  if (filter && selected.length === 0) {
    throw new Error(`No rival decks matched filter "${filter}"`);
  }

  console.log(`Total pending: ${pending.length} | Already translated: ${alreadyDone} | Translating now: ${selected.length}`);

  if (selected.length === 0) {
    console.log('All rival decks are fully translated!');
    return;
  }

  let success = 0;
  let failed = 0;

  for (const deck of selected) {
    process.stdout.write(`  ${deck.name} ... `);

    try {
      const translated = await translateDeck(client, deck);
      validateTranslation(deck, translated);

      writeFileSync(
        join(RIVALS_DIR, deck.slug, 'deck.pl.json'),
        JSON.stringify(translated, null, 2),
      );

      console.log('OK');
      success++;
    } catch (error) {
      console.log(`FAILED: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  console.log(`\nDone. Success: ${success} | Failed: ${failed}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});