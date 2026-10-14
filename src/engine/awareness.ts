/**
 * Awareness — the spatial "where is everyone going" layer.
 *
 * Fixes the through-ball-to-empty-space bug by SOLVING for the meeting
 * point of a pass instead of hoping a mate will be there. Every pass in
 * aiBrain.ts is gated on:
 *   - reach: can the receiver physically get to the arrival point?
 *   - lane:  can an opponent step into the corridor before the ball?
 *   - space: how crowded is the destination?
 *
 * Pure math. No physics, no renderer, no side effects.
 */

import type { Player, TeamSide } from '../types/soccer';
import { dist, PITCH_LENGTH, PITCH_WIDTH } from './physics';

export interface Vec2 { x: number; y: number; }

// ---------------------------------------------------------------------------
// Motion prediction
// ---------------------------------------------------------------------------

/** Where will `p` be in `seconds` at current velocity? Capped to 0.9s. */
export function predictPosition(p: Player, seconds: number): Vec2 {
  const t = Math.min(seconds, 0.9);
  return { x: p.x + p.vx * t, y: p.y + p.vy * t };
}

export function speedOf(p: Player): number {
  return Math.hypot(p.vx, p.vy);
}

// ---------------------------------------------------------------------------
// Meeting-point solve — the through-ball fix
// ---------------------------------------------------------------------------

/**
 * Iterate to find where passer->receiver meet: ball flight time converges
 * with receiver forward motion. Three iterations gives sub-unit residual.
 */
export function solveMeetingPoint(
  passer: Player, receiver: Player, ballSpeed: number
): { point: Vec2; flightTime: number } {
  let px = receiver.x;
  let py = receiver.y;
  let t = dist(passer.x, passer.y, px, py) / Math.max(1, ballSpeed);
  for (let i = 0; i < 3; i++) {
    const lead = Math.min(t, 0.9);
    px = receiver.x + receiver.vx * lead;
    py = receiver.y + receiver.vy * lead;
    t = dist(passer.x, passer.y, px, py) / Math.max(1, ballSpeed);
  }
  return { point: { x: px, y: py }, flightTime: t };
}

/**
 * Burst + sustain reach model — a receiver can cover a bit more than
 * speed*time in the first moment because they accelerate into the run.
 */
export function receiverCanReach(
  receiver: Player, target: Vec2, flightTime: number
): boolean {
  const d = dist(receiver.x, receiver.y, target.x, target.y);
  const reach = 24 + receiver.stats.speed * 2.2 * flightTime;
  return d <= reach;
}

// ---------------------------------------------------------------------------
// Lane scanning — will an opponent step into the pass?
// ---------------------------------------------------------------------------

/**
 * 1.0 = corridor passer -> target is wide open. Uses a per-opponent lunge
 * reach that grows with ball flight time, so a fast defender can nick a
 * slow pass but not a rocket. `airborne` dampens their influence.
 */
export function scanLane(
  passer: Player, target: Vec2, allPlayers: Player[],
  ballSpeed: number, airborne: boolean
): number {
  const ax = passer.x, ay = passer.y;
  const bx = target.x, by = target.y;
  const segLen = Math.hypot(bx - ax, by - ay);
  if (segLen < 1) return 1;
  const dx = (bx - ax) / segLen, dy = (by - ay) / segLen;

  let clarity = 1;
  for (const opp of allPlayers) {
    if (opp.team === passer.team || opp.sentOff) continue;
    const proj = (opp.x - ax) * dx + (opp.y - ay) * dy;
    if (proj <= 0 || proj >= segLen) continue;
    const cx = ax + dx * proj, cy = ay + dy * proj;
    const perp = Math.hypot(opp.x - cx, opp.y - cy);
    const tBall = proj / Math.max(1, ballSpeed);
    const lunge = 22 + opp.stats.speed * 2.4 * tBall;
    if (perp < lunge) {
      const threat = 1 - perp / lunge;
      let weight = 0.55 * threat;
      if (airborne) weight *= 0.4;
      clarity *= 1 - weight;
    }
  }
  return Math.max(0, clarity);
}

/** 0..1 openness at (x,y) for `forTeam` — 1 = 130+ units of free space. */
export function spaceAt(
  x: number, y: number, allPlayers: Player[], forTeam: TeamSide, horizon = 0.3
): number {
  let nearest = 999;
  for (const p of allPlayers) {
    if (p.team === forTeam || p.sentOff) continue;
    const fx = p.x + p.vx * horizon;
    const fy = p.y + p.vy * horizon;
    const d = dist(x, y, fx, fy);
    if (d < nearest) nearest = d;
  }
  return Math.max(0, Math.min(1, (nearest - 12) / 130));
}

// ---------------------------------------------------------------------------
// Full pass read — one call, three answers
// ---------------------------------------------------------------------------

export interface PassRead {
  score: number;              // 0..1 composite
  arrival: Vec2;              // where the receiver should meet the ball
  flightTime: number;
  laneClear: number;          // 0..1
  receiverCanReach: boolean;  // hard gate — the through-ball bug lives here
  space: number;              // 0..1 openness at arrival
  forwardProgress: number;    // -1..1 along attack direction
}

export function readPass(
  passer: Player,
  mate: Player,
  allPlayers: Player[],
  targetDir: number,
  opts: { airborne?: boolean; ballSpeedHint?: number } = {}
): PassRead {
  const d0 = dist(passer.x, passer.y, mate.x, mate.y);
  const ballSpeed = opts.ballSpeedHint ?? Math.max(320, Math.min(640, d0 * 2.6));

  const meeting = solveMeetingPoint(passer, mate, ballSpeed);
  meeting.point.x = Math.max(30, Math.min(PITCH_LENGTH - 30, meeting.point.x));
  meeting.point.y = Math.max(30, Math.min(PITCH_WIDTH - 30, meeting.point.y));

  const reachable = receiverCanReach(mate, meeting.point, meeting.flightTime);
  const lane = scanLane(passer, meeting.point, allPlayers, ballSpeed, !!opts.airborne);
  const space = spaceAt(meeting.point.x, meeting.point.y, allPlayers, passer.team, 0.4);
  const ahead = (meeting.point.x - passer.x) * targetDir;
  const forwardProgress = Math.max(-1, Math.min(1, ahead / 400));

  // Composite score. Reachability is a HARD gate — this is the bug fix.
  let score =
    lane * 0.45 +
    space * 0.25 +
    (forwardProgress + 1) * 0.10 +
    (reachable ? 0.10 : 0);
  if (!reachable) score *= 0.25;
  score = Math.max(0, Math.min(1, score));

  return {
    score,
    arrival: meeting.point,
    flightTime: meeting.flightTime,
    laneClear: lane,
    receiverCanReach: reachable,
    space,
    forwardProgress,
  };
}

// ---------------------------------------------------------------------------
// Receiver readiness — does the intended target actually want the ball?
// ---------------------------------------------------------------------------

/**
 * 0..1 how ready this player is to receive right now. Discourages passes to
 * a static, backward-facing player even if the lane is technically open.
 */
export function receiverReadiness(mate: Player, targetDir: number): number {
  const speed = speedOf(mate);
  const movingForward = mate.vx * targetDir > 0;
  const facingUpfield = Math.cos(mate.facingAngle) * targetDir > -0.2;
  let r = 0.4;
  r += Math.min(0.3, speed / 400);
  if (movingForward) r += 0.15;
  if (facingUpfield) r += 0.1;
  return Math.max(0, Math.min(1, r));
}

// ---------------------------------------------------------------------------
// Best through-ball candidate — the entry point aiBrain.ts calls
// ---------------------------------------------------------------------------

/**
 * A runner in space with a REACHABLE meeting point and a clear lane.
 * Returns null when nobody qualifies — the AI simply does not play the
 * impossible pass instead of hoofing it into touch.
 */
export function findReadyThroughRunner(
  passer: Player, allPlayers: Player[], targetDir: number, ballSpeed = 520
): { mate: Player; read: PassRead } | null {
  let best: { mate: Player; read: PassRead; score: number } | null = null;
  for (const mate of allPlayers) {
    if (mate.team !== passer.team || mate.id === passer.id) continue;
    if (mate.position === 'GK' || mate.sentOff) continue;
    const ahead = (mate.x - passer.x) * targetDir;
    if (ahead < 80) continue;
    const d = dist(passer.x, passer.y, mate.x, mate.y);
    if (d < 120 || d > 480) continue;

    const read = readPass(passer, mate, allPlayers, targetDir, {
      airborne: false,
      ballSpeedHint: ballSpeed,
    });
    const readiness = receiverReadiness(mate, targetDir);
    const score = read.score * 0.6 + readiness * 0.4;
    // Strict gates: only truly viable through balls are returned.
    if (read.score > 0.55 && read.receiverCanReach && read.laneClear > 0.5) {
      if (!best || score > best.score) best = { mate, read, score };
    }
  }
  return best ? { mate: best.mate, read: best.read } : null;
}
