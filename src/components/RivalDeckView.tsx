import { useState } from 'react';
import { t } from '../i18n/labels';
import { renderText } from './GameText';
import { StarRating } from './StarRating';
import { warbandRatingsForDeck } from '../data/pairings';
import { warbandHref } from '../routing';
import { warbandIcon, deckIcon } from '../data/icons';
import type { RivalCard, RivalDeck } from '../types/rivals';
import type { Language } from '../types/warscroll';

interface Props {
  deck: RivalDeck;
  language: Language;
}

const CARD_TYPE_ORDER = ['Objective', 'Ploy', 'Upgrade'];

function groupCards(cards: RivalCard[]) {
  const groups = new Map<string, RivalCard[]>();

  for (const card of cards) {
    const bucket = groups.get(card.type) ?? [];
    bucket.push(card);
    groups.set(card.type, bucket);
  }

  const orderedTypes = [...groups.keys()].sort((left, right) => {
    const leftIndex = CARD_TYPE_ORDER.indexOf(left);
    const rightIndex = CARD_TYPE_ORDER.indexOf(right);
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return normalizedLeft - normalizedRight || left.localeCompare(right);
  });

  return orderedTypes.map((type) => ({
    type,
    cards: (groups.get(type) ?? []).sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true })),
  }));
}

function labelForCardType(type: string, language: Language) {
  return t(type.toLowerCase(), language);
}

function labelForSingleCardType(type: string, language: Language) {
  const key = `${type.toLowerCase()}CardType`;
  return t(key, language);
}

export function RivalDeckView({ deck, language }: Props) {
  const groupedCards = groupCards(deck.cards);
  const [showAllWarbands, setShowAllWarbands] = useState(false);
  const headerIcon = deckIcon(deck.slug);

  const warbandRatings = warbandRatingsForDeck(deck.slug, language);
  const recommended = warbandRatings.filter((rating) => rating.stars >= 2);
  // Never collapse to an empty list: if nothing is >=2 stars, the collapsed view shows all.
  const collapsedList = recommended.length > 0 ? recommended : warbandRatings;
  const shownWarbands = showAllWarbands ? warbandRatings : collapsedList;
  const canExpand = warbandRatings.length > collapsedList.length;

  return (
    <div className="rival-deck">
      <div className="warscroll-header rival-header">
        <h2>
          {headerIcon && <img className="header-icon" src={headerIcon} alt="" />}
          {deck.name}
        </h2>
        <div className="rival-header-meta">
          <span className="rival-pill">{deck.code}</span>
          <span className="rival-pill">{deck.cardCount} {t('cards', language).toLowerCase()}</span>
          <span className={`ga-badge ${deck.faction}`}>{deck.faction}</span>
        </div>
      </div>

      <div className="rival-body">
        <aside className="rival-sidebar">
          <div className="inspire-box rival-plot-box">
            <h4>{t('plot', language)}</h4>
            <p>{deck.plot ? renderText(deck.plot) : t('noPlot', language)}</p>
          </div>

          {deck.strategy && (
            <div className="reaction-box rival-meta-box rival-strategy-box">
              <h4>{t('strategy', language)}</h4>
              {deck.strategyTagline && <p className="rival-strategy-identity">{deck.strategyTagline}</p>}
              <p className="rules">{deck.strategy}</p>
            </div>
          )}

          <div className="reaction-box rival-meta-box">
            <h4>{t('faction', language)}</h4>
            <p className="rules">{deck.faction}</p>
            <h4>{t('cards', language)}</h4>
            <p className="rules">{deck.cardCount}</p>
          </div>
        </aside>

        <div className="rival-content">
          {warbandRatings.length > 0 && (
            <section className="rival-group pairing-warbands">
              <div className="rival-group-header">
                <h3>{t('bestWarbands', language)}</h3>
                <span>{shownWarbands.length}</span>
              </div>
              <ul className="pairing-list deck-warband-list">
                {shownWarbands.map((rating) => {
                  const icon = warbandIcon(rating.warband);
                  return (
                    <li key={rating.warband} className={`pairing-row stars-${rating.stars}`}>
                      <StarRating stars={rating.stars} />
                      <a className="pairing-link" href={warbandHref(rating.warband)}>
                        {icon
                          ? <img className="pairing-icon" src={icon} alt="" />
                          : <span className={`ga-dot ${rating.warbandMeta.grandAlliance}`} aria-hidden="true" />}
                        <span className="pairing-name">{rating.warbandMeta.name}</span>
                        <span className="pairing-fighters">{rating.warbandMeta.fighters}</span>
                      </a>
                      {rating.note && <span className="pairing-note">{rating.note}</span>}
                    </li>
                  );
                })}
              </ul>
              {canExpand && (
                <button
                  type="button"
                  className="pairing-toggle"
                  onClick={() => setShowAllWarbands((value) => !value)}
                >
                  {showAllWarbands
                    ? t('showLess', language)
                    : `${t('showMore', language)} (${warbandRatings.length})`}
                </button>
              )}
            </section>
          )}

          {groupedCards.map((group) => (
            <section className="rival-group" key={group.type}>
              <div className="rival-group-header">
                <h3>{labelForCardType(group.type, language)}</h3>
                <span>{group.cards.length}</span>
              </div>

              <div className="rival-card-grid">
                {group.cards.map((card) => (
                  <article className="ability-card rival-card" key={card.id}>
                    <div className="rival-card-top">
                      <div>
                        <div className="rival-card-id">{card.id}</div>
                        <div className="rival-card-type">{labelForSingleCardType(card.type, language)}</div>
                        <h4>{card.name}</h4>
                      </div>
                      {card.value && (
                        <div className="rival-card-value">{card.value}</div>
                      )}
                    </div>
                    {card.text && (
                      <p className="rules">{renderText(card.text)}</p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
