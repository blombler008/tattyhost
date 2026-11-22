import { createContext, useContext } from 'react';
import type { NotificationType } from './components/Notification';

type ToastContextValue = {
    toast: (message: string, type?: NotificationType, values?: Record<string, string | number>) => void;
};

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) throw new Error('useToast must be used within ToastProvider');
    return context;
}

export function queueToastForNextPage(messageKey: string) {
    try {
        sessionStorage.setItem('tattyhost-pending-toast', messageKey);
    } catch (error) {
        console.error('Could not queue notification for the next page:', error);
    }
}
