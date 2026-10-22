import { sfx } from '../audio/sfx';
import { type Settings, saveSettings } from './settings';

// DOM overlay menus: crisp pixel font text at any size, keyboard and mouse.
// Arrows move, Enter/Space/S select, Left/Right change options, Esc goes back or pauses.

export const GAME_TITLE = 'PIXEL PITCH';

export type Mode = 'match' | 'training';
type Screen = 'main' | 'options' | 'pause' | 'result';

export interface MenuActions {
  start(mode: Mode): void;
  pause(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  settingsChanged(s: Settings): void;
}

interface Item {
  label: () => string;
  select?: () => void;
  change?: (dir: 1 | -1) => void;
}

const LENGTHS: Settings['matchMinutes'][] = [3, 5, 8];
const LEVELS = ['EASY', 'NORMAL', 'HARD'];
const CAMERAS: Settings['camera'][] = ['close', 'normal', 'wide'];

export class Menu {
  private root = document.getElementById('menu')!;
  private screen: Screen | null = 'main';
  private items: Item[] = [];
  private index = 0;
  private resultText = '';
  /** True while a match or training session is in progress (Esc pauses it). */
  inGame = false;

  constructor(
    private settings: Settings,
    private actions: MenuActions,
  ) {
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (!el) return;
      sfx.unlock();
      this.index = Number(el.dataset.i);
      this.activate(1);
    });
    this.root.addEventListener('mousemove', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (el && Number(el.dataset.i) !== this.index) {
        this.index = Number(el.dataset.i);
        this.render();
      }
    });
    this.show('main');
  }

  get isOpen(): boolean {
    return this.screen !== null;
  }

  show(screen: Screen | null, resultText = ''): void {
    this.screen = screen;
    this.index = 0;
    this.resultText = resultText;
    this.items = screen ? this.build(screen) : [];
    this.render();
  }

  private build(screen: Screen): Item[] {
    const s = this.settings;
    const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
      s[key] = value;
      saveSettings(s);
      this.actions.settingsChanged(s);
    };
    const cycle = <T>(list: T[], cur: T, dir: 1 | -1) => list[(list.indexOf(cur) + dir + list.length) % list.length];
    switch (screen) {
      case 'main':
        return [
          { label: () => 'MATCH', select: () => this.go(() => this.actions.start('match')) },
          { label: () => 'TRAINING', select: () => this.go(() => this.actions.start('training')) },
          { label: () => 'OPTIONS', select: () => this.show('options') },
        ];
      case 'options':
        return [
          { label: () => `SOUND      ${s.sound ? 'ON' : 'OFF'}`, change: () => set('sound', !s.sound) },
          { label: () => `CROWD      ${s.crowd ? 'ON' : 'OFF'}`, change: () => set('crowd', !s.crowd) },
          {
            label: () => `MATCH      ${s.matchMinutes} MIN`,
            change: (d) => set('matchMinutes', cycle(LENGTHS, s.matchMinutes, d)),
          },
          {
            label: () => `DIFFICULTY ${LEVELS[s.difficulty]}`,
            change: (d) => set('difficulty', ((s.difficulty + d + 3) % 3) as Settings['difficulty']),
          },
          { label: () => `AIM GUIDE  ${s.aimGuide ? 'ON' : 'OFF'}`, change: () => set('aimGuide', !s.aimGuide) },
          { label: () => `KICKS      ${s.assist ? 'ASSISTED' : 'MANUAL'}`, change: () => set('assist', !s.assist) },
          {
            label: () => `CAMERA     ${s.camera.toUpperCase()}`,
            change: (d) => set('camera', cycle(CAMERAS, s.camera, d)),
          },
          { label: () => `CONTROLS   ${s.showHelp ? 'SHOW' : 'HIDE'}`, change: () => set('showHelp', !s.showHelp) },
          { label: () => 'BACK', select: () => this.back() },
        ];
      case 'pause':
        return [
          { label: () => 'RESUME', select: () => this.go(() => this.actions.resume()) },
          { label: () => 'RESTART', select: () => this.go(() => this.actions.restart()) },
          { label: () => 'OPTIONS', select: () => this.show('options') },
          { label: () => 'MAIN MENU', select: () => this.toMain() },
        ];
      case 'result':
        return [
          { label: () => 'PLAY AGAIN', select: () => this.go(() => this.actions.restart()) },
          { label: () => 'MAIN MENU', select: () => this.toMain() },
        ];
    }
  }

  private go(fn: () => void): void {
    this.show(null);
    this.inGame = true;
    fn();
  }

  private toMain(): void {
    this.inGame = false;
    this.actions.quit();
    this.show('main');
  }

  private back(): void {
    if (this.screen === 'options') this.show(this.inGame ? 'pause' : 'main');
    else if (this.screen === 'pause') this.go(() => this.actions.resume());
  }

  private activate(dir: 1 | -1): void {
    const item = this.items[this.index];
    if (!item) return;
    sfx.blip();
    if (item.change) {
      item.change(dir);
      this.render();
    } else item.select?.();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.screen) {
      if (e.key === 'Escape' && this.inGame) {
        this.actions.pause();
        this.show('pause');
      }
      return;
    }
    sfx.unlock();
    switch (e.key) {
      case 'ArrowUp':
        this.index = (this.index - 1 + this.items.length) % this.items.length;
        sfx.blip();
        break;
      case 'ArrowDown':
        this.index = (this.index + 1) % this.items.length;
        sfx.blip();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (this.items[this.index]?.change) this.activate(e.key === 'ArrowLeft' ? -1 : 1);
        break;
      case 'Enter':
      case ' ':
      case 's':
      case 'S':
        this.activate(1);
        break;
      case 'Escape':
      case 'Backspace':
        this.back();
        break;
      default:
        return;
    }
    e.preventDefault();
    this.render();
  }

  private render(): void {
    if (!this.screen) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    const heading =
      this.screen === 'main'
        ? `<h1>${GAME_TITLE}</h1>`
        : this.screen === 'options'
          ? '<h2>OPTIONS</h2>'
          : this.screen === 'pause'
            ? '<h2>PAUSED</h2>'
            : `<h2>FULL TIME</h2><p class="result">${this.resultText}</p>`;
    const list = this.items
      .map(
        (it, i) =>
          `<li data-i="${i}" class="${i === this.index ? 'on' : ''}${it.change ? ' opt' : ''}">${it.label()}</li>`,
      )
      .join('');
    const hint =
      this.screen === 'options'
        ? 'LEFT/RIGHT CHANGE | ESC BACK'
        : 'ARROWS MOVE | ENTER SELECT' + (this.screen === 'pause' ? ' | ESC RESUME' : '');
    const version = this.screen === 'main' ? `<p class="version">v${__APP_VERSION__}</p>` : '';
    this.root.innerHTML = `<div class="panel">${heading}<ul>${list}</ul><p class="hint">${hint}</p>${version}</div>`;
  }
}
