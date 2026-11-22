import { useEffect, useRef, useState } from 'react';
import { useToast } from '../toast-context';
import { useI18n } from '../i18n-context';

export type Service = {
    id: number;
    name: string;
    address: string;
    status: 'online' | 'offline' | 'maintenance';
    details: string;
};

export function useServiceStatus() {
    const { toast } = useToast();
    const { t } = useI18n();
    const [services, setServices] = useState<Service[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const lastNotifiedError = useRef('');

    useEffect(() => {
        let cancelled = false;
        const eventSource = new EventSource('/api/services/events');

        const reportError = (message: string) => {
            if (cancelled) return;
            setError(message);
            setLoading(false);
            if (message !== lastNotifiedError.current) {
                lastNotifiedError.current = message;
                toast(message, 'error');
            }
        };

        eventSource.addEventListener('services', (event) => {
            if (cancelled) return;
            try {
                const data = JSON.parse((event as MessageEvent<string>).data) as { services?: Service[] };
                const incomingServices = data.services;
                if (!Array.isArray(incomingServices)) {
                    throw new Error(t('Ungültige Serverstatus-Antwort'));
                }
                setServices((current) => (
                    JSON.stringify(current) === JSON.stringify(incomingServices) ? current : incomingServices
                ));
                setError('');
                lastNotifiedError.current = '';
            } catch (loadError) {
                reportError(loadError instanceof Error ? loadError.message : t('Serverstatus konnte nicht geladen werden'));
            } finally {
                setLoading(false);
            }
        });

        eventSource.onerror = () => {
            reportError(t('Live-Verbindung zum Serverstatus unterbrochen; erneuter Verbindungsversuch läuft'));
        };

        return () => {
            cancelled = true;
            eventSource.close();
        };
    }, [t, toast]);

    return { services, loading, error };
}
