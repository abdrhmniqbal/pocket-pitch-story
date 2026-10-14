/**
 * Set-Piece Variety — parameterized dead-ball variants built on the same
 * pattern as the outfield action variety (pick contextually, execute with
 * real mechanical differences).
 *
 * Throw-ins (short safe vs long down the line), corners (inswinger /
 * outswinger / short, technique-gated), free kicks (direct shot vs delivery,
 * with wall formation + wall jump), and penalties (placement vs power with
 * a keeper read). This module only sets ball velocities — it never touches
 * the physics core, renderer, HUD, match flow, or team data.
 *
 * Mini-soccer rules: no offside, no VAR — none of that is implemented here.
 */

import { Ball, MatchHalf, MatchStats, Player, TeamSide, VisualEffect } from '../types/soccer';
import { dist, GOAL_HEIGHT, GOAL_WIDTH, PITCH_LENGTH, PITCH_WIDTH } from './physics';
import { countVariety } from './actionVariety';
import { soundEngine } from '../audio/soundEngine';

/** Minimal context shared with the engine layer. */
export interface SetPieceCtx {
  half?: MatchHalf;
  dt: number;
  ball: Ball;
  allPlayers: Player[];
  stats: MatchStats;
  addEffect: (effect: VisualEffect) => void;
  addCommentary: (
    text: string,
    type: 'goal' | 'save' | 'shot' | 'tackle' | 'pass' | 'whistle' | 'info' | 'corner' | 'out' | 'kickoff',
    team?: TeamSide
  ) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function opponentsNear(allPlayers: Player[], x: number, y: number, radius: number, team: TeamSide): number {
  let n = 0;
  for (const p of allPlayers) {
    if (p.team !== team && !p.sentOff && dist(p.x, p.y, x, y) < radius) n++;
  }
  return n;
}

function dust(ctx: SetPieceCtx, x: number, y: number, id: string): void {
  ctx.addEffect({ id: `${id}-${Date.now()}-${Math.random()}`, type: 'dust', x, y, z: 0, life: 0, maxLife: 0.3 });
}

// ===========================================================================
// 1. THROW-INS — short (safe, to feet) vs long (down the line)
// ===========================================================================

export type ThrowVariant = 'short' | 'long';

/**
 * Pick the throw: short and safe to feet when pressed or when a nearby
 * outlet is open; long down the line when the short lane is crowded and a
 * runner is breaking into space.
 */
export function pickThrowVariant(
  taker: Player,
  mates: Player[],
  ctx: SetPieceCtx,
  targetDir: number
): { variant: ThrowVariant; target: Player | null } {
  // Only genuine infield outlets count — outfield mates standing on the pitch.
  // ROUND 3 FIX: the taker is NEVER an outlet — a throw to self is illegal
  // under the second-touch rule under any circumstance.
  const eligible = mates.filter(
    m => m.id !== taker.id && !m.sentOff && m.position !== 'GK' && m.x > 20 && m.x < PITCH_LENGTH - 20 && m.y > 20 && m.y < PITCH_WIDTH - 20
  );
  const pool = eligible.length > 0 ? eligible : mates.filter(m => m.id !== taker.id && !m.sentOff && m.position !== 'GK');
  let shortBest: Player | null = null;
  let shortScore = -Infinity;
  let longBest: Player | null = null;
  let longScore = -Infinity;
  let longCrowd = 99;
  for (const mate of pool) {
    const d = dist(taker.x, taker.y, mate.x, mate.y);
    const crowd = opponentsNear(ctx.allPlayers, mate.x, mate.y, 70, taker.team);
    const ahead = (mate.x - taker.x) * targetDir;
    if (d >= 40 && d <= 260) {
      const score = 90 - crowd * 50 - d * 0.1 + Math.random() * 12;
      if (score > shortScore) {
        shortScore = score;
        shortBest = mate;
      }
    }
    if (ahead > 100 && d >= 150 && d <= 380) {
      const score = ahead * 0.3 - crowd * 40 + Math.random() * 12;
      if (score > longScore) {
        longScore = score;
        longBest = mate;
        longCrowd = crowd;
      }
    }
  }
  // Long down the line only when a runner breaks into genuine space and the
  // short lane is crowded — never into pressure.
  if (longBest && longCrowd === 0 && longScore > 40 && (!shortBest || shortScore < 45 || longScore > shortScore + 35)) {
    return { variant: 'long', target: longBest };
  }
  // Pressed taker with a safe short outlet keeps it simple.
  if (shortBest && shortScore > 25) return { variant: 'short', target: shortBest };
  if (longBest && longCrowd === 0 && longScore > 35) return { variant: 'long', target: longBest };
  // Regression guard: NEVER throw to empty grass when a teammate exists —
  // fall back to the nearest outlet with a safe short throw to feet.
  if (pool.length > 0) {
    let nearest = pool[0];
    let nd = dist(taker.x, taker.y, nearest.x, nearest.y);
    for (const mate of pool) {
      const d = dist(taker.x, taker.y, mate.x, mate.y);
      if (d < nd) {
        nd = d;
        nearest = mate;
      }
    }
    return { variant: 'short', target: nearest };
  }
  return { variant: 'short', target: shortBest };
}

/** Execute the throw: flat and safe to feet, or lofted down the line. */
export function executeThrowVariant(
  taker: Player,
  target: Player | null,
  variant: ThrowVariant,
  ctx: SetPieceCtx,
  spot: { x: number; y: number },
  targetDir: number
): void {
  const { ball } = ctx;
  countVariety(`setpiece:throw_${variant}`);
  taker.state = 'throwing';
  taker.stateTimer = 0;
  taker.hasBall = false;
  ball.carrierId = null;
  // ROUND 3 FIX: structural guard — the taker must never receive their own
  // throw. Re-target the nearest other outfield teammate, or open space.
  if (target && target.id === taker.id) target = null;
  if (!target) {
    let nearest: Player | null = null;
    let nd = Infinity;
    for (const q of ctx.allPlayers) {
      if (q.team !== taker.team || q.id === taker.id || q.position === 'GK' || q.sentOff) continue;
      const d = dist(taker.x, taker.y, q.x, q.y);
      if (d < nd) {
        nd = d;
        nearest = q;
      }
    }
    target = nearest;
  }

  // Aim AT the teammate, clamped infield so the throw always stays on the
  // pitch and reachable — never to empty grass or out over the line.
  const tx = clamp(target ? target.x : spot.x + targetDir * 80, 40, PITCH_LENGTH - 40);
  const ty = clamp(target ? target.y : (spot.y <= 0 ? 90 : PITCH_WIDTH - 90), 60, PITCH_WIDTH - 60);
  const angle = Math.atan2(ty - taker.y, tx - taker.x);
  taker.facingAngle = angle;
  ball.x = taker.x;
  ball.y = taker.y <= 0 ? 4 : PITCH_WIDTH - 4;
  ball.z = 24;
  if (variant === 'short') {
    // Safe: flat dart to feet, easy to control.
    ball.vx = Math.cos(angle) * 240;
    ball.vy = Math.sin(angle) * 240;
    ball.vz = 105;
    soundEngine.playThrow();
    ctx.addCommentary(
      `${taker.name} takes it SHORT to ${target ? target.name : 'a teammate'} — safe ball to feet!`,
      'out',
      taker.team
    );
  } else {
    // Long: hurled down the line with a high arc for the runner to chase.
    ball.vx = Math.cos(angle) * 300;
    ball.vy = Math.sin(angle) * 300;
    ball.vz = 175;
    soundEngine.playThrow();
    dust(ctx, taker.x, taker.y, 'longthrow');
    ctx.addCommentary(
      `${taker.name} hurls the LONG throw down the line for ${target ? target.name : 'the runner'}!`,
      'out',
      taker.team
    );
  }
  ball.lastTouchTeam = taker.team;
  ball.lastTouchPlayerId = taker.id;
  ctx.addEffect({
    id: `throw-${Date.now()}-${Math.random()}`,
    type: 'dust',
    x: taker.x,
    y: taker.y,
    z: 20,
    life: 0,
    maxLife: 0.28,
  });
}

// ===========================================================================
// 2. CORNERS — inswinger vs outswinger vs short (technique-gated)
// ===========================================================================

export type CornerVariant = 'inswinger' | 'outswinger' | 'short';

export interface CornerPlan {
  variant: CornerVariant;
  targetX: number;
  targetY: number;
}

/**
 * Pick the corner by the kicker's technique: cultured takers bend inswingers
 * at the near post or whip outswingers to the penalty spot; weaker takers
 * play the safe short corner. Crowded six-yard boxes invite the outswinger.
 */
export function pickCornerVariant(
  taker: Player,
  ctx: SetPieceCtx,
  spot: { x: number; y: number }
): CornerPlan {
  const tech = taker.stats.technique;
  const isRight = spot.x > PITCH_LENGTH / 2;
  const boxX = isRight ? PITCH_LENGTH - 110 : 110;
  const boxCrowd = opponentsNear(ctx.allPlayers, boxX, PITCH_WIDTH / 2, 110, taker.team);
  const roll = Math.random();

  if ((tech < 62 && roll < 0.55) || roll < 0.12) {
    // Limited taker, or an occasional surprise routine: short corner.
    countVariety('setpiece:corner_short');
    return {
      variant: 'short',
      targetX: isRight ? PITCH_LENGTH - 190 : 190,
      targetY: spot.y < PITCH_WIDTH / 2 ? 150 : PITCH_WIDTH - 150,
    };
  }
  if (boxCrowd >= 4 || (tech >= 75 && roll < 0.45)) {
    // Outswinger to the penalty spot, away from the keeper's fists.
    countVariety('setpiece:corner_outswinger');
    return {
      variant: 'outswinger',
      targetX: isRight ? PITCH_LENGTH - 150 : 150,
      targetY: PITCH_WIDTH / 2 + (Math.random() - 0.5) * 60,
    };
  }
  if (tech >= 68 || roll < 0.6) {
    // Inswinger bent at the near post under the bar.
    countVariety('setpiece:corner_inswinger');
    return {
      variant: 'inswinger',
      targetX: boxX,
      targetY: PITCH_WIDTH / 2 + (spot.y < PITCH_WIDTH / 2 ? -55 : 55),
    };
  }
  countVariety('setpiece:corner_short');
  return {
    variant: 'short',
    targetX: isRight ? PITCH_LENGTH - 190 : 190,
    targetY: spot.y < PITCH_WIDTH / 2 ? 150 : PITCH_WIDTH - 150,
  };
}

/** Execute the corner: bending inswinger, hanging outswinger, or short pass. */
export function executeCornerVariant(taker: Player, plan: CornerPlan, ctx: SetPieceCtx): void {
  const { ball } = ctx;
  taker.state = 'kicking';
  taker.stateTimer = 0;
  taker.hasBall = false;
  const angle = Math.atan2(plan.targetY - taker.y, plan.targetX - taker.x);
  taker.facingAngle = angle;
  soundEngine.playKick(0.85);
  dust(ctx, taker.x, taker.y, 'corner');

  switch (plan.variant) {
    case 'inswinger': {
      // Bent at pace toward the near post, dipping under the bar.
      ball.vx = Math.cos(angle) * 220;
      ball.vy = Math.sin(angle) * 220;
      ball.vz = 185;
      ctx.addCommentary(`${taker.name} bends in the INSWINGER at the near post!`, 'corner', taker.team);
      break;
    }
    case 'outswinger': {
      // Hanging whip to the penalty spot for the late run.
      ball.vx = Math.cos(angle) * 200;
      ball.vy = Math.sin(angle) * 200;
      ball.vz = 210;
      ctx.addCommentary(`${taker.name} whips an OUTSWINGER to the penalty spot!`, 'corner', taker.team);
      break;
    }
    case 'short': {
      // Rolled short to the edge of the box to keep possession.
      const shortPower = 250;
      ball.vx = Math.cos(angle) * shortPower;
      ball.vy = Math.sin(angle) * shortPower;
      ball.vz = 20;
      ctx.addCommentary(`${taker.name} plays it SHORT — a clever corner routine!`, 'corner', taker.team);
      break;
    }
  }
  ball.lastTouchTeam = taker.team;
  ball.lastTouchPlayerId = taker.id;
}

// ===========================================================================
// 3. FREE KICKS — direct shot (in range) vs delivery; wall + wall jump
// ===========================================================================

export type FreeKickVariant = 'direct' | 'delivery';

export interface FreeKickPlan {
  variant: FreeKickVariant;
  targetX: number;
  targetY: number;
}

/** Direct range: close + central + a strong kick = a shot at goal. */
export function pickFreeKickVariant(
  taker: Player,
  spot: { x: number; y: number },
  targetGoal: { x: number; center: { x: number; y: number } }
): FreeKickPlan {
  const dGoal = dist(spot.x, spot.y, targetGoal.x, targetGoal.center.y);
  const central = Math.abs(spot.y - targetGoal.center.y) < 220;
  const inRange = dGoal < 430 && central && taker.stats.kick >= 68;
  if (inRange && Math.random() < 0.7) {
    countVariety('setpiece:freekick_direct');
    return {
      variant: 'direct',
      targetX: targetGoal.x,
      targetY: Math.random() < 0.5 ? targetGoal.center.y - GOAL_WIDTH / 2 + 20 : targetGoal.center.y + GOAL_WIDTH / 2 - 20,
    };
  }
  countVariety('setpiece:freekick_delivery');
  // Delivery goes into the box of the goal being attacked — never backwards.
  // (targetGoal.x is 0 for the left goal, PITCH_LENGTH for the right goal.)
  const boxX = targetGoal.x === 0 ? 120 : PITCH_LENGTH - 120;
  return {
    variant: 'delivery',
    targetX: boxX,
    targetY: PITCH_WIDTH / 2 + (Math.random() - 0.5) * 90,
  };
}

/**
 * Wall spots: 2–3 defenders on the goal-side line between ball and goal,
 * 8 yards off. Pure function of the spot (no movement itself).
 */
export function wallSpots(
  spot: { x: number; y: number },
  targetGoal: { x: number; center: { x: number; y: number } },
  count: number
): { x: number; y: number }[] {
  const dx = targetGoal.x - spot.x;
  const dy = targetGoal.center.y - spot.y;
  const d = Math.hypot(dx, dy) || 1;
  // Mini-soccer wall stands ~70 units off the ball.
  const wx = spot.x + (dx / d) * 70;
  const wy = spot.y + (dy / d) * 70;
  // Spread across the shot lane.
  const nx = -dy / d;
  const ny = dx / d;
  const spots: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * 38;
    spots.push({
      x: clamp(wx + nx * off, 40, PITCH_LENGTH - 40),
      y: clamp(wy + ny * off, 40, PITCH_WIDTH - 40),
    });
  }
  return spots;
}

/** Execute the free kick: rising direct strike or hanging delivery. */
export function executeFreeKickVariant(
  taker: Player,
  plan: FreeKickPlan,
  ctx: SetPieceCtx,
  targetGoal: { x: number; center: { x: number; y: number } }
): void {
  const { ball } = ctx;
  taker.state = 'kicking';
  taker.stateTimer = 0;
  taker.hasBall = false;
  const angle = Math.atan2(plan.targetY - taker.y, plan.targetX - taker.x);
  taker.facingAngle = angle;
  ball.lastTouchTeam = taker.team;
  ball.lastTouchPlayerId = taker.id;

  if (plan.variant === 'direct') {
    // Rising strike over the wall toward the corner — deliberate, readable pace.
    const power = 380 + taker.stats.kick * 2.2;
    ball.vx = Math.cos(angle) * power;
    ball.vy = Math.sin(angle) * power;
    ball.vz = rand(90, 130); // lower loft, flatter trajectory
    if (taker.team === 'home') ctx.stats.homeShots++;
    else ctx.stats.awayShots++;
    soundEngine.playKick(1.0);
    dust(ctx, taker.x, taker.y, 'freekick');
    ctx.addCommentary(`${taker.name} curls the DIRECT free kick over the wall!`, 'shot', taker.team);
  } else {
    // Hanging delivery into the box: arc so the ball LANDS at the target.
    // Higher and longer to clear opponents — less interception.
    const distToBox = Math.hypot(plan.targetX - taker.x, plan.targetY - taker.y);
    // Longer flight time = higher arc = clears defenders
    const flightTime = Math.max(1.2, Math.min(2.2, distToBox / 320));
    const deliverySpeed = distToBox / flightTime;
    const vz = 0.5 * 720 * flightTime; // gravity=720, peak at flight/2
    ball.vx = Math.cos(angle) * deliverySpeed;
    ball.vy = Math.sin(angle) * deliverySpeed;
    ball.vz = vz;
    soundEngine.playKick(0.85);
    dust(ctx, taker.x, taker.y, 'freekick');
    ctx.addCommentary(`${taker.name} delivers the free kick into the box!`, 'pass', taker.team);
  }
  void targetGoal;
}

/** Wall jump: the wall leaps as the kick is struck (called at delivery). */
export function wallJump(ctx: SetPieceCtx, defenders: Player[]): void {
  for (const d of defenders) {
    if (d.state !== 'blocking') continue;
    d.z = 16 + Math.random() * 8;
    d.stateTimer = 0;
    countVariety('setpiece:wall_jump');
  }
}

// ===========================================================================
// 4. PENALTIES — placement vs power; keeper reads a side
// ===========================================================================

export type PenaltyVariant = 'placement' | 'power';

export interface PenaltyPlan {
  variant: PenaltyVariant;
  targetY: number; // absolute pitch y inside the goal mouth
  keeperGuess: 'left' | 'center' | 'right'; // keeper's read from the taker's view
}

/**
 * Pick the penalty: technicians place it in the corner, strong legs go for
 * power; the keeper reads the taker's body shape and guesses a side.
 */
export function pickPenaltyVariant(
  taker: Player,
  targetGoal: { yMin: number; yMax: number; center: { x: number; y: number } }
): PenaltyPlan {
  const tech = taker.stats.technique;
  const variant: PenaltyVariant = tech >= 72 && Math.random() < 0.6 ? 'placement' : 'power';
  countVariety(`setpiece:penalty_${variant}`);
  const cornered = Math.random() < (variant === 'placement' ? 0.85 : 0.6);
  const side = Math.random() < 0.5 ? -1 : 1;
  const targetY = cornered
    ? targetGoal.center.y + side * (GOAL_WIDTH / 2 - 18)
    : targetGoal.center.y + (Math.random() - 0.5) * GOAL_WIDTH * 0.5;
  // Keeper read: better keepers guess right more often.
  const guessRoll = Math.random();
  const keeperGuess = guessRoll < 0.42 ? (side < 0 ? 'left' : 'right') : guessRoll < 0.6 ? 'center' : side < 0 ? 'right' : 'left';
  void targetGoal.yMin;
  void targetGoal.yMax;
  return { variant, targetY, keeperGuess };
}

/** Execute the penalty: placed into the corner or blasted down the middle. */
export function executePenaltyVariant(
  taker: Player,
  plan: PenaltyPlan,
  ctx: SetPieceCtx,
  targetGoal: { x: number; center: { x: number; y: number } }
): void {
  const { ball } = ctx;
  taker.state = 'kicking';
  taker.stateTimer = 0;
  taker.hasBall = false;
  const angle = Math.atan2(plan.targetY - taker.y, targetGoal.x - taker.x);
  taker.facingAngle = angle;
  ball.lastTouchTeam = taker.team;
  ball.lastTouchPlayerId = taker.id;
  if (taker.team === 'home') ctx.stats.homeShots++;
  else ctx.stats.awayShots++;

  if (plan.variant === 'placement') {
    const power = 260 + taker.stats.kick * 1.2;
    ball.vx = Math.cos(angle) * power;
    ball.vy = Math.sin(angle) * power;
    ball.vz = rand(18, 42) * 2.5;
    soundEngine.playKick(0.9);
    ctx.addCommentary(`${taker.name} PASSES the penalty into the corner!`, 'shot', taker.team);
  } else {
    const power = 320 + taker.stats.kick * 1.5;
    ball.vx = Math.cos(angle) * power;
    ball.vy = Math.sin(angle) * power;
    ball.vz = rand(10, GOAL_HEIGHT + 14) * 2.5;
    soundEngine.playKick(1.0);
    dust(ctx, taker.x, taker.y, 'penalty');
    ctx.addCommentary(`${taker.name} SMASHES the penalty with POWER!`, 'shot', taker.team);
  }
}

/**
 * Send the keeper the right way for the penalty read: dives toward the
 * guessed side from the taker's view (mirrored for the keeper's goal).
 *
 * keeperDefendsLeft is half-aware (use defendsLeft(keeperTeam, half)): the
 * dive mirror follows the goal the keeper defends, which swaps at HT.
 */
export function penaltyKeeperDive(
  gk: Player,
  plan: PenaltyPlan,
  keeperDefendsLeft: boolean
): void {
  // Mirror the taker's read for the keeper's goal.
  const dir = plan.keeperGuess === 'center' ? 0 : plan.keeperGuess === 'left' ? -1 : 1;
  const dive = keeperDefendsLeft ? -dir : dir;
  gk.state = 'diving';
  gk.stateTimer = 0;
  gk.z = 10;
  gk.vx = 0;
  gk.vy = dive * 320;
  gk.facingAngle = dive >= 0 ? Math.PI / 2 : -Math.PI / 2;
  countVariety(`setpiece:keeper_read_${plan.keeperGuess}`);
}
