import type { SSRAuthState } from '../middleware/check-auth';
import { useI18n } from '../i18n-context';

export function LicensePage() {
    const { t } = useI18n();
    return (
        <article className="mx-auto max-w-4xl px-5 py-12 sm:py-16">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">Tattyhost</p>
            <h1 className="theme-text mt-2 text-3xl font-semibold">{t('MIT License')}</h1>
            <div className="theme-panel mt-8 space-y-5 rounded-2xl border p-6 text-sm leading-7 theme-muted sm:p-8">
                <p>Copyright 2022 blombler</p>
                <p>
                    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
                    associated documentation files (the “Software”), to deal in the Software without restriction,
                    including without limitation the rights to use, copy, modify, merge, publish, distribute,
                    sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
                    furnished to do so, subject to the following conditions:
                </p>
                <p>
                    The above copyright notice and this permission notice shall be included in all copies or
                    substantial portions of the Software.
                </p>
                <p>
                    THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
                    NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
                    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
                    DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
                    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
                </p>
            </div>
        </article>
    );
}

export function ImprintPage() {
    const { t } = useI18n();
    return (
        <article className="mx-auto max-w-4xl px-5 py-12 sm:py-16">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Rechtliches')}</p>
            <h1 className="theme-text mt-2 text-3xl font-semibold">{t('Impressum & Datenschutz')}</h1>

            <section className="theme-panel mt-8 rounded-2xl border p-6 sm:p-8">
                <h2 className="theme-text text-xl font-semibold">{t('Verantwortlich für diese Website')}</h2>
                <address className="mt-4 not-italic leading-7 theme-muted">
                    <span className="block">Schrade Tim</span>
                    <span className="block">Vor dem Hummelsholz 83</span>
                    <span className="block">78056 Villingen-Schwenningen, {t('Deutschland')}</span>
                    <span className="mt-2 block">
                        {t('E-Mail')}: <a className="text-sky-200 underline underline-offset-4" href="mailto:admin@tattyhost.com">admin@tattyhost.com</a>
                    </span>
                </address>
            </section>

            <section className="mt-8 space-y-6">
                <div>
                    <h2 className="theme-text text-xl font-semibold">{t('Datenschutzerklärung')}</h2>
                    <p className="mt-3 leading-7 theme-muted">
                        {t('Diese Website verarbeitet Daten, die für Betrieb und Kontoverwaltung erforderlich sind. Dazu gehören Benutzername, E-Mail-Adresse, ein gehashter Passwortwert, Profileinstellungen, Cloud- und Dateizugriffsberechtigungen, Sessiondaten sowie technische Login- und Sicherheitsereignisse.')}
                    </p>
                </div>
                <div>
                    <h3 className="theme-text font-semibold">{t('Konten, Sessions und Sicherheit')}</h3>
                    <p className="mt-2 leading-7 theme-muted">
                        {t('Bei einer Anmeldung werden eine Session-ID, IP-Adresse, Browserkennung und Ablaufzeit gespeichert. Das Anmelde-Cookie ist für die Kontofunktion erforderlich, HttpOnly und in Produktion auf sichere Verbindungen beschränkt. Passwörter werden nicht im Klartext gespeichert. Loginversuche und sicherheitsrelevante Kontoaktionen können protokolliert werden.')}
                    </p>
                </div>
                <div>
                    <h3 className="theme-text font-semibold">{t('Betriebs- und Änderungsprotokolle')}</h3>
                    <p className="mt-2 leading-7 theme-muted">
                        {t('Für den Betrieb werden HTTP-Methode, bereinigter Seitenpfad, Request-ID, Status und Dauer einer Anfrage sowie bei angemeldeten Konten eine interne Benutzer-ID protokolliert. Diese Betriebsprotokolle liegen auf dem Server in Logdateien und in der Datenbank und werden standardmäßig nach 90 Tagen gelöscht. Konto- und Adminänderungen werden zusätzlich mit einer internen Benutzer-ID in einem Auditprotokoll gespeichert. Passwörter, Cookies, Tokens, Anfrageinhalte und URL-Query-Strings werden nicht in diese Protokolle geschrieben. Loginversuche und Sessions speichern außerdem die IP-Adresse; Sessions speichern eine Browserkennung.')}
                    </p>
                </div>
                <div>
                    <h3 className="theme-text font-semibold">{t('Einstellungen und lokale Speicherung')}</h3>
                    <p className="mt-2 leading-7 theme-muted">
                        {t('Sprache, Zeitzone und Dark-Mode-Präferenz werden dem jeweiligen Benutzerkonto zugeordnet. Die Website speichert außerdem die Auswahl zum Cookie-Hinweis und die Darstellungseinstellung lokal im Browser.')}
                    </p>
                </div>
                <div>
                    <h3 className="theme-text font-semibold">{t('Deine Rechte und Kontakt')}</h3>
                    <p className="mt-2 leading-7 theme-muted">
                        {t('Für Fragen zu gespeicherten Kontodaten sowie für Auskunfts-, Berichtigungs- oder Löschungsanfragen kontaktiere bitte die oben genannte E-Mail-Adresse.')}
                    </p>
                </div>
                <aside className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-4 text-sm leading-6 text-amber-100/80">
                    {t('Bitte prüfe insbesondere Verantwortlichen-Angaben, Hosting, Speicherfristen und Rechtsgrundlagen vor Veröffentlichung. Diese technische Umsetzung ersetzt keine rechtliche Prüfung.')}
                </aside>
            </section>
        </article>
    );
}

type SitemapPageProps = {
    auth?: SSRAuthState;
};

export function SitemapPage({ auth }: SitemapPageProps) {
    const { t } = useI18n();
    const links = [
        { href: '/', label: t('Home') },
        { href: '/servers', label: t('Server') },
        { href: 'https://forum.tattyhost.com', label: t('Forum') },
        { href: '/login', label: t('Anmelden') },
        { href: '/about', label: t('Über mich') },
        { href: '/license', label: t('MIT License') },
        { href: '/impressum', label: t('Impressum & Datenschutz') },
        { href: '/sitemap', label: t('Sitemap') },
        ...(auth?.isLoggedIn ? [
            { href: '/downloads', label: t('Downloads') },
            { href: '/files', label: t('Dateien') }
        ] : []),
        ...(auth?.session?.role === 'admin' ? [{ href: '/admin', label: t('Admin Services') }] : [])
    ];

    return (
        <section className="mx-auto max-w-4xl px-5 py-12 sm:py-16">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">Tattyhost</p>
            <h1 className="theme-text mt-2 text-3xl font-semibold">{t('Sitemap')}</h1>
            <p className="mt-3 theme-muted">{t('Übersicht der verfügbaren Seiten.')}</p>
            <ul className="mt-8 grid gap-3 sm:grid-cols-2">
                {links.map((link) => (
                    <li key={link.href}>
                        <a className="theme-panel flex items-center justify-between rounded-xl border p-4 transition hover:border-sky-300/30" href={link.href}>
                            <span className="theme-text">{link.label}</span>
                            <span aria-hidden="true" className="text-sky-200">↗</span>
                        </a>
                    </li>
                ))}
            </ul>
        </section>
    );
}
