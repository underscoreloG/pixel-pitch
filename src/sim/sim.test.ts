import { describe, expect, it } from 'vitest';
import { predictCrossing, stepBall } from './ball';
import { BREAK_PAUSE, CENTER, DT, FINESSE_SPIN, FOUL_PAUSE, GOAL_HEIGHT, MIN_KICK_POWER, PENALTY_SPOT, PITCH_LENGTH, PITCH_WIDTH } from './constants';
import { findPassTarget, planKick, resolveHumanKick } from './kick';
import { NO_INPUT, createMatch, kickoff, matchMinute, periodEnd, stepMatch } from './match';
import { decided } from './shootout';
import { queueSub, speedFactor, subsLeft, tire } from './squad';
import { commitFoul } from './tackle';
import type { Ball, Footballer, InputFrame, MatchSettings, MatchState } from './types';

const MATCH: MatchSettings = { mode: 'match', duration: 600, difficulty: 1 };
const ball = (over: Partial<Ball> = {}): Ball => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ...over });
const human = (s: MatchState) => s.players[s.controlled];
const keeper = (s: MatchState, team: 'home' | 'away') => s.players.find((p) => p.team === team && p.gk)!;
const types = (s: MatchState) => s.events.map((e) => e.type);

function run(s: MatchState, seconds: number, input: InputFrame = NO_INPUT): void {
  for (let i = 0; i < seconds / DT; i++) stepMatch(s, input);
}

/** Press a button for `hold` seconds, then release for one tick. */
function press(s: MatchState, button: 'pass' | 'shoot' | 'lob' | 'through', hold = 0.2, extra: Partial<InputFrame> = {}): void {
  run(s, hold, { ...NO_INPUT, ...extra, [button]: true });
  stepMatch(s, { ...NO_INPUT, ...extra });
}

/** Keeper out of the way, ball placed and struck. */
function emptyGoalShot(s: MatchState, b: Partial<Ball>): void {
  Object.assign(keeper(s, 'away'), { y: 5 });
  Object.assign(keeper(s, 'away').gk!, { state: 'down', stateTimer: 99 });
  Object.assign(human(s), { x: 10, y: 10 });
  Object.assign(s.ball, ball(b));
}

/** Leaves only the given players on the pitch (the rest are sent off). */
function only(s: MatchState, ...keep: Footballer[]): void {
  for (const p of s.players) if (!keep.includes(p)) Object.assign(p, { sentOff: true, x: -20, y: -20 });
  s.setPiece = null;
}

describe('ball physics', () => {
  it('a 15 m/s ground pass rolls a realistic distance and stops', () => {
    const b = ball({ vx: 15 });
    let t = 0;
    while (b.vx > 0 && t < 30) {
      stepBall(b, DT);
      t += DT;
    }
    expect(b.vx).toBe(0);
    expect(b.x).toBeGreaterThan(25);
    expect(b.x).toBeLessThan(35);
  });

  it('a lofted ball bounces several times, never goes underground, then rolls', () => {
    const b = ball({ vx: 10, vz: 10 });
    let bounces = 0;
    let prevVz = b.vz;
    for (let i = 0; i < 20 / DT; i++) {
      stepBall(b, DT);
      expect(b.z).toBeGreaterThanOrEqual(0);
      if (prevVz < 0 && b.vz > 0) bounces++;
      prevVz = b.vz;
    }
    expect(bounces).toBeGreaterThanOrEqual(2);
    expect(b.z).toBe(0);
    expect(b.vz).toBe(0);
  });

  it('predictCrossing agrees with stepping the ball', () => {
    const b = ball({ x: 80, y: 30, vx: 20, vy: 2, vz: 4 });
    const c = predictCrossing(b, 100, 3)!;
    expect(c).not.toBeNull();
    const copy = { ...b };
    for (let t = 0; t < c.t - DT / 2; t += DT) stepBall(copy, DT);
    expect(copy.x).toBeGreaterThanOrEqual(100);
    expect(Math.abs(copy.y - c.y)).toBeLessThan(0.5);
  });
});

describe('training: goals and restarts', () => {
  it('a shot into an empty net scores and restarts from kickoff', () => {
    const s = createMatch(1);
    emptyGoalShot(s, { x: 95, y: CENTER.y, vx: 25 });
    run(s, 1);
    expect(s.score.home).toBe(1);
    expect(types(s)).toContain('goal');
    run(s, 3);
    expect(s.phase).toBe('play');
    expect(s.ball.x).toBeCloseTo(CENTER.x);
  });

  it('a shot over the bar is a goal kick to the keeper', () => {
    const s = createMatch(1);
    emptyGoalShot(s, { x: 100, y: CENTER.y, z: GOAL_HEIGHT + 1, vx: 20, vz: 2 });
    run(s, 0.5);
    expect(s.score.home).toBe(0);
    expect(s.phase).toBe('out');
    keeper(s, 'away').gk!.stateTimer = 0;
    run(s, 1.1);
    expect(keeper(s, 'away').gk!.state).toBe('holding');
  });

  it('hitting the post bounces the ball back into play', () => {
    const s = createMatch(1);
    emptyGoalShot(s, { x: 100, y: CENTER.y - 3.66, vx: 20 });
    run(s, 0.4);
    expect(types(s)).toContain('post');
    expect(s.ball.x).toBeLessThan(PITCH_LENGTH);
  });

  it('the keeper stops a soft shot straight at him', () => {
    const s = createMatch(1);
    Object.assign(human(s), { x: 80, y: 10 });
    Object.assign(s.ball, ball({ x: 90, y: CENTER.y, vx: 12 }));
    run(s, 3);
    expect(s.score.home).toBe(0);
    expect(types(s).some((t) => t === 'save' || t === 'catch')).toBe(true);
  });

  it('keeper putting it wide is a corner, set at the corner spot', () => {
    const s = createMatch(1);
    emptyGoalShot(s, { x: 100, y: 20, vx: 15 });
    s.lastTouch = 'away';
    run(s, 2);
    expect(s.setPiece).toMatchObject({ type: 'corner', team: 'home', x: PITCH_LENGTH - 0.5, y: 0.5 });
  });

  it('a dead ball cannot be dribbled, only kicked', () => {
    const s = createMatch(1);
    s.setPiece = { type: 'corner', team: 'home', x: 60, y: 30, takerId: s.controlled, timer: 0 };
    Object.assign(s.ball, ball({ x: 60, y: 30 }));
    Object.assign(human(s), { x: 57, y: 30 });
    run(s, 1, { ...NO_INPUT, moveX: 1 });
    expect(s.ball.x).toBe(60);
    expect(s.possessor).toBe(-1);
  });

  it('a throw-in leaves from above the head and clears the set piece', () => {
    const s = createMatch(1);
    s.setPiece = { type: 'throw-in', team: 'home', x: 60, y: 0.05, takerId: s.controlled, timer: 0 };
    Object.assign(s.ball, ball({ x: 60, y: 0.05 }));
    Object.assign(human(s), { x: 60, y: 0.7, facingX: 0, facingY: 1 });
    press(s, 'pass');
    expect(s.setPiece).toBeNull();
    expect(s.ball.z).toBeGreaterThan(1.8);
    expect(s.ball.vy).toBeGreaterThan(5);
  });
});

describe('player', () => {
  it('runs onto the ball and keeps it while dribbling', () => {
    const s = createMatch(1);
    run(s, 2, { ...NO_INPUT, moveX: 1 });
    expect(s.possessor).toBe(s.controlled);
    expect(Math.hypot(s.ball.x - human(s).x, s.ball.y - human(s).y)).toBeLessThan(1.4);
    expect(human(s).x).toBeGreaterThan(CENTER.x + 5);
  });

  it('a fully charged shot leaves the foot fast', () => {
    const s = createMatch(1);
    run(s, 0.5, { ...NO_INPUT, moveX: 1 });
    press(s, 'shoot', 1, { moveX: 1 });
    expect(Math.hypot(s.ball.vx, s.ball.vy)).toBeGreaterThan(25);
    expect(s.possessor).toBe(-1);
  });

  it('pressing pass while charging a shot fakes it and keeps the ball', () => {
    const s = createMatch(1);
    run(s, 0.6, { ...NO_INPUT, moveX: 1 });
    run(s, 0.3, { ...NO_INPUT, moveX: 1, shoot: true });
    run(s, 0.1, { ...NO_INPUT, moveX: 1, shoot: true, pass: true });
    expect(types(s)).toContain('fake');
    expect(types(s)).not.toContain('kick');
    expect(human(s).fakeAnim).toBeGreaterThan(0);
    run(s, 0.3, { ...NO_INPUT, moveX: 1 });
    expect(s.possessor).toBe(s.controlled);
  });

  it('an easy keeper usually bites on a fake shot close in', () => {
    let bites = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = createMatch(seed, { mode: 'training', duration: 0, difficulty: 0 });
      Object.assign(human(s), { x: 88, y: CENTER.y });
      Object.assign(s.ball, ball({ x: 88.6, y: CENTER.y }));
      run(s, 0.3, { ...NO_INPUT, moveX: 0.3 });
      run(s, 0.2, { ...NO_INPUT, moveX: 0.3, shoot: true });
      run(s, 0.05, { ...NO_INPUT, moveX: 0.3, shoot: true, pass: true });
      if (keeper(s, 'away').gk!.state === 'diving') bites++;
    }
    expect(bites).toBeGreaterThanOrEqual(5);
  });
});

describe('11 v 11', () => {
  it('starts with 22 players and a home kickoff taken by the striker', () => {
    const s = createMatch(1, MATCH);
    expect(s.players).toHaveLength(22);
    expect(s.setPiece).toMatchObject({ type: 'kickoff', team: 'home' });
    expect(human(s).number).toBe(9);
    expect(s.players.filter((p) => p.team === 'away').every((p) => p.x > CENTER.x)).toBe(true);
  });

  it('a pass goes to the teammate in the aim direction and control follows it', () => {
    const s = createMatch(1, MATCH);
    const passer = human(s);
    const mate = s.players.find((p) => p.team === 'home' && p.number === 4)!;
    const dx = mate.x - passer.x;
    const dy = mate.y - passer.y;
    const n = Math.hypot(dx, dy);
    press(s, 'pass', 0.3, { moveX: dx / n, moveY: dy / n });
    expect(s.passTarget).toBe(mate.id);
    expect(s.controlled).toBe(mate.id);
  });

  it('pass assist prefers an outfield teammate over the keeper behind him', () => {
    const s = createMatch(1, MATCH);
    press(s, 'pass', 0.3, { moveX: -1 });
    expect(s.players[s.passTarget]?.gk).toBeNull();
  });

  it('the CPU takes its own kickoff and plays on', () => {
    const s = createMatch(3, MATCH);
    s.score.home = 1;
    s.phase = 'goal';
    s.kickoffTeam = 'away';
    s.phaseTimer = 0.01;
    run(s, 3);
    expect(s.setPiece).toBeNull();
    expect(s.events.some((e) => e.type === 'kick' && e.team === 'away')).toBe(true);
  });

  it('a minute of CPU vs idle human stays sane: ball in bounds, players on the pitch, passes made', () => {
    const s = createMatch(7, MATCH);
    kickoff(s, 'away');
    let kicks = 0;
    for (let i = 0; i < 60 / DT; i++) {
      stepMatch(s, NO_INPUT);
      kicks += s.events.filter((e) => e.type === 'kick' && e.team === 'away').length;
      s.events.length = 0;
      expect(Number.isFinite(s.ball.x) && Number.isFinite(s.ball.y)).toBe(true);
    }
    // The idle human eventually owns a restart and play waits for him; before that the CPU must be playing.
    expect(kicks).toBeGreaterThanOrEqual(3);
    for (const p of s.players.filter((q) => !q.sentOff)) {
      expect(p.x).toBeGreaterThan(-4);
      expect(p.x).toBeLessThan(PITCH_LENGTH + 4);
      expect(p.y).toBeGreaterThan(-4);
      expect(p.y).toBeLessThan(PITCH_WIDTH + 4);
    }
  });
});

describe('defending and assisted kicks', () => {
  /** Away carrier dribbling towards the home goal, the human in front of him. */
  function faceUp(seed: number, gap: number): { s: MatchState; carrier: Footballer; me: Footballer } {
    const s = createMatch(seed, MATCH);
    const carrier = s.players.find((p) => p.team === 'away' && p.number === 9)!;
    const me = human(s);
    only(s, carrier, me);
    Object.assign(carrier, { x: 60, y: CENTER.y, facingX: -1, facingY: 0, think: 99 });
    Object.assign(me, { x: 60 - gap, y: CENTER.y + 2, facingX: 1, facingY: 0 });
    Object.assign(s.ball, ball({ x: 59.4, y: CENTER.y }));
    s.possessor = carrier.id;
    return { s, carrier, me };
  }

  it('holding S runs at the carrier and usually wins the ball', () => {
    let won = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { s, me } = faceUp(seed, 8);
      let gotIt = false;
      for (let i = 0; i < 3 / DT && !gotIt; i++) {
        stepMatch(s, { ...NO_INPUT, pass: true, sprint: true });
        gotIt = s.possessor === me.id;
      }
      if (gotIt) won++;
    }
    expect(won).toBeGreaterThanOrEqual(6);
  });

  it('a defender who gets onto the dribbled ball sometimes takes it without pressing anything', () => {
    let won = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { s, me } = faceUp(seed, 1.5);
      Object.assign(me, { x: 59.0, y: CENTER.y });
      // Steer at the ball, no button.
      for (let i = 0; i < 45; i++) {
        const dx = s.ball.x - me.x;
        const dy = s.ball.y - me.y;
        const n = Math.hypot(dx, dy) || 1;
        stepMatch(s, { ...NO_INPUT, moveX: dx / n, moveY: dy / n });
      }
      if (s.possessor === me.id) won++;
    }
    expect(won).toBeGreaterThanOrEqual(3);
  });

  it('control switches to the nearest red player when blue wins the ball', () => {
    const s = createMatch(1, MATCH);
    const blue = s.players.find((p) => p.team === 'away' && p.number === 8)!;
    const near = s.players.find((p) => p.team === 'home' && p.number === 6)!;
    s.setPiece = null;
    Object.assign(blue, { x: near.x + 3, y: near.y, think: 99 });
    Object.assign(s.ball, ball({ x: near.x + 2.5, y: near.y }));
    run(s, 0.1);
    expect(s.possessor).toBe(blue.id);
    expect(s.controlled).toBe(near.id);
  });

  it('an assisted pass is weighted to reach the teammate', () => {
    const s = createMatch(2, MATCH);
    const mate = s.players.find((p) => p.team === 'home' && p.number === 4)!;
    const me = human(s);
    only(s, me, mate);
    Object.assign(me, { x: 50, y: 34, facingX: -1, facingY: 0 });
    Object.assign(mate, { x: 30, y: 30 });
    Object.assign(s.ball, ball({ x: 49.5, y: 34 }));
    run(s, 0.2, { ...NO_INPUT, moveX: -1 });
    press(s, 'pass', DT, { moveX: -1, moveY: -0.2 });
    run(s, 4);
    expect(s.possessor).toBe(mate.id);
  });

  it('a full-charge pass is firm and the receiver takes it first time, even with the aim still held', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const s = createMatch(seed, MATCH);
      const me = human(s);
      const mate = s.players.find((p) => p.team === 'home' && p.number === 4)!;
      only(s, me, mate);
      Object.assign(me, { x: 56, y: 34, facingX: -1, facingY: 0 });
      Object.assign(mate, { x: 35, y: 30 });
      Object.assign(s.ball, ball({ x: 55.5, y: 34 }));
      run(s, 0.2, { ...NO_INPUT, moveX: -1 });
      const n = Math.hypot(mate.x - me.x, mate.y - me.y);
      const stick = { moveX: (mate.x - me.x) / n, moveY: (mate.y - me.y) / n };
      press(s, 'pass', 1, stick);
      expect(Math.hypot(s.ball.vx, s.ball.vy)).toBeGreaterThan(15);
      let t = 0;
      while (s.possessor !== mate.id && t < 3) {
        stepMatch(s, { ...NO_INPUT, ...stick });
        t += DT;
      }
      expect(t).toBeLessThan(0.8);
    }
  });

  it('a max-power shot is fast and stays on target', () => {
    let onTarget = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = createMatch(seed, MATCH);
      const me = human(s);
      only(s, me);
      Object.assign(me, { x: 87, y: 30, facingX: 1, facingY: 0 });
      Object.assign(s.ball, ball({ x: 87.6, y: 30 }));
      s.possessor = me.id;
      const n = Math.hypot(105 - 87.6, 37.2 - 30);
      press(s, 'shoot', 1, { moveX: (105 - 87.6) / n, moveY: (37.2 - 30) / n });
      expect(Math.hypot(s.ball.vx, s.ball.vy)).toBeGreaterThan(32);
      for (let i = 0; i < 2 / DT; i++) {
        const prevX = s.ball.x;
        stepMatch(s, NO_INPUT);
        if (s.phase === 'goal' || (prevX < 105 && s.ball.x >= 105)) {
          if (s.phase === 'goal') onTarget++;
          break;
        }
      }
    }
    expect(onTarget).toBeGreaterThanOrEqual(9);
  });

  it('an assisted shot aimed just wide is pulled inside the post; manual stays wide', () => {
    const shootFrom = (assist: boolean) => {
      const s = createMatch(3, { ...MATCH, assist });
      const me = human(s);
      only(s, me);
      Object.assign(me, { x: 88, y: 34, facingX: 1, facingY: 0 });
      Object.assign(s.ball, ball({ x: 88.6, y: 34 }));
      s.possessor = me.id;
      // Aim at a point 2 m outside the far post.
      const dx = 105 - 88.6;
      const dy = 34 + 3.66 + 2 - 34;
      const n = Math.hypot(dx, dy);
      press(s, 'shoot', 0.3, { moveX: dx / n, moveY: dy / n });
      let crossY = NaN;
      for (let i = 0; i < 120 && Number.isNaN(crossY); i++) {
        const prevX = s.ball.x;
        stepMatch(s, NO_INPUT);
        if (prevX < 105 && s.ball.x >= 105) crossY = s.ball.y;
        if (s.phase === 'goal') crossY = s.ball.y;
      }
      return crossY;
    };
    expect(Math.abs(shootFrom(true) - 34)).toBeLessThan(3.66);
    expect(Math.abs(shootFrom(false) - 34)).toBeGreaterThan(3.66);
  });

  it('an assisted full-power volley stays under the bar; a manual one flies over', () => {
    const crossingZ = (assist: boolean, seed: number) => {
      const s = createMatch(seed, { ...MATCH, assist });
      const me = human(s);
      only(s, me);
      Object.assign(me, { x: 89, y: 34, facingX: 1, facingY: 0 });
      // A bouncing ball met at knee height, fully charged.
      Object.assign(s.ball, ball({ x: 89.6, y: 34, z: 0.7 }));
      me.pending = { type: 'shot', power: 1, ttl: 0.25, finesse: false };
      stepMatch(s, { ...NO_INPUT, moveX: 1, moveY: 0.1 });
      return predictCrossing(s.ball, PITCH_LENGTH, 3)?.z ?? NaN;
    };
    for (let seed = 1; seed <= 10; seed++) expect(crossingZ(true, seed)).toBeLessThan(GOAL_HEIGHT - 0.2);
    expect(Math.max(...[1, 2, 3, 4, 5].map((seed) => crossingZ(false, seed)))).toBeGreaterThan(GOAL_HEIGHT);
  });

  it('a pass on the run allows for the runner\'s momentum, and even a tap arrives with pace', () => {
    const s = createMatch(4, MATCH);
    const me = human(s);
    const mate = s.players.find((p) => p.team === 'home' && p.number === 4)!;
    only(s, me, mate);
    // Sprinting up the line, a tapped pass square to a teammate 20 m away.
    Object.assign(me, { x: 50, y: 20, vx: 0, vy: 9, facingX: 0, facingY: 1 });
    Object.assign(mate, { x: 30, y: 20, vx: 0, vy: 0 });
    Object.assign(s.ball, ball({ x: 50, y: 20.9 }));
    const k = resolveHumanKick(s, me, 'pass', MIN_KICK_POWER, -1, 0);
    expect(k.target).toBe(mate.id);
    const plan = planKick(s, me, 'pass', k.power, k.dirX, k.dirY, { sprinting: true });
    const tx = mate.x - s.ball.x;
    const ty = mate.y - s.ball.y;
    const cos = (plan.vx * tx + plan.vy * ty) / (Math.hypot(plan.vx, plan.vy) * Math.hypot(tx, ty));
    expect(cos).toBeGreaterThan(Math.cos((1 * Math.PI) / 180));
    const b = { ...s.ball, vx: plan.vx, vy: plan.vy, vz: plan.vz };
    for (let i = 0; i < 300 && Math.hypot(b.x - mate.x, b.y - mate.y) > 1; i++) stepBall(b, DT);
    expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(9);
  });

  it('pass assist picks the open teammate over one with a defender in the lane', () => {
    const s = createMatch(5, MATCH);
    const me = human(s);
    const near = s.players.find((p) => p.team === 'home' && p.number === 4)!;
    const open = s.players.find((p) => p.team === 'home' && p.number === 7)!;
    const blue = s.players.find((p) => p.team === 'away' && !p.gk)!;
    only(s, me, near, open, blue);
    Object.assign(me, { x: 50, y: 34, facingX: -1, facingY: 0 });
    Object.assign(s.ball, ball({ x: 49.4, y: 34 }));
    // The stick points nearer the first teammate, but a defender sits on that line.
    Object.assign(near, { x: 35, y: 32 });
    Object.assign(open, { x: 35, y: 38 });
    Object.assign(blue, { x: 42, y: 33 });
    expect(findPassTarget(s, me, -1, 0)?.id).toBe(open.id);
    Object.assign(blue, { x: 42, y: 45 });
    expect(findPassTarget(s, me, -1, 0)?.id).toBe(near.id);
  });
});

describe('through balls and curl', () => {
  it('a through ball goes into the space ahead of the runner, and he gets there first', () => {
    for (let seed = 1; seed <= 5; seed++) {
      // One defender only: with offside on, the runner would be past the second-last opponent.
      const s = createMatch(seed, { ...MATCH, offside: false });
      const passer = s.players.find((p) => p.team === 'home' && p.number === 10)!;
      const runner = s.players.find((p) => p.team === 'home' && p.number === 9)!;
      const blue = s.players.find((p) => p.team === 'away' && p.number === 5)!;
      s.controlled = passer.id;
      only(s, passer, runner, blue);
      Object.assign(passer, { x: 55, y: 30, facingX: 1, facingY: 0 });
      Object.assign(runner, { x: 70, y: 36, vx: 0, vy: 0 });
      // A defender a few metres goal-side of the passer's line, beaten by the ball in behind.
      Object.assign(blue, { x: 67, y: 24, vx: 0, vy: 0, think: 99 });
      Object.assign(s.ball, ball({ x: 55.6, y: 30 }));
      s.possessor = passer.id;
      const n = Math.hypot(15, 6);
      press(s, 'through', 0.3, { moveX: 15 / n, moveY: 6 / n });
      expect(s.passTarget).toBe(runner.id);
      // Played beyond him, not to his feet.
      const crossing = predictCrossing(s.ball, runner.x + 4, 3);
      expect(crossing).not.toBeNull();
      // He takes it in stride, beyond where he started.
      for (let i = 0; i < 3 / DT && s.possessor !== runner.id; i++) stepMatch(s, NO_INPUT);
      expect(s.possessor).toBe(runner.id);
      expect(runner.x).toBeGreaterThan(74);
    }
  });

  it('spin curls the ball in the air, and barely on the grass', () => {
    const flight = (spin: number, vz: number) => {
      const b = ball({ vx: 25, vz, spin });
      while (b.x < 20) stepBall(b, DT);
      return b.y;
    };
    expect(flight(0, 3)).toBeCloseTo(0, 5);
    expect(Math.abs(flight(FINESSE_SPIN, 3))).toBeGreaterThan(1.5);
    expect(Math.abs(flight(FINESSE_SPIN, 3))).toBeLessThan(4);
    expect(Math.abs(flight(FINESSE_SPIN, 0))).toBeLessThan(Math.abs(flight(FINESSE_SPIN, 3)) / 2);
  });

  it('an assisted finesse shot starts outside the post and curls in just inside it', () => {
    const s = createMatch(3, MATCH);
    const me = human(s);
    only(s, me);
    Object.assign(me, { x: 85, y: 24, facingX: 1, facingY: 0 });
    Object.assign(s.ball, ball({ x: 85.6, y: 24 }));
    s.possessor = me.id;
    // Aim at the far post, finesse held.
    const dx = 105 - 85.6;
    const dy = 34 + 3.66 - 24;
    const n = Math.hypot(dx, dy);
    press(s, 'shoot', 0.4, { moveX: dx / n, moveY: dy / n, finesse: true });
    expect(Math.abs(s.ball.spin ?? 0)).toBeGreaterThan(0.3);
    // Heading wide of the far post at first...
    const straightY = s.ball.y + (s.ball.vy / s.ball.vx) * (105 - s.ball.x);
    expect(straightY).toBeGreaterThan(34 + 3.66);
    // ...and it bends back inside it.
    const c = predictCrossing(s.ball, 105, 3)!;
    expect(c.y).toBeLessThan(34 + 3.66 - 0.1);
    expect(c.y).toBeGreaterThan(34 + 3.66 - 1);
    expect(c.z).toBeLessThan(GOAL_HEIGHT);
  });

  it('the CPU plays through balls and curls shots in a match', () => {
    const s = createMatch(11, { mode: 'match', duration: 300, difficulty: 1, autoplay: true });
    const kinds = new Set<string>();
    let curled = 0;
    while (s.phase !== 'full-time') {
      stepMatch(s, NO_INPUT);
      for (const e of s.events) if (e.type === 'kick' && e.tick === s.tick - 1) {
        kinds.add(e.kick!);
        if (e.kick === 'shot' && Math.abs(s.ball.spin ?? 0) > 0.2) curled++;
      }
      s.events.length = 0;
    }
    expect(kinds.has('through')).toBe(true);
    expect(curled).toBeGreaterThan(0);
  });
});

describe('offside', () => {
  /** Red #10 passes to #9 with two blue defenders and the keeper; #9 stands `beyond` metres past the last outfield defender. */
  function passTo9(beyond: number, settings: Partial<MatchSettings> = {}): MatchState {
    const s = createMatch(4, { ...MATCH, ...settings });
    const passer = s.players.find((p) => p.team === 'home' && p.number === 10)!;
    const nine = s.players.find((p) => p.team === 'home' && p.number === 9)!;
    const [d1, d2] = s.players.filter((p) => p.team === 'away' && p.role === 'DF');
    only(s, passer, nine, d1, d2, keeper(s, 'away'));
    s.controlled = passer.id;
    Object.assign(passer, { x: 60, y: 34, facingX: 1, facingY: 0 });
    Object.assign(d1, { x: 80, y: 28, think: 99 });
    Object.assign(d2, { x: 80, y: 42, think: 99 });
    Object.assign(nine, { x: 80 + beyond, y: 34, vx: 0, vy: 0 });
    Object.assign(s.ball, ball({ x: 60.6, y: 34 }));
    s.possessor = passer.id;
    press(s, 'pass', 0.1, { moveX: 1, moveY: 0 });
    return s;
  }

  it('a pass to a player beyond the second-last defender is offside: free kick where he plays it', () => {
    const s = passTo9(4);
    expect(s.offside?.ids).toContain(human(s).id);
    run(s, 3);
    expect(s.events.some((e) => e.type === 'offside')).toBe(true);
    expect(s.setPiece?.type).toBe('free-kick');
    expect(s.setPiece?.team).toBe('away');
    // Where he played it, well upfield of the pass.
    expect(s.setPiece!.x).toBeGreaterThan(70);
  });

  it('level is onside, and so is running past the line after the pass', () => {
    const s = passTo9(-0.2);
    expect(s.offside).toBeNull();
    run(s, 3);
    expect(s.events.some((e) => e.type === 'offside')).toBe(false);
  });

  it('can be switched off', () => {
    const s = passTo9(4, { offside: false });
    run(s, 3);
    expect(s.events.some((e) => e.type === 'offside')).toBe(false);
    expect(s.possessor).toBe(human(s).id);
  });

  it('nobody is offside from a throw-in', () => {
    const s = createMatch(5, MATCH);
    const thrower = s.players.find((p) => p.team === 'home' && p.number === 7)!;
    const nine = s.players.find((p) => p.team === 'home' && p.number === 9)!;
    const [d1, d2] = s.players.filter((p) => p.team === 'away' && p.role === 'DF');
    only(s, thrower, nine, d1, d2, keeper(s, 'away'));
    Object.assign(d1, { x: 75, y: 30, think: 99 });
    Object.assign(d2, { x: 75, y: 40, think: 99 });
    Object.assign(nine, { x: 82, y: 6 });
    s.phase = 'out';
    s.phaseTimer = 0.01;
    s.restart = { type: 'throw-in', team: 'home', x: 78, y: 0.05 };
    run(s, 0.6);
    press(s, 'pass', 0.1, { moveX: 0.6, moveY: 0.8 });
    expect(s.offside).toBeNull();
  });

  it('the CPU mostly stays onside in a match', () => {
    const s = createMatch(12, { mode: 'match', duration: 300, difficulty: 1, autoplay: true });
    let flags = 0;
    while (s.phase !== 'full-time') {
      stepMatch(s, NO_INPUT);
      flags += s.events.filter((e) => e.type === 'offside' && e.tick === s.tick - 1).length;
      s.events.length = 0;
    }
    expect(flags).toBeLessThanOrEqual(6);
  });
});

describe('squads: ratings, stamina, substitutions, stats', () => {
  it('players differ a little, the same way for the same seed', () => {
    const a = createMatch(7, MATCH);
    const b = createMatch(7, MATCH);
    const pace = a.players.filter((p) => !p.gk).map((p) => p.ratings.pace);
    expect(Math.max(...pace)).toBeLessThan(1.07);
    expect(Math.min(...pace)).toBeGreaterThan(0.93);
    expect(new Set(pace).size).toBeGreaterThan(10);
    expect(b.players.map((p) => p.ratings)).toEqual(a.players.map((p) => p.ratings));
  });

  it('sprinting tires a player and makes him slower; standing gets some back', () => {
    const s = createMatch(1, MATCH);
    const p = s.players.find((q) => q.team === 'away' && q.number === 8)!;
    const fresh = speedFactor(p);
    Object.assign(p, { vx: 9, vy: 0 });
    for (let i = 0; i < 60 / DT; i++) tire(s, p, DT);
    expect(p.stamina).toBeLessThan(0.7);
    expect(speedFactor(p)).toBeLessThan(fresh);
    const tired = p.stamina;
    Object.assign(p, { vx: 0, vy: 0 });
    for (let i = 0; i < 20 / DT; i++) tire(s, p, DT);
    expect(p.stamina).toBeGreaterThan(tired);
  });

  it('a substitution waits for the next stoppage, brings on a fresh player, and there are only three', () => {
    const s = createMatch(2, MATCH);
    run(s, 2, NO_INPUT);
    const tiredOnes = s.players.filter((p) => p.team === 'home' && !p.gk).slice(0, 4);
    for (const p of tiredOnes) p.stamina = 0.4;
    for (const p of tiredOnes) queueSub(s, 'home', p.id);
    expect(s.subs.home.queue.length).toBe(3);
    // Open play: nothing yet.
    s.setPiece = null;
    s.phase = 'play';
    stepMatch(s, NO_INPUT);
    expect(s.subs.home.made).toBe(0);
    // The ball goes out: the changes are made.
    s.phase = 'out';
    s.phaseTimer = 1;
    stepMatch(s, NO_INPUT);
    expect(s.subs.home.made).toBe(3);
    expect(subsLeft(s, 'home')).toBe(0);
    expect(tiredOnes.slice(0, 3).every((p) => p.stamina === 1 && p.number >= 12)).toBe(true);
    expect(queueSub(s, 'home', tiredOnes[3].id)).toBe(false);
  });

  it('over a CPU match: tired players are changed, and the stats add up', () => {
    const s = createMatch(5, { mode: 'match', duration: 240, difficulty: 1, autoplay: true });
    let subs = 0;
    let shots = 0;
    while (s.phase !== 'full-time') {
      stepMatch(s, NO_INPUT);
      for (const e of s.events) {
        if (e.tick !== s.tick - 1) continue;
        if (e.type === 'sub') subs++;
        if (e.type === 'kick' && e.kick === 'shot') shots++;
      }
      s.events.length = 0;
    }
    expect(subs).toBeGreaterThanOrEqual(2);
    const { home, away } = s.stats;
    expect(home.shots + away.shots).toBe(shots);
    expect(home.onTarget + away.onTarget).toBeGreaterThanOrEqual(s.score.home + s.score.away);
    const possession = home.possession / (home.possession + away.possession);
    expect(possession).toBeGreaterThan(0.2);
    expect(possession).toBeLessThan(0.8);
    expect(home.completed).toBeLessThanOrEqual(home.passes);
    expect(home.completed / home.passes).toBeGreaterThan(0.4);
  });
});

describe('goal kicks', () => {
  it('the keeper kicks it well upfield, where his side usually wins it', () => {
    let kept = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const s = createMatch(seed, { ...MATCH, autoplay: true });
      run(s, 3);
      s.possessor = -1;
      s.setPiece = null;
      s.phase = 'out';
      s.phaseTimer = 0.01;
      s.restart = { type: 'goal-kick', team: 'home', x: 5.5, y: CENTER.y };
      // Wait for the kick, then for someone to control it.
      let kickedFrom = NaN;
      for (let i = 0; i < 8 / DT && (Number.isNaN(kickedFrom) || s.possessor < 0); i++) {
        stepMatch(s, NO_INPUT);
        if (Number.isNaN(kickedFrom) && s.events.some((e) => e.type === 'kick' && e.playerId === keeper(s, 'home').id)) {
          kickedFrom = keeper(s, 'home').x;
        }
        s.events.length = 0;
      }
      expect(s.ball.x - kickedFrom).toBeGreaterThan(20);
      if (s.possessor >= 0 && s.players[s.possessor].team === 'home') kept++;
    }
    expect(kept).toBeGreaterThanOrEqual(6);
  });
});

describe('keeper against shots', () => {
  /** A placed shot at the far corner from `d` metres with the keeper set, charged for `hold` seconds. */
  function placedShot(seed: number, d: number, hold: number): boolean {
    const s = createMatch(seed, MATCH);
    const me = human(s);
    only(s, me, keeper(s, 'away'));
    const y = 34 + ((seed % 5) - 2) * 3;
    const place = () => {
      Object.assign(me, { x: 105 - d - 0.6, y, vx: 0, vy: 0, facingX: 1, facingY: 0 });
      Object.assign(s.ball, ball({ x: 105 - d, y }));
      s.possessor = me.id;
    };
    place();
    run(s, 0.5);
    place();
    const ty = 34 + (y > 34 ? -3.2 : 3.2);
    const n = Math.hypot(d, ty - y);
    press(s, 'shoot', hold, { moveX: d / n, moveY: (ty - y) / n });
    for (let i = 0; i < 3 / DT; i++) {
      stepMatch(s, NO_INPUT);
      if (s.phase === 'goal') return true;
      if (s.phase !== 'play') return false;
    }
    return false;
  }
  const goals = (d: number, hold: number) => Array.from({ length: 20 }, (_, i) => placedShot(i + 1, d, hold)).filter(Boolean).length;

  it('a half-power shot from range is saved: the keeper waits for it instead of diving early and lying down', () => {
    expect(goals(24, 0.4)).toBeLessThanOrEqual(2);
  });

  it('a hard shot into the corner from the edge of the box beats the keeper sometimes, not always', () => {
    const g = goals(22, 0.8);
    expect(g).toBeGreaterThanOrEqual(3);
    expect(g).toBeLessThanOrEqual(17);
  });

  it('a firm, placed shot from close in usually scores', () => {
    expect(goals(12, 0.4)).toBeGreaterThanOrEqual(14);
  });
});

describe('taking set pieces', () => {
  /** Walk the human up to a dead ball the way a player would, then press pass. */
  function walkUpAndPass(type: 'free-kick' | 'corner' | 'penalty', from: { x: number; y: number }, at: { x: number; y: number }) {
    const s = createMatch(5, MATCH);
    const me = human(s);
    only(s, me);
    Object.assign(me, from);
    s.setPiece = { type, team: 'home', x: at.x, y: at.y, takerId: me.id, timer: 0.2 };
    Object.assign(s.ball, ball(at));
    for (let i = 0; i < 2 / DT; i++) {
      const dx = s.ball.x - me.x;
      const dy = s.ball.y - me.y;
      const n = Math.hypot(dx, dy) || 1;
      stepMatch(s, { ...NO_INPUT, moveX: dx / n, moveY: dy / n });
    }
    press(s, 'pass', 0.2, { moveX: 1 });
    return s;
  }

  for (const [type, from, at] of [
    ['free-kick', { x: 50, y: 30 }, { x: 55, y: 34 }],
    ['corner', { x: 98, y: 8 }, { x: 104.5, y: 0.5 }],
    ['penalty', { x: 92, y: 34 }, { x: 94, y: 34 }],
  ] as const) {
    it(`the human can walk up to a ${type} and take it`, () => {
      const s = walkUpAndPass(type, from, at);
      expect(s.setPiece).toBeNull();
      expect(types(s)).toContain('kick');
    });
  }
});

describe('penalties', () => {
  /**
   * Fouls the attacking side's #9 in the box, waits for the penalty, takes it (human) or lets the CPU
   * (with the human's keeper diving the way `keeperStick` is held), returns the outcome.
   */
  function penalty(seed: number, team: 'home' | 'away', stick = { moveX: 1, moveY: 0.22 }, charge = 0.7, keeperStick = 0): string {
    const s = createMatch(seed, MATCH);
    s.setPiece = null;
    const att = s.players.find((p) => p.team === team && p.number === 9)!;
    const def = s.players.find((p) => p.team !== team && p.role === 'DF')!;
    const boxX = team === 'home' ? 95 : 10;
    Object.assign(att, { x: boxX, y: CENTER.y });
    Object.assign(def, { x: boxX + 0.5, y: CENTER.y });
    s.possessor = att.id;
    commitFoul(s, def, att, 0.3);
    run(s, FOUL_PAUSE + 0.1);
    expect((s as MatchState).setPiece?.type).toBe('penalty');
    if (team === 'home') {
      run(s, 0.4, { ...NO_INPUT, moveX: 1 });
      press(s, 'shoot', charge, stick);
    }
    for (let i = 0; i < 4 / DT; i++) {
      stepMatch(s, { ...NO_INPUT, moveY: keeperStick });
      for (const e of s.events) {
        if (e.type === 'goal') return 'goal';
        if (e.type === 'save' || e.type === 'catch') return 'saved';
        if (e.type === 'post' || e.type === 'bar' || e.type === 'goal-kick' || e.type === 'corner') return 'missed';
      }
      s.events.length = 0;
    }
    return 'none';
  }
  const rate = (outcomes: string[]) => outcomes.filter((o) => o === 'goal').length / outcomes.length;
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);

  it('a well-placed red penalty usually goes in, but the keeper saves some', () => {
    const outs = seeds.map((seed) => penalty(seed, 'home'));
    const r = rate(outs);
    expect(r).toBeGreaterThan(0.6);
    expect(r).toBeLessThan(0.95);
  });

  it('on a CPU penalty your keeper dives the way you hold the stick, and saves some', () => {
    const r = rate(seeds.map((seed) => penalty(seed, 'away', undefined, undefined, -1)));
    expect(r).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(0.85);
    // Standing up in the middle mostly gets beaten.
    expect(rate(seeds.map((seed) => penalty(seed, 'away')))).toBeGreaterThan(r);
  });
});

describe('halves, extra time and shootouts', () => {
  const CUP: MatchSettings = { mode: 'match', duration: 60, difficulty: 1, autoplay: true };
  const until = (s: MatchState, type: string, max = 400) => {
    for (let i = 0; i < max / DT; i++) {
      stepMatch(s, NO_INPUT);
      const hit = s.events.some((e) => e.type === type && e.tick === s.tick - 1);
      s.events.length = 0;
      if (hit) return true;
    }
    return false;
  };

  it('half-time at 45 minutes, then the other side kicks off the second half from 45', () => {
    const s = createMatch(1, CUP);
    expect(until(s, 'half-time')).toBe(true);
    expect(matchMinute(s)).toBe(45);
    expect(until(s, 'kickoff')).toBe(true);
    expect(s.period).toBe(2);
    expect(s.kickoffTeam).toBe('away');
    expect(s.clock).toBeCloseTo(30, 1);
    expect(until(s, 'full-time')).toBe(true);
    expect(matchMinute(s)).toBe(90);
  });

  it('a draw goes to extra time, then to penalties, and the shootout finds a winner', () => {
    const s = createMatch(2, { ...CUP, ifDrawn: 'extra-time' });
    // Late in the second half, level.
    Object.assign(s, { period: 2, clock: 59.9 });
    s.score = { home: 1, away: 1 };
    s.setPiece = null;
    Object.assign(s.ball, ball({ x: CENTER.x, y: CENTER.y }));
    expect(until(s, 'extra-time', 15)).toBe(true);
    expect(until(s, 'kickoff', 10)).toBe(true);
    expect(s.period).toBe(3);
    Object.assign(s, { period: 4, clock: periodEnd(s) + 20 - 0.1 });
    s.score = { home: 2, away: 2 };
    s.setPiece = null;
    Object.assign(s.ball, ball({ x: CENTER.x, y: CENTER.y }));
    expect(until(s, 'shootout', 15)).toBe(true);
    expect(until(s, 'full-time', 200)).toBe(true);
    const so = s.shootout!;
    expect(so.winner).not.toBeNull();
    expect(so.goals.home).not.toBe(so.goals.away);
    expect(so.taken.home).toBeGreaterThanOrEqual(3);
    expect(Math.abs(so.taken.home - so.taken.away)).toBeLessThanOrEqual(1);
    // The match score stays as it was.
    expect(s.score).toEqual({ home: 2, away: 2 });
  });

  it('a drawn match with the default rule just ends', () => {
    const s = createMatch(3, CUP);
    Object.assign(s, { period: 2, clock: 59.9 });
    s.score = { home: 0, away: 0 };
    s.setPiece = null;
    Object.assign(s.ball, ball({ x: CENTER.x, y: CENTER.y }));
    expect(until(s, 'full-time', 15)).toBe(true);
    expect(s.shootout).toBeNull();
  });

  it('shootout scoring: stops once a side cannot catch up, sudden death after five each', () => {
    expect(decided({ home: 3, away: 0 }, { home: 3, away: 3 })).toBe('home');
    expect(decided({ home: 2, away: 0 }, { home: 3, away: 2 })).toBeNull();
    expect(decided({ home: 4, away: 3 }, { home: 5, away: 5 })).toBe('home');
    expect(decided({ home: 4, away: 4 }, { home: 5, away: 5 })).toBeNull();
    expect(decided({ home: 5, away: 4 }, { home: 6, away: 5 })).toBeNull();
    expect(decided({ home: 5, away: 4 }, { home: 6, away: 6 })).toBe('home');
  });
});

describe('tackles, fouls and cards', () => {
  /** Away carrier running at the home goal, the human right behind him. */
  function chase(seed: number, carrierX = 60): { s: MatchState; carrier: Footballer; me: Footballer } {
    const s = createMatch(seed, MATCH);
    const carrier = s.players.find((p) => p.team === 'away' && p.number === 9)!;
    const me = human(s);
    only(s, carrier, me);
    Object.assign(carrier, { x: carrierX, y: CENTER.y, vx: -5, vy: 0, facingX: -1, facingY: 0, think: 99 });
    Object.assign(me, { x: carrierX + 1.6, y: CENTER.y, vx: -5, vy: 0, facingX: -1, facingY: 0 });
    Object.assign(s.ball, ball({ x: carrierX - 0.7, y: CENTER.y, vx: -5 }));
    s.possessor = carrier.id;
    return { s, carrier, me };
  }

  it('a standing tackle from the front often wins the ball cleanly', () => {
    let won = 0;
    let fouls = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const s = createMatch(seed, MATCH);
      const carrier = s.players.find((p) => p.team === 'away' && p.number === 9)!;
      const me = human(s);
      only(s, carrier, me);
      Object.assign(carrier, { x: 60, y: CENTER.y, facingX: -1, facingY: 0, think: 99 });
      Object.assign(me, { x: 59, y: CENTER.y, facingX: 1, facingY: 0 });
      Object.assign(s.ball, ball({ x: 59.5, y: CENTER.y }));
      s.possessor = carrier.id;
      press(s, 'pass', DT);
      if (types(s).includes('tackle')) won++;
      if (types(s).includes('foul')) fouls++;
    }
    expect(won).toBeGreaterThanOrEqual(3);
    expect(fouls).toBe(0);
  });

  it('a slide from behind that misses the ball is a foul, then a free kick', () => {
    const { s, carrier } = chase(2);
    press(s, 'shoot', DT, { moveX: -1 });
    run(s, 0.5);
    expect(s.phase).toBe('foul');
    expect(s.foul).toMatchObject({ victimId: carrier.id, penalty: false });
    expect(['yellow', 'red']).toContain(s.foul!.card);
    run(s, FOUL_PAUSE + 0.1);
    expect(s.setPiece).toMatchObject({ type: 'free-kick', team: 'away' });
  });

  it('a second yellow is a red and the player is sent off', () => {
    const { s, me } = chase(4);
    me.yellow = 1;
    press(s, 'shoot', DT, { moveX: -1 });
    run(s, 0.5);
    expect(s.foul?.card).toBe('red');
    run(s, FOUL_PAUSE + 0.1);
    expect(me.sentOff).toBe(true);
  });

  it('a foul in the box is a penalty', () => {
    const { s } = chase(5, 12);
    press(s, 'shoot', DT, { moveX: -1 });
    run(s, 0.5);
    expect(s.foul?.penalty).toBe(true);
    run(s, FOUL_PAUSE + 0.1);
    expect(s.setPiece).toMatchObject({ type: 'penalty', team: 'away', x: PENALTY_SPOT, y: CENTER.y });
  });
});

describe('match flow', () => {
  it('match mode ends at full time, after a half-time break', () => {
    const s = createMatch(1, { mode: 'match', duration: 2, difficulty: 1 });
    run(s, 1.5);
    expect(s.phase).toBe('break');
    run(s, BREAK_PAUSE + 1.5);
    expect(s.phase).toBe('full-time');
  });

  it('training never ends', () => {
    const s = createMatch(1);
    run(s, 30);
    expect(s.phase).not.toBe('full-time');
  });

  it('the referee follows play and stays on the pitch', () => {
    const s = createMatch(1);
    run(s, 6, { ...NO_INPUT, moveX: 1, moveY: 0.3, sprint: true });
    const r = s.referee;
    expect(r.x).toBeGreaterThan(0);
    expect(r.x).toBeLessThan(PITCH_LENGTH);
    expect(r.y).toBeGreaterThan(0);
    expect(r.y).toBeLessThan(PITCH_WIDTH);
    expect(Math.hypot(r.x - s.ball.x, r.y - s.ball.y)).toBeLessThan(30);
  });
});

describe('determinism', () => {
  it('same seed and inputs give an identical 11 v 11 match', () => {
    const script = (s: MatchState) => {
      run(s, 2, { ...NO_INPUT, moveX: 1, sprint: true });
      press(s, 'pass', 0.3, { moveX: 1, moveY: -0.5 });
      run(s, 8);
    };
    const a = createMatch(42, MATCH);
    const b = createMatch(42, MATCH);
    script(a);
    script(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('soak', () => {
  it('five minutes of CPU vs CPU never stalls and produces football', () => {
    const s = createMatch(11, { mode: 'match', duration: 9999, difficulty: 1, autoplay: true });
    let still = 0;
    let maxStill = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 300 / DT; i++) {
      stepMatch(s, NO_INPUT);
      for (const e of s.events) seen.add(e.type);
      s.events.length = 0;
      const moving = Math.hypot(s.ball.vx, s.ball.vy) > 0.05;
      const dead = !!s.setPiece || s.phase !== 'play' || s.players.some((p) => p.gk?.state === 'holding');
      still = moving || dead ? 0 : still + DT;
      maxStill = Math.max(maxStill, still);
    }
    expect(maxStill).toBeLessThan(5);
    for (const t of ['kick', 'tackle', 'save']) expect(seen).toContain(t);
  });
});
