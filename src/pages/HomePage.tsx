import serverIcon from '../assets/material-icons/web-server.svg';
import { useServiceStatus, type Service } from '../hooks/use-service-status';
import { useI18n } from '../i18n-context';

function getStatusClass(status: Service['status']) {
    if (status === 'online') return 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/20';
    if (status === 'offline') return 'bg-rose-400/10 text-rose-300 ring-rose-400/20';
    return 'bg-amber-300/10 text-amber-200 ring-amber-300/20';
}

export default function HomePage() {
    const { services, loading: servicesLoading, error: servicesError } = useServiceStatus();
    const { t } = useI18n();

    return (
        <div className="overflow-hidden">
            <section className="relative mx-auto max-w-6xl px-5 pb-16 pt-16 sm:px-8 sm:pb-24 sm:pt-24">
                <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-sky-500/10 blur-3xl" />
                <div className="relative grid items-center gap-12 lg:grid-cols-[1.15fr_0.85fr]">
                    <div>
                        <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-300/5 px-3 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-sky-200">
                            {t('Willkommen im Netzwerk')}
                        </p>
                        <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight text-white sm:text-6xl">
                            {t('Zusammen spielen.')}
                            <span className="block text-sky-300">{t('Zusammen zuhause.')}</span>
                        </h1>
                        <p className="mt-6 max-w-xl text-base leading-7 text-slate-400 sm:text-lg">
                            {t('Willkommen auf dem Tattyhost Netzwerk — ein kleiner Treffpunkt für unsere Community. Such dir deinen Server aus und schau bei uns vorbei.')}
                        </p>
                        <div className="mt-8 flex flex-wrap gap-3">
                            <a
                                className="rounded-xl bg-sky-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200"
                                href="https://discord.gg/NpEN6h3tTp"
                                target="_blank"
                                rel="noreferrer"
                            >
                                {t('Discord beitreten')}
                            </a>
                            <a className="rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/30 hover:bg-white/5" href="/servers">
                                {t('Server entdecken')}
                            </a>
                        </div>
                    </div>

                    <div className="theme-panel relative rounded-3xl border p-6 shadow-2xl shadow-black/40 sm:p-8">
                        <div className="mb-6 flex items-start justify-between gap-4">
                            <div>
                                <p className="text-sm theme-muted">{t('Dein nächstes Abenteuer')}</p>
                                <h2 className="mt-1 text-2xl font-semibold text-white">{t('Tattyhost Netzwerk')}</h2>
                            </div>
                            <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-2xl bg-sky-300/10">
                                <img className="material-icon h-6 w-6" src={serverIcon} alt="" />
                            </span>
                        </div>
                        <div className="space-y-3">
                            {servicesLoading ? (
                                <p className="theme-muted rounded-2xl border p-4">{t('Serverstatus wird geladen...')}</p>
                            ) : (
                                <>
                                    {services.map((service) => (
                                        <article key={service.id} className="theme-surface rounded-2xl border p-4">
                                            <div className="flex flex-wrap items-center justify-between gap-3">
                                                <h3 className="font-semibold text-white">{t(service.name)}</h3>
                                                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${getStatusClass(service.status)}`}>
                                                    {service.status === 'maintenance' ? t('Wartung') : service.status === 'online' ? t('Online') : t('Offline')}
                                                </span>
                                            </div>
                                            <p className="mt-3 font-mono text-sm text-sky-200">{service.address}</p>
                                            {service.details && <p className="mt-1 text-xs text-slate-500">{t(service.details)}</p>}
                                            {service.status === 'online' &&
                                                (service.playersOnline !== null || service.minecraftVersion) && (
                                                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
                                                    {service.playersOnline !== null && service.playersMax !== null && (
                                                        <span>{t('Spieler')}: {service.playersOnline} / {service.playersMax}</span>
                                                    )}
                                                    {service.minecraftVersion && (
                                                        <span>{t('Minecraft-Version')}: {service.minecraftVersion}</span>
                                                    )}
                                                </div>
                                            )}
                                        </article>
                                    ))}
                                </>
                            )}
                            {!servicesLoading && !servicesError && !services.length && (
                                <p className="theme-muted rounded-2xl border p-4">{t('Aktuell sind keine Services hinterlegt.')}</p>
                            )}
                        </div>
                        <p className="mt-4 text-xs leading-5 theme-muted">
                            {t('Der Status aktualisiert sich automatisch. Ohne Servermeldung seit 90 Sekunden wird der Dienst als offline angezeigt.')}
                        </p>
                    </div>
                </div>
            </section>

            <section className="theme-subsection border-y">
                <div className="mx-auto grid max-w-6xl gap-6 px-5 py-10 sm:grid-cols-3 sm:px-8 sm:py-12">
                    <div>
                        <p className="text-sm font-medium text-sky-200">{t('01 / Spielen')}</p>
                        <h2 className="mt-2 text-lg font-semibold text-white">{t('Verbinde dich')}</h2>
                        <p className="mt-2 text-sm leading-6 theme-muted">{t('Nutze die Server-Adresse und komm direkt ins Netzwerk.')}</p>
                    </div>
                    <div>
                        <p className="text-sm font-medium text-sky-200">{t('02 / Treffen')}</p>
                        <h2 className="mt-2 text-lg font-semibold text-white">{t('Finde die Community')}</h2>
                        <p className="mt-2 text-sm leading-6 theme-muted">{t('Im Discord gibt es Neuigkeiten und einen Platz zum Chatten.')}</p>
                    </div>
                    <div>
                        <p className="text-sm font-medium text-sky-200">{t('03 / Mitmachen')}</p>
                        <h2 className="mt-2 text-lg font-semibold text-white">{t('Bis bald auf dem Server')}</h2>
                        <p className="mt-2 text-sm leading-6 theme-muted">{t('Wir freuen uns, wenn du vorbeischaust.')}</p>
                    </div>
                </div>
            </section>
        </div>
    );
}
