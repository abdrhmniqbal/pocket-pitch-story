/** Playing role - the only four kinds of outfield/GK slot in mini-soccer. */
export type Role = 'GK' | 'DF' | 'MF' | 'FW';

export type Position = Role;

export type TeamSide = 'home' | 'away'; // home = Sun Rays (red/orange), away = Blue Stars (pink/cyan)

export interface PlayerStats {
  speed: number;       // 1 - 99
  kick: number;        // 1 - 99
  technique: number;   // 1 - 99
  defense: number;     // 1 - 99
  stamina: number;     // 1 - 99
}

export type PlayerActionState =
  | 'idle'
  | 'running'
  | 'dribbling'
  | 'kicking'
  | 'tackling'
  | 'sliding'
  | 'prone'
  | 'diving'
  | 'holding'
  | 'throwing'
  | 'celebrating'
  | 'disappointed'
  | 'skill_move'
  | 'shielding'
  | 'jockeying'
  | 'blocking'
  | 'protesting';

export interface HairStyle {
  style: 'short' | 'spiky' | 'bangs' | 'curly' | 'ponytail' | 'buzz';
  color: string; // hex
}

export interface Player {
  id: string;
  name: string;
  number: number;
  team: TeamSide;
  position: Role;
  hair: HairStyle;
  skinColor: string;
  stats: PlayerStats;
  currentStamina: number; // 0 - 100

  // World coordinates on the pitch plane:
  // x: 0 to PITCH_LENGTH (along the length of field)
  // y: 0 to PITCH_WIDTH (across the width of field)
  x: number;
  y: number;
  z: number; // vertical height for jumps/headers

  vx: number;
  vy: number;
  vz: number;

  targetX: number;
  targetY: number;

  baseHomeX: number; // home formation coordinate
  baseHomeY: number;

  facingAngle: number; // in radians
  state: PlayerActionState;
  stateTimer: number; // seconds in current state
  animFrame: number;

  hasBall: boolean;
  tackleCooldown: number;
  catchCooldown?: number;
  yellowCards: number;
  sentOff?: boolean;
  foulCount?: number;
  /** Red-card send-off walk-off (fix 6): steered exit target while leaving. */
  walkingOff?: boolean;
  walkOffTx?: number;
  walkOffTy?: number;
  /** Dribble exposure (fix 4): time+distance of current possession spell. */
  possessionTime?: number;
  possessionDist?: number;
}

export interface Team {
  id: TeamSide;
  name: string;
  shortName: string;
  jerseyColor: string;
  jerseyCollarColor: string;
  shortsColor: string;
  socksColor: string;
  gkJerseyColor: string;
  score: number;
  players: Player[];
  formation: string;
}

export interface Ball {
  x: number;
  y: number;
  z: number; // height above ground
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  carrierId: string | null;
  lastTouchTeam: TeamSide | null;
  lastTouchPlayerId: string | null;
  rotationAngle: number;
  /** Second-touch rule (fix 1): set-piece taker blocked from re-collecting until another player touches. */
  secondTouchBlockId?: string | null;
  /** Set by the woodwork collision in physics; consumed by the engine for commentary. */
  woodworkHit?: 'post' | 'bar' | null;
  /** Refractory window after a woodwork hit so one contact yields one bounce. */
  woodworkCooldown?: number;
}

export type MatchHalf = 'FH' | 'HT' | 'SH' | 'FT'; // First Half, Half Time, Second Half, Full Time

export type SetPieceType = 'corner_kick' | 'throw_in' | 'goal_kick' | 'free_kick' | 'penalty' | null;

export interface SetPieceState {
  type: SetPieceType;
  team: TeamSide | null;
  spot: { x: number; y: number };
  kickerId: string | null;
  timer: number;
}

export interface KickoffState {
  active: boolean;
  team: TeamSide;
  phase: 'ready' | 'whistle' | 'kicking' | 'done';
  timer: number;
  kickerId: string | null;
  partnerId: string | null;
}

export interface MatchStats {
  homePossessionTime: number;
  awayPossessionTime: number;
  homeShots: number;
  awayShots: number;
  homeShotsOnTarget: number;
  awayShotsOnTarget: number;
  homePasses: number;
  awayPasses: number;
  homeTackles: number;
  awayTackles: number;
  homeSaves: number;
  awaySaves: number;
  homeCorners: number;
  awayCorners: number;
  homeThrowIns: number;
  awayThrowIns: number;
  homeFouls?: number;
  awayFouls?: number;
  homeYellows?: number;
  awayYellows?: number;
  homeReds?: number;
  awayReds?: number;
}

export interface MatchCommentaryItem {
  id: string;
  minute: number;
  second: number;
  half: '1H' | '2H';
  text: string;
  type: 'goal' | 'save' | 'shot' | 'tackle' | 'pass' | 'whistle' | 'info' | 'corner' | 'out' | 'kickoff';
  team?: TeamSide;
}

export interface CardBanner {
  playerName: string;
  team: TeamSide;
  kind: 'yellow' | 'second_yellow' | 'red';
  reason: string;
  timer: number;
}

export type CameraMode = 'follow_ball' | 'follow_star' | 'center_pitch' | 'free';

export type PitchTheme = 'dirt' | 'grass' | 'sunset';

export interface VisualEffect {
  id: string;
  type: 'dust' | 'net_ripple' | 'exclamation';
  x: number;
  y: number;
  z: number;
  color?: string;
  life: number; // 0 to 1
  maxLife: number;
  vx?: number;
  vy?: number;
}
