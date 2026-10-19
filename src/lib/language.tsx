import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type Language = 'ar' | 'en';
type LanguageValue = { language: Language; toggleLanguage: () => void; text: (ar: string, en: string) => string; number: (value: number) => string };
const LanguageContext = createContext<LanguageValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try { return localStorage.getItem('bilhanah:language:v1') === 'en' ? 'en' : 'ar'; } catch { return 'ar'; }
  });
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    document.title = language === 'ar' ? 'بالهنا | منيو يفتح النفس' : 'Bilhanah | A menu worth opening';
    try { localStorage.setItem('bilhanah:language:v1', language); } catch { /* Storage is optional. */ }
  }, [language]);
  const value: LanguageValue = {
    language,
    toggleLanguage: () => setLanguage(current => current === 'ar' ? 'en' : 'ar'),
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
