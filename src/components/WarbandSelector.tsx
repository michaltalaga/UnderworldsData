import { useState, useMemo } from 'react';
import type { Language, WarbandMeta } from '../types/warscroll';
import { t } from '../i18n/labels';
import { warbandHref } from '../routing';
import { warbandIcon, factionIcon } from '../data/icons';

interface Props {
  warbands: WarbandMeta[];
  selected: string | null;
  language: Language;
  availableSlugs: Set<string>;
}

const FACTION_ORDER = ['Chaos', 'Death', 'Destruction', 'Order'] as const;

export function WarbandSelector({ warbands, selected, language, availableSlugs }: Props) {
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
            <h3 className={faction}>
              {factionIcon(faction) && <img className="faction-icon" src={factionIcon(faction)!} alt="" />}
              {faction}
            </h3>
            <div className="warband-grid">
              {grouped[faction].map((wb) => {
                const icon = warbandIcon(wb.slug);
                return (
                  <a
                    key={wb.slug}
                    href={warbandHref(wb.slug)}
                    className={`warband-btn ${selected === wb.slug ? 'active' : ''} ${!availableSlugs.has(wb.slug) ? 'no-data' : ''}`}
                    title={`${wb.name} (${wb.fighters} ${t('fighters', language)})`}
                    aria-current={selected === wb.slug ? 'page' : undefined}
                  >
                    {icon && <img className="btn-icon" src={icon} alt="" />}
                    {wb.name}
                  </a>
                );
              })}
            </div>
          </div>
        ) : null
      )}
    </div>
  );
}
