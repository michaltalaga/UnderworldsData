import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Language, WarbandMeta, Warscroll, WarscrollTranslation } from '../types/warscroll';
import type { RivalDeck, RivalDeckMeta, RivalDeckTranslation } from '../types/rivals';
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

const pngModules = import.meta.glob('../../warbands/*/warscroll.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

// GA warscroll globs — keyed by e.g. "chaos-1", "order-2"
const gaEnModules = import.meta.glob<Warscroll>('../../warbands/_ga/*-[12].json', {
  eager: true,
  import: 'default',
});

const gaPlModules = import.meta.glob<WarscrollTranslation>('../../warbands/_ga/*-[12].pl.json', {
  eager: true,
  import: 'default',
});

const gaPngModules = import.meta.glob('../../warbands/_ga/*-[12].png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const rivalModules = import.meta.glob<RivalDeck>('../../rivals/*/deck.json', {
  eager: true,
  import: 'default',
});

const rivalPlModules = import.meta.glob<RivalDeckTranslation>('../../rivals/*/deck.pl.json', {
  eager: true,
  import: 'default',
});

function extractSlug(path: string): string {
  // path like "../../warbands/the-thricefold-discord/warscroll.json"
  const parts = path.split('/');
  return parts[parts.length - 2];
}

function extractGaKey(path: string): string {
  // path like "../../warbands/_ga/chaos-1.json" or "chaos-1.pl.json" or "chaos-1.png"
  const filename = path.split('/').pop()!;
  const match = filename.match(/^(\w+-[12])/);
  return match ? match[1] : filename;
}

function loadMap<T>(modules: Record<string, T>): Map<string, T> {
  const map = new Map<string, T>();
  for (const [path, data] of Object.entries(modules)) {
    map.set(extractSlug(path), data);
  }
  return map;
}

function loadGaMap<T>(modules: Record<string, T>): Map<string, T> {
  const map = new Map<string, T>();
  for (const [path, data] of Object.entries(modules)) {
    map.set(extractGaKey(path), data);
  }
  return map;
}

function mergeRivalMeta(base: RivalDeckMeta, translation: RivalDeckTranslation | null): RivalDeckMeta {
  if (!translation) {
    return base;
  }

  return {
    ...base,
    name: translation.name ?? base.name,
    plot: translation.plot === undefined ? base.plot : translation.plot,
  };
}

function mergeRivalDeck(base: RivalDeck, translation: RivalDeckTranslation | null): RivalDeck {
  if (!translation) {
    return base;
  }

  return {
    ...mergeRivalMeta(base, translation),
    cards: base.cards.map((card, index) => {
      const translatedCard = translation.cards[index];
      if (!translatedCard) {
        return card;
      }

      return {
        ...card,
        name: translatedCard.name ?? card.name,
        text: translatedCard.text === undefined ? card.text : translatedCard.text,
      };
    }),
  };
}

export function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [view, setView] = useState<AppView>('warscrolls');
  const [printCardSpacing, setPrintCardSpacing] = useState(false);
  const [selectedWarbandSlug, setSelectedWarbandSlug] = useState<string | null>(null);
  const [selectedRivalSlug, setSelectedRivalSlug] = useState<string | null>(null);
  const [gaVariant, setGaVariant] = useState<1 | 2>(1);
  const [warscrolls] = useState(() => loadMap(enModules));
  const [warscrollImages] = useState(() => loadMap(pngModules));
  const [translations] = useState(() => loadMap(plModules));
  const [gaWarscrolls] = useState(() => loadGaMap(gaEnModules));
  const [gaTranslations] = useState(() => loadGaMap(gaPlModules));
  const [gaImages] = useState(() => loadGaMap(gaPngModules));
  const [rivals] = useState(() => loadMap(rivalModules));
  const [rivalTranslations] = useState(() => loadMap(rivalPlModules));

  const warbands: WarbandMeta[] = warbandIndex as WarbandMeta[];
  const rivalDecks: RivalDeckMeta[] = rivalIndex as RivalDeckMeta[];

  // Non-OP warbands are available if GA data exists for their alliance
  const availableWarbandSlugs = useMemo(() => {
    const slugs = new Set(warscrolls.keys());
    for (const wb of warbands) {
      if (!wb.opLegal) {
        const gaKey = `${wb.grandAlliance.toLowerCase()}-1`;
        if (gaWarscrolls.has(gaKey)) slugs.add(wb.slug);
      }
    }
    return slugs;
  }, [warscrolls, gaWarscrolls, warbands]);
  const availableRivalSlugs = new Set(rivals.keys());

  const selectedWarband = selectedWarbandSlug ? warbands.find((w) => w.slug === selectedWarbandSlug) ?? null : null;
  const isNonOp = selectedWarband ? !selectedWarband.opLegal : false;

  // For non-OP: use GA data; for OP: use per-warband data
  const gaKey = isNonOp && selectedWarband ? `${selectedWarband.grandAlliance.toLowerCase()}-${gaVariant}` : null;
  const selectedWarscroll = isNonOp
    ? (gaKey ? gaWarscrolls.get(gaKey) ?? null : null)
    : (selectedWarbandSlug ? warscrolls.get(selectedWarbandSlug) ?? null : null);
  const selectedWarscrollImage = isNonOp
    ? (gaKey ? gaImages.get(gaKey) ?? null : null)
    : (selectedWarbandSlug ? warscrollImages.get(selectedWarbandSlug) ?? null : null);
  const selectedTranslation = isNonOp
    ? (gaKey ? gaTranslations.get(gaKey) ?? null : null)
    : (selectedWarbandSlug ? translations.get(selectedWarbandSlug) ?? null : null);
  const selectedRivalDeck = selectedRivalSlug ? rivals.get(selectedRivalSlug) ?? null : null;
  const selectedRivalTranslation = selectedRivalSlug ? rivalTranslations.get(selectedRivalSlug) ?? null : null;
  const displayedRivalDeck = language === 'pl' && selectedRivalDeck
    ? mergeRivalDeck(selectedRivalDeck, selectedRivalTranslation)
    : selectedRivalDeck;
  const displayedRivalDecks = language === 'pl'
    ? rivalDecks.map((deck) => mergeRivalMeta(deck, rivalTranslations.get(deck.slug) ?? null))
    : rivalDecks;
  const currentTitle = view === 'warscrolls' ? t('warscrollTitle', language) : t('rivalsTitle', language);
  const canPrint = view === 'warscrolls' ? Boolean(selectedWarscroll) : Boolean(displayedRivalDeck);

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
    <div className={`app${printCardSpacing ? ' print-card-spacing' : ''}`}>
      <header className="header">
        <div className="header-main">
          <h1>{t('appTitle', language)}</h1>
          <ViewToggle view={view} onChange={setView} language={language} />
        </div>
        <div className="header-controls">
          <LanguageToggle language={language} onChange={setLanguage} />
          {canPrint && view === 'rivals' && (
            <button
              type="button"
              className={`print-toggle${printCardSpacing ? ' active' : ''}`}
              onClick={() => setPrintCardSpacing((value) => !value)}
              aria-pressed={printCardSpacing}
            >
              {t('cardGaps', language)}: {t(printCardSpacing ? 'on' : 'off', language)}
            </button>
          )}
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
              imageUrl={selectedWarscrollImage}
              isNonOp={isNonOp}
              gaVariant={gaVariant}
              onGaVariantChange={setGaVariant}
            />
          )}
        </>
      ) : (
        <>
          {rivalDecks.length > 0 ? (
            <RivalDeckSelector
              decks={displayedRivalDecks}
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

          {displayedRivalDeck && (
            <RivalDeckView
              deck={displayedRivalDeck}
              language={language}
            />
          )}
        </>
      )}
    </div>
  );
}
