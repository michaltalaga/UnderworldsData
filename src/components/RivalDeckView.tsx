import { t } from '../i18n/labels';
import { renderText } from './GameText';
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

export function RivalDeckView({ deck, language }: Props) {
  const groupedCards = groupCards(deck.cards);

  return (
    <div className="rival-deck">
      <div className="warscroll-header rival-header">
        <h2>{deck.name}</h2>
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

          <div className="reaction-box rival-meta-box">
            <h4>{t('faction', language)}</h4>
            <p className="rules">{deck.faction}</p>
            <h4>{t('cards', language)}</h4>
            <p className="rules">{deck.cardCount}</p>
          </div>
        </aside>

        <div className="rival-content">
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
