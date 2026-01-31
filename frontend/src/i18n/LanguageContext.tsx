import { createContext, useContext, useState, ReactNode } from 'react';
import {
  Language,
  Translations,
  translations,
  getBrowserLanguage,
  getStoredLanguage,
  setStoredLanguage
} from './translations';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    // Check localStorage first, then browser language
    return getStoredLanguage() || getBrowserLanguage();
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    setStoredLanguage(lang);
  };

  const t = translations[language];

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}

// Helper function for string interpolation
export function interpolate(str: string, values: Record<string, string | number>): string {
  return str.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
}
