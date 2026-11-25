import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const WARBANDS_DIR = join(ROOT, 'warbands');
export const GA_DIR = join(WARBANDS_DIR, '_ga');
export const RIVALS_DIR = join(ROOT, 'rivals');
export const PAIRINGS_FILE = join(ROOT, 'warband-rivals-pairings.json');
export const PAIRINGS_PL_FILE = join(ROOT, 'warband-rivals-pairings.pl.json');

export const ALLIANCES = ['Chaos', 'Death', 'Destruction', 'Order'];
export const FACTION_ICONS = ['chaos', 'death', 'destruction', 'order', 'universal'];
export const GA_KEYS = ALLIANCES.flatMap((alliance) => [1, 2].map((variant) => `${alliance.toLowerCase()}-${variant}`));

export interface WarbandMeta {
  slug: string;
  name: string;
  fighters: number;
  opLegal: boolean;
  grandAlliance: string;
}

export interface RivalDeckMeta {
  slug: string;
  code: string;
  name: string;
  faction: string;
  plot: string | null;
  cardCount: number;
  iconUrl: string | null;
  sourceUrl: string;
}

export interface RivalDeck extends RivalDeckMeta {
  cards: { id: string; name: string; type: string; text: string | null }[];
  strategyTagline?: string;
  strategy?: string;
}

export interface Rating {
  warband: string;
  deck: string;
  stars: number;
  note?: string;
}

export interface PairingsFile {
  meta: {
    description: string;
    deckOrder: string[];
    ratingScale: { stars: number; label: string; description: string }[];
    method: string;
    [key: string]: unknown;
  };
  ratings: Rating[];
}

export interface PairingsPlFile {
  ratings: { warband: string; deck: string; note: string }[];
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readJsonIfExists<T>(path: string): T | null {
  return existsSync(path) ? readJson<T>(path) : null;
}

/** Writes pretty JSON with a trailing newline, like the hand-edited data files. */
export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function loadWarbands(): WarbandMeta[] {
  return readJson<WarbandMeta[]>(join(WARBANDS_DIR, 'index.json'));
}

export function loadDeckIndex(): RivalDeckMeta[] {
  const path = join(RIVALS_DIR, 'index.json');
  return existsSync(path) ? readJson<RivalDeckMeta[]>(path) : [];
}

/** Universal Rivals decks: the columns of the pairings matrix. */
export function loadPairableDecks(): RivalDeckMeta[] {
  return loadDeckIndex().filter((deck) => deck.faction === 'Universal');
}

export const warbandFile = (slug: string, file: string) => join(WARBANDS_DIR, slug, file);
export const deckFile = (slug: string, file: string) => join(RIVALS_DIR, slug, file);

export function fighterCardFiles(wb: WarbandMeta): string[] {
  return Array.from({ length: wb.fighters }, (_, i) => i + 1).flatMap((n) => [
    warbandFile(wb.slug, `fighters/${n}.png`),
    warbandFile(wb.slug, `fighters/${n}-inspired.png`),
  ]);
}
