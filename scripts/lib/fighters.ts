/** The shape of warbands/<slug>/fighters.json, and its formatting. */

/**
 * A characteristic: a number, or the id of the runemark printed in its place (for example a
 * Gardener runemark standing for "the current space on your tracker").
 */
export type Characteristic = number | string;

export interface WeaponAbility {
  name: string;
  critical: boolean;
}

export interface Weapon {
  name: string | null;
  reach: 'melee' | 'ranged';
  range: Characteristic;
  symbol: 'hammer' | 'swords';
  dice: Characteristic;
  damage: Characteristic;
  abilities: WeaponAbility[];
}

export interface FighterSide {
  move: Characteristic;
  save: { symbol: 'shield' | 'dodge'; dice: Characteristic };
  health: Characteristic;
  bounty: Characteristic;
  runemarks: string[];
  weapons: Weapon[];
}

export interface Fighter {
  index: number;
  name: string;
  uninspired: FighterSide;
  inspired: FighterSide;
  cardRulesText: string | null;
}

export interface FightersFile {
  warband: string;
  fighters: Fighter[];
}

export const SIDES = ['uninspired', 'inspired'] as const;
export type Side = (typeof SIDES)[number];

/** Pretty JSON with save, runemarks and each weapon on one line, like most fighters.json files. */
export function formatFighters(value: unknown, indent = 0, key?: string): string {
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (v && typeof v === 'object') {
      return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`;
    }
    return JSON.stringify(v);
  };
  if (key === 'save' || key === 'runemarks' || key === 'weapon') return inline(value);
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const itemKey = key === 'weapons' ? 'weapon' : undefined;
    return `[\n${value.map((v) => `${pad}  ${formatFighters(v, indent + 1, itemKey)}`).join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${formatFighters(v, indent + 1, k)}`);
    return `{\n${entries.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

export function fightersFileText(file: FightersFile): string {
  return `${formatFighters(file)}\n`;
}
