import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import deLocale from '../languages/de.json';
import enLocale from '../languages/en.json';
import { I18nContext, type Language, type PreferenceUpdate } from './i18n-context';

function normalizeLanguage(language: string | null | undefined): Language {
    return language === 'en' ? 'en' : 'de';
}

function applyDocumentPreferences(language: Language, darkMode: boolean) {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    const locale: Record<string, string> = language === 'en' ? enLocale : deLocale;
    document.title = locale['Seitentitel'] || 'Tattyhost Netzwerk';
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description && locale['Meta-Beschreibung']) description.content = locale['Meta-Beschreibung'];
}

export function I18nProvider({ children, isLoggedIn }: { children: React.ReactNode; isLoggedIn: boolean }) {
    const [language, setLanguageState] = useState<Language>('de');
    const [darkMode, setDarkModeState] = useState(true);
    const [ready, setReady] = useState(!isLoggedIn);
    const preferenceRevision = useRef(0);
    const preferenceSaveQueue = useRef<Promise<void>>(Promise.resolve());

    const setLanguage = useCallback((nextLanguage: Language) => {
        preferenceRevision.current += 1;
        setLanguageState(nextLanguage);
        document.documentElement.lang = nextLanguage;
        localStorage.setItem('tattyhost-language', nextLanguage);
    }, []);

    const setDarkMode = useCallback((nextDarkMode: boolean) => {
        preferenceRevision.current += 1;
        setDarkModeState(nextDarkMode);
        document.documentElement.dataset.theme = nextDarkMode ? 'dark' : 'light';
        localStorage.setItem('tattyhost-dark-mode', String(nextDarkMode));
    }, []);

    const savePreferences = useCallback((update: PreferenceUpdate) => {
        if (update.language) setLanguage(update.language);
        if (typeof update.darkMode === 'boolean') setDarkMode(update.darkMode);

        if (!isLoggedIn) return Promise.resolve();

        const saveRequest = preferenceSaveQueue.current.then(async () => {
            const settingsResponse = await fetch('/api/settings', { credentials: 'include' });
            const settingsData = await settingsResponse.json() as {
                success: boolean;
                settings?: { language: string; timezone: string; darkMode: boolean };
                error?: string;
            };
            if (!settingsResponse.ok || !settingsData.success || !settingsData.settings) {
                throw new Error(settingsData.error || 'Einstellungen konnten nicht geladen werden');
            }

            const response = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    ...settingsData.settings,
                    ...update,
                    language: update.language || settingsData.settings.language,
                    darkMode: typeof update.darkMode === 'boolean' ? update.darkMode : settingsData.settings.darkMode
                })
            });
            const data = await response.json() as { success: boolean; error?: string };
            if (!response.ok || !data.success) {
                throw new Error(data.error || (update.language
                    ? 'Spracheinstellung konnte nicht gespeichert werden'
                    : 'Darstellung konnte nicht gespeichert werden'));
            }
        });
        preferenceSaveQueue.current = saveRequest.catch(() => undefined);
        return saveRequest;
    }, [isLoggedIn, setDarkMode, setLanguage]);

    useEffect(() => {
        applyDocumentPreferences(language, darkMode);
    }, [darkMode, language]);

    useEffect(() => {
        if (isLoggedIn) return;
        const storedLanguage = normalizeLanguage(window.localStorage.getItem('tattyhost-language'));
        const storedTheme = window.localStorage.getItem('tattyhost-dark-mode') !== 'false';
        setLanguageState(storedLanguage);
        setDarkModeState(storedTheme);
        setReady(true);
    }, [isLoggedIn]);

    useEffect(() => {
        if (!isLoggedIn) return;
        let cancelled = false;
        const revisionAtStart = preferenceRevision.current;
        async function loadPreferences() {
            try {
                const response = await fetch('/api/settings', { credentials: 'include' });
                const data = await response.json() as {
                    success: boolean;
                    settings?: { language: string; darkMode: boolean };
                    error?: string;
                };
                if (!response.ok || !data.success || !data.settings) {
                    throw new Error(data.error || 'Could not load preferences');
                }
                if (!cancelled && revisionAtStart === preferenceRevision.current) {
                    setLanguageState(normalizeLanguage(data.settings.language));
                    setDarkModeState(data.settings.darkMode);
                }
            } catch (error) {
                if (!cancelled) console.error('Loading user preferences failed:', error);
            } finally {
                if (!cancelled) setReady(true);
            }
        }
        void loadPreferences();
        return () => {
            cancelled = true;
        };
    }, [isLoggedIn]);

    const t = useCallback((german: string, values: Record<string, string | number> = {}) => {
        const locale: Record<string, string> = language === 'en' ? enLocale : deLocale;
        const template = locale[german] || german;
        return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`));
    }, [language]);

    const value = useMemo(() => ({
        language,
        darkMode,
        ready,
        t,
        setLanguage,
        setDarkMode,
        savePreferences
    }), [darkMode, language, ready, savePreferences, setDarkMode, setLanguage, t]);

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
