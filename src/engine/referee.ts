/**
 * Referee — the visible on-pitch official for mini-soccer.
 *
 * Follows play at a distance (never interferes), detects reckless tackles
 * (from behind, at high speed, or repeated fouling), plays advantage when
 * the fouled team keeps a promising attack, and issues yellows / second
 * yellows / straight reds (last-man denial). Teams down a man drop deeper.
 *
 * This module holds no physics or rendering of its own: it exposes pure
 * helpers plus a small pending-foul queue that the match engine drains.
 *
 * Mini-soccer rules: no offside, no VAR — none of that is implemented here.
 */

import { Ball, Player, TeamSide } from '../types/soccer';
import { dist, PITCH_LENGTH, PITCH_WIDTH } from './physics';
import { attackDirFor, defendsLeft } from './sides';
import type { HalfLike } from './sides';
import { countVariety } from './actionVariety';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ===========================================================================
// 1. REFEREE ENTITY
// ===========================================================================

export interface RefereeState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facingAngle: number;
}

export function createReferee(): RefereeState {
  return {
    x: PITCH_LENGTH / 2,
    y: PITCH_WIDTH / 2 + 120,
    vx: 0,
    vy: 0,
    facingAngle: 0,
  };
}

/**
 * Trail the play at a distance: hold ~130 units off the ball on the
 * touchline side, drifting with it. Velocity-steered (never snaps), and
 * always keeps clear of the ball's lane so it never interferes.
 */
export function updateRefereePosition(ref: RefereeState, ball: Ball, dt: number): void {
  const holdX = clamp(ball.x - 60, 80, PITCH_LENGTH - 80);
  const side = ball.y < PITCH_WIDTH / 2 ? 1 : -1;
  const holdY = clamp(ball.y + side * 130, 60, PITCH_WIDTH - 60);
  const dx = holdX - ref.x;
  const dy = holdY - ref.y;
  const d = Math.hypot(dx, dy);
  if (d > 4) {
    const arrival = Math.min(1, d / 60);
    const desiredVx = (dx / d) * 200 * arrival;
    const desiredVy = (dy / d) * 200 * arrival;
    const blend = Math.min(1, 4.5 * dt);
    ref.vx += (desiredVx - ref.vx) * blend;
    ref.vy += (desiredVy - ref.vy) * blend;
  } else {
    ref.vx *= Math.pow(0.1, dt);
    ref.vy *= Math.pow(0.1, dt);
  }
  ref.x += ref.vx * dt;
  ref.y += ref.vy * dt;
  ref.x = clamp(ref.x, 40, PITCH_LENGTH - 40);
  ref.y = clamp(ref.y, 30, PITCH_WIDTH - 30);
  if (Math.hypot(ref.vx, ref.vy) > 8) {
    ref.facingAngle = Math.atan2(ref.vy, ref.vx);
  } else {
    ref.facingAngle = Math.atan2(ball.y - ref.y, ball.x - ref.x);
  }
}

// ===========================================================================
// 2. FOUL ASSESSMENT
// ===========================================================================

export type CardKind = 'yellow' | 'second_yellow' | 'red';

export interface TackleMeta {
  fromBehind: boolean;
  highSpeed: boolean;
  tackleKind: 'slide' | 'poke';
}

export interface FoulAssessment {
  decision: 'play_on' | 'advantage' | 'foul';
  card: CardKind | null;
  reason: string;
  lastMan: boolean;
  inBox: boolean;
}

/** Pending stoppage the engine must whistle for (free kick or penalty). */
export interface FoulEvent {
  foulerId: string;
  foulerName: string;
  foulerTeam: TeamSide;
  victimId: string;
  victimName: string;
  fouledTeam: TeamSide;
  spot: { x: number; y: number };
  card: CardKind | null;
  reason: string;
  lastMan: boolean;
  inBox: boolean;
}

const pendingFouls: FoulEvent[] = [];

export function drainFoulEvents(): FoulEvent[] {
  if (pendingFouls.length === 0) return [];
  return pendingFouls.splice(0, pendingFouls.length);
}

/** Was the tackle launched from behind the victim's facing direction? */
export function tackleFromBehind(tackler: Player, victim: Player): boolean {
  // Approach vector vs victim's facing: tackler behind = approach aligned
  // with the victim's motion (dot of approach dir with victim facing > 0.35).
  const ax = tackler.x - victim.x;
  const ay = tackler.y - victim.y;
  const d = Math.hypot(ax, ay) || 1;
  const dot = (ax / d) * Math.cos(victim.facingAngle) + (ay / d) * Math.sin(victim.facingAngle);
  return dot < -0.35;
}

/** Was the victim the last obstacle (through on goal, only keeper beyond)? */
export function isLastManDenial(
  victim: Player,
  allPlayers: Player[],
  targetGoal: { x: number; center: { x: number; y: number } }
): boolean {
  const dGoal = dist(victim.x, victim.y, targetGoal.x, targetGoal.center.y);
  if (dGoal > 330) return false;
  // Count outfield defenders (of the fouling team) goal-side of the victim.
  let goalSide = 0;
  for (const p of allPlayers) {
    if (p.team === victim.team || p.position === 'GK' || p.sentOff) continue;
    const pGoal = dist(p.x, p.y, targetGoal.x, targetGoal.center.y);
    if (pGoal < dGoal - 30) goalSide++;
  }
  return goalSide === 0;
}

/** Is the spot inside the fouling team's penalty box (penalty, not free kick)? */
export function isInPenaltyBox(
  spot: { x: number; y: number },
  foulerTeam: TeamSide,
  half?: HalfLike
): boolean {
  const inY = spot.y >= 160 && spot.y <= PITCH_WIDTH - 160;
  if (!inY) return false;
  // Half-time side switching: each team's box follows the goal they defend.
  if (defendsLeft(foulerTeam, half)) return spot.x >= 0 && spot.x <= 190;
  return spot.x >= PITCH_LENGTH - 190 && spot.x <= PITCH_LENGTH;
}

/**
 * Does the fouled team keep a promising attack? Ball retained (or loose to
 * them) in the attacking third with support = play the advantage.
 */
export function isPromisingAttack(
  fouledTeam: TeamSide,
  ball: Ball,
  allPlayers: Player[],
  half?: HalfLike
): boolean {
  // Half-time side switching: "attacking" follows the half-aware direction.
  const dir = attackDirFor(fouledTeam, half);
  const attackingHalf =
    dir === 1 ? ball.x > PITCH_LENGTH * 0.5 : ball.x < PITCH_LENGTH * 0.5;
  const attackingThird =
    dir === 1 ? ball.x > (PITCH_LENGTH * 2) / 3 : ball.x < PITCH_LENGTH / 3;
  const keeper = ball.carrierId !== null;
  const carrier = allPlayers.find(p => p.id === ball.carrierId);
  if (keeper && carrier) {
    if (carrier.team !== fouledTeam) return false;
    if (!attackingHalf) return false;
    // Fouled side kept it past halfway: numbers up in support?
    let support = 0;
    for (const p of allPlayers) {
      if (p.team !== fouledTeam || p.id === carrier.id || p.sentOff) continue;
      if (dist(p.x, p.y, ball.x, ball.y) < 260) support++;
    }
    return support >= 1;
  }
  if (!attackingThird) return false;
  // Loose ball falling to the fouled team with space.
  let friends = 0;
  let foes = 0;
  for (const p of allPlayers) {
    if (p.sentOff) continue;
    if (dist(p.x, p.y, ball.x, ball.y) > 200) continue;
    if (p.team === fouledTeam) friends++;
    else foes++;
  }
  return friends > foes;
}

/**
 * Assess a completed tackle for a foul. Clean, front-on, low-speed pokes
 * usually play on; reckless tackles (behind / high speed / repeat offender)
 * are whistled, and last-man denial sees red.
 */
export function assessTackle(
  tackler: Player,
  victim: Player,
  ball: Ball,
  allPlayers: Player[],
  meta: TackleMeta,
  targetGoal: { x: number; center: { x: number; y: number } },
  half?: HalfLike
): FoulAssessment {
  const lastMan = isLastManDenial(victim, allPlayers, targetGoal);
  const inBox = isInPenaltyBox({ x: victim.x, y: victim.y }, tackler.team, half);
  const repeat = (tackler.foulCount ?? 0) >= 3;

  // Base foul heat: reckless markers stack up fast.
  // Tuned down: most tackles should be clean, only truly reckless ones whistled.
  let heat = 0.02;
  if (meta.fromBehind) heat += 0.35;
  if (meta.highSpeed) heat += 0.15;
  if (meta.tackleKind === 'slide') heat += 0.04;
  if (repeat) heat += 0.2;
  if (lastMan) heat += 0.4;

  const isFoul = Math.random() < heat;
  if (!isFoul) {
    return { decision: 'play_on', card: null, reason: '', lastMan, inBox };
  }

  // Card: red for RECKLESS last-man denial (fair ones see yellow), second
  // yellow = red, yellows for reckless or cynical repeat fouling.
  // CARDS DISABLED (user request 2026-10-13): fouls only, no cards for now.
  const reckless = meta.fromBehind || meta.highSpeed;
  let card: CardKind | null = null;
  let reason = 'a mistimed challenge';
  const CARDS_ENABLED = false;
  if (CARDS_ENABLED && lastMan && reckless) {
    card = 'red';
    reason = 'denying a clear goalscoring chance as the last man';
  } else if (CARDS_ENABLED && lastMan) {
    card = 'yellow';
    reason = 'denying a promising break as the last man';
  } else if (CARDS_ENABLED && (tackler.yellowCards ?? 0) >= 1 && reckless) {
    card = 'second_yellow';
    reason = 'another reckless lunge — a second yellow';
  } else if (CARDS_ENABLED && meta.fromBehind && (meta.highSpeed || repeat)) {
    card = 'yellow';
    reason = 'a reckless tackle from behind';
  } else if (CARDS_ENABLED && repeat) {
    card = 'yellow';
    reason = 'persistent fouling after repeated warnings';
  } else if (CARDS_ENABLED && reckless) {
    card = Math.random() < 0.3 ? 'yellow' : null;
    reason = meta.fromBehind ? 'a lunge from behind' : 'a high-speed collision';
  }

  // Advantage: promising attack kept = play on with a note, no stoppage.
  if (isPromisingAttack(victim.team, ball, allPlayers, half)) {
    countVariety('ref:advantage');
    return { decision: 'advantage', card, reason, lastMan, inBox };
  }
  countVariety(card ? `ref:card_${card}` : 'ref:foul');
  return { decision: 'foul', card, reason, lastMan, inBox };
}

/** Queue the stoppage for the engine to whistle (free kick or penalty). */
export function raiseFoulEvent(
  tackler: Player,
  victim: Player,
  assessment: FoulAssessment
): void {
  pendingFouls.push({
    foulerId: tackler.id,
    foulerName: tackler.name,
    foulerTeam: tackler.team,
    victimId: victim.id,
    victimName: victim.name,
    fouledTeam: victim.team,
    spot: { x: victim.x, y: victim.y },
    card: assessment.card,
    reason: assessment.reason,
    lastMan: assessment.lastMan,
    inBox: assessment.inBox,
  });
}

// ===========================================================================
// 3. SHORT-HANDED SHAPE
// ===========================================================================

/** Active (non-sent-off) outfield count for a team. */
export function activeOutfieldCount(team: TeamSide, allPlayers: Player[]): number {
  let n = 0;
  for (const p of allPlayers) {
    if (p.team === team && !p.sentOff && p.position !== 'GK') n++;
  }
  return n;
}

/**
 * Dismiss a player: straight red or second yellow. They walk off toward the
 * nearest sideline/tunnel (velocity-steered, head-down) via the AI walk-off
 * branch, then are removed to the tunnel once clear of the pitch. Play
 * continues around them; distance-gated finders and press ranks skip them
 * from the moment of dismissal.
 */
export function dismissPlayer(dismissed: Player): void {
  dismissed.sentOff = true;
  dismissed.hasBall = false;
  // Head-down send-off: walk to the nearest sideline, then to the tunnel.
  dismissed.state = 'disappointed';
  dismissed.stateTimer = 0;
  dismissed.vx = 0;
  dismissed.vy = 0;
  dismissed.vz = 0;
  dismissed.z = 0;
  const exitY = dismissed.y < PITCH_WIDTH / 2 ? -45 : PITCH_WIDTH + 45;
  dismissed.walkingOff = true;
  dismissed.walkOffTx = Math.max(60, Math.min(PITCH_LENGTH - 60, dismissed.x));
  dismissed.walkOffTy = exitY;
  dismissed.facingAngle = exitY < 0 ? -Math.PI / 2 : Math.PI / 2;
}

/**
 * Final removal once the dismissed player has walked clear of the pitch.
 * Keeps them far off-pitch so finders, press ranks and outlets never
 * select them again.
 */
export function removeWalkedOff(dismissed: Player): void {
  dismissed.walkingOff = false;
  dismissed.walkOffTx = undefined;
  dismissed.walkOffTy = undefined;
  dismissed.vx = 0;
  dismissed.vy = 0;
  dismissed.vz = 0;
  dismissed.z = 0;
  dismissed.x = dismissed.team === 'home' ? -500 : PITCH_LENGTH + 500;
  dismissed.y = -500;
  dismissed.facingAngle = dismissed.team === 'home' ? 0 : Math.PI;
}

/**
 * How many men down a team is vs a full 6-outfield mini-soccer side.
 * (7-a-side: 1 GK + 6 outfield.)
 */
export function shortfall(team: TeamSide, allPlayers: Player[]): number {
  return Math.max(0, 6 - activeOutfieldCount(team, allPlayers));
}

/**
 * Extra goal-side shift (in world units) for a team down a man: the shape
 * drops deeper and stays compact to protect the box.
 */
export function dropDeepShift(team: TeamSide, allPlayers: Player[]): number {
  return shortfall(team, allPlayers) * 70;
}
