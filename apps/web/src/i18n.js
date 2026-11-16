import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// UI is English. Kiswahili strings cover patient-facing outputs (receipts, SMS,
// cards) as those screens arrive; shell strings are translated already.
const resources = {
  en: {
    translation: {
      appName: 'Afyazuri',
      tagline: 'Every department on one system',
      signIn: 'Sign in',
      signingIn: 'Signing in…',
      signOut: 'Sign out',
      username: 'Username',
      password: 'Password',
      totpCode: 'Authenticator code',
      online: 'Online',
      offline: 'Offline',
      nav: {
        home: 'Home',
        patients: 'Patients',
        breakGlass: 'Emergency access',
        users: 'Staff',
        roles: 'Roles & permissions',
        facility: 'Facility setup',
        audit: 'Audit log',
        account: 'My account',
      },
    },
  },
  sw: {
    translation: {
      appName: 'Afyazuri',
      tagline: 'Idara zote katika mfumo mmoja',
      signIn: 'Ingia',
      signingIn: 'Inaingia…',
      signOut: 'Toka',
      username: 'Jina la mtumiaji',
      password: 'Nenosiri',
      totpCode: 'Nambari ya uthibitisho',
      online: 'Mtandaoni',
      offline: 'Nje ya mtandao',
      nav: {
        home: 'Nyumbani',
        patients: 'Wagonjwa',
        breakGlass: 'Ufikiaji wa dharura',
        users: 'Wafanyakazi',
        roles: 'Majukumu na ruhusa',
        facility: 'Mpangilio wa kituo',
        audit: 'Kumbukumbu za ukaguzi',
        account: 'Akaunti yangu',
      },
    },
  },
};

const stored = (() => {
  try {
    return localStorage.getItem('az.lang');
  } catch {
    return null;
  }
})();

i18n.use(initReactI18next).init({
  resources,
  lng: stored ?? 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export const setLanguage = (lng) => {
  i18n.changeLanguage(lng);
  try {
    localStorage.setItem('az.lang', lng);
  } catch {
    /* storage unavailable */
  }
};

export default i18n;
