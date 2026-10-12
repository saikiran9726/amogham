export type Locale = 'en' | 'te' | 'hi';

export const enTranslations = {
  // Common
  'common.appName': 'Restaurant OS',
  'common.online': 'Online',
  'common.offline': 'Offline (Changes will queue locally)',
  'common.syncing': 'Syncing changes...',
  'common.retry': 'Retry',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.back': 'Back',
  'common.loading': 'Loading...',
  'common.noData': 'No data available',
  'common.devTools': 'Component Library',
  'common.dismiss': 'Dismiss',
  'common.update': 'Update',
  'common.confirm': 'Confirm',

  // Portals
  'portal.waiter': 'Waiter Portal',
  'portal.kitchen': 'Kitchen Display System',
  'portal.owner': 'Owner Dashboard',

  // Kitchen specific
  'kitchen.rushMode': 'Rush Mode',
  'kitchen.rushModeActive': 'Rush Mode Active',
  'kitchen.clock': 'Kitchen Clock',
  'kitchen.liveOrders': 'Live Orders',
  'kitchen.completed': 'Completed',
  'kitchen.allStations': 'All Stations',

  // Waiter specific
  'waiter.tables': 'Tables',
  'waiter.activeOrders': 'Active Orders',
  'waiter.quickBill': 'Quick Bill',
  'waiter.notifications': 'Alerts',

  // Owner specific
  'owner.overview': 'Overview',
  'owner.liveSales': 'Live Sales',
  'owner.menuAnalytics': 'Menu Performance',
  'owner.staff': 'Staff & Tables',
  'owner.settings': 'Settings',

  // Statuses
  'status.new': 'New Order',
  'status.preparing': 'Preparing',
  'status.ready': 'Ready to Serve',
  'status.late': 'Delayed',
  'status.overdue': 'Overdue',

  // Auth & Placeholders
  'auth.signInRequired': 'Sign In Required',
  'auth.notAvailableYet': 'Sign in with your staff credentials to continue.',
  'auth.login': 'Log In',
  'auth.username': 'Username or Email',
  'auth.password': 'Password',
} as const;

export type TranslationKey = keyof typeof enTranslations;

export const teTranslations: Record<TranslationKey, string> = {
  'common.appName': 'రెస్టారెంట్ OS',
  'common.online': 'ఆన్‌లైన్',
  'common.offline': 'ఆఫ్‌లైన్ (మార్పులు స్థానికంగా నిల్వ చేయబడతాయి)',
  'common.syncing': 'సింక్ అవుతోంది...',
  'common.retry': 'మళ్ళీ ప్రయత్నించండి',
  'common.close': 'మూసివేయి',
  'common.save': 'భద్రపరచు',
  'common.cancel': 'రద్దు చేయి',
  'common.delete': 'తొలగించు',
  'common.edit': 'సవరించు',
  'common.back': 'వెనుకకు',
  'common.loading': 'లోడ్ అవుతోంది...',
  'common.noData': 'సమాచారం అందుబాటులో లేదు',
  'common.devTools': 'డెవలపర్ సాధనాలు',
  'common.dismiss': 'రద్దు చేయి',
  'common.update': 'నవీకరించు',
  'common.confirm': 'నిర్ధారించు',

  'portal.waiter': 'వెయిటర్ పోర్టల్',
  'portal.kitchen': 'కిచెన్ డిస్‌ప్లే సిస్టమ్',
  'portal.owner': 'యజమాని డాష్‌బోర్డ్',

  'kitchen.rushMode': 'రష్ మోడ్',
  'kitchen.rushModeActive': 'రష్ మోడ్ ప్రారంభించబడింది',
  'kitchen.clock': 'కిచెన్ గడియారం',
  'kitchen.liveOrders': 'ప్రత్యక్ష ఆర్డర్‌లు',
  'kitchen.completed': 'పూర్తయినవి',
  'kitchen.allStations': 'అన్ని స్టేషన్లు',

  'waiter.tables': 'టేబుల్స్',
  'waiter.activeOrders': 'యాక్టివ్ ఆర్డర్‌లు',
  'waiter.quickBill': 'త్వరిత బిల్లు',
  'waiter.notifications': 'హెచ్చరికలు',

  'owner.overview': 'అవలోకనం',
  'owner.liveSales': 'ప్రత్యక్ష అమ్మకాలు',
  'owner.menuAnalytics': 'మెనూ విశ్లేషణ',
  'owner.staff': 'సిబ్బంది & టేబుల్స్',
  'owner.settings': 'సెట్టింగులు',

  'status.new': 'కొత్త ఆర్డర్',
  'status.preparing': 'తయారవుతోంది',
  'status.ready': 'వడ్డించడానికి సిద్ధం',
  'status.late': 'ఆలస్యం',
  'status.overdue': 'గడువు ముగిసింది',

  'auth.signInRequired': 'లాగిన్ అవసరం',
  'auth.notAvailableYet': 'కొనసాగడానికి మీ సిబ్బంది వివరాలతో లాగిన్ అవ్వండి.',
  'auth.login': 'లాగిన్',
  'auth.username': 'యూజర్‌పేరు లేదా ఈమెయిల్',
  'auth.password': 'పాస్‌వర్డ్',
};

export const hiTranslations: Record<TranslationKey, string> = {
  'common.appName': 'रेस्टोरेंट OS',
  'common.online': 'ऑनलाइन',
  'common.offline': 'ऑफ़लाइन (बदलाव स्थानीय रूप से कतारबद्ध होंगे)',
  'common.syncing': 'सिंक हो रहा है...',
  'common.retry': 'पुनः प्रयास करें',
  'common.close': 'बंद करें',
  'common.save': 'सहेजें',
  'common.cancel': 'रद्द करें',
  'common.delete': 'हटाएं',
  'common.edit': 'संपादित करें',
  'common.back': 'वापस',
  'common.loading': 'लोड हो रहा है...',
  'common.noData': 'कोई डेटा उपलब्ध नहीं है',
  'common.devTools': 'डेवलपर टूल्स',
  'common.dismiss': 'खारिज करें',
  'common.update': 'अपडेट करें',
  'common.confirm': 'पुष्टि करें',

  'portal.waiter': 'वेटर पोर्टल',
  'portal.kitchen': 'किचन डिस्प्ले सिस्टम',
  'portal.owner': 'ओनर डैशबोर्ड',

  'kitchen.rushMode': 'रश मोड',
  'kitchen.rushModeActive': 'रश मोड सक्रिय',
  'kitchen.clock': 'किचन घड़ी',
  'kitchen.liveOrders': 'सक्रिय ऑर्डर',
  'kitchen.completed': 'पूर्ण',
  'kitchen.allStations': 'सभी स्टेशन',

  'waiter.tables': 'टेबल्स',
  'waiter.activeOrders': 'सक्रिय ऑर्डर',
  'waiter.quickBill': 'त्वरित बिल',
  'waiter.notifications': 'अलर्ट्स',

  'owner.overview': 'अवलोकन',
  'owner.liveSales': 'लाइव बिक्री',
  'owner.menuAnalytics': 'मेनू विश्लेषण',
  'owner.staff': 'कर्मचारी और टेबल्स',
  'owner.settings': 'सेटिंग्स',

  'status.new': 'नया ऑर्डर',
  'status.preparing': 'तैयार हो रहा है',
  'status.ready': 'परोसने के लिए तैयार',
  'status.late': 'विलंबित',
  'status.overdue': 'अतिदेय',

  'auth.signInRequired': 'साइन इन आवश्यक है',
  'auth.notAvailableYet': 'जारी रखने के लिए अपने स्टाफ क्रेडेंशियल से लॉग इन करें।',
  'auth.login': 'लॉग इन करें',
  'auth.username': 'उपयोगकर्ता नाम या ईमेल',
  'auth.password': 'पासवर्ड',
};

export const translations: Record<Locale, Record<TranslationKey, string>> = {
  en: enTranslations,
  te: teTranslations,
  hi: hiTranslations,
};

let currentLocale: Locale = 'en';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Universal translation helper.
 * Replaces placeholders like {name} with param values.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const dict = translations[currentLocale] || translations.en;
  let text = dict[key] || translations.en[key] || key;

  if (params) {
    for (const [paramKey, val] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(val));
    }
  }

  return text;
}
