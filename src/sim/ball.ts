import {
  AIR_DRAG,
  BOUNCE_FRICTION,
  BOUNCE_RESTITUTION,
  DT,
  GRAVITY,
  MIN_BOUNCE_SPEED,
  ROLL_DRAG,
  ROLL_RESIST,
  SPIN_DECAY_AIR,
  SPIN_DECAY_GROUND,
} from './constants';
import type { Ball } from './types';

export function stepBall(ball: Ball, dt: number): void {
  const spin = ball.spin ?? 0;
  if (spin !== 0) {
    // Curl: the spin turns the path sideways, strongly in the air and only a little on the grass.
    const airborne = ball.z > 0 || ball.vz > 0;
    const k = spin * dt * (airborne ? 1 : 0.25);
    const vx = ball.vx;
    ball.vx -= ball.vy * k;
    ball.vy += vx * k;
    const next = spin * (1 - (airborne ? SPIN_DECAY_AIR : SPIN_DECAY_GROUND) * dt);
    ball.spin = Math.abs(next) < 0.01 ? 0 : next;
  }
  if (ball.z <= 0 && ball.vz <= 0) {
    // Rolling on grass: linear drag plus constant resistance, so it actually stops.
    ball.z = 0;
    ball.vz = 0;
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > 0) {
      const next = Math.max(0, speed - (ROLL_DRAG * speed + ROLL_RESIST) * dt);
      const k = next / speed;
      ball.vx *= k;
      ball.vy *= k;
    }
  } else {
    const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
    const drag = AIR_DRAG * speed * dt;
    ball.vx -= ball.vx * drag;
    ball.vy -= ball.vy * drag;
    ball.vz -= ball.vz * drag + GRAVITY * dt;
  }

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  if (ball.z < 0) {
    ball.z = 0;
    if (-ball.vz > MIN_BOUNCE_SPEED) {
      ball.vz = -ball.vz * BOUNCE_RESTITUTION;
      ball.vx *= BOUNCE_FRICTION;
      ball.vy *= BOUNCE_FRICTION;
    } else {
      ball.vz = 0;
    }
  }
}

export interface Crossing {
  y: number;
  z: number;
  t: number;
}

/** Simulates a copy of the ball forward and reports where it crosses the plane x = planeX. */
export function predictCrossing(ball: Ball, planeX: number, maxTime: number): Crossing | null {
  const b = { ...ball };
  for (let t = DT; t <= maxTime; t += DT) {
    const prevX = b.x;
    const prevY = b.y;
    const prevZ = b.z;
    stepBall(b, DT);
    if ((prevX - planeX) * (b.x - planeX) <= 0 && prevX !== b.x) {
      const f = (planeX - prevX) / (b.x - prevX);
      return { y: prevY + (b.y - prevY) * f, z: prevZ + (b.z - prevZ) * f, t };
    }
  }
  return null;
}
