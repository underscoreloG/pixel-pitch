import { sfx } from '../audio/sfx';
import { type Settings, saveSettings } from './settings';

// DOM overlay menus: crisp pixel font text at any size, keyboard and mouse.
// Arrows move, Enter/Space/S select, Left/Right change options, Esc goes back or pauses.

export const GAME_TITLE = 'PIXEL PITCH';

export type Mode = 'match' | 'training';
type Screen = 'main' | 'options' | 'pause' | 'result' | 'controls' | 'subs';
type Command = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'pause';

const KEY_COMMANDS: Record<string, Command> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  ' ': 'select',
  s: 'select',
  S: 'select',
  Escape: 'back',
  Backspace: 'back',
};

const ARROWS = ['left', 'up', 'down', 'right'].map((d) => `<kbd class="arr ${d}"></kbd>`).join('');
/** Keyboard controls, shown on the CONTROLS screen. */
const KEYS: [string, string][] = [
  [ARROWS, 'Move'],
  ['<kbd>SHIFT</kbd>', 'Sprint'],
  ['<kbd>S</kbd>', 'Pass'],
  ['<kbd>Q</kbd>', 'Switch player'],
  ['<kbd>D</kbd>', 'Shoot'],
  ['<kbd>ESC</kbd>', 'Pause'],
  ['<kbd>A</kbd>', 'Lob / cross'],
  ['<kbd>E</kbd> + <kbd>D</kbd>', 'Curled shot'],
  ['<kbd>W</kbd>', 'Through ball'],
  ['<kbd>E</kbd> + <kbd>A</kbd>', 'Whipped cross'],
];
const TIPS = [
  'Hold a kick key to charge, release to kick.',
  'Another kick key while charging: fake.',
  'Defending: hold S to press and tackle, D to slide.',
];

export interface MenuActions {
  start(mode: Mode): void;
  pause(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  settingsChanged(s: Settings): void;
  /** Red's outfield players for the substitutions screen; null outside a match. */
  squad(): { id: number; label: string }[] | null;
  subsLeft(): number;
  /** Ask for a change at the next stoppage; false if it can't be made. */
  substitute(id: number): boolean;
}

interface Item {
  label: () => string;
  select?: () => void;
  change?: (dir: 1 | -1) => void;
}

const LENGTHS: Settings['matchMinutes'][] = [3, 5, 8];
const LEVELS = ['EASY', 'NORMAL', 'HARD'];
const CAMERAS: Settings['camera'][] = ['close', 'normal', 'wide'];
const IF_DRAWN: Settings['ifDrawn'][] = ['final', 'extra-time', 'penalties'];

export class Menu {
  private root = document.getElementById('menu')!;
  private screen: Screen | null = 'main';
  private items: Item[] = [];
  private index = 0;
  private resultText = '';
  private padHeld = [false, false, false];
  private padDir: Command | null = null;
  private padRepeatAt = 0;
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
    requestAnimationFrame(this.pollPad);
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
          { label: () => 'CONTROLS', select: () => this.show('controls') },
          { label: () => 'OPTIONS', select: () => this.show('options') },
        ];
      case 'controls':
        return [{ label: () => 'BACK', select: () => this.back() }];
      case 'subs':
        return [
          ...(this.actions.squad() ?? []).map((p) => ({
            label: () => p.label,
            select: () => {
              if (this.actions.substitute(p.id)) this.show('pause');
            },
          })),
          { label: () => 'BACK', select: () => this.back() },
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
            label: () => `IF DRAWN   ${s.ifDrawn.replace('-', ' ').toUpperCase()}`,
            change: (d) => set('ifDrawn', cycle(IF_DRAWN, s.ifDrawn, d)),
          },
          { label: () => `OFFSIDE    ${s.offside ? 'ON' : 'OFF'}`, change: () => set('offside', !s.offside) },
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
          { label: () => `KEY HINTS  ${s.showHelp ? 'SHOW' : 'HIDE'}`, change: () => set('showHelp', !s.showHelp) },
          { label: () => 'BACK', select: () => this.back() },
        ];
      case 'pause':
        return [
          { label: () => 'RESUME', select: () => this.go(() => this.actions.resume()) },
          { label: () => 'RESTART', select: () => this.go(() => this.actions.restart()) },
          ...(this.actions.squad()
            ? [{ label: () => `SUBS (${this.actions.subsLeft()} LEFT)`, select: () => this.show('subs') }]
            : []),
          { label: () => 'CONTROLS', select: () => this.show('controls') },
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
    if (this.screen === 'options' || this.screen === 'controls' || this.screen === 'subs') {
      this.show(this.inGame ? 'pause' : 'main');
    }
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
    const cmd = KEY_COMMANDS[e.key];
    if (!cmd || !this.command(cmd)) return;
    e.preventDefault();
  }

  /** One menu command from the keyboard or a gamepad. Returns false if it did nothing. */
  private command(cmd: Command): boolean {
    if (!this.screen) {
      if ((cmd === 'back' || cmd === 'pause') && this.inGame) {
        this.actions.pause();
        this.show('pause');
        return true;
      }
      return false;
    }
    sfx.unlock();
    switch (cmd) {
      case 'up':
        this.index = (this.index - 1 + this.items.length) % this.items.length;
        sfx.blip();
        break;
      case 'down':
        this.index = (this.index + 1) % this.items.length;
        sfx.blip();
        break;
      case 'left':
      case 'right':
        if (this.items[this.index]?.change) this.activate(cmd === 'left' ? -1 : 1);
        break;
      case 'select':
        this.activate(1);
        break;
      case 'back':
        this.back();
        break;
      case 'pause':
        if (this.screen === 'pause') this.go(() => this.actions.resume());
        else return false;
        break;
    }
    this.render();
    return true;
  }

  /**
   * The first gamepad drives the menus too: d-pad or stick to move (held
   * directions repeat), A selects, B goes back, Start pauses and resumes.
   */
  private pollPad = (now: number): void => {
    requestAnimationFrame(this.pollPad);
    const pad = navigator.getGamepads?.()[0];
    if (!pad) return;
    const btn = (i: number) => (pad.buttons[i]?.value ?? 0) > 0.5;
    const sx = pad.axes[0] ?? 0;
    const sy = pad.axes[1] ?? 0;
    const dir: Command | null =
      btn(12) || sy < -0.6 ? 'up' : btn(13) || sy > 0.6 ? 'down' : btn(14) || sx < -0.6 ? 'left' : btn(15) || sx > 0.6 ? 'right' : null;
    const pressed = [0, 1, 9].map(btn);
    const edge = (i: number) => pressed[i] && !this.padHeld[i];
    // Directions and buttons only count in a menu; Start also pauses a match.
    if (this.screen && dir && (dir !== this.padDir || now >= this.padRepeatAt)) {
      this.command(dir);
      this.padRepeatAt = now + (dir === this.padDir ? 140 : 380);
    }
    this.padDir = dir;
    if (this.screen && edge(0)) this.command('select');
    else if (this.screen && edge(1)) this.command('back');
    else if (edge(2)) this.command('pause');
    this.padHeld = pressed;
  };

  private heading(): string {
    switch (this.screen) {
      case 'main':
        return `<h1>${GAME_TITLE}</h1>`;
      case 'options':
        return '<h2>OPTIONS</h2>';
      case 'controls': {
        const keys = KEYS.map(([k, what]) => `<span>${k} ${what}</span>`).join('');
        return `<h2>CONTROLS</h2><div class="keys">${keys}</div><div class="tips">${TIPS.join('<br />')}</div>`;
      }
      case 'pause':
        return '<h2>PAUSED</h2>';
      case 'subs':
        return `<h2>SUBSTITUTIONS</h2><p class="tips">Pick who comes off (${this.actions.subsLeft()} left).<br />The change is made at the next stoppage.</p>`;
      default:
        return `<h2>FULL TIME</h2><p class="result">${this.resultText}</p>`;
    }
  }

  private render(): void {
    if (!this.screen) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    const heading = this.heading();
    const list = this.items
      .map(
        (it, i) =>
          `<li data-i="${i}" class="${i === this.index ? 'on' : ''}${it.change ? ' opt' : ''}">${it.label()}</li>`,
      )
      .join('');
    const hint =
      this.screen === 'options'
        ? 'LEFT/RIGHT CHANGE | ESC BACK'
        : this.screen === 'controls' || this.screen === 'subs'
          ? 'ESC BACK'
        : 'ARROWS MOVE | ENTER SELECT' + (this.screen === 'pause' ? ' | ESC RESUME' : '');
    const version = this.screen === 'main' ? `<p class="version">v${__APP_VERSION__}</p>` : '';
    this.root.innerHTML = `<div class="panel">${heading}<ul>${list}</ul><p class="hint">${hint}</p>${version}</div>`;
  }
}
