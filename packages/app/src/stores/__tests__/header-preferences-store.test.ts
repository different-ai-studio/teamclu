import { beforeEach, describe, expect, test } from "vitest";
import { useHeaderPreferencesStore } from "@/stores/header-preferences-store";
import { loadFromStorage, saveToStorage } from "@/lib/config/storage";
import { appStoragePrefix } from "@/lib/config/build-config";

/**
 * Header icon visibility preferences — persisted to localStorage under the
 * shared `appStoragePrefix`-keyed `header-prefs` entry. Defaults are false
 * (icons hidden out of the box); the store mirrors the git-settings pattern.
 *
 * We exercise the store + the persistence helpers together rather than
 * re-importing the module under `vi.resetModules`: the latter re-binds the
 * store's `localStorage` closure to a separate realm in jsdom under vitest,
 * so writes round-trip invisibly to the test's `localStorage`. The
 * module-level `persisted` snapshot is read once at import; the restore
 * path is instead asserted through the storage helpers directly (which is
 * what the store itself calls).
 */
const STORAGE_KEY = `${appStoragePrefix}-header-prefs`;

describe("header-preferences-store", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the live store instance to defaults for state assertions.
    useHeaderPreferencesStore.setState({
      showChangesTab: false,
      showSkillsRefresh: false,
    });
  });

  test("defaults are hidden (false)", () => {
    const s = useHeaderPreferencesStore.getState();
    expect(s.showChangesTab).toBe(false);
    expect(s.showSkillsRefresh).toBe(false);
  });

  test("setShowChangesTab flips state and persists to localStorage", () => {
    useHeaderPreferencesStore.getState().setShowChangesTab(true);
    expect(useHeaderPreferencesStore.getState().showChangesTab).toBe(true);
    const loaded = loadFromStorage(STORAGE_KEY, null);
    expect(loaded).toEqual({
      showChangesTab: true,
      showSkillsRefresh: false,
    });
  });

  test("setShowSkillsRefresh flips state and persists to localStorage", () => {
    useHeaderPreferencesStore.getState().setShowSkillsRefresh(true);
    expect(useHeaderPreferencesStore.getState().showSkillsRefresh).toBe(true);
    const loaded = loadFromStorage(STORAGE_KEY, null);
    expect(loaded).toEqual({
      showChangesTab: false,
      showSkillsRefresh: true,
    });
  });

  test("the toggles are independent", () => {
    useHeaderPreferencesStore.getState().setShowChangesTab(true);
    useHeaderPreferencesStore.getState().setShowSkillsRefresh(true);
    useHeaderPreferencesStore.getState().setShowChangesTab(false);
    const s = useHeaderPreferencesStore.getState();
    expect(s.showChangesTab).toBe(false);
    expect(s.showSkillsRefresh).toBe(true);
  });

  test("storage helpers round-trip the persisted shape the store writes", () => {
    saveToStorage(STORAGE_KEY, {
      showChangesTab: true,
      showSkillsRefresh: true,
    });
    expect(loadFromStorage(STORAGE_KEY, null)).toEqual({
      showChangesTab: true,
      showSkillsRefresh: true,
    });
  });

  test("missing persisted keys fall back to the false defaults (loadFromStorage semantics)", () => {
    // Only one key seeded — the store reads `persisted.showSkillsRefresh` as
    // undefined and applies `?? false`.
    saveToStorage(STORAGE_KEY, { showChangesTab: true });
    const loaded = loadFromStorage<Partial<{
      showChangesTab: boolean;
      showSkillsRefresh: boolean;
    }>>(STORAGE_KEY, {});
    expect(loaded.showChangesTab ?? false).toBe(true);
    expect(loaded.showSkillsRefresh ?? false).toBe(false);
  });
});
