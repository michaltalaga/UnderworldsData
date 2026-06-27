import { Fragment, useMemo } from 'react';
import type { Language, WarbandMeta } from '../types/warscroll';
import type { RivalDeck } from '../types/rivals';
import { t } from '../i18n/labels';
import { ratingStars, ratingNote } from '../data/pairings';
import { warbandHref, deckHref } from '../routing';
import { deckIcon, factionIcon } from '../data/icons';
import { StarRating } from './StarRating';

interface Props {
  language: Language;
  decks: RivalDeck[];
  warbands: WarbandMeta[];
}

const FACTION_ORDER = ['Chaos', 'Death', 'Destruction', 'Order'] as const;

const LEGEND: { stars: number; labelKey: string; descKey: string }[] = [
  { stars: 3, labelKey: 'signatureFit', descKey: 'signatureFitDesc' },
  { stars: 2, labelKey: 'goodFit', descKey: 'goodFitDesc' },
  { stars: 1, labelKey: 'workableFit', descKey: 'workableFitDesc' },
  { stars: 0, labelKey: 'weakFit', descKey: 'weakFitDesc' },
];

export function OverviewView({ language, decks, warbands }: Props) {
  const opWarbands = useMemo(() => warbands.filter((w) => w.opLegal), [warbands]);

  const warbandsByFaction = useMemo(() => {
    const groups: Record<string, WarbandMeta[]> = {};
    for (const faction of FACTION_ORDER) {
      groups[faction] = opWarbands.filter((w) => w.grandAlliance === faction);
    }
    return groups;
  }, [opWarbands]);

  return (
    <div className="overview">
      <section className="overview-intro">
        <h2>{t('overviewTitle', language)}</h2>
        <p className="overview-lead">{t('overviewLead', language)}</p>

        <div className="rating-legend">
          <h3>{t('ratingScale', language)}</h3>
          <ul>
            {LEGEND.map((scale) => (
              <li key={scale.stars}>
                <StarRating stars={scale.stars} compact={scale.stars > 0} decorative />
                <span className="legend-label">{t(scale.labelKey, language)}</span>
                <span className="legend-desc">{t(scale.descKey, language)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="overview-decks">
        <h3>{t('theDecks', language)}</h3>
        <div className="overview-deck-grid">
          {decks.map((deck) => {
            const icon = deckIcon(deck.slug);
            return (
              <a key={deck.slug} className="overview-deck-card" href={deckHref(deck.slug)}>
                <div className="overview-deck-top">
                  {icon
                    ? <img className="overview-deck-icon" src={icon} alt="" />
                    : <span className="rival-pill">{deck.code}</span>}
                  <span className="overview-deck-name">{deck.name}</span>
                </div>
                {deck.strategyTagline && <div className="overview-deck-identity">{deck.strategyTagline}</div>}
                {deck.strategy && <p className="overview-deck-summary">{deck.strategy}</p>}
              </a>
            );
          })}
        </div>
      </section>

      <section className="overview-matrix">
        <h3>{t('matrixHeading', language)}</h3>
        <p className="overview-hint">{t('matrixHint', language)}</p>

        <div className="matrix-scroll">
          <table className="pairing-matrix">
            <thead>
              <tr>
                <th className="matrix-corner" scope="col">
                  {t('selectWarband', language)}
                </th>
                {decks.map((deck) => (
                  <th key={deck.slug} className="matrix-deck-col" scope="col">
                    <a href={deckHref(deck.slug)} title={deck.name}>
                      {deck.code}
                    </a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FACTION_ORDER.map((faction) => (
                <Fragment key={faction}>
                  <tr className="matrix-faction-row">
                    <th colSpan={decks.length + 1} className={faction} scope="colgroup">
                      {factionIcon(faction) && <img className="faction-icon" src={factionIcon(faction)!} alt="" />}
                      {faction}
                    </th>
                  </tr>
                  {warbandsByFaction[faction].map((warband) => (
                    <tr key={warband.slug}>
                      <th className="matrix-warband-row" scope="row">
                        <a href={warbandHref(warband.slug)} title={warband.name}>
                          <span className="matrix-warband-name">{warband.name}</span>
                          <span className="matrix-fighters">{warband.fighters}</span>
                        </a>
                      </th>
                      {decks.map((deck) => {
                        const stars = ratingStars(warband.slug, deck.slug);
                        const note = ratingNote(warband.slug, deck.slug, language);
                        const label = `${warband.name} × ${deck.name}: ${stars}/3`;
                        return (
                          <td key={deck.slug} className={`matrix-cell stars-${stars}`}>
                            <a
                              href={warbandHref(warband.slug)}
                              title={note ? `${label} — ${note}` : label}
                              aria-label={label}
                            >
                              <StarRating stars={stars} compact decorative />
                            </a>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
