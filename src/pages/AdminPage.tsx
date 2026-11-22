import { useCallback, useEffect, useRef, useState } from 'react';
import type { SSRAuthState } from '../middleware/check-auth';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';

type Overview = {
    users: number;
    activeUsers: number;
    activeSessions: number;
    failedLogins24h: number;
    activeDownloads: number;
};

type AdminUser = {
    uuid: string;
    username: string;
    email: string;
    is_active: boolean;
    has_cloud_access: boolean;
    has_file_access: boolean;
    role: 'user' | 'admin';
    created_at: string;
};

type AdminDownload = {
    id: number;
    title: string;
    description: string | null;
    url: string;
    is_active: boolean;
    storage_key: string | null;
    original_filename: string | null;
};

type FileListingRules = {
    filter: string[];
    star: string[];
};

type Service = {
    id: number;
    name: string;
    address: string;
    status: 'online' | 'offline' | 'maintenance';
    details: string;
};

type ServiceStatusApiKey = {
    configured: boolean;
    createdAt: string | null;
};

type ApiResult<T> = { success: boolean; error?: string } & T;

async function requestJson<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, {
        ...init,
        credentials: 'include',
        headers
    });
    const data = await response.json() as ApiResult<T>;
    if (!response.ok || !data.success) {
        throw new Error(data.error || 'Die Anfrage ist fehlgeschlagen');
    }
    return data;
}

async function requestFormData<T>(url: string, body: FormData): Promise<ApiResult<T>> {
    const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        body
    });
    const data = await response.json() as ApiResult<T>;
    if (!response.ok || !data.success) {
        throw new Error(data.error || 'Die Anfrage ist fehlgeschlagen');
    }
    return data;
}

type AdminPageProps = {
    auth?: SSRAuthState;
};

export default function AdminPage({ auth }: AdminPageProps) {
    const { language, t } = useI18n();
    const { toast } = useToast();
    const [tab, setTab] = useState<'overview' | 'users' | 'files' | 'downloads' | 'services'>('overview');
    const [overview, setOverview] = useState<Overview | null>(null);
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [downloads, setDownloads] = useState<AdminDownload[]>([]);
    const [maxUploadMb, setMaxUploadMb] = useState(16);
    const [services, setServices] = useState<Service[]>([]);
    const [fileListingRules, setFileListingRules] = useState<FileListingRules | null>(null);
    const [serviceStatusApiKey, setServiceStatusApiKey] = useState<ServiceStatusApiKey | null>(null);
    const [revealedServiceStatusApiKey, setRevealedServiceStatusApiKey] = useState('');
    const [search, setSearch] = useState('');
    const [newDownload, setNewDownload] = useState({ title: '', description: '', url: '' });
    const [uploadTitle, setUploadTitle] = useState('');
    const [uploadDescription, setUploadDescription] = useState('');
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const [passwordResetUserId, setPasswordResetUserId] = useState<string | null>(null);
    const [passwordResetEmail, setPasswordResetEmail] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const currentUserId = auth?.session?.userId;

    const loadOverview = useCallback(async () => {
        const data = await requestJson<{ overview: Overview }>('/api/admin/overview');
        setOverview(data.overview);
    }, []);

    const loadUsers = useCallback(async (query = '') => {
        const data = await requestJson<{ users: AdminUser[] }>(`/api/admin/users?search=${encodeURIComponent(query)}`);
        setUsers(data.users);
    }, []);

    const loadDownloads = useCallback(async () => {
        const data = await requestJson<{ downloads: AdminDownload[]; maxUploadMb: number }>('/api/admin/downloads');
        setDownloads(data.downloads);
        setMaxUploadMb(data.maxUploadMb);
    }, []);

    const loadFileListingRules = useCallback(async () => {
        const data = await requestJson<{ rules: FileListingRules }>('/api/admin/files/settings');
        setFileListingRules(data.rules);
    }, []);

    const loadServices = useCallback(async () => {
        const data = await requestJson<{ services: Service[] }>('/api/admin/services');
        setServices(data.services);
    }, []);

    const loadServiceStatusApiKey = useCallback(async () => {
        const data = await requestJson<ServiceStatusApiKey>('/api/admin/services/status-key');
        setServiceStatusApiKey({ configured: data.configured, createdAt: data.createdAt || null });
    }, []);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            await Promise.all([
                loadOverview(),
                loadUsers(),
                loadDownloads(),
                loadFileListingRules(),
                loadServices(),
                loadServiceStatusApiKey()
            ]);
        } catch (loadError) {
            toast(loadError instanceof Error ? loadError.message : 'Admin-Daten konnten nicht geladen werden', 'error');
        } finally {
            setLoading(false);
        }
    }, [loadDownloads, loadFileListingRules, loadOverview, loadServices, loadServiceStatusApiKey, loadUsers, toast]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const perform = async (action: () => Promise<unknown>, reload: () => Promise<unknown>, successMessage?: string) => {
        setSaving(true);
        try {
            await action();
            await reload();
            if (successMessage) toast(successMessage, 'success');
        } catch (actionError) {
            toast(actionError instanceof Error ? actionError.message : 'Änderung konnte nicht gespeichert werden', 'error');
        } finally {
            setSaving(false);
        }
    };

    const saveFileListingRules = () => {
        if (!fileListingRules) return;
        void perform(
            () => requestJson('/api/admin/files/settings', {
                method: 'PUT',
                body: JSON.stringify(fileListingRules)
            }),
            loadFileListingRules,
            'Datei-Filter und Sterne gespeichert.'
        );
    };

    const updateUserRole = (user: AdminUser, role: AdminUser['role']) =>
        perform(
            () => requestJson(`/api/admin/users/${encodeURIComponent(user.uuid)}/role`, {
                method: 'PUT',
                body: JSON.stringify({ role })
            }),
            () => loadUsers(search),
            'Änderungen gespeichert.'
        );

    const updateUserStatus = (user: AdminUser, isActive: boolean) =>
        perform(
            () => requestJson(`/api/admin/users/${encodeURIComponent(user.uuid)}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ isActive })
            }),
            () => loadUsers(search),
            'Änderungen gespeichert.'
        );

    const updateUserCloudAccess = (user: AdminUser, enabled: boolean) =>
        perform(
            () => requestJson(`/api/admin/users/${encodeURIComponent(user.uuid)}/cloud-access`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled })
            }),
            () => loadUsers(search),
            'Änderungen gespeichert.'
        );

    const updateUserFileAccess = (user: AdminUser, enabled: boolean) =>
        perform(
            () => requestJson(`/api/admin/users/${encodeURIComponent(user.uuid)}/file-access`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled })
            }),
            () => loadUsers(search),
            'Dateizugriff aktualisiert.'
        );

    const sendPasswordReset = async (user: AdminUser, recipientEmail?: string) => {
        setSaving(true);
        try {
            const data = await requestJson<{ recipientType: 'account' | 'custom' }>(
                `/api/admin/users/${encodeURIComponent(user.uuid)}/password-reset`,
                {
                    method: 'POST',
                    body: JSON.stringify(recipientEmail ? { recipientEmail } : {})
                }
            );
            toast(
                data.recipientType === 'custom'
                    ? 'Reset-Link an die Wunschadresse für {username} wurde gesendet.'
                    : 'Reset-Link an {email} wurde gesendet.',
                'success',
                data.recipientType === 'custom' ? { username: user.username } : { email: user.email }
            );
            setPasswordResetUserId(null);
            setPasswordResetEmail('');
        } catch (actionError) {
            toast(actionError instanceof Error ? actionError.message : 'Reset-Mail konnte nicht gesendet werden', 'error');
        } finally {
            setSaving(false);
        }
    };

    const deleteUser = (user: AdminUser) => {
        if (!window.confirm(t('Konto "{username}" wirklich löschen?', { username: user.username }))) return;
        void perform(
            () => requestJson(`/api/admin/users/${encodeURIComponent(user.uuid)}`, { method: 'DELETE' }),
            () => loadUsers(search),
            'Benutzerkonto gelöscht.'
        );
    };

    const createDownload = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void perform(
            async () => {
                await requestJson('/api/admin/downloads', { method: 'POST', body: JSON.stringify(newDownload) });
                setNewDownload({ title: '', description: '', url: '' });
            },
            async () => {
                await Promise.all([loadDownloads(), loadOverview()]);
            },
            'Download hinzugefügt.'
        );
    };

    const updateUploadLimit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void perform(
            () => requestJson('/api/admin/downloads/settings', {
                method: 'PUT',
                body: JSON.stringify({ maxUploadMb })
            }),
            loadDownloads,
            t('Maximale Dateigröße gespeichert.')
        );
    };

    const uploadDownload = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!uploadFile) return;
        if (uploadFile.size > maxUploadMb * 1024 * 1024) {
            toast(t('Die Datei überschreitet das konfigurierte Upload-Limit'), 'error');
            return;
        }

        const formData = new FormData();
        formData.append('title', uploadTitle);
        formData.append('description', uploadDescription);
        formData.append('file', uploadFile);
        void perform(
            () => requestFormData('/api/admin/downloads/upload', formData),
            async () => {
                setUploadTitle('');
                setUploadDescription('');
                setUploadFile(null);
                if (uploadInputRef.current) uploadInputRef.current.value = '';
                await Promise.all([loadDownloads(), loadOverview()]);
            },
            t('Datei hochgeladen und als Download veröffentlicht.')
        );
    };

    const saveDownload = (download: AdminDownload) =>
        perform(
            () => requestJson(`/api/admin/downloads/${download.id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    title: download.title,
                    description: download.description || '',
                    url: download.url,
                    isActive: download.is_active
                })
            }),
            async () => {
                await Promise.all([loadDownloads(), loadOverview()]);
            },
            'Download gespeichert.'
        );

    const deleteDownload = (download: AdminDownload) => {
        if (!window.confirm(t('Download "{title}" wirklich löschen?', { title: download.title }))) return;
        setSaving(true);
        void (async () => {
            try {
                const result = await requestJson<{ cleanupFailed: boolean }>(
                    `/api/admin/downloads/${download.id}`,
                    { method: 'DELETE' }
                );
                await Promise.all([loadDownloads(), loadOverview()]);
                toast(
                    result.cleanupFailed
                        ? t('Download gelöscht, aber die gespeicherte Datei konnte nicht entfernt werden.')
                        : t('Download gelöscht.'),
                    result.cleanupFailed ? 'error' : 'success'
                );
            } catch (actionError) {
                toast(actionError instanceof Error ? actionError.message : 'Download konnte nicht gelöscht werden', 'error');
            } finally {
                setSaving(false);
            }
        })();
    };

    const saveService = (service: Service) =>
        perform(
            () => requestJson(`/api/admin/services/${service.id}`, {
                method: 'PUT',
                body: JSON.stringify({ status: service.status, details: service.details })
            }),
            loadServices,
            'Serverstatus gespeichert.'
        );

    const rotateServiceStatusApiKey = async () => {
        if (serviceStatusApiKey?.configured &&
            !window.confirm(t('Der bisherige Schlüssel wird sofort ungültig. Den Schlüssel wirklich neu erstellen?'))) return;
        setSaving(true);
        try {
            const data = await requestJson<{ apiKey: string }>('/api/admin/services/status-key', { method: 'POST' });
            setRevealedServiceStatusApiKey(data.apiKey);
            await loadServiceStatusApiKey();
            toast('Der Schlüssel wird nur jetzt angezeigt. Kopiere ihn direkt in die geheime Konfiguration deines Servers.', 'success');
        } catch (actionError) {
            toast(actionError instanceof Error ? actionError.message : 'API-Schlüssel konnte nicht erstellt werden', 'error');
        } finally {
            setSaving(false);
        }
    };

    const revokeServiceStatusApiKey = () => {
        if (!window.confirm(t('Der Serverstatus-API-Schlüssel wird sofort ungültig. Wirklich widerrufen?'))) return;
        setRevealedServiceStatusApiKey('');
        void perform(
            () => requestJson('/api/admin/services/status-key', { method: 'DELETE' }),
            loadServiceStatusApiKey,
            'API-Schlüssel widerrufen.'
        );
    };

    const copyServiceStatusApiKey = async () => {
        try {
            await navigator.clipboard.writeText(revealedServiceStatusApiKey);
            toast('API-Schlüssel in die Zwischenablage kopiert.', 'success');
        } catch (copyError) {
            toast(copyError instanceof Error ? copyError.message : 'Kopieren in die Zwischenablage ist fehlgeschlagen', 'error');
        }
    };

    const tabs = [
        { id: 'overview', label: 'Dashboard' },
        { id: 'users', label: t('Benutzer') },
        { id: 'files', label: t('Dateien') },
        { id: 'downloads', label: 'Downloads' },
        { id: 'services', label: t('Serverstatus') }
    ] as const;

    return (
        <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Verwaltung')}</p>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="theme-text text-3xl font-semibold">{t('Admin Services')}</h1>
                    <p className="theme-muted mt-2">{t('Benutzer, Dateien, Downloads und Serverstatus verwalten.')}</p>
                </div>
                <button className="rounded-lg border px-4 py-2 text-sm theme-text transition hover:bg-white/5 disabled:opacity-50" onClick={() => void refresh()} disabled={loading || saving}>
                    {t('Aktualisieren')}
                </button>
            </div>

            <div className="mt-8 flex gap-2 overflow-x-auto border-b border-[var(--theme-border)] pb-2" role="tablist" aria-label={t('Admin-Bereiche')}>
                {tabs.map((item) => (
                    <button
                        key={item.id}
                        className={`shrink-0 rounded-lg px-4 py-2 text-sm transition ${tab === item.id ? 'bg-sky-300 text-slate-950' : 'theme-muted hover:bg-white/5 hover:text-white'}`}
                        type="button"
                        role="tab"
                        aria-selected={tab === item.id}
                        onClick={() => setTab(item.id)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>

            {loading ? <p className="theme-muted py-10">{t('Admin-Daten werden geladen...')}</p> : (
                <>
                    {tab === 'overview' && overview && (
                        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {[
                                [t('Benutzer'), overview.users],
                                [t('Aktive Konten'), overview.activeUsers],
                                [t('Aktive Sessions'), overview.activeSessions],
                                [t('Fehlgeschlagene Logins (24 h)'), overview.failedLogins24h],
                                [t('Aktive Downloads'), overview.activeDownloads]
                            ].map(([label, value]) => (
                                <article key={label} className="theme-panel rounded-2xl border p-5">
                                    <p className="theme-muted text-sm">{label}</p>
                                    <p className="theme-text mt-2 text-3xl font-semibold">{value}</p>
                                </article>
                            ))}
                        </div>
                    )}

                    {tab === 'users' && (
                        <div className="mt-6">
                            <form
                                className="mb-5 flex gap-2"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void perform(() => loadUsers(search), async () => undefined);
                                }}
                            >
                                <input className="theme-input min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('Benutzername oder E-Mail suchen')} />
                                <button className="rounded-lg bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50" disabled={saving}>{t('Suchen')}</button>
                            </form>
                            <div className="space-y-3">
                                {users.map((user) => {
                                    const isSelf = user.uuid === currentUserId;
                                    return (
                                        <article key={user.uuid} className="theme-panel rounded-xl border p-4">
                                            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                                                <div className="min-w-0">
                                                    <h2 className="theme-text font-semibold">{user.username}</h2>
                                                    <p className="theme-muted break-all text-sm">{user.email}</p>
                                                </div>
                                                <div className="flex flex-wrap items-center gap-3">
                                                    <select className="theme-input rounded-lg border px-3 py-2 text-sm" value={user.role} disabled={saving || isSelf} aria-label={t('Rolle von {username}', { username: user.username })} onChange={(event) => void updateUserRole(user, event.target.value as AdminUser['role'])}>
                                                        <option value="user">{t('User')}</option>
                                                        <option value="admin">Admin</option>
                                                    </select>
                                                    <label className="flex items-center gap-2 text-sm theme-muted">
                                                        <input type="checkbox" checked={user.is_active} disabled={saving || isSelf} onChange={(event) => void updateUserStatus(user, event.target.checked)} />
                                                        {t('Aktiv')}
                                                    </label>
                                                    <label className="flex items-center gap-2 text-sm theme-muted">
                                                        <input type="checkbox" checked={user.has_cloud_access} disabled={saving} onChange={(event) => void updateUserCloudAccess(user, event.target.checked)} />
                                                        {t('Cloud-Zugang')}
                                                    </label>
                                                    <label className="flex items-center gap-2 text-sm theme-muted">
                                                        <input type="checkbox" checked={user.has_file_access} disabled={saving} onChange={(event) => void updateUserFileAccess(user, event.target.checked)} />
                                                        {t('Dateizugriff')}
                                                    </label>
                                                    <button
                                                        className="rounded-lg border px-3 py-2 text-sm theme-text transition hover:bg-white/5 disabled:opacity-50"
                                                        type="button"
                                                        disabled={saving}
                                                        onClick={() => {
                                                            setPasswordResetUserId((current) => current === user.uuid ? null : user.uuid);
                                                            setPasswordResetEmail('');
                                                        }}
                                                    >
                                                        {t('Passwort-Reset')}
                                                    </button>
                                                    <button className="rounded-lg border border-rose-400/20 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-50" disabled={saving || isSelf} onClick={() => deleteUser(user)}>
                                                        {t('Löschen')}
                                                    </button>
                                                </div>
                                            </div>
                                            {passwordResetUserId === user.uuid && (
                                                <div className="mt-4 space-y-3 border-t border-[var(--theme-border)] pt-4">
                                                    <p className="theme-muted text-sm">
                                                        {t('Der Link ist eine Stunde gültig und kann nur einmal verwendet werden. Eine Wunsch-E-Mail ändert nicht die E-Mail-Adresse des Kontos.')}
                                                    </p>
                                                    <button
                                                        className="rounded-lg bg-sky-300 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                                                        type="button"
                                                        disabled={saving}
                                                        onClick={() => void sendPasswordReset(user)}
                                                    >
                                                        {t('An Konto-E-Mail senden')}
                                                    </button>
                                                    <div className="flex flex-col gap-2 sm:flex-row">
                                                        <label className="sr-only" htmlFor={`reset-email-${user.uuid}`}>{t('Wunsch-E-Mail')}</label>
                                                        <input
                                                            id={`reset-email-${user.uuid}`}
                                                            className="theme-input min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
                                                            type="email"
                                                            maxLength={128}
                                                            value={passwordResetEmail}
                                                            onChange={(event) => setPasswordResetEmail(event.target.value)}
                                                            placeholder={t('Wunsch-E-Mail (optional)')}
                                                        />
                                                        <button
                                                            className="rounded-lg border px-3 py-2 text-sm theme-text disabled:opacity-50"
                                                            type="button"
                                                            disabled={saving || !passwordResetEmail.trim()}
                                                            onClick={() => void sendPasswordReset(user, passwordResetEmail.trim())}
                                                        >
                                                            {t('An Wunsch-E-Mail senden')}
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </article>
                                    );
                                })}
                                {!users.length && <p className="theme-muted rounded-xl border p-5">{t('Keine passenden Konten gefunden.')}</p>}
                            </div>
                        </div>
                    )}

                    {tab === 'files' && (
                        <div className="mt-6 space-y-6">
                            {fileListingRules && (
                                <form
                                    className="theme-panel space-y-4 rounded-2xl border p-5"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        saveFileListingRules();
                                    }}
                                >
                                    <div>
                                        <h2 className="theme-text font-semibold">{t('Datei-Filter und Sterne')}</h2>
                                        <p className="theme-muted mt-2 text-sm">
                                            {t('Eine Regex pro Zeile. Filter-Regeln blenden passende Dateinamen aus; Stern-Regeln markieren sie als Favoriten. Die Regeln gelten auch für Unterordner. Maximal 100 Regeln mit jeweils 128 Zeichen.')}
                                        </p>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <label className="block">
                                            <span className="theme-muted mb-2 block text-sm">{t('Ausblendfilter')}</span>
                                            <textarea
                                                className="theme-input min-h-48 w-full rounded-lg border px-3 py-2 font-mono text-sm"
                                                value={fileListingRules.filter.join('\n')}
                                                maxLength={13000}
                                                onChange={(event) => setFileListingRules((current) => current
                                                    ? { ...current, filter: event.target.value.split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean) }
                                                    : current)}
                                            />
                                        </label>
                                        <label className="block">
                                            <span className="theme-muted mb-2 block text-sm">{t('Stern-Regeln')}</span>
                                            <textarea
                                                className="theme-input min-h-48 w-full rounded-lg border px-3 py-2 font-mono text-sm"
                                                value={fileListingRules.star.join('\n')}
                                                maxLength={13000}
                                                onChange={(event) => setFileListingRules((current) => current
                                                    ? { ...current, star: event.target.value.split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean) }
                                                    : current)}
                                            />
                                        </label>
                                    </div>
                                    <button className="rounded-lg bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50" type="submit" disabled={saving}>
                                        {t('Regeln speichern')}
                                    </button>
                                </form>
                            )}
                        </div>
                    )}

                    {tab === 'downloads' && (
                        <div className="mt-6 space-y-6">
                            <form
                                className="theme-panel flex flex-wrap items-end gap-3 rounded-2xl border p-5"
                                onSubmit={updateUploadLimit}
                            >
                                <label className="grid gap-2 text-sm">
                                    <span className="theme-muted">{t('Maximale Dateigröße (MB)')}</span>
                                    <input
                                        className="theme-input w-36 rounded-lg border px-3 py-2"
                                        type="number"
                                        min={1}
                                        max={512}
                                        step={1}
                                        value={maxUploadMb}
                                        onChange={(event) => setMaxUploadMb(Number(event.target.value))}
                                        required
                                    />
                                </label>
                                <p className="theme-muted flex-1 text-sm">
                                    {t('Erlaubter Bereich: 1 bis 512 MB. Der Standardwert beträgt 16 MB.')}
                                </p>
                                <button
                                    className="rounded-lg border px-4 py-2 text-sm theme-text disabled:opacity-50"
                                    disabled={saving || maxUploadMb < 1 || maxUploadMb > 512}
                                >
                                    {t('Upload-Limit speichern')}
                                </button>
                            </form>

                            <form className="theme-panel grid gap-3 rounded-2xl border p-5" onSubmit={uploadDownload}>
                                <div>
                                    <h2 className="theme-text font-semibold">{t('Datei hochladen')}</h2>
                                    <p className="theme-muted mt-1 text-sm">
                                        {t('Der Upload wird als öffentlicher Download bereitgestellt.')}
                                        {' '}
                                        {t('Aktuelles Limit: {size} MB', { size: String(maxUploadMb) })}
                                    </p>
                                </div>
                                <label className="grid gap-2 text-sm">
                                    <span className="theme-muted">{t('Datei auswählen')}</span>
                                    <input
                                        ref={uploadInputRef}
                                        className="theme-input rounded-lg border px-3 py-2"
                                        type="file"
                                        onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
                                        required
                                    />
                                </label>
                                <input
                                    className="theme-input rounded-lg border px-3 py-2 text-sm"
                                    value={uploadTitle}
                                    onChange={(event) => setUploadTitle(event.target.value)}
                                    placeholder={t('Titel (optional, Standard: Dateiname)')}
                                    maxLength={128}
                                />
                                <textarea
                                    className="theme-input min-h-20 rounded-lg border px-3 py-2 text-sm"
                                    value={uploadDescription}
                                    onChange={(event) => setUploadDescription(event.target.value)}
                                    placeholder={t('Beschreibung (optional)')}
                                    maxLength={2000}
                                />
                                <button
                                    className="w-fit rounded-lg bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                                    disabled={saving || !uploadFile}
                                >
                                    {t('Datei hochladen')}
                                </button>
                            </form>

                            <form className="theme-panel grid gap-3 rounded-2xl border p-5" onSubmit={createDownload}>
                                <h2 className="theme-text font-semibold">{t('Download hinzufügen')}</h2>
                                <input className="theme-input rounded-lg border px-3 py-2 text-sm" value={newDownload.title} onChange={(event) => setNewDownload({ ...newDownload, title: event.target.value })} placeholder={t('Titel')} maxLength={128} required />
                                <textarea className="theme-input min-h-20 rounded-lg border px-3 py-2 text-sm" value={newDownload.description} onChange={(event) => setNewDownload({ ...newDownload, description: event.target.value })} placeholder={t('Beschreibung (optional)')} maxLength={2000} />
                                <input className="theme-input rounded-lg border px-3 py-2 text-sm" type="url" value={newDownload.url} onChange={(event) => setNewDownload({ ...newDownload, url: event.target.value })} placeholder="https://..." required />
                                <button className="w-fit rounded-lg bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50" disabled={saving}>{t('Hinzufügen')}</button>
                            </form>
                            <div className="space-y-4">
                                {downloads.map((download) => (
                                    <article key={download.id} className="theme-panel grid gap-3 rounded-2xl border p-5">
                                        <input className="theme-input rounded-lg border px-3 py-2 text-sm" value={download.title} onChange={(event) => setDownloads((items) => items.map((item) => item.id === download.id ? { ...item, title: event.target.value } : item))} aria-label={t('Download-Titel')} maxLength={128} />
                                        <textarea className="theme-input min-h-16 rounded-lg border px-3 py-2 text-sm" value={download.description || ''} onChange={(event) => setDownloads((items) => items.map((item) => item.id === download.id ? { ...item, description: event.target.value } : item))} aria-label={t('Download-Beschreibung')} maxLength={2000} />
                                        <input
                                            className="theme-input rounded-lg border px-3 py-2 text-sm"
                                            type={download.storage_key ? 'text' : 'url'}
                                            value={download.url}
                                            readOnly={Boolean(download.storage_key)}
                                            onChange={(event) => setDownloads((items) => items.map((item) => item.id === download.id ? { ...item, url: event.target.value } : item))}
                                            aria-label={t('Download-URL')}
                                        />
                                        {download.original_filename && (
                                            <p className="theme-muted text-xs">
                                                {t('Hochgeladene Datei: {filename}', { filename: download.original_filename })}
                                            </p>
                                        )}
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <label className="flex items-center gap-2 text-sm theme-muted">
                                                <input type="checkbox" checked={download.is_active} onChange={(event) => setDownloads((items) => items.map((item) => item.id === download.id ? { ...item, is_active: event.target.checked } : item))} />
                                                {t('Öffentlich im Mitgliederbereich')}
                                            </label>
                                            <div className="flex gap-2">
                                                <button className="rounded-lg bg-sky-300 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50" disabled={saving} onClick={() => void saveDownload(download)}>{t('Speichern')}</button>
                                                <button className="rounded-lg border border-rose-400/20 px-3 py-2 text-sm text-rose-200 disabled:opacity-50" disabled={saving} onClick={() => deleteDownload(download)}>{t('Löschen')}</button>
                                            </div>
                                        </div>
                                    </article>
                                ))}
                                {!downloads.length && <p className="theme-muted rounded-xl border p-5">{t('Noch keine Downloads angelegt.')}</p>}
                            </div>
                        </div>
                    )}

                    {tab === 'services' && (
                        <div className="mt-6 space-y-4">
                            <article className="theme-panel space-y-4 rounded-2xl border p-5">
                                <div>
                                    <h2 className="theme-text font-semibold">{t('Serverstatus API-Schlüssel')}</h2>
                                    <p className="theme-muted mt-2 text-sm">
                                        {t('Ein externer Server meldet seinen Status idealerweise alle 30 Sekunden. Nach 60 Sekunden ohne Meldung wird er automatisch als offline angezeigt. Der 64 Zeichen lange Schlüssel wird in der Datenbank nur als SHA-256-Hash gespeichert.')}
                                    </p>
                                    <p className="theme-muted mt-2 text-sm">
                                        {t('Status: {status}', { status: serviceStatusApiKey?.configured ? t('Aktiv') : t('Nicht eingerichtet') })}
                                        {serviceStatusApiKey?.createdAt && ` · ${t('erstellt')} ${new Date(serviceStatusApiKey.createdAt).toLocaleString(language === 'de' ? 'de-DE' : 'en-US')}`}
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        className="rounded-lg bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                                        type="button"
                                        disabled={saving}
                                        onClick={() => void rotateServiceStatusApiKey()}
                                    >
                                        {serviceStatusApiKey?.configured ? t('Schlüssel neu erstellen') : t('Schlüssel erstellen')}
                                    </button>
                                    {serviceStatusApiKey?.configured && (
                                        <button
                                            className="rounded-lg border border-rose-400/20 px-4 py-2 text-sm text-rose-200 disabled:opacity-50"
                                            type="button"
                                            disabled={saving}
                                            onClick={revokeServiceStatusApiKey}
                                        >
                                            {t('Widerrufen')}
                                        </button>
                                    )}
                                </div>
                                {revealedServiceStatusApiKey && (
                                    <div className="space-y-2">
                                        <label className="theme-muted block text-sm" htmlFor="service-status-api-key">{t('API-Schlüssel (nur einmal sichtbar)')}</label>
                                        <input
                                            id="service-status-api-key"
                                            className="theme-input w-full rounded-lg border px-3 py-2 font-mono text-sm"
                                            value={revealedServiceStatusApiKey}
                                            readOnly
                                            onFocus={(event) => event.currentTarget.select()}
                                        />
                                        <button className="rounded-lg border px-3 py-2 text-sm theme-text disabled:opacity-50" type="button" disabled={saving} onClick={() => void copyServiceStatusApiKey()}>
                                            {t('Schlüssel kopieren')}
                                        </button>
                                        <button className="ml-2 rounded-lg border px-3 py-2 text-sm theme-muted" type="button" onClick={() => setRevealedServiceStatusApiKey('')}>
                                            {t('Ausblenden')}
                                        </button>
                                    </div>
                                )}
                                <div>
                                    <p className="theme-muted text-sm">{t('Sende alle 30 Sekunden per HTTPS einen')} <code className="font-mono">PUT /api/services/status</code> <span>{t('mit')}</span> <code className="font-mono">Authorization: Bearer &lt;SCHLÜSSEL&gt;</code>:</p>
                                    <pre className="theme-input mt-2 overflow-x-auto rounded-lg border p-3 text-xs"><code>{language === 'de'
                                        ? '{ "name": "Minecraft", "status": "online", "details": "Server läuft" }'
                                        : '{ "name": "Minecraft", "status": "online", "details": "Server is running" }'}</code></pre>
                                </div>
                            </article>
                            {services.map((service) => (
                                <article key={service.id} className="theme-panel grid gap-3 rounded-2xl border p-5 sm:grid-cols-2">
                                    <div>
                                        <h2 className="theme-text font-semibold">{service.name}</h2>
                                        <p className="theme-muted mt-1 font-mono text-sm">{service.address}</p>
                                    </div>
                                    <select className="theme-input rounded-lg border px-3 py-2 text-sm" value={service.status} onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, status: event.target.value as Service['status'] } : item))} aria-label={t('Status von {service}', { service: service.name })}>
                                        <option value="online">Online</option>
                                        <option value="offline">Offline</option>
                                        <option value="maintenance">{t('Wartung')}</option>
                                    </select>
                                    <input className="theme-input rounded-lg border px-3 py-2 text-sm sm:col-span-2" value={service.details} onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, details: event.target.value } : item))} placeholder={t('Status-Details')} maxLength={255} aria-label={t('Details für {service}', { service: service.name })} />
                                    <button className="w-fit rounded-lg bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50 sm:col-span-2" disabled={saving} onClick={() => void saveService(service)}>{t('Status speichern')}</button>
                                </article>
                            ))}
                            {!services.length && <p className="theme-muted rounded-xl border p-5">{t('Keine Services konfiguriert.')}</p>}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
