// All simulation units are meters, seconds and m/s. The pitch x axis runs
// along its length (home attacks +x), y runs across it, z is height.

export const DT = 1 / 60;

export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
export const CENTER = { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 } as const;

export const GOAL_WIDTH = 7.32;
export const GOAL_HEIGHT = 2.44;
export const GOAL_DEPTH = 2;
export const GOAL_Y_MIN = CENTER.y - GOAL_WIDTH / 2;
export const GOAL_Y_MAX = CENTER.y + GOAL_WIDTH / 2;
export const POST_RADIUS = 0.06;

export const PENALTY_AREA_DEPTH = 16.5;
export const PENALTY_AREA_WIDTH = 40.32;
export const GOAL_AREA_DEPTH = 5.5;
export const GOAL_AREA_WIDTH = 18.32;
export const PENALTY_SPOT = 11;
export const CENTER_CIRCLE_RADIUS = 9.15;

// Ball
export const GRAVITY = 9.81;
export const BALL_RADIUS = 0.11;
export const AIR_DRAG = 0.012; // quadratic, 1/m (about 11 m/s^2 of drag at 30 m/s)
export const ROLL_DRAG = 0.4; // linear, 1/s
export const ROLL_RESIST = 0.6; // constant, m/s^2
export const BOUNCE_RESTITUTION = 0.55;
export const BOUNCE_FRICTION = 0.85; // share of horizontal speed kept per bounce
export const MIN_BOUNCE_SPEED = 0.8; // below this the ball stops bouncing and rolls

// Outfield player
export const PLAYER_JOG_SPEED = 6.5;
export const PLAYER_SPRINT_SPEED = 9;
export const PLAYER_ACCEL = 28;
export const PLAYER_ACCEL_WITH_BALL = 20;
export const PLAYER_DECEL = 35;
export const DRIBBLE_SPEED_FACTOR = 0.93;
export const DRIBBLE_STIFFNESS = 14;
export const GAIN_CONTROL_RADIUS = 0.8;
export const KEEP_CONTROL_RADIUS = 1.35;
export const MAX_CONTROL_HEIGHT = 0.5;
export const MAX_CONTROL_REL_SPEED = 11;
export const KICK_RADIUS = 1.0;
export const MAX_KICK_HEIGHT = 1.2;
export const CHARGE_TIME = 1;
export const MIN_KICK_POWER = 0.1;
export const KICK_BUFFER_TIME = 0.25;
export const KICK_COOLDOWN = 0.25;

// Goalkeeper
export const KEEPER_SPEED = 5;
export const KEEPER_ACCEL = 20;
export const KEEPER_REACTION = 0.18;
export const KEEPER_DIVE_SPEED = 6.5;
export const KEEPER_DIVE_TIME = 0.55;
export const KEEPER_RECOVER_TIME = 0.8;
export const KEEPER_REACH_STANDING = 0.55;
export const KEEPER_REACH_DIVING = 0.9;
export const KEEPER_MAX_STANDING_Z = 2.4;
export const KEEPER_MAX_DIVING_Z = 1.8;
export const KEEPER_SURE_CATCH_SPEED = 10;
export const KEEPER_MAX_CATCH_SPEED = 20;
export const KEEPER_HOLD_TIME = 1.2;
/** Chance a keeper facing a penalty dives the right way, per difficulty (the rest he guesses wrong or stays). */
export const PENALTY_READ = [0.15, 0.22, 0.3] as const;
/** Reaction (s), dive speed (m/s) and catch multiplier per difficulty: easy, normal, hard. */
export const KEEPER_LEVELS = [
  { reaction: 0.28, diveSpeed: 5.6, catchFactor: 0.8 },
  { reaction: KEEPER_REACTION, diveSpeed: KEEPER_DIVE_SPEED, catchFactor: 1 },
  { reaction: 0.12, diveSpeed: 7.3, catchFactor: 1.1 },
] as const;

// Referee
export const REFEREE_SPEED = 8;
export const REFEREE_ACCEL = 10;

// Stoppages
export const GOAL_PAUSE = 2.5;
export const OUT_PAUSE = 1;
export const THROW_HEIGHT = 2;
/** Extra seconds allowed past full time to finish an attack. */
export const MAX_ADDED_TIME = 10;

// Teams, tackles, fouls
export const PLAYER_RADIUS = 0.35;
export const TACKLE_RANGE = 1.1;
export const TACKLE_COOLDOWN = 0.8;
export const TACKLE_ANIM = 0.35;
export const HUMAN_TACKLE_SUCCESS = 0.65;
/** The human's standing tackle lunges further than the CPU's. */
export const HUMAN_TACKLE_REACH = 1.6;
/** Per-tick chance a defender standing on the dribbled ball wins it (human; CPU per difficulty below). */
export const HUMAN_BODY_STEAL = 0.08;
export const SLIDE_RANGE = 3.5;
export const SLIDE_SPEED = 9.5;
export const SLIDE_TIME = 0.55;
export const SLIDE_RECOVER = 0.6;
export const FALL_TIME = 1.4;
export const FOUL_PAUSE = 2.6;
export const FREE_KICK_DISTANCE = 9.15;
/** An AI set-piece taker waits this long at the ball before playing it. */
export const SET_PIECE_DELAY = 0.9;
/** Pass assist picks a teammate within this angle (radians) of the aim. */
export const PASS_ASSIST_CONE = 0.8;
/** CPU decision interval (s), tackle success, kick error multiplier, speed factor, body-steal chance per difficulty. */
export const AI_LEVELS = [
  { decision: 0.35, tackle: 0.25, accuracy: 1.6, speed: 0.92, steal: 0.004 },
  { decision: 0.22, tackle: 0.35, accuracy: 1.2, speed: 0.96, steal: 0.008 },
  { decision: 0.15, tackle: 0.45, accuracy: 1.0, speed: 1.0, steal: 0.012 },
] as const;
