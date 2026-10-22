import {
  AI_LEVELS,
  CHARGE_TIME,
  DRIBBLE_SPEED_FACTOR,
  DT,
  DRIBBLE_STIFFNESS,
  GAIN_CONTROL_RADIUS,
  HUMAN_BODY_STEAL,
  HUMAN_TACKLE_REACH,
  HUMAN_TACKLE_SUCCESS,
  KEEP_CONTROL_RADIUS,
  KICK_BUFFER_TIME,
  KICK_RADIUS,
  MAX_CONTROL_HEIGHT,
  MAX_CONTROL_REL_SPEED,
  MAX_KICK_HEIGHT,
  MIN_KICK_POWER,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_ACCEL,
  PLAYER_ACCEL_WITH_BALL,
  PLAYER_DECEL,
  PLAYER_JOG_SPEED,
  PLAYER_RADIUS,
  PLAYER_SPRINT_SPEED,
  SLIDE_RANGE,
} from './constants';
import { stepBall } from './ball';
import { emit } from './events';
import { isSprinting, kickBall, receiveAt, resolveHumanKick } from './kick';
import { random, randomRange } from './rng';
import { active, byId, clamp, dist } from './team';
import { fromBehind, standingTackle, startSlide } from './tackle';
import type { Buttons, Footballer, InputFrame, KickType, MatchState, Role, Team } from './types';

const BUTTON_FOR: Record<KickType, keyof Buttons> = { pass: 'pass', shot: 'shoot', lob: 'lob', through: 'through' };
const KICK_ORDER: KickType[] = ['shot', 'pass', 'lob', 'through'];
export const FAKE_TIME = 0.35;

export function createFootballer(
  id: number,
  team: Team,
  role: Role,
  number: number,
  slot: { u: number; v: number },
): Footballer {
  return {
    id,
    team,
    role,
    number,
    slot,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facingX: team === 'home' ? 1 : -1,
    facingY: 0,
    charging: null,
    charge: 0,
    pending: null,
    kickCooldown: 0,
    kickAnim: 0,
    throwAnim: 0,
    fakeAnim: 0,
    lastFakeTick: -1,
    tackleCooldown: 0,
    tackleAnim: 0,
    slide: 0,
    slideWonBall: false,
    down: 0,
    yellow: 0,
    sentOff: false,
    gk: role === 'GK' ? { state: 'positioning', stateTimer: 0, threatTimer: 0, ignoreBall: 0, diveDir: 0, facingPenalty: false } : null,
    think: 0,
  };
}

export function tickTimers(p: Footballer, dt: number): void {
  p.kickCooldown = Math.max(0, p.kickCooldown - dt);
  p.kickAnim = Math.max(0, p.kickAnim - dt);
  p.throwAnim = Math.max(0, p.throwAnim - dt);
  p.fakeAnim = Math.max(0, p.fakeAnim - dt);
  p.tackleCooldown = Math.max(0, p.tackleCooldown - dt);
  p.tackleAnim = Math.max(0, p.tackleAnim - dt);
  p.down = Math.max(0, p.down - dt);
  p.think = Math.max(0, p.think - dt);
}

/** True when the player can move under his own control this tick. */
export function canMove(p: Footballer): boolean {
  return !p.sentOff && p.down === 0 && p.slide === 0;
}

/**
 * Steers towards (mx, my) with capped acceleration, so turns have weight.
 * Analog input scales the target speed.
 */
export function locomote(
  p: Footballer,
  mx: number,
  my: number,
  sprint: boolean,
  withBall: boolean,
  dt: number,
  speedFactor = 1,
): void {
  const mag = Math.hypot(mx, my);
  if (mag > 1) {
    mx /= mag;
    my /= mag;
  }
  const moving = mag > 0.2;
  if (moving) {
    const n = Math.hypot(mx, my);
    p.facingX = mx / n;
    p.facingY = my / n;
  }
  const feint = p.fakeAnim > 0 ? 0.55 : 1;
  const topSpeed =
    (sprint ? PLAYER_SPRINT_SPEED : PLAYER_JOG_SPEED) * (withBall ? DRIBBLE_SPEED_FACTOR : 1) * speedFactor * feint;
  const accel = !moving ? PLAYER_DECEL : withBall ? PLAYER_ACCEL_WITH_BALL : PLAYER_ACCEL;
  const tvx = moving ? mx * topSpeed : 0;
  const tvy = moving ? my * topSpeed : 0;
  const dvx = tvx - p.vx;
  const dvy = tvy - p.vy;
  const dv = Math.hypot(dvx, dvy);
  const maxDv = accel * dt;
  if (dv > maxDv) {
    p.vx += (dvx / dv) * maxDv;
    p.vy += (dvy / dv) * maxDv;
  } else {
    p.vx = tvx;
    p.vy = tvy;
  }
  p.x = clamp(p.x + p.vx * dt, -3, PITCH_LENGTH + 3);
  p.y = clamp(p.y + p.vy * dt, -3, PITCH_WIDTH + 3);
}

/** Players on the ground or sliding drift to a stop. */
export function coast(p: Footballer, dt: number): void {
  const k = Math.max(0, 1 - 6 * dt);
  p.vx *= k;
  p.vy *= k;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

/** Keeps bodies from overlapping. */
export function separate(s: MatchState): void {
  const ps = active(s);
  const min = PLAYER_RADIUS * 2;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= min || d === 0) continue;
      const push = (min - d) / 2;
      a.x -= (dx / d) * push;
      a.y -= (dy / d) * push;
      b.x += (dx / d) * push;
      b.y += (dy / d) * push;
    }
}

function canControl(p: Footballer): boolean {
  return canMove(p) && !p.gk && p.kickCooldown === 0;
}

/**
 * Who has the ball: the carrier keeps it within reach; otherwise the nearest
 * player who can trap it (slow enough, low enough) takes it. The carrier pushes
 * the ball ahead of himself, further the faster he runs. A fast ball through a
 * body is blocked.
 */
export function resolvePossession(s: MatchState): void {
  const ball = s.ball;
  if (s.players.some((p) => p.gk?.state === 'holding')) {
    s.possessor = -1;
    return;
  }
  let carrier = byId(s, s.possessor);
  if (
    carrier &&
    (!canControl(carrier) || s.setPiece || dist(carrier, ball) > KEEP_CONTROL_RADIUS || ball.z >= MAX_CONTROL_HEIGHT)
  )
    carrier = undefined;

  if (!carrier && !s.setPiece && s.phase === 'play') {
    let best = Infinity;
    for (const p of active(s)) {
      if (!canControl(p) || ball.z >= MAX_CONTROL_HEIGHT) continue;
      // The intended receiver is set for it and stretches a little further.
      const reach = p.id === s.passTarget ? 1.1 : GAIN_CONTROL_RADIUS;
      const d = dist(p, ball);
      if (d < reach && d < best && trappable(s, p)) {
        best = d;
        carrier = p;
      }
    }
  }

  if (carrier && s.phase === 'play') carrier = bodySteal(s, carrier);

  const prev = s.possessor;
  s.possessor = carrier ? carrier.id : -1;
  if (carrier) {
    if (carrier.id !== prev) {
      s.lastTouch = carrier.team;
      s.lastToucherId = carrier.id;
      s.passTarget = -1;
      if (carrier.team === 'home') s.controlled = carrier.id;
      else autoSwitch(s);
    }
    const lead = 0.45 + 0.07 * Math.hypot(carrier.vx, carrier.vy);
    const tx = carrier.x + carrier.facingX * lead;
    const ty = carrier.y + carrier.facingY * lead;
    ball.vx = carrier.vx + (tx - ball.x) * DRIBBLE_STIFFNESS;
    ball.spin = 0;
    ball.vy = carrier.vy + (ty - ball.y) * DRIBBLE_STIFFNESS;
    ball.vz = Math.min(ball.vz, 0);
    return;
  }

  if (s.phase !== 'play') return;
  for (const p of active(s)) {
    // Teammates let their own side's passes through; opponents get in the way.
    if (!canControl(p) || p.team === s.lastTouch) continue;
    if (dist(p, ball) > 0.42 || ball.z > 1.8 || trappable(s, p)) continue;
    ball.vx = -ball.vx * 0.25 + randomRange(s.rng, -2, 2);
    ball.spin = 0;
    ball.vy = ball.vy * 0.3 + randomRange(s.rng, -3, 3);
    ball.vz = Math.abs(ball.vz) * 0.3 + randomRange(s.rng, 0, 2);
    p.kickCooldown = 0.3;
    s.lastTouch = p.team;
    s.lastToucherId = p.id;
    s.passTarget = -1;
    emit(s, 'block', { team: p.team, playerId: p.id, power: 0.6 });
    break;
  }
}

/**
 * A defender who gets his body onto the dribbled ball can take it: likely for
 * the human (that's the point of closing down), occasionally for the CPU.
 */
function bodySteal(s: MatchState, carrier: Footballer): Footballer {
  for (const o of active(s)) {
    const human = o.id === s.controlled && !s.settings.autoplay;
    if (o.team === carrier.team || o.gk || !canControl(o) || dist(o, s.ball) > (human ? 0.65 : 0.55)) continue;
    const chance = human ? HUMAN_BODY_STEAL : AI_LEVELS[s.settings.difficulty].steal;
    if (random(s.rng) >= chance) continue;
    carrier.kickCooldown = 0.4;
    emit(s, 'tackle', { team: o.team, playerId: o.id, power: 0.4 });
    return o;
  }
  return carrier;
}

/** When blue wins the ball, hand control to the red player best placed to win it back. */
function autoSwitch(s: MatchState): void {
  if (s.settings.autoplay) return;
  const current = byId(s, s.controlled);
  const nearest = nearestHome(s);
  if (!nearest || !current || nearest.id === current.id) return;
  if (dist(nearest, s.ball) + 3 < dist(current, s.ball)) s.controlled = nearest.id;
}

/**
 * Can this player kill the ball? Mostly about the ball's own pace (a player
 * running onto a slow ball still traps it); the intended receiver of a pass is
 * set for it and handles firmer balls.
 */
function trappable(s: MatchState, p: Footballer): boolean {
  const ball = s.ball;
  const speed = Math.hypot(ball.vx, ball.vy);
  const rel = Math.hypot(ball.vx - p.vx, ball.vy - p.vy);
  const max = p.id === s.passTarget ? MAX_CONTROL_REL_SPEED * 2 : MAX_CONTROL_REL_SPEED;
  return speed < max && rel < max * 1.6;
}

/** Home player nearest the ball (other than the current one when asked to switch). */
export function nearestHome(s: MatchState, excludeId = -1): Footballer | undefined {
  let best: Footballer | undefined;
  let bestD = Infinity;
  for (const p of active(s)) {
    if (p.team !== 'home' || p.gk || p.id === excludeId) continue;
    const d = dist(p, s.ball);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * The human player: movement, switching, kicks (hold to charge, release to
 * kick, press another kick button while charging to fake), and tackles when
 * an opponent has the ball (pass = standing, shoot = slide).
 */
export function stepHuman(s: MatchState, input: InputFrame, dt: number): void {
  const buttons: Buttons = {
    pass: input.pass,
    shoot: input.shoot,
    lob: input.lob,
    through: input.through,
    switch: input.switch,
  };
  const pressed = (b: keyof Buttons) => buttons[b] && !s.prevButtons[b];

  let p = byId(s, s.controlled);
  if (!p || p.sentOff) p = nearestHome(s);
  if (!p) return;
  if (pressed('switch') && s.possessor !== p.id && !s.setPiece) {
    const next = nearestHome(s, p.id);
    if (next) {
      p.charging = null;
      p.pending = null;
      p = next;
    }
  }
  s.controlled = p.id;

  const carrier = byId(s, s.possessor);
  const defending = !!carrier && carrier.team !== p.team && s.phase === 'play' && canMove(p);
  // Hold pass while defending to close the carrier down: the player runs at the ball by himself,
  // and keeps after it if a tackle knocks it loose nearby.
  const looseNearby = !carrier && s.phase === 'play' && !s.setPiece && dist(p, s.ball) < 6 && canMove(p);
  const pressing = (defending || looseNearby) && buttons.pass && !p.charging;

  // A set-piece taker at the ball is locked in place: the stick only aims.
  const atDeadBall = s.setPiece?.takerId === p.id && dist(p, s.ball) < 1.2;
  // From behind, run round to get goal-side of the carrier; otherwise go straight at the ball.
  const behind = !!carrier && defending && fromBehind(p, carrier);
  if (pressing) {
    let aimX = s.ball.x + s.ball.vx * 0.15;
    let aimY = s.ball.y + s.ball.vy * 0.15;
    if (behind && carrier) {
      // Come round on whichever side he is already on, ahead of the carrier, not through his back.
      const side = Math.sign((p.x - carrier.x) * -carrier.facingY + (p.y - carrier.y) * carrier.facingX) || 1;
      aimX = carrier.x + carrier.facingX * 1.2 - carrier.facingY * side * 1.1;
      aimY = carrier.y + carrier.facingY * 1.2 + carrier.facingX * side * 1.1;
    }
    const tx = aimX - p.x;
    const ty = aimY - p.y;
    const n = Math.hypot(tx, ty) || 1;
    locomote(p, tx / n, ty / n, input.sprint, false, dt);
  } else if (s.passTarget === p.id && !carrier && canMove(p) && receiverOnAuto(s, input)) {
    // Receiving a pass: cut across to meet the ball (or run onto a through ball) until the player steers somewhere new.
    const meet = receiveAt(s, meetingPoint(s, p));
    const tx = meet.x - p.x;
    const ty = meet.y - p.y;
    const n = Math.hypot(tx, ty) || 1;
    if (n > 0.3) locomote(p, tx / n, ty / n, true, false, dt);
  } else if (atDeadBall) {
    // Lined up just behind the ball, always within kicking reach: the stick aims and he steps round it.
    const m = Math.hypot(input.moveX, input.moveY);
    if (m > 0.3) {
      p.facingX = input.moveX / m;
      p.facingY = input.moveY / m;
    }
    p.x = s.ball.x - p.facingX * 0.6;
    p.y = s.ball.y - p.facingY * 0.6;
    p.vx = p.vy = 0;
  } else if (canMove(p)) {
    locomote(p, input.moveX, input.moveY, input.sprint, s.possessor === p.id, dt);
  }

  if (defending && !p.charging && carrier) {
    const d = dist(p, carrier);
    // Holding only tackles from a fair angle; a fresh press tackles from anywhere (your risk).
    if (buttons.pass && p.tackleCooldown === 0 && d < HUMAN_TACKLE_REACH && (pressed('pass') || !behind)) {
      standingTackle(s, p, carrier, HUMAN_TACKLE_SUCCESS, HUMAN_TACKLE_REACH);
    } else if (pressed('shoot') && p.tackleCooldown === 0 && d < SLIDE_RANGE) {
      startSlide(s, p, s.ball.x - p.x, s.ball.y - p.y);
    }
  } else if (canMove(p)) {
    chargeKicks(s, p, buttons, pressed, input.finesse, dt);
  }
  s.prevButtons = buttons;

  if (p.pending) {
    if (canKickNow(s, p)) {
      const sprint = isSprinting(p, input.sprint);
      const k = resolveHumanKick(s, p, p.pending.type, p.pending.power, input.moveX, input.moveY, p.pending.finesse);
      kickBall(s, p, p.pending.type, k.power, k.dirX, k.dirY, { ...k, sprinting: sprint });
      // Control follows the pass, FIFA style; the stick used to aim it doesn't steer the receiver.
      if (k.target >= 0) {
        s.controlled = k.target;
        const m = Math.hypot(input.moveX, input.moveY);
        s.passStick = m > 0.3 ? { x: input.moveX / m, y: input.moveY / m } : null;
      }
      return;
    }
    p.pending.ttl -= dt;
    if (p.pending.ttl <= 0) p.pending = null;
  }
}

function chargeKicks(
  s: MatchState,
  p: Footballer,
  buttons: Buttons,
  pressed: (b: keyof Buttons) => boolean,
  finesse: boolean,
  dt: number,
): void {
  if (!p.charging) {
    for (const type of KICK_ORDER) {
      if (pressed(BUTTON_FOR[type])) {
        p.charging = type;
        p.charge = 0;
        return;
      }
    }
    return;
  }
  // Another kick button while charging cancels into a feint (fake shot / fake pass).
  const fake = KICK_ORDER.some((t) => t !== p.charging && pressed(BUTTON_FOR[t]));
  if (fake) {
    p.charging = null;
    p.charge = 0;
    p.pending = null;
    p.fakeAnim = FAKE_TIME;
    p.lastFakeTick = s.tick;
    emit(s, 'fake', { team: p.team, playerId: p.id });
    return;
  }
  if (buttons[BUTTON_FOR[p.charging]]) {
    p.charge = Math.min(1, p.charge + dt / CHARGE_TIME);
  } else {
    p.pending = { type: p.charging, power: Math.max(MIN_KICK_POWER, p.charge), ttl: KICK_BUFFER_TIME, finesse };
    p.charging = null;
    p.charge = 0;
  }
}

/** Earliest point on the ball's path the player can get to (where he should meet a pass). */
function meetingPoint(s: MatchState, p: Footballer): { x: number; y: number } {
  const b = { ...s.ball };
  for (let i = 1; i <= 150; i++) {
    stepBall(b, DT);
    if (dist(p, b) <= PLAYER_SPRINT_SPEED * i * DT * 0.85 + 0.5) return { x: b.x, y: b.y };
  }
  return { x: b.x, y: b.y };
}

/**
 * The receiver runs onto the ball by himself while the stick is untouched or
 * still held the way the pass was aimed; any other direction hands control back.
 */
function receiverOnAuto(s: MatchState, input: InputFrame): boolean {
  const m = Math.hypot(input.moveX, input.moveY);
  if (m < 0.2) {
    s.passStick = null;
    return true;
  }
  const ps = s.passStick;
  if (ps && (input.moveX * ps.x + input.moveY * ps.y) / m > 0.7) return true;
  s.passStick = null;
  return false;
}

export function canKickNow(s: MatchState, p: Footballer): boolean {
  if (s.phase !== 'play' || p.kickCooldown > 0 || !canMove(p)) return false;
  if (s.players.some((q) => q.gk?.state === 'holding')) return false;
  if (s.setPiece && (s.setPiece.takerId !== p.id || s.setPiece.timer > 0)) return false;
  return dist(p, s.ball) < KICK_RADIUS && s.ball.z < MAX_KICK_HEIGHT;
}
