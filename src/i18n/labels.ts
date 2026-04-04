import type { Language } from '../types/warscroll';

type Labels = {
  [key: string]: { [L in Language]: string };
};

export const labels: Labels = {
  title: { en: 'Underworlds Warscrolls', pl: 'Zwoje Wojenne Underworlds' },
  selectWarband: { en: 'Select a Warband', pl: 'Wybierz drużynę' },
  inspire: { en: 'Inspire', pl: 'Inspiracja' },
  abilities: { en: 'Abilities', pl: 'Zdolności' },
  reactions: { en: 'Reactions', pl: 'Reakcje' },
  print: { en: 'Print', pl: 'Drukuj' },
  search: { en: 'Search...', pl: 'Szukaj...' },
  noWarscroll: { en: 'Warscroll data not yet extracted for this warband.', pl: 'Dane zwoju wojennego nie zostały jeszcze wyodrębnione dla tej drużyny.' },
  passive: { en: 'Passive', pl: 'Pasywna' },
  action: { en: 'Action', pl: 'Akcja' },
  reaction: { en: 'Reaction', pl: 'Reakcja' },
  fighters: { en: 'fighters', pl: 'wojowników' },
};

export function t(key: string, lang: Language): string {
  return labels[key]?.[lang] ?? labels[key]?.en ?? key;
}
