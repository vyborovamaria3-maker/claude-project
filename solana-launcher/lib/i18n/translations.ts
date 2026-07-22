import en from "./messages/en.json";
import ar from "./messages/ar.json";
import de from "./messages/de.json";
import es from "./messages/es.json";
import fr from "./messages/fr.json";
import he from "./messages/he.json";
import it from "./messages/it.json";
import ja from "./messages/ja.json";
import ko from "./messages/ko.json";
import pt from "./messages/pt.json";
import ru from "./messages/ru.json";
import zh from "./messages/zh.json";

export const TRANSLATIONS = {
  en,
  ar,
  de,
  es,
  fr,
  he,
  it,
  ja,
  ko,
  pt,
  ru,
  zh,
} as const;

export type TranslationLocale = keyof typeof TRANSLATIONS;
export type TranslationKey = keyof typeof en;

export function hasTranslationLocale(locale: string): locale is TranslationLocale {
  return locale in TRANSLATIONS;
}

export function getMessages(locale: string) {
  const messages = hasTranslationLocale(locale) ? TRANSLATIONS[locale] : TRANSLATIONS.en;

  return {
    ...TRANSLATIONS.en,
    ...messages,
  };
}
