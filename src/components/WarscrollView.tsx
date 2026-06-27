import type { Language, Warscroll, Ability, WarscrollTranslation, AbilityTranslation } from '../types/warscroll';
import type { RivalDeckMeta } from '../types/rivals';
import { t } from '../i18n/labels';
import { renderText } from './GameText';
import { StarRating } from './StarRating';
import { deckRatingsForWarband } from '../data/pairings';
import { deckHref } from '../routing';
import { warbandIcon, deckIcon } from '../data/icons';

interface Props {
  warscroll: Warscroll;
  translation: WarscrollTranslation | null;
  language: Language;
  imageUrl: string | null;
  isNonOp?: boolean;
  gaVariant?: 1 | 2;
  onGaVariantChange?: (v: 1 | 2) => void;
  warbandSlug?: string | null;
  decks?: RivalDeckMeta[];
}

function pick(base: string | undefined | null, translated: string | undefined): string {
  return translated ?? base ?? '';
}

function AbilityCard({ ability, tr, language }: { ability: Ability; tr?: AbilityTranslation; language: Language }) {
  return (
    <div className="ability-card">
      <h4>{pick(ability.name, tr?.name)}</h4>
      {ability.type && (
        <div className="ability-type">{t(ability.type, language)}</div>
      )}
      {(ability.flavorText || tr?.flavorText) && (
        <p className="flavor">{renderText(pick(ability.flavorText, tr?.flavorText))}</p>
      )}
      {(ability.trigger || tr?.trigger) && (
        <p className="trigger">{renderText(pick(ability.trigger, tr?.trigger))}</p>
      )}
      <p className="rules">{renderText(pick(ability.rulesText, tr?.rulesText))}</p>
    </div>
  );
}

export function WarscrollView({ warscroll, translation, language, imageUrl, isNonOp, gaVariant, onGaVariantChange, warbandSlug, decks }: Props) {
  const pairingRatings = !isNonOp && warbandSlug ? deckRatingsForWarband(warbandSlug, language) : [];
  const playstyle = !isNonOp ? pick(warscroll.playstyle, translation?.playstyle) : '';
  const taglineByDeck = new Map((decks ?? []).map((deck) => [deck.slug, deck.strategyTagline]));
  const headerIcon = warbandIcon(warbandSlug);

  return (
    <div className="warscroll">
      {isNonOp && onGaVariantChange && (
        <div className="ga-toggle">
          <button
            className={gaVariant === 1 ? 'active' : ''}
            onClick={() => onGaVariantChange(1)}
          >
            {t('warscroll', language)} 1
          </button>
          <button
            className={gaVariant === 2 ? 'active' : ''}
            onClick={() => onGaVariantChange(2)}
          >
            {t('warscroll', language)} 2
          </button>
        </div>
      )}
      <div className="warscroll-header">
        <h2>
          {headerIcon && <img className="header-icon" src={headerIcon} alt="" />}
          {warscroll.name}
          {warscroll.version && (
            <span className="version">(v{warscroll.version})</span>
          )}
        </h2>
      </div>
      <div className="warscroll-body">
        <div className="warscroll-left">
          <div className="inspire-box">
            <h4>{t('inspire', language)}</h4>
            <p>{renderText(pick(warscroll.inspire, translation?.inspire))}</p>
          </div>
          {warscroll.reactions.length > 0 && warscroll.reactions.map((r, i) => (
            <div className="reaction-box" key={i}>
              <h4>{pick(r.name, translation?.reactions?.[i]?.name)}</h4>
              {(r.trigger || translation?.reactions?.[i]?.trigger) && (
                <p className="trigger">{renderText(pick(r.trigger, translation?.reactions?.[i]?.trigger))}</p>
              )}
              <p className="rules">{renderText(pick(r.rulesText, translation?.reactions?.[i]?.rulesText))}</p>
            </div>
          ))}
        </div>
        <div className="warscroll-right">
          {warscroll.abilities.map((ability, i) => (
            <AbilityCard
              key={i}
              ability={ability}
              tr={translation?.abilities?.[i]}
              language={language}
            />
          ))}
        </div>
      </div>

      {(playstyle || pairingRatings.length > 0) && (
        <div className="pairings-panel">
          {playstyle && (
            <div className="pairings-playstyle">
              <h4>{t('playstyle', language)}</h4>
              <p>{playstyle}</p>
            </div>
          )}
          {pairingRatings.length > 0 && (
            <div className="pairings-decks">
              <h4>{t('recommendedDecks', language)}</h4>
              <ul className="pairing-list">
                {pairingRatings.map((rating) => {
                  const secondary = rating.note ?? taglineByDeck.get(rating.deck) ?? null;
                  const icon = deckIcon(rating.deck);
                  return (
                    <li key={rating.deck} className={`pairing-row stars-${rating.stars}`}>
                      <StarRating stars={rating.stars} />
                      <a className="pairing-link" href={deckHref(rating.deck)}>
                        {icon
                          ? <img className="pairing-icon" src={icon} alt="" />
                          : <span className="pairing-code">{rating.deckMeta.code}</span>}
                        <span className="pairing-name">{rating.deckMeta.name}</span>
                      </a>
                      {secondary && <span className="pairing-note">{secondary}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {imageUrl && (
        <div className="warscroll-image">
          <img src={imageUrl} alt={warscroll.name} />
        </div>
      )}
    </div>
  );
}
