import { useState, useMemo } from 'react';
import type { Language, WarbandMeta } from '../types/warscroll';
import { t } from '../i18n/labels';

interface Props {
  warbands: WarbandMeta[];
  selected: string | null;
  onSelect: (slug: string) => void;
  language: Language;
  availableSlugs: Set<string>;
}

const FACTION_ORDER = ['Chaos', 'Death', 'Destruction', 'Order'] as const;

export function WarbandSelector({ warbands, selected, onSelect, language, availableSlugs }: Props) {
  const [search, setSearch] = useState('');

  const grouped = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = q
      ? warbands.filter((w) => w.name.toLowerCase().includes(q))
      : warbands;

    const groups: Record<string, WarbandMeta[]> = {};
    for (const faction of FACTION_ORDER) {
      groups[faction] = filtered.filter((w) => w.grandAlliance === faction);
    }
    return groups;
  }, [warbands, search]);

  return (
    <div className="selector">
      <input
        className="search-input"
        type="text"
        placeholder={t('search', language)}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {FACTION_ORDER.map((faction) =>
        grouped[faction].length > 0 ? (
          <div className="faction-group" key={faction}>
            <h3 className={faction}>{faction}</h3>
            <div className="warband-grid">
              {grouped[faction].map((wb) => (
                <button
                  key={wb.slug}
                  className={`warband-btn ${selected === wb.slug ? 'active' : ''} ${!availableSlugs.has(wb.slug) ? 'no-data' : ''}`}
                  onClick={() => onSelect(wb.slug)}
                  title={`${wb.name} (${wb.fighters} ${t('fighters', language)})`}
                >
                  {wb.name}
                </button>
              ))}
            </div>
          </div>
        ) : null
      )}
    </div>
  );
}
