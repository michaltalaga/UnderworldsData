import { t } from '../i18n/labels';
import type { Language } from '../types/warscroll';
import { viewHref, type AppView } from '../routing';

interface Props {
  view: AppView;
  language: Language;
}

const VIEWS: { value: AppView; labelKey: string }[] = [
  { value: 'warscrolls', labelKey: 'viewWarscrolls' },
  { value: 'rivals', labelKey: 'viewRivals' },
  { value: 'overview', labelKey: 'viewOverview' },
];

export function ViewToggle({ view, language }: Props) {
  return (
    <div className="view-toggle">
      {VIEWS.map((item) => (
        <a
          key={item.value}
          href={viewHref(item.value)}
          className={view === item.value ? 'active' : ''}
          aria-current={view === item.value ? 'page' : undefined}
        >
          {t(item.labelKey, language)}
        </a>
      ))}
    </div>
  );
}
