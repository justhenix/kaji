import { broadcastSettings, DEFAULT_SETTINGS, fetchEngineStatus, fetchSettings, onRuntimeUpdate, onSettingsUpdated, persistSettings } from './ipc';
import { statusFromRuntime } from './status';
import type { AppSettings, EngineGuiStatus } from './types';

type Listener = (source: 'draft' | 'external' | 'status' | 'saved') => void;

class SettingsStore {
  private committed: AppSettings = { ...DEFAULT_SETTINGS };
  private draft: AppSettings = { ...DEFAULT_SETTINGS };
  private engineStatus: EngineGuiStatus = {
    phase: 'offline',
    reason: '',
    mode: 'assist',
    head_control_active: false,
    voice_active: false,
    is_paused: false,
    session_id: 0,
  };
  private isLoaded = false;
  private isDirty = false;
  private changedFields = new Set<keyof AppSettings>();
  private pendingSave: Promise<void> | null = null;
  private listeners: Set<Listener> = new Set();

  async init(): Promise<void> {
    if (this.isLoaded) return;
    const s = await fetchSettings();
    this.committed = { ...s };
    this.draft = { ...s };
    await this.refreshEngineStatus();
    this.isLoaded = true;
    this.isDirty = false;

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyAppearance());

    onSettingsUpdated((newSettings) => {
      const pending = Object.fromEntries([...this.changedFields].map((key) => [key, this.draft[key]]));
      this.committed = { ...newSettings };
      this.draft = { ...newSettings, ...pending };
      this.notify('external');
    });

    const unlisten = onRuntimeUpdate((runtime) => this.updateEngineStatus(statusFromRuntime(runtime)));
    window.addEventListener('pagehide', unlisten, { once: true });
    this.notify('saved');
  }

  get settings(): AppSettings {
    return this.draft;
  }

  get committedSettings(): AppSettings {
    return this.committed;
  }

  get status(): EngineGuiStatus {
    return this.engineStatus;
  }

  get dirty(): boolean {
    return this.isDirty;
  }

  setDraftField<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.draft[key] = value;
    if (this.committed[key] === value) this.changedFields.delete(key);
    else this.changedFields.add(key);
    this.isDirty = this.changedFields.size > 0;
    this.notify('draft');
  }

  updateEngineStatus(partial: Partial<EngineGuiStatus>): void {
    this.engineStatus = { ...this.engineStatus, ...partial };
    this.notify('status');
  }

  async refreshEngineStatus(): Promise<void> {
    try {
      this.updateEngineStatus(await fetchEngineStatus());
    } catch {
      this.updateEngineStatus({ phase: 'offline', head_control_active: false, voice_active: false });
    }
  }

  saveDraft(): Promise<void> {
    const snapshot = { ...this.draft };
    const saving = (async () => {
      await persistSettings(snapshot);
      broadcastSettings(snapshot);
      this.committed = snapshot;
      this.changedFields = new Set((Object.keys(snapshot) as (keyof AppSettings)[]).filter((key) => this.draft[key] !== snapshot[key]));
      this.isDirty = this.changedFields.size > 0;
      this.notify('saved');
    })();
    this.pendingSave = saving;
    return saving.finally(() => {
      if (this.pendingSave === saving) this.pendingSave = null;
    });
  }

  async waitForPendingSave(): Promise<void> {
    await this.pendingSave;
  }

  discardDraft(): void {
    this.draft = { ...this.committed };
    this.isDirty = false;
    this.changedFields.clear();
    this.notify('saved');
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(source: Parameters<Listener>[0]): void {
    this.applyAppearance();
    for (const listener of this.listeners) {
      try {
        listener(source);
      } catch (e) {
        console.error('Listener error in store', e);
      }
    }
  }

  private applyAppearance(): void {
    const theme = this.draft.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : this.draft.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = this.draft.accent_color;
  }
}

export const store = new SettingsStore();
