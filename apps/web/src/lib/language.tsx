import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type Language = 'ar' | 'en';
type LanguageValue = { language: Language; hasPreference: boolean; setLanguage: (language: Language) => void; toggleLanguage: () => void; text: (ar: string, en: string) => string; number: (value: number) => string };
const LanguageContext = createContext<LanguageValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [hasPreference, setHasPreference] = useState(() => {
    try { return localStorage.getItem('bilhanah:language:v1') !== null; } catch { return false; }
  });
  const [language, setLanguage] = useState<Language>(() => {
    try { return localStorage.getItem('bilhanah:language:v1') === 'en' ? 'en' : 'ar'; } catch { return 'ar'; }
  });
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    if (hasPreference) {
      try { localStorage.setItem('bilhanah:language:v1', language); } catch { /* Storage is optional. */ }
    }
  }, [language, hasPreference]);
  const value: LanguageValue = {
    language,
    hasPreference,
    // Applies a default (e.g. a restaurant's menu language) without recording it as the visitor's choice.
    setLanguage,
    toggleLanguage: () => { setHasPreference(true); setLanguage(current => current === 'ar' ? 'en' : 'ar'); },
    text: (ar, en) => language === 'ar' ? ar : en,
    number: value => new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-EG').format(value),
  };
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('LanguageProvider is required');
  return context;
}

/** Sets the tab title for the current page in the visitor's language. */
export function usePageTitle(ar: string, en: string) {
  const { language } = useLanguage();
  useEffect(() => { document.title = language === 'ar' ? ar : en; }, [language, ar, en]);
}
