/**
 * keeperBrain.ts: shot reading, reaction, tracking and positioning for goalkeepers.
 *
 * What was wrong with the old keeper (see updateGoalkeeperAI in ai.ts):
 *  1. ORDER BUG: "gather the loose ball in the box" ran BEFORE shot stopping and
 *     always returned. Any shot inside the box counted as a loose ball, so the
 *     keeper ran at the ball's current position and never reached the save code.
 *  2. OVERWRITTEN MOVEMENT: the "track the shot" move had no return, so the stance
 *     move at the bottom of the function replaced it every frame.
 *  3. BLIND SAVE ROLL: the dive roll ignored where the ball was heading relative to
 *     the keeper, so a shot straight at him failed as often as one in the corner.
 *  4. POSITIONING: the keeper shaded sideways on a fixed line instead of covering
 *     the angle between ball and goal.
 *
 * This module fixes 1, 2 and 4 (ai.ts calls it), and keeperVariety.ts is patched
 * for 3 (save chance now depends on the keeper's gap to the ball's path).
 */

import type { Player } from '../types/soccer';
import type { AIUpdateContext } from './ai';
import {
  dist,
  GOAL_HEIGHT,
  GOAL_WIDTH,
  LEFT_GOAL,
  PENALTY_BOX_LENGTH,
  PITCH_LENGTH,
} from './physics';
import { keeperReflex } from './keeperVariety';

type Goal = typeof LEFT_GOAL;

/**
 * Downward acceleration used to predict ball height at the goal. Set this to your
 * physics gravity. Too high is the safe direction: the keeper treats more
 * lofted balls as saveable instead of letting them go.
 */
export const BALL_GRAVITY = 600;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

// ---------------------------------------------------------------------------
// Per-keeper memory
// ---------------------------------------------------------------------------

interface KeeperState {
  clock: number;
  shotSince: number | null;
}

const states = new Map<string, KeeperState>();

function stateOf(id: string): KeeperState {
  let s = states.get(id);
  if (!s) {
    s = { clock: 0, shotSince: null };
    states.set(id, s);
  }
  return s;
}

/** Call once per frame per keeper. */
export function keeperTick(gk: Player, dt: number): void {
  stateOf(gk.id).clock += dt;
}

/** Call at kick-off / after a goal. */
export function resetKeepers(): void {
  states.clear();
}

// ---------------------------------------------------------------------------
// Reading the shot
// ---------------------------------------------------------------------------

export interface ShotRead {
  incoming: boolean;
  speed: number;
  interceptX: number;
  interceptY: number;
  /** Distance from the keeper to the ball's path right now (horizontal + height). */
  miss: number;
}

const NO_SHOT: ShotRead = { incoming: false, speed: 0, interceptX: 0, interceptY: 0, miss: 999 };

export function readShot(gk: Player, ctx: AIUpdateContext, ownGoal: Goal): ShotRead {
  const { ball } = ctx;
  const left = ownGoal.center.x < PITCH_LENGTH / 2;
  const towardV = left ? -ball.vx : ball.vx;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (ball.carrierId !== null || towardV < 70 || speed < 140) return NO_SHOT;
  // Back-passes and slow rolls from our own side are gathered, not "saved".
  if (ball.lastTouchTeam === gk.team && speed < 330) return NO_SHOT;

  const tGoal = (ownGoal.x - ball.x) / ball.vx;
  if (tGoal <= 0 || tGoal > 4) return NO_SHOT;
  const goalY = ball.y + ball.vy * tGoal;
  if (Math.abs(goalY - ownGoal.center.y) > GOAL_WIDTH / 2 + 14) return NO_SHOT; // wide

  const zGoal = ball.z + ball.vz * tGoal - 0.5 * BALL_GRAVITY * tGoal * tGoal;
  if (zGoal > GOAL_HEIGHT + 18) return NO_SHOT; // over the bar

  // Where the ball crosses the keeper's own depth: that is where he needs to be.
  const tK = (gk.x - ball.x) / ball.vx;
  const tUse = tK > 0 ? tK : tGoal;
  const arriveY = ball.y + ball.vy * tUse;
  const zAt = Math.max(0, ball.z + ball.vz * tUse - 0.5 * BALL_GRAVITY * tUse * tUse);

  // Distance from the keeper to the ball's line of travel.
  const dx = ball.vx / speed;
  const dy = ball.vy / speed;
  const vx = gk.x - ball.x;
  const vy = gk.y - ball.y;
  const along = vx * dx + vy * dy;
  const horizontal = along < 0 ? Math.hypot(vx, vy) : Math.abs(vx * dy - vy * dx);
  const vertical = Math.max(0, Math.abs(zAt - 16) - 24);

  return {
    incoming: true,
    speed,
    interceptX: gk.x,
    interceptY: clamp(arriveY, ownGoal.yMin + 6, ownGoal.yMax - 6),
    miss: Math.hypot(horizontal, vertical),
  };
}

// ---------------------------------------------------------------------------
// Responding to the shot: wait (reaction time) -> slide to the line -> save
// ---------------------------------------------------------------------------

export type KeeperShotPlan =
  | { kind: 'none'; incoming: boolean }
  | { kind: 'move'; incoming: true; x: number; y: number; speed: number }
  | { kind: 'save'; incoming: true; gap: number };

export function planShotResponse(gk: Player, ctx: AIUpdateContext, ownGoal: Goal): KeeperShotPlan {
  const st = stateOf(gk.id);
  const shot = readShot(gk, ctx, ownGoal);
  if (!shot.incoming) {
    st.shotSince = null;
    return { kind: 'none', incoming: false };
  }
  if (st.shotSince === null) st.shotSince = st.clock;

  const reflex = keeperReflex(gk);
  const react = 0.07 + (1 - reflex) * 0.13; // sharper keepers read the shot sooner
  const elapsed = st.clock - st.shotSince;
  const lateness = Math.max(0, react - elapsed);

  const d = dist(gk.x, gk.y, ctx.ball.x, ctx.ball.y);
  const contactR = 60 + 34 * reflex;
  const ready = (gk.catchCooldown ?? 0) <= 0;
  if (ready && d < contactR && shot.miss < 100) {
    // Point-blank shots beat the reaction time: lateness widens the gap.
    return { kind: 'save', incoming: true, gap: shot.miss + lateness * 150 };
  }
  if (elapsed >= react) {
    return {
      kind: 'move',
      incoming: true,
      x: shot.interceptX,
      y: shot.interceptY,
      speed: gk.stats.speed * (1.5 + 0.45 * reflex),
    };
  }
  return { kind: 'none', incoming: true };
}

// ---------------------------------------------------------------------------
// Positioning: stand on the line between ball and goal centre, step out as the
// shooter closes (narrowing the angle).
// ---------------------------------------------------------------------------

export interface KeeperPosition {
  x: number;
  y: number;
  speedScale: number;
}

export function keeperPosition(gk: Player, ctx: AIUpdateContext, ownGoal: Goal): KeeperPosition {
  const { ball } = ctx;
  const left = ownGoal.center.x < PITCH_LENGTH / 2;
  const sgn = left ? 1 : -1;
  const carrier = ctx.allPlayers.find(p => p.hasBall && p.team !== gk.team && !p.sentOff) ?? null;
  const refX = carrier ? carrier.x : ball.x + ball.vx * 0.3;
  const refY = carrier ? carrier.y : ball.y + ball.vy * 0.3;

  let ux = refX - ownGoal.center.x;
  let uy = refY - ownGoal.center.y;
  const D = Math.hypot(ux, uy) || 1;
  ux /= D;
  uy /= D;
  // Never walk sideways along the goal line: keep a forward component.
  if (ux * sgn < 0.3) {
    ux = 0.3 * sgn;
    uy = Math.sign(uy || 1) * Math.sqrt(1 - 0.09);
  }

  const threat = carrier ? clamp01(1 - D / 520) : clamp01(1 - D / 700) * 0.6;
  const depth = 34 + threat * 70;
  let x = ownGoal.center.x + ux * depth;
  let y = ownGoal.center.y + uy * depth;
  y = clamp(y, ownGoal.center.y - (GOAL_WIDTH / 2 + 18), ownGoal.center.y + (GOAL_WIDTH / 2 + 18));
  x = left
    ? clamp(x, 20, PENALTY_BOX_LENGTH - 30)
    : clamp(x, PITCH_LENGTH - PENALTY_BOX_LENGTH + 30, PITCH_LENGTH - 20);
  return { x, y, speedScale: threat > 0.3 ? 1.3 : 1.1 };
}
