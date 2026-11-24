import { useCallback, useEffect, useState, type FormEvent } from 'react';
import binIcon from '../assets/material-icons/rubbish-bin-delete-button.svg';
import addIcon from '../assets/material-icons/round-add-button.svg';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';

type OwnWhitelistRequest = {
    id: number;
    service_name: string;
    player_name: string;
    status: 'pending' | 'approved' | 'rejected' | 'revoked';
};

type MinecraftAccount = {
    player_uuid: string;
    player_name: string;
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
                                <button
                                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-300 transition hover:bg-white/5"
                                    type="button"
                                    onClick={() => void removeEntry(request)}
                                >
                                    <img className="material-icon h-5 w-5" src={binIcon} alt="" />
                                    {t(request.status === 'approved' ? 'Von Whitelist entfernen' : 'Entfernen')}
                                </button>
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
                        <li key={account.player_uuid} className="flex items-center justify-between gap-4 rounded-xl border p-4 theme-input">
                            <span className="min-w-0">
                                <span className="block font-medium theme-text">{account.player_name}</span>
                                <span className="block truncate font-mono text-xs theme-muted">{account.player_uuid}</span>
                            </span>
                            <button
                                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-300 transition hover:bg-white/5"
                                type="button"
                                onClick={() => void remove(account)}
                            >
                                <img className="material-icon h-5 w-5" src={binIcon} alt="" />
                                {t('Entfernen')}
                            </button>
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
                <button
                    className="flex items-center justify-center gap-2 rounded-xl bg-sky-300 px-5 py-3 text-sm font-semibold text-black transition hover:bg-sky-200 disabled:opacity-60"
                    disabled={adding || !playerName.trim()}
                >
                    <img className="h-5 w-5 brightness-0" src={addIcon} alt="" />
                    {t('Konto hinzufügen')}
                </button>
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
                    <button
                        className="mt-4 flex items-center gap-2 rounded-xl bg-rose-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-rose-400"
                        type="button"
                        onClick={() => setStep(1)}
                    >
                        {t('Konto löschen')}
                    </button>
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
                        <button
                            className="rounded-xl border px-5 py-3 text-sm theme-text transition hover:bg-white/5"
                            type="button"
                            onClick={() => { setStep(0); setPassword(''); }}
                        >
                            {t('Abbrechen')}
                        </button>
                        {step < DELETE_STEPS ? (
                            <button
                                className="rounded-xl bg-rose-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-rose-400"
                                type="button"
                                onClick={() => setStep(step + 1)}
                            >
                                {t('Ja, fortfahren')}
                            </button>
                        ) : (
                            <button
                                className="rounded-xl bg-rose-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:opacity-60"
                                disabled={deleting || !password}
                            >
                                {t('Konto endgültig löschen')}
                            </button>
                        )}
                    </div>
                </form>
            )}
        </section>
    );
}
