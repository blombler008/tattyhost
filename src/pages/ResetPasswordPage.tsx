import { useEffect, useState } from 'react';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';

export default function ResetPasswordPage() {
    const { t } = useI18n();
    const { toast } = useToast();
    const [token, setToken] = useState('');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [loading, setLoading] = useState(false);
    const [complete, setComplete] = useState(false);

    useEffect(() => {
        const resetToken = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
        setToken(resetToken);
        if (resetToken) {
            window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        }
    }, []);

    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (password !== confirmation) {
            toast('Die Passwörter stimmen nicht überein.', 'error');
            return;
        }

        setLoading(true);
        try {
            const response = await fetch('/api/password-reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, newPassword: password })
            });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) {
                throw new Error(t(data.error || 'Passwort konnte nicht zurückgesetzt werden'));
            }
            setToken('');
            setPassword('');
            setConfirmation('');
            setComplete(true);
            toast('Dein Passwort wurde geändert. Du kannst dich jetzt mit dem neuen Passwort anmelden.', 'success');
        } catch (submitError) {
            toast(submitError instanceof Error ? submitError.message : 'Passwort konnte nicht zurückgesetzt werden', 'error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <section className="mx-auto max-w-md px-5 py-16 sm:py-24">
            <div className="theme-panel rounded-3xl border p-6 sm:p-8">
                <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Tattyhost Konto')}</p>
                <h1 className="theme-text mt-2 text-3xl font-semibold">{t('Passwort zurücksetzen')}</h1>

                {complete ? (
                    <>
                        <a className="mt-6 inline-flex rounded-xl bg-sky-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200" href="/login">
                            {t('Zur Anmeldung')}
                        </a>
                    </>
                ) : !token ? (
                    <>
                        <p className="theme-muted mt-4">{t('Der Reset-Link fehlt oder wurde bereits verwendet. Bitte fordere im Adminbereich einen neuen Link an.')}</p>
                        <a className="mt-6 inline-flex text-sm text-sky-200 underline underline-offset-4" href="/login">
                            {t('Zur Anmeldung')}
                        </a>
                    </>
                ) : (
                    <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)}>
                        <label className="block">
                            <span className="theme-muted mb-1 block text-sm">{t('Neues Passwort')}</span>
                            <input
                                className="theme-input w-full rounded-xl border px-3 py-3"
                                type="password"
                                autoComplete="new-password"
                                minLength={8}
                                maxLength={128}
                                required
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                            />
                        </label>
                        <label className="block">
                            <span className="theme-muted mb-1 block text-sm">{t('Neues Passwort wiederholen')}</span>
                            <input
                                className="theme-input w-full rounded-xl border px-3 py-3"
                                type="password"
                                autoComplete="new-password"
                                minLength={8}
                                maxLength={128}
                                required
                                value={confirmation}
                                onChange={(event) => setConfirmation(event.target.value)}
                            />
                        </label>
                        <button className="w-full rounded-xl bg-sky-300 py-3 font-semibold text-slate-950 transition hover:bg-sky-200 disabled:opacity-60" type="submit" disabled={loading}>
                            {loading ? t('Passwort wird gespeichert...') : t('Passwort speichern')}
                        </button>
                    </form>
                )}
            </div>
        </section>
    );
}
