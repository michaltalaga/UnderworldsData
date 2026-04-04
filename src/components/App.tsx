import { useState, useEffect, useCallback } from 'react';
import type { Language, WarbandMeta, Warscroll, WarscrollTranslation } from '../types/warscroll';
import type { RivalDeck, RivalDeckMeta } from '../types/rivals';
import { t } from '../i18n/labels';
import { LanguageToggle } from './LanguageToggle';
import { WarbandSelector } from './WarbandSelector';
import { WarscrollView } from './WarscrollView';
import { RivalDeckSelector } from './RivalDeckSelector';
import { RivalDeckView } from './RivalDeckView';
import { ViewToggle, type AppView } from './ViewToggle';

import warbandIndex from '../../warbands/index.json';
import rivalIndex from '../../rivals/index.json';

const enModules = import.meta.glob<Warscroll>('../../warbands/*/warscroll.json', {
  eager: true,
  import: 'default',
});

const plModules = import.meta.glob<WarscrollTranslation>('../../warbands/*/warscroll.pl.json', {
  eager: true,
  import: 'default',
});

const rivalModules = import.meta.glob<RivalDeck>('../../rivals/*/deck.json', {
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
  const [view, setView] = useState<AppView>('warscrolls');
  const [selectedWarbandSlug, setSelectedWarbandSlug] = useState<string | null>(null);
  const [selectedRivalSlug, setSelectedRivalSlug] = useState<string | null>(null);
  const [warscrolls] = useState(() => loadMap(enModules));
  const [translations] = useState(() => loadMap(plModules));
  const [rivals] = useState(() => loadMap(rivalModules));

  const warbands: WarbandMeta[] = warbandIndex as WarbandMeta[];
  const rivalDecks: RivalDeckMeta[] = rivalIndex as RivalDeckMeta[];
  const availableWarbandSlugs = new Set(warscrolls.keys());
  const availableRivalSlugs = new Set(rivals.keys());

  const selectedWarscroll = selectedWarbandSlug ? warscrolls.get(selectedWarbandSlug) ?? null : null;
  const selectedTranslation = selectedWarbandSlug ? translations.get(selectedWarbandSlug) ?? null : null;
  const selectedRivalDeck = selectedRivalSlug ? rivals.get(selectedRivalSlug) ?? null : null;
  const currentTitle = view === 'warscrolls' ? t('warscrollTitle', language) : t('rivalsTitle', language);
  const canPrint = view === 'warscrolls' ? Boolean(selectedWarscroll) : Boolean(selectedRivalDeck);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  useEffect(() => {
    document.title = `${t('appTitle', language)} - ${currentTitle}`;
  }, [currentTitle, language]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      if (view === 'warscrolls') {
        setSelectedWarbandSlug(null);
      } else {
        setSelectedRivalSlug(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view]);

  return (
    <div className="app">
      <header className="header">
        <div className="header-main">
          <h1>{t('appTitle', language)}</h1>
          <ViewToggle view={view} onChange={setView} language={language} />
        </div>
        <div className="header-controls">
          <LanguageToggle language={language} onChange={setLanguage} />
          {canPrint && (
            <button className="print-btn" onClick={handlePrint}>
              {t('print', language)}
            </button>
          )}
        </div>
      </header>

      {view === 'warscrolls' ? (
        <>
          <WarbandSelector
            warbands={warbands}
            selected={selectedWarbandSlug}
            onSelect={setSelectedWarbandSlug}
            language={language}
            availableSlugs={availableWarbandSlugs}
          />

          {selectedWarbandSlug && !selectedWarscroll && (
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
        </>
      ) : (
        <>
          {rivalDecks.length > 0 ? (
            <RivalDeckSelector
              decks={rivalDecks}
              selected={selectedRivalSlug}
              onSelect={setSelectedRivalSlug}
              language={language}
              availableSlugs={availableRivalSlugs}
            />
          ) : (
            <div className="no-warscroll">
              <p>{t('noRivalsLoaded', language)}</p>
            </div>
          )}

          {selectedRivalSlug && !selectedRivalDeck && (
            <div className="no-warscroll">
              <p>{t('noRivalDeck', language)}</p>
            </div>
          )}

          {selectedRivalDeck && (
            <RivalDeckView
              deck={selectedRivalDeck}
              language={language}
            />
          )}
        </>
      )}
    </div>
  );
}
