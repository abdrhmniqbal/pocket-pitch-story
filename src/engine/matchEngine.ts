/**
 * Match Engine orchestrating match clock, rules, kickoff resets, and statistics.
 */

import { Ball, CardBanner, KickoffState, MatchHalf, MatchStats, Player, SetPieceState, SetPieceType, Team, VisualEffect } from '../types/soccer';
import { CENTER_CIRCLE_RADIUS, checkGoal, CORNER_SPOTS, dist, GOAL_HEIGHT, GOAL_KICK_SPOTS, GOAL_WIDTH, LEFT_GOAL, PENALTY_BOX_LENGTH, PENALTY_BOX_WIDTH, PITCH_LENGTH, PITCH_WIDTH, RIGHT_GOAL, updateBallPhysics } from './physics';
import { updatePlayerAI } from './ai';
import {
  executeCornerVariant,
  executeFreeKickVariant,
  executePenaltyVariant,
  executeThrowVariant,
  penaltyKeeperDive,
  pickCornerVariant,
  pickFreeKickVariant,
  pickPenaltyVariant,
  pickThrowVariant,
  wallJump,
  wallSpots,
} from './setPieceVariety';
import type { SetPieceCtx } from './setPieceVariety';
import { executeGoalKick } from './keeperVariety';
import {
  CardKind,
  FoulEvent,
  RefereeState,
  createReferee,
  dismissPlayer,
  drainFoulEvents,
  updateRefereePosition,
} from './referee';
import { soundEngine } from '../audio/soundEngine';
import { countVariety } from './actionVariety';
import { attackDirFor, attackGoalFor, defendsLeft, formationXOf, isSecondHalf, ownGoalFor } from './sides';

/**
 * Match-clock pacing: one match-second advances per 1/60th of a (speed-scaled)
 * game second, i.e. 1 game-minute per real second at 1x speed, so a full
 * 90-minute match lasts 90 real seconds.
 */
const MATCH_SECOND_THRESHOLD = 1 / 60;

/** Length of the half-time break in real seconds before the second half auto-starts. */
const HALF_TIME_BREAK_SECONDS = 5;

/** How long the transient 'SECOND HALF' kickoff banner stays up, in real seconds. */
const SECOND_HALF_BANNER_SECONDS = 3;

/**
 * Fix 2 — contextual free-kick wall: only form a wall within shooting range
 * of goal (~35m). The pitch is 1100 units ≈ 105m, so 35m ≈ 350 units; use
 * 370 as the danger threshold.
 */
export const FREE_KICK_WALL_RANGE = 370;

/** Fix 3 — free-kick tempo: walk-up + placement delay before the kick. */
const FREE_KICK_TEMPO_SECONDS = 1.8;

/**
 * Velocity-based steering for non-live-reset movement (set-piece walk-ups,
 * kickoff restraint). Mirrors the AI moveToTarget delivery dynamics
 * (arrival easing, acceleration blending, facing, stride) so field players
 * ALWAYS run to positions instead of snapping. Position changes here happen
 * ONLY via velocity integration (x += vx * dt), never by direct assignment.
 */
function steerPlayerTo(p: Player, tx: number, ty: number, maxSpeed: number, dt: number): void {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d > 3) {
    const arrivalFactor = Math.min(1, d / 22);
    const desiredSpeed = maxSpeed * arrivalFactor;
    const desiredVx = (dx / d) * desiredSpeed;
    const desiredVy = (dy / d) * desiredSpeed;
    const accelRate = 7.5;
    p.vx += (desiredVx - p.vx) * Math.min(1, accelRate * dt);
    p.vy += (desiredVy - p.vy) * Math.min(1, accelRate * dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const currentSpeed = Math.hypot(p.vx, p.vy);
    if (currentSpeed > 6) {
      const targetAngle = Math.atan2(p.vy, p.vx);
      let angleDiff = targetAngle - p.facingAngle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      p.facingAngle += angleDiff * Math.min(1, 9.0 * dt);
    }
    p.animFrame += dt * (currentSpeed * 0.075);
  } else {
    const friction = Math.pow(0.08, dt * 6);
    p.vx *= friction;
    p.vy *= friction;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

/**
 * Reasonable run speed for set-piece walk-ups / kickoff restraint so
 * movement looks natural rather than sluggish. Decision logic (targets)
 * is unchanged; only the delivery speed is normalized here.
 */
function setPieceRunSpeed(p: Player): number {
  return Math.max(260, p.stats.speed * 2.5);
}

/**
 * Where a set-piece taker must stand before delivery. Pure function of the
 * set-piece state (no movement itself).
 */
function setPieceTakerTarget(
  type: SetPieceType,
  team: 'home' | 'away' | null,
  spot: { x: number; y: number },
  half: MatchHalf
): { x: number; y: number } {
  if (type === 'throw_in') {
    return { x: spot.x, y: spot.y <= 0 ? -3 : PITCH_WIDTH + 3 };
  }
  // The taker stands behind the ball, i.e. opposite the attack direction
  // (which swaps ends at half-time).
  const dir = team == null ? 1 : attackDirFor(team, half);
  return { x: spot.x - dir * 12, y: spot.y };
}

export interface MatchEngineState {
  half: MatchHalf;
  matchMinutes: number; // 0 to 90
  matchSeconds: number; // 0 to 59
  gameSpeed: number;    // 0 = paused, 1 = normal, 2 = fast, 4 = turbo
  isGoalSequence: boolean;
  goalScorer: Player | null;
  goalTeam: 'home' | 'away' | null;
  goalTimer: number;
  selectedPlayerId: string;
  setPiece: SetPieceState;
  kickoff: KickoffState;
  showHalfTimeBanner: boolean;
  showSecondHalfBanner: boolean;
  secondHalfBannerTimer: number;
  showFullTimeBanner: boolean;
  referee: RefereeState;
  cardBanner: CardBanner | null;
}

export class MatchEngine {
  public homeTeam: Team;
  public awayTeam: Team;
  public ball: Ball;
  public stats: MatchStats;
  public state: MatchEngineState;
  public visualEffects: VisualEffect[] = [];
  public onCommentary?: (text: string, type: 'goal' | 'save' | 'shot' | 'tackle' | 'pass' | 'whistle' | 'info' | 'corner' | 'out' | 'kickoff', team?: 'home' | 'away') => void;
  public onGoalScored?: (team: 'home' | 'away', scorer: Player) => void;
  public onSetPieceEvent?: (type: SetPieceType, team: 'home' | 'away') => void;

  private simTimeAccumulator: number = 0;
  private halfTimeTimer: number = 0; // Counts up while half === 'HT' until startSecondHalf() auto-fires.
  private throwInGrace: number = 0; // Tackle-suppression window after a throw-in is taken (~2s game time).

  constructor(homeTeam: Team, awayTeam: Team) {
    this.homeTeam = homeTeam;
    this.awayTeam = awayTeam;

    this.ball = {
      x: PITCH_LENGTH / 2,
      y: PITCH_WIDTH / 2,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      radius: 5,
      carrierId: null,
      lastTouchTeam: 'home',
      lastTouchPlayerId: null,
      secondTouchBlockId: null,
      rotationAngle: 0,
    };

    // Fix 7 — fresh matches start from a fully-zeroed stat sheet.
    this.stats = {
      homePossessionTime: 0,
      awayPossessionTime: 0,
      homeShots: 0,
      awayShots: 0,
      homeShotsOnTarget: 0,
      awayShotsOnTarget: 0,
      homePasses: 0,
      awayPasses: 0,
      homeTackles: 0,
      awayTackles: 0,
      homeSaves: 0,
      awaySaves: 0,
      homeCorners: 0,
      awayCorners: 0,
      homeThrowIns: 0,
      awayThrowIns: 0,
      homeFouls: 0,
      awayFouls: 0,
      homeYellows: 0,
      awayYellows: 0,
      homeReds: 0,
      awayReds: 0,
    };

    // Initialize state: fresh match at 0:00, Brown selected (DF)
    this.state = {
      half: 'FH',
      matchMinutes: 0,
      matchSeconds: 0,
      gameSpeed: 1,
      isGoalSequence: false,
      goalScorer: null,
      goalTeam: null,
      goalTimer: 0,
      selectedPlayerId: 'h2', // Brown!
      setPiece: {
        type: null,
        team: null,
        spot: { x: 0, y: 0 },
        kickerId: null,
        timer: 0,
      },
      kickoff: {
        active: false,
        team: 'home',
        phase: 'done',
        timer: 0,
        kickerId: null,
        partnerId: null,
      },
      showHalfTimeBanner: false,
      showSecondHalfBanner: false,
      secondHalfBannerTimer: 0,
      showFullTimeBanner: false,
      referee: createReferee(),
      cardBanner: null,
    };

    // Start with authentic Kickoff sequence!
    this.resetKickoff('home');
  }

  public getAllPlayers(): Player[] {
    return [...this.homeTeam.players, ...this.awayTeam.players];
  }

  public getSelectedPlayer(): Player {
    const all = this.getAllPlayers();
    return all.find(p => p.id === this.state.selectedPlayerId) || all[0];
  }

  public setSelectedPlayer(id: string) {
    this.state.selectedPlayerId = id;
  }

  public addEffect(effect: VisualEffect) {
    this.visualEffects.push(effect);
  }

  public addCommentary(
    text: string,
    type: 'goal' | 'save' | 'shot' | 'tackle' | 'pass' | 'whistle' | 'info' | 'corner' | 'out' | 'kickoff' = 'info',
    team?: 'home' | 'away'
  ) {
    if (this.onCommentary) {
      this.onCommentary(text, type, team);
    }
  }

  /**
   * Main game tick
   */
  public update(realDeltaTime: number) {
    if (this.state.gameSpeed === 0) return;

    // Real (unscaled) frame time, used for break/banner timers so the
    // half-time break lasts ~5 real seconds at any game speed.
    const realDt = Math.min(0.05, realDeltaTime);
    // Scale delta time by game speed
    const dt = realDt * this.state.gameSpeed;

    // The referee trails play at a distance (never interferes).
    updateRefereePosition(this.state.referee, this.ball, dt);
    // Transient card banners tick down in real time.
    if (this.state.cardBanner) {
      this.state.cardBanner.timer += realDt;
      if (this.state.cardBanner.timer > 3.5) this.state.cardBanner = null;
    }

    // Throw-in grace period ticks down in game time (models opponents retreating 2m).
    if (this.throwInGrace > 0) {
      this.throwInGrace = Math.max(0, this.throwInGrace - dt);
    }

    // Transient 'SECOND HALF' kickoff banner ticks down in real time.
    if (this.state.showSecondHalfBanner) {
      this.state.secondHalfBannerTimer += realDt;
      if (this.state.secondHalfBannerTimer >= SECOND_HALF_BANNER_SECONDS) {
        this.state.showSecondHalfBanner = false;
        this.state.secondHalfBannerTimer = 0;
      }
    }

    // 1. Update Match Clock
    // 1x speed advances one match-second per real second (a full 90-minute
    // match lasts 90 real seconds). dt is already scaled by gameSpeed, and the
    // remainder is carried over so 2x/4x stay proportional from this base.
    if (!this.state.isGoalSequence && this.state.half !== 'HT' && this.state.half !== 'FT') {
      this.simTimeAccumulator += dt;
      let secondsToAdvance = 0;
      while (this.simTimeAccumulator >= MATCH_SECOND_THRESHOLD && secondsToAdvance < 10) {
        this.simTimeAccumulator -= MATCH_SECOND_THRESHOLD;
        secondsToAdvance += 1;
      }
      while (secondsToAdvance > 0) {
        secondsToAdvance -= 1;
        this.state.matchSeconds += 1;
        if (this.state.matchSeconds >= 60) {
          this.state.matchSeconds = 0;
          this.state.matchMinutes += 1;

          // Half-Time Check (45:00)
          if (this.state.half === 'FH' && this.state.matchMinutes >= 45) {
            this.state.half = 'HT';
            this.state.matchSeconds = 0;
            this.state.showHalfTimeBanner = true;
            this.halfTimeTimer = 0;
            this.stopPlayForBreak();
            soundEngine.playDoubleWhistle();
            this.addCommentary('The referee blows for HALF TIME! Take a breather!', 'whistle');
            break;
          }
          // Full-Time Check (90:00)
          else if (this.state.half === 'SH' && this.state.matchMinutes >= 90) {
            this.state.half = 'FT';
            this.state.matchSeconds = 0;
            this.state.showFullTimeBanner = true;
            this.stopPlayForBreak();
            soundEngine.playDoubleWhistle();
            this.addCommentary('FULL TIME! What an exhilarating football clash!', 'whistle');
            break;
          }
        }
      }
    }

    // 1b. Half-Time break: freeze play under the HALF TIME banner, then
    // automatically start the second half after ~5 real seconds. No user
    // action is required.
    if (this.state.half === 'HT' && !this.state.isGoalSequence) {
      this.halfTimeTimer += realDt;
      if (this.halfTimeTimer >= HALF_TIME_BREAK_SECONDS) {
        this.startSecondHalf();
      } else {
        // Real break feel: clock stopped, players idle, ball dead.
        this.updateVisualEffects(dt);
        return;
      }
    }

    // 1c. Full-Time: the match is over. The clock stays on 90:00 and play
    // freezes (no post-whistle goals or restarts). No user action required.
    if (this.state.half === 'FT') {
      this.updateVisualEffects(dt);
      return;
    }

    // 2. Goal Celebration Sequence
    if (this.state.isGoalSequence) {
      this.state.goalTimer += dt;
      if (this.state.goalTimer > 4.5) {
        // Reset to center kickoff!
        this.resetKickoff(this.state.goalTeam === 'home' ? 'away' : 'home');
      }
      // Keep updating ball physics slowly
      updateBallPhysics(this.ball, dt * 0.4);
      this.ball.woodworkHit = null;
      this.updateVisualEffects(dt);
      return;
    }

    // 2b. Kickoff Sequence (Mini soccer kickoff logic)
    if (this.state.kickoff.active) {
      this.updateKickoff(dt);
      this.updateVisualEffects(dt);
      return;
    }

    // 3. Set Piece Handling (Corner Kick, Throw-In, Goal Kick)
    if (this.state.setPiece.type !== null) {
      this.updateSetPiece(dt);
      this.updateVisualEffects(dt);
      return;
    }

    // 4. Goal Detection
    const goalScoredTeam = checkGoal(this.ball, this.state.half);
    if (goalScoredTeam && !this.state.isGoalSequence) {
      this.handleGoalScored(goalScoredTeam);
      return;
    }

    // 5. Update Ball Physics
    updateBallPhysics(this.ball, dt);

    // 5b. Woodwork: the frame collision flags bounces for commentary.
    if (this.ball.woodworkHit) {
      const hit = this.ball.woodworkHit;
      this.ball.woodworkHit = null;
      const hitter = this.getAllPlayers().find(p => p.id === this.ball.lastTouchPlayerId);
      const hitterName = hitter ? hitter.name : 'The strike';
      soundEngine.playPostHit();
      if (hit === 'post') {
        this.addCommentary(`${hitterName} rattles the POST! OFF THE WOODWORK and back into play!`, 'shot', this.ball.lastTouchTeam ?? undefined);
      } else {
        this.addCommentary(`${hitterName} crashes it OFF THE CROSSBAR! Back into play!`, 'shot', this.ball.lastTouchTeam ?? undefined);
      }
    }

    // 6. Update All Players AI
    const allPlayers = this.getAllPlayers();
    for (const player of allPlayers) {
      updatePlayerAI(player, {
        half: this.state.half,
        dt,
        ball: this.ball,
        allPlayers,
        stats: this.stats,
        addEffect: (e) => this.addEffect(e),
        addCommentary: (text, type, team) => this.addCommentary(text, type, team),
        tackleSuppressed: this.throwInGrace > 0 || this.state.setPiece.type !== null,
      });
    }

    // 7b. Second-touch rule (fix 1): the block lifts the moment ANOTHER
    // player touches the ball after the set-piece delivery.
    if (
      this.ball.secondTouchBlockId != null &&
      this.ball.lastTouchPlayerId != null &&
      this.ball.lastTouchPlayerId !== this.ball.secondTouchBlockId
    ) {
      this.ball.secondTouchBlockId = null;
    }

    // 8. Track Possession Stats
    if (this.ball.lastTouchTeam === 'home') {
      this.stats.homePossessionTime += dt;
    } else if (this.ball.lastTouchTeam === 'away') {
      this.stats.awayPossessionTime += dt;
    }

    // 9. Auto-track Active Player for Bottom-Left Monitor
    const ballCarrier = allPlayers.find(p => p.hasBall);
    if (ballCarrier) {
      this.state.selectedPlayerId = ballCarrier.id;
    }

    // 10. Visual Effects Lifetime
    this.updateVisualEffects(dt);

    // 11. Boundary checks (Corners, Throw-Ins, Goal Kicks)
    this.handleBoundaries();

    // 12. Foul stoppages raised by the referee during AI (whistled now,
    // taken next tick via the set-piece branch).
    for (const foul of drainFoulEvents()) {
      if (this.state.setPiece.type !== null) break;
      this.whistleFoul(foul);
    }
  }

  /**
   * Fresh dead-ball context for the set-piece variety executors.
   */
  private spCtx(dt: number): SetPieceCtx {
    return {
      half: this.state.half,
      dt,
      ball: this.ball,
      allPlayers: this.getAllPlayers(),
      stats: this.stats,
      addEffect: (e) => this.addEffect(e),
      addCommentary: (text, type, team) => this.addCommentary(text, type, team),
    };
  }

  /**
   * Whistle a referee foul: stop play, show any card, award the free kick
   * (or penalty when the foul was inside the box).
   */
  private whistleFoul(foul: FoulEvent) {
    if (this.state.half !== 'FH' && this.state.half !== 'SH') return;
    if (this.state.isGoalSequence || this.state.kickoff.active || this.state.setPiece.type !== null) return;
    if (foul.foulerTeam === 'home') this.stats.homeFouls = (this.stats.homeFouls ?? 0) + 1;
    else this.stats.awayFouls = (this.stats.awayFouls ?? 0) + 1;

    soundEngine.playWhistle(true);
    const fouler = this.getAllPlayers().find(q => q.id === foul.foulerId);
    if (fouler && !fouler.sentOff && foul.card) this.applyCard(fouler, foul.card, foul.reason);

    const fouledName = foul.fouledTeam === 'home' ? this.homeTeam.name : this.awayTeam.name;
    if (foul.inBox) {
      // Penalty! Spot 120 units out from the goal the fouled team attacks
      // (ends swap at half-time), centered on the goal.
      const attackX = attackGoalFor(foul.fouledTeam, this.state.half).x;
      const spot = attackX === 0
        ? { x: 120, y: PITCH_WIDTH / 2 }
        : { x: PITCH_LENGTH - 120, y: PITCH_WIDTH / 2 };
      this.addCommentary(
        `*WHISTLE* ${foul.foulerName} ${foul.reason} — PENALTY for ${fouledName}!`,
        'whistle',
        foul.fouledTeam
      );
      this.setupSetPiece('penalty', foul.fouledTeam, spot);
    } else {
      const spot = {
        x: Math.max(60, Math.min(PITCH_LENGTH - 60, foul.spot.x)),
        y: Math.max(60, Math.min(PITCH_WIDTH - 60, foul.spot.y)),
      };
      this.addCommentary(
        `*WHISTLE* Foul by ${foul.foulerName} on ${foul.victimName} — free kick for ${fouledName}!`,
        'whistle',
        foul.fouledTeam
      );
      this.setupSetPiece('free_kick', foul.fouledTeam, spot);
    }
  }

  /**
   * Show a yellow, or send off for a second yellow / straight red.
   * Dismissed players head down the tunnel and their side drops deeper.
   */
  private applyCard(offender: Player, card: CardKind, reason: string) {
    const teamName = offender.team === 'home' ? this.homeTeam.name : this.awayTeam.name;
    if (card === 'yellow') {
      offender.yellowCards = (offender.yellowCards ?? 0) + 1;
      if (offender.team === 'home') this.stats.homeYellows = (this.stats.homeYellows ?? 0) + 1;
      else this.stats.awayYellows = (this.stats.awayYellows ?? 0) + 1;
      this.state.cardBanner = { playerName: offender.name, team: offender.team, kind: 'yellow', reason, timer: 0 };
      this.addCommentary(`YELLOW CARD for ${offender.name} (${teamName}) — ${reason}!`, 'whistle', offender.team);
    } else {
      if (card === 'second_yellow') offender.yellowCards = 2;
      if (offender.team === 'home') this.stats.homeReds = (this.stats.homeReds ?? 0) + 1;
      else this.stats.awayReds = (this.stats.awayReds ?? 0) + 1;
      dismissPlayer(offender);
      this.state.cardBanner = { playerName: offender.name, team: offender.team, kind: card, reason, timer: 0 };
      this.addCommentary(
        card === 'second_yellow'
          ? `SECOND YELLOW — RED CARD! ${offender.name} walks! ${teamName} must reshuffle down a man!`
          : `RED CARD! ${offender.name} is SENT OFF — ${reason}! ${teamName} drop deeper!`,
        'whistle',
        offender.team
      );
    }
  }

  private handleGoalScored(scoringTeam: 'home' | 'away') {
    this.state.isGoalSequence = true;
    this.state.goalTimer = 0;
    this.state.goalTeam = scoringTeam;

    if (scoringTeam === 'home') {
      this.homeTeam.score++;
    } else {
      this.awayTeam.score++;
    }

    // Find likely scorer
    const allPlayers = this.getAllPlayers();
    const scorer = allPlayers.find(p => p.id === this.ball.lastTouchPlayerId) || 
      (scoringTeam === 'home' ? this.homeTeam.players[6] : this.awayTeam.players[6]);

    this.state.goalScorer = scorer;

    // Sound and celebration
    soundEngine.playWhistle(true);
    soundEngine.playCrowdGoal();

    // Team-wide celebration: ALL players on the scoring team celebrate, ALL
    // players on the conceding team are disappointed. This overrides any
    // stuck states (e.g. the conceding GK left celebrating). 'disappointed'
    // has no dedicated sprite; the renderer falls back to the idle body.
    // Sent-off players are off the pitch: leave them alone.
    for (const p of allPlayers) {
      if (p.sentOff) continue;
      if (p.team === scoringTeam) {
        p.state = 'celebrating';
        p.stateTimer = 0;
        p.z = 0; // reset any dive elevation
      } else {
        p.state = 'disappointed';
        p.stateTimer = 0;
        p.z = 0; // reset dive elevation so conceding GK doesn't look like jumping
      }
    }
    // Scorer jump + goal badge effect
    if (scorer) {
      scorer.z = 12; // jump
      this.addEffect({
        id: `goal-excl-${Date.now()}`,
        type: 'exclamation',
        x: scorer.x,
        y: scorer.y,
        z: 40,
        color: '#ffeb3b',
        life: 0,
        maxLife: 3.5,
      });
    }

    const teamName = scoringTeam === 'home' ? this.homeTeam.name : this.awayTeam.name;
    const nearEdge = Math.min(
      Math.abs(this.ball.y - RIGHT_GOAL.yMin),
      Math.abs(this.ball.y - RIGHT_GOAL.yMax)
    );
    if (nearEdge < 12) {
      this.addCommentary(
        `GOOOOOAL FOR ${teamName.toUpperCase()}! ${scorer ? scorer.name : 'Stunning finish'} scores IN OFF THE WOODWORK!`,
        'goal',
        scoringTeam
      );
    } else {
      this.addCommentary(
        `GOOOOOAL FOR ${teamName.toUpperCase()}! ${scorer ? scorer.name : 'Stunning finish'} puts it in the net!`,
        'goal',
        scoringTeam
      );
    }

    if (this.onGoalScored) {
      this.onGoalScored(scoringTeam, scorer);
    }
  }

  /**
   * Setup a set piece (Corner, Throw-in, Goal kick)
   */
  private setupSetPiece(type: SetPieceType, team: 'home' | 'away', spot: { x: number; y: number }) {
    // Clear carrier
    this.ball.carrierId = null;
    this.ball.x = spot.x;
    this.ball.y = spot.y;
    this.ball.z = 0;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.vz = 0;

    // Pick appropriate taker
    const teamPlayers = (team === 'home' ? this.homeTeam : this.awayTeam).players;
    let taker: Player;

    if (type === 'goal_kick') {
      taker = teamPlayers.find(p => p.position === 'GK') || teamPlayers[0];
      // Walk-up: taker runs to the spot via updateSetPiece steering (no snap).
      taker.vx = 0;
      taker.vy = 0;
      taker.vz = 0;
      taker.hasBall = false;
      taker.state = 'running';
      taker.stateTimer = 0;
    } else if (type === 'corner_kick') {
      taker = teamPlayers.find(p => (p.position === 'MF' || p.position === 'FW') && !p.sentOff)
        || teamPlayers.find(p => p.position !== 'GK' && !p.sentOff)
        || teamPlayers[0];
      // Walk-up: taker runs to the spot via updateSetPiece steering (no snap).
      taker.vx = 0;
      taker.vy = 0;
      taker.vz = 0;
      taker.hasBall = false;
      taker.state = 'running';
      taker.stateTimer = 0;
    } else if (type === 'free_kick' || type === 'penalty') {
      // Dead-ball specialist: best kick among the available outfielders.
      const candidates = teamPlayers.filter(p => p.position !== 'GK' && !p.sentOff);
      const pool = candidates.length > 0 ? candidates : teamPlayers.filter(p => p.position !== 'GK');
      taker = pool.reduce((best, cur) => (cur.stats.kick > best.stats.kick ? cur : best), pool[0] || teamPlayers[0]);
      // Walk-up: taker runs to the spot via updateSetPiece steering (no snap).
      taker.vx = 0;
      taker.vy = 0;
      taker.vz = 0;
      taker.hasBall = false;
      taker.state = 'running';
      taker.stateTimer = 0;
    } else {
      // Throw-in: Select nearest outfield player (not GK)
      const outfielders = teamPlayers.filter(p => p.position !== 'GK' && !p.sentOff);
      taker = outfielders.reduce((closest, cur) => {
        const dCur = dist(cur.x, cur.y, spot.x, spot.y);
        const dClosest = dist(closest.x, closest.y, spot.x, spot.y);
        return dCur < dClosest ? cur : closest;
      }, outfielders[0] || teamPlayers[0]);

      taker.facingAngle = spot.y <= 0 ? Math.PI / 2 : -Math.PI / 2; // Face onto pitch
      // Walk-up: taker runs to the touchline via updateSetPiece steering (no snap).
      taker.vx = 0;
      taker.vy = 0;
      taker.vz = 0;
      taker.hasBall = false;
      taker.state = 'running';
      taker.stateTimer = 0;
      // Ball waits dead at the touchline spot until the taker walks up.
      this.ball.x = spot.x;
      this.ball.y = spot.y;
      this.ball.z = 0;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.ball.vz = 0;
    }

    // Fix 2 — free-kick setups never inherit a stale wall pose from open play:
    // nobody stands in 'blocking' until the contextual wall forms (or at all
    // when far from goal).
    if (type === 'free_kick') {
      for (const q of this.getAllPlayers()) {
        if (q.state === 'blocking') {
          q.state = 'running';
          q.stateTimer = 0;
        }
      }
    }

    this.state.setPiece = {
      type,
      team,
      spot,
      kickerId: taker.id,
      timer: 0,
    };

    if (this.onSetPieceEvent) {
      this.onSetPieceEvent(type, team);
    }
  }

  /**
   * Updates players during set pieces and executes delivery
   */
  private updateSetPiece(dt: number) {
    const sp = this.state.setPiece;
    sp.timer += dt;

    const allPlayers = this.getAllPlayers();
    const taker = allPlayers.find(p => p.id === sp.kickerId);

    // Walk-ups: every field player runs to their set-piece mark via velocity
    // steering (no snaps). Ball placement below is dead-ball setup, not a player.
    const takerTarget = setPieceTakerTarget(sp.type, sp.team, sp.spot, this.state.half);
    const takerArrived =
      !taker || dist(taker.x, taker.y, takerTarget.x, takerTarget.y) < 30;

    // Keep ball positioned at set piece spot or in thrower's hands
    if (sp.type === 'throw_in' && taker) {
      steerPlayerTo(taker, takerTarget.x, takerTarget.y, setPieceRunSpeed(taker), dt);
      taker.facingAngle = sp.spot.y <= 0 ? Math.PI / 2 : -Math.PI / 2;
      if (takerArrived) {
        taker.state = 'throwing';
        taker.hasBall = true;
        (this.ball as any).carrierId = taker.id;
        this.ball.x = taker.x;
        this.ball.y = taker.y;
        this.ball.z = 24; // Held overhead
      } else {
        taker.state = 'running';
        taker.hasBall = false;
        this.ball.x = sp.spot.x;
        this.ball.y = sp.spot.y;
        this.ball.z = 0;
      }
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.ball.vz = 0;

      // Teammate approaches sideline to create passing channel for throw
      const teammates = allPlayers.filter(p => p.team === sp.team && p.id !== sp.kickerId && p.position !== 'GK' && !p.sentOff);
      const receiver = teammates.reduce((closest, cur) => {
        const dCur = dist(cur.x, cur.y, sp.spot.x, sp.spot.y);
        const dClosest = dist(closest.x, closest.y, sp.spot.x, sp.spot.y);
        return dCur < dClosest ? cur : closest;
      }, teammates[0]);
      if (receiver) {
        const targetReceiveY = sp.spot.y <= 0 ? 55 : PITCH_WIDTH - 55;
        const targetReceiveX = sp.spot.x + attackDirFor(sp.team ?? 'home', this.state.half) * 40;
        receiver.state = 'running';
        steerPlayerTo(receiver, targetReceiveX, targetReceiveY, setPieceRunSpeed(receiver), dt);
      }
    } else {
      if (taker) {
        steerPlayerTo(taker, takerTarget.x, takerTarget.y, setPieceRunSpeed(taker), dt);
        if (takerArrived) {
          taker.state = 'idle';
          taker.hasBall = true;
        } else {
          taker.state = 'running';
          taker.hasBall = false;
        }
      }
      this.ball.x = sp.spot.x;
      this.ball.y = sp.spot.y;
      this.ball.z = 0;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.ball.vz = 0;
    }

    // Keepers never freeze during dead-ball setups: non-taking keepers
    // shuffle to their line and set (penalties steer theirs specifically).
    if (sp.type !== 'penalty') {
      for (const q of allPlayers) {
        if (q.position !== 'GK' || q.sentOff || q.id === sp.kickerId) continue;
        const lineX = defendsLeft(q.team, this.state.half) ? 45 : PITCH_LENGTH - 45;
        const shade = Math.max(-1, Math.min(1, (this.ball.y - PITCH_WIDTH / 2) / 260));
        const lineY = Math.max(270 + 12, Math.min(410 - 12, PITCH_WIDTH / 2 + shade * (GOAL_WIDTH / 2 - 12)));
        q.state = 'running';
        steerPlayerTo(q, lineX, lineY, setPieceRunSpeed(q), dt);
      }
    }

    // Wall formation for free kicks (fix 2): a full defensive wall ONLY in a
    // dangerous position (within shooting range, < ~35m of goal). Far from
    // goal, defenders take normal marking/zonal positions — no wall.
    if (sp.type === 'free_kick') {
      const wallTeam = sp.team === 'home' ? 'away' : 'home';
      const defended = ownGoalFor(wallTeam, this.state.half);
      const distToGoal = dist(sp.spot.x, sp.spot.y, defended.x, defended.center.y);
      const formWall = distToGoal < FREE_KICK_WALL_RANGE;
      const candidates = allPlayers
        .filter(q => q.team === wallTeam && q.position !== 'GK' && !q.sentOff)
        .sort((a, b) => dist(a.x, a.y, sp.spot.x, sp.spot.y) - dist(b.x, b.y, sp.spot.x, sp.spot.y));
      if (formWall) {
        countVariety('setpiece:wall_formed');
        const wallSize = distToGoal < 330 ? 3 : 2;
        const wall = candidates.slice(0, wallSize);
        const spots = wallSpots(sp.spot, defended, wallSize);
        wall.forEach((def, i) => {
          def.state = 'blocking';
          def.stateTimer = 0;
          steerPlayerTo(def, spots[i].x, spots[i].y, setPieceRunSpeed(def), dt);
        });
        // Remaining defenders drop to the box edge; attackers crowd the box.
        for (const q of allPlayers) {
          if (q.sentOff || q.id === sp.kickerId || q.position === 'GK') continue;
          if (q.team === wallTeam) {
            if (wall.indexOf(q) !== -1) continue;
            q.state = 'running';
            steerPlayerTo(q, defended.x + (defendsLeft(wallTeam, this.state.half) ? 150 : -150), q.baseHomeY, setPieceRunSpeed(q), dt);
          } else {
            // Attackers crowd the box they're ATTACKING (based on their team,
            // not where the foul happened).
            const attackRight = attackDirFor(sp.team ?? 'home', this.state.half) === 1;
            const boxX = attackRight ? PITCH_LENGTH - 110 : 110;
            q.state = 'running';
            steerPlayerTo(q, boxX + Math.sin(q.number) * 60, PITCH_WIDTH / 2 + Math.cos(q.number) * 120, setPieceRunSpeed(q), dt);
          }
        }
      } else {
        // No wall far from goal: zonal shape — defenders goal-side of the
        // ball, attackers offering outlets. Nobody stands in a wall.
        countVariety('setpiece:wall_skipped');
        for (const q of allPlayers) {
          if (q.sentOff || q.id === sp.kickerId || q.position === 'GK') continue;
          if (q.state === 'blocking') q.state = 'running';
          if (q.team === wallTeam) {
            q.state = 'running';
            steerPlayerTo(q, sp.spot.x + (defendsLeft(wallTeam, this.state.half) ? -90 : 90), q.baseHomeY, setPieceRunSpeed(q), dt);
          } else {
            // Attackers position by the goal they attack, not the foul spot.
            const attackRight = attackDirFor(sp.team ?? 'home', this.state.half) === 1;
            const boxX = attackRight ? PITCH_LENGTH - 110 : 110;
            q.state = 'running';
            steerPlayerTo(q, boxX + Math.sin(q.number) * 60, PITCH_WIDTH / 2 + Math.cos(q.number) * 120, setPieceRunSpeed(q), dt);
          }
        }
      }
    } else if (sp.type === 'penalty') {
      // Only taker + keeper in the box; everyone else clears outside it.
      const keeperTeam = sp.team === 'home' ? 'away' : 'home';
      const keeper = allPlayers.find(q => q.team === keeperTeam && q.position === 'GK');
      const penGoal = attackGoalFor(sp.team ?? 'home', this.state.half);
      if (keeper) {
        keeper.state = 'running';
        steerPlayerTo(keeper, penGoal.x + (defendsLeft(keeperTeam, this.state.half) ? 30 : -30), penGoal.center.y, setPieceRunSpeed(keeper), dt);
      }
      for (const q of allPlayers) {
        if (q.sentOff || q.id === sp.kickerId || q.position === 'GK') continue;
        const attacksRight = attackDirFor(sp.team ?? 'home', this.state.half) === 1;
        const inBox = (attacksRight ? q.x > PITCH_LENGTH - 190 : q.x < 190)
          && q.y > 150 && q.y < PITCH_WIDTH - 150;
        if (inBox) {
          q.state = 'running';
          steerPlayerTo(q, attacksRight ? PITCH_LENGTH - 230 : 230, q.y, setPieceRunSpeed(q), dt);
        }
      }
    }

    // Position teammates & defenders during preparation (run, never snap)
    if (sp.type === 'corner_kick') {
      const isRight = sp.spot.x > PITCH_LENGTH / 2;
      const boxX = isRight ? PITCH_LENGTH - 110 : 110;
      for (const q of allPlayers) {
        if (q.id !== sp.kickerId && !q.sentOff) {
          // Crowd into penalty box!
          const targetX = boxX + (Math.sin(q.number) * 60);
          const targetY = PITCH_WIDTH / 2 + (Math.cos(q.number) * 120);
          q.state = 'running';
          steerPlayerTo(q, targetX, targetY, setPieceRunSpeed(q), dt);
        }
      }
    } else if (sp.type === 'goal_kick') {
      // GOAL-KICK SAFETY: while the kick is set up and taken, opponents
      // must not press the taker — anyone inside the kicking team's box
      // (plus a margin) retreats outside it instead of charging the keeper.
      const kickingDefendsLeft = defendsLeft(sp.team ?? 'home', this.state.half);
      const boxDepth = PENALTY_BOX_LENGTH + 45;
      const boxTop = (PITCH_WIDTH - PENALTY_BOX_WIDTH) / 2 - 40;
      const boxBottom = (PITCH_WIDTH + PENALTY_BOX_WIDTH) / 2 + 40;
      for (const opp of allPlayers) {
        if (opp.team === sp.team || opp.sentOff || opp.position === 'GK') continue;
        const inside = kickingDefendsLeft
          ? opp.x < boxDepth && opp.y > boxTop && opp.y < boxBottom
          : opp.x > PITCH_LENGTH - boxDepth && opp.y > boxTop && opp.y < boxBottom;
        if (inside) {
          opp.state = 'running';
          const retreatX = kickingDefendsLeft ? boxDepth + 40 : PITCH_LENGTH - boxDepth - 40;
          steerPlayerTo(opp, retreatX, Math.max(50, Math.min(PITCH_WIDTH - 50, opp.y)), setPieceRunSpeed(opp) * 1.35, dt);
        }
      }
      // Defenders spread far wide to provide build-up channels and not crowd keeper!
      const teammates = allPlayers.filter(q => q.team === sp.team && q.id !== sp.kickerId && !q.sentOff);
      const spreadX = kickingDefendsLeft ? 280 : PITCH_LENGTH - 280;
      const defenders = teammates.filter(q => q.position === 'DF');
      if (defenders[0]) {
        defenders[0].state = 'running';
        steerPlayerTo(defenders[0], spreadX, 95, setPieceRunSpeed(defenders[0]), dt);
      }
      if (defenders[1]) {
        defenders[1].state = 'running';
        steerPlayerTo(defenders[1], spreadX, PITCH_WIDTH - 95, setPieceRunSpeed(defenders[1]), dt);
      }
    } else if (sp.type === 'throw_in') {
      // THROW-IN SAFETY: opponents must give the thrower space (min 80 units
      // from the spot). Anyone closer retreats infield.
      for (const opp of allPlayers) {
        if (opp.team === sp.team || opp.sentOff || opp.position === 'GK') continue;
        if (opp.id === sp.kickerId) continue;
        const d = dist(opp.x, opp.y, sp.spot.x, sp.spot.y);
        if (d < 80) {
          // Retreat infield: push away from touchline toward pitch center
          const dirX = sp.spot.x - opp.x;
          const dirY = sp.spot.y - opp.y;
          const len = Math.hypot(dirX, dirY) || 1;
          // Move to 90 units away, biased infield (toward center Y)
          const targetX = sp.spot.x - (dirX / len) * 90;
          const centerBiasY = PITCH_WIDTH / 2;
          const targetY = sp.spot.y - (dirY / len) * 60 * 0.5 + centerBiasY * 0.1;
          opp.state = 'running';
          steerPlayerTo(opp,
            Math.max(40, Math.min(PITCH_LENGTH - 40, targetX)),
            Math.max(40, Math.min(PITCH_WIDTH - 40, targetY)),
            setPieceRunSpeed(opp) * 1.2, dt);
        }
      }
    }

    // Goal-kick take gate: the kick is taken once the taker walked up AND
    // opponents have retreated outside the box (or the fallback timer fires,
    // so play can never stall on a straggler).
    // Fix 3 — free-kick tempo: free kicks use a longer walk-up (place the
    // ball, ~1-2s delay) matching the other set-piece routines.
    const takeGate = sp.type === 'free_kick' ? FREE_KICK_TEMPO_SECONDS : sp.type === 'penalty' ? 2.5 : 1.0;
    let takeReady: boolean = sp.timer > takeGate && taker !== undefined && takerArrived;
    if (takeReady && sp.type === 'goal_kick' && sp.team && sp.timer < 2.5) {
      const kickingDefendsLeft = defendsLeft(sp.team, this.state.half);
      const boxDepth = PENALTY_BOX_LENGTH + 45;
      const boxTop = (PITCH_WIDTH - PENALTY_BOX_WIDTH) / 2 - 40;
      const boxBottom = (PITCH_WIDTH + PENALTY_BOX_WIDTH) / 2 + 40;
      for (const q of allPlayers) {
        if (q.team === sp.team || q.sentOff || q.position === 'GK') continue;
        const inside = kickingDefendsLeft
          ? q.x < boxDepth && q.y > boxTop && q.y < boxBottom
          : q.x > PITCH_LENGTH - boxDepth && q.y > boxTop && q.y < boxBottom;
        if (inside) {
          takeReady = false;
          break;
        }
      }
    }
    // THROW-IN RETREAT GATE: wait until opponents have stepped back (80+ units
    // from spot), with a 4s fallback so play never stalls on a straggler.
    if (takeReady && sp.type === 'throw_in' && sp.timer < 4.0) {
      for (const q of allPlayers) {
        if (q.team === sp.team || q.sentOff || q.position === 'GK') continue;
        if (q.id === sp.kickerId) continue;
        if (dist(q.x, q.y, sp.spot.x, sp.spot.y) < 80) {
          takeReady = false;
          break;
        }
      }
    }

    // ROUND 3 FIX: corner execution must ALWAYS produce a kick into the
    // box — absolute fallback so the taker can never run/dribble from a
    // corner setup. If the walk-up stalls, deliver from the spot anyway.
    if (sp.type === 'corner_kick' && taker && !takeReady && sp.timer > 3.5 && this.state.setPiece.type !== null) {
      taker.state = 'kicking';
      taker.stateTimer = 0;
      taker.hasBall = false;
      executeCornerVariant(taker, pickCornerVariant(taker, this.spCtx(dt), sp.spot), this.spCtx(dt));
      this.ball.secondTouchBlockId = taker.id;
      this.state.setPiece.type = null;
      this.state.setPiece.kickerId = null;
      return;
    }

    // Execute the kick / throw once ready (after ~1.0s AND taker walked up)
    if (takeReady && taker) {
      const attackDir = attackDirFor(sp.team ?? 'home', this.state.half);

      if (sp.type === 'throw_in') {
        // AUTHENTIC OVERHEAD SOCCER THROW-IN (Not a kick!)
        taker.state = 'throwing';
        taker.stateTimer = 0;
        taker.hasBall = false;
        (this.ball as any).carrierId = null;

        // Short-to-feet vs long-down-the-line, picked contextually.
        const throwMates = allPlayers.filter(q => q.team === sp.team && q.id !== sp.kickerId && q.position !== 'GK' && !q.sentOff);
        const throwDir = attackDir;
        const throwPick = pickThrowVariant(taker, throwMates, this.spCtx(dt), throwDir);
        executeThrowVariant(taker, throwPick.target, throwPick.variant, this.spCtx(dt), sp.spot, throwDir);

        setTimeout(() => {
          if (taker.state === 'throwing') taker.state = 'running';
        }, 300);

        // Fix 1 — second-touch rule: throw-in taker cannot re-collect first.
        this.ball.secondTouchBlockId = taker.id;
        // Conclude set piece!
        this.state.setPiece.type = null;
        this.state.setPiece.kickerId = null;
        // Start the post-throw-in grace window so the receiver is not instantly dispossessed.
        this.throwInGrace = 2.0;
        return;
      }

      taker.state = 'kicking';
      taker.stateTimer = 0;
      taker.hasBall = false;

      if (sp.type === 'corner_kick') {
        // Inswinger / outswinger / short, gated by the taker's technique.
        executeCornerVariant(taker, pickCornerVariant(taker, this.spCtx(dt), sp.spot), this.spCtx(dt));
      } else if (sp.type === 'goal_kick') {
        // Proper FOOT goal kick from the ground (short build-up vs long
        // downfield). Never a hand distribution — those are only for the
        // keeper releasing a live held ball.
        const gkDir = attackDir;
        taker.state = 'kicking';
        taker.stateTimer = 0;
        executeGoalKick(taker, this.spCtx(dt), gkDir);
      } else if (sp.type === 'free_kick') {
        // The wall leaps as the kick is struck over it (only when a wall formed).
        const wallTeam = sp.team === 'home' ? 'away' : 'home';
        const wall = allPlayers.filter(q => q.team === wallTeam && q.position !== 'GK' && !q.sentOff && q.state === 'blocking');
        if (wall.length > 0) wallJump(this.spCtx(dt), wall);
        setTimeout(() => {
          for (const d of wall) {
            if (d.z !== 0) d.z = 0;
          }
        }, 450);
        // Direct shot in range, delivery into the box from deep.
        const attacking = attackGoalFor(sp.team ?? 'home', this.state.half);
        executeFreeKickVariant(taker, pickFreeKickVariant(taker, sp.spot, attacking), this.spCtx(dt), attacking);
      } else if (sp.type === 'penalty') {
        // Placement vs power; the keeper reads a side and dives.
        const keeperTeam = sp.team === 'home' ? 'away' : 'home';
        const keeper = allPlayers.find(q => q.team === keeperTeam && q.position === 'GK');
        const attacking = attackGoalFor(sp.team ?? 'home', this.state.half);
        const plan = pickPenaltyVariant(taker, attacking);
        if (keeper) penaltyKeeperDive(keeper, plan, defendsLeft(keeperTeam, this.state.half));
        executePenaltyVariant(taker, plan, this.spCtx(dt), attacking);
      }

      // Fix 1 — second-touch rule: the taker cannot re-collect until another
      // player touches the ball. Armed at delivery; lifted in update() once
      // ball.lastTouchPlayerId changes away from the taker.
      if (taker && (sp.type === 'corner_kick' || sp.type === 'free_kick' || sp.type === 'goal_kick' || sp.type === 'penalty')) {
        this.ball.secondTouchBlockId = taker.id;
      }

      // Conclude set piece!
      this.state.setPiece.type = null;
      this.state.setPiece.kickerId = null;
    }
  }

  /**
   * Boundary checks (Out over Sideline = Throw-in, Out over Endline = Corner or Goal Kick)
   */
  private handleBoundaries() {
    if (this.state.isGoalSequence || this.state.setPiece.type !== null) return;

    // 1. Sideline Out (Throw-in)
    if (this.ball.y < -2 || this.ball.y > PITCH_WIDTH + 2) {
      soundEngine.playWhistle(true);
      const throwInTeam = this.ball.lastTouchTeam === 'home' ? 'away' : 'home';
      const clampX = Math.max(30, Math.min(PITCH_LENGTH - 30, this.ball.x));
      const touchY = this.ball.y < 0 ? 0 : PITCH_WIDTH;

      if (throwInTeam === 'home') this.stats.homeThrowIns++;
      else this.stats.awayThrowIns++;

      const teamName = throwInTeam === 'home' ? this.homeTeam.name : this.awayTeam.name;
      this.addCommentary(`Ball out of play! Throw-in for ${teamName}!`, 'out', throwInTeam);

      this.setupSetPiece('throw_in', throwInTeam, { x: clampX, y: touchY });
      return;
    }

    // 2. Endline Out (Corner Kick vs Goal Kick)
    // Ends swap at half-time: each end is defended by ownGoalFor(team, half),
    // so the corner / goal-kick ruling follows the defended ends, not names.
    const half = this.state.half;
    const defendsRightTeam: 'home' | 'away' =
      ownGoalFor('home', half).x === PITCH_LENGTH ? 'home' : 'away';
    const defendsLeftTeam: 'home' | 'away' =
      defendsRightTeam === 'home' ? 'away' : 'home';
    const teamName = (t: 'home' | 'away'): string =>
      t === 'home' ? this.homeTeam.name : this.awayTeam.name;
    // Check Right Endline (X > PITCH_LENGTH)
    if (this.ball.x > PITCH_LENGTH + 2) {
      // Check if it was NOT a goal
      const inGoalMouth = this.ball.y >= RIGHT_GOAL.yMin && this.ball.y <= RIGHT_GOAL.yMax && this.ball.z <= GOAL_HEIGHT;
      if (!inGoalMouth) {
        soundEngine.playWhistle(true);
        // If last touched by the team defending this end -> Corner for the attackers!
        if (this.ball.lastTouchTeam === defendsRightTeam) {
          const cornerTeam: 'home' | 'away' = defendsLeftTeam;
          if (cornerTeam === 'home') this.stats.homeCorners++;
          else this.stats.awayCorners++;
          const cornerSpot = this.ball.y < PITCH_WIDTH / 2 ? CORNER_SPOTS.rightTop : CORNER_SPOTS.rightBottom;
          this.addCommentary(`Deflected out! CORNER KICK for ${teamName(cornerTeam)}!`, 'corner', cornerTeam);
          this.setupSetPiece('corner_kick', cornerTeam, cornerSpot);
        } else {
          // Last touched by the attackers -> Goal kick for the defending team!
          this.addCommentary(`Shot flies wide! Goal kick for ${teamName(defendsRightTeam)}.`, 'out', defendsRightTeam);
          this.setupSetPiece('goal_kick', defendsRightTeam, GOAL_KICK_SPOTS.away);
        }
        return;
      }
    }

    // Check Left Endline (X < -2)
    if (this.ball.x < -2) {
      const inGoalMouth = this.ball.y >= LEFT_GOAL.yMin && this.ball.y <= LEFT_GOAL.yMax && this.ball.z <= GOAL_HEIGHT;
      if (!inGoalMouth) {
        soundEngine.playWhistle(true);
        // If last touched by the team defending this end -> Corner for the attackers!
        if (this.ball.lastTouchTeam === defendsLeftTeam) {
          const cornerTeam: 'home' | 'away' = defendsRightTeam;
          if (cornerTeam === 'home') this.stats.homeCorners++;
          else this.stats.awayCorners++;
          const cornerSpot = this.ball.y < PITCH_WIDTH / 2 ? CORNER_SPOTS.leftTop : CORNER_SPOTS.leftBottom;
          this.addCommentary(`Deflected behind! CORNER KICK for ${teamName(cornerTeam)}!`, 'corner', cornerTeam);
          this.setupSetPiece('corner_kick', cornerTeam, cornerSpot);
        } else {
          // Last touched by the attackers -> Goal kick for the defending team!
          this.addCommentary(`Shot goes wide! Goal kick for ${teamName(defendsLeftTeam)}.`, 'out', defendsLeftTeam);
          this.setupSetPiece('goal_kick', defendsLeftTeam, GOAL_KICK_SPOTS.home);
        }
        return;
      }
    }
  }

  /**
   * Authentic Mini Soccer Kickoff Initiation:
   * Sets up 2 players at the center spot (kicker + partner), enforces opponent clearance outside circle,
   * blows referee whistle, and conducts kickoff tap before releasing play!
   */
  /**
   * Kickoff mark for one player: where they must stand for a kickoff by
   * kickoffTeam in the current half. In the second half the whole formation
   * mirrors (teams line up on their NEW sides) — a pure function of the
   * half, so both resetKickoff and the run-to-position steering agree.
   */
  private kickoffTarget(
    p: Player,
    kickoffTeam: 'home' | 'away',
    half: MatchHalf,
    kickerId: string | null,
    partnerId: string | null
  ): { x: number; y: number; facing: number } {
    const centerX = PITCH_LENGTH / 2;
    const centerY = PITCH_WIDTH / 2;
    const attackDir = attackDirFor(kickoffTeam, half);
    const facing = attackDir === 1 ? 0 : Math.PI;
    if (p.id === kickerId) {
      // Primary kicker at the ball, facing the partner for the tap-off
      const kickerFacing = Math.PI / 2; // face down toward partner
      return { x: centerX - attackDir * 14, y: centerY, facing: kickerFacing };
    }
    if (p.id === partnerId) {
      // Kickoff partner stands side-by-side with kicker (horizontal line),
      // facing the kicker for the tap-off
      const partnerFacing = -Math.PI / 2; // face up toward kicker
      return { x: centerX - attackDir * 14, y: centerY + 36, facing: partnerFacing };
    }
    if (p.team === kickoffTeam) {
      // Teammates in formation (mirrored in SH), strictly on own side of halfway line
      let x = formationXOf(p, half);
      const y = p.baseHomeY;
      if (defendsLeft(kickoffTeam, half)) {
        if (x > centerX - 60) x = centerX - 80;
      } else {
        if (x < centerX + 60) x = centerX + 80;
      }
      return { x, y, facing };
    }
    // Defending team: formation (mirrored in SH), outside the center circle
    // arc, and strictly inside their own half.
    let x = formationXOf(p, half);
    let y = p.baseHomeY;
    const d = dist(x, y, centerX, centerY);
    if (d < CENTER_CIRCLE_RADIUS + 20) {
      const angle = Math.atan2(y - centerY, x - centerX);
      x = centerX + Math.cos(angle) * (CENTER_CIRCLE_RADIUS + 25);
      y = centerY + Math.sin(angle) * (CENTER_CIRCLE_RADIUS + 25);
    }
    const defendingTeam: 'home' | 'away' = kickoffTeam === 'home' ? 'away' : 'home';
    if (defendsLeft(defendingTeam, half)) {
      if (x > centerX - 35) x = centerX - 60;
    } else {
      if (x < centerX + 35) x = centerX + 60;
    }
    return { x, y, facing };
  }

  /** Are all active players on their kickoff marks (SH run-to-position gate)? */
  private kickoffSidesSet(): boolean {
    const ko = this.state.kickoff;
    for (const q of this.getAllPlayers()) {
      if (q.sentOff) continue;
      const t = this.kickoffTarget(q, ko.team, this.state.half, ko.kickerId, ko.partnerId);
      if (dist(q.x, q.y, t.x, t.y) > 36) return false;
    }
    return true;
  }

  public resetKickoff(kickoffTeam: 'home' | 'away') {
    this.throwInGrace = 0;
    this.ball.secondTouchBlockId = null;
    this.state.isGoalSequence = false;
    this.state.goalScorer = null;
    this.state.goalTeam = null;
    this.state.goalTimer = 0;
    this.state.setPiece.type = null;

    const half = this.state.half;
    const kickingTeamObj = kickoffTeam === 'home' ? this.homeTeam : this.awayTeam;
    const defendingTeamObj = kickoffTeam === 'home' ? this.awayTeam : this.homeTeam;

    const forwards = kickingTeamObj.players.filter(p => p.position === 'FW');
    const kicker = forwards[0] || kickingTeamObj.players[5];
    const partner = forwards[1] || kickingTeamObj.players.find(p => p.position === 'MF') || kickingTeamObj.players[4];

    this.state.kickoff = {
      active: true,
      team: kickoffTeam,
      phase: 'whistle',
      timer: 0,
      kickerId: kicker.id,
      partnerId: partner.id,
    };

    const centerX = PITCH_LENGTH / 2;
    const centerY = PITCH_WIDTH / 2;

    // Reset ball at exact center spot
    this.ball.x = centerX;
    this.ball.y = centerY;
    this.ball.z = 0;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.vz = 0;
    this.ball.carrierId = null;
    this.ball.lastTouchTeam = kickoffTeam;
    this.ball.lastTouchPlayerId = kicker.id;

    // Half-time side switching: in the second half teams line up on their
    // NEW (mirrored) sides and RUN to the marks via velocity steering in
    // updateKickoff — positions are never snapped. First-half kickoffs keep
    // the instant formation reset.
    const steering = isSecondHalf(half);
    const place = (p: Player): void => {
      const t = this.kickoffTarget(p, kickoffTeam, half, kicker.id, partner.id);
      p.z = 0;
      p.vx = 0;
      p.vy = 0;
      p.vz = 0;
      p.hasBall = false;
      p.stateTimer = 0;
      p.targetX = t.x;
      p.targetY = t.y;
      p.facingAngle = t.facing;
      if (steering) {
        p.state = 'running';
      } else {
        p.x = t.x;
        p.y = t.y;
        p.state = 'idle';
      }
    };

    // Position Kickoff Team players strictly in their own half
    // (dismissed players stay down the tunnel).
    for (const p of kickingTeamObj.players) {
      if (p.sentOff) continue;
      place(p);
    }

    // Position Defending Team strictly in their own half AND OUTSIDE center circle!
    // (dismissed players stay down the tunnel).
    for (const opp of defendingTeamObj.players) {
      if (opp.sentOff) continue;
      place(opp);
    }

    // Referee blows the sharp whistle!
    soundEngine.playWhistle(false);
    this.addCommentary(`*WHISTLE* Referee signals KICK OFF for ${kickingTeamObj.name}!`, 'whistle', kickoffTeam);
  }

  /**
   * Step the kickoff sequence until ball is passed into play
   */
  private updateKickoff(dt: number) {
    const ko = this.state.kickoff;
    ko.timer += dt;

    const allPlayers = this.getAllPlayers();
    const kicker = allPlayers.find(p => p.id === ko.kickerId);
    const partner = allPlayers.find(p => p.id === ko.partnerId);

    const centerX = PITCH_LENGTH / 2;
    const centerY = PITCH_WIDTH / 2;
    const half = this.state.half;
    const attackDir = attackDirFor(ko.team, half);

    // Hold ball dead center before kick
    if (ko.phase !== 'kicking') {
      this.ball.x = centerX;
      this.ball.y = centerY;
      this.ball.z = 0;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.ball.vz = 0;
    }

    if (isSecondHalf(half)) {
      // Second-half kickoff: both sides run to their mirrored marks via
      // velocity steering (no snaps). Marks already satisfy restraint shape.
      for (const q of allPlayers) {
        if (q.sentOff) continue;
        const t = this.kickoffTarget(q, ko.team, half, ko.kickerId, ko.partnerId);
        if (dist(q.x, q.y, t.x, t.y) > 30) {
          q.state = 'running';
          steerPlayerTo(q, t.x, t.y, setPieceRunSpeed(q), dt);
        } else if (q.state === 'running') {
          q.state = 'idle';
          q.stateTimer = 0;
        }
      }
    } else {
      // Restrain opponent players strictly outside center circle and behind halfway line.
      // Run-based restraint only (no snaps): steer violators back via velocity.
      for (const q of allPlayers) {
        if (q.team !== ko.team) {
          let holdX: number | null = null;
          let holdY: number | null = null;
          if (attackDir === 1 && q.x < centerX + 30) {
            holdX = centerX + 30;
            holdY = q.y;
          } else if (attackDir === -1 && q.x > centerX - 30) {
            holdX = centerX - 30;
            holdY = q.y;
          }
          const d = dist(q.x, q.y, centerX, centerY);
          if (d < CENTER_CIRCLE_RADIUS + 15) {
            const angle = Math.atan2(q.y - centerY, q.x - centerX);
            const a = Number.isFinite(angle) ? angle : 0;
            holdX = centerX + Math.cos(a) * (CENTER_CIRCLE_RADIUS + 20);
            holdY = centerY + Math.sin(a) * (CENTER_CIRCLE_RADIUS + 20);
          }
          if (holdX !== null && holdY !== null) {
            q.state = 'running';
            steerPlayerTo(q, holdX, holdY, setPieceRunSpeed(q), dt);
          }
        }
      }
    }

    // Phase 1 -> Phase 2: Kicker makes the short tap/pass to partner after whistle.
    // In SH the tap waits until both sides have run to their mirrored marks
    // (with a timer fallback so play can never stall on a straggler).
    const sidesSet = half !== 'SH' || ko.timer > 5 || this.kickoffSidesSet();
    if (ko.timer > 0.65 && ko.phase === 'whistle' && kicker && partner && sidesSet) {
      ko.phase = 'kicking';
      kicker.state = 'kicking';
      kicker.stateTimer = 0;

      const angle = Math.atan2(partner.y - kicker.y, partner.x - kicker.x);
      kicker.facingAngle = angle;

      const passSpeed = 260;
      this.ball.vx = Math.cos(angle) * passSpeed;
      this.ball.vy = Math.sin(angle) * passSpeed;
      this.ball.vz = 0;

      soundEngine.playKick(0.5);
      this.addCommentary(`${kicker.name} lays the ball off to ${partner.name}! Match is ALIVE!`, 'kickoff', ko.team);
    }

    // Phase 2 -> Done: Partner receives the pass, kicking off full-match gameplay!
    if (ko.phase === 'kicking' && partner) {
      updateBallPhysics(this.ball, dt);
      const dToPartner = dist(this.ball.x, this.ball.y, partner.x, partner.y);
      if (dToPartner < 22 || ko.timer > 1.2) {
        partner.hasBall = true;
        partner.state = 'dribbling';
        partner.stateTimer = 0;
        this.ball.carrierId = partner.id;
        this.ball.lastTouchPlayerId = partner.id;
        this.ball.lastTouchTeam = ko.team;
        ko.active = false;
        ko.phase = 'done';
      }
    }
  }

  public startSecondHalf() {
    // Guard: never rewind a finished (or not-yet-halftime) match.
    if (this.state.half !== 'HT') return;
    this.halfTimeTimer = 0;
    this.state.half = 'SH';
    this.state.matchMinutes = 45;
    this.state.matchSeconds = 0;
    this.state.showHalfTimeBanner = false;
    this.state.showSecondHalfBanner = true;
    this.state.secondHalfBannerTimer = 0;
    this.resetKickoff('away');
    this.addCommentary('SECOND HALF! Away team to kick off — game on again!', 'kickoff', 'away');
  }

  /**
   * Fix 7 — starting a new match resets ALL match state: score 0-0, clock
   * 0:00, stats cleared, cards cleared, teams back to full strength at
   * their formation spots, ball/block/effects/timers reset.
   */
  public restartFullMatch() {
    this.halfTimeTimer = 0;
    this.simTimeAccumulator = 0;
    this.throwInGrace = 0;
    this.homeTeam.score = 0;
    this.awayTeam.score = 0;
    // Full squads back: cards/fouls cleared, walk-offs cancelled, everyone
    // restored to their formation spots (fix 7: teams back to 11v11 shape).
    for (const q of this.getAllPlayers()) {
      q.yellowCards = 0;
      q.sentOff = false;
      q.foulCount = 0;
      q.walkingOff = false;
      q.walkOffTx = undefined;
      q.walkOffTy = undefined;
      q.hasBall = false;
      q.possessionTime = 0;
      q.possessionDist = 0;
      q.tackleCooldown = 0;
      q.catchCooldown = 0;
      q.state = 'idle';
      q.stateTimer = 0;
      q.vx = 0;
      q.vy = 0;
      q.vz = 0;
      q.z = 0;
      q.x = q.baseHomeX;
      q.y = q.baseHomeY;
      q.targetX = q.baseHomeX;
      q.targetY = q.baseHomeY;
      q.currentStamina = 100;
    }
    // Stat sheet fully cleared (fix 7: nothing carries over).
    this.stats = {
      homePossessionTime: 0,
      awayPossessionTime: 0,
      homeShots: 0,
      awayShots: 0,
      homeShotsOnTarget: 0,
      awayShotsOnTarget: 0,
      homePasses: 0,
      awayPasses: 0,
      homeTackles: 0,
      awayTackles: 0,
      homeSaves: 0,
      awaySaves: 0,
      homeCorners: 0,
      awayCorners: 0,
      homeThrowIns: 0,
      awayThrowIns: 0,
      homeFouls: 0,
      awayFouls: 0,
      homeYellows: 0,
      awayYellows: 0,
      homeReds: 0,
      awayReds: 0,
    };
    this.ball.secondTouchBlockId = null;
    this.visualEffects = [];
    this.state.referee = createReferee();
    this.state.cardBanner = null;
    drainFoulEvents();
    this.state.half = 'FH';
    this.state.matchMinutes = 0;
    this.state.matchSeconds = 0;
    this.state.showHalfTimeBanner = false;
    this.state.showSecondHalfBanner = false;
    this.state.secondHalfBannerTimer = 0;
    this.state.showFullTimeBanner = false;
    this.state.selectedPlayerId = 'h2';
    this.resetKickoff('home');
  }

  /**
   * Freeze the ball and set every player idle for a break whistle
   * (half-time / full-time). Positions are kept; the SH kickoff re-forms.
   */
  private stopPlayForBreak() {
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.vz = 0;
    this.ball.carrierId = null;
    for (const p of this.getAllPlayers()) {
      p.vx = 0;
      p.vy = 0;
      p.vz = 0;
      p.hasBall = false;
      p.state = 'idle';
      p.stateTimer = 0;
      p.z = 0; // ground everyone: no stuck dive elevation over the break
    }
  }

  private updateVisualEffects(dt: number) {
    for (let i = this.visualEffects.length - 1; i >= 0; i--) {
      const eff = this.visualEffects[i];
      eff.life += dt / eff.maxLife;
      if (eff.life >= 1) {
        this.visualEffects.splice(i, 1);
      }
    }
  }
}

