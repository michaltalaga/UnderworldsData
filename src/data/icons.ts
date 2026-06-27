// Eagerly-loaded icon URL lookups (warband, rival deck, and faction/Grand Alliance icons).
const warbandIconModules = import.meta.glob('../../warbands/*/icon.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const deckIconModules = import.meta.glob('../../rivals/*/icon.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const factionIconModules = import.meta.glob('../../warbands/_ga/*-icon.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

function bySlug(modules: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [path, url] of Object.entries(modules)) {
    const parts = path.split('/');
    map.set(parts[parts.length - 2], url); // .../<slug>/icon.png
  }
  return map;
}

function byFaction(modules: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [path, url] of Object.entries(modules)) {
    const file = path.split('/').pop() ?? '';
    map.set(file.replace('-icon.png', '').toLowerCase(), url); // chaos-icon.png -> chaos
  }
  return map;
}

const warbandIcons = bySlug(warbandIconModules);
const deckIcons = bySlug(deckIconModules);
const factionIcons = byFaction(factionIconModules);

export function warbandIcon(slug: string | null | undefined): string | null {
  return slug ? warbandIcons.get(slug) ?? null : null;
}

export function deckIcon(slug: string | null | undefined): string | null {
  return slug ? deckIcons.get(slug) ?? null : null;
}

export function factionIcon(faction: string | null | undefined): string | null {
  return faction ? factionIcons.get(faction.toLowerCase()) ?? null : null;
}
