import { useEffect, useState } from 'react';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';

type WhitelistRequestDialogProps = {
    serviceId: number;
    serviceName: string;
    isLoggedIn: boolean;
    onClose: () => void;
};

const MAX_REASON_LENGTH = 500;

export default function WhitelistRequestDialog({ serviceId, serviceName, isLoggedIn, onClose }: WhitelistRequestDialogProps) {
    const { t } = useI18n();
    const { toast } = useToast();
    const [playerName, setPlayerName] = useState('');
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [savedAccounts, setSavedAccounts] = useState<string[]>([]);

    useEffect(() => {
        if (!isLoggedIn) return;
        let cancelled = false;
        fetch('/api/account/minecraft', { credentials: 'include' })
            .then((response) => response.json() as Promise<{ success: boolean; accounts?: { player_name: string }[] }>)
            .then((data) => {
                if (cancelled || !data.success || !data.accounts) return;
                const names = data.accounts.map((account) => account.player_name);
                setSavedAccounts(names);
                if (names.length === 1) setPlayerName(names[0]);
            })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [isLoggedIn]);

    useEffect(() => {
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [onClose]);

    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSubmitting(true);
        try {
            const response = await fetch('/api/services/whitelist/requests', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serviceId, playerName: playerName.trim(), reason: reason.trim() })
            });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) {
                toast(data.error ? t(data.error) : t('Whitelist-Antrag konnte nicht gesendet werden'), 'error');
                return;
            }
            toast(t('Whitelist-Antrag gesendet. Ein Admin prüft ihn.'), 'success');
            onClose();
        } catch {
            toast(t('Whitelist-Antrag konnte nicht gesendet werden'), 'error');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="presentation"
            onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
        >
            <div className="theme-panel w-full max-w-md rounded-2xl border p-6 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="whitelist-dialog-title">
                <h2 id="whitelist-dialog-title" className="theme-text text-lg font-semibold">
                    {t('Whitelist beantragen')} · {t(serviceName)}
                </h2>

                {!isLoggedIn ? (
                    <>
                        <p className="theme-muted mt-3 text-sm">
                            {t('Du musst eingeloggt sein, um eine Whitelist zu beantragen. Bitte melde dich an oder registriere dich.')}
                        </p>
                        <div className="mt-5 flex justify-end gap-2">
                            <button className="rounded-lg border px-4 py-2 text-sm theme-text transition hover:bg-white/5" type="button" onClick={onClose}>
                                {t('Abbrechen')}
                            </button>
                            <a className="rounded-lg bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950" href="/login">
                                {t('Zum Login / Registrieren')}
                            </a>
                        </div>
                    </>
                ) : (
                    <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
                        <div>
                            <label className="theme-muted block text-sm" htmlFor="whitelist-player-name">{t('Minecraft-Name')}</label>
                            {savedAccounts.length > 0 && (
                                <select
                                    className="theme-input mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                                    value={savedAccounts.includes(playerName) ? playerName : ''}
                                    onChange={(event) => setPlayerName(event.target.value)}
                                    aria-label={t('Gespeichertes Minecraft-Konto')}
                                >
                                    <option value="">{t('Anderes Konto eingeben')}</option>
                                    {savedAccounts.map((name) => <option key={name} value={name}>{name}</option>)}
                                </select>
                            )}
                            <input
                                id="whitelist-player-name"
                                className="theme-input mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                                value={playerName}
                                onChange={(event) => setPlayerName(event.target.value)}
                                maxLength={16}
                                autoFocus
                                required
                            />
                        </div>
                        <div>
                            <label className="theme-muted block text-sm" htmlFor="whitelist-reason">{t('Warum möchtest du auf die Whitelist?')}</label>
                            <textarea
                                id="whitelist-reason"
                                className="theme-input mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                                value={reason}
                                onChange={(event) => setReason(event.target.value)}
                                maxLength={MAX_REASON_LENGTH}
                                rows={4}
                                required
                            />
                        </div>
                        <div className="flex justify-end gap-2">
                            <button className="rounded-lg border px-4 py-2 text-sm theme-text transition hover:bg-white/5" type="button" onClick={onClose}>
                                {t('Abbrechen')}
                            </button>
                            <button
                                className="rounded-lg bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                                type="submit"
                                disabled={submitting || !playerName.trim() || !reason.trim()}
                            >
                                {t('Antrag senden')}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
