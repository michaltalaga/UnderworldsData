import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

interface RivalDeckIndexEntry {
  slug: string;
  code: string;
  name: string;
  faction: string;
  plot: string | null;
  cardCount: number;
  iconUrl: string | null;
  sourceUrl: string;
}

interface RivalCard {
  id: string;
  name: string;
  type: string;
  faction: string;
  text: string | null;
  value: string | null;
  previewImageUrl: string | null;
}

interface RivalDeck extends RivalDeckIndexEntry {
  cards: RivalCard[];
}

interface HtmlCell {
  tag: 'th' | 'td';
  attrs: string;
  html: string;
}

const RIVALS_DIR = join(import.meta.dirname, '..', 'rivals');
const RIVALS_URL = 'https://www.underworldsdb.com/rivals.php';
const BASE_URL = 'https://www.underworldsdb.com/';

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  copy: '(c)',
  gt: '>',
  hellip: '...',
  lt: '<',
  mdash: '-',
  nbsp: ' ',
  ndash: '-',
  quot: '"',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

const ICON_ALIASES: Record<string, string> = {
  'critical-success': 'crit',
  damage: 'damage',
  dodge: 'dodge',
  grievous: 'grievous',
  hammer: 'hammer',
  hex: 'hex',
  move: 'move',
  shield: 'shield',
  smash: 'hammer',
  sword: 'sword',
};

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function decodeHtml(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const codePoint = parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
    }
    if (lower.startsWith('#')) {
      const codePoint = parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
    }
    return ENTITY_MAP[lower] ?? `&${entity};`;
  });
}

function getAttribute(attrs: string, name: string): string | null {
  const quoted = attrs.match(new RegExp(`${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i'));
  if (quoted) return decodeHtml(quoted[2]);

  const bare = attrs.match(new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, 'i'));
  return bare ? decodeHtml(bare[1]) : null;
}

function iconToken(alt: string): string {
  const slug = slugify(alt);
  return `{icon:${ICON_ALIASES[slug] ?? slug}}`;
}

function htmlToText(html: string): string {
  let text = html;

  text = text.replace(/<span\b[^>]*class=(['"])[^'"]*sr-only[^'"]*\1[^>]*>[\s\S]*?<\/span>/gi, '');
  text = text.replace(/<img\b([^>]*)>/gi, (_, attrs: string) => {
    const alt = getAttribute(attrs, 'alt');
    return alt ? ` ${iconToken(alt)} ` : ' ';
  });
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>\s*/gi, '\n');
  text = text.replace(/<p\b[^>]*>/gi, '');
  text = text.replace(/<\/div>\s*/gi, '\n');
  text = text.replace(/<div\b[^>]*>/gi, '');
  text = text.replace(/<li\b[^>]*>/gi, '- ');
  text = text.replace(/<\/li>\s*/gi, '\n');
  text = text.replace(/<\/?(b|i|strong|em|small)\b[^>]*>/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtml(text);
  text = text.replace(/\r/g, '');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\s+([,.;:!?])/g, '$1');
  return text.trim();
}

function toNullableText(html: string): string | null {
  const text = htmlToText(html);
  return text === '-' ? null : text || null;
}

function extractTableBody(html: string, tableId: string): string {
  const tableMatch = html.match(new RegExp(`<table\\b[^>]*id=["']${tableId}["'][^>]*>([\\s\\S]*?)<\\/table>`, 'i'));
  if (!tableMatch) {
    throw new Error(`Could not find table "${tableId}" in HTML`);
  }

  const bodyMatch = tableMatch[1].match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!bodyMatch) {
    throw new Error(`Could not find tbody for table "${tableId}"`);
  }

  return bodyMatch[1];
}

function extractRows(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
}

function extractCells(rowHtml: string): HtmlCell[] {
  return [...rowHtml.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((match) => ({
    tag: match[1].toLowerCase() as HtmlCell['tag'],
    attrs: match[2],
    html: match[3],
  }));
}

function resolveUrl(pathOrUrl: string | null): string | null {
  if (!pathOrUrl) return null;
  return new URL(pathOrUrl, BASE_URL).toString();
}

function extractPreviewImageUrl(html: string): string | null {
  const match = html.match(/src=(['"])([^'"]+)\1/i);
  return resolveUrl(match?.[2] ?? null);
}

function parseRivalsIndex(html: string): RivalDeckIndexEntry[] {
  const rows = extractRows(extractTableBody(html, 'carddb'));

  return rows.map((rowHtml) => {
    const cells = extractCells(rowHtml);
    if (cells.length < 3) {
      throw new Error(`Unexpected rivals row shape with ${cells.length} cells`);
    }

    const faction = htmlToText(cells[0].html.replace(/<img\b[^>]*>/gi, ''));
    const nameMatch = cells[1].html.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
    const name = htmlToText(nameMatch?.[1] ?? cells[1].html);
    const href = cells[1].html.match(/<a\b[^>]*href=(['"])([^'"]+)\1/i)?.[2] ?? null;
    const sourceUrl = resolveUrl(href);
    if (!sourceUrl) {
      throw new Error(`Missing deck link for ${name}`);
    }

    const iconUrl = resolveUrl(cells[1].html.match(/<img\b[^>]*src=(['"])([^'"]+)\1/i)?.[2] ?? null);
    const source = new URL(sourceUrl);
    const cardIds = (source.searchParams.get('deck') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value && value !== '0');

    const slug = slugify(name.replace(/\s+rivals deck$/i, ''));
    const code = cardIds[0]?.match(/^[A-Z]+/)?.[0] ?? slug.toUpperCase();

    return {
      slug,
      code,
      name,
      faction,
      plot: toNullableText(cells[2].html),
      cardCount: cardIds.length,
      iconUrl,
      sourceUrl,
    };
  });
}

function parseSharedDeck(html: string, baseDeck: RivalDeckIndexEntry): RivalDeck {
  const rows = extractRows(extractTableBody(html, 'carddb'));
  const cards = rows.map((rowHtml) => {
    const cells = extractCells(rowHtml);
    if (cells.length < 7) {
      throw new Error(`Unexpected shared deck row shape with ${cells.length} cells for ${baseDeck.name}`);
    }

    const id = htmlToText(cells[0].html);
    const name = htmlToText(cells[1].html);
    const faction = getAttribute(cells[3].attrs, 'data-sort') ?? htmlToText(cells[3].html);
    const type = getAttribute(cells[4].attrs, 'data-sort') ?? htmlToText(cells[4].html);

    return {
      id,
      name,
      faction,
      type,
      text: toNullableText(cells[5].html),
      value: toNullableText(cells[6].html),
      previewImageUrl: extractPreviewImageUrl(cells[2].html),
    };
  });

  return {
    ...baseDeck,
    cards,
  };
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} when fetching ${url}`);
  }
  return response.text();
}

function writeJson(relativePath: string, data: unknown) {
  const filePath = join(RIVALS_DIR, relativePath);
  const directory = join(filePath, '..');
  mkdirSync(directory, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function selectDecks(index: RivalDeckIndexEntry[], filter: string | null): RivalDeckIndexEntry[] {
  if (!filter) return index;

  const normalized = slugify(filter);
  return index.filter((deck) =>
    deck.slug === normalized ||
    deck.code.toLowerCase() === filter.toLowerCase() ||
    slugify(deck.name) === normalized,
  );
}

async function main() {
  const filter = process.argv[2] ?? null;

  console.log('Fetching rival deck index...');
  const rivalsHtml = await fetchHtml(RIVALS_URL);
  const index = parseRivalsIndex(rivalsHtml);
  writeJson('index.json', index);

  const selectedDecks = selectDecks(index, filter);
  if (selectedDecks.length === 0) {
    throw new Error(`No rival decks matched filter "${filter}"`);
  }

  console.log(`Found ${index.length} rival decks. Syncing ${selectedDecks.length} deck(s)...\n`);

  let success = 0;
  let failed = 0;

  for (const deck of selectedDecks) {
    process.stdout.write(`  ${deck.name} ... `);

    try {
      const sharedHtml = await fetchHtml(deck.sourceUrl);
      const fullDeck = parseSharedDeck(sharedHtml, deck);
      writeJson(join(deck.slug, 'deck.json'), fullDeck);
      console.log(`OK (${fullDeck.cards.length} cards)`);
      success++;
    } catch (error) {
      console.log(`FAILED: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  console.log(`\nDone. Success: ${success} | Failed: ${failed}`);
  console.log(`Rival deck data written to ${RIVALS_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
