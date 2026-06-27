import type { WarbandMeta } from './warscroll';
import type { RivalDeckMeta } from './rivals';

export interface PairingRatingScale {
  stars: number;
  label: string;
  description: string;
}

export interface PairingMeta {
  title: string;
  game: string;
  description: string;
  note?: string;
  deckOrder: string[];
  ratingScale: PairingRatingScale[];
  method: string;
}

export interface PairingRating {
  warband: string;
  deck: string;
  stars: number;
  note?: string;
}

/** Central ratings file: stars + English per-pairing notes only. Prose lives in entity files. */
export interface PairingsFile {
  meta: PairingMeta;
  ratings: PairingRating[];
}

export interface PairingNoteTranslation {
  warband: string;
  deck: string;
  note: string;
}

/** Polish notes companion file (warband-rivals-pairings.pl.json). */
export interface PairingsTranslationFile {
  ratings: PairingNoteTranslation[];
}

/** A rating from a warband's point of view — language-resolved note + the deck's metadata. */
export interface DeckRatingForWarband {
  deck: string;
  stars: number;
  note: string | null;
  deckMeta: RivalDeckMeta;
}

/** A rating from a deck's point of view — language-resolved note + the warband's metadata. */
export interface WarbandRatingForDeck {
  warband: string;
  stars: number;
  note: string | null;
  warbandMeta: WarbandMeta;
}
