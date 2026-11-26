export type Language = 'en' | 'pl';

export interface WarbandMeta {
  slug: string;
  name: string;
  fighters: number;
  opLegal: boolean;
  grandAlliance: 'Chaos' | 'Death' | 'Destruction' | 'Order';
}

export interface Ability {
  name: string;
  type?: 'passive' | 'action' | 'reaction';
  trigger?: string;
  flavorText?: string | null;
  rulesText: string;
}

export interface Warscroll {
  id: string;
  name: string;
  version?: string | null;
  grandAlliance: string;
  inspire: string;
  /** A rule printed outside any entry, such as "You can use 1 of the following abilities once per battle round." */
  generalRules?: string;
  reactions: Ability[];
  abilities: Ability[];
  /** Strategic playstyle blurb for the pairings feature (English source). */
  playstyle?: string;
}

export interface AbilityTranslation {
  name?: string;
  trigger?: string;
  flavorText?: string;
  rulesText?: string;
}

export interface WarscrollTranslation {
  inspire?: string;
  generalRules?: string;
  reactions?: AbilityTranslation[];
  abilities?: AbilityTranslation[];
  playstyle?: string;
}
