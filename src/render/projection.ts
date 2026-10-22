import { PITCH_LENGTH, PITCH_WIDTH } from '../sim/constants';

// Oblique "broadcast" projection: pitch length runs left-right, depth is
// foreshortened, height lifts things up the screen.
export const PX_X = 8;
export const PX_Y = 5;
export const PX_Z = 7;
export const MARGIN = 32;

export const WORLD_W = Math.ceil(PITCH_LENGTH * PX_X + MARGIN * 2);
export const WORLD_H = Math.ceil(PITCH_WIDTH * PX_Y + MARGIN * 2);

export function project(x: number, y: number, z = 0): { x: number; y: number } {
  return { x: MARGIN + x * PX_X, y: MARGIN + y * PX_Y - z * PX_Z };
}
