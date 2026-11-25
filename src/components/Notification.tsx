import Button from './Button';
import { useEffect } from 'react';
import closeIcon from '../assets/material-icons/close-button.svg';
import { useI18n } from '../i18n-context';
export type NotificationType = 'success' | 'error' | 'info';

export type NotificationItem = {
    id: number;
    message: string;
    type?: NotificationType;
    values?: Record<string, string | number>;
};

type NotificationProps = {
    notifications: NotificationItem[];
    onRemove: (id: number) => void;
    duration?: number;
};

function ToastItem({ notification, onRemove, duration }: {
    notification: NotificationItem;
    onRemove: (id: number) => void;
    duration: number;
}) {
    const { t } = useI18n();

    useEffect(() => {
        const timeout = window.setTimeout(() => onRemove(notification.id), duration);
        return () => window.clearTimeout(timeout);
    }, [duration, notification.id, onRemove]);

    const { id, message, type = 'info', values } = notification;
    const typeStyle = {
        success: 'border-emerald-400/30 bg-emerald-950 text-emerald-50',
        error: 'border-rose-400/30 bg-rose-950 text-rose-50',
        info: 'border-sky-400/30 bg-slate-900 text-slate-50'
    }[type];

    return (
        <div
            className={`flex items-start justify-between gap-4 rounded-xl border px-4 py-3 text-sm shadow-xl shadow-black/25 ${typeStyle}`}
            role={type === 'error' ? 'alert' : 'status'}
        >
            <span>{t(message, values)}</span>
            <Button
                onClick={() => onRemove(id)} variant="icon" className="shrink-0 text-white/80"
                aria-label={t('Schließen')}
            >
                <img src={closeIcon} alt="" className="material-icon h-4 w-4 cursor-pointer" />
            </Button>
        </div>
    );
}

export default function Notification({ notifications, onRemove, duration = 4500 }: NotificationProps) {
    return (
        <div className="fixed inset-x-4 top-4 z-[100] ml-auto flex max-w-sm flex-col gap-2" aria-live="polite">
            {notifications.map((notification) => (
                <ToastItem
                    key={notification.id}
                    notification={notification}
                    onRemove={onRemove}
                    duration={duration}
                />
            ))}
        </div>
    );
}
