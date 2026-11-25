import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';
import downloadIcon from '../assets/material-icons/download-button.svg';
import addIcon from '../assets/material-icons/round-add-button.svg';

type Service = {
    id: number;
    name: string;
    status: string;
    lastReportedAt: string | null;
    minecraftVersion: string | null;
    playersOnline: number | null;
    playersMax: number | null;
};
type Player = { uuid: string; name: string };
type Backup = { id: string; createdAt: string | number; sizeBytes: number; reason?: string };
type World = { world: string; backups: Backup[] };
type Status = { version: string; minecraftVersion: string; online: number; max: number; luckPerms: boolean };
type AuditEntry = { id: number; action: string; details: string | null; logged_at: string; username: string | null };

async function request<T>(url: string, method = 'GET'): Promise<T> {
    const response = await fetch(url, {
        method, credentials: 'include',
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {})
    });
    const data = await response.json() as { success: boolean; error?: string } & T;
    if (!response.ok || !data.success) throw new Error(data.error || 'Die Anfrage ist fehlgeschlagen');
    return data;
}

function backupInfo(backup: Backup): string {
    const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(backup.createdAt).getTime()) / 60_000));
    return `${(backup.sizeBytes / 1024 / 1024).toFixed(2)} MiB · ${ageMinutes} min${backup.reason ? ` · ${backup.reason}` : ''}`;
}

export default function ThnAdminPanel({ services }: { services: Service[] }) {
    const { t } = useI18n();
    const { toast } = useToast();
    const [serviceId, setServiceId] = useState('');
    const [status, setStatus] = useState<Status | null>(null);
    const [reachable, setReachable] = useState<boolean | null>(null);
    const [players, setPlayers] = useState<Player[]>([]);
    const [uuid, setUuid] = useState('');
    const [stats, setStats] = useState<Record<string, unknown> | null>(null);
    const [backups, setBackups] = useState<Backup[]>([]);
    const [worlds, setWorlds] = useState<World[]>([]);
    const [audit, setAudit] = useState<AuditEntry[]>([]);
    const [busy, setBusy] = useState(false);
    const playerRequest = useRef(0);
    const serviceRequest = useRef(0);
    const service = services.find((item) => String(item.id) === serviceId);
    const base = `/api/admin/thn/${encodeURIComponent(serviceId)}`;

    const report = useCallback((error: unknown) => {
        toast(error instanceof Error ? error.message : t('Anfrage fehlgeschlagen'), 'error');
    }, [t, toast]);

    const refresh = useCallback(async () => {
        if (!serviceId) return;
        const requestId = ++serviceRequest.current;
        const [newStatus, newPlayers, newWorlds, newAudit] = await Promise.allSettled([
            request<Status>(`${base}/status`),
            request<{ players: Player[] }>(`${base}/players`),
            request<{ worlds: World[] }>(`${base}/worlds/backups`),
            request<{ entries: AuditEntry[] }>(`${base}/audit`)
        ]);
        if (serviceRequest.current !== requestId) return;
        setStatus(newStatus.status === 'fulfilled' ? newStatus.value : null);
        setReachable(newStatus.status === 'fulfilled');
        setPlayers(newPlayers.status === 'fulfilled' ? newPlayers.value.players : []);
        setWorlds(newWorlds.status === 'fulfilled' ? newWorlds.value.worlds : []);
        setAudit(newAudit.status === 'fulfilled' ? newAudit.value.entries : []);
        if (newAudit.status === 'rejected') report(newAudit.reason);
        if (newStatus.status === 'rejected') report(newStatus.reason);
        else {
            if (newPlayers.status === 'rejected') report(newPlayers.reason);
            if (newWorlds.status === 'rejected') report(newWorlds.reason);
        }
    }, [base, serviceId, report]);

    useEffect(() => {
        playerRequest.current++;
        serviceRequest.current++;
        setStatus(null);
        setReachable(null);
        setPlayers([]);
        setWorlds([]);
        setAudit([]);
        setStats(null);
        setBackups([]);
        setUuid('');
        void refresh();
    }, [refresh]);

    const loadPlayer = async () => {
        const requestId = ++playerRequest.current;
        setBackups([]);
        setStats(null);
        const [data, stored] = await Promise.allSettled([
            request<{ backups: Backup[] }>(`${base}/players/${encodeURIComponent(uuid)}/backups`),
            request<{ player: Record<string, unknown> }>(`${base}/players/${encodeURIComponent(uuid)}/stored-stats`)
        ]);
        if (playerRequest.current !== requestId) return;
        if (data.status === 'fulfilled') setBackups(data.value.backups);
        else report(data.reason);
        if (stored.status === 'fulfilled') setStats(stored.value.player);
        else report(stored.reason);
        if (players.some((player) => player.uuid === uuid)) {
            try {
                const live = await request<Record<string, unknown>>(`${base}/players/${encodeURIComponent(uuid)}/stats`);
                if (playerRequest.current !== requestId) return;
                setStats(live);
            } catch (error) {
                report(error);
            }
        }
    };

    const selectPlayer = (value: string) => {
        playerRequest.current++;
        setBackups([]);
        setStats(null);
        setUuid(value);
    };

    const perform = async (url: string, after: () => Promise<void>) => {
        setBusy(true);
        try {
            await request(url, 'POST');
            await after();
            toast(t('Aktion erfolgreich'), 'success');
        } catch (error) {
            report(error);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mt-6 space-y-5">
            <section className="theme-panel rounded-xl border p-5 space-y-3">
                <h2 className="theme-text text-xl font-semibold">{t('THNLink Server')}</h2>
                <select className="theme-input rounded-lg border p-2" value={serviceId} disabled={busy} onChange={(event) => {
                    playerRequest.current++;
                    serviceRequest.current++;
                    setBackups([]);
                    setStats(null);
                    setServiceId(event.target.value);
                }}>
                    <option value="">{t('Server auswählen')}</option>
                    {services.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                {service && <p className="theme-muted text-sm">
                    {t('Status')}: {service.status} · Minecraft: {service.minecraftVersion || '–'} · {t('Spieler')}: {service.playersOnline ?? '–'}/{service.playersMax ?? '–'} · {t('Letzter Heartbeat')}: {service.lastReportedAt ? new Date(service.lastReportedAt).toLocaleString() : '–'}
                </p>}
                {service && <p className="theme-muted text-sm">{t('Plugin-API')}: {reachable === null ? t('Wird geladen...') : reachable ? t('Erreichbar') : t('Nicht erreichbar')}{status && ` · THNLink ${status.version} · Minecraft ${status.minecraftVersion} · ${status.online}/${status.max} · LuckPerms: ${status.luckPerms ? '✓' : '–'}`}</p>}
                {service && <button className="theme-text rounded-lg border px-3 py-2" type="button" onClick={() => void refresh()}>{t('Aktualisieren')}</button>}
            </section>
            {service && <>
                <section className="theme-panel rounded-xl border p-5 space-y-3">
                    <h2 className="theme-text text-xl font-semibold">{t('Spieler-Backups')}</h2>
                    <select className="theme-input rounded-lg border p-2" disabled={busy} value={players.some((p) => p.uuid === uuid) ? uuid : ''} onChange={(event) => selectPlayer(event.target.value)}>
                        <option value="">{t('Online-Spieler auswählen')}</option>
                        {players.map((player) => <option key={player.uuid} value={player.uuid}>{player.name}</option>)}
                    </select>
                    <input className="theme-input rounded-lg border p-2" disabled={busy} value={uuid} onChange={(event) => selectPlayer(event.target.value)} placeholder={t('Spieler-UUID')} aria-label={t('Spieler-UUID')} />
                    <button className="theme-text rounded-lg border px-3 py-2" type="button" onClick={() => void loadPlayer()}>{t('Laden')}</button>
                    <button className="theme-text inline-flex items-center gap-2 rounded-lg border px-3 py-2 disabled:opacity-50" type="button" disabled={busy || !players.some((player) => player.uuid === uuid)} onClick={() => void perform(`${base}/players/${encodeURIComponent(uuid)}/backups`, loadPlayer)}>
                        <img src={addIcon} className="material-icon h-5 w-5" alt="" />{t('Backup jetzt erstellen')}
                    </button>
                    {stats && <pre className="theme-muted overflow-auto text-xs">{JSON.stringify(stats, null, 2)}</pre>}
                    <ul className="space-y-2">{backups.map((backup) => <li key={backup.id} className="theme-text flex flex-wrap items-center gap-3 text-sm">
                        <span>{backup.id} · {backupInfo(backup)}</span>
                        <a className="inline-flex items-center gap-1 underline" href={`${base}/players/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(backup.id)}`}><img src={downloadIcon} className="material-icon h-4 w-4" alt="" />{t('Download')}</a>
                        <button className="rounded border px-2 py-1" type="button" disabled={busy} onClick={() => {
                            if (!window.confirm(t('Wiederherstellen überschreibt das aktuelle Inventar und den Spielerzustand. Erstelle vorher möglichst ein neues Backup. Fortfahren?'))) return;
                            void perform(`${base}/players/${encodeURIComponent(uuid)}/backups/${encodeURIComponent(backup.id)}/restore`, loadPlayer);
                        }}>{t('Wiederherstellen')}</button>
                    </li>)}</ul>
                </section>
                <section className="theme-panel rounded-xl border p-5 space-y-3">
                    <h2 className="theme-text text-xl font-semibold">{t('Welt-Backups')}</h2>
                    <p className="theme-muted text-sm">{t('Welt-Backups können sehr groß sein. Die Wiederherstellung erfolgt manuell bei entladener Welt.')}</p>
                    <button className="theme-text rounded-lg border px-3 py-2" type="button" disabled={busy} onClick={() => void perform(`${base}/worlds/all/backups`, refresh)}>{t('Alle Welten sichern')}</button>
                    {worlds.map((world) => <div key={world.world} className="space-y-2">
                        <h3 className="theme-text font-semibold">{world.world}</h3>
                        <button className="theme-text rounded-lg border px-3 py-1 text-sm" type="button" disabled={busy} onClick={() => void perform(`${base}/worlds/${encodeURIComponent(world.world)}/backups`, refresh)}>{t('Welt sichern')}</button>
                        {world.backups.map((backup) => <p key={backup.id} className="theme-muted text-sm">{backup.id} · {backupInfo(backup)} · <a className="underline" href={`${base}/worlds/${encodeURIComponent(world.world)}/backups/${encodeURIComponent(backup.id)}`}>{t('Download')}</a></p>)}
                    </div>)}
                </section>
                <section className="theme-panel rounded-xl border p-5 space-y-3">
                    <h2 className="theme-text text-xl font-semibold">{t('Audit-Protokoll')}</h2>
                    <p className="theme-muted text-sm">{t('Letzte 100 Backup- und Whitelist-Aktionen dieses Servers')}</p>
                    <ul className="space-y-2">{audit.map((entry) => <li key={entry.id} className="theme-muted break-all text-sm">
                        {new Date(entry.logged_at).toLocaleString()} · {entry.username || t('System oder gelöschter Benutzer')} · {entry.action} · {entry.details}
                    </li>)}</ul>
                </section>
            </>}
        </div>
    );
}
