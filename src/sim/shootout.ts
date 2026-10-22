import { computeTickInfo, stepAI } from './ai';
import { stepBall } from './ball';
import {
  BALL_RADIUS,
  CENTER,
  DT,
  GOAL_HEIGHT,
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  PENALTY_SPOT,
  POST_RADIUS,
  SET_PIECE_DELAY,
} from './constants';
import { emit } from './events';
import { stepKeeper } from './keeper';
import { canMove, stepHuman } from './player';
import { active, attackDir, keeperOf, other, targetGoalX } from './team';
import type { Footballer, InputFrame, MatchState, Team } from './types';

/** Who steps up, in order (shirt numbers); the keeper goes last. */
const TAKER_ORDER = [9, 10, 8, 7, 11, 4, 5, 6, 2, 3, 1];
/** Seconds to watch where a kick ends up before it counts as saved or missed. */
const FLIGHT_TIME = 3;
const RESULT_PAUSE = 1.6;

/** A drawn match goes to penalties: five each, then sudden death. Red shoots first. */
export function startShootout(s: MatchState): void {
  s.phase = 'shootout';
  s.possessor = -1;
  s.restart = null;
  s.foul = null;
  s.offside = null;
  s.shootout = {
    goals: { home: 0, away: 0 },
    taken: { home: 0, away: 0 },
    next: { home: 0, away: 0 },
    turn: 'home',
    stage: 'kick',
    timer: 0,
    takerId: -1,
    winner: null,
  };
  emit(s, 'shootout');
  setUpKick(s);
}

/** One tick of the shootout: only the taker, the keepers and the ball move. */
export function stepShootout(s: MatchState, input: InputFrame): void {
  const so = s.shootout!;
  const taker = s.players[so.takerId];
  const keepers = active(s).filter((p) => p.gk);

  if (so.stage === 'kick') {
    const sp = s.setPiece;
    if (sp && Math.hypot(taker.x - sp.x, taker.y - sp.y) < 1.3) sp.timer = Math.max(0, sp.timer - DT);
    if (so.turn === 'home' && !s.settings.autoplay) stepHuman(s, input, DT);
    else if (canMove(taker)) stepAI(s, taker, computeTickInfo(s), DT);
    for (const k of keepers) stepKeeper(s, k, DT);
    if (!s.setPiece) {
      so.stage = 'flight';
      so.timer = FLIGHT_TIME;
    }
    return;
  }

  if (so.stage === 'flight') {
    for (const k of keepers) stepKeeper(s, k, DT);
    const ball = s.ball;
    const prev = { x: ball.x, y: ball.y, z: ball.z };
    if (!keepers.some((k) => k.gk!.state === 'holding')) stepBall(ball, DT);
    so.timer -= DT;
    const outcome = kickOutcome(s, prev);
    if (outcome) {
      if (outcome === 'goal') so.goals[so.turn]++;
      so.taken[so.turn]++;
      emit(s, 'shootout-kick', { team: so.turn, outcome });
      so.stage = 'result';
      so.timer = RESULT_PAUSE;
    }
    return;
  }

  // Result shown: next kick, or the end.
  stepBall(s.ball, DT);
  so.timer -= DT;
  if (so.timer > 0) return;
  so.winner = decided(so.goals, so.taken);
  if (so.winner) {
    s.phase = 'full-time';
    s.setPiece = null;
    emit(s, 'full-time', { team: so.winner });
    return;
  }
  so.turn = other(so.turn);
  setUpKick(s);
}

/** Five each, stopping early once one side can't be caught; then sudden death after each pair. */
export function decided(goals: Record<Team, number>, taken: Record<Team, number>): Team | null {
  const leader: Team = goals.home > goals.away ? 'home' : 'away';
  if (goals.home === goals.away) return null;
  if (taken.home <= 5 && taken.away <= 5) {
    const left = (t: Team) => 5 - taken[t];
    const trailer = other(leader);
    if (goals[leader] > goals[trailer] + left(trailer)) return leader;
    return taken.home === 5 && taken.away === 5 ? leader : null;
  }
  return taken.home === taken.away ? leader : null;
}

/** Ball on the spot, the taker behind it, the keeper on his line, everyone else in the centre circle. */
function setUpKick(s: MatchState): void {
  const so = s.shootout!;
  const team = so.turn;
  const defending = other(team);
  const dir = attackDir(team);
  const goalX = targetGoalX(team);
  const spot = { x: goalX - dir * PENALTY_SPOT, y: CENTER.y };
  const taker = nextTaker(s, team);
  const keeper = keeperOf(s, defending);
  const watchers = active(s).filter((p) => p.id !== taker.id && p.id !== keeper?.id);
  watchers.forEach((p, i) => {
    const a = (i / watchers.length) * Math.PI * 2;
    place(p, CENTER.x + Math.cos(a) * 7, CENTER.y + Math.sin(a) * 7, CENTER.x - p.x, CENTER.y - p.y);
    if (p.gk) p.gk.state = 'positioning';
  });
  // Yours stands right behind the ball, ready to shoot; the CPU's walks up.
  place(taker, spot.x - dir * (team === 'home' && !s.settings.autoplay ? 0.6 : 1.5), spot.y, dir, 0);
  if (keeper) {
    place(keeper, goalX - dir * 0.3, CENTER.y, -dir, 0);
    Object.assign(keeper.gk!, { state: 'positioning', stateTimer: 0, threatTimer: 0, ignoreBall: 0, facingPenalty: true });
  }
  Object.assign(s.ball, { x: spot.x, y: spot.y, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 });
  s.possessor = -1;
  s.passTarget = -1;
  s.lastTouch = team;
  s.setPiece = { type: 'penalty', team, x: spot.x, y: spot.y, takerId: taker.id, timer: team === 'home' ? 0.2 : SET_PIECE_DELAY };
  if (team === 'home') s.controlled = taker.id;
  so.takerId = taker.id;
  so.stage = 'kick';
}

function nextTaker(s: MatchState, team: Team): Footballer {
  const so = s.shootout!;
  const squad = TAKER_ORDER.map((n) => active(s).find((p) => p.team === team && p.number === n)).filter(
    (p): p is Footballer => !!p,
  );
  const taker = squad[so.next[team] % squad.length];
  so.next[team]++;
  return taker;
}

function place(p: Footballer, x: number, y: number, faceX: number, faceY: number): void {
  const n = Math.hypot(faceX, faceY) || 1;
  Object.assign(p, { x, y, vx: 0, vy: 0, facingX: faceX / n, facingY: faceY / n });
  Object.assign(p, { charging: null, charge: 0, pending: null, kickCooldown: 0, slide: 0, down: 0, jump: 0 });
}

/** Where the kick ended up, once it is clear: in, saved, or missed. Hits the woodwork and comes out: missed. */
function kickOutcome(s: MatchState, prev: { x: number; y: number; z: number }): 'goal' | 'saved' | 'missed' | null {
  const so = s.shootout!;
  const ball = s.ball;
  const goalX = targetGoalX(so.turn);
  const crossed = goalX > CENTER.x ? prev.x <= goalX && ball.x > goalX : prev.x >= goalX && ball.x < goalX;
  if (crossed) {
    const f = (goalX - prev.x) / (ball.x - prev.x);
    const y = prev.y + (ball.y - prev.y) * f;
    const z = prev.z + (ball.z - prev.z) * f;
    const hit = POST_RADIUS + BALL_RADIUS;
    const inside = y > GOAL_Y_MIN + hit && y < GOAL_Y_MAX - hit && z < GOAL_HEIGHT - hit;
    // Into the net it stops; anything else is gone.
    ball.vx = ball.vy = ball.vz = 0;
    return inside ? 'goal' : 'missed';
  }
  const keeper = keeperOf(s, other(so.turn));
  if (keeper?.gk?.state === 'holding') return 'saved';
  if (so.timer <= 0) return s.lastToucherId === keeper?.id ? 'saved' : 'missed';
  return null;
}
