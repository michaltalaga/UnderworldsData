import type { Language } from '../types/warscroll';

interface Props {
  language: Language;
  onChange: (lang: Language) => void;
}

const LANGUAGES: { code: Language; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'pl', label: 'PL' },
];

export function LanguageToggle({ language, onChange }: Props) {
  return (
    <div className="lang-toggle">
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          className={language === l.code ? 'active' : ''}
          onClick={() => onChange(l.code)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
