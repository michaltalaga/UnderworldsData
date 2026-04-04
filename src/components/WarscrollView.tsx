import type { Language, Warscroll, Ability, WarscrollTranslation, AbilityTranslation } from '../types/warscroll';
import { t } from '../i18n/labels';

interface Props {
  warscroll: Warscroll;
  translation: WarscrollTranslation | null;
  language: Language;
}

function pick(base: string | undefined | null, translated: string | undefined): string {
  return translated ?? base ?? '';
}

function renderIconTokens(text: string) {
  const parts = text.split(/(\{icon:[^}]+\})/g);
  return parts.map((part, i) => {
    const match = part.match(/^\{icon:(.+)\}$/);
    if (match) {
      return (
        <span key={i} className="icon-token">
          {match[1]}
        </span>
      );
    }
    return part;
  });
}

function renderText(text: string) {
  if (!text) return null;
  return text.split('\n').map((line, i) => (
    <span key={i}>
      {i > 0 && <br />}
      {renderIconTokens(line)}
    </span>
  ));
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

export function WarscrollView({ warscroll, translation, language }: Props) {
  return (
    <div className="warscroll">
      <div className="warscroll-header">
        <h2>
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
    </div>
  );
}
