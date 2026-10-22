// Procedural pixel-art figures. A tiny 3D skeleton is posed per frame,
// projected with the same oblique camera as the pitch, then rasterised with no
// anti-aliasing. That gives smooth 8-frame run cycles in 16 facing directions
// without hand-drawing hundreds of frames. Replace with real sheets later by
// keeping the frame names.

export const FIG_W = 32;
export const FIG_H = 32;
export const FIG_ANCHOR_X = 16;
export const FIG_ANCHOR_Y = 25;
export const DIRECTIONS = 16;
export const RUN_FRAMES = 8;

// Art pixels per meter: 1.25x the pitch scale, for slightly cartoon proportions.
const SX = 10;
const SY = 6.25;
const SZ = 8.75;

// Body (meters), pelvis at the origin. Local axes: forward, right, up.
const HIP_W = 0.1;
const THIGH = 0.44;
const SHIN = 0.44;
const FOOT = 0.2;
const TORSO = 0.5;
const SHOULDER_W = 0.17;
const CHEST_D = 0.09;
const WAIST_W = 0.12;
const UPPER_ARM = 0.29;
const FOREARM = 0.27;
const NECK = 0.2;
const HEAD_R = 2.3; // px

type RGB = readonly [number, number, number];
type P3 = [number, number, number];

export interface Kit {
  skin: RGB;
  hair: RGB;
  shirt: RGB;
  forearm: RGB;
  shorts: RGB;
  socks: RGB;
  boots: RGB;
  hands: RGB;
}

interface Leg {
  swing: number; // thigh angle, forward positive
  knee: number; // knee flex, shin rotates back
  spread: number; // sideways
}

interface Arm {
  swing: number; // forward positive, PI = straight up
  elbow: number; // forearm bends forward
  raise: number; // sideways
}

interface Pose {
  legL: Leg;
  legR: Leg;
  armL: Arm;
  armR: Arm;
  lean: number; // torso pitch forward
  roll: number; // whole-body roll towards the body's right (dives); 0 = standing
  lift: number; // extra height (standing) or pelvis height (rolled / fixed)
  /** Pelvis height is `lift` instead of feet-on-the-ground (slides). */
  fixed?: boolean;
}

const leg = (swing: number, knee: number, spread = 0.03): Leg => ({ swing, knee, spread });
const arm = (swing: number, elbow: number, raise = 0.12): Arm => ({ swing, elbow, raise });

interface Gait {
  thigh: number;
  knee: number;
  arm: number;
  elbow: number;
  lean: number;
  flight: number;
}

const GAITS: Record<'walk' | 'jog' | 'sprint', Gait> = {
  walk: { thigh: 0.35, knee: 0.6, arm: 0.35, elbow: 0.35, lean: 0.03, flight: 0 },
  jog: { thigh: 0.6, knee: 1.3, arm: 0.65, elbow: 1.3, lean: 0.12, flight: 0.04 },
  sprint: { thigh: 0.85, knee: 1.8, arm: 0.95, elbow: 1.45, lean: 0.25, flight: 0.07 },
};

function gaitPose(phase: number, g: Gait): Pose {
  const w = phase * Math.PI * 2;
  // Knee flexes most just after toe-off, while the leg swings through.
  const legAt = (o: number) => leg(g.thigh * Math.sin(w + o), 0.12 + g.knee * Math.max(0, Math.cos(w + o + Math.PI / 4)));
  const armAt = (o: number) => arm(-g.arm * Math.sin(w + o), g.elbow);
  return {
    legL: legAt(0),
    legR: legAt(Math.PI),
    armL: armAt(0),
    armR: armAt(Math.PI),
    lean: g.lean,
    roll: 0,
    lift: g.flight * Math.max(0, Math.sin(2 * w)),
  };
}

const stand = (o: Partial<Pose>): Pose => ({
  legL: leg(0.04, 0.12, 0.06),
  legR: leg(-0.04, 0.12, 0.06),
  armL: arm(0.05, 0.25),
  armR: arm(-0.05, 0.25),
  lean: 0.02,
  roll: 0,
  lift: 0,
  ...o,
});

function dive(side: 1 | -1): [Pose, Pose, Pose] {
  return [
    stand({ legL: leg(0.3, 0.6), legR: leg(0.1, 0.4), armL: arm(2.4, 0.2, 0.25), armR: arm(2.4, 0.2, 0.25), lean: 0.1, roll: side * 0.7, lift: 0.75 }),
    stand({ legL: leg(0.1, 0.2), legR: leg(0.05, 0.15), armL: arm(3, 0.05), armR: arm(3, 0.05), lean: 0, roll: side * 1.35, lift: 0.6 }),
    stand({ legL: leg(0.3, 0.7), legR: leg(0.1, 0.4), armL: arm(2.7, 0.4, 0.2), armR: arm(2.7, 0.4, 0.2), lean: 0, roll: side * 1.5, lift: 0.15 }),
  ];
}

const [diveR0, diveR1, downR] = dive(1);
const [diveL0, diveL1, downL] = dive(-1);

/** Every frame column in a figure sheet, in order. */
export const POSES: { name: string; pose: Pose }[] = [
  ...(['walk', 'jog', 'sprint'] as const).flatMap((g) =>
    Array.from({ length: RUN_FRAMES }, (_, i) => ({ name: `${g}${i}`, pose: gaitPose(i / RUN_FRAMES, GAITS[g]) })),
  ),
  { name: 'idle0', pose: stand({}) },
  { name: 'idle1', pose: stand({ armL: arm(0.08, 0.4), armR: arm(-0.02, 0.4), lift: 0.02 }) },
  {
    name: 'windup',
    pose: stand({ legR: leg(-0.75, 1.7), legL: leg(0.2, 0.4), armL: arm(0.5, 0.4, 0.7), armR: arm(-0.5, 0.4, 0.35), lean: 0.12 }),
  },
  {
    name: 'strike',
    pose: stand({ legR: leg(0.55, 0.35), legL: leg(0.05, 0.35), armL: arm(-0.2, 0.3, 0.8), armR: arm(0.4, 0.4, 0.4), lean: 0.05 }),
  },
  {
    name: 'follow',
    pose: stand({ legR: leg(1.15, 0.25), legL: leg(-0.05, 0.25), armL: arm(-0.5, 0.3, 0.9), armR: arm(0.6, 0.5, 0.3), lean: -0.08 }),
  },
  {
    name: 'throw',
    pose: stand({ legL: leg(0.3, 0.2), legR: leg(-0.3, 0.3), armL: arm(3.0, 0.6, 0.15), armR: arm(3.0, 0.6, 0.15), lean: -0.15 }),
  },
  {
    name: 'ready',
    pose: stand({ legL: leg(0.35, 0.75, 0.22), legR: leg(0.35, 0.75, 0.22), armL: arm(0.9, 0.4, 0.55), armR: arm(0.9, 0.4, 0.55), lean: 0.35 }),
  },
  { name: 'hold', pose: stand({ armL: arm(1.0, 1.1, 0.25), armR: arm(1.0, 1.1, 0.25) }) },
  {
    name: 'header',
    pose: stand({ legL: leg(-0.3, 1.1), legR: leg(0.15, 1.4), armL: arm(0.7, 0.5, 0.9), armR: arm(0.7, 0.5, 0.9), lean: -0.2, lift: 0.45 }),
  },
  { name: 'point', pose: stand({ armR: arm(1.6, 0.05, 0.5) }) },
  { name: 'card', pose: stand({ armR: arm(3.05, 0, 0.1) }) },
  {
    name: 'tackle',
    pose: stand({ legR: leg(0.9, 0.15, 0.25), legL: leg(-0.25, 0.5), armL: arm(0.3, 0.3, 0.6), armR: arm(-0.4, 0.3, 0.4), lean: 0.3 }),
  },
  {
    name: 'slide',
    pose: stand({
      legR: leg(1.45, 0.05, 0.05),
      legL: leg(1.2, 2.4, 0.1),
      armL: arm(-0.6, 0.3, 0.5),
      armR: arm(-0.9, 0.3, 0.3),
      lean: -1.15,
      lift: 0.2,
      fixed: true,
    }),
  },
  { name: 'diveR0', pose: diveR0 },
  { name: 'diveR1', pose: diveR1 },
  { name: 'downR', pose: downR },
  { name: 'diveL0', pose: diveL0 },
  { name: 'diveL1', pose: diveL1 },
  { name: 'downL', pose: downL },
];

export function frameName(pose: string, dir: number): string {
  return `${pose}@${dir}`;
}

/** Facing angle in pitch space (radians) to the nearest sheet direction. */
export function dirIndex(yaw: number): number {
  const step = (Math.PI * 2) / DIRECTIONS;
  return ((Math.round(yaw / step) % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
}

export function directionYaw(dir: number): number {
  return (dir * Math.PI * 2) / DIRECTIONS;
}

/** Rasterises one pose at one facing into RGBA pixels (FIG_W x FIG_H). */
export function renderFigure(pose: Pose, yaw: number, kit: Kit): Uint8ClampedArray<ArrayBuffer> {
  const r = new Raster();
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cl = Math.cos(pose.lean);
  const sl = Math.sin(pose.lean);
  const lean = (p: P3): P3 => [p[0] * cl + p[2] * sl, p[1], -p[0] * sl + p[2] * cl];
  const cr = Math.cos(pose.roll);
  const sr = Math.sin(pose.roll);
  const roll = (p: P3): P3 => [p[0], p[1] * cr + p[2] * sr, -p[1] * sr + p[2] * cr];
  const add = (a: P3, b: P3, k = 1): P3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const dir = (swing: number, out: number, side: number): P3 => [
    Math.sin(swing) * Math.cos(out),
    side * Math.sin(out),
    -Math.cos(swing) * Math.cos(out),
  ];

  // Legs
  const legs = ([-1, 1] as const).map((side) => {
    const l = side < 0 ? pose.legL : pose.legR;
    const hip: P3 = [0, side * HIP_W, 0];
    const knee = add(hip, dir(l.swing, l.spread, side), THIGH);
    const shinAngle = l.swing - l.knee;
    const ankle = add(knee, dir(shinAngle, l.spread * 0.5, side), SHIN);
    const toe = add(ankle, [Math.cos(shinAngle), 0, Math.sin(shinAngle)], FOOT);
    return { side, hip, knee, ankle, toe };
  });

  // Torso, head, arms
  const shoulders = ([-1, 1] as const).map((side) => lean([0, side * SHOULDER_W, TORSO]));
  const head = lean([0, 0, TORSO + NECK]);
  const arms = ([-1, 1] as const).map((side, i) => {
    const a = side < 0 ? pose.armL : pose.armR;
    const shoulder = shoulders[i];
    const elbow = add(shoulder, dir(a.swing, a.raise, side), UPPER_ARM);
    const hand = add(elbow, dir(a.swing + a.elbow, a.raise, side), FOREARM);
    return { side, shoulder, elbow, hand };
  });
  const torsoPts: P3[] = [];
  for (const f of [-CHEST_D, CHEST_D])
    for (const s of [-1, 1]) {
      torsoPts.push(lean([f, s * SHOULDER_W, TORSO]));
      torsoPts.push([f * 0.9, s * WAIST_W, 0.02]);
    }
  const shortsPts: P3[] = [];
  for (const f of [-CHEST_D, CHEST_D])
    for (const s of [-1, 1]) {
      shortsPts.push([f, s * WAIST_W, 0.06]);
      shortsPts.push([f, s * (WAIST_W + 0.01), -0.12]);
    }

  // Rolled poses float at `lift`; standing poses put the lowest foot on the ground.
  const R = (p: P3) => roll(p);
  const footZ = Math.min(...legs.flatMap((l) => [R(l.ankle)[2], R(l.toe)[2]]));
  const offset = pose.roll || pose.fixed ? pose.lift : -footZ + 0.02 + pose.lift;
  const project = (p: P3) => {
    const q = R(p);
    const X = q[0] * cy - q[1] * sy;
    const Y = q[0] * sy + q[1] * cy;
    return { x: FIG_ANCHOR_X + X * SX, y: FIG_ANCHOR_Y + Y * SY - (q[2] + offset) * SZ, depth: Y };
  };

  // Limbs on the side away from the camera get a darker shade.
  const shadeFor = (side: number) => (Math.abs(cy) > 0.25 && side * cy < 0 ? 0.78 : 1);
  const prims: { depth: number; draw: () => void }[] = [];
  const seg = (a: P3, b: P3, width: number, c: RGB, bias = 0) => {
    const pa = project(a);
    const pb = project(b);
    prims.push({ depth: (pa.depth + pb.depth) / 2 + bias, draw: () => r.line(pa, pb, width, c) });
  };

  for (const l of legs) {
    const k = shadeFor(l.side);
    const mid = add(l.hip, [l.knee[0] - l.hip[0], l.knee[1] - l.hip[1], l.knee[2] - l.hip[2]], 0.45);
    seg(l.hip, mid, 2, shade(kit.shorts, k));
    seg(mid, l.knee, 2, shade(kit.skin, k));
    seg(l.knee, l.ankle, 2, shade(kit.socks, k));
    seg(l.ankle, l.toe, 1, shade(kit.boots, k), 0.001);
    const pa = project(l.ankle);
    prims.push({ depth: pa.depth + 0.001, draw: () => r.stamp(pa.x, pa.y, 2, kit.boots) });
  }
  const torsoDepth = project([0, 0, 0]).depth;
  prims.push({ depth: torsoDepth - 0.001, draw: () => r.hull(shortsPts.map(project), kit.shorts) });
  prims.push({ depth: torsoDepth, draw: () => r.hull(torsoPts.map(project), kit.shirt) });
  for (const a of arms) {
    const k = shadeFor(a.side);
    seg(a.shoulder, a.elbow, 1, shade(kit.shirt, k), 0.002);
    seg(a.elbow, a.hand, 1, shade(kit.forearm, k), 0.002);
    const ph = project(a.hand);
    prims.push({ depth: ph.depth + 0.003, draw: () => r.stamp(ph.x, ph.y, 1, shade(kit.hands, k)) });
  }
  const ph = project(head);
  prims.push({ depth: torsoDepth + 0.05, draw: () => r.head(ph.x, ph.y, yaw, kit) });

  prims.sort((a, b) => a.depth - b.depth);
  for (const p of prims) p.draw();
  r.outline([14, 26, 12], 170);
  return r.data;
}

function shade(c: RGB, k: number): RGB {
  return k === 1 ? c : [c[0] * k, c[1] * k, c[2] * k];
}

class Raster {
  data = new Uint8ClampedArray(FIG_W * FIG_H * 4);

  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= FIG_W || y >= FIG_H) return;
    const i = (y * FIG_W + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }

  stamp(x: number, y: number, width: number, c: RGB): void {
    if (width <= 1) {
      this.set(Math.floor(x), Math.floor(y), c);
      return;
    }
    const x0 = Math.floor(x - 0.5);
    const y0 = Math.floor(y - 0.5);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.set(x0 + dx, y0 + dy, c);
  }

  line(a: { x: number; y: number }, b: { x: number; y: number }, width: number, c: RGB): void {
    const n = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, width, c);
    }
  }

  /** Fills the convex hull of the points (pixel centres inside). */
  hull(points: { x: number; y: number }[], c: RGB): void {
    const h = convexHull(points);
    if (h.length < 3) {
      if (h.length === 2) this.line(h[0], h[1], 2, c);
      return;
    }
    const minX = Math.floor(Math.min(...h.map((p) => p.x)));
    const maxX = Math.ceil(Math.max(...h.map((p) => p.x)));
    const minY = Math.floor(Math.min(...h.map((p) => p.y)));
    const maxY = Math.ceil(Math.max(...h.map((p) => p.y)));
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let inside = true;
        for (let i = 0; i < h.length && inside; i++) {
          const p = h[i];
          const q = h[(i + 1) % h.length];
          if ((q.x - p.x) * (py - p.y) - (q.y - p.y) * (px - p.x) < -0.35) inside = false;
        }
        if (inside) this.set(x, y, c);
      }
  }

  /** Round head with hair on top/back and eyes on the face side, based on facing. */
  head(px: number, py: number, yaw: number, kit: Kit): void {
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const away = -Math.sin(yaw); // 1 = facing away from the camera
    const side = Math.cos(yaw); // 1 = facing screen right
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.hypot(dx, dy) > HEAD_R) continue;
        const hair =
          dy <= -2 ||
          (dy === -1 && away > -0.6) ||
          (away > 0.6 && dy <= 1) ||
          (Math.abs(side) > 0.4 && dx * Math.sign(side) <= -1 && dy <= 0);
        this.set(cx + dx, cy + dy, hair ? kit.hair : kit.skin);
      }
    if (away < 0.5) {
      const eye: RGB = [40, 26, 16];
      if (Math.abs(side) < 0.4) {
        this.set(cx - 1, cy, eye);
        this.set(cx + 1, cy, eye);
      } else {
        this.set(cx + Math.sign(side), cy, eye);
      }
    }
  }

  outline(c: RGB, alpha: number): void {
    const src = this.data.slice();
    const opaque = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < FIG_W && y < FIG_H && src[(y * FIG_W + x) * 4 + 3] > 0;
    for (let y = 0; y < FIG_H; y++)
      for (let x = 0; x < FIG_W; x++) {
        if (opaque(x, y)) continue;
        if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) this.set(x, y, c, alpha);
      }
  }
}

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
