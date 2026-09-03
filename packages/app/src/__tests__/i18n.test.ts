import { appShortName } from '@/lib/config/build-config'
import { vi } from 'vitest'

// Mock localStorage BEFORE importing i18n (i18n.init calls getUserLanguage which uses localStorage)
const mockLocalStorage = (() => {
  let store: { [key: string]: string } = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    getAll: () => ({ ...store }),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
});
vi.stubGlobal('localStorage', mockLocalStorage)

// Use dynamic import so i18n loads after localStorage mock is set up
let i18n: Awaited<typeof import('../lib/i18n')['default']>;
let changeLanguage: (lang: string) => void;

describe('i18n Functions', () => {
  beforeAll(async () => {
    const mod = await import('../lib/i18n');
    i18n = mod.default;
    changeLanguage = mod.changeLanguage;
  });

  beforeEach(() => {
    mockLocalStorage.clear();
  });

  test('should initialize with default language', () => {
    expect(i18n.language).toBeDefined();
  });

  test('should change language and persist in localStorage', async () => {
    const newLanguage = 'zh-CN';
    changeLanguage(newLanguage);
    expect(localStorage.getItem(`${appShortName}-language`)).toBe(newLanguage);
    await i18n.changeLanguage(newLanguage);
    expect(i18n.language).toBe(newLanguage);
  });

  test('should translate common phrases', () => {
    const saveText = i18n.t('common.save');
    expect(saveText).toBeDefined();
    expect(typeof saveText).toBe('string');
  });
});
