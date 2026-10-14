/**
 * Formations — mini-soccer (7-a-side: 1 GK + 6 outfield).
 *
 * Slot positions are NORMALIZED in the FIRST-HALF orientation, using the
 * "defends own goal at x=0" convention: (0,0) is the top-left corner of
 * the half a team defends in FH, (1,1) is the bottom-right of the half
 * it attacks in FH.
 *
 * `applyFormation` writes each slot's world position into the team's
 * baseHomeX/baseHomeY — the same anchors ai.ts, sides.ts and the set-piece
 * code already read from. No other module changes for formations to work.
 */

import type { Player, Role, Team } from '../types/soccer';
import { PITCH_LENGTH, PITCH_WIDTH } from './physics';

export type FormationId =
  | '2-2-2'   // Balanced (classic)
  | '2-3-1'   // Midfield diamond
  | '3-2-1'   // Defensive block
  | '1-3-2'   // Attacking
  | '3-1-2'   // Wing-back width
  | '1-2-3';  // All-out attack

export interface FormationSlot {
  role: Role;
  label: string;   // LB / CB / CM / ST …
  baseX: number;   // 0 = own goal line, 1 = opponent goal line
  baseY: number;   // 0 = top touchline, 1 = bottom touchline
}

export interface Formation {
  id: FormationId;
  name: string;
  slots: FormationSlot[]; // exactly 7; index 0 is the GK slot
}

export const FORMATIONS: Record<FormationId, Formation> = {
  '2-2-2': {
    id: '2-2-2', name: 'Balanced',
    slots: [
      { role: 'GK', label: 'GK', baseX: 0.04, baseY: 0.50 },
      { role: 'DF', label: 'LB', baseX: 0.21, baseY: 0.22 },
      { role: 'DF', label: 'RB', baseX: 0.21, baseY: 0.78 },
      { role: 'MF', label: 'LM', baseX: 0.42, baseY: 0.25 },
      { role: 'MF', label: 'RM', baseX: 0.42, baseY: 0.75 },
      { role: 'FW', label: 'ST', baseX: 0.63, baseY: 0.35 },
      { role: 'FW', label: 'ST', baseX: 0.65, baseY: 0.65 },
    ],
  },
  '2-3-1': {
    id: '2-3-1', name: 'Midfield Diamond',
    slots: [
      { role: 'GK', label: 'GK', baseX: 0.04, baseY: 0.50 },
      { role: 'DF', label: 'LB', baseX: 0.20, baseY: 0.24 },
      { role: 'DF', label: 'RB', baseX: 0.20, baseY: 0.76 },
      { role: 'MF', label: 'LM', baseX: 0.42, baseY: 0.20 },
      { role: 'MF', label: 'CM', baseX: 0.46, baseY: 0.50 },
      { role: 'MF', label: 'RM', baseX: 0.42, baseY: 0.80 },
      { role: 'FW', label: 'ST', baseX: 0.66, baseY: 0.50 },
    ],
  },
  '3-2-1': {
    id: '3-2-1', name: 'Defensive',
    slots: [
      { role: 'GK', label: 'GK', baseX: 0.04, baseY: 0.50 },
      { role: 'DF', label: 'LB', baseX: 0.19, baseY: 0.20 },
      { role: 'DF', label: 'CB', baseX: 0.22, baseY: 0.50 },
      { role: 'DF', label: 'RB', baseX: 0.19, baseY: 0.80 },
      { role: 'MF', label: 'LM', baseX: 0.42, baseY: 0.30 },
      { role: 'MF', label: 'RM', baseX: 0.42, baseY: 0.70 },
      { role: 'FW', label: 'ST', baseX: 0.66, baseY: 0.50 },
    ],
  },
  '1-3-2': {
    id: '1-3-2', name: 'Attacking',
    slots: [
      { role: 'GK', label: 'GK', baseX: 0.04, baseY: 0.50 },
      { role: 'DF', label: 'CB', baseX: 0.22, baseY: 0.50 },
      { role: 'MF', label: 'LM', baseX: 0.42, baseY: 0.20 },
      { role: 'MF', label: 'CM', baseX: 0.45, baseY: 0.50 },
      { role: 'MF', label: 'RM', baseX: 0.42, baseY: 0.80 },
      { role: 'FW', label: 'ST', baseX: 0.64, baseY: 0.35 },
      { role: 'FW', label: 'ST', baseX: 0.64, baseY: 0.65 },
    ],
  },
  '3-1-2': {
    id: '3-1-2', name: 'Wing-Back',
    slots: [
      { role: 'GK', label: 'GK', baseX: 0.04, baseY: 0.50 },
      { role: 'DF', label: 'LB', baseX: 0.20, baseY: 0.18 },
      { role: 'DF', label: 'CB', baseX: 0.22, baseY: 0.50 },
      { role: 'DF', label: 'RB', baseX: 0.20, baseY: 0.82 },
      { role: 'MF', label: 'CM', baseX: 0.46, baseY: 0.50 },
      { role: 'FW', label: 'ST', baseX: 0.64, baseY: 0.32 },
      { role: 'FW', label: 'ST', baseX: 0.64, baseY: 0.68 },
    ],
  },
  '1-2-3': {
    id: '1-2-3', name: 'All-Out Attack',
    slots: [
      { role: 'GK', label: 'GK', baseX: 0.04, baseY: 0.50 },
      { role: 'DF', label: 'CB', baseX: 0.23, baseY: 0.50 },
      { role: 'MF', label: 'LM', baseX: 0.44, baseY: 0.28 },
      { role: 'MF', label: 'RM', baseX: 0.44, baseY: 0.72 },
      { role: 'FW', label: 'LW', baseX: 0.66, baseY: 0.22 },
      { role: 'FW', label: 'ST', baseX: 0.68, baseY: 0.50 },
      { role: 'FW', label: 'RW', baseX: 0.66, baseY: 0.78 },
    ],
  },
};

/**
 * Assign a formation to a team. Rewrites `position` and `baseHomeX/Y` on
 * every player, and teleports them to the formation's first-half mark so
 * a mid-match change takes effect at the next kickoff.
 *
 * Matching rule keeps identity stable across calls:
 *   - GK slot -> declared GK.
 *   - DF/MF/FW slots -> declared DF/MF/FW, in squad-number order.
 *   - Leftover players are force-fit to leftover slots.
 */
export function applyFormation(team: Team, formationId: FormationId): void {
  const formation = FORMATIONS[formationId];
  if (!formation) return;

  const isHome = team.id === 'home';

  const byRole: Record<Role, Player[]> = { GK: [], DF: [], MF: [], FW: [] };
  for (const p of team.players) byRole[p.position as Role].push(p);
  (Object.keys(byRole) as Role[]).forEach(r =>
    byRole[r].sort((a, b) => a.number - b.number)
  );

  const cursor: Record<Role, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
  const taken = new Set<string>();
  const slotsRemaining: FormationSlot[] = [];

  // Pass 1: same-role slots claim same-role players.
  for (const slot of formation.slots) {
    const pool = byRole[slot.role];
    const p = pool[cursor[slot.role]];
    if (p && !taken.has(p.id)) {
      cursor[slot.role]++;
      taken.add(p.id);
      placePlayer(p, slot, isHome);
    } else {
      slotsRemaining.push(slot);
    }
  }

  // Pass 2: leftover players fill leftover slots.
  const unplaced = team.players.filter(p => !taken.has(p.id));
  const n = Math.min(slotsRemaining.length, unplaced.length);
  for (let i = 0; i < n; i++) {
    placePlayer(unplaced[i], slotsRemaining[i], isHome);
  }

  team.formation = formationId;
}

function placePlayer(p: Player, slot: FormationSlot, isHome: boolean): void {
  p.position = slot.role;
  // X-mirrored for the away side; Y stays top-to-bottom for both (matches
  // the existing teamData convention: away defenders keep 0.22/0.78).
  const x = slot.baseX * PITCH_LENGTH;
  p.baseHomeX = isHome ? x : PITCH_LENGTH - x;
  p.baseHomeY = slot.baseY * PITCH_WIDTH;
  // Take effect immediately: teleport to the formation mark.
  p.x = p.baseHomeX;
  p.y = p.baseHomeY;
  p.targetX = p.baseHomeX;
  p.targetY = p.baseHomeY;
  p.vx = 0;
  p.vy = 0;
}

/** UI helper: list every formation id + name. */
export function listFormations(): Array<{ id: FormationId; name: string }> {
  return (Object.keys(FORMATIONS) as FormationId[]).map(id => ({
    id,
    name: FORMATIONS[id].name,
  }));
}
