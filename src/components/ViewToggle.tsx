import { t } from '../i18n/labels';
import type { Language } from '../types/warscroll';

export type AppView = 'warscrolls' | 'rivals';

interface Props {
  view: AppView;
  onChange: (view: AppView) => void;
  language: Language;
}

const VIEWS: { value: AppView; labelKey: string }[] = [
  { value: 'warscrolls', labelKey: 'viewWarscrolls' },
  { value: 'rivals', labelKey: 'viewRivals' },
];

export function ViewToggle({ view, onChange, language }: Props) {
  return (
    <div className="view-toggle">
      {VIEWS.map((item) => (
        <button
          key={item.value}
          className={view === item.value ? 'active' : ''}
          onClick={() => onChange(item.value)}
        >
          {t(item.labelKey, language)}
        </button>
      ))}
    </div>
  );
}
