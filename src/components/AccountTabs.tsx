import Button from './Button';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import binIcon from '../assets/material-icons/rubbish-bin-delete-button.svg';
import addIcon from '../assets/material-icons/round-add-button.svg';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';
import MinecraftAccountCard, { type AccountPlayerStats } from './MinecraftAccountCard';
import refreshIcon from '../assets/material-icons/refresh-button.svg';
import linkIcon from '../assets/material-icons/check-symbol.svg';

type OwnWhitelistRequest = {
    id: number;
    service_name: string;
    player_name: string;
    status: 'pending' | 'approved' | 'rejected' | 'revoked';
};

type MinecraftAccount = {
    player_uuid: string;
    player_name: string;
    verified: boolean;
};

const statusStyles: Record<OwnWhitelistRequest['status'], string> = {
    pending: 'bg-amber-300/20 text-amber-200',
    approved: 'bg-emerald-300/20 text-emerald-200',
    rejected: 'bg-rose-300/20 text-rose-200',
    revoked: 'bg-slate-300/20 text-slate-200'
};

const statusLabels: Record<OwnWhitelistRequest['status'], string> = {
    pending: 'Ausstehend',
    approved: 'Freigegeben',
    rejected: 'Abgelehnt',
    revoked: 'Widerrufen'
};

export function ServerTab() {
    const { t } = useI18n();
    const { toast } = useToast();
    const [requests, setRequests] = useState<OwnWhitelistRequest[] | null>(null);

    const removeEntry = async (request: OwnWhitelistRequest) => {
        const message = request.status === 'approved'
            ? 'Wirklich von der Whitelist dieses Servers entfernen?'
            : 'Diesen Whitelist-Eintrag wirklich entfernen?';
        if (!window.confirm(t(message))) return;
        try {
            const response = await fetch(`/api/account/whitelist/${request.id}`, { method: 'DELETE', credentials: 'include' });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) throw new Error(data.error);
            setRequests((current) => current && current.filter((entry) => entry.id !== request.id));
        } catch {
            toast(t('Whitelist-Eintrag konnte nicht entfernt werden'), 'error');
        }
    };

    useEffect(() => {
        let cancelled = false;
        fetch('/api/account/whitelist', { credentials: 'include' })
            .then((response) => response.json() as Promise<{ success: boolean; requests?: OwnWhitelistRequest[]; error?: string }>)
            .then((data) => {
                if (cancelled) return;
                if (!data.success || !data.requests) throw new Error(data.error);
                setRequests(data.requests);
            })
            .catch(() => {
                if (!cancelled) toast(t('Whitelist konnte nicht geladen werden'), 'error');
            });
        return () => { cancelled = true; };
    }, [t, toast]);

    return (
        <section className="rounded-2xl border p-5 theme-panel sm:p-7">
            <h2 className="text-xl font-semibold theme-text">{t('Meine Server-Whitelist')}</h2>
            <p className="mt-2 text-sm theme-muted">{t('Hier siehst du, auf welchen Servern du auf der Whitelist stehst oder sie beantragt hast.')}</p>
            {requests === null ? (
                <p className="mt-6 text-sm theme-muted" role="status">{t('Wird geladen...')}</p>
            ) : requests.length === 0 ? (
                <p className="mt-6 text-sm theme-muted">{t('Du hast noch keine Whitelist beantragt.')}</p>
            ) : (
                <ul className="mt-6 space-y-3">
                    {requests.map((request) => (
                        <li key={request.id} className="flex items-center justify-between gap-4 rounded-xl border p-4 theme-input">
                            <span>
                                <span className="block font-medium theme-text">{request.service_name}</span>
                                <span className="block text-sm theme-muted">{request.player_name}</span>
                            </span>
                            <span className="flex items-center gap-3">
                                <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusStyles[request.status]}`}>
                                    {t(statusLabels[request.status])}
                                </span>
                                <Button variant="danger"
                                    type="button"
                                    onClick={() => void removeEntry(request)}
                                >
                                    <img className="material-icon h-5 w-5" src={binIcon} alt="" />
                                    {t(request.status === 'approved' ? 'Von Whitelist entfernen' : 'Entfernen')}
                                </Button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

export function MinecraftTab() {
    const { t } = useI18n();
    const { toast } = useToast();
    const [accounts, setAccounts] = useState<MinecraftAccount[] | null>(null);
    const [playerName, setPlayerName] = useState('');
    const [adding, setAdding] = useState(false);
    const [linkCode, setLinkCode] = useState<{ uuid: string; code: string } | null>(null);
    const [stats, setStats] = useState<Record<string, AccountPlayerStats>>({});
    const [statsUnavailable, setStatsUnavailable] = useState<Record<string, boolean>>({});

    const load = useCallback(async () => {
        try {
            const response = await fetch('/api/account/minecraft', { credentials: 'include' });
            const data = await response.json() as { success: boolean; accounts?: MinecraftAccount[] };
            if (!response.ok || !data.success || !data.accounts) throw new Error();
            setAccounts(data.accounts);
        } catch {
            toast(t('Minecraft-Konten konnten nicht geladen werden'), 'error');
        }
    }, [t, toast]);

    useEffect(() => {
        void load();
    }, [load]);

    const add = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setAdding(true);
        try {
            const response = await fetch('/api/account/minecraft', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playerName: playerName.trim() })
            });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) {
                toast(data.error ? t(data.error) : t('Minecraft-Konto konnte nicht hinzugefügt werden'), 'error');
                return;
            }
            setPlayerName('');
            await load();
        } catch {
            toast(t('Minecraft-Konto konnte nicht hinzugefügt werden'), 'error');
        } finally {
            setAdding(false);
        }
    };

    const remove = async (account: MinecraftAccount) => {
        try {
            const response = await fetch(`/api/account/minecraft/${encodeURIComponent(account.player_uuid)}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) throw new Error(data.error);
            await load();
        } catch {
            toast(t('Minecraft-Konto konnte nicht entfernt werden'), 'error');
        }
    };

    const createCode = async (account: MinecraftAccount) => {
        try {
            const response = await fetch(`/api/account/minecraft/${encodeURIComponent(account.player_uuid)}/link-code`, {
                method: 'POST', credentials: 'include'
            });
            const data = await response.json() as { success: boolean; code?: string; error?: string };
            if (!response.ok || !data.success || !data.code) throw new Error(data.error);
            setLinkCode({ uuid: account.player_uuid, code: data.code });
        } catch (error) {
            toast(error instanceof Error && error.message ? error.message : t('Code konnte nicht erstellt werden'), 'error');
        }
    };

    const loadStats = useCallback(async (account: MinecraftAccount) => {
        try {
            const response = await fetch(`/api/account/minecraft/${encodeURIComponent(account.player_uuid)}/stats`, { credentials: 'include' });
            const data = await response.json() as { success: boolean; player?: AccountPlayerStats; error?: string };
            if (response.status === 404) {
                setStats((current) => {
                    const next = { ...current };
                    delete next[account.player_uuid];
                    return next;
                });
                setStatsUnavailable((current) => ({ ...current, [account.player_uuid]: true }));
                return;
            }
            if (!response.ok || !data.success || !data.player) throw new Error(data.error);
            const player = data.player;
            setStats((current) => ({ ...current, [account.player_uuid]: player }));
            setStatsUnavailable((current) => ({ ...current, [account.player_uuid]: false }));
        } catch (error) {
            toast(error instanceof Error && error.message ? error.message : t('Statistiken konnten nicht geladen werden'), 'error');
        }
    }, [t, toast]);

    useEffect(() => {
        const verified = accounts?.filter((account) => account.verified) || [];
        if (!verified.length) return;
        const refresh = () => { for (const account of verified) void loadStats(account); };
        refresh();
        const timer = window.setInterval(refresh, 30_000);
        return () => window.clearInterval(timer);
    }, [accounts, loadStats]);

    return (
        <section className="rounded-2xl border p-5 theme-panel sm:p-7">
            <h2 className="text-xl font-semibold theme-text">{t('Minecraft-Konten')}</h2>
            <p className="mt-2 text-sm theme-muted">
                {t('Verknüpfte Konten werden bei neuen Whitelist-Anträgen zur Auswahl angeboten. Das Entfernen hier ändert keine bestehenden Whitelist-Einträge.')}
            </p>
            {accounts === null ? (
                <p className="mt-6 text-sm theme-muted" role="status">{t('Wird geladen...')}</p>
            ) : accounts.length === 0 ? (
                <p className="mt-6 text-sm theme-muted">{t('Noch kein Minecraft-Konto verknüpft. Es wird nach deinem ersten Whitelist-Antrag automatisch gespeichert.')}</p>
            ) : (
                <ul className="mt-6 space-y-3">
                    {accounts.map((account) => (
                        <li key={account.player_uuid}>
                            <MinecraftAccountCard name={account.player_name} uuid={account.player_uuid} verified={account.verified} stats={stats[account.player_uuid] || (account.verified && statsUnavailable[account.player_uuid] ? null : undefined)} skinUrl={`/api/account/minecraft/${encodeURIComponent(account.player_uuid)}/skin`} notice={!account.verified && linkCode?.uuid === account.player_uuid && <p className="theme-subsection theme-text mt-4 rounded-xl border p-3 text-sm">{t('Im Spiel innerhalb von 10 Minuten eingeben:')} <code>/link {linkCode.code}</code></p>}>
                            <Button type="button" onClick={() => void (account.verified ? loadStats(account) : createCode(account))}>
                                <img className="material-icon h-4 w-4" src={account.verified ? refreshIcon : linkIcon} alt="" />
                                {t(account.verified ? 'Spielzeit anzeigen' : 'Im Spiel verifizieren')}
                            </Button>
                            {!account.verified && linkCode?.uuid === account.player_uuid && (
                                <Button type="button" onClick={() => void load()}><img className="material-icon h-4 w-4" src={refreshIcon} alt="" />{t('Verifizierung aktualisieren')}</Button>
                            )}
                            <Button variant="danger"
                                type="button"
                                onClick={() => void remove(account)}
                            >
                                <img className="material-icon h-5 w-5" src={binIcon} alt="" />
                                {t('Entfernen')}
                            </Button>
                            </MinecraftAccountCard>
                        </li>
                    ))}
                </ul>
            )}
            <form className="mt-6 flex flex-col gap-3 sm:flex-row" onSubmit={(event) => void add(event)}>
                <input
                    className="w-full rounded-xl border px-3 py-3 theme-input"
                    value={playerName}
                    onChange={(event) => setPlayerName(event.target.value)}
                    maxLength={16}
                    placeholder={t('Minecraft-Name')}
                    aria-label={t('Minecraft-Name')}
                    required
                />
                <Button variant="primary"
                    disabled={adding || !playerName.trim()}
                >
                    <img className="h-5 w-5 brightness-0" src={addIcon} alt="" />
                    {t('Konto hinzufügen')}
                </Button>
            </form>
        </section>
    );
}

const DELETE_STEPS = 3;

export function DeleteAccountSection() {
    const { t } = useI18n();
    const { toast } = useToast();
    const [step, setStep] = useState(0);
    const [password, setPassword] = useState('');
    const [deleting, setDeleting] = useState(false);

    const questions = [
        'Möchtest du dein Konto wirklich löschen?',
        'Alle deine Daten, Whitelist-Einträge und Minecraft-Konten werden entfernt. Bist du dir sicher?',
        'Letzte Warnung: Das Löschen kann nicht rückgängig gemacht werden. Gib dein Passwort ein, um es endgültig zu bestätigen.'
    ];

    const deleteAccount = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setDeleting(true);
        try {
            const response = await fetch('/api/account', {
                method: 'DELETE',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) {
                toast(data.error ? t(data.error) : t('Konto konnte nicht gelöscht werden'), 'error');
                return;
            }
            window.location.assign('/');
        } catch {
            toast(t('Konto konnte nicht gelöscht werden'), 'error');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <section className="rounded-2xl border border-rose-400/40 p-5 theme-panel sm:p-7">
            <h2 className="text-xl font-semibold text-rose-300">{t('Konto löschen')}</h2>
            {step === 0 ? (
                <>
                    <p className="mt-2 text-sm theme-muted">{t('Dein Konto und alle zugehörigen Daten werden dauerhaft gelöscht.')}</p>
                    <Button variant="danger" className="mt-4"
                        type="button"
                        onClick={() => setStep(1)}
                    >
                        {t('Konto löschen')}
                    </Button>
                </>
            ) : (
                <form className="mt-2 space-y-4" onSubmit={(event) => void deleteAccount(event)}>
                    <p className="text-sm theme-text" role="alert">
                        {t('Schritt')} {step}/{DELETE_STEPS}: {t(questions[step - 1])}
                    </p>
                    {step === DELETE_STEPS && (
                        <input
                            className="w-full rounded-xl border px-3 py-3 theme-input"
                            type="password"
                            autoComplete="current-password"
                            placeholder={t('Passwort')}
                            aria-label={t('Passwort')}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                            autoFocus
                        />
                    )}
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            onClick={() => { setStep(0); setPassword(''); }}
                        >
                            {t('Abbrechen')}
                        </Button>
                        {step < DELETE_STEPS ? (
                            <Button variant="danger"
                                type="button"
                                onClick={() => setStep(step + 1)}
                            >
                                {t('Ja, fortfahren')}
                            </Button>
                        ) : (
                            <Button variant="danger"
                                disabled={deleting || !password}
                            >
                                {t('Konto endgültig löschen')}
                            </Button>
                        )}
                    </div>
                </form>
            )}
        </section>
    );
}
