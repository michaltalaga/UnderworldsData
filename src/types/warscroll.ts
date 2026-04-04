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
  reactions: Ability[];
  abilities: Ability[];
}

export interface AbilityTranslation {
  name?: string;
  trigger?: string;
  flavorText?: string;
  rulesText?: string;
}

export interface WarscrollTranslation {
  inspire?: string;
  reactions?: AbilityTranslation[];
  abilities?: AbilityTranslation[];
}
