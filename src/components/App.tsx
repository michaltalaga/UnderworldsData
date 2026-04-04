import { useState, useEffect, useCallback } from 'react';
import type { Language, WarbandMeta, Warscroll, WarscrollTranslation } from '../types/warscroll';
import { t } from '../i18n/labels';
import { LanguageToggle } from './LanguageToggle';
import { WarbandSelector } from './WarbandSelector';
import { WarscrollView } from './WarscrollView';

import warbandIndex from '../../warbands/index.json';

const enModules = import.meta.glob<Warscroll>('../../warbands/*/warscroll.json', {
  eager: true,
  import: 'default',
});

const plModules = import.meta.glob<WarscrollTranslation>('../../warbands/*/warscroll.pl.json', {
  eager: true,
  import: 'default',
});

function extractSlug(path: string): string {
  // path like "../../warbands/the-thricefold-discord/warscroll.json"
  const parts = path.split('/');
  return parts[parts.length - 2];
}

function loadMap<T>(modules: Record<string, T>): Map<string, T> {
  const map = new Map<string, T>();
  for (const [path, data] of Object.entries(modules)) {
    map.set(extractSlug(path), data);
  }
  return map;
}

export function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [warscrolls] = useState(() => loadMap(enModules));
  const [translations] = useState(() => loadMap(plModules));

  const warbands: WarbandMeta[] = warbandIndex as WarbandMeta[];
  const availableSlugs = new Set(warscrolls.keys());

  const selectedWarscroll = selectedSlug ? warscrolls.get(selectedSlug) ?? null : null;
  const selectedTranslation = selectedSlug ? translations.get(selectedSlug) ?? null : null;

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedSlug(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>{t('title', language)}</h1>
        <div className="header-controls">
          <LanguageToggle language={language} onChange={setLanguage} />
          {selectedWarscroll && (
            <button className="print-btn" onClick={handlePrint}>
              {t('print', language)}
            </button>
          )}
        </div>
      </header>

      <WarbandSelector
        warbands={warbands}
        selected={selectedSlug}
        onSelect={setSelectedSlug}
        language={language}
        availableSlugs={availableSlugs}
      />

      {selectedSlug && !selectedWarscroll && (
        <div className="no-warscroll">
          <p>{t('noWarscroll', language)}</p>
        </div>
      )}

      {selectedWarscroll && (
        <WarscrollView
          warscroll={selectedWarscroll}
          translation={language === 'pl' ? selectedTranslation : null}
          language={language}
        />
      )}
    </div>
  );
}
