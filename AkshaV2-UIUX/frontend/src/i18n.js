import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Import translation files
import en from "./lacales/en/translation.json";
import ja from "./lacales/ja/translation.json";

// Get saved language from localStorage or fallback to 'en'
const savedLanguage = localStorage.getItem("i18nLang") || "en";

i18n
  .use(initReactI18next) // Passes i18n down to react-i18next
  .init({
    resources: {
      en: { translation: en },
      ja: { translation: ja }
    },
    lng: savedLanguage, // use saved language
    fallbackLng: "en", // fallback language if key not found
    interpolation: {
      escapeValue: false // react already protects from XSS
    }
  });

// Listen for language changes and save them in localStorage
i18n.on("languageChanged", (lng) => {
  localStorage.setItem("i18nLang", lng);
});

export default i18n;
