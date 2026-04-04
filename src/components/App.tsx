import { useState, useEffect, useCallback } from 'react';
import type { Language, WarbandMeta, Warscroll } from '../types/warscroll';
import { t } from '../i18n/labels';
import { LanguageToggle } from './LanguageToggle';
import { WarbandSelector } from './WarbandSelector';
import { WarscrollView } from './WarscrollView';

// Import warband index - will be bundled
import warbandIndex from '../../warbands/index.json';

// Dynamically import warscroll JSONs
const warscrollModules = import.meta.glob<Warscroll>('../../warbands/warscrolls/*.json', {
  eager: true,
  import: 'default',
});

function loadWarscrolls(): Map<string, Warscroll> {
  const map = new Map<string, Warscroll>();
  for (const [path, data] of Object.entries(warscrollModules)) {
    const slug = path.split('/').pop()?.replace('.json', '') ?? '';
    map.set(slug, data);
  }
  return map;
}

export function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [warscrolls] = useState(() => loadWarscrolls());

  const warbands: WarbandMeta[] = warbandIndex as WarbandMeta[];
  const availableSlugs = new Set(warscrolls.keys());

  const selectedWarscroll = selectedSlug ? warscrolls.get(selectedSlug) ?? null : null;

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  // Keyboard shortcut: Escape to deselect
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
        <WarscrollView warscroll={selectedWarscroll} language={language} />
      )}
    </div>
  );
}
