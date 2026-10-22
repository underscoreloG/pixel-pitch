// Player preferences, persisted per browser. Storage can be unavailable
// (private mode, blocked site data), so every access is guarded and the game
// works with defaults.

export interface Settings {
  sound: boolean;
  crowd: boolean;
  /** Match length in real minutes. */
  matchMinutes: 3 | 5 | 8;
  difficulty: 0 | 1 | 2;
  aimGuide: boolean;
  /** How much of the pitch the camera shows. */
  camera: 'close' | 'normal' | 'wide';
  showHelp: boolean;
}

const KEY = 'pixel-pitch:settings';

export const DEFAULTS: Settings = {
  sound: true,
  crowd: false,
  matchMinutes: 5,
  difficulty: 1,
  aimGuide: true,
  camera: 'normal',
  showHelp: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not persisted; the in-memory settings still apply.
  }
}
