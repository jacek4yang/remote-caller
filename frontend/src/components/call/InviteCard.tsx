import { Copy, Share2, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useI18n } from '../../i18n/I18nProvider';

interface InviteCardProps {
  room: string;
  shareSupported: boolean;
  onCopy: () => void;
  onNativeShare: () => void;
  onDismiss: () => void;
}

/** One-tap invite for the waiting creator. */
export function InviteCard({ room, shareSupported, onCopy, onNativeShare, onDismiss }: InviteCardProps) {
  const { t } = useI18n();
  return (
    <div className="invite-card" role="region" aria-label={t('call.inviteTitle')}>
      <button type="button" className="invite-close" aria-label={t('common.close')} onClick={onDismiss}>
        <X size={15} aria-hidden="true" />
      </button>
      <p className="invite-eyebrow">{t('call.inviteTitle')}</p>
      <p className="invite-body">{t('call.inviteBody')}</p>
      <div className="invite-actions">
        <Button variant="primary" onClick={onCopy}>
          <Copy size={16} aria-hidden="true" />
          {t('call.copyInvite')}
        </Button>
        {shareSupported ? (
          <Button variant="secondary" onClick={onNativeShare}>
            <Share2 size={16} aria-hidden="true" />
            {t('common.share')}
          </Button>
        ) : null}
      </div>
      <p className="invite-code-row">
        <span className="visually-hidden">{t('call.roomCode')}: </span>
        <code className="invite-code">{room}</code>
        <Button variant="ghost" size="sm" onClick={onCopy} style={{ minHeight: 30, paddingInline: 10 }}>
          <Copy size={13} aria-hidden="true" />
          {t('common.copy')}
        </Button>
      </p>
    </div>
  );
}
