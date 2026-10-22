export interface Vec2 {
  x: number;
  y: number;
}

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export type KickType = 'pass' | 'shot' | 'lob';

/** One tick of controller state. Move axes are -1..1, +y is towards the camera. */
export interface InputFrame {
  moveX: number;
  moveY: number;
  sprint: boolean;
  pass: boolean;
  shoot: boolean;
  lob: boolean;
  /** Switch to the teammate nearest the ball. */
  switch: boolean;
}

export interface Buttons {
  pass: boolean;
  shoot: boolean;
  lob: boolean;
  switch: boolean;
}

export interface PendingKick {
  type: KickType;
  power: number;
  ttl: number;
}

/** home = the human side (red, attacks +x), away = the CPU side (blue, attacks -x). */
export type Team = 'home' | 'away';
export type Role = 'GK' | 'DF' | 'MF' | 'FW';

export type KeeperState = 'positioning' | 'diving' | 'down' | 'holding';

export interface KeeperBrain {
  state: KeeperState;
  stateTimer: number;
  threatTimer: number;
  ignoreBall: number;
  diveDir: number;
}

export interface Footballer {
  id: number;
  team: Team;
  role: Role;
  number: number;
  /** Formation slot, team-relative: u = 0 own goal line .. 1 opponent's, v = 0..1 across. */
  slot: { u: number; v: number };
  x: number;
  y: number;
  vx: number;
  vy: number;
  facingX: number;
  facingY: number;
  // Kicking (human input charges, AI kicks directly)
  charging: KickType | null;
  charge: number;
  pending: PendingKick | null;
  kickCooldown: number;
  kickAnim: number;
  throwAnim: number;
  fakeAnim: number;
  lastFakeTick: number;
  // Defending
  tackleCooldown: number;
  tackleAnim: number;
  /** Seconds left in a slide tackle (0 = not sliding). */
  slide: number;
  slideWonBall: boolean;
  /** Seconds left on the ground (fouled, or getting up after a slide). */
  down: number;
  yellow: number;
  sentOff: boolean;
  gk: KeeperBrain | null;
  /** CPU brain timer: next decision when it reaches 0. */
  think: number;
}

export type SetPieceType = 'kickoff' | 'throw-in' | 'corner' | 'goal-kick' | 'free-kick' | 'penalty';

/** A dead ball: only `takerId` may play it, once it is ready. */
export interface SetPiece {
  type: SetPieceType;
  team: Team;
  x: number;
  y: number;
  takerId: number;
  /** AI takers wait until this reaches 0. */
  timer: number;
}

export type Card = 'none' | 'yellow' | 'red';

export interface Foul {
  offenderId: number;
  victimId: number;
  x: number;
  y: number;
  card: Card;
  penalty: boolean;
}

export interface MatchSettings {
  mode: 'match' | 'training';
  /** Match length in real seconds (the HUD scales it to 90 minutes). */
  duration: number;
  difficulty: 0 | 1 | 2;
  /** CPU controls the home side too (menu backdrop demo, soak tests). */
  autoplay?: boolean;
  /** Assisted kicks for the human (default on): pass weight, shot aim, less random error. */
  assist?: boolean;
}

export type MatchEventType =
  | 'goal'
  | 'save'
  | 'catch'
  | 'post'
  | 'bar'
  | 'kickoff'
  | 'kick'
  | 'bounce'
  | 'block'
  | 'tackle'
  | 'fake'
  | 'foul'
  | 'card'
  | 'throw-in'
  | 'corner'
  | 'goal-kick'
  | 'free-kick'
  | 'penalty'
  | 'full-time';

export interface MatchEvent {
  type: MatchEventType;
  tick: number;
  /** 0..1 strength, for sounds. */
  power?: number;
  /** Team concerned: scorer, restart taker, card receiver. */
  team?: Team;
  playerId?: number;
  card?: Card;
}

export type Phase = 'play' | 'goal' | 'out' | 'foul' | 'full-time';

export interface MatchState {
  tick: number;
  rng: { seed: number };
  settings: MatchSettings;
  /** Seconds of match time elapsed. */
  clock: number;
  ball: Ball;
  players: Footballer[];
  /** Id of the home player the human controls. */
  controlled: number;
  /** Human buttons on the previous tick, for press/release edges. */
  prevButtons: Buttons;
  /** Id of the player dribbling the ball, -1 if loose or held by a keeper. */
  possessor: number;
  /** Intended receiver of the last pass, -1 if none. */
  passTarget: number;
  lastTouch: Team;
  lastToucherId: number;
  referee: { x: number; y: number; vx: number; vy: number };
  score: { home: number; away: number };
  phase: Phase;
  phaseTimer: number;
  kickoffTeam: Team;
  restart: { type: SetPieceType; team: Team; x: number; y: number } | null;
  setPiece: SetPiece | null;
  foul: Foul | null;
  /** Appended by the sim, drained by whoever reads them (renderer, tests). */
  events: MatchEvent[];
}
