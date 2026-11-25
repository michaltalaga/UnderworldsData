import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AiClient, NoProviderLeftError, takeProviderOption } from './ai';
import { completeJson } from './ai/json';

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
  ai: AiClient,
  data: RivalDeck,
): Promise<RivalDeckTranslation> {
  const input = JSON.stringify(data, null, 2);

  return completeJson<RivalDeckTranslation>(ai, {
    prompt: `${TRANSLATION_PROMPT}\n\nHere is the English rival deck JSON to translate:\n\n${input}`,
    maxTokens: 8192,
    repairInstruction:
      'Your JSON output was invalid and failed to parse. Please return the same translation as valid JSON. Preserve the exact schema and return ONLY the fixed JSON.',
  });
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
  const { provider, args } = takeProviderOption(process.argv.slice(2));
  const filter = args[0] ?? null;

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

  const ai = await AiClient.create({ provider });

  let success = 0;
  let failed = 0;

  for (const deck of selected) {
    process.stdout.write(`  ${deck.name} ... `);

    try {
      const translated = await translateDeck(ai, deck);
      validateTranslation(deck, translated);

      writeFileSync(
        join(RIVALS_DIR, deck.slug, 'deck.pl.json'),
        JSON.stringify(translated, null, 2),
      );

      console.log('OK');
      success++;
    } catch (error) {
      if (error instanceof NoProviderLeftError) throw error;
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