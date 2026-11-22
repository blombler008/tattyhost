import { createContext, useContext } from 'react';

export type Language = 'de' | 'en';
export type PreferenceUpdate = { language?: Language; darkMode?: boolean };
export type I18nContextValue = {
    language: Language;
    darkMode: boolean;
    ready: boolean;
    t: (german: string, values?: Record<string, string | number>) => string;
    setLanguage: (language: Language) => void;
    setDarkMode: (darkMode: boolean) => void;
    savePreferences: (update: PreferenceUpdate) => Promise<void>;
};

export const I18nContext = createContext<I18nContextValue | null>(null);

export function useI18n() {
    const context = useContext(I18nContext);
    if (!context) throw new Error('useI18n must be used within I18nProvider');
    return context;
}
