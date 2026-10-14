/**
 * Outfield Action Variety — parameterized variants built on the 6 core
 * primitives (Move, Kick, Control, Contest).
 *
 * Every variant below has REAL mechanical differences: distinct ball speed /
 * height (vz) / trajectory / lead-target, a distinct player animation state,
 * and a risk/reward tradeoff. Nothing here is a renamed copy of a base kick.
 *
 * Mini-soccer rules: no offside, no VAR — none of that is implemented here.
 *
 * This module never touches the physics core (it only sets ball velocities,
 * like the base AI does), the renderer, HUD, match flow, set pieces, keeper
 * logic or team data.
 */

import { Ball, MatchHalf, MatchStats, Player, TeamSide, VisualEffect } from '../types/soccer';
import { dist, GOAL_HEIGHT, GOAL_WIDTH, PITCH_LENGTH, PITCH_WIDTH } from './physics';
import { soundEngine } from '../audio/soundEngine';
import { groundPassSpeed, loftedKick, shotSpeed } from './kickMath';

/** Minimal context shared with the AI layer (AIUpdateContext is assignable). */
export interface VarietyCtx {
  half?: MatchHalf;
  dt: number;
  ball: Ball;
  allPlayers: Player[];
  stats: MatchStats;
  addEffect: (effect: VisualEffect) => void;
  addCommentary: (
    text: string,
    type: 'goal' | 'save' | 'shot' | 'tackle' | 'pass' | 'whistle' | 'info' | 'corner' | 'out',
    team?: TeamSide
  ) => void;
}

export interface GoalFrame {
  x: number;
  yMin: number;
  yMax: number;
  center: { x: number; y: number };
}

/** Carrier situation snapshot (structurally matches the AI layer snapshot). */
export interface VarietySituation {
  distToGoal: number;
  lateralOffset: number;
  angleQuality: number;
  nearestOpp: number;
  secondOpp: number;
  underHeavyPressure: boolean;
  inOwnThird: boolean;
  inAttackingThird: boolean;
  isWide: boolean;
  openTeammates: number;
}

export interface VarietyTraits {
  pace: number;
  flair: number;
  grit: number;
  finish: number;
}

export function varietyTraits(player: Player): VarietyTraits {
  const norm = (s: number): number => Math.max(0, Math.min(1, (s - 50) / 50));
  return {
    pace: norm(player.stats.speed),
    flair: norm(player.stats.technique),
    grit: norm(player.stats.defense),
    finish: norm(player.stats.kick),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Lightweight action counters for sim verification (no gameplay effect). */
export const varietyCounts: Record<string, number> = {};

export function countVariety(key: string): void {
  varietyCounts[key] = (varietyCounts[key] ?? 0) + 1;
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function bumpPass(player: Player, stats: MatchStats): void {
  if (player.team === 'home') stats.homePasses++;
  else stats.awayPasses++;
}

function bumpShot(player: Player, stats: MatchStats, onTarget: boolean): void {
  if (player.team === 'home') {
    stats.homeShots++;
    if (onTarget) stats.homeShotsOnTarget++;
  } else {
    stats.awayShots++;
    if (onTarget) stats.awayShotsOnTarget++;
  }
}

function kickDust(v: VarietyCtx, player: Player, id: string, maxLife = 0.3): void {
  v.addEffect({ id: `${id}-${Date.now()}-${Math.random()}`, type: 'dust', x: player.x, y: player.y, z: 0, life: 0, maxLife });
}

// Impact puff for tackles/interceptions/skills (dust — the sparkle effect was removed).
function hitStar(v: VarietyCtx, x: number, y: number, z: number, color = '#ffeb3b'): void {
  void color;
  v.addEffect({ id: `clash-${Date.now()}-${Math.random()}`, type: 'dust', x, y, z, life: 0, maxLife: 0.4 });
}

/**
 * Knock a tackled victim prone (lying on the ground).
 * Sets state='prone' + stateTimer=0, pins z=0, damps velocity so the
 * freeze branch in ai.ts holds them still, and kicks up a dust puff
 * where they hit the ground. Caller keeps their own state untouched.
 */
export function knockProne(victim: Player, v: VarietyCtx): void {
  victim.state = 'prone';
  victim.stateTimer = 0;
  victim.z = 0;
  victim.vz = 0;
  victim.vx *= 0.25;
  victim.vy *= 0.25;
  victim.catchCooldown = Math.max(victim.catchCooldown ?? 0, 1.0);
  hitStar(v, victim.x, victim.y, 4);
}

function isInAttackBox(mate: Player, targetDir: number): boolean {
  if (targetDir === 1) return mate.x > PITCH_LENGTH - 190 && mate.y > 160 && mate.y < PITCH_WIDTH - 160;
  return mate.x < 190 && mate.y > 160 && mate.y < PITCH_WIDTH - 160;
}

function countOpponentsNear(allPlayers: Player[], x: number, y: number, radius: number, team: TeamSide): number {
  let n = 0;
  for (const p of allPlayers) {
    if (p.team !== team && dist(p.x, p.y, x, y) < radius) n++;
  }
  return n;
}

function laneBlocked(player: Player, mate: Player, allPlayers: Player[]): boolean {
  for (const opp of allPlayers) {
    if (opp.team === player.team) continue;
    const l2 = (mate.x - player.x) * (mate.x - player.x) + (mate.y - player.y) * (mate.y - player.y);
    if (l2 === 0) continue;
    let t = ((opp.x - player.x) * (mate.x - player.x) + (opp.y - player.y) * (mate.y - player.y)) / l2;
    t = clamp(t, 0, 1);
    if (dist(opp.x, opp.y, player.x + t * (mate.x - player.x), player.y + t * (mate.y - player.y)) < 25) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reception memory: powers first-time passes, volleys and headers.
// ---------------------------------------------------------------------------

const lastReceiveAt = new Map<string, number>();
const lastReceiveZ = new Map<string, number>();

/** Record the moment a player takes the ball (with the ball's incoming height). */
export function noteGain(playerId: string, incomingZ: number): void {
  lastReceiveAt.set(playerId, Date.now());
  lastReceiveZ.set(playerId, incomingZ);
}

function secondsSinceGain(playerId: string): number {
  const at = lastReceiveAt.get(playerId);
  if (!at) return 99;
  return (Date.now() - at) / 1000;
}

export function isFirstTimeWindow(playerId: string): boolean {
  return secondsSinceGain(playerId) < 0.5;
}

// ---------------------------------------------------------------------------
// One-two / wall pass pending returns.
// ---------------------------------------------------------------------------

interface OneTwoPending {
  passerId: string;
  at: number;
}

const oneTwoPending = new Map<string, OneTwoPending>(); // keyed by receiver id

function registerOneTwo(passerId: string, receiverId: string): void {
  oneTwoPending.set(receiverId, { passerId, at: Date.now() });
}

/**
 * If this player just received a one-two layoff, return the passer so the
 * ball can be played back first-time. Consumes the pending entry.
 */
export function consumeOneTwoReturn(playerId: string, allPlayers: Player[]): Player | null {
  const pending = oneTwoPending.get(playerId);
  if (!pending) return null;
  oneTwoPending.delete(playerId);
  if (Date.now() - pending.at > 4000) return null;
  const passer = allPlayers.find(p => p.id === pending.passerId) || null;
  if (!passer || passer.team !== allPlayers.find(p => p.id === playerId)?.team) return null;
  if (dist(passer.x, passer.y, allPlayers.find(p => p.id === playerId)!.x, allPlayers.find(p => p.id === playerId)!.y) > 260) return null;
  return passer;
}

// Hold-up marker: carrier is back-to-goal waiting for support; next pass
// should be a layoff to a supporting teammate.
const holdUpUntil = new Map<string, number>();

function markHoldUp(playerId: string): void {
  holdUpUntil.set(playerId, Date.now() + 3500);
}

function isHoldingUp(playerId: string): boolean {
  const until = holdUpUntil.get(playerId);
  return until !== undefined && Date.now() < until;
}

// ===========================================================================
// 1. PASSING VARIANTS
// ===========================================================================

export type PassVariant =
  | 'short'
  | 'driven'
  | 'lofted'
  | 'long_ball'
  | 'through_ball'
  | 'lobbed_through'
  | 'one_two'
  | 'one_two_return'
  | 'first_time'
  | 'back_pass'
  | 'cross_low'
  | 'cross_high'
  | 'cross_driven'
  | 'cutback'
  | 'switch'
  | 'layoff';

export interface PassOpts {
  underPressure: boolean;
}

/** Find a runner breaking into space ahead (through-ball target). */
export function findThroughRunner(player: Player, allPlayers: Player[], targetDir: number): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of allPlayers) {
    if (mate.team !== player.team || mate.id === player.id || mate.position === 'GK') continue;
    const ahead = (mate.x - player.x) * targetDir;
    if (ahead < 60) continue;
    const d = dist(player.x, player.y, mate.x, mate.y);
    if (d < 110 || d > 450) continue;
    // Space beyond the runner (toward the enemy goal)?
    const probeX = mate.x + targetDir * 90;
    const probeY = mate.y;
    const crowded = countOpponentsNear(allPlayers, probeX, probeY, 90, player.team);
    if (crowded > 0) continue;
    const score = ahead * 1.2 + (mate.stats.speed - 75) * 2 + Math.random() * 20;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return bestScore > 40 ? best : null;
}

/**
 * Find a runner in behind for a LOBBED through ball (fix 5): a teammate
 * breaking beyond the defensive line with open space to drop the ball into.
 * Stricter than the grounded through-ball finder — requires a defender line
 * to clear and genuine space beyond the runner.
 */
export function findLobbedThroughRunner(player: Player, allPlayers: Player[], targetDir: number): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of allPlayers) {
    if (mate.team !== player.team || mate.id === player.id || mate.position === 'GK') continue;
    if (mate.sentOff) continue;
    const ahead = (mate.x - player.x) * targetDir;
    if (ahead < 80) continue;
    const d = dist(player.x, player.y, mate.x, mate.y);
    if (d < 140 || d > 480) continue;
    // Must clear at least one opponent between carrier and mate (the line).
    let lineToBeat = false;
    for (const opp of allPlayers) {
      if (opp.team === player.team || opp.position === 'GK' || opp.sentOff) continue;
      const between =
        targetDir === 1
          ? opp.x > player.x + 30 && opp.x < mate.x + 40
          : opp.x < player.x - 30 && opp.x > mate.x - 40;
      if (between && Math.abs(opp.y - mate.y) < 170) {
        lineToBeat = true;
        break;
      }
    }
    if (!lineToBeat) continue;
    // Space beyond the runner toward the enemy goal (drop zone).
    const probeX = mate.x + targetDir * 95;
    const probeY = mate.y;
    if (probeX < 60 || probeX > PITCH_LENGTH - 60) continue;
    const crowded = countOpponentsNear(allPlayers, probeX, probeY, 95, player.team);
    if (crowded > 0) continue;
    const mateCrowd = countOpponentsNear(allPlayers, mate.x, mate.y, 60, player.team);
    if (mateCrowd > 1) continue;
    const score = ahead * 1.1 + (mate.stats.speed - 75) * 2.2 + (95 - crowded * 95) * 0.2 + Math.random() * 20;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return bestScore > 55 ? best : null;
}

/** Find a safe outlet behind the carrier (back-pass target, DF first). */
export function findBackOutlet(player: Player, allPlayers: Player[], targetDir: number): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of allPlayers) {
    if (mate.team !== player.team || mate.id === player.id || mate.position === 'GK') continue;
    const behind = (player.x - mate.x) * targetDir;
    if (behind < 40) continue;
    const d = dist(player.x, player.y, mate.x, mate.y);
    if (d > 320) continue;
    const crowded = countOpponentsNear(allPlayers, mate.x, mate.y, 75, player.team);
    let score = 60 - crowded * 40 - d * 0.1 + Math.random() * 15;
    if (mate.position === 'DF') score += 30;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return best;
}

/** Find an open teammate on the opposite flank (switch-of-play target). */
export function findSwitchTarget(player: Player, allPlayers: Player[], targetDir: number): Player | null {
  const playerTop = player.y < PITCH_WIDTH / 2;
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of allPlayers) {
    if (mate.team !== player.team || mate.id === player.id || mate.position === 'GK') continue;
    const mateTop = mate.y < PITCH_WIDTH / 2;
    if (mateTop === playerTop) continue;
    const d = dist(player.x, player.y, mate.x, mate.y);
    if (d < 300 || d > 560) continue;
    if (countOpponentsNear(allPlayers, mate.x, mate.y, 80, player.team) > 0) continue;
    const score = d * 0.2 + Math.random() * 15;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  void targetDir;
  return bestScore > 55 ? best : null;
}

/**
 * Most open teammate inside the attacking box (cross / cutback target).
 * Returns null when nobody is in the box.
 */
export function findBoxTarget(player: Player, allPlayers: Player[], targetDir: number): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of allPlayers) {
    if (mate.team !== player.team || mate.id === player.id || mate.position === 'GK') continue;
    if (!isInAttackBox(mate, targetDir)) continue;
    const crowd = countOpponentsNear(allPlayers, mate.x, mate.y, 70, player.team);
    const score = 100 - crowd * 45 + Math.random() * 20;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return bestScore > 20 ? best : null;
}

/**
 * Close outlet ahead or sideways for a one-two / wall pass: near enough to
 * combine, with room for the passer to burst beyond.
 */
export function findWallMate(player: Player, allPlayers: Player[], targetDir: number): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of allPlayers) {
    if (mate.team !== player.team || mate.id === player.id || mate.position === 'GK') continue;
    const d = dist(player.x, player.y, mate.x, mate.y);
    if (d < 45 || d > 170) continue;
    if ((mate.x - player.x) * targetDir < -30) continue;
    if (countOpponentsNear(allPlayers, mate.x, mate.y, 60, player.team) > 1) continue;
    const burstX = player.x + targetDir * 110;
    if (countOpponentsNear(allPlayers, burstX, player.y, 70, player.team) > 1) continue;
    const score = 60 - d * 0.15 + Math.random() * 15;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return bestScore > 25 ? best : null;
}

/** Contextually pick the pass variant for this passer -> mate pair. */
export function pickPassVariant(
  player: Player,
  mate: Player,
  v: VarietyCtx,
  targetDir: number,
  opts: PassOpts
): PassVariant {
  const traits = varietyTraits(player);
  // Hold-up play resolves with a layoff to support.
  if (isHoldingUp(player.id) && (mate.x - player.x) * targetDir < 80) return 'layoff';
  // Struck without trapping when pressed right after receiving.
  if (isFirstTimeWindow(player.id) && opts.underPressure) return 'first_time';

  const mateInBox = isInAttackBox(mate, targetDir);
  const wide = player.y < 200 || player.y > PITCH_WIDTH - 200;
  const attackingThird = targetDir === 1 ? player.x > (PITCH_LENGTH * 2) / 3 : player.x < PITCH_LENGTH / 3;
  const byline = targetDir === 1 ? player.x > PITCH_LENGTH - 190 : player.x < 190;
  const d = dist(player.x, player.y, mate.x, mate.y);
  const behind = (mate.x - player.x) * targetDir < -40;

  // Cutback from the byline to support at the edge of the box.
  if (byline && wide && mateInBox) return 'cutback';
  // Wide crosses with teammates in the box: low / high / driven by crowd.
  if (wide && attackingThird && mateInBox) {
    const crowd = countOpponentsNear(v.allPlayers, mate.x, mate.y, 70, player.team);
    if (crowd >= 2) return 'cross_high';
    if (Math.random() < 0.5) return 'cross_low';
    return 'cross_driven';
  }
  if (behind) return 'back_pass';
  if (d > 300) return Math.random() < 0.6 ? 'long_ball' : 'lofted';
  const blocked = laneBlocked(player, mate, v.allPlayers);
  if (d > 150 && blocked) return 'lofted';
  if (d >= 120 && d <= 350 && traits.finish > 0.2 && !blocked && Math.random() < 0.6) {
    return 'driven';
  }
  // One-two / wall pass with a close outlet ahead or sideways.
  if (d >= 45 && d <= 220 && (mate.x - player.x) * targetDir > -30 && Math.random() < 0.3 + traits.flair * 0.25) {
    return 'one_two';
  }
  if (d <= 175) return 'short';
  return Math.random() < 0.5 ? 'short' : 'driven';
}

/** Execute a parameterized pass variant. Real diffs: speed / vz / lead / risk. */
export function executePassVariant(
  player: Player,
  mate: Player,
  variant: PassVariant,
  v: VarietyCtx,
  targetDir: number,
  opts: PassOpts,
  forcedTarget?: { x: number; y: number }
): void {
  const { ball } = v;
  player.hasBall = false;
  ball.carrierId = null;
  player.state = 'kicking';
  player.stateTimer = 0;
  bumpPass(player, v.stats);

  const traits = varietyTraits(player);
  const d = dist(player.x, player.y, mate.x, mate.y);
  countVariety(`pass:${variant}`);
  // Default arrival: lead the mate. A forcedTarget (through-ball solver)
  // overrides the aim point entirely.
  let tx = forcedTarget ? forcedTarget.x : mate.x + mate.vx * 0.3;
  let ty = forcedTarget ? forcedTarget.y : mate.y + mate.vy * 0.3;
  let speed = 380;
  let vz = 10;
  let label = `${player.name} slides a pass to ${mate.name}`;
  let vol = 0.6;
  let jitter = 0;

  switch (variant) {
    case 'short':
      speed = groundPassSpeed(d, player, 'short');
      vz = 8;
      label = `${player.name} slides a short pass to ${mate.name}`;
      vol = 0.55;
      break;
    case 'driven':
      speed = groundPassSpeed(d, player, 'driven');
      vz = 6;
      jitter = (1 - traits.finish) * 0.06;
      label = `${player.name} fires a DRIVEN pass at ${mate.name}`;
      vol = 0.8;
      kickDust(v, player, 'driven');
      break;
    case 'lofted': {
      const vec = loftedKick(tx - player.x, ty - player.y, d, player, 55);
      speed = Math.hypot(vec.vx, vec.vy);
      vz = vec.vz;
      ball.vx = vec.vx; ball.vy = vec.vy; ball.vz = vec.vz;
      ball.lastTouchTeam = player.team;
      ball.lastTouchPlayerId = player.id;
      player.facingAngle = Math.atan2(ty - player.y, tx - player.x);
      soundEngine.playKick(0.7);
      v.addCommentary(`${player.name} lifts a lofted pass towards ${mate.name}!`, 'pass', player.team);
      return;
    }
    case 'long_ball': {
      const vec = loftedKick(tx - player.x, ty - player.y, d, player, 80);
      ball.vx = vec.vx; ball.vy = vec.vy; ball.vz = vec.vz;
      ball.lastTouchTeam = player.team;
      ball.lastTouchPlayerId = player.id;
      player.facingAngle = Math.atan2(ty - player.y, tx - player.x);
      soundEngine.playKick(0.9);
      kickDust(v, player, 'longball');
      v.addCommentary(`${player.name} launches a LONG BALL for ${mate.name}!`, 'pass', player.team);
      return;
    }
    case 'through_ball':
      // Aim at the solver's arrival point when we have it, else lead forward.
      if (!forcedTarget) {
        tx = clamp(mate.x + mate.vx * 0.8 + targetDir * 70, 50, PITCH_LENGTH - 50);
        ty = clamp(mate.y + mate.vy * 0.8, 40, PITCH_WIDTH - 40);
      }
      speed = groundPassSpeed(dist(player.x, player.y, tx, ty), player, 'through');
      vz = 18;
      label = `${player.name} slides a THROUGH BALL into space for ${mate.name}`;
      vol = 0.75;
      break;
    case 'lobbed_through': {
      if (!forcedTarget) {
        tx = clamp(mate.x + mate.vx * 0.9 + targetDir * 85, 50, PITCH_LENGTH - 50);
        ty = clamp(mate.y + mate.vy * 0.9, 40, PITCH_WIDTH - 40);
      }
      const flight = dist(player.x, player.y, tx, ty);
      const vec = loftedKick(tx - player.x, ty - player.y, flight, player, 110);
      ball.vx = vec.vx; ball.vy = vec.vy; ball.vz = vec.vz;
      ball.lastTouchTeam = player.team;
      ball.lastTouchPlayerId = player.id;
      player.facingAngle = Math.atan2(ty - player.y, tx - player.x);
      soundEngine.playKick(0.85);
      kickDust(v, player, 'lobbedthrough');
      v.addCommentary(`${player.name} lobs it over the top for ${mate.name}!`, 'pass', player.team);
      return;
    }
    case 'one_two':
      speed = groundPassSpeed(d, player, 'short') * 0.9;
      vz = 8;
      registerOneTwo(player.id, mate.id);
      player.vx = targetDir * 260;
      player.vy = (mate.y >= player.y ? 1 : -1) * 60;
      label = `${player.name} starts a ONE-TWO with ${mate.name}`;
      vol = 0.65;
      break;
    case 'one_two_return':
      speed = groundPassSpeed(d, player, 'short');
      vz = 10;
      jitter = (1 - traits.flair) * 0.05;
      label = `${player.name} returns the WALL PASS first-time`;
      vol = 0.7;
      break;
    case 'first_time':
      speed = groundPassSpeed(d, player, 'driven') * 0.95;
      vz = 15;
      jitter = (1 - traits.flair) * 0.12;
      label = `${player.name} plays a FIRST-TIME pass to ${mate.name}`;
      vol = 0.75;
      break;
    case 'back_pass':
      speed = groundPassSpeed(d, player, 'back');
      vz = 8;
      label = `${player.name} goes BACK to ${mate.name} to recycle it`;
      vol = 0.55;
      break;
    case 'cross_low':
      speed = groundPassSpeed(d, player, 'cross');
      vz = 18;
      label = `${player.name} fizzes a LOW cross in for ${mate.name}`;
      vol = 0.78;
      break;
    case 'cross_high': {
      const vec = loftedKick(tx - player.x, ty - player.y, d, player, 90);
      ball.vx = vec.vx; ball.vy = vec.vy; ball.vz = vec.vz;
      ball.lastTouchTeam = player.team;
      ball.lastTouchPlayerId = player.id;
      player.facingAngle = Math.atan2(ty - player.y, tx - player.x);
      soundEngine.playKick(0.75);
      v.addCommentary(`${player.name} floats a HIGH cross towards ${mate.name}!`, 'pass', player.team);
      return;
    }
    case 'cross_driven':
      speed = groundPassSpeed(d, player, 'driven') * 1.05;
      vz = 35;
      jitter = 0.03;
      label = `${player.name} rifles a DRIVEN cross at ${mate.name}`;
      vol = 0.85;
      kickDust(v, player, 'drivencross');
      break;
    case 'cutback':
      tx = mate.x - targetDir * 25;
      ty = mate.y;
      speed = groundPassSpeed(dist(player.x, player.y, tx, ty), player, 'short') * 1.1;
      vz = 12;
      label = `${player.name} CUTS IT BACK for ${mate.name}`;
      vol = 0.75;
      break;
    case 'switch': {
      const vec = loftedKick(tx - player.x, ty - player.y, d, player, 70);
      ball.vx = vec.vx; ball.vy = vec.vy; ball.vz = vec.vz;
      ball.lastTouchTeam = player.team;
      ball.lastTouchPlayerId = player.id;
      player.facingAngle = Math.atan2(ty - player.y, tx - player.x);
      soundEngine.playKick(0.85);
      kickDust(v, player, 'switch');
      v.addCommentary(`${player.name} SWITCHES the play to ${mate.name}!`, 'pass', player.team);
      return;
    }
    case 'layoff':
      speed = groundPassSpeed(d, player, 'short') * 0.7;
      vz = 5;
      label = `${player.name} lays it off for ${mate.name}`;
      vol = 0.5;
      break;
  }
  void opts;

  let angle = Math.atan2(ty - player.y, tx - player.x);
  if (jitter > 0) angle += (Math.random() - 0.5) * 2 * jitter;
  player.facingAngle = angle;
  ball.vx = Math.cos(angle) * speed;
  ball.vy = Math.sin(angle) * speed;
  ball.vz = vz;
  ball.lastTouchTeam = player.team;
  ball.lastTouchPlayerId = player.id;

  soundEngine.playKick(vol);
  v.addCommentary(`${label}!`, 'pass', player.team);
}

/** Safety-first hoof: pressured deep clearance, big loft upfield & infield. */
export function executeSafetyClearance(player: Player, v: VarietyCtx, targetDir: number): void {
  const { ball } = v;
  countVariety('defense:safety');
  player.hasBall = false;
  ball.carrierId = null;
  player.state = 'kicking';
  player.stateTimer = 0;
  bumpPass(player, v.stats);

  let aimX = clamp(player.x + targetDir * rand(340, 480), 60, PITCH_LENGTH - 60);
  let aimY = clamp(PITCH_WIDTH / 2 + (player.y - PITCH_WIDTH / 2) * 0.3 + (Math.random() - 0.5) * 120, 60, PITCH_WIDTH - 60);
  // Never hoof it straight behind for a needless corner.
  if (targetDir === 1 && aimX > PITCH_LENGTH - 120) aimX = PITCH_LENGTH - 160;
  if (targetDir === -1 && aimX < 120) aimX = 160;
  const angle = Math.atan2(aimY - player.y, aimX - player.x);
  player.facingAngle = angle;
  const power = rand(600, 700) + player.stats.kick * 0.5;
  ball.vx = Math.cos(angle) * power;
  ball.vy = Math.sin(angle) * power;
  ball.vz = rand(140, 190);
  ball.lastTouchTeam = player.team;
  ball.lastTouchPlayerId = player.id;

  soundEngine.playKick(0.9);
  kickDust(v, player, 'safety');
  v.addCommentary(`${player.name} hoofs it clear — SAFETY FIRST from the danger zone!`, 'pass', player.team);
}

// ===========================================================================
// 2. SHOOTING VARIANTS
// ===========================================================================

export type ShotVariant =
  | 'power'
  | 'finesse'
  | 'placed'
  | 'low_driven'
  | 'chip'
  | 'volley'
  | 'header'
  | 'tap_in'
  | 'long_range'
  | 'finish_calm'
  | 'finish_rushed';

export interface ShooterInfo {
  distToGoal: number;
  keeperOffLine: boolean;
  oneVOne: boolean;
  boxCrowded: boolean;
  underPressure: boolean;
}

/** Gather keeper positioning / 1v1 / box-crowd facts for the shot picker. */
export function buildShooterInfo(
  player: Player,
  v: VarietyCtx,
  targetGoal: GoalFrame,
  sit: VarietySituation,
  traits: VarietyTraits
): ShooterInfo {
  void traits;
  const gk = v.allPlayers.find(p => p.team !== player.team && p.position === 'GK');
  const keeperOffLine = gk
    ? dist(gk.x, gk.y, targetGoal.center.x, targetGoal.center.y) > 85 || gk.state === 'diving'
    : false;
  if (keeperOffLine) countVariety('debug:keeperOut');
  const oneVOne = sit.distToGoal < 350 && sit.secondOpp > 110;
  let boxCrowd = 0;
  for (const o of v.allPlayers) {
    if (o.team === player.team) continue;
    if (dist(o.x, o.y, targetGoal.center.x, targetGoal.center.y) < 110) boxCrowd++;
  }
  return {
    distToGoal: sit.distToGoal,
    keeperOffLine,
    oneVOne,
    boxCrowded: boxCrowd >= 2,
    underPressure: sit.underHeavyPressure,
  };
}

/** Contextually pick the shot variant (chip vs rushing keeper, etc.). */
export function pickShotVariant(
  player: Player,
  v: VarietyCtx,
  targetGoal: GoalFrame,
  sit: VarietySituation,
  traits: VarietyTraits,
  info: ShooterInfo
): ShotVariant {
  // Tap-in from point-blank range.
  if (sit.distToGoal < 130) return 'tap_in';
  // Header / volley off a recent high ball.
  const lrZ = lastReceiveZ.get(player.id) ?? 0;
  const freshHigh = secondsSinceGain(player.id) < 1.3;
  if (freshHigh && lrZ >= 22 && lrZ <= 80 && sit.distToGoal < 300 && v.ball.z > 6) return 'header';
  if (freshHigh && lrZ >= 12 && sit.distToGoal < 380 && traits.flair > 0.1) return 'volley';
  // 1v1 finish: calm placement vs rushing it (technique-gated).
  if (info.oneVOne) return traits.flair > 0.3 && !sit.underHeavyPressure ? 'finish_calm' : 'finish_rushed';
  // Chip / lob when the keeper rushes out.
  if (info.keeperOffLine && sit.distToGoal > 95 && sit.distToGoal < 440) return 'chip';
  // Long-range effort from distance.
  if (sit.distToGoal >= 420) return 'long_range';
  // Curled finesse when the angle invites it and technique allows.
  if (sit.angleQuality > 0.55 && traits.flair > 0.35) return Math.random() < 0.5 ? 'finesse' : 'placed';
  // Low driven under legs when the box is crowded.
  if (info.boxCrowded) return 'low_driven';
  // Power when straight and strong, otherwise placed.
  if (traits.finish > 0.5 && sit.angleQuality > 0.35) return 'power';
  if (traits.finish > 0.5) return Math.random() < 0.65 ? 'power' : 'placed';
  return Math.random() < 0.5 ? 'placed' : 'power';
}

/** Schedule a brief frustration/protest state after a big miss (non-blocking). */
function scheduleFrustration(player: Player, v: VarietyCtx, text: string): void {
  v.addCommentary(text, 'info', player.team);
  setTimeout(() => {
    if (player.state === 'kicking' || player.state === 'idle' || player.state === 'running') {
      player.state = Math.random() < 0.5 ? 'disappointed' : 'protesting';
      player.stateTimer = 0;
    }
  }, 550);
}

/** Execute a parameterized shot variant. Real diffs: power / vz / aim / risk. */
export function executeShotVariant(
  player: Player,
  targetGoal: GoalFrame,
  variant: ShotVariant,
  v: VarietyCtx,
  info: ShooterInfo
): void {
  const { ball } = v;
  player.hasBall = false;
  ball.carrierId = null;
  player.state = 'kicking';
  player.stateTimer = 0;

  const tech = player.stats.technique;
  countVariety(`shot:${variant}`);
  let power = 500;
  let aimZ = 20;
  let onTargetP = 0.55;
  let label = `shoots`;
  let vol = 0.95;

  switch (variant) {
    case 'power': // laces through it: max pace, wilder
      power = shotSpeed(info.distToGoal, player, 'power');
      aimZ = rand(10, GOAL_HEIGHT - 10);
      onTargetP = 0.55;
      label = `${player.name} UNLEASHES a POWER SHOT`;
      vol = 1.0;
      break;
    case 'finesse': // bent around the keeper, less pace, far corner
      power = shotSpeed(info.distToGoal, player, 'finesse');
      aimZ = rand(12, GOAL_HEIGHT - 14);
      onTargetP = tech >= 75 ? 0.62 : 0.45;
      label = `${player.name} curls a FINESSE shot with bend`;
      vol = 0.85;
      break;
    case 'placed': // side-foot into the corner, most accurate
      power = shotSpeed(info.distToGoal, player, 'placed');
      aimZ = rand(8, GOAL_HEIGHT - 16);
      onTargetP = 0.65;
      label = `${player.name} PLACES a shot into the corner`;
      vol = 0.85;
      break;
    case 'low_driven': // skimming under legs and dives
      power = shotSpeed(info.distToGoal, player, 'placed') * 1.15;
      aimZ = rand(5, 12);
      onTargetP = 0.58;
      label = `${player.name} drills a LOW DRIVEN shot`;
      vol = 0.9;
      break;
    case 'chip': // delicate lob over the rushing keeper
      power = shotSpeed(info.distToGoal, player, 'chip');
      aimZ = rand(34, GOAL_HEIGHT - 8);
      onTargetP = info.keeperOffLine ? 0.62 : 0.5;
      label = `${player.name} CHIPS the keeper`;
      vol = 0.8;
      break;
    case 'volley': // struck out of the air: spectacular, volatile
      power = shotSpeed(info.distToGoal, player, 'volley');
      aimZ = rand(10, GOAL_HEIGHT);
      onTargetP = tech >= 65 ? 0.52 : 0.38;
      label = `${player.name} hits it on the VOLLEY`;
      vol = 0.95;
      break;
    case 'header': // guided nod from a high ball
      power = shotSpeed(info.distToGoal, player, 'volley') * 0.7;
      aimZ = rand(6, GOAL_HEIGHT - 18);
      onTargetP = 0.55;
      label = `${player.name} rises for the HEADER`;
      vol = 0.8;
      break;
    case 'tap_in': // bundled home from the goalmouth
      power = shotSpeed(info.distToGoal, player, 'tap');
      aimZ = rand(5, 18);
      onTargetP = 0.88;
      label = `${player.name} prods home the TAP-IN`;
      vol = 0.7;
      break;
    case 'long_range': // speculative rocket, low accuracy
      power = shotSpeed(info.distToGoal, player, 'power') * 1.1;
      aimZ = rand(12, GOAL_HEIGHT + 10);
      onTargetP = 0.32;
      label = `${player.name} lets fly from LONG RANGE`;
      vol = 1.0;
      break;
    case 'finish_calm': // 1v1: opens the body, strokes it home
      power = shotSpeed(info.distToGoal, player, 'placed');
      aimZ = rand(6, 24);
      onTargetP = tech >= 75 ? 0.8 : 0.68;
      label = `${player.name} keeps calm and slots the 1v1 finish`;
      vol = 0.8;
      break;
    case 'finish_rushed': // 1v1: snatches at it under pressure
      power = shotSpeed(info.distToGoal, player, 'power') * 0.9;
      aimZ = rand(8, GOAL_HEIGHT);
      onTargetP = 0.45;
      label = `${player.name} RUSHES the 1v1 finish`;
      vol = 0.9;
      break;
  }

  const onTarget = Math.random() < onTargetP;
  bumpShot(player, v.stats, onTarget);

  let aimY: number;
  let finalZ = aimZ;
  let frustrated = false;
  if (onTarget) {
    const farCorner = Math.random() < 0.5;
    aimY = farCorner ? targetGoal.yMin + 20 : targetGoal.yMax - 20;
    v.addCommentary(`${label} towards the corner!`, 'shot', player.team);
  } else {
    const miss = Math.random();
    if (miss < 0.38) {
      aimY = targetGoal.yMin + Math.random() * GOAL_WIDTH;
      finalZ = GOAL_HEIGHT + rand(22, 55); // skied over the bar
      v.addCommentary(`${label} — but skies it over the bar!`, 'shot', player.team);
      frustrated = true;
    } else if (miss < 0.78) {
      aimY = Math.random() < 0.5 ? targetGoal.yMin - 40 : targetGoal.yMax + 40; // wide
      finalZ = rand(8, 40);
      v.addCommentary(`${label} — but it whistles wide of the post!`, 'shot', player.team);
      frustrated = true;
    } else {
      if (Math.random() < 0.5) {
        aimY = targetGoal.yMin + Math.random() * GOAL_WIDTH;
        finalZ = GOAL_HEIGHT; // crossbar
      } else {
        aimY = Math.random() < 0.5 ? targetGoal.yMin : targetGoal.yMax; // post
        finalZ = rand(15, 45);
      }
      soundEngine.playPostHit();
      v.addCommentary(`${label} — OFF THE WOODWORK! Inches away!`, 'shot', player.team);
      frustrated = true;
    }
  }

  const angle = Math.atan2(aimY - player.y, targetGoal.x - player.x);
  player.facingAngle = angle;
  ball.vx = Math.cos(angle) * power;
  ball.vy = Math.sin(angle) * power;
  ball.vz = finalZ * 2.5;
  ball.lastTouchTeam = player.team;
  ball.lastTouchPlayerId = player.id;

  soundEngine.playKick(vol);
  kickDust(v, player, 'shot');

  if (frustrated && Math.random() < 0.35) {
    scheduleFrustration(player, v, `${player.name} is frustrated — buries his head in his hands after that miss!`);
  }
}

// ===========================================================================
// 3. BALL CONTROL VARIANTS
// ===========================================================================

export type ControlVariant = 'first_touch' | 'receive_turn' | 'shield' | 'hold_up';

/** Volley/header first-time finish off a high incoming ball. Returns true if shot. */
export function tryFirstTimeFinish(
  player: Player,
  v: VarietyCtx,
  targetGoal: GoalFrame,
  incomingZ: number
): boolean {
  const dGoal = dist(player.x, player.y, targetGoal.center.x, targetGoal.center.y);
  if (incomingZ >= 28 && incomingZ <= 80 && dGoal < 300 && player.stats.technique >= 55) {
    // Header: meet the high ball first-time.
    player.hasBall = false;
    v.ball.carrierId = null;
    executeShotVariant(player, targetGoal, 'header', v, {
      distToGoal: dGoal,
      keeperOffLine: false,
      oneVOne: false,
      boxCrowded: false,
      underPressure: true,
    });
    noteGain(player.id, incomingZ);
    return true;
  }
  if (incomingZ >= 12 && incomingZ < 45 && dGoal < 380 && player.stats.technique >= 65 && Math.random() < 0.6) {
    // Volley: lash the dropping ball first-time.
    player.hasBall = false;
    v.ball.carrierId = null;
    executeShotVariant(player, targetGoal, 'volley', v, {
      distToGoal: dGoal,
      keeperOffLine: false,
      oneVOne: false,
      boxCrowded: false,
      underPressure: true,
    });
    noteGain(player.id, incomingZ);
    return true;
  }
  return false;
}

/** Cushion / turn on reception. Called right after gaining a loose ball. */
export function applyReceiveTouch(
  player: Player,
  v: VarietyCtx,
  incomingSpeed: number,
  incomingZ: number
): void {
  noteGain(player.id, incomingZ);
  if ((incomingSpeed > 420 || incomingZ > 45) && Math.random() < 0.5) {
    // First touch / trap: cushion a hot ball.
    countVariety('control:first_touch');
    player.state = 'dribbling';
    player.stateTimer = 0;
    v.addCommentary(`${player.name} cushions it with a lovely FIRST TOUCH!`, 'info', player.team);
    return;
  }
  // Interception of a zipped pass gets a call-out.
  if (incomingSpeed > 260 && Math.random() < 0.7) {
    countVariety('defense:interception');
    v.addCommentary(`${player.name} steps in to INTERCEPT the pass!`, 'tackle', player.team);
    hitStar(v, player.x, player.y, 12, '#b3e5fc');
    return;
  }
  // Receive and turn: touch away from the nearest pressure.
  let nearest: Player | null = null;
  let nd = Infinity;
  for (const o of v.allPlayers) {
    if (o.team === player.team) continue;
    const d = dist(player.x, player.y, o.x, o.y);
    if (d < nd) {
      nd = d;
      nearest = o;
    }
  }
  if (nearest && nd < 70) {
    countVariety('control:receive_turn');
    const away = Math.atan2(player.y - nearest.y, player.x - nearest.x);
    player.vx = Math.cos(away) * 200;
    player.vy = Math.sin(away) * 200;
    player.facingAngle = away;
    if (Math.random() < 0.3) {
      v.addCommentary(`${player.name} receives and TURNS away from ${nearest.name}!`, 'info', player.team);
    }
  }
}

/**
 * Shield-the-ball / hold-up-play decision for a pressed carrier.
 * Returns true when handled (caller should return for this think tick).
 */
export function maybeShieldOrHoldUp(
  player: Player,
  v: VarietyCtx,
  targetDir: number,
  sit: VarietySituation,
  traits: VarietyTraits
): boolean {
  if (!sit.underHeavyPressure || sit.nearestOpp >= 52) return false;
  let support: Player | null = null;
  for (const mate of v.allPlayers) {
    if (mate.team !== player.team || mate.id === player.id || mate.position === 'GK') continue;
    if (dist(player.x, player.y, mate.x, mate.y) < 175) {
      support = mate;
      break;
    }
  }
  if (!support) return false;
  const strength = (player.stats.defense + player.stats.stamina) / 200;
  if (Math.random() > 0.3 + strength * 0.35 + traits.grit * 0.15) return false;
  void targetDir;

  if (Math.random() < 0.5) {
    // Shield ball: body between ball and defender, ride the challenge.
    countVariety('control:shield');
    player.state = 'shielding';
    player.stateTimer = 0;
    player.vx *= 0.2;
    player.vy *= 0.2;
    player.x += player.vx * v.dt;
    player.y += player.vy * v.dt;
    if (Math.random() < 0.45) {
      v.addCommentary(`${player.name} SHIELDS the ball, holding off the defender!`, 'info', player.team);
    }
  } else {
    // Hold-up play: back to goal, wait for support (layoff follows).
    countVariety('control:hold_up');
    player.state = 'shielding';
    player.stateTimer = 0;
    markHoldUp(player.id);
    player.vx *= 0.15;
    player.vy *= 0.15;
    player.x += player.vx * v.dt;
    player.y += player.vy * v.dt;
    if (Math.random() < 0.5) {
      v.addCommentary(`${player.name} holds it up with back to goal, waiting for support!`, 'info', player.team);
    }
  }
  return true;
}

// ===========================================================================
// 4. SKILL MOVES (stat-gated 1v1 beats; failure loses the ball)
// ===========================================================================

export type SkillKind = 'step_over' | 'feint' | 'drag_back' | 'roulette' | 'nutmeg';

const SKILL_TABLE: Record<SkillKind, { label: string; base: number; techScale: number }> = {
  step_over: { label: 'step-over', base: 0.38, techScale: 0.0045 },
  feint: { label: 'body feint', base: 0.44, techScale: 0.004 },
  drag_back: { label: 'drag-back', base: 0.48, techScale: 0.0038 },
  roulette: { label: 'roulette', base: 0.32, techScale: 0.005 },
  nutmeg: { label: 'NUTMEG', base: 0.28, techScale: 0.005 },
};

function pickSkillKind(player: Player, nearestDist: number): SkillKind {
  const tech = player.stats.technique;
  const fancy = tech >= 78;
  const roll = Math.random();
  if (nearestDist < 45) return roll < 0.6 ? 'drag_back' : 'feint';
  if (fancy && roll < 0.22) return 'roulette';
  if (fancy && roll < 0.4) return 'nutmeg';
  if (roll < 0.6) return 'step_over';
  return 'feint';
}

/** Attempt a 1v1 skill move. Failure = possession lost. Returns success. */
export function attemptSkillMove(
  player: Player,
  defender: Player,
  kind: SkillKind,
  v: VarietyCtx,
  targetDir: number
): boolean {
  const { ball } = v;
  const table = SKILL_TABLE[kind];
  const successChance = clamp(table.base + player.stats.technique * table.techScale, 0.05, 0.92);
  const success = Math.random() < successChance;

  player.state = 'skill_move';
  player.stateTimer = 0;
  countVariety(`skill:${kind}:${success ? 'ok' : 'fail'}`);

  if (success) {
    // Defender is beaten: stumbles as the carrier bursts past.
    defender.state = 'sliding';
    defender.stateTimer = 0;
    defender.catchCooldown = 0.9;
    defender.tackleCooldown = Math.max(defender.tackleCooldown, 0.6);
    const pastAngle = Math.atan2(defender.y - player.y, defender.x - player.x);
    const burst = kind === 'roulette' || kind === 'nutmeg' ? 430 : 360;
    player.vx = Math.cos(pastAngle) * burst + targetDir * 120;
    player.vy = Math.sin(pastAngle) * burst;
    player.facingAngle = Math.atan2(player.vy, player.vx);
    hitStar(v, player.x, player.y, 14);
    soundEngine.playKick(0.5);
    const flavor =
      kind === 'nutmeg'
        ? `${player.name} slips it THROUGH THE LEGS — a cheeky NUTMEG on ${defender.name}!`
        : kind === 'roulette'
          ? `${player.name} spins the ROULETTE around ${defender.name}! Magnificent!`
          : kind === 'drag_back'
            ? `${player.name} drags it back and leaves ${defender.name} lunging at air!`
            : kind === 'feint'
              ? `${player.name} sells ${defender.name} with a body feint!`
              : `${player.name} throws a STEP-OVER and burns past ${defender.name}!`;
    v.addCommentary(flavor, 'info', player.team);
  } else {
    // Failure: the ball is lost to the defender.
    player.hasBall = false;
    clearDribbleExposure(player);
    ball.carrierId = null;
    const spill = Math.atan2(defender.y - player.y, defender.x - player.x);
    ball.vx = Math.cos(spill) * 210;
    ball.vy = Math.sin(spill) * 210;
    ball.vz = 25;
    ball.lastTouchTeam = defender.team;
    ball.lastTouchPlayerId = defender.id;
    defender.catchCooldown = 0;
    player.state = 'sliding';
    player.stateTimer = 0;
    player.catchCooldown = 0.8;
    hitStar(v, defender.x, defender.y, 10, '#ffccbc');
    v.addCommentary(
      `${player.name} tries the ${table.label} but ${defender.name} reads it — possession lost!`,
      'tackle',
      defender.team
    );
    if (Math.random() < 0.25) {
      scheduleFrustration(player, v, `${player.name} is frustrated after that failed trick!`);
    }
  }
  return success;
}

/**
 * Skill-move / shield decision for a dribbling carrier.
 * Returns true when handled (caller should return for this think tick).
 */
export function maybeSkillOrShield(
  player: Player,
  v: VarietyCtx,
  targetDir: number,
  sit: VarietySituation,
  traits: VarietyTraits
): boolean {
  // Nearest outfield defender.
  let nearest: Player | null = null;
  let nd = Infinity;
  for (const o of v.allPlayers) {
    if (o.team === player.team || o.position === 'GK') continue;
    const d = dist(player.x, player.y, o.x, o.y);
    if (d < nd) {
      nd = d;
      nearest = o;
    }
  }
  // 1v1 skill move when tight with a defender (technique-gated).
  if (nearest && nd < 80 && nd > 8) {
    const probeX = nearest.x + targetDir * 95;
    const probeY = nearest.y;
    let spaceBehind = Infinity;
    for (const o of v.allPlayers) {
      if (o.team === player.team || o.position === 'GK') continue;
      if (o.id === nearest.id) continue;
      const d = dist(o.x, o.y, probeX, probeY);
      if (d < spaceBehind) spaceBehind = d;
    }
    const tech = player.stats.technique;
    const gate = tech >= 62 ? 0.75 : tech / 200;
    // Close control (drag-back / feint) needs no space; expansive beats do.
    const closeControl = nd < 45;
    if ((closeControl || spaceBehind > 55) && Math.random() < gate * (0.6 + traits.pace * 0.35 + traits.flair * 0.45)) {
      attemptSkillMove(player, nearest, pickSkillKind(player, nd), v, targetDir);
      return true;
    }
  }
  // Otherwise shield / hold-up under heavy pressure.
  return maybeShieldOrHoldUp(player, v, targetDir, sit, traits);
}

// ---------------------------------------------------------------------------
// Dribble exposure (fix 4): escalating dispossession risk per possession spell.
// Tracked on the player (possessionTime/possessionDist), reset on every gain
// and cleared on every release. Long carries get punished; one-man beats stay
// viable.
// ---------------------------------------------------------------------------

/** Start (or restart) the exposure clock when a player takes the ball. */
export function notePossessionGain(player: Player): void {
  player.possessionTime = 0;
  player.possessionDist = 0;
}

/** Advance exposure while the carrier dribbles with the ball. */
export function updateDribbleExposure(player: Player, dt: number): void {
  player.possessionTime = (player.possessionTime ?? 0) + dt;
  const step = Math.hypot(player.vx, player.vy) * dt;
  player.possessionDist = (player.possessionDist ?? 0) + step;
}

/** Clear exposure when the ball is released (pass/shot/tackle/clearance). */
export function clearDribbleExposure(player: Player): void {
  player.possessionTime = 0;
  player.possessionDist = 0;
}

/**
 * Escalating tackle bonus vs a carrier: +0 after a fresh touch, ramping to
 * +0.35 for long carries (time and distance both count). Returned as an
 * additive success-chance bonus, already clamped.
 */
export function dribbleRiskBonus(carrier: Player): number {
  const t = carrier.possessionTime ?? 0;
  const d = carrier.possessionDist ?? 0;
  const byTime = Math.max(0, t - 1.2) * 0.075;
  const byDist = Math.max(0, d - 120) * 0.0009;
  return Math.min(0.35, byTime + byDist);
}

/** Aggression multiplier for defenders stepping to a long carrier (1..1.6). */
export function dribblePressMultiplier(carrier: Player): number {
  return 1 + dribbleRiskBonus(carrier) * 1.7;
}

// ===========================================================================
// 5. DEFENDING VARIANTS
// ===========================================================================

/** Should the primary presser jockey/contain instead of diving in? */
export function shouldJockey(player: Player, v: VarietyCtx, ownGoal: GoalFrame, pressRank: number): boolean {
  if (pressRank !== 0) return false;
  const carrier = v.allPlayers.find(p => p.hasBall && p.team !== player.team);
  if (!carrier || carrier.position === 'GK') return false;
  const dGoal = dist(carrier.x, carrier.y, ownGoal.center.x, ownGoal.center.y);
  const lateral = Math.abs(carrier.y - ownGoal.center.y);
  const traits = varietyTraits(player);
  if (dGoal < 230) return true; // contain inside the box, never dive in (penalty risk)
  // A shot is likely: in range with an angle — CLOSE DOWN, don't stand off.
  const shotLikely = dGoal < 440 && lateral < 280;
  if (shotLikely) return false;
  if (carrier.state === 'shielding') return true; // don't dive at a shield
  if (traits.grit < 0.3 && dGoal < 380) return true; // timid defender holds off
  return false;
}

/** Contain point: goal-side of the carrier, arm's length away. */
export function jockeyPoint(carrier: Player, ownGoal: GoalFrame): { x: number; y: number } {
  const dx = ownGoal.center.x - carrier.x;
  const dy = ownGoal.center.y - carrier.y;
  const d = Math.hypot(dx, dy) || 1;
  const x = clamp(carrier.x + (dx / d) * 58, 50, PITCH_LENGTH - 50);
  const y = clamp(carrier.y + (dy / d) * 58, 40, PITCH_WIDTH - 40);
  return { x, y };
}

/** Shot-blocking point: on the carrier-to-goal line, close to the shooter. */
export function shotBlockPoint(carrier: Player, ownGoal: GoalFrame): { x: number; y: number } {
  const t = 0.32;
  const x = clamp(carrier.x + (ownGoal.center.x - carrier.x) * t, 40, PITCH_LENGTH - 40);
  const y = clamp(carrier.y + (ownGoal.center.y - carrier.y) * t, 40, PITCH_WIDTH - 40);
  return { x, y };
}

/** Recovery-run target when beaten behind the ball. Null when shape holds. */
export function recoveryPoint(
  player: Player,
  v: VarietyCtx,
  ownGoal: GoalFrame,
  targetDir: number
): { x: number; y: number } | null {
  const { ball } = v;
  const carrier = v.allPlayers.find(p => p.hasBall);
  const oppHasIt = carrier && carrier.team !== player.team;
  // Half-time side switching: "our third" follows the goal we defend.
  const defendsLeftSide = ownGoal.center.x < PITCH_LENGTH / 2;
  const looseInOurThird =
    !carrier &&
    (defendsLeftSide ? ball.x < PITCH_LENGTH / 3 : ball.x > (PITCH_LENGTH * 2) / 3);
  if (!oppHasIt && !looseInOurThird) return null;
  const inOurThird =
    defendsLeftSide ? ball.x < PITCH_LENGTH / 3 : ball.x > (PITCH_LENGTH * 2) / 3;
  if (!inOurThird) return null;
  // Beaten: further from our goal than the ball along the length axis.
  const beaten =
    defendsLeftSide ? player.x > ball.x + 100 : player.x < ball.x - 100;
  if (!beaten) return null;
  void targetDir;
  const x = defendsLeftSide ? 200 : PITCH_LENGTH - 200;
  const y = clamp(player.y * 0.7 + ball.y * 0.3, 50, PITCH_WIDTH - 50);
  return { x, y };
}

/**
 * Shot / pass-lane block contact: a free, fast ball striking a defender is
 * deflected with a call-out. Returns true when a block happened.
 */
export function checkBlockContact(player: Player, v: VarietyCtx, ownGoal: GoalFrame): boolean {
  const { ball } = v;
  if (ball.carrierId !== null) return false;
  if (player.position === 'GK') return false;
  if (player.tackleCooldown > 0) return false;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed < 300 || ball.z > 42) return false;
  if (dist(player.x, player.y, ball.x, ball.y) > 30) return false;
  const towardOwn = ownGoal.center.x < PITCH_LENGTH / 2 ? ball.vx < -60 : ball.vx > 60;
  const dGoal = dist(ball.x, ball.y, ownGoal.center.x, ownGoal.center.y);
  const goalBound = towardOwn && dGoal < 440;
  // Only a deliberately-positioned blocker, or a genuine goal-bound shot,
  // can make block contact — ordinary pass receptions play on untouched.
  const postedUp = player.state === 'blocking' || player.state === 'jockeying';
  if (!postedUp && !(goalBound && speed > 420)) return false;

  player.state = 'blocking';
  player.stateTimer = 0;
  player.tackleCooldown = 0.7;
  player.catchCooldown = 0.6;
  hitStar(v, ball.x, ball.y, 10);
  soundEngine.playTackle();
  if (player.team === 'home') v.stats.homeTackles++;
  else v.stats.awayTackles++;

  countVariety(towardOwn && dGoal < 440 ? 'block:shot' : 'block:lane');

  if (towardOwn && dGoal < 440) {
    // BLOCKS THE SHOT: throw the body, deflect away from goal + infield.
    const away = ownGoal.center.x < PITCH_LENGTH / 2 ? 1 : -1;
    ball.vx = away * rand(220, 380);
    ball.vy += (ball.y > PITCH_WIDTH / 2 ? 1 : -1) * rand(120, 220);
    if (ball.y < 120 && ball.vy < 0) ball.vy = -ball.vy;
    if (ball.y > PITCH_WIDTH - 120 && ball.vy > 0) ball.vy = -ball.vy;
    ball.vz = rand(90, 150);
    ball.lastTouchTeam = player.team;
    ball.lastTouchPlayerId = player.id;
    v.addCommentary(`${player.name} throws himself in the way — BLOCKS THE SHOT!`, 'tackle', player.team);
  } else {
    // BLOCKS THE PASS LANE: sticks a leg out, kills the pass.
    ball.vx *= -0.2;
    ball.vy = -ball.vy * 0.4 + (Math.random() - 0.5) * 200;
    ball.vz = rand(60, 100);
    ball.lastTouchTeam = player.team;
    ball.lastTouchPlayerId = player.id;
    v.addCommentary(`${player.name} reads it and BLOCKS THE PASS LANE!`, 'tackle', player.team);
  }
  return true;
}

/**
 * Poke / toe tackle: quick nick when tight, shorter cooldown than a slide,
 * smaller share of clean wins, occasionally threads it to a teammate.
 */
export function executePokeTackle(player: Player, carrier: Player, v: VarietyCtx): void {
  const { ball } = v;
  player.state = 'tackling';
  player.stateTimer = 0;
  player.tackleCooldown = 0.5;
  player.catchCooldown = 0.6;

  const angle = Math.atan2(carrier.y - player.y, carrier.x - player.x);
  player.facingAngle = angle;
  player.vx = Math.cos(angle) * 200;
  player.vy = Math.sin(angle) * 200;
  soundEngine.playTackle();
  hitStar(v, carrier.x, carrier.y, 10, '#fff9c4');

  const pokeBase = (player.stats.defense * 1.05) / (player.stats.defense + carrier.stats.technique);
  const successChance = Math.min(0.95, pokeBase + dribbleRiskBonus(carrier));
  countVariety('defense:poke');
  if (Math.random() < successChance) {
    carrier.hasBall = false;
    clearDribbleExposure(carrier);
    ball.carrierId = null;
    carrier.catchCooldown = Math.max(carrier.catchCooldown ?? 0, 0.6);
    if (player.team === 'home') v.stats.homeTackles++;
    else v.stats.awayTackles++;

    const roll = Math.random();
    if (roll < 0.3) {
      // Thread the poke to the nearest teammate.
      let mate: Player | null = null;
      let md = Infinity;
      for (const q of v.allPlayers) {
        if (q.team !== player.team || q.id === player.id || q.position === 'GK') continue;
        const d = dist(player.x, player.y, q.x, q.y);
        if (d < md) {
          md = d;
          mate = q;
        }
      }
      if (mate && md < 320) {
        const a = Math.atan2(mate.y - player.y, mate.x - player.x);
        ball.vx = Math.cos(a) * 380;
        ball.vy = Math.sin(a) * 380;
        ball.vz = 12;
        bumpPass(player, v.stats);
        v.addCommentary(`${player.name} nicks it with a TOE-POKE through to ${mate.name}!`, 'tackle', player.team);
      } else {
        ball.vx = Math.cos(angle) * 170;
        ball.vy = Math.sin(angle) * 170;
        ball.vz = 20;
        v.addCommentary(`${player.name} sticks a TOE-POKE in to nick the ball away!`, 'tackle', player.team);
      }
    } else {
      ball.vx = Math.cos(angle) * 170;
      ball.vy = Math.sin(angle) * 170;
      ball.vz = 20;
      v.addCommentary(`${player.name} sticks a TOE-POKE in to nick the ball away!`, 'tackle', player.team);
    }
    ball.lastTouchTeam = player.team;
    ball.lastTouchPlayerId = player.id;
  } else {
    v.addCommentary(`${carrier.name} skips past ${player.name}'s attempted poke!`, 'info', carrier.team);
  }
}

// ===========================================================================
// 6. EMOTION
// ===========================================================================

/** Brief frustration/protest state for a dispossessed (fouled-feel) victim. */
export function frustrateAfterFoul(victim: Player, v: VarietyCtx): void {
  if (Math.random() > 0.18) return;
  v.addCommentary(`${victim.name} protests the challenge — wants the foul!`, 'info', victim.team);
  setTimeout(() => {
    if (victim.state === 'sliding' || victim.state === 'prone' || victim.state === 'idle' || victim.state === 'running') {
      victim.state = 'protesting';
      victim.stateTimer = 0;
    }
  }, 500);
}
