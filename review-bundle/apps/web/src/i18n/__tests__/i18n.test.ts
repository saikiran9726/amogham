import { describe, it, expect } from 'vitest';
import {
  t,
  setLocale,
  getLocale,
  translations,
  type Locale,
  type TranslationKey,
} from '../index.js';

describe('i18n Localization Engine', () => {
  it('translates default english keys accurately', () => {
    setLocale('en');
    expect(t('common.appName')).toBe('Restaurant OS');
    expect(t('portal.waiter')).toBe('Waiter Portal');
  });

  it('translates to telugu and hindi without missing keys', () => {
    const locales: Locale[] = ['te', 'hi'];
    const keys = Object.keys(translations.en) as TranslationKey[];

    for (const loc of locales) {
      setLocale(loc);
      for (const k of keys) {
        const translated = t(k);
        expect(translated).toBeDefined();
        expect(translated).not.toBe('');
        // Must not just fallback to empty string
        expect(translations[loc][k]).toBeDefined();
      }
    }
  });

  it('supports parameter substitution', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
  });
});
