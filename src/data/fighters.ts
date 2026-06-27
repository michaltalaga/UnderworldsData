// Fighter-card images (both sides) per warband, paired with fighter names from fighters.json.
interface FightersFile {
  warband: string;
  fighters: { index: number; name: string }[];
}

export interface FighterCard {
  index: number;
  name: string | null;
  uninspired: string | null;
  inspired: string | null;
}

const imageModules = import.meta.glob('../../warbands/*/fighters/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const dataModules = import.meta.glob('../../warbands/*/fighters.json', {
  eager: true,
  import: 'default',
}) as Record<string, FightersFile>;

// slug -> (index -> { uninspired, inspired })
const imagesBySlug = new Map<string, Map<number, { uninspired?: string; inspired?: string }>>();
for (const [path, url] of Object.entries(imageModules)) {
  const parts = path.split('/');
  const slug = parts[parts.length - 3]; // .../warbands/<slug>/fighters/<file>.png
  const file = parts[parts.length - 1];
  const match = file.match(/^(\d+)(-inspired)?\.png$/);
  if (!match) continue;
  const index = Number(match[1]);
  const inspired = Boolean(match[2]);

  const byIndex = imagesBySlug.get(slug) ?? new Map();
  const entry = byIndex.get(index) ?? {};
  if (inspired) entry.inspired = url;
  else entry.uninspired = url;
  byIndex.set(index, entry);
  imagesBySlug.set(slug, byIndex);
}

// slug -> (index -> name)
const namesBySlug = new Map<string, Map<number, string>>();
for (const [path, data] of Object.entries(dataModules)) {
  const parts = path.split('/');
  const slug = parts[parts.length - 2];
  const byIndex = new Map<number, string>();
  for (const fighter of data.fighters ?? []) {
    byIndex.set(fighter.index, fighter.name);
  }
  namesBySlug.set(slug, byIndex);
}

/** Fighter cards (both sides + name) for a warband, sorted by fighter index. */
export function warbandFighters(slug: string | null | undefined): FighterCard[] {
  if (!slug) return [];
  const images = imagesBySlug.get(slug);
  if (!images) return [];
  const names = namesBySlug.get(slug);

  return [...images.entries()]
    .map(([index, urls]) => ({
      index,
      name: names?.get(index) ?? null,
      uninspired: urls.uninspired ?? null,
      inspired: urls.inspired ?? null,
    }))
    .filter((card) => card.uninspired || card.inspired)
    .sort((a, b) => a.index - b.index);
}
