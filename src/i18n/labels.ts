import type { Language } from '../types/warscroll';

type Labels = {
  [key: string]: { [L in Language]: string };
};

export const labels: Labels = {
  appTitle: { en: 'Underworlds Reference', pl: 'Kompendium Underworlds' },
  warscrollTitle: { en: 'Warscrolls', pl: 'Zwoje Wojenne' },
  rivalsTitle: { en: 'Rival Decks', pl: 'Talie Rivals' },
  selectWarband: { en: 'Select a Warband', pl: 'Wybierz drużynę' },
  inspire: { en: 'Inspire', pl: 'Inspiracja' },
  abilities: { en: 'Abilities', pl: 'Zdolności' },
  reactions: { en: 'Reactions', pl: 'Reakcje' },
  print: { en: 'Print', pl: 'Drukuj' },
  cardGaps: { en: 'Card Gaps', pl: 'Odstępy kart' },
  on: { en: 'On', pl: 'Wł.' },
  off: { en: 'Off', pl: 'Wył.' },
  search: { en: 'Search...', pl: 'Szukaj...' },
  noWarscroll: { en: 'Warscroll data not yet extracted for this warband.', pl: 'Dane zwoju wojennego nie zostały jeszcze wyodrębnione dla tej drużyny.' },
  noRivalDeck: { en: 'Rival deck data not yet downloaded for this deck.', pl: 'Dane talii Rivals nie zostały jeszcze pobrane dla tej talii.' },
  noRivalsLoaded: { en: 'No rival decks have been downloaded yet. Run npm run rivals:sync to populate this view.', pl: 'Nie pobrano jeszcze żadnych talii Rivals. Uruchom npm run rivals:sync, aby wypełnić ten widok.' },
  passive: { en: 'Passive', pl: 'Pasywna' },
  action: { en: 'Action', pl: 'Akcja' },
  reaction: { en: 'Reaction', pl: 'Reakcja' },
  fighters: { en: 'fighters', pl: 'wojowników' },
  cards: { en: 'Cards', pl: 'Karty' },
  faction: { en: 'Faction', pl: 'Frakcja' },
  plot: { en: 'Plot', pl: 'Plot' },
  objective: { en: 'Objectives', pl: 'Cele' },
  objectiveCardType: { en: 'Objective', pl: 'Cel' },
  ploy: { en: 'Ploys', pl: 'Podstępy' },
  ployCardType: { en: 'Ploy', pl: 'Podstęp' },
  upgrade: { en: 'Upgrades', pl: 'Ulepszenia' },
  upgradeCardType: { en: 'Upgrade', pl: 'Ulepszenie' },
  noPlot: { en: 'No plot text listed for this deck.', pl: 'Brak opisu plotu dla tej talii.' },
  viewWarscrolls: { en: 'Warscrolls', pl: 'Zwoje' },
  viewRivals: { en: 'Rival Decks', pl: 'Rivals' },
};

export function t(key: string, lang: Language): string {
  return labels[key]?.[lang] ?? labels[key]?.en ?? key;
}
