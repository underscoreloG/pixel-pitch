import { AI_LEVELS, CENTER, GOAL_WIDTH, HEADER_REACH } from './constants';
import { kickBall } from './kick';
import { canHeadNow } from './player';
import { random } from './rng';
import { active, attackDir, dist, inPenaltyArea, keeperOf, other, targetGoalX, teamU } from './team';
import type { Footballer, MatchState } from './types';

/** The human's player cushions a high ball only once it is right on him, leaving time to press a key and head it. */
const CUSHION_REACH = 0.45;

/**
 * Aerial balls: everyone who can get his head to it contests it, the nearest
 * most likely to win. The CPU heads at goal in the box, clears from its own
 * third and flicks on elsewhere. The human's player (if he hasn't pressed a
 * kick key, which heads it in stepHuman) cushions it down to his feet.
 */
export function resolveHeaders(s: MatchState): void {
  const human = s.settings.autoplay ? -1 : s.controlled;
  const contenders = active(s).filter(
    (p) => canHeadNow(s, p) && (p.id !== human || dist(p, s.ball) < CUSHION_REACH),
  );
  if (contenders.length === 0) return;
  // The man the ball was meant for is set for it and wins more than his share.
  const weights = contenders.map((p) => (HEADER_REACH + 0.25 - dist(p, s.ball)) * (p.id === s.passTarget ? 2 : 1));
  let r = random(s.rng) * weights.reduce((a, b) => a + b, 0);
  let winner = contenders[contenders.length - 1];
  for (let i = 0; i < contenders.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      winner = contenders[i];
      break;
    }
  }
  if (winner.id === human) cushion(s, winner);
  else aiHeader(s, winner);
}

/** Nods it down in front of himself and stays on it. */
function cushion(s: MatchState, p: Footballer): void {
  kickBall(s, p, 'pass', 0.05, p.facingX, p.facingY, { header: true, errorMul: 0.3, target: p.id });
}

function aiHeader(s: MatchState, p: Footballer): void {
  const errorMul = AI_LEVELS[s.settings.difficulty].accuracy;
  const goalX = targetGoalX(p.team);
  const dir = attackDir(p.team);
  const ball = s.ball;
  const pressure = Math.min(...active(s).filter((o) => o.team !== p.team).map((o) => dist(o, p)));
  const slow = Math.hypot(ball.vx, ball.vy, ball.vz) < 9;
  if (inPenaltyArea(other(p.team), p.x, p.y) && Math.hypot(goalX - p.x, CENTER.y - p.y) < 15) {
    // At goal, away from the keeper.
    const keeper = keeperOf(s, other(p.team));
    const ty = CENTER.y + (keeper && keeper.y > CENTER.y ? -1 : 1) * (GOAL_WIDTH / 2 - 0.8);
    const n = Math.hypot(goalX - s.ball.x, ty - s.ball.y) || 1;
    kickBall(s, p, 'shot', 0.75, (goalX - s.ball.x) / n, (ty - s.ball.y) / n, { header: true, errorMul });
    return;
  }
  if (slow && pressure > 2.5) {
    // Time to bring it down.
    cushion(s, p);
    return;
  }
  if (teamU(p.team, p.x) < 0.33) {
    // Clear it: high, upfield and away from the middle.
    const side = Math.sign(p.y - CENTER.y) || 1;
    const n = Math.hypot(1, 0.6);
    kickBall(s, p, 'lob', 0.8, dir / n, (0.6 * side) / n, { header: true, errorMul });
    return;
  }
  // Flick it on to the nearest teammate ahead, or nod it forward.
  const mate = active(s)
    .filter((m) => m.team === p.team && !m.gk && m.id !== p.id && dist(m, p) > 3 && dist(m, p) < 18)
    .filter((m) => teamU(p.team, m.x) > teamU(p.team, p.x) - 0.02)
    .sort((a, b) => dist(a, p) - dist(b, p))[0];
  if (!mate) {
    kickBall(s, p, 'pass', 0.35, dir, 0, { header: true, errorMul });
    return;
  }
  const d = dist(mate, s.ball) || 1;
  const power = Math.min(1, Math.max(0.1, (d - 2) / 18));
  kickBall(s, p, 'pass', power, (mate.x - s.ball.x) / d, (mate.y - s.ball.y) / d, {
    header: true,
    errorMul,
    target: mate.id,
  });
}
