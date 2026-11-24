import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';
import settingsTabIcon from '../assets/material-icons/settings-cogwheel-button.svg';
import serverTabIcon from '../assets/material-icons/server-rack-with-three-levels.svg';
import minecraftTabIcon from '../assets/material-icons/gamepad.svg';
import { DeleteAccountSection, MinecraftTab, ServerTab } from '../components/AccountTabs';

const accountTabs = [
    { id: 'general', label: 'Allgemeines', icon: settingsTabIcon },
    { id: 'server', label: 'Server', icon: serverTabIcon },
    { id: 'minecraft', label: 'Minecraft', icon: minecraftTabIcon }
] as const;

type UserSettings = {
    language: string;
    timezone: string;
    darkMode: boolean;
};

type UserAccount = {
    username: string;
    email: string;
};

type SettingsResponse = {
    success: boolean;
    settings?: UserSettings;
    error?: string;
};

const languages = [
    { value: 'de', label: 'Deutsch' },
    { value: 'en', label: 'English' }
];

const timezones = [
    'UTC',
    'Europe/Berlin',
    'Europe/London',
    'America/New_York',
    'America/Los_Angeles',
    'Asia/Tokyo'
];

export default function UserSettingsPage() {
    const { t, setLanguage, setDarkMode } = useI18n();
    const { toast } = useToast();
    const [tab, setTab] = useState<'general' | 'server' | 'minecraft'>('general');
    const [settings, setSettings] = useState<UserSettings | null>(null);
    const [account, setAccount] = useState<UserAccount | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [currentEmailPassword, setCurrentEmailPassword] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [savingEmail, setSavingEmail] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [savingPassword, setSavingPassword] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function loadSettings() {
            try {
                const [settingsResponse, accountResponse] = await Promise.all([
                    fetch('/api/settings', { credentials: 'include' }),
                    fetch('/api/account', { credentials: 'include' })
                ]);
                const [settingsData, accountData] = await Promise.all([
                    settingsResponse.json() as Promise<SettingsResponse>,
                    accountResponse.json() as Promise<{ success: boolean; account?: UserAccount; error?: string }>
                ]);
                if (!settingsResponse.ok || !settingsData.success || !settingsData.settings) {
                    throw new Error(settingsData.error || 'Einstellungen konnten nicht geladen werden');
                }
                if (!accountResponse.ok || !accountData.success || !accountData.account) {
                    throw new Error(accountData.error || 'Kontodaten konnten nicht geladen werden');
                }
                if (!cancelled) {
                    setSettings(settingsData.settings);
                    setAccount(accountData.account);
                    setNewEmail(accountData.account.email);
                    setLanguage(settingsData.settings.language === 'en' ? 'en' : 'de');
                    setDarkMode(settingsData.settings.darkMode);
                }
            } catch (loadError) {
                if (!cancelled) {
                    toast(loadError instanceof Error ? loadError.message : 'Einstellungen konnten nicht geladen werden', 'error');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void loadSettings();
        return () => {
            cancelled = true;
        };
    }, [setDarkMode, setLanguage, toast]);

    const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!settings) return;

        setSaving(true);
        try {
            const response = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(settings)
            });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Einstellungen konnten nicht gespeichert werden');
            }
            setLanguage(settings.language === 'en' ? 'en' : 'de');
            setDarkMode(settings.darkMode);
            toast('Einstellungen gespeichert.', 'success');
        } catch (saveError) {
            toast(saveError instanceof Error ? saveError.message : 'Einstellungen konnten nicht gespeichert werden', 'error');
        } finally {
            setSaving(false);
        }
    };

    const saveEmail = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSavingEmail(true);
        try {
            const response = await fetch('/api/account/email', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ currentPassword: currentEmailPassword, email: newEmail })
            });
            const data = await response.json() as { success: boolean; email?: string; error?: string };
            if (!response.ok || !data.success || !data.email) {
                throw new Error(data.error || 'E-Mail-Adresse konnte nicht geändert werden');
            }
            const updatedEmail = data.email;
            setAccount((current) => current ? { ...current, email: updatedEmail } : current);
            setNewEmail(updatedEmail);
            setCurrentEmailPassword('');
            toast('E-Mail-Adresse aktualisiert.', 'success');
        } catch (saveError) {
            toast(saveError instanceof Error ? saveError.message : 'E-Mail-Adresse konnte nicht geändert werden', 'error');
        } finally {
            setSavingEmail(false);
        }
    };

    const savePassword = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (newPassword !== confirmPassword) {
            toast('Die neuen Passwörter stimmen nicht überein', 'error');
            return;
        }

        setSavingPassword(true);
        try {
            const response = await fetch('/api/account/password', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Passwort konnte nicht geändert werden');
            }
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
            toast('Passwort geändert. Andere aktive Sitzungen wurden abgemeldet.', 'success');
        } catch (saveError) {
            toast(saveError instanceof Error ? saveError.message : 'Passwort konnte nicht geändert werden', 'error');
        } finally {
            setSavingPassword(false);
        }
    };

    const updateSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
        setSettings((current) => current ? { ...current, [key]: value } : current);
    };

    return (
        <section className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Dein Konto')}</p>
            <h1 className="mt-2 text-3xl font-semibold theme-text">{t('Profil-Einstellungen')}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 theme-muted">
                {t('Diese Einstellungen werden in deinem Benutzerprofil gespeichert.')}
            </p>

            {loading ? (
                <p className="mt-8 text-sm theme-muted" role="status">{t('Einstellungen werden geladen...')}</p>
            ) : settings && account && (
                <div className="mt-8 space-y-8">
                    <div className="flex gap-2 border-b border-[var(--theme-border)]" role="tablist">
                        {accountTabs.map((item) => (
                            <button
                                key={item.id}
                                className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition ${tab === item.id ? 'border-sky-300 theme-text' : 'border-transparent theme-muted hover:text-sky-200'}`}
                                type="button"
                                role="tab"
                                aria-selected={tab === item.id}
                                onClick={() => setTab(item.id)}
                            >
                                <img className="h-5 w-5 material-icon" src={item.icon} alt="" />
                                {t(item.label)}
                            </button>
                        ))}
                    </div>
                    {tab === 'server' && <ServerTab />}
                    {tab === 'minecraft' && <MinecraftTab />}
                    {tab === 'general' && <>
                    <section className="rounded-2xl border p-5 theme-panel sm:p-7">
                        <h2 className="text-xl font-semibold theme-text">{t('Konto')}</h2>
                        <p className="mt-2 text-sm theme-muted">
                            {t('Angemeldet als')} <strong className="theme-text">{account.username}</strong>
                        </p>
                        <form className="mt-6 space-y-4" onSubmit={saveEmail}>
                            <h3 className="font-medium theme-text">{t('E-Mail-Adresse ändern')}</h3>
                            <label className="block">
                                <span className="mb-2 block text-sm theme-muted">{t('Neue E-Mail-Adresse')}</span>
                                <input
                                    className="w-full rounded-xl border px-3 py-3 theme-input"
                                    type="email"
                                    autoComplete="email"
                                    required
                                    value={newEmail}
                                    onChange={(event) => setNewEmail(event.target.value)}
                                />
                            </label>
                            <label className="block">
                                <span className="mb-2 block text-sm theme-muted">{t('Aktuelles Passwort zur Bestätigung')}</span>
                                <input
                                    className="w-full rounded-xl border px-3 py-3 theme-input"
                                    type="password"
                                    autoComplete="current-password"
                                    required
                                    value={currentEmailPassword}
                                    onChange={(event) => setCurrentEmailPassword(event.target.value)}
                                />
                            </label>
                            <p className="text-xs theme-muted">
                                {t('E-Mail-Änderungen werden sofort übernommen; eine Bestätigungs-E-Mail ist derzeit nicht eingerichtet.')}
                            </p>
                            <button
                                className="rounded-xl bg-sky-300 px-5 py-3 text-sm font-semibold text-black transition hover:bg-sky-200 disabled:opacity-60"
                                disabled={savingEmail}
                            >
                                {savingEmail ? t('Speichern...') : t('E-Mail speichern')}
                            </button>
                        </form>

                        <form className="mt-8 space-y-4 border-t border-[var(--theme-border)] pt-6" onSubmit={savePassword}>
                            <h3 className="font-medium theme-text">{t('Passwort ändern')}</h3>
                            <label className="block">
                                <span className="mb-2 block text-sm theme-muted">{t('Aktuelles Passwort')}</span>
                                <input
                                    className="w-full rounded-xl border px-3 py-3 theme-input"
                                    type="password"
                                    autoComplete="current-password"
                                    required
                                    value={currentPassword}
                                    onChange={(event) => setCurrentPassword(event.target.value)}
                                />
                            </label>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className="block">
                                    <span className="mb-2 block text-sm theme-muted">{t('Neues Passwort')}</span>
                                    <input
                                        className="w-full rounded-xl border px-3 py-3 theme-input"
                                        type="password"
                                        autoComplete="new-password"
                                        minLength={8}
                                        maxLength={128}
                                        required
                                        value={newPassword}
                                        onChange={(event) => setNewPassword(event.target.value)}
                                    />
                                </label>
                                <label className="block">
                                    <span className="mb-2 block text-sm theme-muted">{t('Neues Passwort wiederholen')}</span>
                                    <input
                                        className="w-full rounded-xl border px-3 py-3 theme-input"
                                        type="password"
                                        autoComplete="new-password"
                                        minLength={8}
                                        maxLength={128}
                                        required
                                        value={confirmPassword}
                                        onChange={(event) => setConfirmPassword(event.target.value)}
                                    />
                                </label>
                            </div>
                            <button
                                className="rounded-xl bg-sky-300 px-5 py-3 text-sm font-semibold text-black transition hover:bg-sky-200 disabled:opacity-60"
                                disabled={savingPassword}
                            >
                                {savingPassword ? t('Speichern...') : t('Passwort speichern')}
                            </button>
                        </form>
                    </section>

                    <form className="space-y-6 rounded-2xl border p-5 theme-panel sm:p-7" onSubmit={saveSettings}>
                    <label className="block">
                        <span className="mb-2 block text-sm font-medium theme-text">{t('Sprache')}</span>
                        <select
                            className="w-full rounded-xl border px-3 py-3 theme-input"
                            value={settings.language}
                            onChange={(event) => {
                                updateSetting('language', event.target.value);
                                setLanguage(event.target.value === 'en' ? 'en' : 'de');
                            }}
                        >
                            {!languages.some((language) => language.value === settings.language) && (
                                <option value={settings.language}>{settings.language} ({t('aktuell')})</option>
                            )}
                            {languages.map((language) => (
                                <option key={language.value} value={language.value}>{t(language.label)}</option>
                            ))}
                        </select>
                        <span className="mt-1 block text-xs theme-muted">{t('Gespeicherte Spracheinstellung für dein Profil.')}</span>
                    </label>

                    <label className="block">
                        <span className="mb-2 block text-sm font-medium theme-text">{t('Zeitzone')}</span>
                        <select
                            className="w-full rounded-xl border px-3 py-3 theme-input"
                            value={settings.timezone}
                            onChange={(event) => updateSetting('timezone', event.target.value)}
                        >
                            {!timezones.includes(settings.timezone) && (
                                <option value={settings.timezone}>{settings.timezone} ({t('aktuell')})</option>
                            )}
                            {timezones.map((timezone) => (
                                <option key={timezone} value={timezone}>{timezone}</option>
                            ))}
                        </select>
                    </label>

                    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border p-4 theme-input">
                        <span>
                            <span className="block text-sm font-medium theme-text">{t('Darstellung')}</span>
                            <span className="mt-1 block text-xs theme-muted">{t(settings.darkMode ? 'Dunkles Farbschema verwenden.' : 'Hellmodus verwenden.')}</span>
                        </span>
                        <input
                            className="h-5 w-5 accent-sky-300"
                            type="checkbox"
                            checked={settings.darkMode}
                            onChange={(event) => {
                                updateSetting('darkMode', event.target.checked);
                                setDarkMode(event.target.checked);
                            }}
                        />
                    </label>

                    <button
                        className="rounded-xl bg-sky-300 px-5 py-3 text-sm font-semibold text-black transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
                        type="submit"
                        disabled={saving}
                    >
                        {saving ? t('Speichern...') : t('Änderungen speichern')}
                    </button>
                    </form>
                    <DeleteAccountSection />
                    </>}
                </div>
            )}
        </section>
    );
}
