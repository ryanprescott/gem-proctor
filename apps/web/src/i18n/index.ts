import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import admin from "./locales/en/admin.json";
import auth from "./locales/en/auth.json";
import common from "./locales/en/common.json";
import errors from "./locales/en/errors.json";
import importNs from "./locales/en/import.json";
import practice from "./locales/en/practice.json";
import sources from "./locales/en/sources.json";
import tests from "./locales/en/tests.json";

/** English only in v1, every string from a namespaced catalog (SPEC §1.3). Keys are written `ns:key`. */
export const resources = { en: { admin, auth, common, errors, import: importNs, practice, sources, tests } } as const;
export const NAMESPACES = Object.keys(resources.en);

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en"],
  ns: NAMESPACES,
  defaultNS: "common",
  nsSeparator: ":",
  keySeparator: ".",
  resources,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
