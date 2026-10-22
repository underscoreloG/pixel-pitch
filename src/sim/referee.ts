import { CENTER, PITCH_LENGTH, PITCH_WIDTH, REFEREE_ACCEL, REFEREE_SPEED } from './constants';
import { active, clamp, dist } from './team';
import type { MatchState } from './types';

export function createReferee(): MatchState['referee'] {
  return { x: CENTER.x - 6, y: CENTER.y + 10, vx: 0, vy: 0 };
}

/**
 * Diagonal system, simplified: stay behind play and off to the side so ball
 * and players are in view. After a foul he runs to the spot to show the card.
 */
export function stepReferee(s: MatchState, dt: number): void {
  const r = s.referee;
  const b = s.ball;
  let tx: number;
  let ty: number;
  if (s.phase === 'foul' && s.foul) {
    tx = s.foul.x - 2;
    ty = s.foul.y + (s.foul.y > CENTER.y ? -2 : 2);
  } else if (s.phase === 'goal') {
    tx = CENTER.x;
    ty = CENTER.y + 8;
  } else {
    tx = b.x - 9;
    ty = b.y + (b.y > CENTER.y ? -11 : 11);
  }
  // Keep a few meters from players (except when showing a card).
  if (s.phase !== 'foul') {
    for (const p of active(s)) {
      const d = dist(p, { x: tx, y: ty });
      if (d >= 3 || d === 0) continue;
      tx += ((tx - p.x) / d) * (3 - d);
      ty += ((ty - p.y) / d) * (3 - d);
    }
  }
  tx = clamp(tx, 2, PITCH_LENGTH - 2);
  ty = clamp(ty, 2, PITCH_WIDTH - 2);

  const dx = tx - r.x;
  const dy = ty - r.y;
  const d = Math.hypot(dx, dy);
  // Walks when close to position, runs when play moves away.
  const speed = Math.min(REFEREE_SPEED, Math.max(0, d - 1) * 1.2);
  const tvx = d > 0.01 ? (dx / d) * speed : 0;
  const tvy = d > 0.01 ? (dy / d) * speed : 0;
  const dvx = tvx - r.vx;
  const dvy = tvy - r.vy;
  const dv = Math.hypot(dvx, dvy);
  const maxDv = REFEREE_ACCEL * dt;
  if (dv > maxDv) {
    r.vx += (dvx / dv) * maxDv;
    r.vy += (dvy / dv) * maxDv;
  } else {
    r.vx = tvx;
    r.vy = tvy;
  }
  r.x += r.vx * dt;
  r.y += r.vy * dt;
}
