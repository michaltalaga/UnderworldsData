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

export interface RivalCard {
  id: string;
  name: string;
  type: string;
  faction: string;
  text: string | null;
  value: string | null;
  previewImageUrl: string | null;
}

export interface RivalDeck extends RivalDeckMeta {
  cards: RivalCard[];
}
