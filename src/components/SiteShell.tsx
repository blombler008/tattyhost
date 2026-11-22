import { useEffect, useState } from 'react';
import logo from '../assets/logos/logo3.svg';
import settingsIcon from '../assets/material-icons/settings-cogwheel-button.svg';
import sunIcon from '../assets/material-icons/shining-sun.svg';
import themeIcon from '../assets/material-icons/invert-colors-button.svg';
import menuIcon from '../assets/material-icons/menu-button.svg';
import closeIcon from '../assets/material-icons/close-button.svg';
import { useI18n } from '../i18n-context';
import { queueToastForNextPage, useToast } from '../toast-context';

type SiteShellProps = {
    children: React.ReactNode;
    activePage?: 'home' | 'servers' | 'login' | 'downloads' | 'files' | 'admin' | 'settings';
    auth?: {
        isLoggedIn: boolean;
        session: { role: string } | null;
    };
};

function CookieNotice() {
    const { t } = useI18n();
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        setVisible(localStorage.getItem('tattyhost-cookie-choice') === null);
    }, []);

    const dismiss = () => {
        localStorage.setItem('tattyhost-cookie-choice', 'seen');
        setVisible(false);
    };

    if (!visible) return null;

    return (
        <aside className="theme-panel fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-2xl border p-5 shadow-2xl shadow-black/50 sm:inset-x-6 sm:flex sm:items-center sm:gap-6">
            <div className="flex-1">
                <h2 className="text-lg font-semibold theme-text">{t('Cookies')}</h2>
                <p className="mt-1 text-sm leading-6 theme-muted">
                    {t('Für die Anmeldung wird ein technisch notwendiges Cookie verwendet. Diese Website verwendet keine optionalen Tracking-Cookies.')}{' '}
                    <a className="text-sky-300 underline underline-offset-4 hover:text-sky-200" href="/impressum">
                        {t('Datenschutz')}
                    </a>
                </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 sm:mt-0">
                <button
                    className="rounded-lg bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-300"
                    onClick={dismiss}
                >
                    {t('Verstanden')}
                </button>
            </div>
        </aside>
    );
}

export default function SiteShell({ children, activePage, auth }: SiteShellProps) {
    const { language, darkMode, t, setLanguage, savePreferences } = useI18n();
    const { toast } = useToast();
    const [menuOpen, setMenuOpen] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const [hasCloudAccess, setHasCloudAccess] = useState(false);
    const [hasFileAccess, setHasFileAccess] = useState(false);
    const isLoggedIn = auth?.isLoggedIn ?? false;

    useEffect(() => {
        if (!isLoggedIn) {
            setHasCloudAccess(false);
            setHasFileAccess(false);
            return;
        }

        let cancelled = false;
        let requestInFlight = false;
        async function loadAccountAccess() {
            if (requestInFlight) return;
            requestInFlight = true;
            try {
                const response = await fetch('/api/account', { credentials: 'include' });
                const data = await response.json() as {
                    success: boolean;
                    account?: { hasCloudAccess: boolean; hasFileAccess: boolean };
                    error?: string;
                };
                if (!response.ok || !data.success || !data.account) {
                    throw new Error(data.error || 'Kontoberechtigungen konnten nicht geprüft werden');
                }
                if (!cancelled) {
                    setHasCloudAccess(data.account.hasCloudAccess);
                    setHasFileAccess(data.account.hasFileAccess);
                }
            } catch (error) {
                if (!cancelled) {
                    setHasCloudAccess(false);
                    setHasFileAccess(false);
                    console.error('Loading account access failed:', error);
                }
            } finally {
                requestInFlight = false;
            }
        }

        void loadAccountAccess();
        const interval = window.setInterval(() => void loadAccountAccess(), 30_000);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [isLoggedIn]);

    const logout = async () => {
        setLoggingOut(true);
        try {
            const response = await fetch('/api/logout', {
                method: 'POST',
                credentials: 'include'
            });
            const data = await response.json();
            if (!data.success) {
                toast(data.error || 'Abmelden fehlgeschlagen', 'error');
                setLoggingOut(false);
                return;
            }
            queueToastForNextPage('Abmeldung erfolgreich');
            window.location.assign('/');
        } catch {
            toast('Verbindung zum Server fehlgeschlagen', 'error');
            setLoggingOut(false);
        }
    };

    const updateLanguage = async (value: string) => {
        const nextLanguage = value === 'en' ? 'en' : 'de';
        setLanguage(nextLanguage);
        if (!isLoggedIn) return;
        try {
            await savePreferences({ language: nextLanguage });
        } catch (error) {
            toast(error instanceof Error ? error.message : 'Spracheinstellung konnte nicht gespeichert werden', 'error');
        }
    };

    const updateTheme = async () => {
        const nextDarkMode = !darkMode;
        try {
            await savePreferences({ darkMode: nextDarkMode });
        } catch (error) {
            toast(error instanceof Error ? error.message : 'Darstellung konnte nicht gespeichert werden', 'error');
        }
    };

    return (
        <div className="theme-shell flex min-h-screen flex-col">
            <header className="theme-header relative z-10 border-b">
                <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
                    <a className="flex items-center gap-3" href="/" aria-label={t('Tattyhost Startseite')}>
                        <img className="h-10 w-10 rounded-xl" src={logo} alt="" />
                        <span className="theme-text hidden text-lg font-semibold tracking-tight sm:inline">Tattyhost</span>
                    </a>
                    <div className="flex items-center gap-2">
                        {!isLoggedIn && (
                            <>
                                <label className="sr-only" htmlFor="site-language">{t('Sprache')}</label>
                                <select
                                    id="site-language"
                                    className="theme-input rounded-lg border px-2 py-2 text-xs font-semibold"
                                    value={language}
                                    onChange={(event) => void updateLanguage(event.target.value)}
                                    aria-label={t('Sprache')}
                                >
                                    <option value="de">DE</option>
                                    <option value="en">EN</option>
                                </select>
                                <button
                                    className="theme-text grid h-9 w-9 place-items-center rounded-lg border transition hover:bg-white/10"
                                    type="button"
                                    onClick={() => void updateTheme()}
                                    aria-label={t(darkMode ? 'Zum Hellmodus wechseln' : 'Zum Dunkelmodus wechseln')}
                                    title={t(darkMode ? 'Hell' : 'Dunkel')}
                                >
                                    <img className="material-icon h-5 w-5" src={darkMode ? sunIcon : themeIcon} alt="" />
                                </button>
                            </>
                        )}
                        <nav
                            aria-label={t('Hauptnavigation')}
                            className={`${menuOpen ? 'theme-menu absolute left-0 right-0 top-full flex flex-col border-b p-4 shadow-xl sm:static sm:flex-row sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none' : 'hidden sm:flex'} items-stretch gap-1 sm:items-center sm:gap-1`}
                        >
                            <a className={`rounded-lg px-3 py-2 text-sm transition hover:bg-white/5 hover:text-white ${activePage === 'home' ? 'text-white' : 'text-zinc-400'}`} href="/">
                                {t('Home')}
                            </a>
                            <a className={`rounded-lg px-3 py-2 text-sm transition hover:bg-white/5 hover:text-white ${activePage === 'servers' ? 'text-white' : 'text-zinc-400'}`} href="/servers">
                                {t('Server')}
                            </a>
                            {!isLoggedIn && (
                                <a className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/5 hover:text-white" href="/about">
                                    {t('Über mich')}
                                </a>
                            )}
                            <a className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/5 hover:text-white" href="https://forum.tattyhost.com">
                                {t('Forum')}
                            </a>
                            {isLoggedIn && hasCloudAccess && (
                                <a className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/5 hover:text-white" href="https://cloud.tattyhost.com">
                                    {t('Cloud')}
                                </a>
                            )}
                            {isLoggedIn && (
                                <a className={`rounded-lg px-3 py-2 text-sm transition hover:bg-white/5 hover:text-white ${activePage === 'downloads' ? 'bg-white/5 text-white' : 'text-zinc-400'}`} href="/downloads">
                                    {t('Downloads')}
                                </a>
                            )}
                        </nav>
                        {isLoggedIn ? (
                            <div className="relative sm:ml-3">
                                <button
                                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition hover:bg-white/10 ${activePage === 'settings' ? 'border-sky-300/40 bg-white/10 text-white' : 'border-white/10 bg-white/[0.06] text-white'}`}
                                    type="button"
                                    aria-haspopup="menu"
                                    aria-expanded={profileOpen}
                                    onClick={() => setProfileOpen((open) => !open)}
                                >
                                    <img className="material-icon h-5 w-5" src={settingsIcon} alt="" />
                                    <span>{t('Profil')}</span>
                                </button>
                                {profileOpen && (
                                    <div className="theme-panel absolute right-0 top-full z-30 mt-2 w-52 rounded-xl border p-1.5 shadow-2xl shadow-black/50" role="menu">
                                        {hasFileAccess && (
                                            <a
                                                className={`block rounded-lg px-3 py-2.5 text-sm transition hover:bg-white/5 hover:text-white ${activePage === 'files' ? 'bg-white/5 text-white' : 'text-zinc-300'}`}
                                                href="/files"
                                                role="menuitem"
                                            >
                                                {t('Dateien')}
                                            </a>
                                        )}
                                        <a
                                            className="block rounded-lg px-3 py-2.5 text-sm text-zinc-300 transition hover:bg-white/5 hover:text-white"
                                            href="/settings"
                                            role="menuitem"
                                        >
                                            {t('Profil-Einstellungen')}
                                        </a>
                                        {auth?.session?.role === 'admin' && (
                                            <a
                                                className="block rounded-lg px-3 py-2.5 text-sm text-zinc-300 transition hover:bg-white/5 hover:text-white"
                                                href="/admin"
                                                role="menuitem"
                                            >
                                                {t('Admin Services')}
                                            </a>
                                        )}
                                        <div className="my-1 border-t border-white/[0.08]" />
                                        <button
                                            className="w-full rounded-lg px-3 py-2.5 text-left text-sm text-rose-300 transition hover:bg-rose-400/10 disabled:opacity-60"
                                            type="button"
                                            onClick={logout}
                                            disabled={loggingOut}
                                            role="menuitem"
                                        >
                                            {loggingOut ? t('Abmelden...') : t('Logout')}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <a
                                className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${activePage === 'login' ? 'bg-sky-300 text-black' : 'bg-white/[0.06] text-white hover:bg-white/10'}`}
                                href="/login"
                            >
                                {t('Anmelden')}
                            </a>
                        )}
                        <button
                            className="grid h-10 w-10 place-items-center rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 sm:hidden"
                            type="button"
                            aria-label={t(menuOpen ? 'Menü schließen' : 'Menü öffnen')}
                            aria-expanded={menuOpen}
                            onClick={() => setMenuOpen((open) => !open)}
                        >
                            <img className="material-icon h-5 w-5" src={menuOpen ? closeIcon : menuIcon} alt="" />
                        </button>
                    </div>
                </div>
            </header>

            <main className="flex-1">{children}</main>

            <footer className="theme-header border-t">
                <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 sm:grid-cols-2 sm:px-8">
                    <div>
                        <h2 className="theme-text font-semibold">Tattyhost</h2>
                        <p className="mt-2 max-w-md text-sm leading-6 theme-muted">
                            {t('Kleine, feine Seite für das Tattyhost Netzwerk.')}
                        </p>
                    </div>
                    <div className="sm:text-right">
                        <h2 className="theme-text font-semibold">{t('Links')}</h2>
                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm theme-muted sm:justify-end">
                            <a className="transition hover:text-white" href="https://discord.gg/NpEN6h3tTp">Discord</a>
                            <a className="transition hover:text-white" href="/license">{t('Lizenz')}</a>
                            <a className="transition hover:text-white" href="/impressum">{t('Impressum')}</a>
                            <a className="transition hover:text-white" href="/sitemap">{t('Sitemap')}</a>
                        </div>
                    </div>
                </div>
                <div className="theme-header flex flex-wrap justify-center gap-2 border-t px-5 py-4 text-center text-xs theme-muted">
                    <span>© 2022</span>
                    <a className="transition hover:text-white" href="/license">{t('MIT License')}</a>
                    <span aria-hidden="true">|</span>
                    <a className="transition hover:text-white" href="/impressum">{t('Impressum')}</a>
                </div>
            </footer>
            <CookieNotice />
        </div>
    );
}
