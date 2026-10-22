import { describe, expect, it } from 'vitest';
import { predictCrossing, stepBall } from './ball';
import { CENTER, DT, FOUL_PAUSE, GOAL_HEIGHT, PENALTY_SPOT, PITCH_LENGTH, PITCH_WIDTH } from './constants';
import { NO_INPUT, createMatch, kickoff, stepMatch } from './match';
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
function press(s: MatchState, button: 'pass' | 'shoot' | 'lob', hold = 0.2, extra: Partial<InputFrame> = {}): void {
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
  /** Fouls the attacking side's #9 in the box, waits for the penalty, takes it (human) or lets the CPU, returns the outcome. */
  function penalty(seed: number, team: 'home' | 'away', stick = { moveX: 1, moveY: 0.22 }, charge = 0.7): string {
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
      stepMatch(s, NO_INPUT);
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

  it('CPU penalties are scored at a similar rate', () => {
    const r = rate(seeds.map((seed) => penalty(seed, 'away')));
    expect(r).toBeGreaterThan(0.55);
    expect(r).toBeLessThan(0.95);
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
  it('match mode ends at full time', () => {
    const s = createMatch(1, { mode: 'match', duration: 2, difficulty: 1 });
    run(s, 2.5);
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
