import { useEffect, useState } from 'react';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';

type Download = {
    id: number;
    title: string;
    description: string | null;
    url: string;
    created_at: string;
};

export default function DownloadsPage() {
    const { t } = useI18n();
    const { toast } = useToast();
    const [downloads, setDownloads] = useState<Download[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        async function loadDownloads() {
            try {
                const response = await fetch('/api/downloads', { credentials: 'include' });
                const data = await response.json() as { success: boolean; error?: string; downloads?: Download[] };
                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Downloads konnten nicht geladen werden');
                }
                if (!cancelled) setDownloads(data.downloads || []);
            } catch (loadError) {
                if (!cancelled) {
                    const message = loadError instanceof Error ? loadError.message : 'Downloads konnten nicht geladen werden';
                    setError(message);
                    toast(message, 'error');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        void loadDownloads();
        return () => {
            cancelled = true;
        };
    }, [toast]);

    return (
        <section className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Mitgliederbereich')}</p>
            <h1 className="theme-text mt-2 text-3xl font-semibold">{t('Downloads')}</h1>
            <p className="theme-muted mt-3">{t('Dateien und Ressourcen für die Tattyhost-Community.')}</p>
            {loading ? (
                <p className="theme-muted mt-8">{t('Downloads werden geladen...')}</p>
            ) : downloads.length ? (
                <ul className="mt-8 grid gap-4 sm:grid-cols-2">
                    {downloads.map((download) => (
                        <li key={download.id} className="theme-panel rounded-2xl border p-5">
                            <h2 className="theme-text text-lg font-semibold">{t(download.title)}</h2>
                            {download.description && <p className="theme-muted mt-2 text-sm leading-6">{t(download.description)}</p>}
                            <a
                                className="mt-5 inline-flex rounded-lg bg-sky-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-200"
                                href={download.url}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {t('Herunterladen')}
                            </a>
                        </li>
                    ))}
                </ul>
            ) : !error ? (
                <p className="theme-panel theme-muted mt-8 rounded-xl border p-5">{t('Aktuell sind keine Downloads verfügbar.')}</p>
            ) : null}
        </section>
    );
}
