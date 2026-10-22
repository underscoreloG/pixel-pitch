// On-screen controls for touch screens: a virtual stick on the left (full
// tilt sprints), kick buttons on the right, a pause button at the top.
// Several fingers at once; each is tracked by its pointer id.

export interface TouchState {
  moveX: number;
  moveY: number;
  sprint: boolean;
  pass: boolean;
  shoot: boolean;
  lob: boolean;
  through: boolean;
  finesse: boolean;
  switch: boolean;
}

type Button = Exclude<keyof TouchState, 'moveX' | 'moveY' | 'sprint'>;

const BUTTONS: { key: Button; label: string }[] = [
  { key: 'lob', label: 'LOB' },
  { key: 'through', label: 'THRU' },
  { key: 'finesse', label: 'CURL' },
  { key: 'pass', label: 'PASS' },
  { key: 'shoot', label: 'SHOOT' },
  { key: 'switch', label: 'SWAP' },
];

/** Stick travel (px) for full deflection; beyond 95% of it, the player sprints. */
const STICK_RADIUS = 46;

export const touch: TouchState = {
  moveX: 0,
  moveY: 0,
  sprint: false,
  pass: false,
  shoot: false,
  lob: false,
  through: false,
  finesse: false,
  switch: false,
};

export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);

let root: HTMLElement | null = null;

/** Shows or hides the controls (only ever shown on a touch screen). */
export function showTouchControls(on: boolean): void {
  if (!isTouchDevice()) return;
  if (!root) root = build();
  root.hidden = !on;
  if (!on) reset();
}

/** Keeps a finger's moves and release coming to the control it started on, if the browser allows it. */
function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Not an active pointer (or not supported): the control still works without capture.
  }
}

function reset(): void {
  Object.assign(touch, { moveX: 0, moveY: 0, sprint: false });
  for (const b of BUTTONS) touch[b.key] = false;
}

function build(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'touch';
  el.innerHTML =
    `<div class="stick"><div class="knob"></div></div>` +
    `<div class="pad">${BUTTONS.map((b) => `<button data-k="${b.key}">${b.label}</button>`).join('')}</div>` +
    `<button class="pause" aria-label="Pause">II</button>`;
  document.body.appendChild(el);

  const stick = el.querySelector<HTMLElement>('.stick')!;
  const knob = el.querySelector<HTMLElement>('.knob')!;
  let stickId = -1;
  const moveStick = (e: PointerEvent) => {
    const r = stick.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > STICK_RADIUS) {
      dx = (dx / d) * STICK_RADIUS;
      dy = (dy / d) * STICK_RADIUS;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    touch.moveX = dx / STICK_RADIUS;
    touch.moveY = dy / STICK_RADIUS;
    touch.sprint = d >= STICK_RADIUS * 0.95;
  };
  stick.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId;
    capture(stick, e.pointerId);
    moveStick(e);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) moveStick(e);
  });
  const release = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    stickId = -1;
    knob.style.transform = '';
    Object.assign(touch, { moveX: 0, moveY: 0, sprint: false });
  };
  stick.addEventListener('pointerup', release);
  stick.addEventListener('pointercancel', release);

  for (const btn of el.querySelectorAll<HTMLButtonElement>('.pad button')) {
    const key = btn.dataset.k as Button;
    const set = (on: boolean) => {
      touch[key] = on;
      btn.classList.toggle('on', on);
    };
    btn.addEventListener('pointerdown', (e) => {
      capture(btn, e.pointerId);
      set(true);
    });
    btn.addEventListener('pointerup', () => set(false));
    btn.addEventListener('pointercancel', () => set(false));
  }
  el.querySelector('.pause')!.addEventListener('click', () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
  );
  return el;
}
