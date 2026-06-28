import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Language, WarbandMeta, Warscroll, WarscrollTranslation } from '../types/warscroll';
import type { RivalDeck, RivalDeckMeta, RivalDeckTranslation } from '../types/rivals';
import { t } from '../i18n/labels';
import { LanguageToggle } from './LanguageToggle';
import { WarbandSelector } from './WarbandSelector';
import { WarscrollView } from './WarscrollView';
import { RivalDeckSelector } from './RivalDeckSelector';
import { RivalDeckView } from './RivalDeckView';
import { OverviewView } from './OverviewView';
import { ViewToggle } from './ViewToggle';
import { useRoute, viewHref, navigate } from '../routing';

import warbandIndex from '../../warbands/index.json';
import rivalIndex from '../../rivals/index.json';

const DATA_SOURCE_URL = 'https://www.underworldsdb.com/';
const AUTHOR_URL = 'https://cyberdynesystems.cc/';
const APP_BUILD_LABEL = __APP_BUILD_LABEL__;
const APP_BUILD_URL = __APP_BUILD_URL__;

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
    strategyTagline: translation.strategyTagline ?? base.strategyTagline,
    strategy: translation.strategy ?? base.strategy,
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
  const route = useRoute();
  const view = route.view;
  const selectedWarbandSlug = view === 'warscrolls' ? route.warband : null;
  const selectedRivalSlug = view === 'rivals' ? route.deck : null;

  const [language, setLanguage] = useState<Language>('en');
  const [printCardSpacing, setPrintCardSpacing] = useState(false);
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

  // Full decks (with strategy + cards), language-merged — for the overview and warband panels.
  const allDecks = useMemo<RivalDeck[]>(() => {
    return rivalDecks
      .map((meta) => {
        const full = rivals.get(meta.slug);
        if (!full) return null;
        return language === 'pl' ? mergeRivalDeck(full, rivalTranslations.get(meta.slug) ?? null) : full;
      })
      .filter((deck): deck is RivalDeck => deck !== null);
  }, [rivalDecks, rivals, rivalTranslations, language]);
  const currentTitle =
    view === 'warscrolls'
      ? t('warscrollTitle', language)
      : view === 'rivals'
        ? t('rivalsTitle', language)
        : t('overviewTitle', language);
  const canPrint =
    view === 'warscrolls'
      ? Boolean(selectedWarscroll)
      : view === 'rivals'
        ? Boolean(displayedRivalDeck)
        : false;

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  useEffect(() => {
    document.title = `${t('appTitle', language)} - ${currentTitle}`;
  }, [currentTitle, language]);

  // Reset the GA warscroll variant whenever the selected warband changes,
  // so variant-2 doesn't carry over to an unrelated warband.
  useEffect(() => {
    setGaVariant(1);
  }, [selectedWarbandSlug]);

  // Scroll to top whenever the route's target changes (new warband/deck/tab).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view, selectedWarbandSlug, selectedRivalSlug]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      if (view === 'warscrolls' && selectedWarbandSlug) navigate(viewHref('warscrolls'));
      else if (view === 'rivals' && selectedRivalSlug) navigate(viewHref('rivals'));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view, selectedWarbandSlug, selectedRivalSlug]);

  return (
    <div className={`app${printCardSpacing ? ' print-card-spacing' : ''}`}>
      <header className="header">
        <div className="header-main">
          <h1>{t('appTitle', language)}</h1>
          <ViewToggle view={view} language={language} />
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

      {view === 'warscrolls' && (
        <>
          <WarbandSelector
            warbands={warbands}
            selected={selectedWarbandSlug}
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
              key={selectedWarbandSlug}
              warscroll={selectedWarscroll}
              translation={language === 'pl' ? selectedTranslation : null}
              language={language}
              imageUrl={selectedWarscrollImage}
              isNonOp={isNonOp}
              gaVariant={gaVariant}
              onGaVariantChange={setGaVariant}
              warbandSlug={selectedWarbandSlug}
              decks={allDecks}
            />
          )}
        </>
      )}

      {view === 'rivals' && (
        <>
          {rivalDecks.length > 0 ? (
            <RivalDeckSelector
              decks={displayedRivalDecks}
              selected={selectedRivalSlug}
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
              key={displayedRivalDeck.slug}
              deck={displayedRivalDeck}
              language={language}
            />
          )}
        </>
      )}

      {view === 'overview' && (
        <OverviewView language={language} decks={allDecks} warbands={warbands} />
      )}

      <footer className="app-credits">
        {APP_BUILD_LABEL && (
          <span>
            {t('creditsBuild', language)}:{' '}
            {APP_BUILD_URL ? (
              <a href={APP_BUILD_URL} target="_blank" rel="noreferrer">
                {APP_BUILD_LABEL}
              </a>
            ) : (
              APP_BUILD_LABEL
            )}
          </span>
        )}
        <span>
          {t('creditsAuthor', language)}:{' '}
          <a href={AUTHOR_URL} target="_blank" rel="noreferrer">
            Cyberdyne Systems
          </a>
        </span>
        <span>
          {t('creditsData', language)}:{' '}
          <a href={DATA_SOURCE_URL} target="_blank" rel="noreferrer">
            underworldsdb.com
          </a>
        </span>
      </footer>
    </div>
  );
}
