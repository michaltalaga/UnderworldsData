export type Language = 'en' | 'pl';

export type TranslatedText = {
  [key in Language]?: string;
};

export interface WarbandMeta {
  slug: string;
  name: string;
  fighters: number;
  opLegal: boolean;
  grandAlliance: 'Chaos' | 'Death' | 'Destruction' | 'Order';
}

export interface Ability {
  name: TranslatedText;
  type?: 'passive' | 'action' | 'reaction';
  trigger?: TranslatedText;
  flavorText?: TranslatedText;
  rulesText: TranslatedText;
}

export interface Warscroll {
  id: string;
  name: string;
  version?: string;
  grandAlliance: string;
  inspire: TranslatedText;
  reactions: Ability[];
  abilities: Ability[];
}
