import { Phone } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';

/** Product lockup used in every top bar. Wordmark hides on tiny screens. */
export function Brand() {
  const { t } = useI18n();
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <Phone size={19} strokeWidth={2.4} />
      </span>
      <span className="brand-word">{t('app.name')}</span>
    </div>
  );
}
