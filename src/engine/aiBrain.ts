/**
 * aiBrain.ts: the "mind" layer for outfield players.
 *
 * Why the old AI felt scripted, and what replaces it:
 *  - Decisions were noise + fixed gates (Math.random() < 0.45 ...).
 *    -> every option (shoot / each pass / dribble heading / shield / clear) is now
 *       scored on ONE scale: success chance x value - failure chance x cost,
 *       then picked with a soft-max so good players are consistent and
 *       nervous ones are not.
 *  - Carriers ran in a straight line at goal.
 *    -> carriers steer a fan of headings around predicted defender positions.
 *  - Off-ball scores were re-rolled every frame (jitter).
 *    -> players pick a run, COMMIT to it for ~1-2s, and re-plan only when it
 *       becomes invalid. Teammates repel each other's targets (spacing).
 *  - Omniscient perception.
 *    -> carriers have a field of view, scan over the shoulder, and can be
 *       surprised by a defender arriving from the blind side.
 *  - No personality or mood.
 *    -> stable per-player persona + a confidence value that moves with
 *       good/bad passes and lost balls.
 *  - Defenders only chased the ball.
 *    -> sticky goal-side marking with reaction lag, compact shape toward the
 *       ball, counter-press after losing it, and ball-path interception.
 */

import type { Player, TeamSide } from '../types/soccer';
import type { AIUpdateContext } from './ai';
import { dist, LEFT_GOAL, PITCH_LENGTH, PITCH_WIDTH, RIGHT_GOAL } from './physics';
import { attackDirFor, formationXOf, ownGoalFor } from './sides';
import type { HalfLike } from './sides';
import {
  findBackOutlet,
  findBoxTarget,
  findLobbedThroughRunner,
  findSwitchTarget,
  findWallMate,
} from './actionVariety';
import { findReadyThroughRunner, readPass } from './awareness';

type Goal = typeof RIGHT_GOAL;

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Distance from a point to a segment, plus where along the segment (0..1) it projects. */
function segInfo(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): { d: number; t: number } {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return { d: dist(px, py, x1, y1), t: 0 };
  const t = clamp(((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2, 0, 1);
  return { d: dist(px, py, x1 + t * (x2 - x1), y1 + t * (y2 - y1)), t };
}

function norm01(s: number): number {
  return clamp01((s - 50) / 50);
}

// ---------------------------------------------------------------------------
// World clock (the engine calls updatePlayerAI once per player per frame)
// ---------------------------------------------------------------------------

let worldTime = 0;
let worldFrame = 0;
let callsThisFrame = 0;

/** Call once at the top of updatePlayerAI for every player (including GK). */
export function brainTick(ctx: AIUpdateContext): void {
  callsThisFrame++;
  if (callsThisFrame >= Math.max(1, ctx.allPlayers.length)) {
    callsThisFrame = 0;
    worldTime += ctx.dt;
    worldFrame++;
  }
}

// ---------------------------------------------------------------------------
// Persona (stable personality) and Mind (short-term memory + mood)
// ---------------------------------------------------------------------------

export interface Persona {
  vision: number;     // how well they scan / how far they see options
  composure: number;  // consistency of decisions under pressure
  selfish: number;    // appetite to shoot/dribble instead of pass
  bravery: number;    // tolerance of tight situations, closes down harder
  workRate: number;   // pressing / recovery intensity
  reaction: number;   // seconds between decisions
}

type PassHint = 'auto' | 'through_ball' | 'lobbed_through' | 'back_pass' | 'switch' | 'one_two';

interface Intent {
  kind: 'behind' | 'support' | 'wide' | 'box' | 'shape';
  x: number;
  y: number;
  until: number;
  carrierId: string;
  carrierX: number;
  carrierY: number;
}

interface Mind {
  persona: Persona;
  confidence: number;
  hadBall: boolean;
  possessionSince: number;
  lastScan: number;
  nextScan: number;
  heading: number | null;
  recent: string[];
  thought: string;
  intent: Intent | null;
  markId: string | null;
  markPos: { x: number; y: number; at: number } | null;
}

const minds = new Map<string, Mind>();

function hash01(id: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 10000) / 10000;
}

function buildPersona(p: Player): Persona {
  const tech = norm01(p.stats.technique);
  const spd = norm01(p.stats.speed);
  const def = norm01(p.stats.defense);
  const kick = norm01(p.stats.kick);
  const vision = clamp01(0.22 + tech * 0.5 + hash01(p.id, 1) * 0.28);
  return {
    vision,
    composure: clamp01(0.28 + tech * 0.3 + def * 0.1 + hash01(p.id, 2) * 0.32),
    selfish: clamp01(0.12 + kick * 0.3 + (p.position === 'FW' ? 0.18 : 0) + hash01(p.id, 3) * 0.4),
    bravery: clamp01(0.28 + def * 0.3 + hash01(p.id, 4) * 0.42),
    workRate: clamp01(0.3 + spd * 0.25 + hash01(p.id, 5) * 0.45),
    reaction: 0.3 - vision * 0.15,
  };
}

function getMind(p: Player): Mind {
  let m = minds.get(p.id);
  if (!m) {
    m = {
      persona: buildPersona(p),
      confidence: 0.5,
      hadBall: false,
      possessionSince: 0,
      lastScan: -99,
      nextScan: Math.random() * 1.5,
      heading: null,
      recent: [],
      thought: '',
      intent: null,
      markId: null,
      markPos: null,
    };
    minds.set(p.id, m);
  }
  return m;
}

/** Debug: what is this player thinking right now? (draw it over their head) */
let lastTrace: Array<{ why: string; ev: number }> = [];
/** Debug: every option the last carrier decision weighed, with its score. */
export function getDecisionTrace(): Array<{ why: string; ev: number }> {
  return lastTrace;
}

/** Call at kick-off / after a goal to wipe moods, runs and marks. */
export function resetBrain(): void {
  minds.clear();
  cachedFrame = null;
  lastPass = null;
  possession.team = null;
  possession.gainAt = { home: -99, away: -99 };
  possession.lossAt = { home: -99, away: -99 };
}

export function getThought(id: string): string {
  return minds.get(id)?.thought ?? '';
}

// ---------------------------------------------------------------------------
// Per-frame team view (cached): possession, offside lines, transitions
// ---------------------------------------------------------------------------

interface TeamView {
  dir: 1 | -1;
  outfield: Player[];
  opponents: Player[];
  offsideLine: number;
  hasBall: boolean;
}

interface FrameView {
  frame: number;
  carrier: Player | null;
  home: TeamView;
  away: TeamView;
}

const possession: {
  team: TeamSide | null;
  gainAt: Record<TeamSide, number>;
  lossAt: Record<TeamSide, number>;
} = { team: null, gainAt: { home: -99, away: -99 }, lossAt: { home: -99, away: -99 } };

interface PassEvent { passerId: string; team: TeamSide; at: number; open: boolean }
let lastPass: PassEvent | null = null;

let cachedFrame: FrameView | null = null;

function buildTeamView(ctx: AIUpdateContext, side: TeamSide, carrier: Player | null): TeamView {
  // Half-time side switching: attack direction flips after the break.
  const dir: 1 | -1 = attackDirFor(side, ctx.half);
  const outfield = ctx.allPlayers.filter(p => p.team === side && !p.sentOff && p.position !== 'GK');
  const opponentsAll = ctx.allPlayers.filter(p => p.team !== side && !p.sentOff);
  const opponents = opponentsAll.filter(p => p.position !== 'GK');
  // Offside line = second-last opponent (GK counts) but never behind halfway.
  const xs = opponentsAll.map(p => p.x * dir).sort((a, b) => b - a);
  const second = xs.length >= 2 ? xs[1] : xs.length === 1 ? xs[0] : PITCH_LENGTH / 2;
  const half = (PITCH_LENGTH / 2) * dir;
  const lineProgress = dir === 1 ? Math.max(second, half) : Math.max(second, -half);
  return {
    dir,
    outfield,
    opponents,
    offsideLine: lineProgress * dir,
    hasBall: !!carrier && carrier.team === side,
  };
}

function getFrame(ctx: AIUpdateContext): FrameView {
  if (cachedFrame && cachedFrame.frame === worldFrame) return cachedFrame;
  const carrier = ctx.allPlayers.find(p => p.hasBall && !p.sentOff) ?? null;
  if (carrier && possession.team !== carrier.team) {
    const prev = possession.team;
    possession.team = carrier.team;
    possession.gainAt[carrier.team] = worldTime;
    if (prev) possession.lossAt[prev] = worldTime;
    // Judge the last pass: did it find a teammate or hand the ball over?
    if (lastPass && worldTime - lastPass.at < 3) {
      const passer = minds.get(lastPass.passerId);
      if (passer) {
        passer.confidence = clamp01(passer.confidence + (carrier.team === lastPass.team ? 0.05 : -0.09));
      }
      lastPass = null;
    }
  } else if (carrier && lastPass && carrier.team === lastPass.team && carrier.id !== lastPass.passerId && worldTime - lastPass.at < 3) {
    const passer = minds.get(lastPass.passerId);
    if (passer) passer.confidence = clamp01(passer.confidence + 0.05);
    lastPass = null;
  }
  cachedFrame = {
    frame: worldFrame,
    carrier,
    home: buildTeamView(ctx, 'home', carrier),
    away: buildTeamView(ctx, 'away', carrier),
  };
  return cachedFrame;
}

function teamView(ctx: AIUpdateContext, team: TeamSide): TeamView {
  const f = getFrame(ctx);
  return team === 'home' ? f.home : f.away;
}

// ---------------------------------------------------------------------------
// Pitch reading: danger, openness, pass lanes
// ---------------------------------------------------------------------------

/** 0..1 how threatening a spot is for the side attacking `goal` (distance x angle). */
function goalDanger(x: number, y: number, goal: Goal): number {
  const d = dist(x, y, goal.x, goal.center.y);
  const lateral = Math.abs(y - goal.center.y);
  const angle = clamp01(1 - lateral / (190 + d * 0.28));
  const distV = Math.pow(clamp01(1 - d / 700), 1.25);
  return distV * (0.35 + 0.65 * angle);
}

function predicted(o: Player, secs: number): { x: number; y: number } {
  return { x: o.x + o.vx * secs, y: o.y + o.vy * secs };
}

/** 0..1: how much free space a spot has (opponents projected slightly ahead). */
function openness(x: number, y: number, opps: Player[], secs = 0.3): number {
  let minD = 999;
  for (const o of opps) {
    const p = predicted(o, secs);
    const d = dist(x, y, p.x, p.y);
    if (d < minD) minD = d;
  }
  return clamp01((minD - 25) / 110);
}

/**
 * Chance a ball played from A to B arrives, using a race model: a defender
 * intercepts if he can reach the lane before the ball passes that point.
 */
function laneSuccess(
  ax: number, ay: number, bx: number, by: number,
  ballSpeed: number, opps: Player[], airborne: boolean
): number {
  const len = dist(ax, ay, bx, by);
  let ok = 1;
  for (const o of opps) {
    const s = segInfo(o.x, o.y, ax, ay, bx, by);
    const tBall = (s.t * len) / ballSpeed;
    const oppSpeed = Math.max(60, o.stats.speed * 1.2);
    const reach = 20 + oppSpeed * (tBall * 0.85 + 0.12);
    const margin = s.d - reach;
    if (margin < 0) {
      let p = clamp01(-margin / 38);
      if (airborne) p *= 0.3; // lofted balls clear the lane
      ok *= 1 - p;
    }
  }
  return clamp01(ok);
}

// ---------------------------------------------------------------------------
// Perception: field of view, scanning, blind-side surprises
// ---------------------------------------------------------------------------

export interface CarrierView {
  nearestSeen: number;
  nearestAny: number;
  blindThreat: boolean;
  heavy: boolean;
  frontOpp: number;
  oppPositions: Array<{ o: Player; x: number; y: number }>;
}

const FOV_HALF = 2.0; // ~115 degrees each side: the carrier sees ~230 degrees

export function perceiveCarrier(player: Player, ctx: AIUpdateContext): CarrierView {
  const mind = getMind(player);
  const tv = teamView(ctx, player.team);
  const t = worldTime;
  if (t >= mind.nextScan) {
    mind.lastScan = t;
    mind.nextScan = t + 1.1 + (1 - mind.persona.vision) * 2.2 + Math.random() * 0.8;
  }
  const scanned = t - mind.lastScan < 0.9;

  let nearestSeen = 999;
  let nearestAny = 999;
  let frontOpp = 999;
  let blindThreat = false;
  const oppPositions: CarrierView['oppPositions'] = [];

  for (const o of tv.opponents) {
    const d = dist(player.x, player.y, o.x, o.y);
    const bearing = Math.atan2(o.y - player.y, o.x - player.x);
    const off = Math.abs(angleDiff(bearing, player.facingAngle));
    const seen = scanned || off < FOV_HALF || d < 36;
    if (d < nearestAny) nearestAny = d;
    if (seen) {
      if (d < nearestSeen) nearestSeen = d;
    } else if (d < 95) {
      blindThreat = true;
    }
    if (off < 1.0 && d < frontOpp) frontOpp = d;
    const p = predicted(o, 0.35);
    oppPositions.push({ o, x: p.x, y: p.y });
  }
  return {
    nearestSeen,
    nearestAny,
    blindThreat,
    heavy: nearestSeen < 65,
    frontOpp,
    oppPositions,
  };
}

/** Reaction time between decisions: sharper players and pressured players decide faster. */
export function thinkDelay(player: Player, view: CarrierView): number {
  const m = getMind(player);
  const base = m.persona.reaction * (0.9 + Math.random() * 0.4);
  return view.heavy ? base * 0.65 : base;
}

/** Bookkeeping when a player is carrying the ball (starts the hold timer, relaxes mood). */
export function brainOnCarry(player: Player, dt: number): void {
  const m = getMind(player);
  if (!m.hadBall) {
    m.hadBall = true;
    m.possessionSince = worldTime;
    m.heading = player.facingAngle;
  }
  m.confidence += (0.5 - m.confidence) * 0.02 * dt;
}

/** Bookkeeping when a player does NOT have the ball (detects a lost ball). */
export function brainOffBall(player: Player, ctx: AIUpdateContext): void {
  const m = getMind(player);
  if (m.hadBall) {
    m.hadBall = false;
    m.heading = null;
    const carrier = getFrame(ctx).carrier;
    if (carrier && carrier.team !== player.team) {
      m.confidence = clamp01(m.confidence - 0.12); // dispossessed: shaken
    }
  }
}

// ---------------------------------------------------------------------------
// Carrier decisions
// ---------------------------------------------------------------------------

export interface BrainSituation {
  distToGoal: number;
  angleQuality: number;
  isWide: boolean;
  inOwnThird: boolean;
  inAttackingThird: boolean;
  underHeavyPressure: boolean;
  chasingLate: boolean;
  protectingLate: boolean;
}

export type CarrierChoice =
  | { kind: 'shoot'; why: string }
  | { kind: 'pass'; mate: Player; hint: PassHint; why: string; at?: { x: number; y: number } }
  | { kind: 'dribble'; why: string }
  | { kind: 'shield'; why: string }
  | { kind: 'clear'; why: string };

interface Option {
  choice: CarrierChoice;
  ev: number;
}

interface Mood {
  progressW: number;
  safetyW: number;
}

function tacticalMood(player: Player, ctx: AIUpdateContext, sit: BrainSituation, mind: Mind): Mood {
  let progressW = 1;
  let safetyW = sit.inOwnThird ? 1.4 : sit.inAttackingThird ? 0.7 : 1.0;
  if (sit.chasingLate) { progressW *= 1.35; safetyW *= 0.75; }
  if (sit.protectingLate) { progressW *= 0.65; safetyW *= 1.3; }
  // Counter-attack window: just won it, so go forward quickly.
  if (worldTime - possession.gainAt[player.team] < 3.5 && !sit.inAttackingThird) {
    progressW *= 1.25;
  }
  safetyW *= 1.25 - 0.5 * mind.confidence; // nervous players protect the ball
  return { progressW, safetyW };
}

function ownGoalOf(player: Player, half: HalfLike): Goal {
  return ownGoalFor(player.team, half);
}

function evalShot(
  player: Player, goal: Goal, sit: BrainSituation, view: CarrierView, mind: Mind, mood: Mood
): { ev: number; xg: number } {
  const d = sit.distToGoal;
  if (d > 640) return { ev: -999, xg: 0 };
  const finish = norm01(player.stats.kick);
  let blockers = 0;
  for (const op of view.oppPositions) {
    if (op.o.position === 'GK') continue;
    const s = segInfo(op.x, op.y, player.x, player.y, goal.x, goal.center.y);
    if (s.d < 26 && s.t > 0.05 && s.t < 0.95) blockers++;
  }
  const base = Math.pow(clamp01(1 - d / 680), 1.5);
  const xg = clamp01(
    base *
    (0.25 + 0.75 * sit.angleQuality) *
    (0.5 + 0.5 * finish) *
    Math.pow(0.62, blockers) *
    (view.heavy ? 0.8 : 1) *
    (0.85 + 0.15 * mind.persona.composure)
  );
  let ev = xg * 170 - (1 - xg) * 10 * mood.safetyW;
  ev += mind.persona.selfish * 27 * xg;
  if (d > 420 && d < 640) ev += finish * 8 * openness(player.x, player.y, view.oppPositions.map(p => p.o));
  if (sit.chasingLate) ev += 6;
  return { ev, xg };
}

function evalPass(
  player: Player, mate: Player, hint: PassHint,
  goal: Goal, dir: number, sit: BrainSituation, view: CarrierView,
  mind: Mind, mood: Mood, tv: TeamView, half: HalfLike,
  allPlayers: Player[],
  at?: { x: number; y: number }
): number {
  const lead = hint === 'through_ball' || hint === 'lobbed_through' ? 0.55 : 0.3;
  const rx = clamp(at ? at.x : mate.x + mate.vx * lead, 40, PITCH_LENGTH - 40);
  const ry = clamp(at ? at.y : mate.y + mate.vy * lead, 40, PITCH_WIDTH - 40);
  const d = dist(player.x, player.y, rx, ry);
  if (d < 40) return -999;
  const inBox = dir === 1
    ? mate.x > PITCH_LENGTH - 190 && mate.y > 160 && mate.y < PITCH_WIDTH - 160
    : mate.x < 190 && mate.y > 160 && mate.y < PITCH_WIDTH - 160;
  const isCross = hint === 'auto' && sit.isWide && sit.inAttackingThird && inBox;
  const airborne = hint === 'lobbed_through' || isCross;
  const speed = clamp(d * 3.0, 340, 620);
  // --- Awareness read: reachability gate + lane clarity + arrival space.
  // `receiverCanReach === false` is the through-ball-into-space bug, so an
  // unreachable pass is heavily penalized and never wins the soft-max.
  const read = readPass(player, mate, allPlayers, dir, {
    airborne,
    ballSpeedHint: speed,
  });
  const reachable = read.receiverCanReach ? 1 : 0.15;
  const lane = read.laneClear;
  const recvOpen = read.space;
  const mq = norm01(mate.stats.technique);
  const flair = norm01(player.stats.technique);
  const distPenalty = clamp01((d - 240) / 520) * (1 - 0.55 * flair);
  let success =
    lane * reachable *
    (1 - 0.38 * (1 - recvOpen) * (1 - 0.5 * mq)) *
    (1 - 0.35 * distPenalty) *
    (0.88 + 0.12 * flair);
  if (airborne) success *= isCross ? 0.88 : 0.85;
  if (hint === 'switch') success *= 0.92;
  if (hint === 'back_pass') success = Math.min(0.97, success * 1.05);
  success = clamp01(success);

  const progress = clamp(((rx - player.x) * dir) / 320, -1, 1.6);
  const dangerGain = goalDanger(rx, ry, goal) - goalDanger(player.x, player.y, goal);
  let beaten = 0;
  for (const o of tv.opponents) {
    const op = o.x * dir;
    if (op > player.x * dir + 10 && op < rx * dir) beaten++;
  }
  let value =
    22 * progress * mood.progressW +
    70 * dangerGain * (0.8 + 0.4 * mood.progressW) +
    14 * recvOpen +
    5 * Math.min(beaten, 4);
  if (hint === 'switch' && !view.heavy) value += 6;
  if (hint === 'one_two' && view.frontOpp < 130) value += 8;
  if (view.heavy) value += 24 * (1 - clamp01((view.nearestSeen - 20) / 45)); // relief outlet under pressure
  if (mate.position === 'FW') value += 3;
  // unselfish players like passing a little more
  value += (1 - mind.persona.selfish) * 4;

  const dangerToUs = goalDanger(rx, ry, ownGoalOf(player, half));
  const cost = (16 + 70 * dangerToUs) * mood.safetyW;
  return success * value - (1 - success) * cost;
}

/** Fan of headings scored around predicted defender positions. */
interface CarryPlan {
  heading: number;
  score: number;
  clearance: number;
  progress: number;
}

function planCarry(
  player: Player, goal: Goal, dir: number, view: CarrierView, mind: Mind, mood: Mood
): CarryPlan {
  const base = Math.atan2(goal.center.y - player.y, goal.x - player.x);
  const offsets = [-1.25, -0.85, -0.5, -0.22, 0, 0.22, 0.5, 0.85, 1.25];
  const reach = 150;
  const danger0 = goalDanger(player.x, player.y, goal);
  let best: CarryPlan = { heading: base, score: -Infinity, clearance: 0, progress: 0 };
  for (const off of offsets) {
    const h = base + off;
    const px = player.x + Math.cos(h) * reach;
    const py = player.y + Math.sin(h) * reach;
    let minD = 999;
    for (const op of view.oppPositions) {
      const s = segInfo(op.x, op.y, player.x, player.y, px, py);
      if (s.d < minD) minD = s.d;
    }
    const clearance = clamp01((minD - 24) / 95);
    const progress = ((px - player.x) * dir) / reach;
    const dangerGain = goalDanger(px, py, goal) - danger0;
    const edge = py < 55 || py > PITCH_WIDTH - 55 || px < 60 || px > PITCH_LENGTH - 60 ? 25 : 0;
    const turn = mind.heading !== null ? (Math.abs(angleDiff(h, mind.heading)) / Math.PI) * 10 : 0;
    const score = 28 * progress * mood.progressW + 60 * dangerGain + 42 * clearance - turn - edge;
    if (score > best.score) best = { heading: h, score, clearance, progress };
  }
  return best;
}

/** Between decisions: keep carrying, but steer around defenders instead of running into them. */
export function carrySteer(
  player: Player, ctx: AIUpdateContext, goal: Goal, dir: number, sit: BrainSituation
): { x: number; y: number; speed: number } {
  const mind = getMind(player);
  const view = perceiveCarrier(player, ctx);
  const mood = tacticalMood(player, ctx, sit, mind);
  const plan = planCarry(player, goal, dir, view, mind, mood);
  const cur = mind.heading ?? plan.heading;
  mind.heading = cur + angleDiff(plan.heading, cur) * 0.2; // smooth, organic turning
  let speed = player.stats.speed * 1.35;
  if (plan.clearance > 0.8 && plan.progress > 0.4) speed *= 1.1; // open grass: burst
  if (view.heavy) speed *= 0.93;
  return {
    x: player.x + Math.cos(mind.heading) * 160,
    y: player.y + Math.sin(mind.heading) * 160,
    speed,
  };
}

/** The main decision: score every option on one scale, soft-max pick, remember it. */
export function decideCarrier(
  player: Player,
  ctx: AIUpdateContext,
  goal: Goal,
  dir: number,
  sit: BrainSituation,
  view: CarrierView
): CarrierChoice {
  const mind = getMind(player);
  const tv = teamView(ctx, player.team);
  const mood = tacticalMood(player, ctx, sit, mind);
  const ownGoal = ownGoalOf(player, ctx.half);
  const options: Option[] = [];
  const holdTime = worldTime - mind.possessionSince;

  // --- Shoot
  const shot = evalShot(player, goal, sit, view, mind, mood);
  if (shot.ev > -900) {
    options.push({ choice: { kind: 'shoot', why: `xG ${shot.xg.toFixed(2)}` }, ev: shot.ev });
  }

  // --- Passes: every sensible teammate (generic) + specialist finders for variant fit
  const seen = new Set<string>();
  const addPass = (
    mate: Player | null, hint: PassHint, at?: { x: number; y: number }
  ): void => {
    if (!mate || mate.sentOff || mate.position === 'GK' || mate.id === player.id) return;
    const key = `${mate.id}:${hint}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ev = evalPass(
      player, mate, hint, goal, dir, sit, view, mind, mood,
      tv, ctx.half, ctx.allPlayers, at
    );
    if (ev > -900) {
      options.push({
        choice: { kind: 'pass', mate, hint, why: `${hint}->${mate.name}`, at },
        ev,
      });
    }
  };
  for (const mate of tv.outfield) {
    if (mate.id === player.id) continue;
    const d = dist(player.x, player.y, mate.x, mate.y);
    if (d < 45 || d > 460) continue;
    addPass(mate, 'auto');
  }
  // Through-ball specialist: only a runner with a REACHABLE meeting point
  // and a clear lane qualifies. The arrival point travels with the choice,
  // so executePassVariant aims at exactly that spot. When nobody qualifies
  // the pass is never added — no more hoofing it into empty grass.
  const through = findReadyThroughRunner(player, ctx.allPlayers, dir);
  if (through) addPass(through.mate, 'through_ball', through.read.arrival);
  addPass(findLobbedThroughRunner(player, ctx.allPlayers, dir), 'lobbed_through');
  addPass(findSwitchTarget(player, ctx.allPlayers, dir), 'switch');
  addPass(findBackOutlet(player, ctx.allPlayers, dir), 'back_pass');
  if (player.stats.technique >= 60) addPass(findWallMate(player, ctx.allPlayers, dir), 'one_two');
  if (sit.isWide && sit.inAttackingThird) addPass(findBoxTarget(player, ctx.allPlayers, dir), 'auto');

  // --- Dribble (best heading from the fan)
  const plan = planCarry(player, goal, dir, view, mind, mood);
  const flair = norm01(player.stats.technique);
  const dribSuccess = clamp(0.5 + 0.42 * plan.clearance + 0.12 * flair - (view.heavy ? 0.12 : 0), 0.15, 0.95);
  const dribDanger = goalDanger(player.x, player.y, ownGoal);
  let dribEv =
    Math.max(0, plan.score) * dribSuccess * 0.55 -
    (1 - dribSuccess) * (12 + 30 * dribDanger) * mood.safetyW;
  dribEv += mind.persona.selfish * 5 + (mind.confidence - 0.5) * 8;
  dribEv -= Math.max(0, holdTime - 2.2) * 3; // stop hogging it
  options.push({ choice: { kind: 'dribble', why: `carry c=${plan.clearance.toFixed(2)}` }, ev: dribEv });

  // --- Shield / hold up (pressed, nowhere to go)
  if (view.heavy) {
    const grit = norm01(player.stats.defense);
    const ev = 2 + 14 * (0.5 + 0.5 * grit) - Math.max(0, holdTime - 1.6) * 5;
    options.push({ choice: { kind: 'shield', why: 'ride the challenge' }, ev });
  }

  // --- Clear: giving the ball away is a real cost, so it only wins when the
  //     alternatives are worse (pinned deep, or every outlet is crowded).
  if (player.position === 'DF' || player.position === 'MF') {
    const bestSoFar = Math.max(...options.map(o => o.ev));
    if (view.heavy && (sit.inOwnThird || bestSoFar < -2)) {
      const danger = clamp01(goalDanger(player.x, player.y, ownGoal) * 2);
      const ev = 22 * danger + 6 * norm01(player.stats.defense) + 4 - 14;
      options.push({ choice: { kind: 'clear', why: 'safety first' }, ev: bestSoFar < -2 ? Math.max(ev, bestSoFar + 3) : ev });
    }
  }

  // Variety: do not do the same non-pass thing three times in a row.
  const last = mind.recent[mind.recent.length - 1];
  const last2 = mind.recent[mind.recent.length - 2];
  for (const o of options) {
    if (o.choice.kind !== 'pass' && o.choice.kind === last && o.choice.kind === last2) o.ev -= 4;
  }

  // Soft-max: composed, confident players are consistent; rattled ones gamble.
  let T = 2.2 + (1 - mind.persona.composure) * 3.5 + (1 - mind.confidence) * 1.5;
  if (view.heavy) T *= 1 + (1 - mind.persona.composure) * 0.8;
  const maxEv = Math.max(...options.map(o => o.ev));
  const weights = options.map(o => Math.exp((o.ev - maxEv) / T));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let picked = options[0];
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) { picked = options[i]; break; }
  }

  lastTrace = options.map(o => ({ why: `${o.choice.kind}:${o.choice.why}`, ev: Math.round(o.ev * 10) / 10 }));
  mind.recent.push(picked.choice.kind);
  if (mind.recent.length > 4) mind.recent.shift();
  mind.thought = `${picked.choice.why} (ev ${picked.ev.toFixed(0)})`;
  if (picked.choice.kind === 'pass') {
    lastPass = { passerId: player.id, team: player.team, at: worldTime, open: true };
  }
  return picked.choice;
}

// ---------------------------------------------------------------------------
// Off-ball attacking: committed runs with spacing
// ---------------------------------------------------------------------------

export interface RunTarget {
  x: number;
  y: number;
  speed: number;
  kind: string;
}

function intentStillGood(
  intent: Intent, player: Player, carrier: Player, tv: TeamView, dir: number
): boolean {
  if (worldTime >= intent.until) return false;
  if (intent.carrierId !== carrier.id) return false;
  if (dist(intent.carrierX, intent.carrierY, carrier.x, carrier.y) > 300) return false;
  if (intent.kind === 'behind' && (intent.x - tv.offsideLine) * dir > 12) return false;
  for (const o of tv.opponents) {
    if (dist(o.x, o.y, intent.x, intent.y) < 30) return false; // target got crowded
  }
  return dist(player.x, player.y, intent.x, intent.y) > 10 || worldTime < intent.until - 0.4;
}

export function attackRun(
  player: Player,
  ctx: AIUpdateContext,
  carrier: Player,
  goal: Goal,
  dir: number,
  flags: { chasing: boolean; protecting: boolean }
): RunTarget {
  const mind = getMind(player);
  const tv = teamView(ctx, player.team);
  const work = 0.95 + 0.1 * mind.persona.workRate;

  if (mind.intent && intentStillGood(mind.intent, player, carrier, tv, dir)) {
    return runFrom(mind.intent, player, work);
  }

  const base = Math.atan2(goal.center.y - carrier.y, goal.x - carrier.x);
  const pace = norm01(player.stats.speed);
  const opps = tv.opponents;
  const mates = tv.outfield.filter(m => m.id !== player.id);
  const carrierPressed = opps.some(o => dist(o.x, o.y, carrier.x, carrier.y) < 70);
  const attackW = flags.chasing ? 1.25 : flags.protecting ? 0.7 : 1;
  const lineX = tv.offsideLine - dir * 8;
  const shapeX = clamp(formationXOf(player, ctx.half) + (ctx.ball.x / PITCH_LENGTH - 0.5) * 280 * dir, 70, PITCH_LENGTH - 70);
  const shapeY = player.baseHomeY;

  const spots: Array<{ kind: Intent['kind']; x: number; y: number; bonus: number }> = [];
  for (const dy of [-170, -85, 0, 85, 170]) {
    spots.push({
      kind: 'behind',
      x: lineX - dir * Math.random() * 25,
      y: clamp(player.y + dy, 60, PITCH_WIDTH - 60),
      bonus: player.position === 'FW' ? 8 : 0,
    });
  }
  const supportR = 130 + mind.persona.vision * 50;
  for (const a of [-1.7, -1.15, -0.6, 0.6, 1.15, 1.7, 2.4, -2.4]) {
    const backward = Math.abs(a) > 2 ? 1 : 0;
    spots.push({
      kind: 'support',
      x: clamp(carrier.x + Math.cos(base + a) * supportR, 70, PITCH_LENGTH - 70),
      y: clamp(carrier.y + Math.sin(base + a) * supportR, 55, PITCH_WIDTH - 55),
      bonus: (player.position === 'MF' ? 6 : 0) + (carrierPressed ? 8 * backward : 0),
    });
  }
  for (const wy of [95, PITCH_WIDTH - 95]) {
    spots.push({
      kind: 'wide',
      x: clamp(carrier.x + dir * (40 + Math.random() * 80), 70, PITCH_LENGTH - 70),
      y: wy,
      bonus: player.position === 'MF' ? 3 : 0,
    });
  }
  const carrierInAttack = (carrier.x - PITCH_LENGTH / 2) * dir > 0;
  if (carrierInAttack) {
    const boxX = goal.x - dir * 85;
    const edgeX = goal.x - dir * 190;
    const ys = [PITCH_WIDTH / 2 - 120, PITCH_WIDTH / 2, PITCH_WIDTH / 2 + 120];
    for (const y of ys) spots.push({ kind: 'box', x: boxX, y, bonus: player.position === 'FW' ? 10 : 0 });
    spots.push({ kind: 'box', x: edgeX, y: PITCH_WIDTH / 2 + (Math.random() - 0.5) * 220, bonus: player.position === 'MF' ? 8 : 0 });
  }
  spots.push({ kind: 'shape', x: shapeX, y: shapeY, bonus: 0 });

  const teammateTargets: Array<{ x: number; y: number }> = [];
  for (const m of mates) {
    teammateTargets.push({ x: m.x, y: m.y });
    const mi = minds.get(m.id)?.intent;
    if (mi && worldTime < mi.until) teammateTargets.push({ x: mi.x, y: mi.y });
  }

  let bestScore = -Infinity;
  const scored: Array<{ s: (typeof spots)[number]; score: number }> = [];
  for (const s of spots) {
    const laneQ = laneSuccess(carrier.x, carrier.y, s.x, s.y, 470, opps, false);
    const open = openness(s.x, s.y, opps, 0.2);
    const danger = goalDanger(s.x, s.y, goal);
    const runDist = dist(player.x, player.y, s.x, s.y);
    const reach = clamp01(1 - runDist / (260 + pace * 140));
    const offside = (s.x - tv.offsideLine) * dir > 6 ? 90 : 0;
    let spacing = 0;
    for (const t of teammateTargets) {
      if (dist(t.x, t.y, s.x, s.y) < 85) spacing += 22;
    }
    const shape = -0.05 * dist(s.x, s.y, shapeX, shapeY);
    const distFromBall = dist(carrier.x, carrier.y, s.x, s.y);
    const far = distFromBall > 520 ? -12 : 0;
    const score =
      46 * laneQ + 32 * open + 52 * danger * attackW + 18 * reach -
      offside - spacing + shape + far + s.bonus + Math.random() * 4;
    scored.push({ s, score });
    if (score > bestScore) bestScore = score;
  }
  // soft-max among the candidates so teammates do not all choose identically
  const T = 5;
  const weights = scored.map(c => Math.exp((c.score - bestScore) / T));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let pick = scored[0].s;
  for (let i = 0; i < scored.length; i++) {
    r -= weights[i];
    if (r <= 0) { pick = scored[i].s; break; }
  }

  let dur = 1.0 + Math.random() * 0.5;
  if (pick.kind === 'support') dur = 1.1 + Math.random() * 0.9;
  if (pick.kind === 'wide') dur = 1.5 + Math.random() * 1.0;
  if (pick.kind === 'shape') dur = 0.8;
  let ix = pick.x;
  if (flags.chasing) ix += dir * 60;
  if (flags.protecting) ix -= dir * 40;
  mind.intent = {
    kind: pick.kind,
    x: clamp(ix, 70, PITCH_LENGTH - 70),
    y: clamp(pick.y, 50, PITCH_WIDTH - 50),
    until: worldTime + dur,
    carrierId: carrier.id,
    carrierX: carrier.x,
    carrierY: carrier.y,
  };
  mind.thought = `run:${pick.kind}`;
  return runFrom(mind.intent, player, work);
}

function runFrom(intent: Intent, player: Player, work: number): RunTarget {
  const mul =
    intent.kind === 'behind' ? 1.45 :
    intent.kind === 'box' ? 1.35 :
    intent.kind === 'wide' ? 1.25 :
    intent.kind === 'support' ? 1.22 : 1.15;
  return { x: intent.x, y: intent.y, speed: player.stats.speed * mul * work, kind: intent.kind };
}

// ---------------------------------------------------------------------------
// Defending: sticky goal-side marking, compact shape, press intensity
// ---------------------------------------------------------------------------

export interface DefPost {
  x: number;
  y: number;
  speedMul: number;
  state: 'running' | 'jockeying';
  kind: 'mark' | 'shape';
}

export function defensivePost(
  player: Player,
  ctx: AIUpdateContext,
  ownGoal: Goal,
  dir: number,
  carrier: Player | null,
  dropDeep: number
): DefPost {
  const mind = getMind(player);
  const tv = teamView(ctx, player.team);
  const ball = ctx.ball;

  // --- Pick (or keep) a man to mark. Sticky: only switch for a clearly bigger threat.
  let bestOpp: Player | null = null;
  let bestScore = -Infinity;
  if (player.position === 'DF' || player.position === 'MF') {
    for (const o of tv.opponents) {
      if (carrier && o.id === carrier.id) continue;
      const dGoal = dist(o.x, o.y, ownGoal.center.x, ownGoal.center.y);
      const threat = clamp01(1 - dGoal / 620);
      const prox = clamp01(1 - dist(formationXOf(player, ctx.half), player.baseHomeY, o.x, o.y) / 380);
      if (threat < 0.12 || prox < 0.1) continue;
      // Someone else already has him, and is closer? Leave him.
      let taken = false;
      for (const m of tv.outfield) {
        if (m.id === player.id) continue;
        if (minds.get(m.id)?.markId === o.id && dist(m.x, m.y, o.x, o.y) < dist(player.x, player.y, o.x, o.y) - 10) {
          taken = true;
          break;
        }
      }
      if (taken) continue;
      const score = threat * 60 + prox * 40 + (mind.markId === o.id ? 18 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestOpp = o;
      }
    }
  }

  if (bestOpp) {
    mind.markId = bestOpp.id;
    // Reaction lag: refresh the marking spot only every reaction interval, so a
    // sharp runner can briefly lose his marker.
    if (!mind.markPos || worldTime - mind.markPos.at > mind.persona.reaction) {
      const vx = ownGoal.center.x - bestOpp.x;
      const vy = ownGoal.center.y - bestOpp.y;
      const vl = Math.hypot(vx, vy) || 1;
      const gap = 20 + (1 - mind.persona.bravery) * 16;
      let mx = bestOpp.x + (vx / vl) * gap;
      let my = bestOpp.y + (vy / vl) * gap;
      my += (ball.y - my) * 0.12; // see man and ball
      mx = clamp(mx, 70, PITCH_LENGTH - 70);
      my = clamp(my, 50, PITCH_WIDTH - 50);
      mind.markPos = { x: mx, y: my, at: worldTime };
    }
    mind.thought = `mark ${bestOpp.name}`;
    return {
      x: mind.markPos.x,
      y: mind.markPos.y,
      speedMul: 1.45 + 0.1 * mind.persona.workRate,
      state: 'jockeying',
      kind: 'mark',
    };
  }
  mind.markId = null;
  mind.markPos = null;

  // --- Compact shape: slide toward the ball side and keep the back line flat.
  const highLineShift = (ball.x / PITCH_LENGTH - 0.5) * 220 * dir;
  let destX = formationXOf(player, ctx.half) + highLineShift - dir * dropDeep;
  const compress = player.position === 'DF' ? 0.22 : player.position === 'MF' ? 0.3 : 0.2;
  let destY = player.baseHomeY + (ball.y - player.baseHomeY) * compress;
  if (player.position === 'DF') {
    const defs = tv.outfield.filter(p => p.position === 'DF' && p.id !== player.id);
    if (defs.length > 0) {
      const avg = defs.reduce((s, p) => s + p.x, 0) / defs.length;
      destX = destX * 0.6 + avg * 0.4;
    }
    const minSafeX = dir === 1 ? 240 : PITCH_LENGTH - 240;
    destX = dir === 1 ? Math.max(minSafeX, destX) : Math.min(minSafeX, destX);
  }
  destX = clamp(destX, 70, PITCH_LENGTH - 70);
  destY = clamp(destY, 50, PITCH_WIDTH - 50);
  return { x: destX, y: destY, speedMul: 1.18, state: 'running', kind: 'shape' };
}

/** Press intensity: hard-working players and counter-pressing right after a turnover. */
export function pressBoost(player: Player, ctx: AIUpdateContext): number {
  const m = getMind(player);
  let b = 1 + 0.08 * m.persona.workRate;
  if (worldTime - possession.lossAt[player.team] < 3) b += 0.18;
  return b;
}

/** Where to run to meet a moving ball, not where it is now. */
export function interceptPoint(
  player: Player, ctx: AIUpdateContext, maxSpeed: number
): { x: number; y: number } {
  const b = ctx.ball;
  const k = 0.6; // assumed ground friction
  let last = { x: b.x, y: b.y };
  for (let t = 0.08; t <= 1.4; t += 0.08) {
    const f = (1 - Math.exp(-k * t)) / k;
    const px = clamp(b.x + b.vx * f, 20, PITCH_LENGTH - 20);
    const py = clamp(b.y + b.vy * f, 20, PITCH_WIDTH - 20);
    last = { x: px, y: py };
    if (dist(player.x, player.y, px, py) <= maxSpeed * t * 0.92 + 12) return last;
  }
  return last;
}
