/**
 * Kick Power Math — every pass/shot derives velocity from the distance it
 * needs to cover plus the player's stats, instead of a single hard-coded
 * number. The physics uses per-frame friction:
 *
 *   ground:  v *= 0.988^(60 dt)  ->  lambda_ground = -60*ln(0.988) ~ 0.724 /s
 *   air:     v *= 0.996^(60 dt)  ->  lambda_air    = -60*ln(0.996) ~ 0.240 /s
 *
 * Continuous approximation: v(t) = v0 * exp(-lambda t); distance to rest is
 * v0 / lambda. So a pass that must reach distance D needs v0 ~ D * lambda,
 * scaled up by an overshoot margin so it arrives with pace.
 */

import type { Player } from '../types/soccer';

const GRAVITY = 720;
const GROUND_LAMBDA = -60 * Math.log(0.988); // ~0.724
const AIR_LAMBDA = -60 * Math.log(0.996); // ~0.240

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Ground passes
// ---------------------------------------------------------------------------

export type PassShape =
  | 'short' | 'driven' | 'lofted' | 'long' | 'through' | 'cross' | 'back';

/**
 * Ground / low pass speed. `shape` picks the multiplier; `technique`
 * sharpens delivery (less under/over hit); `kick` adds raw power.
 */
export function groundPassSpeed(
  distance: number, player: Player, shape: PassShape = 'short'
): number {
  const shapeMul =
    shape === 'short'   ? 1.00 :
    shape === 'driven'  ? 1.55 :
    shape === 'through' ? 0.95 :
    shape === 'cross'   ? 1.10 :
    shape === 'back'    ? 0.85 :
    shape === 'long'    ? 1.45 :
    1.00;
  const tech = 0.9 + (player.stats.technique - 50) * 0.004; // ~0.9..1.1
  const kick = 0.9 + (player.stats.kick - 50) * 0.003;      // ~0.9..1.05
  const base = distance * GROUND_LAMBDA * 1.15 * shapeMul;
  return clamp(base * tech * kick, 200, 760);
}

// ---------------------------------------------------------------------------
// Lofted kicks (lofted passes, crosses, long balls, lobbed through)
// ---------------------------------------------------------------------------

export interface KickVec { vx: number; vy: number; vz: number; }

/**
 * Lofted kick toward a point. `apexClearance` is extra vz so the arc
 * clears defenders in the lane (40 = normal pass, 80 = high cross/lob).
 */
export function loftedKick(
  dx: number, dy: number, distance: number,
  player: Player, apexClearance = 40
): KickVec {
  const horiz = clamp(distance * AIR_LAMBDA * 1.05, 220, 660);
  const flight = clamp(distance / 480, 0.55, 1.15);
  const vz = (GRAVITY * flight) / 2 + apexClearance;
  const invD = 1 / Math.max(1, Math.hypot(dx, dy));
  const tech = 1 + (player.stats.technique - 70) * 0.0025;
  return {
    vx: dx * invD * horiz * tech,
    vy: dy * invD * horiz * tech,
    vz,
  };
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export type ShotShape =
  | 'power' | 'placed' | 'finesse' | 'chip' | 'volley' | 'tap';

/**
 * Shot speed. `shape` sets the variant so a finesse is measurably slower
 * than a power shot from the same distance. Longer-range shots get a
 * slightly larger kick to arrive with pace; shorter shots stay tame.
 */
export function shotSpeed(
  distance: number, player: Player, shape: ShotShape = 'power'
): number {
  const variant =
    shape === 'power'    ? 1.15 :
    shape === 'placed'   ? 0.95 :
    shape === 'finesse'  ? 0.88 :
    shape === 'chip'     ? 0.72 :
    shape === 'volley'   ? 1.05 :
    shape === 'tap'      ? 0.65 :
    1.00;
  const distFactor = 1 + Math.max(0, distance - 150) * 0.0012;
  const kick = 0.82 + (player.stats.kick - 50) * 0.006; // ~0.82..1.12
  const base = 440 * distFactor * variant * kick;
  return clamp(base, 340, 680);
}
