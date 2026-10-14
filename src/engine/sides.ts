/**
 * Half-time side switching — single source of truth for which goal each
 * team attacks / defends in each half.
 *
 * Like real soccer, teams swap ends at half-time:
 *  - First half:  home attacks the RIGHT goal, away attacks the LEFT goal.
 *  - Second half: home attacks the LEFT goal,  away attacks the RIGHT goal.
 *
 * All direction logic (AI target goals, keeper boxes, set-piece walls,
 * penalty spots, goal detection, kickoff halves) must derive from these
 * helpers instead of hardcoding `team === 'home' ? ... : ...`.
 */

import type { MatchHalf, Player, TeamSide } from '../types/soccer';
import { LEFT_GOAL, PITCH_LENGTH, RIGHT_GOAL } from './physics';

export type GoalFrame = typeof RIGHT_GOAL;

/** Half value or undefined (engine contexts carry it optionally). */
export type HalfLike = MatchHalf | undefined;

/** True once teams have swapped ends (half === 'SH'). */
export function isSecondHalf(half: HalfLike): boolean {
  return half === 'SH';
}

/**
 * The goal a team attacks: RIGHT for home in FH / away in SH, LEFT otherwise.
 */
export function attackGoalFor(team: TeamSide, half: HalfLike): GoalFrame {
  const swapped = isSecondHalf(half);
  if (team === 'home') return swapped ? LEFT_GOAL : RIGHT_GOAL;
  return swapped ? RIGHT_GOAL : LEFT_GOAL;
}

/** The goal a team defends: the opposite of what it attacks. */
export function ownGoalFor(team: TeamSide, half: HalfLike): GoalFrame {
  const attacked = attackGoalFor(team, half);
  return attacked.x === LEFT_GOAL.x ? RIGHT_GOAL : LEFT_GOAL;
}

/**
 * Attack direction along x: +1 when attacking right, -1 when attacking left.
 * (home: +1 in FH, -1 in SH; away: -1 in FH, +1 in SH.)
 */
export function attackDirFor(team: TeamSide, half: HalfLike): 1 | -1 {
  return attackGoalFor(team, half).x === 0 ? -1 : 1;
}

/** True when the team's own goal is the LEFT goal (defends the left end). */
export function defendsLeft(team: TeamSide, half: HalfLike): boolean {
  return ownGoalFor(team, half).x === LEFT_GOAL.x;
}

/** Mirror an x coordinate horizontally (swap ends). */
export function mirrorX(x: number): number {
  return PITCH_LENGTH - x;
}

/**
 * Effective formation x for a player in a given half. Base formation spots
 * are stored in FH orientation; in the second half the whole shape mirrors
 * so teams hold the opposite end. (Y is unchanged by the swap.)
 */
export function formationX(baseHomeX: number, half: HalfLike): number {
  return isSecondHalf(half) ? mirrorX(baseHomeX) : baseHomeX;
}

/** Convenience over formationX for a player record. */
export function formationXOf(player: Player, half: HalfLike): number {
  return formationX(player.baseHomeX, half);
}
