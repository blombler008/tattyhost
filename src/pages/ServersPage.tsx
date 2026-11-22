import { useServiceStatus } from '../hooks/use-service-status';
import { useI18n } from '../i18n-context';

const statusStyles = {
    online: {
        label: 'online',
        badge: 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/20',
        indicator: 'bg-emerald-300'
    },
    offline: {
        label: 'offline',
        badge: 'bg-rose-400/10 text-rose-300 ring-rose-400/20',
        indicator: 'bg-rose-300'
    },
    maintenance: {
        label: 'maintenance',
        badge: 'bg-amber-300/10 text-amber-200 ring-amber-300/20',
        indicator: 'bg-amber-300'
    }
} as const;

export default function ServersPage() {
    const { services, loading, error } = useServiceStatus();
    const { t } = useI18n();

    return (
        <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
            <div className="flex flex-wrap items-end justify-between gap-5">
                <div>
                    <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Tattyhost Netzwerk')}</p>
                    <h1 className="theme-text mt-2 text-3xl font-semibold sm:text-4xl">{t('Unsere Server')}</h1>
                    <p className="theme-muted mt-3 max-w-2xl">
                        {t('Hier findest du die Server-Adressen und ihren aktuellen Status. Die Anzeige wird live aktualisiert.')}
                    </p>
                </div>
                <a className="rounded-lg border px-4 py-2 text-sm theme-text transition hover:bg-white/5" href="/">
                    {t('Zur Startseite')}
                </a>
            </div>

            {loading ? (
                <p className="theme-muted mt-8 rounded-xl border p-5">{t('Serverstatus wird geladen...')}</p>
            ) : !error && !services.length ? (
                <p className="theme-muted mt-8 rounded-xl border p-5">{t('Aktuell sind keine Server konfiguriert.')}</p>
            ) : (
                <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {services.map((service) => {
                        const status = statusStyles[service.status];
                        return (
                            <article key={service.id} className="theme-panel flex min-h-56 flex-col rounded-2xl border p-6 shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:border-sky-300/25">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-sky-200">{t('Server')}</p>
                                        <h2 className="theme-text mt-2 text-xl font-semibold">{t(service.name)}</h2>
                                    </div>
                                    <span className={`inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${status.badge}`}>
                                        <span className={`h-2 w-2 rounded-full ${status.indicator}`} aria-hidden="true" />
                                        {status.label === 'maintenance' ? t('Wartung') : status.label === 'online' ? t('Online') : t('Offline')}
                                    </span>
                                </div>

                                <div className="mt-6 border-t border-[var(--theme-border)] pt-4">
                                    <p className="theme-muted text-xs">{t('Server-Adresse')}</p>
                                    <p className="mt-1 break-all font-mono text-sm text-sky-200">{service.address}</p>
                                    {service.details && <p className="theme-muted mt-3 text-sm leading-6">{t(service.details)}</p>}
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}

            <p className="theme-muted mt-6 text-xs">{t('Live-Status · Push-Aktualisierung')}</p>
        </section>
    );
}
