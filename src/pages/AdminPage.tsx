import Button from '../components/Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SSRAuthState } from '../middleware/check-auth';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';
import addIcon from '../assets/material-icons/round-add-button.svg';
import infoIcon from '../assets/material-icons/round-info-button.svg';
import cloudIcon from '../assets/material-icons/cloud-outline.svg';
import whitelistIcon from '../assets/material-icons/google-drive-document.svg';
import fileIcon from '../assets/material-icons/save-button.svg';
import dashboardTabIcon from '../assets/material-icons/show-apps-button.svg';
import usersTabIcon from '../assets/material-icons/users-social-symbol.svg';
import filesTabIcon from '../assets/material-icons/folder-symbol.svg';
import downloadsTabIcon from '../assets/material-icons/download-button.svg';
import servicesTabIcon from '../assets/material-icons/server-rack-with-three-levels.svg';
import activeAccountIcon from '../assets/material-icons/round-account-button-with-user-inside.svg';
import sessionIcon from '../assets/material-icons/history-clock-button.svg';
import failedLoginIcon from '../assets/material-icons/locked-padlock-outline.svg';
import userRoleIcon from '../assets/material-icons/user-outline.svg';
import supporterRoleIcon from '../assets/material-icons/headset.svg';
import moderatorRoleIcon from '../assets/material-icons/chat-bubbles.svg';
import adminRoleIcon from '../assets/basics/shield.svg';
import ThnAdminPanel from '../components/ThnAdminPanel';
import MinecraftAccountCard, { type AccountPlayerStats } from '../components/MinecraftAccountCard';
import refreshIcon from '../assets/material-icons/refresh-button.svg';
import binIcon from '../assets/material-icons/rubbish-bin-delete-button.svg';

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
    has_whitelist: boolean;
    role: 'user' | 'supporter' | 'moderator' | 'admin';
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
    manualOverride: boolean;
    whitelistRequired: boolean;
    serviceType: 'generic' | 'minecraft';
    thnlinkEnabled: boolean;
    apiKeyConfigured: boolean;
    apiKeyCreatedAt: string | null;
    lastReportedAt: string | null;
    playersOnline: number | null;
    playersMax: number | null;
    minecraftVersion: string | null;
};

type WhitelistStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

type WhitelistEntry = {
    id: number;
    service_id: number;
    service_name: string;
    player_uuid: string;
    player_name: string;
    reason: string;
    status: WhitelistStatus;
    requested_by: string | null;
    requested_by_name: string | null;
    reviewed_by_name: string | null;
    created_at: string;
};

type WhitelistAction = 'approve' | 'reject' | 'revoke';

type MinecraftAccount = {
    player_uuid: string;
    player_name: string;
    verified: boolean;
    stats: AccountPlayerStats | null;
};

type WhitelistHistoryNote = {
    id: number;
    service_name: string | null;
    player_name: string | null;
    logged_at: string;
};

type WhitelistEntryCardProps = {
    entry: WhitelistEntry;
    saving: boolean;
    showRequester: boolean;
    onAction: (entry: WhitelistEntry, action: WhitelistAction) => void;
};

const roleIcons = {
    user: userRoleIcon,
    supporter: supporterRoleIcon,
    moderator: moderatorRoleIcon,
    admin: adminRoleIcon
};

const permissionIcons = [
    { label: 'Cloud-Zugang', icon: cloudIcon },
    { label: 'Whitelist', icon: whitelistIcon },
    { label: 'Dateizugriff', icon: fileIcon }
];

const whitelistStatusLabels: Record<WhitelistStatus, string> = {
    pending: 'Offen',
    approved: 'Freigegeben',
    rejected: 'Abgelehnt',
    revoked: 'Widerrufen'
};

function WhitelistEntryCard({ entry, saving, showRequester, onAction }: WhitelistEntryCardProps) {
    const { language, t } = useI18n();
    const canApprove = entry.status !== 'approved';
    const canReject = entry.status === 'pending';
    const canRevoke = entry.status === 'approved';

    return (
        <article className="theme-panel rounded-xl border p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-1">
                    <h3 className="theme-text font-semibold">
                        {entry.player_name} <span className="theme-muted text-sm font-normal">· {t(entry.service_name)}</span>
                    </h3>
                    <p className="theme-muted break-all font-mono text-xs">{entry.player_uuid}</p>
                    <p className="theme-muted text-sm">
                        {t(whitelistStatusLabels[entry.status])}
                        {showRequester && entry.requested_by_name && ` · ${t('Von')} ${entry.requested_by_name}`}
                        {` · ${new Date(entry.created_at).toLocaleString(language === 'de' ? 'de-DE' : 'en-US')}`}
                    </p>
                    {entry.reason && <p className="theme-text whitespace-pre-wrap text-sm">{entry.reason}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    {canApprove && (
                        <Button variant="primary" type="button" disabled={saving} onClick={() => onAction(entry, 'approve')}>
                            {t('Annehmen')}
                        </Button>
                    )}
                    {canReject && (
                        <Button variant="danger" type="button" disabled={saving} onClick={() => onAction(entry, 'reject')}>
                            {t('Ablehnen')}
                        </Button>
                    )}
                    {canRevoke && (
                        <Button variant="danger" type="button" disabled={saving} onClick={() => onAction(entry, 'revoke')}>
                            {t('Widerrufen')}
                        </Button>
                    )}
                </div>
            </div>
        </article>
    );
}

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
    const [tab, setTab] = useState<'overview' | 'users' | 'files' | 'downloads' | 'services' | 'whitelist' | 'thn'>('overview');
    const [whitelistFilter, setWhitelistFilter] = useState<WhitelistStatus | 'all'>('pending');
    const [whitelistEntries, setWhitelistEntries] = useState<WhitelistEntry[]>([]);
    const [infoUserId, setInfoUserId] = useState<string | null>(null);
    const infoUserIdRef = useRef<string | null>(null);
    const [showUserLegend, setShowUserLegend] = useState(false);
    const [userWhitelistEntries, setUserWhitelistEntries] = useState<WhitelistEntry[]>([]);
    const [userWhitelistHistory, setUserWhitelistHistory] = useState<WhitelistHistoryNote[]>([]);
    const [userMinecraftAccounts, setUserMinecraftAccounts] = useState<MinecraftAccount[]>([]);
    const [newMinecraftName, setNewMinecraftName] = useState('');
    const [grantServiceId, setGrantServiceId] = useState('');
    const [grantName, setGrantName] = useState('');
    const [overview, setOverview] = useState<Overview | null>(null);
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [downloads, setDownloads] = useState<AdminDownload[]>([]);
    const [maxUploadMb, setMaxUploadMb] = useState(16);
    const [services, setServices] = useState<Service[]>([]);
    const [savedServices, setSavedServices] = useState<Service[]>([]);
    const [showServiceInfo, setShowServiceInfo] = useState(false);
    const [showServiceForm, setShowServiceForm] = useState(false);
    const [newService, setNewService] = useState({
        name: '',
        address: '',
        status: 'maintenance' as Service['status'],
        details: '',
        manualOverride: false,
        whitelistRequired: false,
        serviceType: 'generic' as Service['serviceType'],
        thnlinkEnabled: false
    });
    const [fileListingRules, setFileListingRules] = useState<FileListingRules | null>(null);
    const [revealedServiceApiKeys, setRevealedServiceApiKeys] = useState<Record<number, string>>({});
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
    const roleLabels: Record<AdminUser['role'], string> = {
        user: t('User'),
        supporter: t('Supporter'),
        moderator: t('Moderator'),
        admin: 'Admin'
    };

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
        setSavedServices(data.services);
    }, []);

    const refreshSavedServices = useCallback(async () => {
        const data = await requestJson<{ services: Service[] }>('/api/admin/services');
        setSavedServices(data.services);
    }, []);

    const loadWhitelist = useCallback(async () => {
        const params = whitelistFilter === 'all' ? '' : `?status=${whitelistFilter}`;
        const data = await requestJson<{ requests: WhitelistEntry[] }>(`/api/admin/whitelist/requests${params}`);
        setWhitelistEntries(data.requests);
    }, [whitelistFilter]);

    const loadUserWhitelist = useCallback(async (userId: string) => {
        const [data, historyData, minecraftData] = await Promise.all([
            requestJson<{ requests: WhitelistEntry[] }>(`/api/admin/whitelist/requests?userId=${encodeURIComponent(userId)}`),
            requestJson<{ history: WhitelistHistoryNote[] }>(`/api/admin/whitelist/history?userId=${encodeURIComponent(userId)}`),
            requestJson<{ accounts: MinecraftAccount[] }>(`/api/admin/users/${encodeURIComponent(userId)}/minecraft`)
        ]);
        if (infoUserIdRef.current !== userId) return;
        setUserWhitelistEntries(data.requests);
        setUserWhitelistHistory(historyData.history);
        setUserMinecraftAccounts(minecraftData.accounts);
    }, []);

    useEffect(() => {
        if (tab !== 'users' || !infoUserId || saving) return;
        let cancelled = false;
        const timer = window.setInterval(() => {
            void requestJson<{ accounts: MinecraftAccount[] }>(`/api/admin/users/${encodeURIComponent(infoUserId)}/minecraft`)
                .then((data) => {
                    if (!cancelled && infoUserIdRef.current === infoUserId) setUserMinecraftAccounts(data.accounts);
                })
                .catch((error: unknown) => {
                    if (!cancelled) toast(error instanceof Error ? error.message : 'Minecraft-Konten konnten nicht geladen werden', 'error');
                });
        }, 30000);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [tab, infoUserId, saving, toast]);

    useEffect(() => {
        if (tab !== 'whitelist') return;
        loadWhitelist().catch((loadError: unknown) => {
            toast(loadError instanceof Error ? loadError.message : 'Whitelist konnte nicht geladen werden', 'error');
        });
    }, [tab, loadWhitelist, toast]);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            await Promise.all([
                loadOverview(),
                loadUsers(),
                loadDownloads(),
                loadFileListingRules(),
                loadServices()
            ]);
        } catch (loadError) {
            toast(loadError instanceof Error ? loadError.message : 'Admin-Daten konnten nicht geladen werden', 'error');
        } finally {
            setLoading(false);
        }
    }, [loadDownloads, loadFileListingRules, loadOverview, loadServices, loadUsers, toast]);

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

    const handleWhitelistAction = (entry: WhitelistEntry, action: WhitelistAction) => {
        if (action === 'revoke' &&
            !window.confirm(t('Freigabe für "{name}" wirklich widerrufen?', { name: entry.player_name }))) return;
        const request = () => action === 'revoke'
            ? requestJson(`/api/admin/whitelist/players/${entry.service_id}/${encodeURIComponent(entry.player_uuid)}`, { method: 'DELETE' })
            : requestJson(`/api/admin/whitelist/requests/${entry.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: action === 'approve' ? 'approved' : 'rejected' })
            });
        void perform(
            request,
            async () => {
                await loadWhitelist();
                if (infoUserId) await loadUserWhitelist(infoUserId);
            },
            t('Whitelist aktualisiert.')
        );
    };

    const handleMinecraftAction = (
        userId: string,
        request: () => Promise<unknown>,
        message: string
    ) => {
        void perform(request, async () => {
            setNewMinecraftName('');
            await loadUserWhitelist(userId);
            await loadWhitelist();
        }, message);
    };

    const toggleUserInfo = (user: AdminUser) => {
        if (infoUserId === user.uuid) {
            infoUserIdRef.current = null;
            setInfoUserId(null);
            return;
        }
        infoUserIdRef.current = user.uuid;
        setInfoUserId(user.uuid);
        setUserWhitelistEntries([]);
        setUserWhitelistHistory([]);
        setUserMinecraftAccounts([]);
        setNewMinecraftName('');
        setGrantName('');
        loadUserWhitelist(user.uuid).catch((loadError: unknown) => {
            toast(loadError instanceof Error ? loadError.message : 'Whitelist konnte nicht geladen werden', 'error');
        });
    };

    const saveService = (service: Service) =>
        perform(
            () => requestJson(`/api/admin/services/${service.id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    name: service.name,
                    address: service.address,
                    status: service.status,
                    details: service.details,
                    manualOverride: service.manualOverride,
                    whitelistRequired: service.whitelistRequired,
                    serviceType: service.serviceType,
                    thnlinkEnabled: service.thnlinkEnabled
                })
            }),
            loadServices,
            'Service gespeichert.'
        );

    const createService = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSaving(true);
        void (async () => {
            try {
                const data = await requestJson<{ serviceId: number; apiKey: string }>('/api/admin/services', {
                    method: 'POST',
                    body: JSON.stringify(newService)
                });
                setServices((current) => [...current, {
                    ...newService,
                    id: data.serviceId,
                    apiKeyConfigured: true,
                    apiKeyCreatedAt: null,
                    lastReportedAt: null,
                    playersOnline: null,
                    playersMax: null,
                    minecraftVersion: null
                }]);
                setNewService({
                    name: '',
                    address: '',
                    status: 'maintenance',
                    details: '',
                    manualOverride: false,
                    whitelistRequired: false,
                    serviceType: 'generic',
                    thnlinkEnabled: false
                });
                setRevealedServiceApiKeys((current) => ({ ...current, [data.serviceId]: data.apiKey }));
                try {
                    await loadServices();
                } catch {
                    toast(t('Service wurde erstellt, aber die Serverliste konnte nicht aktualisiert werden.'), 'error');
                    return;
                }
                toast(t('Service erstellt. Kopiere den einmalig angezeigten API-Schlüssel in die Serverkonfiguration.'), 'success');
            } catch (actionError) {
                toast(actionError instanceof Error ? actionError.message : 'Service konnte nicht erstellt werden', 'error');
            } finally {
                setSaving(false);
            }
        })();
    };

    const deleteService = (service: Service) => {
        if (!window.confirm(t('Service "{name}" wirklich löschen? Der zugehörige API-Schlüssel wird ungültig.', { name: service.name }))) return;
        void perform(
            () => requestJson(`/api/admin/services/${service.id}`, { method: 'DELETE' }),
            async () => {
                await loadServices();
                setRevealedServiceApiKeys((current) => {
                    const remaining = { ...current };
                    delete remaining[service.id];
                    return remaining;
                });
            },
            'Service gelöscht.'
        );
    };

    const rotateServiceApiKey = async (service: Service) => {
        if (service.apiKeyConfigured &&
            !window.confirm(t('Der bisherige Schlüssel wird sofort ungültig. Den Schlüssel wirklich neu erstellen?'))) return;
        setSaving(true);
        try {
            const data = await requestJson<{ apiKey: string }>(`/api/admin/services/${service.id}/api-key`, { method: 'POST' });
            setRevealedServiceApiKeys((current) => ({ ...current, [service.id]: data.apiKey }));
            setServices((current) => current.map((item) => item.id === service.id ? { ...item, apiKeyConfigured: true } : item));
            try {
                await loadServices();
            } catch {
                toast(t('Der Schlüssel wurde erstellt, aber die Serverliste konnte nicht aktualisiert werden.'), 'error');
                return;
            }
            toast(t('Kopiere den einmalig angezeigten API-Schlüssel in die Serverkonfiguration.'), 'success');
        } catch (actionError) {
            toast(actionError instanceof Error ? actionError.message : t('API-Schlüssel konnte nicht erstellt werden'), 'error');
        } finally {
            setSaving(false);
        }
    };

    const copyServiceApiKey = async (serviceId: number) => {
        const apiKey = revealedServiceApiKeys[serviceId];
        if (!apiKey) return;
        try {
            await navigator.clipboard.writeText(apiKey);
            toast(t('API-Schlüssel in die Zwischenablage kopiert.'), 'success');
        } catch (copyError) {
            toast(copyError instanceof Error ? copyError.message : t('Kopieren in die Zwischenablage ist fehlgeschlagen'), 'error');
        }
    };

    const tabs = [
        { id: 'overview', label: 'Dashboard', icon: dashboardTabIcon },
        { id: 'users', label: t('Benutzer'), icon: usersTabIcon },
        { id: 'files', label: t('Dateien'), icon: filesTabIcon },
        { id: 'downloads', label: 'Downloads', icon: downloadsTabIcon },
        { id: 'services', label: t('Serverstatus'), icon: servicesTabIcon },
        { id: 'thn', label: 'THNLink', icon: servicesTabIcon },
        { id: 'whitelist', label: 'Whitelist', icon: whitelistIcon }
    ] as const;

    return (
        <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Verwaltung')}</p>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="theme-text text-3xl font-semibold">{t('Admin Services')}</h1>
                    <p className="theme-muted mt-2">{t('Benutzer, Dateien, Downloads und Serverstatus verwalten.')}</p>
                </div>
                <Button variant="ghost" onClick={() => void refresh()} disabled={loading || saving}>
                    {t('Aktualisieren')}
                </Button>
            </div>

            <div className="theme-tabs mt-8 flex gap-2 border-b border-[var(--theme-border)]" role="tablist" aria-label={t('Admin-Bereiche')}>
                {tabs.map((item) => (
                    <Button
                        key={item.id} variant="tab"
                        type="button"
                        role="tab"
                        aria-selected={tab === item.id}
                        onClick={() => setTab(item.id)}
                    >
                        <img className="material-icon h-5 w-5" src={item.icon} alt="" />
                        {item.label}
                    </Button>
                ))}
            </div>

            {tab === 'thn' && <ThnAdminPanel services={savedServices} onRefreshServices={refreshSavedServices} />}
            {tab === 'services' && (
                <div className="mt-3 flex justify-end gap-2">
                    <Button variant="icon"
                        type="button"
                        aria-label={t('Service-Information')}
                        aria-expanded={showServiceInfo}
                        aria-controls="service-status-info"
                        title={t('Service-Information')}
                        onClick={() => setShowServiceInfo((visible) => !visible)}
                    >
                        <img className="h-5 w-5 material-icon" src={infoIcon} alt="" />
                    </Button>
                    <Button variant="icon"
                        type="button"
                        aria-label={t('Service hinzufügen')}
                        aria-expanded={showServiceForm}
                        aria-controls="service-create-form"
                        title={t('Service hinzufügen')}
                        onClick={() => setShowServiceForm((visible) => !visible)}
                    >
                        <img className="h-5 w-5 material-icon" src={addIcon} alt="" />
                    </Button>
                </div>
            )}

            {loading ? <p className="theme-muted py-10">{t('Admin-Daten werden geladen...')}</p> : (
                <>
                    {tab === 'overview' && overview && (
                        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {[
                                [t('Benutzer'), overview.users, usersTabIcon],
                                [t('Aktive Konten'), overview.activeUsers, activeAccountIcon],
                                [t('Aktive Sessions'), overview.activeSessions, sessionIcon],
                                [t('Fehlgeschlagene Logins (24 h)'), overview.failedLogins24h, failedLoginIcon],
                                [t('Aktive Downloads'), overview.activeDownloads, downloadsTabIcon]
                            ].map(([label, value, icon]) => (
                                <article key={label} className="theme-panel rounded-2xl border p-5">
                                    <p className="theme-muted flex items-center gap-2 text-sm">
                                        <img className="h-4 w-4 material-icon" src={icon as string} alt="" />
                                        {label}
                                    </p>
                                    <p className="theme-text mt-2 text-3xl font-semibold">{value}</p>
                                </article>
                            ))}
                        </div>
                    )}

                    {tab === 'users' && (
                        <div className="mt-6">
                            <form
                                className="mb-5 flex items-center gap-2"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void perform(() => loadUsers(search), async () => undefined);
                                }}
                            >
                                <input className="theme-input min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('Benutzername oder E-Mail suchen')} />
                                <Button variant="primary" disabled={saving}>{t('Suchen')}</Button>
                                <Button variant="icon"
                                    type="button"
                                    aria-label={t('Legende')}
                                    aria-expanded={showUserLegend}
                                    title={t('Legende')}
                                    onClick={() => setShowUserLegend((visible) => !visible)}
                                >
                                    <img className="h-5 w-5 material-icon" src={infoIcon} alt="" />
                                </Button>
                            </form>
                            {showUserLegend && (
                                <div className="theme-panel mb-5 grid gap-5 rounded-xl border p-4 sm:grid-cols-2">
                                    <div>
                                        <h3 className="theme-text mb-2 text-sm font-semibold">{t('Berechtigungen')}</h3>
                                        <ul className="theme-text space-y-2 text-sm">
                                            {permissionIcons.map((item) => (
                                                <li key={item.label} className="flex items-center gap-3">
                                                    <img className="h-5 w-5 shrink-0 material-icon" src={item.icon} alt="" />
                                                    {t(item.label)}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                    <div>
                                        <h3 className="theme-text mb-2 text-sm font-semibold">{t('Rolle')}</h3>
                                        <ul className="theme-text space-y-2 text-sm">
                                            {(Object.keys(roleIcons) as AdminUser['role'][]).map((role) => (
                                                <li key={role} className="flex items-center gap-3">
                                                    <img className="h-5 w-5 shrink-0 material-icon" src={roleIcons[role]} alt="" />
                                                    {roleLabels[role]}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                </div>
                            )}
                            <div className="space-y-3">
                                {users.map((user) => {
                                    const isSelf = user.uuid === currentUserId;
                                    const userPermissions = [
                                        user.has_cloud_access && permissionIcons[0],
                                        user.has_whitelist && permissionIcons[1],
                                        user.has_file_access && permissionIcons[2]
                                    ].filter((item) => item !== false);
                                    return (
                                        <article key={user.uuid} className="theme-panel rounded-xl border p-4">
                                            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                                                <Button variant="icon"
                                                    type="button"
                                                    aria-label={t('Whitelist und Minecraft-Informationen von {username}', { username: user.username })}
                                                    aria-expanded={infoUserId === user.uuid}
                                                    title={t('Whitelist und Minecraft-Informationen')}
                                                    onClick={() => toggleUserInfo(user)}
                                                >
                                                    <img className="h-5 w-5 material-icon" src={infoIcon} alt="" />
                                                </Button>
                                                <div className="min-w-0 flex-1">
                                                    <h2 className="theme-text font-semibold">{user.username}</h2>
                                                    <p className="theme-muted break-all text-sm">{user.email}</p>
                                                </div>
                                                <div className="flex flex-wrap items-center gap-3">
                                                    <span className="theme-muted inline-flex items-center gap-1.5 text-sm">
                                                        <img className="h-5 w-5 shrink-0 material-icon" src={roleIcons[user.role]} alt="" />
                                                        {roleLabels[user.role]}
                                                    </span>
                                                    <span className="flex items-center gap-1.5">
                                                        {userPermissions.map((item) => (
                                                            <img key={item.label} className="h-5 w-5 material-icon" src={item.icon} alt={t(item.label)} title={t(item.label)} />
                                                        ))}
                                                    </span>
                                                    <Button variant="danger" disabled={saving || isSelf} onClick={() => deleteUser(user)}>
                                                        {t('Löschen')}
                                                    </Button>
                                                </div>
                                            </div>
                                            {infoUserId === user.uuid && (
                                                <div className="mt-4 space-y-3 border-t border-[var(--theme-border)] pt-4">
                                                    <div className="flex flex-wrap items-center gap-3">
                                                        <select className="theme-input rounded-lg border px-3 py-2 text-sm" value={user.role} disabled={saving || isSelf} aria-label={t('Rolle von {username}', { username: user.username })} onChange={(event) => void updateUserRole(user, event.target.value as AdminUser['role'])}>
                                                            <option value="user">{t('User')}</option>
                                                            <option value="supporter">{t('Supporter')}</option>
                                                            <option value="moderator">{t('Moderator')}</option>
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
                                                        <Button
                                                            type="button"
                                                            disabled={saving}
                                                            onClick={() => {
                                                                setPasswordResetUserId((current) => current === user.uuid ? null : user.uuid);
                                                                setPasswordResetEmail('');
                                                            }}
                                                        >
                                                            {t('Passwort-Reset')}
                                                        </Button>
                                                    </div>
                                                    <h3 className="theme-text text-sm font-semibold">{t('Minecraft-Konten')}</h3>
                                                    {!userMinecraftAccounts.length && (
                                                        <p className="theme-muted text-sm">{t('Keine Minecraft-Konten verknüpft.')}</p>
                                                    )}
                                                    {userMinecraftAccounts.map((account) => (
                                                        <MinecraftAccountCard key={`${user.uuid}-${account.player_uuid}`} name={account.player_name} uuid={account.player_uuid} verified={account.verified} stats={account.stats} skinUrl={`/api/admin/users/${encodeURIComponent(user.uuid)}/minecraft/${encodeURIComponent(account.player_uuid)}/skin`}>
                                                                <Button
                                                                    type="button"
                                                                    disabled={saving}
                                                                    title={t('Aktuellen Namen von Mojang laden')}
                                                                    onClick={() => handleMinecraftAction(
                                                                        user.uuid,
                                                                        () => requestJson(`/api/admin/users/${user.uuid}/minecraft/${encodeURIComponent(account.player_uuid)}`, { method: 'PUT' }),
                                                                        t('Minecraft-Name aktualisiert.')
                                                                    )}
                                                                >
                                                                    <img src={refreshIcon} className="material-icon h-4 w-4" alt="" />{t('Name aktualisieren')}
                                                                </Button>
                                                                <Button variant="danger"
                                                                    type="button"
                                                                    disabled={saving}
                                                                    onClick={() => {
                                                                        if (!window.confirm(t('Minecraft-Konto "{name}" wirklich entfernen?', { name: account.player_name }))) return;
                                                                        handleMinecraftAction(
                                                                            user.uuid,
                                                                            () => requestJson(`/api/admin/users/${user.uuid}/minecraft/${encodeURIComponent(account.player_uuid)}`, { method: 'DELETE' }),
                                                                            t('Minecraft-Konto entfernt.')
                                                                        );
                                                                    }}
                                                                >
                                                                    <img src={binIcon} className="material-icon h-4 w-4" alt="" />{t('Entfernen')}
                                                                </Button>
                                                        </MinecraftAccountCard>
                                                    ))}
                                                    <form
                                                        className="flex gap-2"
                                                        onSubmit={(event) => {
                                                            event.preventDefault();
                                                            handleMinecraftAction(
                                                                user.uuid,
                                                                () => requestJson(`/api/admin/users/${user.uuid}/minecraft`, {
                                                                    method: 'POST',
                                                                    body: JSON.stringify({ playerName: newMinecraftName.trim() })
                                                                }),
                                                                t('Minecraft-Konto hinzugefügt.')
                                                            );
                                                        }}
                                                    >
                                                        <input
                                                            className="theme-input w-full max-w-xs rounded-lg border px-3 py-2 text-sm"
                                                            value={newMinecraftName}
                                                            onChange={(event) => setNewMinecraftName(event.target.value)}
                                                            maxLength={16}
                                                            placeholder={t('Minecraft-Name')}
                                                            aria-label={t('Minecraft-Name')}
                                                        />
                                                        <Button
                                                            disabled={saving || !newMinecraftName.trim()}
                                                        >
                                                            {t('Konto hinzufügen')}
                                                        </Button>
                                                    </form>
                                                    <h3 className="theme-text text-sm font-semibold">{t('Whitelist und Minecraft-Informationen')}</h3>
                                                    <form
                                                        className="flex flex-wrap items-center gap-2"
                                                        onSubmit={(event) => {
                                                            event.preventDefault();
                                                            void perform(
                                                                () => requestJson('/api/admin/whitelist/grant', {
                                                                    method: 'POST',
                                                                    body: JSON.stringify({ userId: user.uuid, serviceId: Number(grantServiceId), playerName: grantName.trim() })
                                                                }),
                                                                async () => {
                                                                    setGrantName('');
                                                                    await loadUserWhitelist(user.uuid);
                                                                    await loadWhitelist();
                                                                },
                                                                t('Benutzer auf die Whitelist gesetzt.')
                                                            );
                                                        }}
                                                    >
                                                        <span className="theme-muted text-sm">{t('Admin edit')}:</span>
                                                        <select
                                                            className="theme-input rounded-lg border px-3 py-2 text-sm"
                                                            value={grantServiceId}
                                                            onChange={(event) => setGrantServiceId(event.target.value)}
                                                            aria-label={t('Server')}
                                                        >
                                                            <option value="">{t('Server wählen')}</option>
                                                            {savedServices.filter((service) => service.serviceType === 'minecraft').map((service) => (
                                                                <option key={service.id} value={service.id}>{t(service.name)}</option>
                                                            ))}
                                                        </select>
                                                        <input
                                                            className="theme-input rounded-lg border px-3 py-2 text-sm"
                                                            list={`minecraft-accounts-${user.uuid}`}
                                                            value={grantName}
                                                            onChange={(event) => setGrantName(event.target.value)}
                                                            maxLength={16}
                                                            placeholder={t('Minecraft-Name')}
                                                            aria-label={t('Minecraft-Name')}
                                                        />
                                                        <datalist id={`minecraft-accounts-${user.uuid}`}>
                                                            {userMinecraftAccounts.map((account) => (
                                                                <option key={account.player_uuid} value={account.player_name} />
                                                            ))}
                                                        </datalist>
                                                        <Button
                                                            disabled={saving || !grantServiceId || !grantName.trim()}
                                                        >
                                                            {t('Auf Whitelist setzen')}
                                                        </Button>
                                                    </form>
                                                    {!userWhitelistEntries.length && !userWhitelistHistory.length && (
                                                        <p className="theme-muted text-sm">{t('Keine Whitelist-Anträge von diesem Benutzer.')}</p>
                                                    )}
                                                    {userWhitelistEntries.map((entry) => (
                                                        <WhitelistEntryCard key={entry.id} entry={entry} saving={saving} showRequester={false} onAction={handleWhitelistAction} />
                                                    ))}
                                                    {userWhitelistHistory.length > 0 && (
                                                        <ul className="theme-muted space-y-1 text-xs">
                                                            {userWhitelistHistory.map((note) => (
                                                                <li key={note.id}>
                                                                    {new Date(note.logged_at).toLocaleString(language === 'de' ? 'de-DE' : 'en-GB')}: {t('Hat sich selbst von der Whitelist entfernt')}
                                                                    {note.service_name ? ` · ${note.service_name}` : ''}
                                                                    {note.player_name ? ` · ${note.player_name}` : ''}
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                </div>
                                            )}
                                            {passwordResetUserId === user.uuid && (
                                                <div className="mt-4 space-y-3 border-t border-[var(--theme-border)] pt-4">
                                                    <p className="theme-muted text-sm">
                                                        {t('Der Link ist eine Stunde gültig und kann nur einmal verwendet werden. Eine Wunsch-E-Mail ändert nicht die E-Mail-Adresse des Kontos.')}
                                                    </p>
                                                    <Button variant="primary"
                                                        type="button"
                                                        disabled={saving}
                                                        onClick={() => void sendPasswordReset(user)}
                                                    >
                                                        {t('An Konto-E-Mail senden')}
                                                    </Button>
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
                                                        <Button
                                                            type="button"
                                                            disabled={saving || !passwordResetEmail.trim()}
                                                            onClick={() => void sendPasswordReset(user, passwordResetEmail.trim())}
                                                        >
                                                            {t('An Wunsch-E-Mail senden')}
                                                        </Button>
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
                                    <Button variant="primary" type="submit" disabled={saving}>
                                        {t('Regeln speichern')}
                                    </Button>
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
                                <Button
                                    disabled={saving || maxUploadMb < 1 || maxUploadMb > 512}
                                >
                                    {t('Upload-Limit speichern')}
                                </Button>
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
                                <Button variant="primary" className="w-fit"
                                    disabled={saving || !uploadFile}
                                >
                                    {t('Datei hochladen')}
                                </Button>
                            </form>

                            <form className="theme-panel grid gap-3 rounded-2xl border p-5" onSubmit={createDownload}>
                                <h2 className="theme-text font-semibold">{t('Download hinzufügen')}</h2>
                                <input className="theme-input rounded-lg border px-3 py-2 text-sm" value={newDownload.title} onChange={(event) => setNewDownload({ ...newDownload, title: event.target.value })} placeholder={t('Titel')} maxLength={128} required />
                                <textarea className="theme-input min-h-20 rounded-lg border px-3 py-2 text-sm" value={newDownload.description} onChange={(event) => setNewDownload({ ...newDownload, description: event.target.value })} placeholder={t('Beschreibung (optional)')} maxLength={2000} />
                                <input className="theme-input rounded-lg border px-3 py-2 text-sm" type="url" value={newDownload.url} onChange={(event) => setNewDownload({ ...newDownload, url: event.target.value })} placeholder="https://..." required />
                                <Button variant="primary" className="w-fit" disabled={saving}>{t('Hinzufügen')}</Button>
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
                                                <Button variant="primary" disabled={saving} onClick={() => void saveDownload(download)}>{t('Speichern')}</Button>
                                                <Button variant="danger" disabled={saving} onClick={() => deleteDownload(download)}>{t('Löschen')}</Button>
                                            </div>
                                        </div>
                                    </article>
                                ))}
                                {!downloads.length && <p className="theme-muted rounded-xl border p-5">{t('Noch keine Downloads angelegt.')}</p>}
                            </div>
                        </div>
                    )}

                    {tab === 'whitelist' && (
                        <div className="mt-6 space-y-4">
                            <select
                                className="theme-input rounded-lg border px-3 py-2 text-sm"
                                value={whitelistFilter}
                                onChange={(event) => setWhitelistFilter(event.target.value as WhitelistStatus | 'all')}
                                aria-label={t('Whitelist-Filter')}
                            >
                                <option value="pending">{t('Offen')}</option>
                                <option value="approved">{t('Freigegeben')}</option>
                                <option value="rejected">{t('Abgelehnt')}</option>
                                <option value="revoked">{t('Widerrufen')}</option>
                                <option value="all">{t('Alle')}</option>
                            </select>
                            {whitelistEntries.map((entry) => (
                                <WhitelistEntryCard key={entry.id} entry={entry} saving={saving} showRequester onAction={handleWhitelistAction} />
                            ))}
                            {!whitelistEntries.length && <p className="theme-muted rounded-xl border p-5">{t('Keine Whitelist-Anträge.')}</p>}
                        </div>
                    )}

                    {tab === 'services' && (
                        <div className="mt-6 space-y-4">
                            {showServiceInfo && (
                                <article id="service-status-info" className="theme-panel space-y-4 rounded-2xl border p-5">
                                    <div>
                                        <h2 className="theme-text font-semibold">{t('Service-Statusmeldungen')}</h2>
                                        <p className="theme-muted mt-2 text-sm">
                                            {t('Jeder Service verwendet einen eigenen API-Schlüssel. Schlüssel werden nur einmal angezeigt und in der Datenbank ausschließlich als SHA-256-Hash gespeichert. Ohne manuelle Überschreibung wird ein Service nach 90 Sekunden ohne Heartbeat einmalig auf offline gesetzt.')}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="theme-muted text-sm">{t('Sende alle 30 Sekunden per HTTPS einen')} <code className="font-mono">PUT /api/services/status</code> <span>{t('mit')}</span> <code className="font-mono">Authorization: Bearer &lt;SCHLÜSSEL&gt;</code>:</p>
                                        <pre className="theme-input mt-2 overflow-x-auto rounded-lg border p-3 text-xs"><code>{JSON.stringify({
                                            status: 'online',
                                            details: language === 'de' ? 'Server läuft' : 'Server is running',
                                            players: { online: 3, max: 20 },
                                            minecraftVersion: '1.21.4'
                                        }, null, 2)}</code></pre>
                                        <p className="theme-muted mt-2 text-xs">
                                            {t('status: online, offline oder maintenance. players und minecraftVersion sind optional; ältere Heartbeats ohne diese Felder funktionieren weiterhin.')}
                                        </p>
                                    </div>
                                </article>
                            )}
                            {showServiceForm && (
                                <form id="service-create-form" className="theme-panel grid gap-3 rounded-2xl border p-5 sm:grid-cols-2" onSubmit={createService}>
                                    <h2 className="theme-text font-semibold sm:col-span-2">{t('Service hinzufügen')}</h2>
                                    <label className="theme-muted text-sm sm:col-span-2">{t('Servertyp')}
                                        <select className="theme-input mt-1 block w-full rounded-lg border px-3 py-2" value={newService.serviceType} onChange={(event) => {
                                            const serviceType = event.target.value === 'minecraft' ? 'minecraft' : 'generic';
                                            setNewService((current) => ({ ...current, serviceType, ...(serviceType === 'generic' ? { whitelistRequired: false, thnlinkEnabled: false } : {}) }));
                                        }}>
                                            <option value="generic">{t('Allgemeiner Dienst')}</option>
                                            <option value="minecraft">{t('Game – Minecraft')}</option>
                                        </select>
                                    </label>
                                    <input
                                        className="theme-input rounded-lg border px-3 py-2 text-sm"
                                        value={newService.name}
                                        onChange={(event) => setNewService((current) => ({ ...current, name: event.target.value }))}
                                        placeholder={t('Service-Name')}
                                        aria-label={t('Service-Name')}
                                        maxLength={64}
                                        required
                                    />
                                    <input
                                        className="theme-input rounded-lg border px-3 py-2 text-sm"
                                        value={newService.address}
                                        onChange={(event) => setNewService((current) => ({ ...current, address: event.target.value }))}
                                        placeholder={t('Serveradresse')}
                                        aria-label={t('Serveradresse')}
                                        maxLength={255}
                                        required
                                    />
                                    <select
                                        className="theme-input rounded-lg border px-3 py-2 text-sm"
                                        value={newService.status}
                                        onChange={(event) => setNewService((current) => ({ ...current, status: event.target.value as Service['status'] }))}
                                        aria-label={t('Service-Status')}
                                    >
                                        <option value="online">{t('Online')}</option>
                                        <option value="offline">{t('Offline')}</option>
                                        <option value="maintenance">{t('Wartung')}</option>
                                    </select>
                                    <input
                                        className="theme-input rounded-lg border px-3 py-2 text-sm"
                                        value={newService.details}
                                        onChange={(event) => setNewService((current) => ({ ...current, details: event.target.value }))}
                                        placeholder={t('Status-Details')}
                                        aria-label={t('Status-Details')}
                                        maxLength={255}
                                    />
                                    <label className="theme-muted flex items-center gap-2 text-sm sm:col-span-2">
                                        <input
                                            type="checkbox"
                                            checked={newService.manualOverride}
                                            onChange={(event) => setNewService((current) => ({ ...current, manualOverride: event.target.checked }))}
                                        />
                                        {t('Manueller Status-Override')}
                                    </label>
                                    {newService.serviceType === 'minecraft' && <label className="theme-muted flex items-center gap-2 text-sm sm:col-span-2">
                                        <input
                                            type="checkbox"
                                            checked={newService.whitelistRequired}
                                            onChange={(event) => setNewService((current) => ({ ...current, whitelistRequired: event.target.checked }))}
                                        />
                                        {t('Whitelist erforderlich')}
                                    </label>}
                                    {newService.serviceType === 'minecraft' && <label className="theme-muted flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={newService.thnlinkEnabled} onChange={(event) => setNewService((current) => ({ ...current, thnlinkEnabled: event.target.checked }))} />{t('THNLink aktivieren')}</label>}
                                    {newService.serviceType === 'minecraft' && <p className="theme-muted text-xs sm:col-span-2">{t('Minecraft-Whitelists verwenden Spielernamen und UUIDs. THNLink aktiviert Spielerstatistiken und Backups.')}</p>}
                                    <Button variant="primary" className="w-fit sm:col-span-2"
                                        type="submit"
                                        disabled={saving}
                                    >
                                        {t('Service hinzufügen und API-Schlüssel erstellen')}
                                    </Button>
                                </form>
                            )}
                            {services.map((service) => (
                                <article key={service.id} className="theme-panel grid gap-3 rounded-2xl border p-5 sm:grid-cols-2">
                                    <label className="theme-muted text-sm sm:col-span-2">{t('Servertyp')}
                                        <select className="theme-input mt-1 block w-full rounded-lg border px-3 py-2" disabled={saving} value={service.serviceType} onChange={(event) => {
                                            const serviceType = event.target.value === 'minecraft' ? 'minecraft' : 'generic';
                                            setServices((items) => items.map((item) => item.id === service.id ? { ...item, serviceType, ...(serviceType === 'generic' ? { whitelistRequired: false, thnlinkEnabled: false } : {}) } : item));
                                        }}>
                                            <option value="generic">{t('Allgemeiner Dienst')}</option>
                                            <option value="minecraft">{t('Game – Minecraft')}</option>
                                        </select>
                                    </label>
                                    <input
                                        className="theme-input rounded-lg border px-3 py-2 text-sm"
                                        value={service.name}
                                        onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, name: event.target.value } : item))}
                                        aria-label={t('Service-Name')}
                                        maxLength={64}
                                        required
                                    />
                                    <input
                                        className="theme-input rounded-lg border px-3 py-2 text-sm"
                                        value={service.address}
                                        onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, address: event.target.value } : item))}
                                        aria-label={t('Serveradresse')}
                                        maxLength={255}
                                        required
                                    />
                                    <select className="theme-input rounded-lg border px-3 py-2 text-sm" value={service.status} onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, status: event.target.value as Service['status'] } : item))} aria-label={t('Status von {service}', { service: service.name })}>
                                        <option value="online">Online</option>
                                        <option value="offline">Offline</option>
                                        <option value="maintenance">{t('Wartung')}</option>
                                    </select>
                                    <input className="theme-input rounded-lg border px-3 py-2 text-sm sm:col-span-2" value={service.details} onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, details: event.target.value } : item))} placeholder={t('Status-Details')} maxLength={255} aria-label={t('Details für {service}', { service: service.name })} />
                                    <label className="theme-muted flex items-center gap-2 text-sm sm:col-span-2">
                                        <input
                                            type="checkbox"
                                            checked={service.manualOverride}
                                            disabled={saving}
                                            onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, manualOverride: event.target.checked } : item))}
                                        />
                                        {t('Manueller Status-Override')}
                                    </label>
                                    {service.serviceType === 'minecraft' && <label className="theme-muted flex items-center gap-2 text-sm sm:col-span-2">
                                        <input
                                            type="checkbox"
                                            checked={service.whitelistRequired}
                                            disabled={saving}
                                            onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, whitelistRequired: event.target.checked } : item))}
                                        />
                                        {t('Whitelist erforderlich')}
                                    </label>}
                                    {service.serviceType === 'minecraft' && <label className="theme-muted flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={service.thnlinkEnabled} disabled={saving} onChange={(event) => setServices((items) => items.map((item) => item.id === service.id ? { ...item, thnlinkEnabled: event.target.checked } : item))} />{t('THNLink aktivieren')}</label>}
                                    <p className="theme-muted text-xs sm:col-span-2">{t(service.serviceType === 'minecraft' ? 'Minecraft-Whitelists verwenden Spielernamen und UUIDs. THNLink aktiviert Spielerstatistiken und Backups.' : 'Minecraft-Einstellungen sind für allgemeine Dienste deaktiviert. Bestehende Whitelist-Einträge bleiben erhalten.')}</p>
                                    <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                                        <span className="theme-muted text-sm">
                                            {t('API-Schlüssel: {status}', { status: service.apiKeyConfigured ? t('Aktiv') : t('Nicht eingerichtet') })}
                                            {service.apiKeyCreatedAt && ` · ${t('erstellt')} ${new Date(service.apiKeyCreatedAt).toLocaleString(language === 'de' ? 'de-DE' : 'en-US')}`}
                                        </span>
                                        <Button
                                            type="button"
                                            disabled={saving}
                                            onClick={() => void rotateServiceApiKey(service)}
                                        >
                                            {service.apiKeyConfigured ? t('Schlüssel neu erstellen') : t('Schlüssel erstellen')}
                                        </Button>
                                        <Button variant="primary"
                                            type="button"
                                            disabled={saving}
                                            onClick={() => void saveService(service)}
                                        >
                                            {t('Service speichern')}
                                        </Button>
                                        <Button variant="danger"
                                            type="button"
                                            disabled={saving}
                                            onClick={() => deleteService(service)}
                                        >
                                            {t('Service löschen')}
                                        </Button>
                                    </div>
                                    {revealedServiceApiKeys[service.id] && (
                                        <div className="space-y-2 sm:col-span-2">
                                            <label className="theme-muted block text-sm" htmlFor={`service-api-key-${service.id}`}>
                                                {t('API-Schlüssel (nur einmal sichtbar)')}
                                            </label>
                                            <input
                                                id={`service-api-key-${service.id}`}
                                                className="theme-input w-full rounded-lg border px-3 py-2 font-mono text-sm"
                                                value={revealedServiceApiKeys[service.id]}
                                                readOnly
                                                onFocus={(event) => event.currentTarget.select()}
                                            />
                                            <Button
                                                type="button"
                                                disabled={saving}
                                                onClick={() => void copyServiceApiKey(service.id)}
                                            >
                                                {t('Schlüssel kopieren')}
                                            </Button>
                                            <Button className="ml-2"
                                                type="button"
                                                onClick={() => setRevealedServiceApiKeys((current) => {
                                                    const remaining = { ...current };
                                                    delete remaining[service.id];
                                                    return remaining;
                                                })}
                                            >
                                                {t('Ausblenden')}
                                            </Button>
                                        </div>
                                    )}
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
