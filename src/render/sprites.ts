import type Phaser from 'phaser';
import {
  CENTER,
  CENTER_CIRCLE_RADIUS,
  GOAL_AREA_DEPTH,
  GOAL_AREA_WIDTH,
  GOAL_DEPTH,
  GOAL_HEIGHT,
  GOAL_WIDTH,
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_WIDTH,
  PENALTY_SPOT,
  PITCH_LENGTH,
  PITCH_WIDTH,
} from '../sim/constants';
import { PX_X, PX_Y, PX_Z, WORLD_H, WORLD_W, project } from './projection';

import { FIG_H, FIG_W, DIRECTIONS, POSES, type Kit, directionYaw, frameName, renderFigure } from './figure';

// All art is generated in code so the prototype needs no assets. Swap for
// Aseprite sheets later by keeping the texture keys and frame names.

const SKIN = [224, 168, 120] as const;
const HAIR = [58, 42, 26] as const;
const BOOTS = [21, 21, 21] as const;

export const KITS: Record<'home' | 'away' | 'homeKeeper' | 'awayKeeper' | 'referee', Kit> = {
  home: { skin: SKIN, hair: HAIR, shirt: [214, 60, 60], forearm: SKIN, shorts: [240, 240, 230], socks: [214, 60, 60], boots: BOOTS, hands: SKIN },
  away: { skin: [196, 140, 100], hair: [24, 20, 18], shirt: [58, 104, 214], forearm: [196, 140, 100], shorts: [36, 60, 140], socks: [58, 104, 214], boots: BOOTS, hands: [196, 140, 100] },
  homeKeeper: { skin: SKIN, hair: [120, 80, 40], shirt: [70, 170, 80], forearm: [70, 170, 80], shorts: [26, 26, 26], socks: [70, 170, 80], boots: BOOTS, hands: [245, 245, 245] },
  awayKeeper: { skin: SKIN, hair: [120, 80, 40], shirt: [232, 214, 64], forearm: [232, 214, 64], shorts: [26, 26, 26], socks: [232, 214, 64], boots: BOOTS, hands: [245, 245, 245] },
  referee: { skin: [190, 130, 90], hair: [30, 24, 20], shirt: [30, 30, 34], forearm: [190, 130, 90], shorts: [30, 30, 34], socks: [30, 30, 34], boots: BOOTS, hands: [190, 130, 90] },
};

export const BALL_FRAMES = 4;

export function createTextures(scene: Phaser.Scene): void {
  for (const [key, kit] of Object.entries(KITS)) createFigureSheet(scene, key, kit);
  createBall(scene);
  createPitch(scene);
  createGoal(scene);
}

/** One row per facing direction, one column per pose. */
function createFigureSheet(scene: Phaser.Scene, key: string, kit: Kit): void {
  const tex = scene.textures.createCanvas(key, FIG_W * POSES.length, FIG_H * DIRECTIONS)!;
  const ctx = tex.getContext();
  for (let d = 0; d < DIRECTIONS; d++) {
    POSES.forEach(({ name, pose }, c) => {
      const pixels = renderFigure(pose, directionYaw(d), kit);
      ctx.putImageData(new ImageData(pixels, FIG_W, FIG_H), c * FIG_W, d * FIG_H);
      tex.add(frameName(name, d), 0, c * FIG_W, d * FIG_H, FIG_W, FIG_H);
    });
  }
  tex.refresh();
}

function createBall(scene: Phaser.Scene): void {
  // A dark patch that travels round the ball, so rolling reads as spin.
  const frames = [
    ['.ww.', 'wkkw', 'wwww', '.ww.'],
    ['.ww.', 'wwkw', 'wwkw', '.ww.'],
    ['.ww.', 'wwww', 'wkkw', '.ww.'],
    ['.ww.', 'wkww', 'wkww', '.ww.'],
  ];
  const ball = scene.textures.createCanvas('ball', 4 * BALL_FRAMES, 4)!;
  frames.forEach((rows, i) => {
    drawMap(ball.getContext(), rows, { w: '#f8f8f8', k: '#3a3a3a' }, i * 4, 0);
    ball.add(`ball${i}`, 0, i * 4, 0, 4, 4);
  });
  ball.refresh();

  const shadow = scene.textures.createCanvas('shadow', 8, 3)!;
  drawMap(shadow.getContext(), ['.kkkkkk.', 'kkkkkkkk', '.kkkkkk.'], { k: 'rgba(0,0,0,0.35)' }, 0, 0);
  shadow.refresh();
}

function createPitch(scene: Phaser.Scene): void {
  const tex = scene.textures.createCanvas('pitch', WORLD_W, WORLD_H)!;
  const ctx = tex.getContext();
  ctx.fillStyle = '#2f6b2a';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // Mowing stripes, 18 bands along the length.
  const stripes = 18;
  for (let i = 0; i < stripes; i++) {
    const a = project((PITCH_LENGTH / stripes) * i, 0);
    const b = project((PITCH_LENGTH / stripes) * (i + 1), PITCH_WIDTH);
    ctx.fillStyle = i % 2 === 0 ? '#3f8a37' : '#38803a';
    ctx.fillRect(Math.round(a.x), Math.round(a.y), Math.round(b.x) - Math.round(a.x), Math.round(b.y) - Math.round(a.y));
  }

  const line = 'rgba(245,245,235,0.9)';
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    const a = project(x0, y0);
    const b = project(x1, y1);
    plotLine(ctx, a.x, a.y, b.x, b.y, line);
  };
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    seg(x0, y0, x1, y0);
    seg(x1, y0, x1, y1);
    seg(x1, y1, x0, y1);
    seg(x0, y1, x0, y0);
  };
  const arc = (cx: number, cy: number, r: number, from = 0, to = Math.PI * 2) => {
    for (let a = from; a <= to; a += 0.01) {
      const p = project(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      plot(ctx, p.x, p.y, line);
    }
  };

  rect(0, 0, PITCH_LENGTH, PITCH_WIDTH);
  seg(CENTER.x, 0, CENTER.x, PITCH_WIDTH);
  arc(CENTER.x, CENTER.y, CENTER_CIRCLE_RADIUS);
  arc(CENTER.x, CENTER.y, 0.25);
  for (const [gx, dir] of [
    [0, 1],
    [PITCH_LENGTH, -1],
  ] as const) {
    rect(gx, CENTER.y - PENALTY_AREA_WIDTH / 2, gx + dir * PENALTY_AREA_DEPTH, CENTER.y + PENALTY_AREA_WIDTH / 2);
    rect(gx, CENTER.y - GOAL_AREA_WIDTH / 2, gx + dir * GOAL_AREA_DEPTH, CENTER.y + GOAL_AREA_WIDTH / 2);
    const spot = gx + dir * PENALTY_SPOT;
    arc(spot, CENTER.y, 0.25);
    // Penalty arc: the part of the 9.15 m circle outside the box.
    const half = Math.acos((PENALTY_AREA_DEPTH - PENALTY_SPOT) / CENTER_CIRCLE_RADIUS);
    const facing = dir === 1 ? 0 : Math.PI;
    arc(spot, CENTER.y, CENTER_CIRCLE_RADIUS, facing - half, facing + half);
  }
  tex.refresh();
}

// Goals are split in two layers so the ball and players can be depth-sorted
// between the far side (net, far post) and the near side (near post, crossbar).
export const GOAL_TEX_W = Math.ceil(GOAL_DEPTH * PX_X) + 3;
export const GOAL_TEX_H = Math.ceil(GOAL_WIDTH * PX_Y + GOAL_HEIGHT * PX_Z) + 3;

/** Screen position of the goal textures' top-left corner for the goal at +x (mirror for the other). */
export function goalAnchor(): { x: number; y: number } {
  const p = project(PITCH_LENGTH, GOAL_Y_MIN, GOAL_HEIGHT);
  return { x: Math.round(p.x) - 1, y: Math.round(p.y) - 1 };
}

function createGoal(scene: Phaser.Scene): void {
  // Local coords relative to the crossbar's far end.
  const local = (dx: number, y: number, z: number) => ({
    x: 1 + dx * PX_X,
    y: 1 + (y - GOAL_Y_MIN) * PX_Y - (z - GOAL_HEIGHT) * PX_Z,
  });
  const line = (ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, c: string) =>
    plotLine(ctx, a.x, a.y, b.x, b.y, c);

  const net = 'rgba(240,240,240,0.35)';
  const frame = '#f8f8f8';

  const back = scene.textures.createCanvas('goal-back', GOAL_TEX_W, GOAL_TEX_H)!;
  const bctx = back.getContext();
  for (let z = 0; z <= GOAL_HEIGHT + 0.01; z += 0.5) {
    line(bctx, local(GOAL_DEPTH, GOAL_Y_MIN, z), local(GOAL_DEPTH, GOAL_Y_MAX, z), net);
    line(bctx, local(0, GOAL_Y_MIN, z), local(GOAL_DEPTH, GOAL_Y_MIN, z), net);
  }
  for (let y = GOAL_Y_MIN; y <= GOAL_Y_MAX + 0.01; y += 0.6) {
    line(bctx, local(GOAL_DEPTH, y, 0), local(GOAL_DEPTH, y, GOAL_HEIGHT), net);
    line(bctx, local(0, y, GOAL_HEIGHT), local(GOAL_DEPTH, y, GOAL_HEIGHT), net);
  }
  line(bctx, local(0, GOAL_Y_MIN, 0), local(0, GOAL_Y_MIN, GOAL_HEIGHT), frame);
  back.refresh();

  const front = scene.textures.createCanvas('goal-front', GOAL_TEX_W, GOAL_TEX_H)!;
  const fctx = front.getContext();
  for (let z = 0; z <= GOAL_HEIGHT + 0.01; z += 0.5) {
    line(fctx, local(0, GOAL_Y_MAX, z), local(GOAL_DEPTH, GOAL_Y_MAX, z), net);
  }
  line(fctx, local(0, GOAL_Y_MAX, 0), local(0, GOAL_Y_MAX, GOAL_HEIGHT), frame);
  line(fctx, local(0, GOAL_Y_MIN, GOAL_HEIGHT), local(0, GOAL_Y_MAX, GOAL_HEIGHT), frame);
  front.refresh();
}

function drawMap(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  palette: Record<string, string>,
  ox: number,
  oy: number,
): void {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = palette[row[x]];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  });
}

function plot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}

/** Bresenham, so lines stay one crisp pixel wide. */
function plotLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  ctx.fillStyle = color;
  for (;;) {
    ctx.fillRect(x, y, 1, 1);
    if (x === xe && y === ye) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}
