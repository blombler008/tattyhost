import { useCallback, useEffect, useRef, useState } from 'react';
import Notification, { type NotificationItem, type NotificationType } from './Notification';
import { ToastContext } from '../toast-context';
import { useI18n } from '../i18n-context';

export default function ToastProvider({ children }: { children: React.ReactNode }) {
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const nextId = useRef(0);
    const { ready } = useI18n();

    const toast = useCallback((message: string, type: NotificationType = 'info', values?: Record<string, string | number>) => {
        nextId.current += 1;
        const notification = { id: nextId.current, message, type, values };
        setNotifications((current) => [...current, notification].slice(-5));
    }, []);

    const removeToast = useCallback((id: number) => {
        setNotifications((current) => current.filter((notification) => notification.id !== id));
    }, []);

    useEffect(() => {
        if (!ready) return;
        try {
            const pending = sessionStorage.getItem('tattyhost-pending-toast');
            if (!pending) return;
            sessionStorage.removeItem('tattyhost-pending-toast');
            toast(pending, 'success');
        } catch (error) {
            console.error('Could not read the notification queued for the next page:', error);
        }
    }, [ready, toast]);

    return (
        <ToastContext.Provider value={{ toast }}>
            {children}
            <Notification notifications={notifications} onRemove={removeToast} />
        </ToastContext.Provider>
    );
}
