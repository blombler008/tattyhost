import { useState } from 'react';
import Button, { ButtonLink } from './components/Button';
import SiteShell from './components/SiteShell';
import { queueToastForNextPage, useToast } from './toast-context';
import ToastProvider from './components/ToastProvider';
import HomePage from './pages/HomePage';
import ServersPage from './pages/ServersPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import UserSettingsPage from './pages/UserSettingsPage';
import AdminPage from './pages/AdminPage';
import DownloadsPage from './pages/DownloadsPage';
import FilesPage from './pages/FilesPage';
import { ImprintPage, LicensePage, SitemapPage } from './pages/LegalPages';
import type { SSRAuthState } from './middleware/check-auth';
import { I18nProvider } from './i18n';
import { useI18n } from './i18n-context';

type AppProps = {
    ssrAuth?: SSRAuthState;
    pathname?: string;
};

type CountProps = {
    counter: number;
};

export function Counter({ counter }: CountProps) {
    const { t } = useI18n();
    const [count, setCount] = useState(counter || 0);
    return <Button onClick={() => setCount((previous) => previous + 1)}>{t('Count is {count}', { count })}</Button>;
}

function LoginPage() {
    const { t } = useI18n();
    const { toast } = useToast();
    const [mode, setMode] = useState<'login' | 'register'>('login');
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const submitAuth = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSubmitting(true);

        let data: { success: boolean; error?: string };
        try {
            const response = await fetch(mode === 'login' ? '/api/login' : '/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(mode === 'login'
                    ? { username, password }
                    : { username, email, password })
            });
            data = await response.json();
        } catch {
            toast('Verbindung zum Server fehlgeschlagen', 'error');
            setSubmitting(false);
            return;
        }

        if (data.success) {
            if (mode === 'register') {
                toast('Account erfolgreich erstellt', 'success');
                setMode('login');
                setPassword('');
            } else {
                queueToastForNextPage('Anmeldung erfolgreich');
                window.location.assign('/');
                return;
            }
        } else {
            toast(mode === 'login' ? 'Login fehlgeschlagen: {error}' : 'Registrierung fehlgeschlagen: {error}', 'error', {
                error: data.error || 'Die Anfrage ist fehlgeschlagen'
            });
        }
        setSubmitting(false);
    };

    return (
        <section className="mx-auto max-w-md px-5 py-16 sm:py-24">
            <form className="theme-panel rounded-3xl border p-6 sm:p-8" onSubmit={submitAuth}>
                <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Tattyhost Konto')}</p>
                <h1 className="theme-text mb-6 mt-2 text-3xl font-semibold">
                    {mode === 'login' ? t('Anmelden') : t('Account erstellen')}
                </h1>
                <label className="mb-4 block">
                    <span className="theme-muted mb-1 block text-sm">{t('Benutzername oder E-Mail')}</span>
                    <input
                        className="theme-surface w-full rounded-xl border px-3 py-3 outline-none focus:border-sky-300"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="username"
                        required
                    />
                </label>
                {mode === 'register' && (
                    <label className="mb-4 block">
                        <span className="theme-muted mb-1 block text-sm">{t('E-Mail')}</span>
                        <input
                            className="theme-surface w-full rounded-xl border px-3 py-3 outline-none focus:border-sky-300"
                            type="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            autoComplete="email"
                            required
                        />
                    </label>
                )}
                <label className="mb-6 block">
                    <span className="theme-muted mb-1 block text-sm">{t('Passwort')}</span>
                    <input
                        className="theme-surface w-full rounded-xl border px-3 py-3 outline-none focus:border-sky-300"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                        minLength={mode === 'register' ? 8 : undefined}
                        required
                    />
                </label>
                <Button variant="primary" className="w-full"
                    type="submit"
                    disabled={submitting}
                >
                    {submitting ? t('Bitte warten...') : mode === 'login' ? t('Anmelden') : t('Registrieren')}
                </Button>
                <Button variant="ghost" className="mt-4 w-full"
                    type="button"
                    onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
                >
                    {mode === 'login' ? t('Noch kein Account? Registrieren') : t('Bereits Account? Anmelden')}
                </Button>
            </form>
        </section>
    );
}

function ComingSoonPage({ pathname }: { pathname: string }) {
    const { t } = useI18n();
    const pageNames: Record<string, string> = {
        '/about': 'Über mich',
        '/settings': 'Profil-Einstellungen'
    };
    const pageName = t(pageNames[pathname] || 'Seite nicht gefunden');

    return (
        <section className="mx-auto max-w-3xl px-5 py-20 text-center sm:py-28">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">Tattyhost</p>
            <h1 className="theme-text mt-3 text-3xl font-semibold">{pageName}</h1>
            <p className="theme-muted mt-4">{t('Diese Seite bauen wir als Nächstes. Schau dich inzwischen auf der Startseite um.')}</p>
            <ButtonLink variant="primary" className="mt-7" href="/">
                {t('Zur Startseite')}
            </ButtonLink>
        </section>
    );
}

function AppContent({ ssrAuth, pathname = '/' }: AppProps) {
    const { t } = useI18n();
    const currentPath = pathname.replace(/\/+$/, '') || '/';
    const activePage = currentPath === '/login' ? 'login'
        : currentPath === '/' ? 'home'
            : currentPath === '/servers' ? 'servers'
            : currentPath === '/downloads' ? 'downloads'
                : currentPath === '/files' ? 'files'
                : currentPath === '/admin' ? 'admin'
                    : currentPath === '/settings' ? 'settings'
                        : undefined;

    let page;
    if (currentPath === '/') {
        page = <HomePage />;
    } else if (currentPath === '/servers') {
        page = <ServersPage auth={ssrAuth} />;
    } else if (currentPath === '/reset-password') {
        page = <ResetPasswordPage />;
    } else if (currentPath === '/login') {
        page = ssrAuth?.isLoggedIn
            ? <section className="mx-auto max-w-xl px-5 py-20 text-center"><h1 className="theme-text text-2xl font-semibold">{t('Du bist bereits angemeldet.')}</h1><a className="mt-5 inline-block text-sky-200 underline" href="/">{t('Zur Startseite')}</a></section>
            : <LoginPage />;
    } else if (currentPath === '/downloads' && !ssrAuth?.isLoggedIn) {
        page = <section className="mx-auto max-w-xl px-5 py-20 text-center"><h1 className="theme-text text-2xl font-semibold">{t('Anmeldung erforderlich')}</h1><p className="theme-muted mt-3">{t('Melde dich an, um auf Downloads zuzugreifen.')}</p><a className="mt-5 inline-block text-sky-200 underline" href="/login">{t('Zum Login')}</a></section>;
    } else if (currentPath === '/files' && !ssrAuth?.isLoggedIn) {
        page = <section className="mx-auto max-w-xl px-5 py-20 text-center"><h1 className="theme-text text-2xl font-semibold">{t('Anmeldung erforderlich')}</h1><p className="theme-muted mt-3">{t('Melde dich an, um auf Dateien zuzugreifen.')}</p><a className="mt-5 inline-block text-sky-200 underline" href="/login">{t('Zum Login')}</a></section>;
    } else if (currentPath === '/admin' && !ssrAuth?.isLoggedIn) {
        page = <section className="mx-auto max-w-xl px-5 py-20 text-center"><h1 className="theme-text text-2xl font-semibold">{t('Anmeldung erforderlich')}</h1><p className="theme-muted mt-3">{t('Melde dich an, um auf Admin Services zuzugreifen.')}</p><a className="mt-5 inline-block text-sky-200 underline" href="/login">{t('Zum Login')}</a></section>;
    } else if (currentPath === '/admin' && ssrAuth?.session?.role !== 'admin') {
        page = <section className="mx-auto max-w-xl px-5 py-20 text-center"><h1 className="theme-text text-2xl font-semibold">{t('Kein Zugriff')}</h1><p className="theme-muted mt-3">{t('Dieser Bereich ist Administratoren vorbehalten.')}</p></section>;
    } else if (currentPath === '/settings' && !ssrAuth?.isLoggedIn) {
        page = <section className="mx-auto max-w-xl px-5 py-20 text-center"><h1 className="theme-text text-2xl font-semibold">{t('Anmeldung erforderlich')}</h1><p className="theme-muted mt-3">{t('Melde dich an, um deine Profileinstellungen zu ändern.')}</p><a className="mt-5 inline-block text-sky-200 underline" href="/login">{t('Zum Login')}</a></section>;
    } else if (currentPath === '/settings') {
        page = <UserSettingsPage />;
    } else if (currentPath === '/downloads') {
        page = <DownloadsPage />;
    } else if (currentPath === '/files') {
        page = <FilesPage />;
    } else if (currentPath === '/admin') {
        page = <AdminPage auth={ssrAuth} />;
    } else if (currentPath === '/license') {
        page = <LicensePage />;
    } else if (currentPath === '/impressum') {
        page = <ImprintPage />;
    } else if (currentPath === '/sitemap') {
        page = <SitemapPage auth={ssrAuth} />;
    } else {
        page = <ComingSoonPage pathname={currentPath} />;
    }

    return <SiteShell activePage={activePage} auth={ssrAuth}>{page}</SiteShell>;
}

export default function App(props: AppProps) {
    return (
        <I18nProvider isLoggedIn={props.ssrAuth?.isLoggedIn ?? false}>
            <ToastProvider>
                <AppContent {...props} />
            </ToastProvider>
        </I18nProvider>
    );
}
