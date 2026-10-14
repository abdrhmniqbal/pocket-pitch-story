/**
 * Soccer Artificial Intelligence for Pocket League Match Day
 * Governs dribbling, passing, shooting, slide tackling, marking, and goalkeeping.
 */

import { Ball, MatchHalf, MatchStats, Player, TeamSide, VisualEffect } from '../types/soccer';
import { dist, GOAL_HEIGHT, GOAL_WIDTH, LEFT_GOAL, PENALTY_BOX_LENGTH, PENALTY_BOX_WIDTH, PITCH_LENGTH, PITCH_WIDTH, RIGHT_GOAL } from './physics';
import { attackDirFor, attackGoalFor, formationXOf, ownGoalFor } from './sides';
import { soundEngine } from '../audio/soundEngine';
import {
  buildShotFacts,
  decideKeeperStance,
  executeKeeperDistribution,
  executeKeeperSave,
  isOneVOne,
  pickKeeperDistribution,
  pickKeeperSave,
  tryClaimCross,
  trySmother,
} from './keeperVariety';
import { keeperPosition, keeperTick, planShotResponse } from './keeperBrain';
import {
  assessTackle,
  dropDeepShift,
  raiseFoulEvent,
  removeWalkedOff,
  tackleFromBehind,
} from './referee';
import {
  applyReceiveTouch,
  buildShooterInfo,
  checkBlockContact,
  consumeOneTwoReturn,
  clearDribbleExposure,
  dribblePressMultiplier,
  dribbleRiskBonus,
  executePassVariant,
  executePokeTackle,
  executeSafetyClearance,
  executeShotVariant,
  frustrateAfterFoul,
  jockeyPoint,
  notePossessionGain,
  updateDribbleExposure,
  knockProne,
  countVariety,
  maybeShieldOrHoldUp,
  maybeSkillOrShield,
  pickPassVariant,
  pickShotVariant,
  recoveryPoint,
  shouldJockey,
  shotBlockPoint,
  tryFirstTimeFinish,
} from './actionVariety';
import {
  attackRun,
  brainOffBall,
  brainOnCarry,
  brainTick,
  carrySteer,
  decideCarrier,
  defensivePost,
  interceptPoint,
  perceiveCarrier,
  pressBoost,
  thinkDelay,
} from './aiBrain';

type PassVariantArg = Parameters<typeof executePassVariant>[2];

export interface AIUpdateContext {
  dt: number;
  ball: Ball;
  allPlayers: Player[];
  stats: MatchStats;
  addEffect: (effect: VisualEffect) => void;
  addCommentary: (text: string, type: 'goal' | 'save' | 'shot' | 'tackle' | 'pass' | 'whistle' | 'info' | 'corner' | 'out', team?: TeamSide) => void;
  tackleSuppressed?: boolean;
  half?: MatchHalf;
  homeScore?: number;
  awayScore?: number;
  matchMinutes?: number;
  matchSeconds?: number;
}

/**
 * AWARENESS layer: per-player short-term memory for varied, alive decisions.
 */
interface AwarenessMemory {
  thinkCooldown: number;
  lastAction: 'shoot' | 'pass' | 'dribble' | 'clear' | null;
  lastTargetId: string | null;
  repeatCount: number;
  dribbleLane: number;
  runSeed: number;
}

const awarenessMemories = new Map<string, AwarenessMemory>();

/**
 * Fetch (or create with randomized init) the awareness memory for a player.
 */
function getAwareness(id: string): AwarenessMemory {
  let mem = awarenessMemories.get(id);
  if (!mem) {
    mem = {
      thinkCooldown: Math.random() * 0.2,
      lastAction: null,
      lastTargetId: null,
      repeatCount: 0,
      dribbleLane: Math.random() * 2 - 1,
      runSeed: Math.random() * Math.PI * 2,
    };
    awarenessMemories.set(id, mem);
  }
  return mem;
}

/**
 * Normalized player traits in 0..1 derived from raw stats.
 */
interface PlayerTraits {
  pace: number;
  flair: number;
  grit: number;
  finish: number;
}

/**
 * Map speed/technique/defense/kick to pace/flair/grit/finish in 0..1.
 */
function playerTraits(player: Player): PlayerTraits {
  const norm = (s: number): number => Math.max(0, Math.min(1, (s - 50) / 50));
  return {
    pace: norm(player.stats.speed),
    flair: norm(player.stats.technique),
    grit: norm(player.stats.defense),
    finish: norm(player.stats.kick),
  };
}

/**
 * Second-touch rule (fix 1): a set-piece taker cannot re-collect the ball
 * until another player has touched it. The engine arms ball.secondTouchBlockId
 * at delivery; every gain path below must consult this gate.
 */
function isSecondTouchBlocked(player: Player, ball: Ball): boolean {
  return ball.secondTouchBlockId != null && ball.secondTouchBlockId === player.id;
}

/**
 * Snapshot of the carrier situation used by the utility scorers.
 */
interface SituationSnapshot {
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
  scoreDiff: number;
  minutesLeft: number;
  chasingLate: boolean;
  protectingLate: boolean;
}

/**
 * Clamp a number into 0..1.
 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Build a snapshot of the carrier situation: goal distance, angle,
 * pressure, thirds, width, outlets, and score/clock state.
 */
function snapshotSituation(
  player: Player,
  ctx: AIUpdateContext,
  targetGoal: typeof RIGHT_GOAL,
  targetDir: number
): SituationSnapshot {
  const { allPlayers } = ctx;
  const distToGoal = dist(player.x, player.y, targetGoal.x, targetGoal.center.y);
  const lateralOffset = Math.abs(player.y - targetGoal.center.y);
  const angleQuality = clamp01(1 - lateralOffset / (190 + distToGoal * 0.28));
  const opponents = allPlayers.filter(p => p.team !== player.team && p.position !== 'GK');
  let nearestOpp = 999;
  let secondOpp = 999;
  for (const o of opponents) {
    const d = dist(player.x, player.y, o.x, o.y);
    if (d < nearestOpp) {
      secondOpp = nearestOpp;
      nearestOpp = d;
    } else if (d < secondOpp) {
      secondOpp = d;
    }
  }
  const underHeavyPressure = nearestOpp < 65;
  let inOwnThird: boolean;
  let inAttackingThird: boolean;
  if (targetDir === 1) {
    inOwnThird = player.x < PITCH_LENGTH / 3;
    inAttackingThird = player.x > (PITCH_LENGTH * 2) / 3;
  } else {
    inOwnThird = player.x > (PITCH_LENGTH * 2) / 3;
    inAttackingThird = player.x < PITCH_LENGTH / 3;
  }
  const isWide = player.y < 200 || player.y > PITCH_WIDTH - 200;
  const allOpponents = allPlayers.filter(p => p.team !== player.team);
  const mates = allPlayers.filter(p => p.team === player.team && p.id !== player.id && p.position !== 'GK');
  let openTeammates = 0;
  for (const mate of mates) {
    let crowded = false;
    for (const opp of allOpponents) {
      if (dist(opp.x, opp.y, mate.x, mate.y) < 70) {
        crowded = true;
        break;
      }
    }
    if (!crowded) openTeammates++;
  }
  const homeScore = ctx.homeScore !== undefined ? ctx.homeScore : 0;
  const awayScore = ctx.awayScore !== undefined ? ctx.awayScore : 0;
  const hasScore = ctx.homeScore !== undefined && ctx.awayScore !== undefined;
  const isHome = player.team === 'home';
  const scoreDiff = hasScore ? (isHome ? homeScore - awayScore : awayScore - homeScore) : 0;
  const hasClock = ctx.matchMinutes !== undefined;
  const minutes = ctx.matchMinutes !== undefined ? ctx.matchMinutes : 45;
  const seconds = ctx.matchSeconds !== undefined ? ctx.matchSeconds : 0;
  const minutesLeft = hasClock ? Math.max(0, 90 - (minutes + seconds / 60)) : 45;
  const chasingLate = scoreDiff < 0 && minutesLeft <= 20;
  const protectingLate = scoreDiff > 0 && minutesLeft <= 15;
  return {
    distToGoal,
    lateralOffset,
    angleQuality,
    nearestOpp,
    secondOpp,
    underHeavyPressure,
    inOwnThird,
    inAttackingThird,
    isWide,
    openTeammates,
    scoreDiff,
    minutesLeft,
    chasingLate,
    protectingLate,
  };
}

/**
 * Carrier action chosen by the utility scorer.
 */
type CarrierAction = 'shoot' | 'pass' | 'dribble' | 'clear';

/**
 * Record a carrier decision so repeats can be penalized and targets rotated.
 */
function noteDecision(mem: AwarenessMemory, action: CarrierAction, targetId?: string | null): void {
  if (mem.lastAction === action) {
    mem.repeatCount += 1;
  } else {
    mem.lastAction = action;
    mem.repeatCount = 1;
  }
  if (targetId !== undefined) {
    mem.lastTargetId = targetId;
  }
}



export function updatePlayerAI(
  player: Player,
  ctx: AIUpdateContext
): void {
  const { dt, ball, allPlayers } = ctx;
  brainTick(ctx);

  // Sent off: walk off toward the sideline/tunnel (fix 6), then removed.
  // Play continues around them; they never touch the ball again.
  if (player.sentOff) {
    player.hasBall = false;
    if (player.walkingOff) {
      const tx = player.walkOffTx ?? player.x;
      const ty = player.walkOffTy ?? (player.y < PITCH_WIDTH / 2 ? -45 : PITCH_WIDTH + 45);
      player.state = 'disappointed';
      moveToTarget(player, tx, ty, Math.max(200, player.stats.speed * 1.1), dt);
      player.state = 'disappointed';
      player.stateTimer = 0;
      const out = player.y < -25 || player.y > PITCH_WIDTH + 25;
      const arrived = out || dist(player.x, player.y, tx, ty) < 22;
      if (arrived) removeWalkedOff(player);
    }
    return;
  }

  // Reduce cooldowns & state timers
  if (player.tackleCooldown > 0) {
    player.tackleCooldown = Math.max(0, player.tackleCooldown - dt);
  }
  if (player.catchCooldown !== undefined && player.catchCooldown > 0) {
    player.catchCooldown = Math.max(0, player.catchCooldown - dt);
  }
  player.stateTimer += dt;

  // Finish momentary states (e.g., kicking, throwing, tackling, sliding, diving)
  if (player.state === 'kicking' && player.stateTimer > 0.28) {
    player.state = 'idle';
  } else if (player.state === 'throwing' && player.stateTimer > 0.35) {
    player.state = 'idle';
  } else if (player.state === 'tackling' && player.stateTimer > 0.45) {
    player.state = 'idle';
  } else if (player.state === 'sliding' && player.stateTimer > 0.45) {
    player.state = 'idle';
  } else if (player.state === 'prone' && player.stateTimer > 1.0) {
    player.state = 'idle';
    player.z = 0; // back on feet after fall: re-tethers sprite to shadow
  } else if (player.state === 'diving' && player.stateTimer > 0.5) {
    player.state = 'idle';
    player.z = 0; // back on the ground: re-tethers sprite to shadow, stance resumes next tick
    player.vx = 0; // stop dive momentum so GK doesn't slide/teleport
    player.vy = 0;
  } else if (player.state === 'skill_move' && player.stateTimer > 0.5) {
    player.state = 'idle';
  } else if ((player.state === 'shielding' || player.state === 'jockeying' || player.state === 'blocking') && player.stateTimer > 1.2) {
    player.state = 'idle';
  } else if ((player.state === 'celebrating' || player.state === 'disappointed' || player.state === 'protesting') && player.stateTimer > 3.0) {
    player.state = 'idle';
  }

  // Freeze action during non-moving states
  if (player.state === 'tackling' || player.state === 'sliding' || player.state === 'prone' || player.state === 'diving' || player.state === 'celebrating' || player.state === 'disappointed' || player.state === 'protesting') {
    // Dampen movement
    player.vx *= 0.85;
    player.vy *= 0.85;
    player.x += player.vx * dt;
    player.y += player.vy * dt;
    return;
  }

  // Half-time side switching: teams swap ends in the second half (home
  // attacks LEFT, away attacks RIGHT). All direction logic below derives
  // from these half-aware helpers.
  const half = ctx.half;
  const targetGoal = attackGoalFor(player.team, half);
  const ownGoal = ownGoalFor(player.team, half);

  const targetDir = attackDirFor(player.team, half);
  const distToBall = dist(player.x, player.y, ball.x, ball.y);

  // 1. GOALKEEPER AI
  if (player.position === 'GK') {
    updateGoalkeeperAI(player, ctx, ownGoal, targetDir);
    return;
  }

  // 2. PLAYER HAS THE BALL
  const canControlBall = !player.catchCooldown || player.catchCooldown <= 0;
  // Second-touch rule: the blocked taker cannot re-collect their own set piece.
  if (isSecondTouchBlocked(player, ball) && !player.hasBall) {
    player.hasBall = false;
    // Drift toward shape instead of vacuum-catching the dead ball.
  } else if (canControlBall && (player.hasBall || (ball.carrierId === player.id && distToBall < 25 && ball.z < 25))) {
    const freshGain = !player.hasBall;
    player.hasBall = true;
    ball.carrierId = player.id;
    ball.lastTouchTeam = player.team;
    ball.lastTouchPlayerId = player.id;
    if (freshGain) notePossessionGain(player);
    updateDribbleExposure(player, dt);

    // Dynamic ball carriage with stride touches and natural rolling
    const forwardDist = 13;
    const strideTouch = Math.max(0, Math.sin(player.animFrame * Math.PI)) * 2.6;
    const targetBallX = player.x + Math.cos(player.facingAngle) * (forwardDist + strideTouch);
    const targetBallY = player.y + Math.sin(player.facingAngle) * (forwardDist + strideTouch);

    // Smooth spring lerp for organic touch-and-run dribbling
    // Cap lerp at 0.35 to prevent snapping at high dt (2x/4x speed)
    const lerpX = Math.min(0.35, 14 * dt);
    const lerpY = Math.min(0.35, 14 * dt);
    ball.x += (targetBallX - ball.x) * lerpX;
    ball.y += (targetBallY - ball.y) * lerpY;
    // Lerp z toward foot height instead of overwriting (prevents z teleport)
    const footZ = Math.max(0, Math.sin(player.animFrame * Math.PI) * 2.2);
    ball.z += (footZ - ball.z) * Math.min(0.4, 14 * dt);
    ball.vx = player.vx;
    ball.vy = player.vy;
    ball.rotationAngle += Math.hypot(player.vx, player.vy) * dt * 0.055;

    // BRAIN: perceive -> think -> commit (see aiBrain.ts)
    const mem = getAwareness(player.id);
    const traits = playerTraits(player);
    const sit = snapshotSituation(player, ctx, targetGoal, targetDir);
    brainOnCarry(player, dt);

    mem.thinkCooldown -= dt;
    if (mem.thinkCooldown > 0) {
      // Between decisions keep carrying, steering around defenders.
      player.state = 'dribbling';
      const carry = carrySteer(player, ctx, targetGoal, targetDir, sit);
      moveToTarget(player, carry.x, carry.y, carry.speed, dt);
      return;
    }
    const view = perceiveCarrier(player, ctx);
    mem.thinkCooldown = thinkDelay(player, view);

    // One-two wall-pass return: teammate laid it off, play it back first-time.
    const wallPasser = consumeOneTwoReturn(player.id, allPlayers);
    if (wallPasser) {
      noteDecision(mem, 'pass', wallPasser.id);
      clearDribbleExposure(player);
      executePassVariant(player, wallPasser, 'one_two_return', ctx, targetDir, { underPressure: sit.underHeavyPressure });
      return;
    }

    // Every option (shoot / each pass / dribble heading / shield / clear) is
    // scored on one scale; the winner is picked with a soft-max.
    const choice = decideCarrier(player, ctx, targetGoal, targetDir, sit, view);

    if (choice.kind === 'shoot') {
      noteDecision(mem, 'shoot');
      clearDribbleExposure(player);
      const info = buildShooterInfo(player, ctx, targetGoal, sit, traits);
      executeShotVariant(player, targetGoal, pickShotVariant(player, ctx, targetGoal, sit, traits, info), ctx, info);
      return;
    }

    if (choice.kind === 'clear') {
      noteDecision(mem, 'clear');
      clearDribbleExposure(player);
      executeClearance(player, ctx, targetDir);
      return;
    }

    if (choice.kind === 'pass') {
      noteDecision(mem, 'pass', choice.mate.id);
      clearDribbleExposure(player);
      const variant: PassVariantArg = choice.hint === 'auto'
        ? pickPassVariant(player, choice.mate, ctx, targetDir, { underPressure: sit.underHeavyPressure })
        : choice.hint;
      executePassVariant(
        player, choice.mate, variant, ctx, targetDir,
        { underPressure: sit.underHeavyPressure },
        choice.at
      );
      return;
    }

    if (choice.kind === 'shield' && maybeShieldOrHoldUp(player, ctx, targetDir, sit, traits)) {
      noteDecision(mem, 'dribble');
      return;
    }

    // Dribble: a defender dead ahead invites a skill move; otherwise carry.
    if (view.frontOpp < 120 && maybeSkillOrShield(player, ctx, targetDir, sit, traits)) {
      noteDecision(mem, 'dribble');
      return;
    }
    noteDecision(mem, 'dribble');
    player.state = 'dribbling';
    const carry = carrySteer(player, ctx, targetGoal, targetDir, sit);
    moveToTarget(player, carry.x, carry.y, carry.speed, dt);
    return;
  }

  // 3. PLAYER DOES NOT HAVE THE BALL
  player.hasBall = false;
  brainOffBall(player, ctx);

  // Is ball loose or held by opponent?
  const teamHasBall = allPlayers.some(p => p.team === player.team && p.hasBall);
  const ballCarrier = allPlayers.find(p => p.hasBall);
  const ownGK = allPlayers.find(p => p.team === player.team && p.position === 'GK');

  // STRICT KEEPER EXCLUSION: Teammates must never crowd or cluster around own GK!
  // Velocity-based repel only (no position snap): nudge velocity upfield and
  // toward the sidelines; actual displacement happens via moveToTarget below.
  if (ownGK && dist(player.x, player.y, ownGK.x, ownGK.y) < 220) {
    const repelDir = targetDir;
    const desiredVx = repelDir * 160;
    const desiredVy = player.y > PITCH_WIDTH / 2 ? 70 : -70;
    const blend = Math.min(1, 5 * dt);
    player.vx += (desiredVx - player.vx) * blend * 0.6;
    player.vy += (desiredVy - player.vy) * blend * 0.6;
  }

  // All outfield teammates of this player (dismissed players are down the tunnel)
  const teammates = allPlayers.filter(p => p.team === player.team && p.position !== 'GK' && !p.sentOff);
  // Sort teammates by distance to the ball for tactical pressing roles
  const sortedTeammates = [...teammates].sort((a, b) => dist(a.x, a.y, ball.x, ball.y) - dist(b.x, b.y, ball.x, ball.y));
  const pressRank = sortedTeammates.findIndex(t => t.id === player.id);

  // Awareness helpers shared by off-ball attack and defense.
  const offBallMem = getAwareness(player.id);
  const offBallTraits = playerTraits(player);
  const isHomeSide = player.team === 'home';
  const offHomeScore = ctx.homeScore !== undefined ? ctx.homeScore : 0;
  const offAwayScore = ctx.awayScore !== undefined ? ctx.awayScore : 0;
  const offHasScore = ctx.homeScore !== undefined && ctx.awayScore !== undefined;
  const offScoreDiff = offHasScore ? (isHomeSide ? offHomeScore - offAwayScore : offAwayScore - offHomeScore) : 0;
  const offHasClock = ctx.matchMinutes !== undefined;
  const offMinutesLeft = offHasClock
    ? Math.max(0, 90 - ((ctx.matchMinutes as number) + (ctx.matchSeconds !== undefined ? (ctx.matchSeconds as number) : 0) / 60))
    : 45;
  const offChasingLate = offScoreDiff < 0 && offMinutesLeft <= 20;
  const offProtectingLate = offScoreDiff > 0 && offMinutesLeft <= 15;
  void offBallMem;

  // Check for slide tackle if close to opponent with ball (gated by press role + grit!)
  // Suppressed briefly after a throw-in so opponents retreat (2m rule).
  // Shot / pass-lane block contact on free, fast balls travelling nearby.
  if (checkBlockContact(player, ctx, ownGoal)) {
    return;
  }

  // Jockey / contain: hold position goal-side instead of diving in.
  const jockeyNow = shouldJockey(player, ctx, ownGoal, pressRank);

  const carrierBonus = ballCarrier && ballCarrier.team !== player.team ? dribbleRiskBonus(ballCarrier) : 0;
  const carrierPress = ballCarrier && ballCarrier.team !== player.team ? dribblePressMultiplier(ballCarrier) : 1;
  // Long carriers hold the ball out and invite the step-in: wider reach.
  const tackleRadius = (44 + offBallTraits.grit * 14) * (1 + carrierBonus * 0.9);
  // Long carriers are not jockeyed — defenders dive in (fix 4).
  const jockeyEffective = jockeyNow && carrierBonus < 0.12;
  if (!ctx.tackleSuppressed && !jockeyEffective && ballCarrier && ballCarrier.team !== player.team && distToBall < tackleRadius && player.tackleCooldown <= 0 && (pressRank === 0 || pressRank === 1)) {
    if (ballCarrier.position !== 'GK' || ballCarrier.state !== 'holding') {
      if (Math.random() < 0.55 + offBallTraits.grit * 0.45) {
        // Poke / toe tackle when tight or low on grit; slide tackle otherwise.
        if (distToBall < 34 && (offBallTraits.grit < 0.45 || Math.random() < 0.45)) {
          executePokeTackle(player, ballCarrier, ctx);
          maybeFoul(player, ballCarrier, ctx, 'poke', ownGoal);
        } else {
          executeTackle(player, ballCarrier, ctx);
          maybeFoul(player, ballCarrier, ctx, 'slide', ownGoal);
        }
        return;
      }
    }
  }

  // If loose ball within intercept reach (volley/header first-time finishes
  // off high balls, safety hoof when pressured deep, control variety on trap)
  const inOwnBox = ownGoal.x === 0 ? ball.x < 170 : ball.x > PITCH_LENGTH - 170;
  const keeperFar = !ownGK || dist(ownGK.x, ownGK.y, ball.x, ball.y) > 120;
  // Second-touch rule: blocked taker lets their own restart ball run.
  if (isSecondTouchBlocked(player, ball)) {
    // Fall through to off-ball positioning without collecting.
  } else if (!ballCarrier && distToBall < 26 && (!inOwnBox || keeperFar) && canControlBall) {
    const incomingSpeed = Math.hypot(ball.vx, ball.vy);
    // Height gate by context: fast balls must be near ground, slow balls can be higher
    // (prevents mid-air teleport pickup of lofted deliveries)
    const pickupZ = incomingSpeed > 300 ? 22 : 40;
    if (ball.z < pickupZ) {
      // Fast-moving balls can't be instantly controlled — require closer proximity
      // for high-speed balls so set piece deliveries actually fly before being claimed.
      const controlRadius = incomingSpeed > 300 ? 12 : 22;
      if (distToBall <= controlRadius) {
    const incomingZ = ball.z;
    if (tryFirstTimeFinish(player, ctx, targetGoal, incomingZ)) {
      return;
    }
    // Gain possession!
    player.hasBall = true;
    ball.carrierId = player.id;
    ball.lastTouchTeam = player.team;
    ball.lastTouchPlayerId = player.id;
    notePossessionGain(player);
    player.state = 'dribbling';
    // Clearance: safety-first hoof when pressured deep in our own box.
    if (inOwnBox) {
      let pressure = false;
      for (const o of allPlayers) {
        if (o.team !== player.team && dist(player.x, player.y, o.x, o.y) < 90) {
          pressure = true;
          break;
        }
      }
      if (pressure) {
        executeSafetyClearance(player, ctx, targetDir);
        return;
      }
    }
    applyReceiveTouch(player, ctx, incomingSpeed, incomingZ);
    return;
    } // end if (within control radius)
    } // end if (ball.z < pickupZ)
  }

  // Opponent GK has the ball: High line stance, wait at edge of final third, do not crowd 6-yard box
  if (ballCarrier && ballCarrier.position === 'GK' && ballCarrier.team !== player.team) {
    player.state = 'running';
    // ROUND 3 FIX: while the keeper holds the ball after a catch, opponents
    // must step back and give space (a few meters) instead of pressing —
    // back off whenever too close to the holder.
    if (ballCarrier.state === 'holding') {
      const holderDist = dist(player.x, player.y, ballCarrier.x, ballCarrier.y);
      if (holderDist < 160) {
        let away = Math.atan2(player.y - ballCarrier.y, player.x - ballCarrier.x);
        if (!Number.isFinite(away)) away = player.y < PITCH_WIDTH / 2 ? -Math.PI / 2 : Math.PI / 2;
        // Stand off toward midfield, a few meters out from the holder.
        const standX = Math.max(60, Math.min(PITCH_LENGTH - 60, ballCarrier.x + (targetDir === 1 ? 175 : -175)));
        const standY = Math.max(50, Math.min(PITCH_WIDTH - 50, ballCarrier.y + Math.sin(away) * 120));
        moveToTarget(player, standX, standY, player.stats.speed * 1.5, dt);
        return;
      }
    }
    const retreatBaseX = formationXOf(player, half);
    const retreatX = targetDir === 1
      ? Math.max(PITCH_LENGTH * 0.42, retreatBaseX - 40)
      : Math.min(PITCH_LENGTH * 0.58, retreatBaseX + 40);

    const isLonePresser = player.position === 'FW';
    if (isLonePresser) {
      // Stand off a few meters from the holder, toward midfield — never on top of him.
      const standOffX = ballCarrier.state === 'holding'
        ? Math.max(60, Math.min(PITCH_LENGTH - 60, ballCarrier.x + (targetDir === 1 ? 175 : -175)))
        : targetDir === 1 ? 190 : PITCH_LENGTH - 190;
      moveToTarget(player, standOffX, player.baseHomeY, player.stats.speed * 1.25, dt);
    } else {
      moveToTarget(player, retreatX, player.baseHomeY, player.stats.speed * 1.15, dt);
    }
    return;
  }

  // Own GK has the ball: SPREAD OUT AND FAN OUT! DO NOT CROWD THE GK!
  const ownGkHasBall = ballCarrier && ballCarrier.position === 'GK' && ballCarrier.team === player.team;
  if (ownGkHasBall) {
    player.state = 'running';
    let spreadX = formationXOf(player, half);
    let spreadY = player.baseHomeY;
    if (player.position === 'DF') {
      spreadX = ownGoal.x === 0 ? 290 : PITCH_LENGTH - 290;
      spreadY = player.number % 2 === 0 ? 80 : PITCH_WIDTH - 80; // Hug wide touchlines!
    } else if (player.position === 'MF') {
      spreadX = ownGoal.x === 0 ? PITCH_LENGTH * 0.48 : PITCH_LENGTH * 0.52;
      spreadY = player.number % 2 === 0 ? 110 : PITCH_WIDTH - 110; // Spread wide in midfield
    } else if (player.position === 'FW') {
      spreadX = targetDir === 1 ? PITCH_LENGTH * 0.74 : PITCH_LENGTH * 0.26;
      spreadY = player.number % 2 === 0 ? 140 : PITCH_WIDTH - 140; // Deep in opponent half
    }
    moveToTarget(player, spreadX, spreadY, player.stats.speed * 1.25, dt);
    return;
  }

  // AGGRESSIVE PRESSING LOGIC (When opponent has ball OR loose ball)
  if (!teamHasBall) {
    player.state = 'running';

    if (!ballCarrier) {
      // LOOSE BALL SCRAMBLE: only the two closest pressers pursue decisively.
      // ROUND 3 FIX: a second-touch-blocked taker never chases their own
      // restart — they hold shape and let a teammate collect it.
      if (pressRank <= 1 && !isSecondTouchBlocked(player, ball)) {
        const ip = interceptPoint(player, ctx, player.stats.speed * 1.65);
        moveToTarget(player, ip.x, ip.y, player.stats.speed * 1.65, dt);
        return;
      }
    } else {
      // OPPONENT HAS BALL: Press with calculated intensity. No free shots:
      // when the carrier is in shooting range the box gets protected —
      // primary closes down, secondary steps into the shooting lane.
      const carrierThreat = ballCarrier
        ? dist(ballCarrier.x, ballCarrier.y, ownGoal.center.x, ownGoal.center.y)
        : 999;
      const shotThreat = carrierThreat < 440;
      // ROUND 3 FIX: danger starts before shooting range — a carrier
      // advancing into our half is pressed, not watched from formation.
      const carrierDeep = ballCarrier
        ? targetDir === 1 ? ballCarrier.x < PITCH_LENGTH * 0.45 : ballCarrier.x > PITCH_LENGTH * 0.55
        : false;
      if (pressRank === 0) {
        // Primary Presser: jockey / contain goal-side when ordered.
        if (jockeyEffective && ballCarrier) {
          if ((player.state as string) !== 'jockeying') countVariety('defense:jockey');
          player.state = 'jockeying';
          player.stateTimer = 0;
          const jp = jockeyPoint(ballCarrier, ownGoal);
          moveToTarget(player, jp.x, jp.y, player.stats.speed * 1.35, dt);
          return;
        }
        // Primary Presser: Closes down carrier — harder when a shot is likely,
        // and harder still the longer the carrier holds it (fix 4).
        const leadX = ballCarrier.x + ballCarrier.vx * 0.18;
        const leadY = ballCarrier.y + ballCarrier.vy * 0.18;
        moveToTarget(player, leadX, leadY, player.stats.speed * (shotThreat ? 1.85 : 1.6) * carrierPress * pressBoost(player, ctx), dt);
        return;
      } else if (pressRank === 1 && (distToBall < 340 + carrierBonus * 500 || shotThreat || carrierDeep)) {
        // Secondary Presser: step into the shooting lane when the carrier
        // threatens our goal from anywhere inside shooting range.
        if (ballCarrier && carrierThreat < 440) {
          if ((player.state as string) !== 'blocking') countVariety('defense:shot_block');
          player.state = 'blocking';
          player.stateTimer = 0;
          const bp = shotBlockPoint(ballCarrier, ownGoal);
          moveToTarget(player, bp.x, bp.y, player.stats.speed * 1.5, dt);
          return;
        }
        // Secondary Presser: Traps carrier or blocks the pass lane.
        player.state = 'blocking';
        player.stateTimer = 0;
        const cutX = (ballCarrier.x + targetGoal.x) * 0.5;
        const cutY = ballCarrier.y;
        const interceptX = (ballCarrier.x * 0.7 + cutX * 0.3);
        const interceptY = (ballCarrier.y * 0.7 + cutY * 0.3);
        moveToTarget(player, interceptX, interceptY, player.stats.speed * 1.38, dt);
        return;
      } else if (pressRank === 2 && (shotThreat || carrierDeep) && ballCarrier) {
        // Tertiary cover: drops goal-side of the carrier to protect the box
        // while the first two press — no more empty penalty area.
        if ((player.state as string) !== 'blocking') countVariety('defense:box_cover');
        player.state = 'blocking';
        player.stateTimer = 0;
        const jp = jockeyPoint(ballCarrier, ownGoal);
        moveToTarget(player, jp.x, jp.y, player.stats.speed * 1.4, dt);
        return;
      }
    }

    // Track back / recovery run when beaten behind the ball in our third.
    const recovery = recoveryPoint(player, ctx, ownGoal, targetDir);
    if (recovery) {
      if ((player.state as string) !== 'running') countVariety('defense:recovery');
      player.state = 'running';
      moveToTarget(player, recovery.x, recovery.y, player.stats.speed * 1.6, dt);
      return;
    }

    // BRAIN: sticky goal-side marking with reaction lag, otherwise compact shape.
    const post = defensivePost(player, ctx, ownGoal, targetDir, ballCarrier ?? null, dropDeepShift(player.team, allPlayers));
    if (post.kind === 'mark') countVariety('defense:track_runner');
    player.state = post.state;
    if (post.state === 'jockeying') player.stateTimer = 0;
    moveToTarget(player, post.x, post.y, player.stats.speed * post.speedMul, dt);
    return;
  }

  // ATTACKING OFFENSIVE POSITIONING (teamHasBall): utility over off-ball runs.
  player.state = 'running';

  // Defenders with possession hold goal-side as safe outlets, spread wide.
  if (player.position === 'DF') {
    const carrier = ballCarrier;
    let outletX = formationXOf(player, half) + (ball.x / PITCH_LENGTH - 0.5) * 200 * targetDir;
    let outletY = player.baseHomeY < PITCH_WIDTH / 2 ? 90 : PITCH_WIDTH - 90;
    // Stay goal-side of the ball, never ahead of the carrier.
    if (carrier) {
      if (targetDir === 1) outletX = Math.min(outletX, carrier.x - 90);
      else outletX = Math.max(outletX, carrier.x + 90);
    }
    // Never crowd the carrier or the GK.
    if (carrier && dist(outletX, outletY, carrier.x, carrier.y) < 80) {
      outletY = outletY < PITCH_WIDTH / 2 ? 90 : PITCH_WIDTH - 90;
      outletX += targetDir === 1 ? -60 : 60;
    }
    if (ownGK && dist(outletX, outletY, ownGK.x, ownGK.y) < 150) {
      outletY = outletY < PITCH_WIDTH / 2 ? 90 : PITCH_WIDTH - 90;
    }
    if (offProtectingLate) outletX -= targetDir * 60;
    outletX -= targetDir * dropDeepShift(player.team, allPlayers);
    if (offChasingLate) outletX += targetDir * 40;
    outletX = Math.max(70, Math.min(PITCH_LENGTH - 70, outletX));
    outletY = Math.max(50, Math.min(PITCH_WIDTH - 50, outletY));
    moveToTarget(player, outletX, outletY, player.stats.speed * 1.22, dt);
    return;
  }

  // FW/MF: committed runs (behind / support / wide / box / shape) with spacing.
  const carrier = ballCarrier;
  if (carrier) {
    const run = attackRun(player, ctx, carrier, targetGoal, targetDir, {
      chasing: offChasingLate,
      protecting: offProtectingLate,
    });
    moveToTarget(player, run.x, run.y, run.speed, dt);
    return;
  }

  // Fallback: no carrier found despite teamHasBall flag.
  const ballXRatio = ball.x / PITCH_LENGTH;
  const offensiveShift = (ballXRatio - 0.5) * 280 * targetDir;
  let destX = formationXOf(player, half) + offensiveShift;
  let destY = player.baseHomeY;
  if (offChasingLate) destX += targetDir * 120;
  if (offProtectingLate) destX -= targetDir * 60;
  destX = Math.max(70, Math.min(PITCH_LENGTH - 70, destX));
  destY = Math.max(50, Math.min(PITCH_WIDTH - 50, destY));
  const runSpeedMultiplier = player.position === 'FW' ? 1.35 : 1.22;
  moveToTarget(player, destX, destY, player.stats.speed * runSpeedMultiplier, dt);
}

/**
 * Foul hook for completed tackle attempts: assess recklessness (from
 * behind, high speed, repeat offender, last-man denial), play advantage
 * when the fouled team keeps a promising attack, else queue the stoppage
 * for the engine to whistle.
 */
function maybeFoul(
  tackler: Player,
  victim: Player,
  ctx: AIUpdateContext,
  kind: 'slide' | 'poke',
  victimGoal: typeof RIGHT_GOAL
): void {
  if (tackler.sentOff || victim.sentOff) return;
  if (tackler.position === 'GK' || victim.position === 'GK') return;
  const speed = Math.hypot(tackler.vx, tackler.vy);
  const assessment = assessTackle(
    tackler,
    victim,
    ctx.ball,
    ctx.allPlayers,
    {
      fromBehind: tackleFromBehind(tackler, victim),
      highSpeed: speed > 420,
      tackleKind: kind,
    },
    victimGoal,
    ctx.half
  );
  if (assessment.decision === 'play_on') return;
  tackler.foulCount = (tackler.foulCount ?? 0) + 1;
  if (assessment.decision === 'advantage') {
    countVariety('ref:advantage_note');
    ctx.addCommentary(
      `${victim.name} is chopped down by ${tackler.name} — ADVANTAGE, play on!`,
      'info',
      victim.team
    );
    return;
  }
  raiseFoulEvent(tackler, victim, assessment);
}

/**
 * Goalkeeper AI behavior with authentic Mini Soccer Keep / Hold logic
 */
function updateGoalkeeperAI(
  gk: Player,
  ctx: AIUpdateContext,
  ownGoal: typeof LEFT_GOAL,
  targetDir: number
): void {
  const { dt, ball, allPlayers } = ctx;
  const defendsLeftSide = ownGoal.x === 0;
  keeperTick(gk, dt);

  // 1. GOALKEEPER IS IN POSSESSION: hold it, step out, then distribute
  // contextually (roll / overarm / drop-kick / long / goal-kick variants).
  if (gk.state === 'holding' || gk.hasBall || ball.carrierId === gk.id) {
    gk.state = 'holding';
    gk.hasBall = true;
    ball.carrierId = gk.id;

    // Firm, steady grip in hands at chest level (NO bouncing!)
    ball.x = gk.x + (defendsLeftSide ? 12 : -12);
    ball.y = gk.y;
    ball.z = 14;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;

    // Step forward toward edge of box while scanning open spaces
    const forwardX = defendsLeftSide ? 80 : PITCH_LENGTH - 80;
    moveToTarget(gk, forwardX, PITCH_WIDTH / 2, 36, dt);

    // Snappy distribution: release within 0.45s so match flow stays fast!
    // BUT: check for nearby opponents first — don't throw into pressure
    if (gk.stateTimer > 0.45) {
      // Count nearby opponents
      let nearbyOpponents = 0;
      for (const o of allPlayers) {
        if (o.team !== gk.team && !o.sentOff && dist(o.x, o.y, gk.x, gk.y) < 120) {
          nearbyOpponents++;
        }
      }
      // If pressured, wait a bit longer (up to 1.2s) for space, or go long
      const pressured = nearbyOpponents >= 2;
      const maxWait = pressured ? 1.2 : 0.45;
      if (gk.stateTimer > maxWait || !pressured) {
        // When pressured, force long distribution (safer)
        executeKeeperDistribution(gk, pickKeeperDistribution(gk, ctx, targetDir, pressured), ctx, targetDir);
      }
      // Else: keep holding, wait for space
    }
    return;
  }

  // 2. SHOT RESPONSE COMES FIRST. A shot into the box is NOT a loose ball: read
  // where it is going, react, slide to that line, and make the save when it arrives.
  const plan = planShotResponse(gk, ctx, ownGoal);
  if (plan.kind === 'save') {
    let crowd = 0;
    for (const o of allPlayers) {
      if (o.team !== gk.team && !o.sentOff && dist(o.x, o.y, ball.x, ball.y) < 80) crowd++;
    }
    const facts = buildShotFacts(ball, ownGoal, crowd, plan.gap);
    executeKeeperSave(gk, pickKeeperSave(gk, facts), facts, ctx, ownGoal);
    return;
  }
  if (plan.kind === 'move') {
    gk.facingAngle = Math.atan2(ball.y - gk.y, ball.x - gk.x);
    moveToTarget(gk, plan.x, plan.y, plan.speed, dt);
    return;
  }

  // 3. PENALTY BOX LOOSE BALL GATHERING — inside (or at the very edge of)
  // the box only. Outside it the keeper holds position and never chases.
  const boxMargin = 15;
  const boxTop = (PITCH_WIDTH - PENALTY_BOX_WIDTH) / 2 - boxMargin;
  const boxBottom = (PITCH_WIDTH + PENALTY_BOX_WIDTH) / 2 + boxMargin;
  const inPenaltyBoxX = defendsLeftSide
    ? ball.x >= -boxMargin && ball.x <= PENALTY_BOX_LENGTH + boxMargin
    : ball.x >= PITCH_LENGTH - PENALTY_BOX_LENGTH - boxMargin && ball.x <= PITCH_LENGTH + boxMargin;
  const inPenaltyBoxY = ball.y >= boxTop && ball.y <= boxBottom;
  const isLooseInBox = inPenaltyBoxX && inPenaltyBoxY && ball.carrierId === null;

  // Keeper only gathers if not on catchCooldown (never right after distributing!).
  // Second-touch rule also applies to a goal-kick taker keeper (fix 1).
  const keeperBlocked = ball.secondTouchBlockId != null && ball.secondTouchBlockId === gk.id;
  if (isLooseInBox && (!gk.catchCooldown || gk.catchCooldown <= 0) && !keeperBlocked) {
    const distToBall = dist(gk.x, gk.y, ball.x, ball.y);
    if (distToBall < 32 && ball.z < 35) {
      // Gather and keep!
      gk.state = 'holding';
      gk.stateTimer = 0;
      gk.hasBall = true;
      notePossessionGain(gk);
      ball.carrierId = gk.id;
      ball.vx = 0;
      ball.vy = 0;
      ball.vz = 0;
      ball.z = 14;

      soundEngine.playSave();
      ctx.addCommentary(`${gk.name} gathers the loose ball securely in the box!`, 'save', gk.team);
      return;
    } else {
      // Rush to secure the loose ball — clamped inside the box, never chasing out.
      const chaseX = defendsLeftSide
        ? Math.max(15, Math.min(PENALTY_BOX_LENGTH + 10, ball.x))
        : Math.max(PITCH_LENGTH - PENALTY_BOX_LENGTH - 10, Math.min(PITCH_LENGTH - 15, ball.x));
      const chaseY = Math.max(boxTop + boxMargin, Math.min(boxBottom - boxMargin, ball.y));
      moveToTarget(gk, chaseX, chaseY, gk.stats.speed * 1.2, dt);
      return;
    }
  }

  // 3. 1v1 SMOTHER: rushed out — fling the body at the carrier's feet.
  const through = isOneVOne(gk, ctx, ownGoal);
  if (through) {
    if (dist(gk.x, gk.y, through.x, through.y) <= 52) {
      if (trySmother(gk, through, ctx)) return;
    } else {
      const rush = decideKeeperStance(gk, ctx, ownGoal);
      moveToTarget(gk, rush.targetX, rush.targetY, gk.stats.speed * 1.2 * rush.speedScale, dt);
      return;
    }
  }

  // 4a. SHOT STOPPING: goal-bound and in range — pick the technique by
  // pace / placement / height / distance, gated by reflexes.
  // ROUND 3 FIX (long shots): the keeper must ATTEMPT every shot on target
  // regardless of distance — predict the trajectory, track it across the
  // goalmouth, and dive when it comes in reach. It may still go in, but the
  // keeper never stands and watches.
  const ballSpeedNow = Math.hypot(ball.vx, ball.vy);
  const towardOwnGoal = defendsLeftSide ? ball.vx < -60 : ball.vx > 60;
  let predictedOnTarget = false;
  let predictedY = ownGoal.center.y;
  if (ball.carrierId === null && towardOwnGoal && ballSpeedNow > 150 && ball.z < 110) {
    const tGoal = (ownGoal.center.x - ball.x) / ball.vx;
    if (tGoal > 0 && tGoal < 4) {
      predictedY = ball.y + ball.vy * tGoal;
      predictedOnTarget = Math.abs(predictedY - ownGoal.center.y) <= GOAL_WIDTH / 2 + 40;
    }
  }
  const shotIncoming = ball.carrierId === null && towardOwnGoal && predictedOnTarget;
  const distToBall = dist(gk.x, gk.y, ball.x, ball.y);

  // Track the trajectory early: shuffle across the line toward the predicted
  // arrival point so the keeper visibly reacts even to midfield efforts.
  if (shotIncoming && gk.state !== 'diving' && distToBall >= 54) {
    const trackY = Math.max(ownGoal.yMin + 10, Math.min(ownGoal.yMax - 10, predictedY));
    const trackX = defendsLeftSide ? 52 : PITCH_LENGTH - 52;
    moveToTarget(gk, trackX, trackY, gk.stats.speed * 1.65, dt);
  }

  if (shotIncoming && distToBall < 54 && gk.state !== 'diving') {
    // Mortal reach: well-placed shots outside the keeper's core radius fly past.
    let crowd = 0;
    for (const o of allPlayers) {
      if (o.team !== gk.team && !o.sentOff && dist(o.x, o.y, ball.x, ball.y) < 80) crowd++;
    }
    const facts = buildShotFacts(ball, ownGoal, crowd);
    executeKeeperSave(gk, pickKeeperSave(gk, facts), facts, ctx, ownGoal);
    return;
  }

  // 5. CLAIM THE CROSS on contact (catch when calm, punch when crowded).
  if (tryClaimCross(gk, ctx)) return;

  // 4b. DESPERATE LUNGE: beaten positionally but a low, fast ball is within
  // lunging range — fling a glove at it instead of standing frozen. The
  // reflex gate decides whether it sticks (distance already adds difficulty).
  // Range capped at ~72 (a real lunge) so the keeper never deflects a ball
  // that hasn't visually reached their sprite.
  if (shotIncoming && gk.state !== 'diving' && (!gk.catchCooldown || gk.catchCooldown <= 0)) {
    const ballSpeed = Math.hypot(ball.vx, ball.vy);
    if (distToBall >= 54 && distToBall < 72 && ball.z < 60 && ballSpeed > 150) {
      let crowd = 0;
      for (const o of allPlayers) {
        if (o.team !== gk.team && !o.sentOff && dist(o.x, o.y, ball.x, ball.y) < 80) crowd++;
      }
      const facts = buildShotFacts(ball, ownGoal, crowd);
      executeKeeperSave(gk, pickKeeperSave(gk, facts), facts, ctx, ownGoal);
      return;
    }
  }

  // 6. POSITIONING: a valid stance decision fires EVERY tick — set on the
  // line, shuffle with the ball, hold vs claim. The keeper never idles
  // without a stance; movement state tracks the decision so there is no
  // stuck standing state.
  const stance = decideKeeperStance(gk, ctx, ownGoal);
  let tx = stance.targetX;
  let ty = stance.targetY;
  let speedScale = stance.speedScale;
  if (stance.stance === 'set' || stance.stance === 'shuffle') {
    const pos = keeperPosition(gk, ctx, ownGoal);
    tx = pos.x;
    ty = pos.y;
    speedScale = pos.speedScale;
  }
  if (gk.state === 'idle' || gk.state === 'running') {
    gk.state = dist(gk.x, gk.y, tx, ty) > 10 ? 'running' : 'idle';
  }
  moveToTarget(gk, tx, ty, gk.stats.speed * 1.1 * speedScale, dt);
}

/**
 * Mirror a tackle clearance back infield when it would otherwise fly straight
 * out over a sideline (priority) or behind for a needless corner. Mirroring
 * preserves speed, drama, and effects — only the direction is fixed.
 */
function biasTackleClearanceInfield(ball: Ball): void {
  // Sidelines: y=0 (top) and y=PITCH_WIDTH (bottom) — must head infield.
  if (ball.y < 120 && ball.vy < 0) {
    ball.vy = -ball.vy;
  } else if (ball.y > PITCH_WIDTH - 120 && ball.vy > 0) {
    ball.vy = -ball.vy;
  }
  // Endlines: avoid blasting behind for needless corners when trivial.
  if (ball.x < 120 && ball.vx < 0) {
    ball.vx = -ball.vx;
  } else if (ball.x > PITCH_LENGTH - 120 && ball.vx > 0) {
    ball.vx = -ball.vx;
  }
}

/**
 * Slide tackle execution
 */
function executeTackle(
  player: Player,
  carrier: Player,
  ctx: AIUpdateContext
): void {
  const { allPlayers, ball, stats, addEffect, addCommentary } = ctx;

  // Capture pre-lunge pace for hard-tackle detection (high speed => fall).
  const tacklerSpeedBefore = Math.hypot(player.vx, player.vy);
  const carrierSpeed = Math.hypot(carrier.vx, carrier.vy);
  const hardFromBehind = tackleFromBehind(player, carrier);

  player.state = 'tackling';
  player.stateTimer = 0;
  player.tackleCooldown = 0.8; // Aggressive quick turnaround for intense contests
  player.catchCooldown = 0.75; // Cannot instantly catch ball while sliding!

  // Push player forward along tackle angle with explosive burst
  const tackleAngle = Math.atan2(carrier.y - player.y, carrier.x - player.x);
  player.facingAngle = tackleAngle;
  player.vx = Math.cos(tackleAngle) * 320;
  player.vy = Math.sin(tackleAngle) * 320;

  soundEngine.playTackle();

  // Tackle impact puff (dust, no sparkle)
  addEffect({
    id: `clash-${Date.now()}-${Math.random()}`,
    type: 'dust',
    x: carrier.x,
    y: carrier.y,
    z: 10,
    life: 0,
    maxLife: 0.38,
  });

  // Check tackle success based on defense vs technique, plus escalating
  // risk the longer the carrier holds it (fix 4: through-the-team punished).
  const baseChance = (player.stats.defense * 1.15) / (player.stats.defense + carrier.stats.technique);
  const successChance = Math.min(0.95, baseChance + dribbleRiskBonus(carrier));
  if (Math.random() < successChance) {
    // Successful tackle!
    carrier.hasBall = false;
    clearDribbleExposure(carrier);
    ball.carrierId = null;
    // Hard sliding tackle => victim FALLS prone (lying down, ~1.0s).
    // executeTackle is always a sliding lunge, which counts as hard per
    // spec (high speed / from-behind also qualify when present).
    const isSlideTackle = true;
    const isHardTackle =
      isSlideTackle || tacklerSpeedBefore > 420 || carrierSpeed > 320 || hardFromBehind;
    void allPlayers;
    if (isHardTackle) {
      knockProne(carrier, ctx);
    } else {
      carrier.state = 'sliding'; // Dispossessed carrier stumbles/slides!
      carrier.stateTimer = 0;
      carrier.catchCooldown = 0.9; // Carrier cannot instantly re-catch either!
    }
    frustrateAfterFoul(carrier, ctx);

    if (player.team === 'home') stats.homeTackles++;
    else stats.awayTackles++;

    const roll = Math.random();
    if (roll < 0.48) {
      // 1. HUGE SLIDING CLEARANCE: Blasts the ball far away!
      const farAngle = tackleAngle + (Math.random() - 0.5) * 0.8;
      const farSpeed = 600 + Math.random() * 200; // 600 - 800 px/s!
      ball.vx = Math.cos(farAngle) * farSpeed;
      ball.vy = Math.sin(farAngle) * farSpeed;
      biasTackleClearanceInfield(ball);
      ball.vz = 80 + Math.random() * 90; // High lofted arc clearing the ball far away!

      soundEngine.playKick(0.9);
      addEffect({
        id: `clear-${Date.now()}`,
        type: 'dust',
        x: ball.x,
        y: ball.y,
        z: 0,
        life: 0,
        maxLife: 0.4,
      });

      addCommentary(`CRUNCHING SLIDE by ${player.name}! Blasts the ball far down the pitch!`, 'tackle', player.team);
    } else if (roll < 0.82) {
      // 2. DEFLECTED 50/50 LOOSE BALL: Ricochets briskly away creating a scramble
      const looseAngle = tackleAngle + (Math.random() - 0.5) * 1.9;
      const looseSpeed = 340 + Math.random() * 120;
      ball.vx = Math.cos(looseAngle) * looseSpeed;
      ball.vy = Math.sin(looseAngle) * looseSpeed;
      biasTackleClearanceInfield(ball);
      ball.vz = 45 + Math.random() * 40;

      addCommentary(`Fierce sliding tackle by ${player.name}! The ball ricochets into open space!`, 'tackle', player.team);
    } else {
      // 3. CLEAN TACKLE HOOK: Pokes ball near tackler
      const pokeSpeed = 160 + Math.random() * 60;
      ball.vx = Math.cos(tackleAngle) * pokeSpeed;
      ball.vy = Math.sin(tackleAngle) * pokeSpeed;
      ball.vz = 20;
      player.catchCooldown = 0.4; // Can collect once recovering from slide

      addCommentary(`Superb sliding tackle by ${player.name}! Dispossesses ${carrier.name}!`, 'tackle', player.team);
    }
  }
}

/**
 * Shoot on goal execution with realistic variations (On target, Skies over bar, Drifts wide, or Woodwork hit)
 */
function executeShot(
  player: Player,
  targetGoal: typeof RIGHT_GOAL,
  ctx: AIUpdateContext
): void {
  const { ball, stats, addEffect, addCommentary } = ctx;

  player.hasBall = false;
  ball.carrierId = null;
  player.state = 'kicking';
  player.stateTimer = 0;

  const isHome = player.team === 'home';
  if (isHome) stats.homeShots++;
  else stats.awayShots++;

  const roll = Math.random();
  let aimY: number;
  let aimZ: number;

  if (roll < 0.55) {
    // 1. Clean Shot On Target (corners of the net)
    if (isHome) stats.homeShotsOnTarget++;
    else stats.awayShotsOnTarget++;

    const pickUpperOrLower = Math.random() > 0.5;
    aimY = pickUpperOrLower ? targetGoal.yMin + 20 : targetGoal.yMax - 20;
    aimZ = Math.random() > 0.5 ? 12 : GOAL_HEIGHT - 12;
    addCommentary(`VENOMOUS STRIKE by ${player.name}! Blasts toward the corner!`, 'shot', player.team);
  } else if (roll < 0.74) {
    // 2. High Over Crossbar / Top Edge
    aimY = targetGoal.yMin + Math.random() * GOAL_WIDTH;
    aimZ = GOAL_HEIGHT + 22 + Math.random() * 35; // Skies over the top bar!
    addCommentary(`${player.name} skies it! The shot flies high over the crossbar!`, 'shot', player.team);
  } else if (roll < 0.93) {
    // 3. Wide of the Post
    aimY = Math.random() > 0.5 ? targetGoal.yMin - 40 : targetGoal.yMax + 40; // Drifts wide!
    aimZ = 10 + Math.random() * 30;
    addCommentary(`${player.name} curls a shot, but it whistles wide of the post!`, 'shot', player.team);
  } else {
    // 4. Woodwork / Crossbar / Post Hit!
    if (Math.random() > 0.5) {
      // Crossbar
      aimY = targetGoal.yMin + Math.random() * GOAL_WIDTH;
      aimZ = GOAL_HEIGHT;
    } else {
      // Post
      aimY = Math.random() > 0.5 ? targetGoal.yMin : targetGoal.yMax;
      aimZ = 20 + Math.random() * 30;
    }
    soundEngine.playPostHit();
    addCommentary(`${player.name} RATTLES THE WOODWORK! A thunderous strike off the post!`, 'shot', player.team);
  }

  const angle = Math.atan2(aimY - player.y, targetGoal.x - player.x);
  player.facingAngle = angle;

  // Blistering shot speed!
  const power = 440 + player.stats.kick * 3.2;
  ball.vx = Math.cos(angle) * power;
  ball.vy = Math.sin(angle) * power;
  ball.vz = aimZ * 2.5;

  soundEngine.playKick(0.95);

  addEffect({
    id: `shot-${Date.now()}`,
    type: 'dust',
    x: player.x,
    y: player.y,
    z: 0,
    life: 0,
    maxLife: 0.35,
  });
}

/**
 * Pass to open teammate (Mini soccer rules - fast pace & zip!)
 */
function executePass(
  player: Player,
  teammate: Player,
  ctx: AIUpdateContext
): void {
  const { ball, stats, addEffect, addCommentary } = ctx;

  player.hasBall = false;
  ball.carrierId = null;
  player.state = 'kicking';
  player.stateTimer = 0;

  if (player.team === 'home') stats.homePasses++;
  else stats.awayPasses++;

  // Lead the pass ahead of teammate
  const leadX = teammate.x + teammate.vx * 0.35;
  const leadY = teammate.y + teammate.vy * 0.35;

  const angle = Math.atan2(leadY - player.y, leadX - player.x);
  player.facingAngle = angle;

  const distance = dist(player.x, player.y, leadX, leadY);
  // Crisp ball zip!
  const passSpeed = Math.min(620, Math.max(340, distance * 3.0));

  ball.vx = Math.cos(angle) * passSpeed;
  ball.vy = Math.sin(angle) * passSpeed;
  ball.vz = distance > 220 ? 50 : 10; // Crisp ground pass with low chip if long

  soundEngine.playKick(0.6);

  addEffect({
    id: `pass-${Date.now()}`,
    type: 'dust',
    x: player.x,
    y: player.y,
    z: 0,
    life: 0,
    maxLife: 0.25,
  });

  addCommentary(`${player.name} slides a pass to ${teammate.name}!`, 'pass', player.team);
}

/**
 * Clearance under pressure: defenders hoof it long upfield with loft.
 */
function executeClearance(
  player: Player,
  ctx: AIUpdateContext,
  targetDir: number
): void {
  const { ball, stats, addEffect, addCommentary } = ctx;

  player.hasBall = false;
  ball.carrierId = null;
  player.state = 'kicking';
  player.stateTimer = 0;

  if (player.team === 'home') stats.homePasses++;
  else stats.awayPasses++;

  const clearDist = 340 + Math.random() * 160;
  let aimX = player.x + targetDir * clearDist;
  aimX = Math.max(60, Math.min(PITCH_LENGTH - 60, aimX));
  let aimY =
    PITCH_WIDTH / 2 +
    (player.y - PITCH_WIDTH / 2) * 0.35 +
    (Math.random() - 0.5) * 140;
  aimY = Math.max(60, Math.min(PITCH_WIDTH - 60, aimY));

  const angle = Math.atan2(aimY - player.y, aimX - player.x);
  player.facingAngle = angle;

  const power = 580 + Math.random() * 120 + player.stats.kick * 0.6;
  ball.vx = Math.cos(angle) * power;
  ball.vy = Math.sin(angle) * power;
  ball.vz = 130 + Math.random() * 60;

  soundEngine.playKick(0.85);

  addEffect({
    id: `clear-${Date.now()}`,
    type: 'dust',
    x: player.x,
    y: player.y,
    z: 0,
    life: 0,
    maxLife: 0.35,
  });

  addCommentary(`${player.name} hoofs it clear under pressure!`, 'pass', player.team);
}

/**
 * Lofted cross from a wide attacker to a teammate inside the box.
 */
function executeCross(
  player: Player,
  teammate: Player,
  ctx: AIUpdateContext
): void {
  const { ball, stats, addEffect, addCommentary } = ctx;

  player.hasBall = false;
  ball.carrierId = null;
  player.state = 'kicking';
  player.stateTimer = 0;

  if (player.team === 'home') stats.homePasses++;
  else stats.awayPasses++;

  const leadX = teammate.x + teammate.vx * 0.4;
  const leadY = teammate.y + teammate.vy * 0.4;

  const angle = Math.atan2(leadY - player.y, leadX - player.x);
  player.facingAngle = angle;

  const distance = dist(player.x, player.y, leadX, leadY);
  const crossSpeed = Math.min(640, Math.max(420, distance * 3.2));

  ball.vx = Math.cos(angle) * crossSpeed;
  ball.vy = Math.sin(angle) * crossSpeed;
  ball.vz = 95 + Math.random() * 50;

  soundEngine.playKick(0.75);

  addEffect({
    id: `cross-${Date.now()}`,
    type: 'dust',
    x: player.x,
    y: player.y,
    z: 0,
    life: 0,
    maxLife: 0.3,
  });

  addCommentary(`${player.name} whips in a cross for ${teammate.name}!`, 'pass', player.team);
}



/**
 * Dynamic physics-based steering:
 * - Natural acceleration and momentum (curving into turns rather than snapping)
 * - Deceleration when approaching target destination (arrival steering)
 * - Smooth body facing angle interpolation (organic turning radius)
 * - Animated stride cycles scaled to real ground speed
 */
function moveToTarget(player: Player, tx: number, ty: number, targetMaxSpeed: number, dt: number): void {
  const dx = tx - player.x;
  const dy = ty - player.y;
  const d = Math.hypot(dx, dy);

  if (d > 3) {
    // 1. Arrival Deceleration: smooth easing into destination (within 22 units)
    const arrivalFactor = Math.min(1, d / 22);
    const desiredSpeed = targetMaxSpeed * arrivalFactor;

    const desiredVx = (dx / d) * desiredSpeed;
    const desiredVy = (dy / d) * desiredSpeed;

    // 2. Physical Acceleration & Steering Force (Momentum & Inertia)
    const accelRate = 7.5;
    player.vx += (desiredVx - player.vx) * Math.min(1, accelRate * dt);
    player.vy += (desiredVy - player.vy) * Math.min(1, accelRate * dt);

    player.x += player.vx * dt;
    player.y += player.vy * dt;

    const currentSpeed = Math.hypot(player.vx, player.vy);

    // 3. Smooth Body Rotation (Facing Angle) with natural turning radius
    if (currentSpeed > 6) {
      const targetAngle = Math.atan2(player.vy, player.vx);
      let angleDiff = targetAngle - player.facingAngle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      const turnSpeed = 9.0;
      player.facingAngle += angleDiff * Math.min(1, turnSpeed * dt);
    }

    // 4. Stride animation speed proportional to real movement velocity
    player.animFrame += dt * (currentSpeed * 0.075);
  } else {
    // Smooth deceleration / friction when arriving at destination
    const friction = Math.pow(0.08, dt * 6);
    player.vx *= friction;
    player.vy *= friction;
    player.x += player.vx * dt;
    player.y += player.vy * dt;
  }
}


