import Button, { ButtonLink } from './Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';
import downloadIcon from '../assets/material-icons/download-button.svg';
import addIcon from '../assets/material-icons/round-add-button.svg';
import refreshIcon from '../assets/material-icons/refresh-button.svg';
import restoreIcon from '../assets/material-icons/history-clock-button.svg';
import worldIcon from '../assets/material-icons/planet-earth.svg';
import playerIcon from '../assets/material-icons/user-outline.svg';
import serverIcon from '../assets/material-icons/server-rack-with-three-levels.svg';
import auditIcon from '../assets/material-icons/list-button-with-3-elements.svg';
import warningIcon from '../assets/material-icons/warning-sign.svg';

type Service = {
    id: number;
    name: string;
    status: string;
    lastReportedAt: string | null;
    minecraftVersion: string | null;
    serviceType: 'generic' | 'minecraft';
    thnlinkEnabled: boolean;
    playersOnline: number | null;
    playersMax: number | null;
};
type Player = { uuid: string; name: string };
type Backup = { id: string; createdAt: string | number; sizeBytes: number; reason?: string };
type World = { world: string; backups: Backup[] };
type Status = { version: string; minecraftVersion: string; online: number; max: number; luckPerms: boolean };
type AuditEntry = { id: number; action: string; details: string | null; logged_at: string; username: string | null };

class RequestError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
    }
}

async function request<T>(url: string, method = 'GET'): Promise<T> {
    const response = await fetch(url, {
        method, credentials: 'include',
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {})
    });
    const data = await response.json() as { success: boolean; error?: string } & T;
    if (!response.ok || !data.success) throw new RequestError(data.error || 'Die Anfrage ist fehlgeschlagen', response.status);
    return data;
}

const inputClass = 'theme-input min-h-11 w-full rounded-xl border px-3 py-2 text-sm outline-none transition focus:border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400/30 disabled:cursor-not-allowed disabled:opacity-50';
const innerCardClass = 'theme-subsection rounded-xl border p-4';

function formatSize(bytes: number, locale: string): string {
    if (bytes < 1024) return `${bytes} B`;
    const unit = bytes < 1024 * 1024 ? 'KiB' : bytes < 1024 * 1024 * 1024 ? 'MiB' : 'GiB';
    const divisor = unit === 'KiB' ? 1024 : unit === 'MiB' ? 1024 ** 2 : 1024 ** 3;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bytes / divisor)} ${unit}`;
}

function formatDate(value: string | number, locale: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '–' : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatAge(value: string | number, locale: string): string {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (!Number.isFinite(seconds)) return '–';
    const unit = seconds < 60 ? 'second' : seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : 'day';
    const divisor = unit === 'second' ? 1 : unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400;
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(seconds / divisor), unit);
}

function statValue(stats: Record<string, unknown>, key: string): string {
    const value = stats[key];
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : '–';
}

export default function ThnAdminPanel({ services, onRefreshServices }: { services: Service[]; onRefreshServices: () => Promise<void> }) {
    const { t, language } = useI18n();
    const { toast } = useToast();
    const [serviceId, setServiceId] = useState('');
    const [status, setStatus] = useState<Status | null>(null);
    const [reachable, setReachable] = useState<boolean | null>(null);
    const [players, setPlayers] = useState<Player[]>([]);
    const [playersKnown, setPlayersKnown] = useState(false);
    const [uuid, setUuid] = useState('');
    const [stats, setStats] = useState<Record<string, unknown> | null>(null);
    const [backups, setBackups] = useState<Backup[]>([]);
    const [worlds, setWorlds] = useState<World[]>([]);
    const [audit, setAudit] = useState<AuditEntry[]>([]);
    const [busy, setBusy] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [playerLoading, setPlayerLoading] = useState(false);
    const [backupsState, setBackupsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [worldsState, setWorldsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [statsState, setStatsState] = useState<'idle' | 'ready' | 'missing' | 'error'>('idle');
    const [auditState, setAuditState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const playerRequest = useRef(0);
    const serviceRequest = useRef(0);
    const eligibleServices = services.filter((item) => item.serviceType === 'minecraft' && item.thnlinkEnabled);
    const service = eligibleServices.find((item) => String(item.id) === serviceId);
    const base = `/api/admin/thn/${encodeURIComponent(serviceId)}`;
    const locale = language === 'de' ? 'de-DE' : 'en-US';
    const playerOnline = players.some((player) => player.uuid === uuid);

    const report = useCallback((error: unknown) => {
        toast(error instanceof Error ? error.message : t('Anfrage fehlgeschlagen'), 'error');
    }, [t, toast]);

    useEffect(() => {
        setServiceId((current) => {
            const eligible = services.filter((item) => item.serviceType === 'minecraft' && item.thnlinkEnabled);
            return eligible.some((item) => String(item.id) === current) ? current : eligible[0] ? String(eligible[0].id) : '';
        });
    }, [services]);

    const refresh = useCallback(async () => {
        if (!serviceId) return;
        const requestId = ++serviceRequest.current;
        setRefreshing(true);
        setWorldsState('loading');
        setAuditState('loading');
        const [newStatus, newPlayers, newWorlds, newAudit, newServices] = await Promise.allSettled([
            request<Status>(`${base}/status`),
            request<{ players: Player[] }>(`${base}/players`),
            request<{ worlds: World[] }>(`${base}/worlds/backups`),
            request<{ entries: AuditEntry[] }>(`${base}/audit`),
            onRefreshServices()
        ]);
        if (serviceRequest.current !== requestId) return;
        setRefreshing(false);
        setStatus(newStatus.status === 'fulfilled' ? newStatus.value : null);
        setReachable(newStatus.status === 'fulfilled');
        setPlayers(newPlayers.status === 'fulfilled' ? newPlayers.value.players : []);
        setPlayersKnown(newPlayers.status === 'fulfilled');
        setWorlds(newWorlds.status === 'fulfilled' ? newWorlds.value.worlds : []);
        setWorldsState(newWorlds.status === 'fulfilled' ? 'ready' : 'error');
        setAudit(newAudit.status === 'fulfilled' ? newAudit.value.entries : []);
        setAuditState(newAudit.status === 'fulfilled' ? 'ready' : 'error');
        if (newServices.status === 'rejected') report(newServices.reason);
        if (newAudit.status === 'rejected') report(newAudit.reason);
        if (newStatus.status === 'rejected') report(newStatus.reason);
        else {
            if (newPlayers.status === 'rejected') report(newPlayers.reason);
            if (newWorlds.status === 'rejected') report(newWorlds.reason);
        }
    }, [base, serviceId, report, onRefreshServices]);

    useEffect(() => {
        playerRequest.current++;
        serviceRequest.current++;
        setStatus(null);
        setReachable(null);
        setPlayers([]);
        setPlayersKnown(false);
        setWorlds([]);
        setAudit([]);
        setStats(null);
        setStatsState('idle');
        setBackups([]);
        setBackupsState('idle');
        setWorldsState('idle');
        setAuditState('idle');
        setRefreshing(false);
        setPlayerLoading(false);
        setUuid('');
        void refresh();
    }, [refresh]);

    const loadPlayer = async () => {
        const requestId = ++playerRequest.current;
        setPlayerLoading(true);
        setBackupsState('loading');
        setBackups([]);
        setStats(null);
        const [data, stored] = await Promise.allSettled([
            request<{ backups: Backup[] }>(`${base}/players/${encodeURIComponent(uuid)}/backups`),
            request<{ player: Record<string, unknown> }>(`${base}/players/${encodeURIComponent(uuid)}/stored-stats`)
        ]);
        if (playerRequest.current !== requestId) return;
        if (data.status === 'fulfilled') {
            setBackups(data.value.backups);
            setBackupsState('ready');
        } else {
            setBackupsState('error');
            report(data.reason);
        }
        if (stored.status === 'fulfilled') {
            setStats(stored.value.player);
            setStatsState('ready');
        } else if (stored.reason instanceof RequestError && stored.reason.status === 404) {
            setStatsState('missing');
        } else {
            setStatsState('error');
            report(stored.reason);
        }
        if (players.some((player) => player.uuid === uuid)) {
            try {
                const live = await request<Record<string, unknown>>(`${base}/players/${encodeURIComponent(uuid)}/stats`);
                if (playerRequest.current !== requestId) return;
                setStats(live);
                setStatsState('ready');
            } catch (error) {
                if (playerRequest.current !== requestId) return;
                if (stored.status !== 'fulfilled') setStatsState('error');
                report(error);
            }
        }
        if (playerRequest.current === requestId) setPlayerLoading(false);
    };

    const selectPlayer = (value: string) => {
        playerRequest.current++;
        setBackups([]);
        setBackupsState('idle');
        setPlayerLoading(false);
        setStats(null);
        setStatsState('idle');
        setUuid(value);
    };

    const perform = async (url: string, after: () => Promise<void>, successMessage: string) => {
        setBusy(true);
        try {
            await request(url, 'POST');
            await after();
            toast(t(successMessage), 'success');
        } catch (error) {
            report(error);
        } finally {
            setBusy(false);
        }
    };

    const statsFields = stats ? [
        { label: t('Spielzeit gesamt'), value: typeof stats.playtimeTicks === 'number' && Number.isFinite(stats.playtimeTicks) && stats.playtimeTicks >= 0 ? t('{hours} Std. {minutes} Min.', { hours: Math.floor(stats.playtimeTicks / 72000), minutes: Math.floor(stats.playtimeTicks / 1200) % 60 }) : '–' },
        { label: t('Zuletzt gesehen'), value: typeof stats.lastSeen === 'number' ? formatDate(stats.lastSeen, locale) : '–' },
        { label: t('Tode'), value: statValue(stats, 'deaths') },
        { label: t('Mob-Kills'), value: statValue(stats, 'mobKills') },
        { label: t('Spieler-Kills'), value: statValue(stats, 'playerKills') },
        { label: t('Level'), value: statValue(stats, 'level') },
        { label: t('Gesundheit'), value: statValue(stats, 'health') },
        { label: t('Hunger'), value: statValue(stats, 'foodLevel') },
        { label: t('Spielmodus'), value: statValue(stats, 'gameMode') },
        { label: t('Welt'), value: statValue(stats, 'world') },
        { label: t('Position (X / Y / Z)'), value: `${statValue(stats, 'x')} / ${statValue(stats, 'y')} / ${statValue(stats, 'z')}` },
        { label: t('Primäre Gruppe'), value: statValue(stats, 'primaryGroup') }
    ] : [];
    const reasonLabel = (reason?: string) => reason === 'quit' ? t('Beim Verlassen') : reason === 'manual' ? t('Manuell') : reason === 'web' ? t('Weboberfläche') : '–';

    return <div className="mt-6 space-y-5">
        <section className="theme-panel rounded-2xl border p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <span className="theme-subsection rounded-xl border p-2.5"><img src={serverIcon} className="material-icon h-5 w-5" alt="" /></span>
                    <div><h2 className="theme-text text-xl font-semibold">{t('THNLink Server')}</h2><p className="theme-muted mt-1 text-sm">{t('Server auswählen und Verbindung prüfen.')}</p></div>
                </div>
                {service && <Button type="button" variant="ghost" disabled={busy || refreshing} onClick={() => void refresh()}><img src={refreshIcon} className={`material-icon h-4 w-4 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} alt="" />{refreshing ? t('Wird aktualisiert...') : t('Aktualisieren')}</Button>}
            </div>
            <label className="mt-5 block max-w-lg"><span className="theme-muted mb-1.5 block text-sm font-medium">{t('Server')}</span><select className={inputClass} value={serviceId} disabled={busy} onChange={(event) => {
                playerRequest.current++;
                serviceRequest.current++;
                setBackups([]);
                setStats(null);
                setServiceId(event.target.value);
            }}><option value="">{t('Server auswählen')}</option>{eligibleServices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            {!eligibleServices.length && <p className="theme-muted mt-4 text-sm">{t('Kein Minecraft-Server mit aktiviertem THNLink vorhanden. Aktiviere THNLink in der Serverkonfiguration.')}</p>}
            {service && <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy={refreshing}>
                <div className={innerCardClass}><p className="theme-muted text-xs font-medium uppercase tracking-wide">{t('Plugin-API')}</p><p className="theme-text mt-2 flex items-center gap-2 font-semibold"><span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${reachable === null ? 'bg-slate-400' : reachable ? 'bg-emerald-500' : 'bg-rose-500'}`} />{reachable === null ? t('Wird geprüft...') : reachable ? t('Erreichbar') : t('Nicht erreichbar')}</p></div>
                <div className={innerCardClass}><p className="theme-muted text-xs font-medium uppercase tracking-wide">{t('Serverstatus')}</p><p className="theme-text mt-2 text-sm font-semibold">{service.status}</p><p className="theme-muted mt-1 text-xs">{t('Spieler')}: {service.playersOnline ?? '–'} / {service.playersMax ?? '–'}</p></div>
                <div className={innerCardClass}><p className="theme-muted text-xs font-medium uppercase tracking-wide">{t('Versionen')}</p><p className="theme-text mt-2 text-sm font-semibold">{status ? `THNLink ${status.version}` : '–'}</p><p className="theme-muted mt-1 text-xs">Minecraft {status?.minecraftVersion || service.minecraftVersion || '–'} · LuckPerms: {status ? status.luckPerms ? t('Ja') : t('Nein') : '–'}</p>{status && <p className="theme-muted mt-1 text-xs">{t('Live-Spieler')}: {status.online} / {status.max}</p>}</div>
                <div className={innerCardClass}><p className="theme-muted text-xs font-medium uppercase tracking-wide">{t('Letzter Heartbeat')}</p><p className="theme-text mt-2 text-sm font-semibold">{service.lastReportedAt ? formatDate(service.lastReportedAt, locale) : '–'}</p></div>
            </div>}
        </section>
        {service && <>
            <section className="theme-panel rounded-2xl border p-5 sm:p-6">
                <div className="flex items-start gap-3"><span className="theme-subsection rounded-xl border p-2.5"><img src={playerIcon} className="material-icon h-5 w-5" alt="" /></span><div><h2 className="theme-text text-xl font-semibold">{t('Spieler und Backups')}</h2><p className="theme-muted mt-1 text-sm">{t('Spieler auswählen, Statistiken ansehen und Backups verwalten.')}</p></div></div>
                <div className={`${innerCardClass} mt-5`}>
                    <div className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto]">
                        <label><span className="theme-muted mb-1.5 block text-sm font-medium">{t('Online-Spieler')}</span><select className={inputClass} value={playerOnline ? uuid : ''} disabled={busy || refreshing} onChange={(event) => selectPlayer(event.target.value)}><option value="">{t('Online-Spieler auswählen')}</option>{players.map((player) => <option key={player.uuid} value={player.uuid}>{player.name}</option>)}</select></label>
                        <label><span className="theme-muted mb-1.5 block text-sm font-medium">{t('Spieler-UUID')}</span><input className={inputClass} placeholder={t('Minecraft-UUID eingeben')} value={uuid} disabled={busy} onChange={(event) => selectPlayer(event.target.value)} /></label>
                        <Button type="button" disabled={!uuid || busy || playerLoading} onClick={() => void loadPlayer()}><img src={refreshIcon} className={`material-icon h-4 w-4 ${playerLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} alt="" />{playerLoading ? t('Wird geladen...') : t('Spieler laden')}</Button>
                    </div>
                    <p className="theme-muted mt-3 text-xs">{t('Online-Spieler auswählen oder die UUID eines Spielers eingeben und laden.')}</p>
                </div>
                {playerLoading && <p className="theme-muted mt-5 text-sm" role="status">{t('Spielerdaten und Backups werden geladen...')}</p>}
                {!playerLoading && stats && <div className="mt-5">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="theme-text font-semibold">{t('Spielerstatistiken')}</h3><p className="theme-muted mt-1 break-all text-sm">{statValue(stats, 'name')} · {uuid}</p></div><span className="theme-subsection theme-text inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${playerOnline ? 'bg-emerald-500' : 'bg-slate-400'}`} />{!playersKnown ? t('Status unbekannt') : playerOnline ? t('Online') : t('Nicht online')}</span></div>
                    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{statsFields.map((field) => <div key={field.label} className={innerCardClass}><dt className="theme-muted text-xs">{field.label}</dt><dd className="theme-text mt-1 break-words text-sm font-semibold">{field.value}</dd></div>)}</dl>
                </div>}
                {!playerLoading && backupsState !== 'idle' && <div className="mt-6">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="theme-text font-semibold">{t('Spieler-Backups')}</h3><p className="theme-muted mt-1 text-sm">{t('Backups liegen auf dem Spielserver.')}</p></div><Button type="button" disabled={busy || refreshing || !playerOnline} title={playersKnown && !playerOnline ? t('Nur für Online-Spieler verfügbar') : undefined} onClick={() => void perform(`${base}/players/${encodeURIComponent(uuid)}/backups`, loadPlayer, 'Spieler-Backup erstellt')}><img src={addIcon} className="material-icon h-4 w-4" alt="" />{busy ? t('Aktion läuft...') : t('Backup jetzt erstellen')}</Button></div>
                    {!playerOnline && <p className="theme-muted mt-2 text-xs">{playersKnown ? t('Ein neues Spieler-Backup ist nur möglich, solange der Spieler online ist.') : t('Online-Status konnte nicht ermittelt werden.')}</p>}
                    {backupsState === 'error' ? <p className="theme-muted mt-4 text-sm">{t('Backups konnten nicht geladen werden.')}</p> : backups.length === 0 ? <p className={`${innerCardClass} theme-muted mt-4 text-sm`}>{t('Keine Spieler-Backups vorhanden.')}</p> : <div className="mt-4 grid gap-3 xl:grid-cols-2">{backups.map((backup) => <article key={backup.id} className={innerCardClass}>
                        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="theme-text font-semibold">{formatDate(backup.createdAt, locale)}</p><p className="theme-muted mt-1 text-xs">{formatAge(backup.createdAt, locale)} · {formatSize(backup.sizeBytes, locale)} · {reasonLabel(backup.reason)}</p></div><span className="theme-muted break-all text-xs">{backup.id}</span></div>
                        <div className="mt-4 flex flex-wrap gap-2"><ButtonLink href={`${base}/players/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(backup.id)}`}><img src={downloadIcon} className="material-icon h-4 w-4" alt="" />{t('Download')}</ButtonLink><Button type="button" disabled={busy} onClick={() => { if (window.confirm(t('Wiederherstellen überschreibt das aktuelle Inventar und den Spielerzustand. Erstelle vorher möglichst ein neues Backup. Fortfahren?'))) void perform(`${base}/players/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(backup.id)}/restore`, loadPlayer, 'Spieler-Backup wiederhergestellt'); }}><img src={restoreIcon} className="material-icon h-4 w-4" alt="" />{t('Wiederherstellen')}</Button></div>
                    </article>)}</div>}
                    {!stats && <p className="theme-muted mt-4 text-sm">{statsState === 'error' ? t('Statistiken konnten nicht geladen werden') : t('Keine Spielerstatistiken verfügbar.')}</p>}
                </div>}
            </section>
            <section className="theme-panel rounded-2xl border p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><span className="theme-subsection rounded-xl border p-2.5"><img src={worldIcon} className="material-icon h-5 w-5" alt="" /></span><div><h2 className="theme-text text-xl font-semibold">{t('Welt-Backups')}</h2><p className="theme-muted mt-1 text-sm">{t('Backups für einzelne oder alle Welten verwalten.')}</p></div></div><Button type="button" disabled={busy || refreshing || worldsState !== 'ready'} onClick={() => void perform(`${base}/worlds/all/backups`, refresh, 'Welt-Backup gestartet; die Erstellung läuft im Hintergrund.')}><img src={addIcon} className="material-icon h-4 w-4" alt="" />{busy ? t('Aktion läuft...') : t('Alle Welten sichern')}</Button></div>
                <div className={`${innerCardClass} mt-5 flex items-start gap-3`}><img src={warningIcon} className="material-icon mt-0.5 h-4 w-4 shrink-0" alt="" /><p className="theme-muted text-sm">{t('Welt-Backups können sehr groß sein. Die Wiederherstellung erfolgt manuell bei entladener Welt.')}</p></div>
                {worldsState === 'loading' || worldsState === 'idle' ? <p className="theme-muted mt-4 text-sm" role="status">{t('Welt-Backups werden geladen...')}</p> : worldsState === 'error' ? <p className="theme-muted mt-4 text-sm">{t('Welt-Backups konnten nicht geladen werden.')}</p> : worlds.length === 0 ? <p className={`${innerCardClass} theme-muted mt-4 text-sm`}>{t('Keine Welten mit Backups gefunden.')}</p> : <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">{worlds.map((world) => <article key={world.world} className="theme-subsection rounded-2xl border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="theme-text break-all font-semibold">{world.world}</h3><p className="theme-muted mt-1 text-xs">{t('{count} Backups', { count: world.backups.length })}</p></div><Button type="button" disabled={busy || refreshing} onClick={() => void perform(`${base}/worlds/${encodeURIComponent(world.world)}/backups`, refresh, 'Welt-Backup gestartet; die Erstellung läuft im Hintergrund.')}><img src={addIcon} className="material-icon h-4 w-4" alt="" />{t('Welt sichern')}</Button></div>
                    {world.backups.length === 0 ? <p className="theme-muted mt-4 text-sm">{t('Noch keine Backups vorhanden.')}</p> : <div className="mt-4 space-y-2">{world.backups.map((backup) => <div key={backup.id} className="theme-panel flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"><div><p className="theme-text text-sm font-medium">{formatDate(backup.createdAt, locale)}</p><p className="theme-muted mt-1 break-all text-xs">{formatAge(backup.createdAt, locale)} · {formatSize(backup.sizeBytes, locale)} · {backup.id}</p></div><ButtonLink href={`${base}/worlds/${encodeURIComponent(world.world)}/backups/${encodeURIComponent(backup.id)}`}><img src={downloadIcon} className="material-icon h-4 w-4" alt="" />{t('Download')}</ButtonLink></div>)}</div>}
                </article>)}</div>}
            </section>
            <section className="theme-panel rounded-2xl border p-5 sm:p-6">
                <div className="flex items-start gap-3"><span className="theme-subsection rounded-xl border p-2.5"><img src={auditIcon} className="material-icon h-5 w-5" alt="" /></span><div><h2 className="theme-text text-xl font-semibold">{t('Audit-Protokoll')}</h2><p className="theme-muted mt-1 text-sm">{t('Letzte 100 Backup- und Whitelist-Aktionen dieses Servers')}</p></div></div>
                {auditState === 'loading' || auditState === 'idle' ? <p className="theme-muted mt-4 text-sm" role="status">{t('Protokoll wird geladen...')}</p> : auditState === 'error' ? <p className="theme-muted mt-4 text-sm">{t('Protokoll konnte nicht geladen werden.')}</p> : audit.length === 0 ? <p className="theme-muted mt-4 text-sm">{t('Keine Protokolleinträge vorhanden.')}</p> : <div className="mt-4 space-y-2">{audit.map((entry) => <article key={entry.id} className={`${innerCardClass} text-sm`}><div className="flex flex-wrap items-start justify-between gap-2"><span className="theme-text break-all font-medium">{entry.action}</span><time className="theme-muted text-xs" dateTime={entry.logged_at}>{formatDate(entry.logged_at, locale)}</time></div><p className="theme-muted mt-1">{t('Ausgeführt von')}: {entry.username || t('System oder gelöschter Benutzer')}</p>{entry.details && <details className="theme-muted mt-2"><summary className="cursor-pointer rounded text-xs hover:text-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">{t('Details anzeigen')}</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs">{entry.details}</pre></details>}</article>)}</div>}
            </section>
        </>}
    </div>;
}
