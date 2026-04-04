import { useMemo, useState } from 'react';
import { t } from '../i18n/labels';
import type { RivalDeckMeta } from '../types/rivals';
import type { Language } from '../types/warscroll';

interface Props {
  decks: RivalDeckMeta[];
  selected: string | null;
  onSelect: (slug: string) => void;
  language: Language;
  availableSlugs: Set<string>;
}

const FACTION_PRIORITY: Record<string, number> = {
  Universal: 0,
  Chaos: 1,
  Death: 2,
  Destruction: 3,
  Order: 4,
};

function compareFactions(a: string, b: string) {
  return (FACTION_PRIORITY[a] ?? 999) - (FACTION_PRIORITY[b] ?? 999) || a.localeCompare(b);
}

export function RivalDeckSelector({ decks, selected, onSelect, language, availableSlugs }: Props) {
  const [search, setSearch] = useState('');

  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? decks.filter((deck) =>
          deck.name.toLowerCase().includes(query) ||
          deck.code.toLowerCase().includes(query),
        )
      : decks;

    const groups = new Map<string, RivalDeckMeta[]>();
    for (const deck of filtered) {
      const current = groups.get(deck.faction) ?? [];
      current.push(deck);
      groups.set(deck.faction, current);
    }

    return [...groups.entries()]
      .sort(([left], [right]) => compareFactions(left, right))
      .map(([faction, items]) => ({
        faction,
        items: items.sort((left, right) => left.name.localeCompare(right.name)),
      }));
  }, [decks, search]);

  return (
    <div className="selector">
      <input
        className="search-input"
        type="text"
        placeholder={t('search', language)}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      {grouped.map((group) => (
        <div className="faction-group" key={group.faction}>
          <h3 className={group.faction}>{group.faction}</h3>
          <div className="warband-grid">
            {group.items.map((deck) => (
              <button
                key={deck.slug}
                className={`warband-btn ${selected === deck.slug ? 'active' : ''} ${!availableSlugs.has(deck.slug) ? 'no-data' : ''}`}
                onClick={() => onSelect(deck.slug)}
                title={`${deck.code} - ${deck.cardCount} ${t('cards', language).toLowerCase()}`}
              >
                {deck.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
