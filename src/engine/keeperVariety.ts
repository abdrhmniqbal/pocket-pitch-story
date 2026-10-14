/**
 * Goalkeeper Variety — parameterized keeper behavior built on the same
 * pattern as the outfield action variety (pick contextually, execute with
 * real mechanical differences).
 *
 * Positioning stances, eight save techniques (reflex-gated), and six
 * contextual distribution options. This module only sets ball velocities
 * and keeper movement targets — it never touches the physics core,
 * renderer, HUD, match flow, or team data.
 *
 * Mini-soccer rules: no offside, no VAR — none of that is implemented here.
 */

import { Ball, MatchHalf, MatchStats, Player, TeamSide, VisualEffect } from '../types/soccer';
import { dist, GOAL_WIDTH, PENALTY_BOX_LENGTH, PENALTY_BOX_WIDTH, PITCH_LENGTH, PITCH_WIDTH } from './physics';
import { defendsLeft, ownGoalFor } from './sides';
import { countVariety } from './actionVariety';
import { soundEngine } from '../audio/soundEngine';

/**
 * Per-keeper cooldown (game seconds) after any cross claim or punch.
 * While it ticks down the keeper holds his line instead of coming again,
 * so claims can never chain back-to-back. Implemented via the keeper's
 * existing catchCooldown field (already decayed every tick in AI).
 */
export const CLAIM_COOLDOWN_SECONDS = 5;

/** Minimal context shared with the AI layer (AIUpdateContext is assignable). */
export interface KeeperCtx {
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

export interface KeeperGoalFrame {
  x: number;
  yMin: number;
  yMax: number;
  center: { x: number; y: number };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

/** Reflexes 0..1 derived from the keeper's defense stat (handling) + technique. */
export function keeperReflex(gk: Player): number {
  const def = Math.max(0, Math.min(1, (gk.stats.defense - 50) / 50));
  const tech = Math.max(0, Math.min(1, (gk.stats.technique - 50) / 50));
  return clamp(def * 0.7 + tech * 0.3, 0, 1);
}

/**
 * Is this spot inside (or very near) the keeper's own penalty box?
 * Keepers may only attempt catches/claims inside it — outside the box
 * they hold position instead of chasing.
 */
export function inKeeperBox(x: number, y: number, team: TeamSide, margin: number, half?: MatchHalf): boolean {
  const boxTop = (PITCH_WIDTH - PENALTY_BOX_WIDTH) / 2 - margin;
  const boxBottom = (PITCH_WIDTH + PENALTY_BOX_WIDTH) / 2 + margin;
  if (y < boxTop || y > boxBottom) return false;
  // Half-time side switching: the keeper's box follows the goal they defend.
  if (defendsLeft(team, half)) return x >= -margin && x <= PENALTY_BOX_LENGTH + margin;
  return x >= PITCH_LENGTH - PENALTY_BOX_LENGTH - margin && x <= PITCH_LENGTH + margin;
}

function opponentsNear(
  allPlayers: Player[],
  x: number,
  y: number,
  radius: number,
  team: TeamSide
): number {
  let n = 0;
  for (const p of allPlayers) {
    if (p.team !== team && !p.sentOff && dist(p.x, p.y, x, y) < radius) n++;
  }
  return n;
}

// ===========================================================================
// 1. POSITIONING
// ===========================================================================

export type KeeperStance = 'set' | 'shuffle' | 'rush_out' | 'hold_line' | 'claim_cross';

export interface KeeperStanceDecision {
  stance: KeeperStance;
  targetX: number;
  targetY: number;
  speedScale: number;
}

/** Is an opponent through 1v1 on this keeper (carrier, close, central)? */
export function isOneVOne(gk: Player, ctx: KeeperCtx, ownGoal: KeeperGoalFrame): Player | null {
  for (const p of ctx.allPlayers) {
    if (p.team === gk.team || p.sentOff || !p.hasBall) continue;
    const dGoal = dist(p.x, p.y, ownGoal.center.x, ownGoal.center.y);
    const dGk = dist(p.x, p.y, gk.x, gk.y);
    if (dGoal < 330 && dGk < 260) return p;
  }
  return null;
}

/**
 * Is a GENUINE cross incoming? Rare and contextual by design: only a
 * meaningfully elevated ball delivered from a WIDE position and travelling
 * toward the box at a delivered-cross pace. Central balls, ground passes,
 * and balls cleared away never qualify — those belong to the
 * shot-stopping / gathering paths instead.
 */
export function isCrossIncoming(ctx: KeeperCtx, ownGoal: KeeperGoalFrame): boolean {
  const { ball } = ctx;
  if (ball.carrierId !== null) return false;
  const dGoal = dist(ball.x, ball.y, ownGoal.center.x, ownGoal.center.y);
  if (dGoal > 260) return false;
  // High ball only: meaningfully elevated, but still at a reachable height.
  if (ball.z < 22 || ball.z > 90) return false;
  // Must arrive from a genuinely wide position — never central.
  if (Math.abs(ball.y - ownGoal.center.y) <= 100) return false;
  // Must be travelling toward this goal with genuine pace.
  const towardGoal = ownGoal.center.x < PITCH_LENGTH / 2 ? -ball.vx : ball.vx;
  if (towardGoal < 130) return false;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed < 180 || speed > 750) return false;
  return true;
}

/**
 * Contextually pick the keeper's stance for this tick: set on the line,
 * shuffle with the ball, rush out to smother a 1v1, or hold vs claim a cross.
 */
export function decideKeeperStance(
  gk: Player,
  ctx: KeeperCtx,
  ownGoal: KeeperGoalFrame
): KeeperStanceDecision {
  const { ball } = ctx;
  // Half-time side switching: the keeper's line follows the goal they defend.
  const defendsLeftSide = defendsLeft(gk.team, ctx.half);
  const lineX = defendsLeftSide ? 45 : PITCH_LENGTH - 45;

  // 1v1: rush out to smother when the carrier is through and close — but
  // never beyond the edge of the penalty box.
  const through = isOneVOne(gk, ctx, ownGoal);
  if (through) {
    countVariety('keeper:stance_rush');
    const boxEdge = PENALTY_BOX_LENGTH + 12;
    const rushX = clamp(
      through.x + (defendsLeftSide ? -55 : 55),
      defendsLeftSide ? 20 : PITCH_LENGTH - boxEdge,
      defendsLeftSide ? boxEdge : PITCH_LENGTH - 20
    );
    const boxTop = (PITCH_WIDTH - PENALTY_BOX_WIDTH) / 2;
    const boxBottom = (PITCH_WIDTH + PENALTY_BOX_WIDTH) / 2;
    return { stance: 'rush_out', targetX: rushX, targetY: clamp(through.y, boxTop, boxBottom), speedScale: 1.55 };
  }

  // Cross: only a calm, off-cooldown keeper with a realistic chance comes;
  // everyone else holds the line. Claims stay rare by construction — and
  // the keeper never leaves the box to chase one.
  if (isCrossIncoming(ctx, ownGoal) && (gk.catchCooldown ?? 0) <= 0) {
    if (!inKeeperBox(ball.x, ball.y, gk.team, 30, ctx.half)) {
      countVariety('keeper:stance_hold');
      return { stance: 'hold_line', targetX: lineX, targetY: ownGoal.center.y, speedScale: 1.0 };
    }
    const crowd = opponentsNear(ctx.allPlayers, ball.x, ball.y, 90, gk.team);
    const confidence = keeperReflex(gk) * 0.7 + (crowd <= 1 ? 0.3 : -crowd * 0.15);
    if (confidence > 0.6 && dist(gk.x, gk.y, ball.x, ball.y) < 180) {
      countVariety('keeper:stance_claim');
      const boxTop = (PITCH_WIDTH - PENALTY_BOX_WIDTH) / 2;
      const boxBottom = (PITCH_WIDTH + PENALTY_BOX_WIDTH) / 2;
      const boxEdge = PENALTY_BOX_LENGTH + 10;
      const claimX = defendsLeftSide
        ? clamp(ball.x, 15, boxEdge)
        : clamp(ball.x, PITCH_LENGTH - boxEdge, PITCH_LENGTH - 15);
      return { stance: 'claim_cross', targetX: claimX, targetY: clamp(ball.y, boxTop, boxBottom), speedScale: 1.45 };
    }
    countVariety('keeper:stance_hold');
    return { stance: 'hold_line', targetX: lineX, targetY: ownGoal.center.y, speedScale: 1.0 };
  }

  // Open play: set when the ball is far, shuffle as it moves nearer.
  const dBall = dist(gk.x, gk.y, ball.x, ball.y);
  const arcX = defendsLeftSide ? 58 : PITCH_LENGTH - 58;
  // Bisect the angle: shade toward the ball side of the goal.
  const shade = clamp((ball.y - ownGoal.center.y) / 260, -1, 1);
  const targetY = clamp(
    ownGoal.center.y + shade * (GOAL_WIDTH / 2 - 12),
    ownGoal.yMin + 12,
    ownGoal.yMax - 12
  );
  // Step a yard off the line as the ball approaches.
  const press = clamp(1 - dBall / 700, 0, 1);
  const targetX = lineX + (defendsLeftSide ? 1 : -1) * press * 26;
  if (dBall < 480) {
    countVariety('keeper:stance_shuffle');
    return { stance: 'shuffle', targetX: arcX + (defendsLeftSide ? press * 18 : -press * 18), targetY, speedScale: 1.25 };
  }
  countVariety('keeper:stance_set');
  return { stance: 'set', targetX: targetX, targetY, speedScale: 1.0 };
}

/**
 * Smother attempt when rushed out: fling the body at a 1v1 carrier's feet.
 * Returns true when the smother resolves the 1v1 (gather or spill).
 */
export function trySmother(gk: Player, carrier: Player, ctx: KeeperCtx): boolean {
  const d = dist(gk.x, gk.y, carrier.x, carrier.y);
  if (d > 52) return false;
  const { ball } = ctx;
  countVariety('keeper:smother');
  gk.state = 'diving';
  gk.stateTimer = 0;
  gk.z = 6;
  if (gk.team === 'home') ctx.stats.homeSaves++;
  else ctx.stats.awaySaves++;
  soundEngine.playSave();
  ctx.addEffect({
    id: `smother-${Date.now()}-${Math.random()}`,
    type: 'dust',
    x: carrier.x,
    y: carrier.y,
    z: 12,
    life: 0,
    maxLife: 0.45,
  });
  const reflex = keeperReflex(gk);
  if (Math.random() < 0.3 + reflex * 0.28) {
    carrier.hasBall = false;
    ball.carrierId = null;
    gk.state = 'holding';
    gk.stateTimer = 0;
    gk.hasBall = true;
    ball.carrierId = gk.id;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
    ball.z = 14;
    ctx.addCommentary(`${gk.name} RUSHES OUT and SMOTHERS the 1v1 at ${carrier.name}'s feet!`, 'save', gk.team);
    return true;
  }
  // Spilled at the carrier's feet — a scramble!
  carrier.hasBall = false;
  ball.carrierId = null;
  ball.vx = (Math.random() - 0.5) * 260;
  ball.vy = (Math.random() - 0.5) * 260;
  ball.vz = rand(60, 110);
  ball.lastTouchTeam = gk.team;
  ball.lastTouchPlayerId = gk.id;
  gk.catchCooldown = 1.2;
  ctx.addCommentary(`${gk.name} dives at ${carrier.name}'s feet — the 1v1 SPILLS LOOSE!`, 'save', gk.team);
  return true;
}

/**
 * Cross claim on contact: catch cleanly when calm, punch when crowded.
 * Returns true when the claim resolves the cross.
 */
export function tryClaimCross(gk: Player, ctx: KeeperCtx): boolean {
  const { ball } = ctx;
  if (ball.carrierId !== null) return false;
  // Per-keeper cooldown after any claim/punch: claims can never chain.
  if ((gk.catchCooldown ?? 0) > 0) return false;
  if (dist(gk.x, gk.y, ball.x, ball.y) > 34 || ball.z > 55) return false;
  // Must be off the carpet — driven ground balls, dribbles and rollers
  // belong to the shot-stopping / gathering paths, never to a cross claim.
  if (ball.z < 3) return false;
  const ownGoal = ownGoalFor(gk.team, ctx.half);
  const dGoal = dist(ball.x, ball.y, ownGoal.center.x, ownGoal.center.y);
  if (dGoal > 260) return false;
  // Keepers catch only inside (or at the very edge of) their own box.
  if (!inKeeperBox(ball.x, ball.y, gk.team, 18, ctx.half)) return false;
  // Must be arriving into the box, not cleared away or trickling by.
  const towardGoal = ownGoal.center.x < PITCH_LENGTH / 2 ? -ball.vx : ball.vx;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (towardGoal < 80 || speed < 150) return false;
  const crowd = opponentsNear(ctx.allPlayers, gk.x, gk.y, 80, gk.team);
  if (crowd >= 2) {
    // Crowded box: punch it away from danger, high and wide.
    countVariety('keeper:save_punch');
    gk.state = 'diving';
    gk.stateTimer = 0;
    const away = ownGoal.center.x < PITCH_LENGTH / 2 ? 1 : -1;
    ball.vx = away * rand(280, 420);
    ball.vy = (ball.y > PITCH_WIDTH / 2 ? 1 : -1) * rand(140, 240);
    ball.vz = rand(120, 180);
    ball.lastTouchTeam = gk.team;
    ball.lastTouchPlayerId = gk.id;
    gk.catchCooldown = CLAIM_COOLDOWN_SECONDS;
    if (gk.team === 'home') ctx.stats.homeSaves++;
    else ctx.stats.awaySaves++;
    soundEngine.playSave();
    ctx.addCommentary(`${gk.name} comes through the crowd and PUNCHES the cross clear!`, 'save', gk.team);
    return true;
  }
  countVariety('keeper:save_claim');
  gk.state = 'holding';
  gk.stateTimer = 0;
  gk.hasBall = true;
  ball.carrierId = gk.id;
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
  ball.z = 14;
  gk.catchCooldown = CLAIM_COOLDOWN_SECONDS;
  if (gk.team === 'home') ctx.stats.homeSaves++;
  else ctx.stats.awaySaves++;
  soundEngine.playSave();
  ctx.addCommentary(`${gk.name} comes off his line and CLAIMS the cross cleanly!`, 'save', gk.team);
  return true;
}

// ===========================================================================
// 2. SAVES
// ===========================================================================

export type KeeperSaveVariant =
  | 'catch'
  | 'parry'
  | 'punch'
  | 'tip_over'
  | 'dive_low'
  | 'dive_high'
  | 'full_stretch'
  | 'block_feet';

export interface ShotFacts {
  speed: number;
  placement: number; // 0 = straight at keeper, 1 = inside the corner
  height: number; // ball z at contact
  distance: number; // ball-to-goal distance
  crowd: number; // opponents contesting the six-yard zone
  /** How far the ball's path passes from the keeper (0 = straight at him). */
  gap?: number;
}

/** Snapshot the incoming shot: pace, placement, height, distance, crowd. */
export function buildShotFacts(ball: Ball, ownGoal: KeeperGoalFrame, crowd: number, gap?: number): ShotFacts {
  const speed = Math.hypot(ball.vx, ball.vy);
  const lateral = Math.abs(ball.y - ownGoal.center.y) / (GOAL_WIDTH / 2);
  const placement = clamp(lateral, 0, 1);
  return {
    speed,
    placement,
    height: ball.z,
    distance: dist(ball.x, ball.y, ownGoal.center.x, ownGoal.center.y),
    crowd,
    gap,
  };
}

/**
 * Contextually pick the save technique: clean hold for tame efforts,
 * parry / tip-over for pace and placement, punch in a crowd, block with
 * the feet for point-blank low strikes, full stretch for the top corner.
 */
export function pickKeeperSave(gk: Player, facts: ShotFacts): KeeperSaveVariant {
  void gk;
  const gap = facts.gap ?? 20;
  // Point-blank and low: no time to dive, block with feet/body.
  if (facts.distance < 120 && facts.height < 22) return 'block_feet';
  // Crowded six-yard box under a high ball: punch, never catch.
  if (facts.crowd >= 2 && facts.height > 18) return 'punch';
  // Well wide of the body: it is a stretch, not a catch.
  if (gap > 45) {
    if (facts.height > 26) return 'tip_over';
    return facts.speed > 480 ? 'full_stretch' : 'dive_low';
  }
  // Very hot: parry when it is at the body, stretch when it is not.
  if (facts.speed > 580) return gap < 28 ? 'parry' : 'full_stretch';
  // High ball: pluck it if it is close, tip it over if not.
  if (facts.height > 26) return gap < 34 ? 'dive_high' : 'tip_over';
  // Anything at (or near) the body at a catchable pace: hold it.
  return gap < 40 ? 'catch' : 'dive_low';
}

/**
 * Reflex-gate the chosen technique: harder stops (stretch, tip-over,
 * point-blank block) need sharper reflexes; tame catches rarely fail.
 * Returns true when the keeper gets enough on it.
 */
export function keeperSaveSuccess(gk: Player, variant: KeeperSaveVariant, facts: ShotFacts): boolean {
  const reflex = keeperReflex(gk);
  // How hard is this shot? Pace, how far the keeper must reach, and how close it is.
  const speedNorm = clamp((facts.speed - 250) / 550, 0, 1);
  const gapNorm = clamp((facts.gap ?? 28) / 58, 0, 1.3);
  const close = clamp(1 - facts.distance / 260, 0, 1);
  let difficulty = 0.4 * speedNorm + 0.36 * gapNorm + 0.14 * close;
  switch (variant) {
    case 'tip_over': difficulty += 0.06; break;
    case 'dive_high': difficulty += 0.06; break;
    case 'full_stretch': difficulty += 0.08; break;
    case 'block_feet': difficulty += 0.05; break;
    case 'dive_low': difficulty += 0.02; break;
    default: break;
  }
  const chance = clamp(0.96 - 0.68 * difficulty + 0.2 * (reflex - 0.5), 0.12, 0.96);
  return Math.random() < chance;
}

/**
 * Execute the save. Returns 'held' (gathered), 'deflected' (still live),
 * or 'beaten' (reflex failure — the ball flies on, possibly goal-bound).
 */
export function executeKeeperSave(
  gk: Player,
  variant: KeeperSaveVariant,
  facts: ShotFacts,
  ctx: KeeperCtx,
  ownGoal: KeeperGoalFrame
): 'held' | 'deflected' | 'beaten' {
  const { ball } = ctx;
  countVariety(`keeper:save_${variant}`);
  gk.state = 'diving';
  gk.stateTimer = 0;
  gk.z = variant === 'dive_low' || variant === 'block_feet' ? 4 : 12 + Math.random() * 10;
  // Capped lunge: the keeper stretches without sliding out of the goalmouth,
  // so it can recover its stance/position as soon as the dive resolves.
  const diveVx = (ball.x - gk.x) * 3.2;
  const diveVy = (ball.y - gk.y) * 3.2;
  const diveMag = Math.hypot(diveVx, diveVy) || 1;
  const diveScale = Math.min(1, 300 / diveMag);
  gk.vx = diveVx * diveScale;
  gk.vy = diveVy * diveScale;
  if (gk.team === 'home') ctx.stats.homeSaves++;
  else ctx.stats.awaySaves++;
  soundEngine.playSave();
  ctx.addEffect({
    id: `save-${Date.now()}-${Math.random()}`,
    type: 'dust',
    x: ball.x,
    y: ball.y,
    z: ball.z + 8,
    life: 0,
    maxLife: 0.45,
  });

  const success = keeperSaveSuccess(gk, variant, facts);
  if (!success) {
    // Beaten: a fingertip at best — the ball keeps travelling.
    countVariety('keeper:beaten');
    ball.vx *= 0.82;
    ball.vy *= 0.82;
    ball.vz = Math.max(ball.vz, 30);
    ball.lastTouchTeam = gk.team;
    ball.lastTouchPlayerId = gk.id;
    gk.catchCooldown = 0.9;
    ctx.addCommentary(
      `${gk.name} gets a fingertip on it but can't keep it out — IT'S THROUGH!`,
      'save',
      gk.team
    );
    return 'beaten';
  }

  const away = ownGoal.center.x < PITCH_LENGTH / 2 ? 1 : -1;
  switch (variant) {
    case 'catch':
    case 'dive_high':
      gk.state = 'holding';
      gk.stateTimer = 0;
      gk.hasBall = true;
      ball.carrierId = gk.id;
      ball.vx = 0;
      ball.vy = 0;
      ball.vz = 0;
      ball.z = 14;
      ctx.addCommentary(
        variant === 'catch'
          ? `SAFE HANDS! ${gk.name} holds the shot cleanly!`
          : `${gk.name} leaps HIGH and plucks it out of the air!`,
        'save',
        gk.team
      );
      return 'held';
    case 'tip_over':
      gk.catchCooldown = 0.9;
      ball.vz = 150 + Math.random() * 70;
      ball.vx = away * rand(120, 220);
      ball.vy += (ball.y > PITCH_WIDTH / 2 ? 1 : -1) * rand(100, 180);
      ctx.addCommentary(`${gk.name} TIPS IT OVER THE BAR — fingertip brilliance!`, 'save', gk.team);
      return 'deflected';
    case 'parry':
    case 'dive_low':
      gk.catchCooldown = 0.8;
      // Parry WIDE and short: mostly sideways toward the touchline, only
      // moderately forward — never with the power to reach the other end.
      ball.vx = away * rand(110, 190);
      ball.vy = (ball.y > PITCH_WIDTH / 2 ? 1 : -1) * rand(170, 260);
      ball.vz = rand(60, 110);
      ctx.addCommentary(
        variant === 'parry'
          ? `${gk.name} PARRIES it away from danger!`
          : `${gk.name} dives LOW to his ${ball.y > ownGoal.center.y ? 'right' : 'left'} and turns it away!`,
        'save',
        gk.team
      );
      return 'deflected';
    case 'full_stretch':
      gk.catchCooldown = 0.9;
      // Full stretch: wide and short, kills the pace.
      ball.vx = away * rand(90, 160);
      ball.vy = (ball.y > PITCH_WIDTH / 2 ? 1 : -1) * rand(180, 260);
      ball.vz = rand(70, 120);
      ctx.addCommentary(`${gk.name} goes FULL STRETCH — an astonishing stop!`, 'save', gk.team);
      return 'deflected';
    case 'punch':
      gk.catchCooldown = 0.8;
      // Punch clears the box but stays in the defensive third — wide, not long.
      ball.vx = away * rand(150, 240);
      ball.vy = (ball.y > PITCH_WIDTH / 2 ? 1 : -1) * rand(130, 210);
      ball.vz = rand(100, 150);
      ctx.addCommentary(`${gk.name} PUNCHES it clear from the crowded box!`, 'save', gk.team);
      return 'deflected';
    case 'block_feet':
      gk.catchCooldown = 0.7;
      // Block: deadens the ball, scatters it wide and short.
      ball.vx = away * rand(100, 180);
      ball.vy += (Math.random() - 0.5) * 260;
      ball.vz = rand(60, 110);
      ctx.addCommentary(`${gk.name} BLOCKS it with his legs — point-blank denial!`, 'save', gk.team);
      return 'deflected';
  }
}

// ===========================================================================
// 3. DISTRIBUTION
// ===========================================================================

export type KeeperDistVariant =
  | 'roll_out'
  | 'throw_overarm'
  | 'drop_kick'
  | 'long_kick'
  | 'goal_kick_short'
  | 'goal_kick_long';

/** Pressure on the keeper: opponents closing down the box. */
export function keeperPressure(gk: Player, ctx: KeeperCtx): number {
  return opponentsNear(ctx.allPlayers, gk.x, gk.y, 170, gk.team);
}

/** Nearest open teammate within a radius band (never sent-off, never the keeper). */
function openMateNear(
  gk: Player,
  ctx: KeeperCtx,
  lo: number,
  hi: number
): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of ctx.allPlayers) {
    if (mate.team !== gk.team || mate.id === gk.id || mate.sentOff) continue;
    const d = dist(gk.x, gk.y, mate.x, mate.y);
    if (d < lo || d > hi) continue;
    // ROUND 3 FIX: distribution targets must be OPEN — any opponent within
    // the radius disqualifies the outlet, never thrown into pressure.
    const crowd = opponentsNear(ctx.allPlayers, mate.x, mate.y, 70, gk.team);
    if (crowd > 0) continue;
    const score = 80 - d * 0.05 + Math.random() * 12;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return bestScore > 15 ? best : null;
}

/** Open runner breaking downfield into space (counter target). */
function openRunner(gk: Player, ctx: KeeperCtx, targetDir: number): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of ctx.allPlayers) {
    if (mate.team !== gk.team || mate.id === gk.id || mate.sentOff) continue;
    if (mate.position !== 'FW' && mate.position !== 'MF') continue;
    const ahead = (mate.x - gk.x) * targetDir;
    if (ahead < 260) continue;
    const crowd = opponentsNear(ctx.allPlayers, mate.x, mate.y, 75, gk.team);
    if (crowd > 0) continue;
    const score = ahead * 0.15 + Math.random() * 14;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return bestScore > 35 ? best : null;
}

/**
 * Contextually pick the distribution — never random: pressed keepers go
 * long, calm keepers build short through the open defender, and a breaking
 * runner triggers the counter.
 */
export function pickKeeperDistribution(
  gk: Player,
  ctx: KeeperCtx,
  targetDir: number,
  fromGoalKick: boolean
): KeeperDistVariant {
  const pressure = keeperPressure(gk, ctx);
  const shortOutlet = openMateNear(gk, ctx, 90, 300);
  const runner = openRunner(gk, ctx, targetDir);

  if (fromGoalKick) {
    if (shortOutlet && pressure < 2 && Math.random() < 0.7) return 'goal_kick_short';
    return 'goal_kick_long';
  }
  // Under heavy pressure: get it long and safe upfield.
  if (pressure >= 2) return Math.random() < 0.55 ? 'long_kick' : 'drop_kick';
  // Breaking runner in space: launch the counter over the top.
  if (runner && Math.random() < 0.5) return 'long_kick';
  // Nearby open defender: calm build-up — roll when very close, throw when wider.
  if (shortOutlet) {
    const d = dist(gk.x, gk.y, shortOutlet.x, shortOutlet.y);
    return d < 170 ? 'roll_out' : 'throw_overarm';
  }
  // Nothing short on: drop-kick into the channel.
  return 'drop_kick';
}

/**
 * Execute a GOAL KICK as a proper foot kick from the ground. Hand
 * distribution (roll_out / throw_overarm) is ONLY for the keeper releasing
 * a live ball held after a catch — it can never come out of a goal kick.
 */
export function executeGoalKick(gk: Player, ctx: KeeperCtx, targetDir: number): void {
  const variant = pickKeeperDistribution(gk, ctx, targetDir, true);
  if (variant === 'goal_kick_short' || variant === 'goal_kick_long') {
    executeKeeperDistribution(gk, variant, ctx, targetDir);
    return;
  }
  // Structural guarantee: any non-kick pick degrades to the long foot kick.
  executeKeeperDistribution(gk, 'goal_kick_long', ctx, targetDir);
}

/**
 * ROUND 3 FIX: final safety verify at release time — never distribute onto a
 * marked teammate. Returns the target only when no opponent is within the
 * radius; otherwise null so the keeper goes long to space instead.
 */
function verifyOpenTarget(
  ctx: KeeperCtx,
  target: Player | null | undefined,
  team: TeamSide,
  radius: number
): Player | null {
  if (!target || target.sentOff) return null;
  return opponentsNear(ctx.allPlayers, target.x, target.y, radius, team) === 0 ? target : null;
}

/** Widest-net search: any open outfield mate anywhere upfield of the keeper. */
function findAnyOpenMate(gk: Player, ctx: KeeperCtx, targetDir: number): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const mate of ctx.allPlayers) {
    if (mate.team !== gk.team || mate.id === gk.id || mate.sentOff || mate.position === 'GK') continue;
    if ((mate.x - gk.x) * targetDir < -40) continue;
    if (opponentsNear(ctx.allPlayers, mate.x, mate.y, 70, gk.team) > 0) continue;
    const d = dist(gk.x, gk.y, mate.x, mate.y);
    const score = 120 - d * 0.08 + Math.random() * 12;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return best;
}

/** Execute the distribution with real mechanical differences per option. */
export function executeKeeperDistribution(
  gk: Player,
  variant: KeeperDistVariant,
  ctx: KeeperCtx,
  targetDir: number
): void {
  const { ball } = ctx;
  countVariety(`keeper:dist_${variant}`);
  gk.hasBall = false;
  ball.carrierId = null;
  ball.lastTouchPlayerId = gk.id;
  ball.lastTouchTeam = gk.team;
  gk.catchCooldown = 2.5; // Never re-catch the ball just released.

  const shortOutlet = openMateNear(gk, ctx, 90, 320);
  const runner = openRunner(gk, ctx, targetDir);
  const midfield = ctx.allPlayers.find(
    p => p.team === gk.team && !p.sentOff && p.position === 'MF' && p.id !== gk.id
  );

  switch (variant) {
    case 'roll_out': {
      // Rolled along the carpet to a nearby open defender.
      const target = verifyOpenTarget(ctx, shortOutlet, gk.team, 70)
        ?? verifyOpenTarget(ctx, midfield, gk.team, 70)
        ?? findAnyOpenMate(gk, ctx, targetDir);
      gk.state = 'throwing';
      gk.stateTimer = 0;
      if (!target) {
        // Nobody open: hurl it long to empty space rather than into pressure.
        const aimX = gk.x + targetDir * 480;
        const aimY = PITCH_WIDTH / 2 + (Math.random() - 0.5) * 160;
        const fallbackAngle = Math.atan2(aimY - gk.y, aimX - gk.x);
        gk.facingAngle = fallbackAngle;
        ball.x = gk.x + Math.cos(fallbackAngle) * 24;
        ball.y = gk.y + Math.sin(fallbackAngle) * 24;
        ball.vx = Math.cos(fallbackAngle) * 430;
        ball.vy = Math.sin(fallbackAngle) * 430;
        ball.vz = 150;
        soundEngine.playKick(0.9);
        ctx.addCommentary(`${gk.name} finds nobody open and hurls it LONG to space!`, 'pass', gk.team);
        break;
      }
      const angle = Math.atan2(target.y - gk.y, target.x - gk.x);
      gk.facingAngle = angle;
      ball.x = gk.x + Math.cos(angle) * 20;
      ball.y = gk.y + Math.sin(angle) * 20;
      ball.vx = Math.cos(angle) * 250;
      ball.vy = Math.sin(angle) * 250;
      ball.vz = 4;
      soundEngine.playThrow();
      ctx.addCommentary(`${gk.name} rolls it out calmly to ${target.name}!`, 'pass', gk.team);
      break;
    }
    case 'throw_overarm': {
      // Flat overarm throw to a nearby open teammate.
      const target = verifyOpenTarget(ctx, shortOutlet, gk.team, 70)
        ?? verifyOpenTarget(ctx, midfield, gk.team, 70)
        ?? findAnyOpenMate(gk, ctx, targetDir);
      gk.state = 'throwing';
      gk.stateTimer = 0;
      if (!target) {
        // Nobody open: hurl it long to empty space rather than into pressure.
        const aimX = gk.x + targetDir * 480;
        const aimY = PITCH_WIDTH / 2 + (Math.random() - 0.5) * 160;
        const fallbackAngle = Math.atan2(aimY - gk.y, aimX - gk.x);
        gk.facingAngle = fallbackAngle;
        ball.x = gk.x + Math.cos(fallbackAngle) * 24;
        ball.y = gk.y + Math.sin(fallbackAngle) * 24;
        ball.vx = Math.cos(fallbackAngle) * 430;
        ball.vy = Math.sin(fallbackAngle) * 430;
        ball.vz = 150;
        soundEngine.playKick(0.9);
        ctx.addCommentary(`${gk.name} finds nobody open and hurls it LONG to space!`, 'pass', gk.team);
        break;
      }
      const angle = Math.atan2(target.y - gk.y, target.x - gk.x);
      gk.facingAngle = angle;
      ball.x = gk.x + Math.cos(angle) * 24;
      ball.y = gk.y + Math.sin(angle) * 24;
      ball.vx = Math.cos(angle) * 330;
      ball.vy = Math.sin(angle) * 330;
      ball.vz = 30;
      soundEngine.playThrow();
      ctx.addCommentary(`${gk.name} throws it OVERARM to ${target.name} on the flank!`, 'pass', gk.team);
      break;
    }
    case 'drop_kick': {
      // Drop-kick driven into the midfield channel.
      const target = verifyOpenTarget(ctx, runner, gk.team, 75)
        ?? verifyOpenTarget(ctx, midfield, gk.team, 70)
        ?? findAnyOpenMate(gk, ctx, targetDir);
      gk.state = 'kicking';
      gk.stateTimer = 0;
      const aimX = target ? target.x : gk.x + targetDir * 420;
      const aimY = target ? target.y : PITCH_WIDTH / 2;
      const angle = Math.atan2(aimY - gk.y, aimX - gk.x);
      gk.facingAngle = angle;
      ball.x = gk.x + Math.cos(angle) * 24;
      ball.y = gk.y + Math.sin(angle) * 24;
      ball.vx = Math.cos(angle) * 400;
      ball.vy = Math.sin(angle) * 400;
      ball.vz = 120;
      soundEngine.playKick(0.9);
      ctx.addCommentary(
        target ? `${gk.name} DROP-KICKS it into the channel for ${target.name}!` : `${gk.name} drop-kicks it long upfield!`,
        'pass',
        gk.team
      );
      break;
    }
    case 'long_kick': {
      // Soaring counter over the top for the breaking runner.
      const target = verifyOpenTarget(ctx, runner, gk.team, 75)
        ?? verifyOpenTarget(ctx, midfield, gk.team, 70)
        ?? findAnyOpenMate(gk, ctx, targetDir);
      gk.state = 'kicking';
      gk.stateTimer = 0;
      const aimX = target ? target.x + targetDir * 45 : gk.x + targetDir * 520;
      const aimY = target ? target.y : PITCH_WIDTH / 2;
      const angle = Math.atan2(aimY - gk.y, aimX - gk.x);
      gk.facingAngle = angle;
      ball.x = gk.x + Math.cos(angle) * 24;
      ball.y = gk.y + Math.sin(angle) * 24;
      ball.vx = Math.cos(angle) * 445;
      ball.vy = Math.sin(angle) * 445;
      ball.vz = 175;
      soundEngine.playKick(0.95);
      ctx.addEffect({
        id: `punt-${Date.now()}-${Math.random()}`,
        type: 'dust',
        x: gk.x,
        y: gk.y,
        z: 0,
        life: 0,
        maxLife: 0.35,
      });
      ctx.addCommentary(
        target ? `${gk.name} launches the LONG KICK counter for ${target.name}!` : `${gk.name} goes LONG upfield under pressure!`,
        'pass',
        gk.team
      );
      break;
    }
    case 'goal_kick_short': {
      // FOOT restart along the carpet to a wide-open defender. Never a
      // dead ball: with no short outlet it becomes a driven long kick.
      const target = verifyOpenTarget(ctx, shortOutlet, gk.team, 70)
        ?? verifyOpenTarget(ctx, midfield, gk.team, 70)
        ?? findAnyOpenMate(gk, ctx, targetDir);
      gk.state = 'kicking';
      gk.stateTimer = 0;
      ball.z = 0; // kicked from the ground, not from the hands
      if (!target) {
        const midX = targetDir === 1 ? PITCH_LENGTH * 0.45 : PITCH_LENGTH * 0.55;
        const midY = PITCH_WIDTH / 2 + (Math.random() - 0.5) * 90;
        const fallbackAngle = Math.atan2(midY - gk.y, midX - gk.x);
        gk.facingAngle = fallbackAngle;
        ball.vx = Math.cos(fallbackAngle) * 370;
        ball.vy = Math.sin(fallbackAngle) * 370;
        ball.vz = 125;
        soundEngine.playKick(0.85);
        ctx.addCommentary(`${gk.name} drives the GOAL KICK long into midfield!`, 'pass', gk.team);
        break;
      }
      const angle = Math.atan2(target.y - gk.y, target.x - gk.x);
      gk.facingAngle = angle;
      ball.vx = Math.cos(angle) * 260;
      ball.vy = Math.sin(angle) * 260;
      ball.vz = 0;
      soundEngine.playKick(0.65);
      ctx.addCommentary(`${gk.name} restarts SHORT to ${target.name} to build from the back.`, 'pass', gk.team);
      break;
    }
    case 'goal_kick_long': {
      // Driven FOOT restart into midfield, kicked from the ground.
      gk.state = 'kicking';
      gk.stateTimer = 0;
      ball.z = 0; // kicked from the ground, not from the hands
      const midX = targetDir === 1 ? PITCH_LENGTH * 0.45 : PITCH_LENGTH * 0.55;
      const midY = PITCH_WIDTH / 2 + (Math.random() - 0.5) * 90;
      const angle = Math.atan2(midY - gk.y, midX - gk.x);
      gk.facingAngle = angle;
      ball.vx = Math.cos(angle) * 370;
      ball.vy = Math.sin(angle) * 370;
      ball.vz = 125;
      soundEngine.playKick(0.85);
      ctx.addCommentary(`${gk.name} drives the GOAL KICK long into midfield!`, 'pass', gk.team);
      break;
    }
  }
}
