/**
 * Physics and Isometric Projection Engine for Pocket League Match Day
 */

import { Ball, Player } from '../types/soccer';

export const PITCH_LENGTH = 1100; // World units along length (Left to Right)
export const PITCH_WIDTH = 680;   // World units along width (Fence to Touchline)
export const GOAL_WIDTH = 140;    // Goal opening along width
export const GOAL_DEPTH = 55;     // Goal net depth
export const GOAL_HEIGHT = 60;    // Crossbar height
export const PENALTY_BOX_LENGTH = 180;
export const PENALTY_BOX_WIDTH = 340;
export const GOAL_AREA_LENGTH = 70;
export const GOAL_AREA_WIDTH = 180;
export const CENTER_CIRCLE_RADIUS = 105;

// Isometric transformation parameters
// Pitch length (+x) goes up-right
// Pitch width (+y) goes down-right
export const ISO_COS = 0.866; // cos(30 deg)
export const ISO_SIN = 0.5;   // sin(30 deg)
export const ISO_TILT = 0.58; // Isometric elevation compression

export interface Point2D {
  x: number;
  y: number;
}

export interface Camera {
  x: number; // world center
  y: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Converts world (x, y, z) to screen pixel coordinates
 */
export function worldToScreen(
  wx: number,
  wy: number,
  wz: number = 0,
  camera: Camera
): Point2D {
  // Relative to camera focus in world coords
  const relX = wx - camera.x;
  const relY = wy - camera.y;

  // Isometric projection
  // +x moves right and up
  // +y moves right and down
  const isoX = (relX + relY) * ISO_COS * camera.zoom;
  const isoY = (-relX + relY) * ISO_SIN * ISO_TILT * camera.zoom - wz * camera.zoom;

  return {
    x: isoX + camera.viewportWidth / 2,
    y: isoY + camera.viewportHeight / 2,
  };
}

/**
 * Inverse conversion: screen pixel (sx, sy) on pitch ground (z=0) to world (wx, wy)
 */
export function screenToWorld(
  sx: number,
  sy: number,
  camera: Camera
): Point2D {
  const normX = (sx - camera.viewportWidth / 2) / (ISO_COS * camera.zoom);
  const normY = (sy - camera.viewportHeight / 2) / (ISO_SIN * ISO_TILT * camera.zoom);

  // normX = relX + relY
  // normY = -relX + relY
  // relY = (normX + normY) / 2
  // relX = (normX - normY) / 2
  const relY = (normX + normY) / 2;
  const relX = (normX - normY) / 2;

  return {
    x: relX + camera.x,
    y: relY + camera.y,
  };
}

/**
 * Calculates Euclidean distance between two points on the pitch
 */
export function dist(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Goal bounds
 */
export const LEFT_GOAL = {
  x: 0,
  yMin: (PITCH_WIDTH - GOAL_WIDTH) / 2,
  yMax: (PITCH_WIDTH + GOAL_WIDTH) / 2,
  center: { x: 0, y: PITCH_WIDTH / 2 },
  backX: -GOAL_DEPTH,
};

export const RIGHT_GOAL = {
  x: PITCH_LENGTH,
  yMin: (PITCH_WIDTH - GOAL_WIDTH) / 2,
  yMax: (PITCH_WIDTH + GOAL_WIDTH) / 2,
  center: { x: PITCH_LENGTH, y: PITCH_WIDTH / 2 },
  backX: PITCH_LENGTH + GOAL_DEPTH,
};

/**
 * Check if ball is inside a goal.
 *
 * Teams swap ends at half-time, so which team a goal credits depends on the
 * half: first half the home side attacks RIGHT (away attacks LEFT); second
 * half it is the other way round. A ball in the LEFT goal in the second
 * half is therefore a HOME goal.
 */
export function checkGoal(ball: Ball, half?: 'FH' | 'HT' | 'SH' | 'FT'): 'home' | 'away' | null {
  // Goal condition: Ball crosses goal line within goal posts and under crossbar
  const swapped = half === 'SH';
  if (ball.z <= GOAL_HEIGHT + 5) {
    // Check right goal (attacked by Home in FH, by Away in SH)
    if (ball.x >= RIGHT_GOAL.x && ball.x <= RIGHT_GOAL.backX) {
      if (ball.y >= RIGHT_GOAL.yMin - 5 && ball.y <= RIGHT_GOAL.yMax + 5) {
        return swapped ? 'away' : 'home';
      }
    }
    // Check left goal (attacked by Away in FH, by Home in SH)
    if (ball.x <= LEFT_GOAL.x && ball.x >= LEFT_GOAL.backX) {
      if (ball.y >= LEFT_GOAL.yMin - 5 && ball.y <= LEFT_GOAL.yMax + 5) {
        return swapped ? 'home' : 'away';
      }
    }
  }
  return null;
}

/**
 * Shortest distance from a 2D point to a segment (for swept woodwork checks).
 */
function segPointDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Step ball physics with friction, air drag, gravity and ground bounce
 */
export function updateBallPhysics(ball: Ball, dt: number): void {
  const GRAVITY = 720;
  const GROUND_FRICTION = 0.988;
  const AIR_DRAG = 0.996;
  const BOUNCE_RESTITUTION = 0.62;

  // Previous position: the swept woodwork check below tests the whole
  // prev->cur segment so fast shots cannot tunnel through the frame.
  const prevX = ball.x;
  const prevY = ball.y;
  const prevZ = ball.z;
  if (ball.woodworkCooldown !== undefined && ball.woodworkCooldown > 0) {
    ball.woodworkCooldown = Math.max(0, ball.woodworkCooldown - dt);
  }

  // Apply velocity
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  // Gravity if above ground
  if (ball.z > 0) {
    ball.vz -= GRAVITY * dt;
    ball.vx *= Math.pow(AIR_DRAG, dt * 60);
    ball.vy *= Math.pow(AIR_DRAG, dt * 60);
  } else {
    // On ground
    ball.z = 0;
    if (ball.vz < -10) {
      // Bounce
      ball.vz = -ball.vz * BOUNCE_RESTITUTION;
    } else {
      ball.vz = 0;
    }
    // Ground friction
    ball.vx *= Math.pow(GROUND_FRICTION, dt * 60);
    ball.vy *= Math.pow(GROUND_FRICTION, dt * 60);
  }

  // Rotation spin based on horizontal speed
  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  ball.rotationAngle += speed * dt * 0.05;

  // Global speed cap: no ball should move faster than 280 units/sec (total 3D speed).
  // This prevents "teleport" effects where the ball crosses the pitch in
  // a few frames, making the camera whip unnaturally.
  const MAX_BALL_SPEED = 280;
  const totalSpeed = Math.hypot(ball.vx, ball.vy, ball.vz);
  if (totalSpeed > MAX_BALL_SPEED) {
    const scale = MAX_BALL_SPEED / totalSpeed;
    ball.vx *= scale;
    ball.vy *= scale;
    ball.vz *= scale;
  }

  // Goal-frame physics: posts at the goal-mouth edges and the crossbar.
  // Swept segment tests (prev->cur) so pacey shots bounce off the woodwork
  // instead of phasing through it. Sets ball.woodworkHit for commentary.
  if ((ball.woodworkCooldown ?? 0) <= 0) {
    const frames = [
      { gx: RIGHT_GOAL.x, dir: 1 as const },
      { gx: LEFT_GOAL.x, dir: -1 as const },
    ];
    for (const frame of frames) {
      if (ball.woodworkHit) break;
      // Posts: vertical cylinders at the mouth edges, full bar height.
      // (Both goals share the same mouth edges.)
      if (ball.z <= GOAL_HEIGHT + 4) {
        for (const postY of [RIGHT_GOAL.yMin, RIGHT_GOAL.yMax]) {
          const dPost = segPointDist(postY, frame.gx, prevY, prevX, ball.y, ball.x);
          if (dPost < 9) {
            // OFF THE POST! Back out in front of goal, onward into play.
            ball.x = frame.gx - frame.dir * 10;
            ball.y = postY + (ball.y < PITCH_WIDTH / 2 ? -10 : 10);
            ball.vx = -frame.dir * Math.abs(ball.vx) * 0.75;
            ball.vy += (ball.y < PITCH_WIDTH / 2 ? -130 : 130);
            ball.woodworkHit = 'post';
            ball.woodworkCooldown = 0.6;
            break;
          }
        }
      }
      if (ball.woodworkHit) break;
      // Crossbar: horizontal bar across the mouth at GOAL_HEIGHT.
      if (prevX !== ball.x) {
        const t = (frame.gx - prevX) / (ball.x - prevX);
        if (t >= 0 && t <= 1) {
          const yc = prevY + (ball.y - prevY) * t;
          const zc = prevZ + (ball.z - prevZ) * t;
          if (yc >= LEFT_GOAL.yMin - 4 && yc <= LEFT_GOAL.yMax + 4 && Math.abs(zc - GOAL_HEIGHT) < 10) {
            // OFF THE BAR! Down and away from goal.
            ball.x = frame.gx - frame.dir * 10;
            ball.vx = -frame.dir * Math.abs(ball.vx) * 0.7;
            ball.vz = -Math.abs(ball.vz) * 0.6;
            ball.woodworkHit = 'bar';
            ball.woodworkCooldown = 0.6;
          }
        }
      }
    }
  }

  // Goal net containment — soft catch, not bouncy
  // Check if ball is inside either goal area
  const inRightGoal = ball.x > RIGHT_GOAL.x && ball.x <= RIGHT_GOAL.backX + 10 &&
    ball.y >= RIGHT_GOAL.yMin - 5 && ball.y <= RIGHT_GOAL.yMax + 5;
  const inLeftGoal = ball.x < LEFT_GOAL.x && ball.x >= LEFT_GOAL.backX - 10 &&
    ball.y >= LEFT_GOAL.yMin - 5 && ball.y <= LEFT_GOAL.yMax + 5;
  
  if (inRightGoal || inLeftGoal) {
    const goal = inRightGoal ? RIGHT_GOAL : LEFT_GOAL;
    const backX = goal.backX;
    
    // Back net: soft stop
    if (inRightGoal && ball.x > backX) {
      ball.x = backX;
      ball.vx = -Math.abs(ball.vx) * 0.15; // soft, not bouncy
      ball.vy *= 0.5;
      ball.vz *= 0.5;
    }
    if (inLeftGoal && ball.x < backX) {
      ball.x = backX;
      ball.vx = Math.abs(ball.vx) * 0.15;
      ball.vy *= 0.5;
      ball.vz *= 0.5;
    }
    
    // Side nets: contain
    if (ball.y < goal.yMin) {
      ball.y = goal.yMin;
      ball.vy = Math.abs(ball.vy) * 0.2;
    }
    if (ball.y > goal.yMax) {
      ball.y = goal.yMax;
      ball.vy = -Math.abs(ball.vy) * 0.2;
    }
    
    // Top net: contain
    if (ball.z > GOAL_HEIGHT) {
      ball.z = GOAL_HEIGHT;
      ball.vz = -Math.abs(ball.vz) * 0.2;
    }
    
    // Heavy damping inside net (ball settles quickly)
    ball.vx *= 0.92;
    ball.vy *= 0.92;
    ball.vz *= 0.92;
  }

  // Pitch boundaries: if the ball goes out past the touchline, stop it dead
  // (don't bounce) so handleBoundaries sees the true exit spot even if delayed.
  const PADDING = 60;
  if (ball.y < -2 || ball.y > PITCH_WIDTH + 2) {
    ball.vx = 0;
    ball.vy = 0;
  }
  if (ball.y < -PADDING) {
    ball.y = -PADDING;
    ball.vy = -ball.vy * 0.4;
  } else if (ball.y > PITCH_WIDTH + PADDING) {
    ball.y = PITCH_WIDTH + PADDING;
    ball.vy = -ball.vy * 0.4;
  }
}

export const CORNER_SPOTS = {
  leftTop: { x: 4, y: 4 },
  leftBottom: { x: 4, y: PITCH_WIDTH - 4 },
  rightTop: { x: PITCH_LENGTH - 4, y: 4 },
  rightBottom: { x: PITCH_LENGTH - 4, y: PITCH_WIDTH - 4 },
};

export const GOAL_KICK_SPOTS = {
  home: { x: 55, y: PITCH_WIDTH / 2 },
  away: { x: PITCH_LENGTH - 55, y: PITCH_WIDTH / 2 },
};

