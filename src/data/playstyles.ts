// Pairings playstyle blurbs of vaulted warbands. They have no warscroll.json of their own (they
// play with their Grand Alliance's warscrolls), so theirs live in playstyle.json / playstyle.pl.json.
import type { Language } from '../types/warscroll';

interface PlaystyleFile {
  warband: string;
  playstyle: string;
}

const enModules = import.meta.glob('../../warbands/*/playstyle.json', { eager: true, import: 'default' }) as Record<string, PlaystyleFile>;
const plModules = import.meta.glob('../../warbands/*/playstyle.pl.json', { eager: true, import: 'default' }) as Record<string, PlaystyleFile>;

function bySlug(modules: Record<string, PlaystyleFile>): Map<string, string> {
  // .../warbands/<slug>/playstyle(.pl).json
  return new Map(
    Object.entries(modules).map(([path, data]) => {
      const parts = path.split('/');
      return [parts[parts.length - 2], data.playstyle];
    }),
  );
}

const en = bySlug(enModules);
const pl = bySlug(plModules);

/** A vaulted warband's playstyle in the given language (English when there is no Polish yet), or ''. */
export function vaultedPlaystyle(slug: string, language: Language): string {
  return (language === 'pl' ? pl.get(slug) : undefined) ?? en.get(slug) ?? '';
}
