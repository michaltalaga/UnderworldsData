import type { Language, Warscroll, Ability, TranslatedText } from '../types/warscroll';
import { t } from '../i18n/labels';

interface Props {
  warscroll: Warscroll;
  language: Language;
}

function getText(text: TranslatedText | undefined, lang: Language): string {
  if (!text) return '';
  return text[lang] ?? text.en ?? '';
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

function renderText(text: TranslatedText | undefined, lang: Language) {
  const raw = getText(text, lang);
  if (!raw) return null;
  return raw.split('\n').map((line, i) => (
    <span key={i}>
      {i > 0 && <br />}
      {renderIconTokens(line)}
    </span>
  ));
}

function AbilityCard({ ability, language }: { ability: Ability; language: Language }) {
  return (
    <div className="ability-card">
      <h4>{getText(ability.name, language)}</h4>
      {ability.type && (
        <div className="ability-type">{t(ability.type, language)}</div>
      )}
      {ability.flavorText && getText(ability.flavorText, language) && (
        <p className="flavor">{renderText(ability.flavorText, language)}</p>
      )}
      {ability.trigger && getText(ability.trigger, language) && (
        <p className="trigger">{renderText(ability.trigger, language)}</p>
      )}
      <p className="rules">{renderText(ability.rulesText, language)}</p>
    </div>
  );
}

export function WarscrollView({ warscroll, language }: Props) {
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
            <p>{renderText(warscroll.inspire, language)}</p>
          </div>
          {warscroll.reactions.length > 0 && warscroll.reactions.map((r, i) => (
            <div className="reaction-box" key={i}>
              <h4>{getText(r.name, language)}</h4>
              {r.trigger && (
                <p className="trigger">{renderText(r.trigger, language)}</p>
              )}
              <p className="rules">{renderText(r.rulesText, language)}</p>
            </div>
          ))}
        </div>
        <div className="warscroll-right">
          {warscroll.abilities.map((ability, i) => (
            <AbilityCard key={i} ability={ability} language={language} />
          ))}
        </div>
      </div>
    </div>
  );
}
