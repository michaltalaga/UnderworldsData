import enRaw from '../../warband-rivals-pairings.json';
import plRaw from '../../warband-rivals-pairings.pl.json';
import warbandIndex from '../../warbands/index.json';
import rivalIndex from '../../rivals/index.json';
import type { Language, WarbandMeta } from '../types/warscroll';
import type { RivalDeckMeta } from '../types/rivals';
import type {
  PairingsFile,
  PairingsTranslationFile,
  PairingRatingScale,
  DeckRatingForWarband,
  WarbandRatingForDeck,
} from '../types/pairings';

const en = enRaw as unknown as PairingsFile;
const pl = plRaw as unknown as PairingsTranslationFile;

export const ratingScale: PairingRatingScale[] = en.meta.ratingScale;
export const deckOrder: string[] = en.meta.deckOrder;
const deckOrderIndex = new Map(deckOrder.map((slug, index) => [slug, index]));

const warbands = warbandIndex as WarbandMeta[];
const rivalDecks = rivalIndex as RivalDeckMeta[];
const deckMetaBySlug = new Map(rivalDecks.map((deck) => [deck.slug, deck]));

const starsByKey = new Map<string, number>();
const enNoteByKey = new Map<string, string>();
for (const rating of en.ratings) {
  const key = `${rating.warband}|${rating.deck}`;
  starsByKey.set(key, rating.stars);
  if (rating.note) enNoteByKey.set(key, rating.note);
}

const plNoteByKey = new Map<string, string>();
for (const rating of pl.ratings) {
  plNoteByKey.set(`${rating.warband}|${rating.deck}`, rating.note);
}

function noteFor(warband: string, deck: string, language: Language): string | null {
  const key = `${warband}|${deck}`;
  if (language === 'pl') return plNoteByKey.get(key) ?? enNoteByKey.get(key) ?? null;
  return enNoteByKey.get(key) ?? null;
}

/** Star value (0-3) for a warband/deck pair; 0 if not rated. */
export function ratingStars(warband: string, deck: string): number {
  return starsByKey.get(`${warband}|${deck}`) ?? 0;
}

/** Language-resolved per-pairing note, or null if none (only signature pairings have notes). */
export function ratingNote(warband: string, deck: string, language: Language): string | null {
  return noteFor(warband, deck, language);
}

/** All deck ratings for a warband (slug), strongest first. */
export function deckRatingsForWarband(slug: string, language: Language): DeckRatingForWarband[] {
  const out: DeckRatingForWarband[] = [];
  for (const deck of deckOrder) {
    const deckMeta = deckMetaBySlug.get(deck);
    if (!deckMeta || !starsByKey.has(`${slug}|${deck}`)) continue;
    out.push({ deck, stars: ratingStars(slug, deck), note: noteFor(slug, deck, language), deckMeta });
  }
  out.sort(
    (left, right) =>
      right.stars - left.stars ||
      (deckOrderIndex.get(left.deck) ?? 0) - (deckOrderIndex.get(right.deck) ?? 0),
  );
  return out;
}

/** All OP-legal warband ratings for a deck (slug), strongest first. */
export function warbandRatingsForDeck(slug: string, language: Language): WarbandRatingForDeck[] {
  const out: WarbandRatingForDeck[] = [];
  for (const warband of warbands) {
    if (!warband.opLegal || !starsByKey.has(`${warband.slug}|${slug}`)) continue;
    out.push({
      warband: warband.slug,
      stars: ratingStars(warband.slug, slug),
      note: noteFor(warband.slug, slug, language),
      warbandMeta: warband,
    });
  }
  out.sort(
    (left, right) =>
      right.stars - left.stars || left.warbandMeta.name.localeCompare(right.warbandMeta.name),
  );
  return out;
}

/** True if the warband slug has pairing ratings (i.e. is OP-legal and present). */
export function hasPairingsForWarband(slug: string): boolean {
  return starsByKey.has(`${slug}|${deckOrder[0]}`);
}
