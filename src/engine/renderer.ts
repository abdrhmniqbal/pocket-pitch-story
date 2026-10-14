/**
 * Canvas 2D Pixel Art Renderer for Pocket League Match Day
 * Renders isometric pitch, chibi characters, net physics, fence, spectators, and VFX.
 */

import { Ball, CameraMode, PitchTheme, Player, Team, VisualEffect } from '../types/soccer';
import { Camera, CENTER_CIRCLE_RADIUS, dist, GOAL_AREA_LENGTH, GOAL_AREA_WIDTH, GOAL_DEPTH, GOAL_HEIGHT, GOAL_WIDTH, ISO_COS, ISO_SIN, ISO_TILT, LEFT_GOAL, PENALTY_BOX_LENGTH, PENALTY_BOX_WIDTH, PITCH_LENGTH, PITCH_WIDTH, Point2D, RIGHT_GOAL, worldToScreen } from './physics';

export interface RenderOptions {
  pitchTheme: PitchTheme;
  cameraMode: CameraMode;
  selectedPlayerId: string;
}

export class SoccerRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private camera: Camera;
  private dirtPattern: CanvasPattern | null = null;
  private grassPattern: CanvasPattern | null = null;

  // Modular chibi sprite parts (heads + bodies composited per player).
  // Preloaded at init; any missing/failed image falls back to procedural art.
  private headSprites: HTMLImageElement[] = [];
  private bodySprites: Record<string, HTMLImageElement> = {};
  private ballSprite: HTMLImageElement | null = null;
  private lastRefereePos: { x: number; y: number } | null = null;
  private fieldTileSprite: HTMLImageElement | null = null;
  private goalSprite: HTMLImageElement | null = null;
  private static readonly BODY_PX = 20; // on-pitch body width
  private static readonly HEAD_PX = 18; // chibi head drawn proportionally large
  private static readonly NECK_OVERLAP_PX = 4; // head overlaps body top

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.camera = {
      x: PITCH_LENGTH * 0.65, // Centered nicely towards the middle-right offensive third
      y: PITCH_WIDTH * 0.45,
      zoom: 1.05,
      viewportWidth: canvas.width,
      viewportHeight: canvas.height,
    };

    this.createSurfacePatterns();
    this.loadPlayerSprites();
  }

  /**
   * Preload modular chibi sprite parts from public/sprites/parts/sliced/.
   * Load failures are tolerated: readiness is checked per-frame and the
   * renderer falls back to the procedural fillRect player.
   */
  private loadPlayerSprites() {
    // Sprites disabled — using fully procedural rendering for consistency.
    // (User request 2026-10-14: remove all sprite usage, use defaults.)
    return;
    if (typeof Image === 'undefined') return;
    const base =
      (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/';
    const v = `?v=ref2`; // cache-bust for referee sprite updates
    const url = (p: string) => (base.endsWith('/') ? base + p : base + '/' + p) + v;
    for (let i = 0; i < 4; i++) {
      const img = new Image();
      img.src = url(`sprites/parts/sliced/head-${i}.png`);
      this.headSprites.push(img);
    }
    const bodies: Record<string, string> = {
      home: 'body-home',
      away: 'body-away',
      gk: 'body-gk',
      'home-run1': 'body-home-run1',
      'home-run2': 'body-home-run2',
      'away-run1': 'body-away-run1',
      'away-run2': 'body-away-run2',
      'gk-run1': 'body-gk-run1',
      'gk-run2': 'body-gk-run2',
      'home-kick': 'body-home-kick',
      'away-kick': 'body-away-kick',
      'gk-kick': 'body-gk-kick',
      'home-celebrate': 'body-home-celebrate',
      'away-celebrate': 'body-away-celebrate',
      'gk-celebrate': 'body-gk-celebrate',
      'home-throw': 'body-home-throw',
      'away-throw': 'body-away-throw',
      'gk-throw': 'body-gk-throw',
      'home-slide': 'body-home-slide',
      'away-slide': 'body-away-slide',
      'gk-slide': 'body-gk-slide',
      'home-prone': 'body-home-prone',
      'away-prone': 'body-away-prone',
      'gk-prone': 'body-gk-prone',
      'referee': 'body-ref',
      'referee-run1': 'body-ref-run1',
      'referee-run2': 'body-ref-run2',
    };
    for (const [key, file] of Object.entries(bodies)) {
      const img = new Image();
      img.src = url(`sprites/parts/sliced/${file}.png`);
      this.bodySprites[key] = img;
    }
    // Ball sprite (pixel art)
    const ballImg = new Image();
    ballImg.src = url(`sprites/parts/sliced/ball-pixel.png?v=pixel1`);
    this.ballSprite = ballImg;
    // Field tile and goal sprites
    this.fieldTileSprite = null;
    const goalImg = new Image();
    goalImg.src = url(`sprites/parts/sliced/goal-iso.png?v=iso1`);
    this.goalSprite = goalImg;
  }

  /** Map hair style to head sprite index (short->0, spiky->1, long->2, bald-band->3). */
  private headIndexForStyle(style: string): number {
    switch (style) {
      case 'short':
        return 0;
      case 'spiky':
        return 1;
      case 'long':
      case 'curly':
      case 'ponytail':
        return 2;
      case 'bald-band':
      case 'buzz':
      case 'bangs':
        return 3;
      default:
        return 0;
    }
  }

  /** Map team/position to body sprite (home->body-home, away->body-away, GK->body-gk). */
  private bodyKeyForPlayer(player: Player): string {
    if (player.position === 'GK') return 'gk';
    return player.team === 'home' ? 'home' : 'away';
  }

  /**
   * Run-cycle body key: idle -> run1 -> idle -> run2 -> idle... based on animFrame.
   * Returns the idle base key when the run frame is not yet loaded (fallback safe).
   */
  private runCycleBodyKey(baseKey: string, animFrame: number): string {
    const step = Math.floor(animFrame * 2) % 4;
    if (step === 1) {
      const run1 = `${baseKey}-run1`;
      return this.spriteReady(this.bodySprites[run1]) ? run1 : baseKey;
    }
    if (step === 3) {
      const run2 = `${baseKey}-run2`;
      return this.spriteReady(this.bodySprites[run2]) ? run2 : baseKey;
    }
    return baseKey;
  }

  /**
   * Pose body key for animation states with dedicated sprites
   * (kick/dive/celebrate/throw/slide/prone). Returns null when the state
   * has no pose sprite (idle/run cycle path). A key for art that failed to
   * load falls back to the idle body at the call site.
   */
  private poseBodyKeyForPlayer(player: Player): string | null {
    const baseKey = this.bodyKeyForPlayer(player);
    switch (player.state) {
      case 'kicking':
        return `${baseKey}-kick`;
      case 'diving':
        // GK dive reuses the arms-overhead throw body, drawn rotated 90deg
        // (see drawChibiPlayer); the dedicated gk-dive sprite was removed.
        return baseKey === 'gk' ? `${baseKey}-throw` : null;
      case 'celebrating':
        return `${baseKey}-celebrate`;
      case 'throwing':
        return `${baseKey}-throw`;
      case 'sliding':
      case 'tackling':
        return `${baseKey}-slide`;
      case 'prone':
        return `${baseKey}-prone`;
      default:
        return null;
    }
  }

  private spriteReady(img: HTMLImageElement | undefined): img is HTMLImageElement {
    return !!img && img.complete && img.naturalWidth > 0;
  }

  /**
   * Per-pose head Y offset in px (positive = head sits lower, toward the neck).
   * Arms-up bodies (throw/celebrate) are taller than the idle body so the
   * neck sits lower in the frame: measured extra height at BODY_PX=20 is
   * ~5-6px (home) up to ~16px (gk-throw); 6px is the compromise fit.
   */
  private headYOffsetForBodyKey(bodyKey: string): number {
    if (bodyKey.endsWith('-throw')) return 6;
    if (bodyKey.endsWith('-celebrate')) return 10;
    return 0;
  }

  /**
   * Draw the head+body composite upright with feet at local (0,0).
   * Body first, then head on top overlapping slightly at the neck.
   * Returns false when sprites are not ready (caller uses procedural fallback).
   */
  private drawSpriteComposite(
    ctx: CanvasRenderingContext2D,
    headIdx: number,
    bodyKey: string
  ): boolean {
    const head = this.headSprites[headIdx];
    const body = this.bodySprites[bodyKey];
    if (!this.spriteReady(head) || !this.spriteReady(body)) return false;
    const bodyW = SoccerRenderer.BODY_PX;
    const bodyH = (bodyW * body.naturalHeight) / body.naturalWidth;
    const headW = SoccerRenderer.HEAD_PX;
    const headH = (headW * head.naturalHeight) / head.naturalWidth;
    const bodyTop = -bodyH;
    ctx.drawImage(body, -bodyW / 2, bodyTop, bodyW, bodyH);
    ctx.drawImage(
      head,
      -headW / 2,
      bodyTop + SoccerRenderer.NECK_OVERLAP_PX - headH + this.headYOffsetForBodyKey(bodyKey),
      headW,
      headH
    );
    return true;
  }

  /** Standing/running composite with horizontal facing flip. Returns false on fallback. */
  private drawStandingSprite(
    px: number,
    py: number,
    player: Player,
    dir: number,
    lean: number,
    bob: number,
    isRunning: boolean = false
  ): boolean {
    const headIdx = this.headIndexForStyle(player.hair.style);
    const baseKey = this.bodyKeyForPlayer(player);
    const bodyKey = isRunning ? this.runCycleBodyKey(baseKey, player.animFrame) : baseKey;
    if (
      !this.spriteReady(this.headSprites[headIdx]) ||
      !this.spriteReady(this.bodySprites[bodyKey])
    ) {
      return false;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(px + lean, py + bob);
    ctx.scale(dir, 1);
    const ok = this.drawSpriteComposite(ctx, headIdx, bodyKey);
    ctx.restore();
    return ok;
  }

  /**
   * Upright pose composite (custom animation sprite + head) with facing flip.
   * The pose art already carries the pose, so no rotation is applied.
   * Returns false when the pose sprite is not ready (caller falls back to
   * the idle body / legacy procedural pose).
   */
  private drawPoseSprite(
    px: number,
    py: number,
    player: Player,
    dir: number,
    poseKey: string
  ): boolean {
    const headIdx = this.headIndexForStyle(player.hair.style);
    if (
      !this.spriteReady(this.headSprites[headIdx]) ||
      !this.spriteReady(this.bodySprites[poseKey])
    ) {
      return false;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(dir, 1);
    const ok = this.drawSpriteComposite(ctx, headIdx, poseKey);
    ctx.restore();
    return ok;
  }

  /**
   * Rotated composite for diving / prone / sliding states.
   * Positive angle lays the sprite head-first toward the facing direction.
   */
  private drawRotatedSprite(
    px: number,
    py: number,
    player: Player,
    dir: number,
    angle: number,
    bodyKeyOverride?: string
  ): boolean {
    const headIdx = this.headIndexForStyle(player.hair.style);
    const bodyKey = bodyKeyOverride ?? this.bodyKeyForPlayer(player);
    if (
      !this.spriteReady(this.headSprites[headIdx]) ||
      !this.spriteReady(this.bodySprites[bodyKey])
    ) {
      return false;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(dir, 1);
    ctx.rotate(angle);
    const ok = this.drawSpriteComposite(ctx, headIdx, bodyKey);
    ctx.restore();
    return ok;
  }

  /** Selection ring + name/position badge for the controlled / on-ball player. */
  private drawPlayerBadge(player: Player, px: number, py: number, isSelected: boolean) {
    if (!isSelected) return;
    const ctx = this.ctx;
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(px, py + 2, 11, 4.5, 0, 0, Math.PI * 2);
    ctx.stroke();

    const label = player.name;
    ctx.font = 'bold 8px monospace';
    const w = ctx.measureText(label).width;
    const lx = Math.round(px - w / 2 - 3);
    const ly = Math.round(py - 46);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(lx, ly, w + 6, 12);
    ctx.fillStyle = '#ffeb3b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, lx + 3, ly + 2);
    ctx.textBaseline = 'alphabetic';
  }

  private createSurfacePatterns() {
    // 1. Dirt pitch texture pattern (as in screenshot)
    const dirtCanvas = document.createElement('canvas');
    dirtCanvas.width = 64;
    dirtCanvas.height = 64;
    const dctx = dirtCanvas.getContext('2d')!;

    dctx.fillStyle = '#bfa276'; // Base sand/dirt
    dctx.fillRect(0, 0, 64, 64);

    // Fine speckled sand grains
    const sandColors = ['#ad9065', '#ccb087', '#9c7f53', '#d9bf98', '#b5976b'];
    for (let i = 0; i < 280; i++) {
      const sx = Math.floor(Math.random() * 64);
      const sy = Math.floor(Math.random() * 64);
      dctx.fillStyle = sandColors[Math.floor(Math.random() * sandColors.length)];
      dctx.fillRect(sx, sy, 1 + (Math.random() > 0.8 ? 1 : 0), 1 + (Math.random() > 0.8 ? 1 : 0));
    }
    this.dirtPattern = this.ctx.createPattern(dirtCanvas, 'repeat');

    // 2. Grass stadium pattern
    const grassCanvas = document.createElement('canvas');
    grassCanvas.width = 64;
    grassCanvas.height = 64;
    const gctx = grassCanvas.getContext('2d')!;
    gctx.fillStyle = '#439b4b';
    gctx.fillRect(0, 0, 64, 64);

    const grassColors = ['#3a8841', '#4ba953', '#327738', '#52b75b'];
    for (let i = 0; i < 240; i++) {
      const gx = Math.floor(Math.random() * 64);
      const gy = Math.floor(Math.random() * 64);
      gctx.fillStyle = grassColors[Math.floor(Math.random() * grassColors.length)];
      gctx.fillRect(gx, gy, 1, 1);
    }
    this.grassPattern = this.ctx.createPattern(grassCanvas, 'repeat');
  }

  public resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.camera.viewportWidth = width;
    this.camera.viewportHeight = height;
  }

  public updateCamera(
    ball: Ball,
    selectedPlayer: Player | undefined,
    mode: CameraMode,
    dt: number
  ) {
    let targetX = PITCH_LENGTH / 2;
    let targetY = PITCH_WIDTH / 2;

    if (mode === 'follow_ball') {
      targetX = ball.x;
      targetY = ball.y;
    } else if (mode === 'follow_star' && selectedPlayer) {
      targetX = selectedPlayer.x;
      targetY = selectedPlayer.y;
    } else if (mode === 'center_pitch') {
      targetX = PITCH_LENGTH / 2;
      targetY = PITCH_WIDTH / 2;
    }

    // Clamp camera within comfortable viewing range
    targetX = Math.max(200, Math.min(PITCH_LENGTH - 200, targetX));
    targetY = Math.max(150, Math.min(PITCH_WIDTH - 150, targetY));

    // Smooth camera follow with max speed (prevents whip but keeps up with ball)
    const dx = targetX - this.camera.x;
    const dy = targetY - this.camera.y;
    const maxCamSpeed = 600; // units/sec max camera speed
    const maxStep = maxCamSpeed * dt;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.1) {
      const step = Math.min(dist, maxStep);
      // Ease: move faster when far, slower when close
      const ease = Math.min(1, dist / 200);
      const move = step * (0.3 + 0.7 * ease);
      this.camera.x += (dx / dist) * move;
      this.camera.y += (dy / dist) * move;
    }
  }

  public render(
    homeTeam: Team,
    awayTeam: Team,
    ball: Ball,
    effects: VisualEffect[],
    options: RenderOptions,
    referee?: { x: number; y: number; facingAngle: number }
  ) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;

    ctx.save();
    // Pixelated crisp graphics
    ctx.imageSmoothingEnabled = false;

    // Clear backdrop
    ctx.fillStyle = '#1c1b18';
    ctx.fillRect(0, 0, width, height);

    // 1. Draw Pitch Ground Polygon
    this.drawPitchGround(options.pitchTheme);

    // 2. Draw Sideline Fence & Spectators (top boundary)
    this.drawFenceAndSpectators();

    // 3. Draw Chalk Pitch Markings
    this.drawChalkLines();

    // 3b. Draw Linesmen (after chalk, so not overlapped)
    this.drawLinesmen(ball, null);

    // 4. Depth Sort and Draw Entities (Players, Ball, and Ground Effects)
    // Goals are drawn in two passes: back net before entities, front posts after
    // (so players can be inside the goal correctly)
    const allPlayers = [...homeTeam.players, ...awayTeam.players];

    // Draw goal back nets first (behind players)
    this.drawGoalBack(LEFT_GOAL, true);
    this.drawGoalBack(RIGHT_GOAL, false);

    // Sort order for isometric 2.5D:
    // Earlier rendered = higher up/farther away; later rendered = closer to camera
    // In our projection, higher (y - x * 0.4) is closer to the screen bottom
    const entities: { kind: 'player' | 'ball' | 'referee'; depth: number; data: Player }[] = allPlayers.map(p => ({
      kind: 'player' as const,
      depth: p.y - p.x * 0.5,
      data: p,
    }));

    entities.push({
      kind: 'ball' as const,
      depth: ball.y - ball.x * 0.5,
      data: ball as unknown as Player,
    });

    if (referee) {
      entities.push({
        kind: 'referee' as const,
        depth: referee.y - referee.x * 0.5,
        data: { x: referee.x, y: referee.y, facingAngle: referee.facingAngle } as unknown as Player,
      });
    }

    entities.sort((a, b) => a.depth - b.depth);

    // Draw Shadows first
    for (const p of allPlayers) {
      this.drawPlayerShadow(p);
    }
    this.drawBallShadow(ball);
    if (referee) {
      this.drawRefereeShadow(referee.x, referee.y);
    }

    // Draw Entities
    for (const ent of entities) {
      if (ent.kind === 'ball') {
        this.drawBall(ball);
      } else if (ent.kind === 'referee' && referee) {
        // The on-pitch official in black
        const rvx = (referee as any).vx ?? 0;
        const rvy = (referee as any).vy ?? 0;
        this.drawReferee(referee.x, referee.y, referee.facingAngle, rvx, rvy);
      } else {
        // Player
        const p = ent.data as Player;
        const isSelected = p.id === options.selectedPlayerId || p.hasBall;
        this.drawChibiPlayer(p, isSelected);
      }
    }

    // 5b. Draw Goal Front Posts (in front of players, so GK appears inside)
    this.drawGoalFront(LEFT_GOAL, true);
    this.drawGoalFront(RIGHT_GOAL, false);

    // 6. Draw Visual Effects (impact dust, exclamation)
    this.drawVisualEffects(effects);

    ctx.restore();
  }

  /**
   * Draw isometric pitch surface with authentic dirt/grass texture
   */
  private drawPitchGround(theme: PitchTheme) {
    const ctx = this.ctx;
    const PADDING = 140;

    // 4 corners of the extended pitch ground
    const p1 = worldToScreen(-PADDING, -PADDING, 0, this.camera);
    const p2 = worldToScreen(PITCH_LENGTH + PADDING, -PADDING, 0, this.camera);
    const p3 = worldToScreen(PITCH_LENGTH + PADDING, PITCH_WIDTH + PADDING, 0, this.camera);
    const p4 = worldToScreen(-PADDING, PITCH_WIDTH + PADDING, 0, this.camera);

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();

    if (theme === 'grass' && this.grassPattern) {
      ctx.fillStyle = this.grassPattern;
      ctx.fill();
    } else if (theme === 'sunset') {
      ctx.fillStyle = '#a87954';
      ctx.fill();
    } else if (this.dirtPattern) {
      ctx.fillStyle = this.dirtPattern;
      ctx.fill();
    } else {
      ctx.fillStyle = '#bda072';
      ctx.fill();
    }

    // Subtle pitch border bevel
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  /**
   * Sideline chainlink fence, benches, and cheering spectators
   */
  private drawFenceAndSpectators() {
    const ctx = this.ctx;
    const fenceY = -45; // Further back from pitch
    const numPosts = 16;
    const postHeight = 65;

    // Draw fence posts along the top touchline (detailed)
    for (let i = 0; i <= numPosts; i++) {
      const wx = (i / numPosts) * (PITCH_LENGTH + 120) - 60;
      const base = worldToScreen(wx, fenceY, 0, this.camera);
      const top = worldToScreen(wx, fenceY, postHeight, this.camera);
      const mid = worldToScreen(wx, fenceY, postHeight * 0.5, this.camera);

      // Steel vertical post with highlight and shadow
      ctx.strokeStyle = '#455a64'; // shadow side
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(base.x + 1, base.y);
      ctx.lineTo(top.x + 1, top.y);
      ctx.stroke();
      ctx.strokeStyle = '#90a4ae'; // main
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
      ctx.strokeStyle = '#cfd8dc'; // highlight
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(base.x - 1, base.y);
      ctx.lineTo(top.x - 1, top.y);
      ctx.stroke();
      // Post cap
      ctx.fillStyle = '#37474f';
      ctx.fillRect(top.x - 2, top.y - 2, 4, 3);
      // Base plate
      ctx.fillStyle = '#546e7a';
      ctx.fillRect(base.x - 3, base.y - 1, 6, 3);

      // Chainlink mesh with diamond pattern (detailed)
      if (i < numPosts) {
        const nextWx = ((i + 1) / numPosts) * (PITCH_LENGTH + 120) - 60;
        const nextBase = worldToScreen(nextWx, fenceY, 0, this.camera);
        const nextTop = worldToScreen(nextWx, fenceY, postHeight, this.camera);
        const nextMid = worldToScreen(nextWx, fenceY, postHeight * 0.5, this.camera);

        // Mesh background
        ctx.fillStyle = 'rgba(46, 125, 50, 0.35)';
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(top.x, top.y);
        ctx.lineTo(nextTop.x, nextTop.y);
        ctx.lineTo(nextBase.x, nextBase.y);
        ctx.closePath();
        ctx.fill();

        // Diamond chainlink pattern
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 0.8;
        const diamonds = 4;
        for (let d = 0; d < diamonds; d++) {
          const t1 = d / diamonds;
          const t2 = (d + 1) / diamonds;
          // Diagonal lines forming diamonds
          ctx.beginPath();
          const x1 = base.x + (nextBase.x - base.x) * t1;
          const y1 = base.y + (nextBase.y - base.y) * t1;
          const x2 = top.x + (nextTop.x - top.x) * t2;
          const y2 = top.y + (nextTop.y - top.y) * t2;
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.beginPath();
          const x3 = base.x + (nextBase.x - base.x) * t2;
          const y3 = base.y + (nextBase.y - base.y) * t2;
          const x4 = top.x + (nextTop.x - top.x) * t1;
          const y4 = top.y + (nextTop.y - top.y) * t1;
          ctx.moveTo(x3, y3);
          ctx.lineTo(x4, y4);
          ctx.stroke();
        }

        // Horizontal rails (top, middle, bottom) with shading
        ctx.strokeStyle = '#37474f';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(mid.x, mid.y);
        ctx.lineTo(nextMid.x, nextMid.y);
        ctx.stroke();
        ctx.strokeStyle = '#78909c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mid.x, mid.y - 1);
        ctx.lineTo(nextMid.x, nextMid.y - 1);
        ctx.stroke();
      }
    }

    // Draw wooden bench and sitting spectators (further back, clearly outside pitch)
    const benchStartX = PITCH_LENGTH * 0.45;
    const benchEndX = PITCH_LENGTH + 40;
    const benchY = -35;

    // Wooden planks
    const b1 = worldToScreen(benchStartX, benchY, 12, this.camera);
    const b2 = worldToScreen(benchEndX, benchY, 12, this.camera);
    ctx.strokeStyle = '#8d6e63';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(b1.x, b1.y);
    ctx.lineTo(b2.x, b2.y);
    ctx.stroke();

    // Spectators sitting along bench (detailed people, not abstract)
    const spectatorCount = 12;
    for (let s = 0; s < spectatorCount; s++) {
      const sx = benchStartX + (s / spectatorCount) * (benchEndX - benchStartX);
      const pos = worldToScreen(sx, benchY, 14, this.camera);
      const px = Math.round(pos.x);
      const py = Math.round(pos.y);

      const suitColors = ['#1e293b', '#374151', '#475569', '#1e3a8a', '#14532d', '#701a75', '#7c2d12', '#0f766e'];
      const suitColor = suitColors[s % suitColors.length];
      const suitDark = 'rgba(0,0,0,0.3)';
      const skinTones = ['#ffd1b3', '#ffcc99', '#e8b08a', '#d4a373', '#c68642'];
      const skin = skinTones[s % skinTones.length];
      const skinDark = 'rgba(0,0,0,0.15)';
      const hairColors = ['#4a2e18', '#271e1b', '#1f2937', '#6b7280', '#92400e', '#111827'];
      const hairColor = hairColors[(s * 3) % hairColors.length];

      // === SITTING PERSON ===
      // Legs (sitting, bent at knee)
      ctx.fillStyle = '#1e293b'; // pants
      ctx.fillRect(px - 4, py - 6, 3, 6); // left thigh
      ctx.fillRect(px + 1, py - 6, 3, 6); // right thigh
      ctx.fillStyle = suitDark;
      ctx.fillRect(px - 4, py - 2, 3, 2);
      ctx.fillRect(px + 1, py - 2, 3, 2);
      // Shoes
      ctx.fillStyle = '#212121';
      ctx.fillRect(px - 4, py - 1, 4, 2);
      ctx.fillRect(px, py - 1, 4, 2);

      // Torso (sitting upright)
      ctx.fillStyle = suitColor;
      ctx.fillRect(px - 5, py - 16, 10, 11);
      // Shading
      ctx.fillStyle = suitDark;
      ctx.fillRect(px - 5, py - 16, 1, 11);
      ctx.fillRect(px + 4, py - 16, 1, 11);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(px - 3, py - 16, 4, 2);
      // Collar/shirt detail
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(px - 2, py - 16, 4, 2);

      // Arms (resting on lap or waving)
      const isWaving = (s + Math.floor(Date.now() / 800)) % 4 === 0;
      if (isWaving) {
        // Arm raised waving
        ctx.fillStyle = suitColor;
        ctx.fillRect(px + 5, py - 20, 2, 6);
        ctx.fillStyle = skin;
        ctx.fillRect(px + 5, py - 23, 3, 3); // waving hand
        ctx.fillStyle = skinDark;
        ctx.fillRect(px + 5, py - 21, 3, 1);
        // Other arm on lap
        ctx.fillStyle = suitColor;
        ctx.fillRect(px - 7, py - 14, 2, 5);
        ctx.fillStyle = skin;
        ctx.fillRect(px - 7, py - 10, 2, 2);
      } else {
        // Both arms resting
        ctx.fillStyle = suitColor;
        ctx.fillRect(px - 7, py - 14, 2, 6);
        ctx.fillRect(px + 5, py - 14, 2, 6);
        ctx.fillStyle = suitDark;
        ctx.fillRect(px - 7, py - 10, 2, 2);
        ctx.fillRect(px + 5, py - 10, 2, 2);
        ctx.fillStyle = skin; // hands
        ctx.fillRect(px - 7, py - 9, 2, 2);
        ctx.fillRect(px + 5, py - 9, 2, 2);
      }

      // === HEAD (proper face) ===
      const hx = px;
      const hy = py - 26;
      // Face
      ctx.fillStyle = skin;
      ctx.fillRect(hx - 5, hy, 10, 10);
      // Face shading
      ctx.fillStyle = skinDark;
      ctx.fillRect(hx - 5, hy, 1, 10);
      ctx.fillRect(hx + 4, hy, 1, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(hx - 4, hy, 8, 1);
      // Ears
      ctx.fillStyle = skin;
      ctx.fillRect(hx - 6, hy + 3, 1, 3);
      ctx.fillRect(hx + 5, hy + 3, 1, 3);

      // Hair (varied styles)
      ctx.fillStyle = hairColor;
      const hs = s % 5;
      if (hs === 0) {
        // Short neat
        ctx.fillRect(hx - 5, hy - 2, 10, 3);
        ctx.fillRect(hx - 5, hy, 1, 2);
        ctx.fillRect(hx + 4, hy, 1, 2);
      } else if (hs === 1) {
        // Messy
        ctx.fillRect(hx - 5, hy - 3, 10, 4);
        ctx.fillRect(hx - 3, hy - 4, 2, 1);
        ctx.fillRect(hx + 1, hy - 4, 2, 1);
      } else if (hs === 2) {
        // Cap
        ctx.fillStyle = suitColor;
        ctx.fillRect(hx - 5, hy - 3, 10, 3);
        ctx.fillRect(hx - 6, hy - 1, 12, 1); // brim
      } else if (hs === 3) {
        // Long
        ctx.fillRect(hx - 5, hy - 2, 10, 3);
        ctx.fillRect(hx - 6, hy, 2, 6);
        ctx.fillRect(hx + 4, hy, 2, 6);
      } else {
        // Bald with sides
        ctx.fillRect(hx - 5, hy + 1, 2, 4);
        ctx.fillRect(hx + 3, hy + 1, 2, 4);
      }
      // Hair highlight
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(hx - 4, hy - 2, 8, 1);

      // Eyes (looking at field)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(hx - 3, hy + 3, 2, 3);
      ctx.fillRect(hx + 1, hy + 3, 2, 3);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(hx - 3, hy + 4, 2, 2);
      ctx.fillRect(hx + 1, hy + 4, 2, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(hx - 3, hy + 4, 1, 1);
      ctx.fillRect(hx + 1, hy + 4, 1, 1);

      // Nose (tiny)
      ctx.fillStyle = skinDark;
      ctx.fillRect(hx - 0.5, hy + 6, 1, 1);

      // Mouth (varied: smile, neutral, open cheering)
      const mouthStyle = s % 3;
      if (mouthStyle === 0) {
        ctx.fillStyle = '#8d3b3b';
        ctx.fillRect(hx - 2, hy + 8, 4, 1); // smile
        ctx.fillRect(hx - 1, hy + 9, 2, 1);
      } else if (mouthStyle === 1) {
        ctx.fillStyle = '#8d3b3b';
        ctx.fillRect(hx - 1, hy + 8, 2, 1); // neutral
      } else {
        ctx.fillStyle = '#5c1a1a';
        ctx.fillRect(hx - 1, hy + 8, 3, 2); // open cheering
      }
    }

    // Water bottles on ground (blue and yellow, as seen in screenshot!)
    const bottle1 = worldToScreen(PITCH_LENGTH * 0.95, -5, 0, this.camera);
    ctx.fillStyle = '#29b6f6'; // Blue sports bottle
    ctx.fillRect(bottle1.x, bottle1.y - 8, 3, 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bottle1.x + 1, bottle1.y - 10, 1, 2);

    const bottle2 = worldToScreen(PITCH_LENGTH * 0.97, -4, 0, this.camera);
    ctx.fillStyle = '#fbc02d'; // Yellow sports bottle
    ctx.fillRect(bottle2.x, bottle2.y - 8, 3, 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bottle2.x + 1, bottle2.y - 10, 1, 2);

    // Corner flags (4 corners)
    const corners = [
      { x: 0, y: 0 },
      { x: PITCH_LENGTH, y: 0 },
      { x: 0, y: PITCH_WIDTH },
      { x: PITCH_LENGTH, y: PITCH_WIDTH },
    ];
    for (const c of corners) {
      const base = worldToScreen(c.x, c.y, 0, this.camera);
      const top = worldToScreen(c.x, c.y, 28, this.camera);
      // Pole
      ctx.strokeStyle = '#f5f5f5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
      // Flag (waving)
      const wave = Math.sin(Date.now() / 300 + c.x) * 2;
      ctx.fillStyle = '#e53935';
      ctx.fillRect(top.x, top.y, 8 + wave, 5);
      ctx.fillStyle = '#b71c1c';
      ctx.fillRect(top.x, top.y + 4, 8 + wave, 1);
    }
  }

  /**
   * Linesmen (assistant referees) with flags along touchlines.
   * They signal for throw-ins, corners, and goal kicks (no offside in mini soccer).
   */
  private drawLinesmen(ball: Ball, setPieceType: string | null) {
    const ctx = this.ctx;
    
    // Two linesmen, one on each touchline — same size as players (27px tall)
    // Positioned closer to pitch edge so they're visible on camera
    const linesmen = [
      { y: -12, side: 'top' },
      { y: PITCH_WIDTH + 12, side: 'bottom' },
    ];
    
    for (let li = 0; li < linesmen.length; li++) {
      const lm = linesmen[li];
      // Follow ball x with smooth movement (for leg animation)
      const targetX = Math.max(60, Math.min(PITCH_LENGTH - 60, ball.x));
      // Store previous position for movement detection (simple: use time-based)
      const lx = targetX;
      const pos = worldToScreen(lx, lm.y, 0, this.camera);
      const px = Math.round(pos.x);
      const py = Math.round(pos.y);
      
      // Movement animation (legs swing when ball moves fast)
      const ballSpeed = Math.hypot(ball.vx, ball.vy);
      const isMoving = ballSpeed > 50;
      const time = Date.now() / 250 + li * Math.PI;
      const legSwing = isMoving ? Math.sin(time) * 2.5 : 0;
      const bob = isMoving ? Math.abs(Math.sin(time)) * 1 : 0;
      
      // Flag state animation (raise/lower smoothly)
      const isSignaling = setPieceType === 'throw_in' || setPieceType === 'corner_kick' || setPieceType === 'goal_kick';
      // Animate flag arm angle
      const flagRaise = isSignaling ? 1 : 0; // 1=up, 0=down
      
      const skin = '#ffd1b3';
      const skinDark = '#e8b08a';
      const skinLight = '#ffdbb8';
      
      // === LEGS (same size as players, with animation) ===
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(px - 4, py - 6 + (legSwing > 0 ? legSwing : 0) - bob, 3, 6);
      ctx.fillRect(px + 1, py - 6 - (legSwing < 0 ? -legSwing : 0) - bob, 3, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(px - 4, py - 6 + (legSwing > 0 ? legSwing : 0) - bob, 1, 6);
      // Shoes with highlight
      ctx.fillStyle = '#212121';
      ctx.fillRect(px - 4, py - 3 + (legSwing > 0 ? legSwing : 0) - bob, 3, 3);
      ctx.fillRect(px + 1, py - 3 - (legSwing < 0 ? -legSwing : 0) - bob, 3, 3);
      ctx.fillStyle = '#4a4a4a';
      ctx.fillRect(px - 4, py - 3 + (legSwing > 0 ? legSwing : 0) - bob, 3, 1);
      
      // === BODY (same proportions as players) ===
      ctx.fillStyle = '#212121';
      ctx.fillRect(px - 5, py - 17 - bob, 10, 11);
      ctx.fillStyle = '#2d2d2d';
      ctx.fillRect(px - 5, py - 17 - bob, 2, 11);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(px + 3, py - 17 - bob, 2, 11);
      ctx.fillStyle = '#f5f5f5'; // white trim
      ctx.fillRect(px - 2, py - 17 - bob, 4, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(px - 2, py - 17 - bob, 4, 1);
      
      // === HEAD (same size as players: 10x10 at py-27) ===
      const hx = px;
      const hy = py - 27 - bob;
      ctx.fillStyle = skin;
      ctx.fillRect(hx - 5, hy, 10, 10);
      ctx.fillStyle = skinDark;
      ctx.fillRect(hx - 5, hy, 1, 10);
      ctx.fillRect(hx + 4, hy, 1, 10);
      ctx.fillStyle = skinLight;
      ctx.fillRect(hx - 4, hy, 8, 1);
      // Ears
      ctx.fillStyle = skin;
      ctx.fillRect(hx - 6, hy + 3, 1, 3);
      ctx.fillRect(hx + 5, hy + 3, 1, 3);
      
      // Hair
      ctx.fillStyle = '#271e1b';
      ctx.fillRect(hx - 5, hy - 2, 10, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(hx - 4, hy - 2, 8, 1);
      
      // Eyes (detailed)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(hx - 3, hy + 3, 2, 3);
      ctx.fillRect(hx + 1, hy + 3, 2, 3);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(hx - 3, hy + 4, 2, 2);
      ctx.fillRect(hx + 1, hy + 4, 2, 2);
      
      // Mouth
      ctx.fillStyle = '#8d3b3b';
      ctx.fillRect(hx - 1, hy + 7, 2, 1);
      
      // === FLAG ARM with raise/lower animation ===
      if (flagRaise > 0.5) {
        // Arm raised high (signaling)
        const armY = py - 24 - bob;
        ctx.fillStyle = '#212121';
        ctx.fillRect(px + 5, armY, 2, 8);
        ctx.fillStyle = skin;
        ctx.fillRect(px + 5, armY - 2, 2, 2);
        // Flag waving
        const wave = Math.sin(Date.now() / 150) * 2;
        ctx.fillStyle = '#ffeb3b';
        ctx.fillRect(px + 7, armY - 4, 10, 6);
        ctx.fillStyle = '#e53935'; // checkered
        ctx.fillRect(px + 7, armY - 4, 5, 3);
        ctx.fillRect(px + 12, armY - 1, 5, 3);
        // Flag pole
        ctx.fillStyle = '#9e9e9e';
        ctx.fillRect(px + 6, armY - 4, 1, 10);
      } else {
        // Arm down, flag held at side
        ctx.fillStyle = '#212121';
        ctx.fillRect(px + 5, py - 15 - bob, 2, 6);
        ctx.fillStyle = skin;
        ctx.fillRect(px + 5, py - 10 - bob, 2, 2);
        // Flag down
        ctx.fillStyle = '#ffeb3b';
        ctx.fillRect(px + 7, py - 12 - bob, 6, 8);
        ctx.fillStyle = '#e53935';
        ctx.fillRect(px + 7, py - 12 - bob, 3, 4);
        // Pole
        ctx.fillStyle = '#9e9e9e';
        ctx.fillRect(px + 6, py - 14 - bob, 1, 10);
      }
      // Other arm
      ctx.fillStyle = '#212121';
      ctx.fillRect(px - 7, py - 15 - bob, 2, 6);
      ctx.fillStyle = skin;
      ctx.fillRect(px - 7, py - 10 - bob, 2, 2);
    }
  }

  /**
   * Draw corner flags
        ctx.fillStyle = '#ffeb3b';
        ctx.fillRect(px + 6, py - 26, 8, 5);
        ctx.fillStyle = '#e53935';
        ctx.fillRect(px + 6, py - 26, 4, 2);
        ctx.fillRect(px + 10, py - 24, 4, 2);
      } else {
        // Flag held down
        ctx.fillStyle = '#212121';
        ctx.fillRect(px + 4, py - 14, 2, 5);
        ctx.fillStyle = '#ffd1b3';
        ctx.fillRect(px + 4, py - 10, 2, 2);
        // Flag down
        ctx.fillStyle = '#ffeb3b';
        ctx.fillRect(px + 6, py - 12, 6, 4);
      }
      // Other arm
      ctx.fillStyle = '#212121';
      ctx.fillRect(px - 6, py - 14, 2, 5);
      ctx.fillStyle = '#ffd1b3';
      ctx.fillRect(px - 6, py - 10, 2, 2);
    }
  }

  /**
   * White chalk pitch boundary lines
   */
  private drawChalkLines() {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2.5;

    // 1. Outer Touchline Boundary Rectangle
    const tl = worldToScreen(0, 0, 0, this.camera);
    const tr = worldToScreen(PITCH_LENGTH, 0, 0, this.camera);
    const br = worldToScreen(PITCH_LENGTH, PITCH_WIDTH, 0, this.camera);
    const bl = worldToScreen(0, PITCH_WIDTH, 0, this.camera);

    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();

    // 2. Halfway Line
    const midTop = worldToScreen(PITCH_LENGTH / 2, 0, 0, this.camera);
    const midBottom = worldToScreen(PITCH_LENGTH / 2, PITCH_WIDTH, 0, this.camera);
    ctx.beginPath();
    ctx.moveTo(midTop.x, midTop.y);
    ctx.lineTo(midBottom.x, midBottom.y);
    ctx.stroke();

    // 3. Center Circle (Isometric Ellipse)
    this.drawIsometricCircle(PITCH_LENGTH / 2, PITCH_WIDTH / 2, CENTER_CIRCLE_RADIUS);

    // Center Spot
    const centerSpot = worldToScreen(PITCH_LENGTH / 2, PITCH_WIDTH / 2, 0, this.camera);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(centerSpot.x, centerSpot.y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // 4. Left Penalty Box & Goal Area
    this.drawBox(0, (PITCH_WIDTH - PENALTY_BOX_WIDTH) / 2, PENALTY_BOX_LENGTH, PENALTY_BOX_WIDTH);
    this.drawBox(0, (PITCH_WIDTH - GOAL_AREA_WIDTH) / 2, GOAL_AREA_LENGTH, GOAL_AREA_WIDTH);

    // Left Penalty Spot
    const leftSpot = worldToScreen(120, PITCH_WIDTH / 2, 0, this.camera);
    ctx.beginPath();
    ctx.arc(leftSpot.x, leftSpot.y, 2, 0, Math.PI * 2);
    ctx.fill();

    // 5. Right Penalty Box & Goal Area
    this.drawBox(PITCH_LENGTH - PENALTY_BOX_LENGTH, (PITCH_WIDTH - PENALTY_BOX_WIDTH) / 2, PENALTY_BOX_LENGTH, PENALTY_BOX_WIDTH);
    this.drawBox(PITCH_LENGTH - GOAL_AREA_LENGTH, (PITCH_WIDTH - GOAL_AREA_WIDTH) / 2, GOAL_AREA_LENGTH, GOAL_AREA_WIDTH);

    // Right Penalty Spot
    const rightSpot = worldToScreen(PITCH_LENGTH - 120, PITCH_WIDTH / 2, 0, this.camera);
    ctx.beginPath();
    ctx.arc(rightSpot.x, rightSpot.y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawBox(wx: number, wy: number, wLen: number, wWidth: number) {
    const ctx = this.ctx;
    const p1 = worldToScreen(wx, wy, 0, this.camera);
    const p2 = worldToScreen(wx + wLen, wy, 0, this.camera);
    const p3 = worldToScreen(wx + wLen, wy + wWidth, 0, this.camera);
    const p4 = worldToScreen(wx, wy + wWidth, 0, this.camera);

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.stroke();
  }

  private drawIsometricCircle(cx: number, cy: number, radius: number) {
    const ctx = this.ctx;
    const segments = 32;
    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const px = cx + Math.cos(angle) * radius;
      const py = cy + Math.sin(angle) * radius;
      const s = worldToScreen(px, py, 0, this.camera);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }

  /**
   * 3D Goal Net with posts, crossbar, and detailed net mesh
   */
  /**
   * Draw goal back net (behind players) — called before entities
   */
  private drawGoalBack(goal: typeof RIGHT_GOAL, isLeft: boolean) {
    const ctx = this.ctx;
    const gx = goal.x;
    const y1 = goal.yMin;
    const y2 = goal.yMax;
    const backX = isLeft ? -GOAL_DEPTH : PITCH_LENGTH + GOAL_DEPTH;

    const p1_top = worldToScreen(gx, y1, GOAL_HEIGHT, this.camera);
    const p2_top = worldToScreen(gx, y2, GOAL_HEIGHT, this.camera);
    const b1_ground = worldToScreen(backX, y1, 0, this.camera);
    const b2_ground = worldToScreen(backX, y2, 0, this.camera);
    const b1_top = worldToScreen(backX, y1, GOAL_HEIGHT * 0.85, this.camera);
    const b2_top = worldToScreen(backX, y2, GOAL_HEIGHT * 0.85, this.camera);

    ctx.fillStyle = 'rgba(240, 240, 240, 0.22)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 0.8;

    const drawNetWithGrid = (
      p1: {x: number, y: number}, p2: {x: number, y: number},
      p3: {x: number, y: number}, p4: {x: number, y: number}
    ) => {
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.lineTo(p4.x, p4.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      for (let i = 1; i < 4; i++) {
        const t = i / 4;
        ctx.beginPath();
        ctx.moveTo(p1.x + (p4.x - p1.x) * t, p1.y + (p4.y - p1.y) * t);
        ctx.lineTo(p2.x + (p3.x - p2.x) * t, p2.y + (p3.y - p2.y) * t);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
        ctx.lineTo(p4.x + (p3.x - p4.x) * t, p4.y + (p3.y - p4.y) * t);
        ctx.stroke();
      }
    };

    // Back net wall (behind)
    drawNetWithGrid(b1_ground, b1_top, b2_top, b2_ground);
    // Top net roof
    drawNetWithGrid(p1_top, b1_top, b2_top, p2_top);
    // Side nets
    const p1_ground = worldToScreen(gx, y1, 0, this.camera);
    const b1g = b1_ground;
    drawNetWithGrid(p1_ground, p1_top, b1_top, b1g);
    const p2_ground = worldToScreen(gx, y2, 0, this.camera);
    drawNetWithGrid(p2_ground, p2_top, b2_top, b2_ground);
  }

  /**
   * Draw goal front posts (in front of players) — called after entities
   */
  private drawGoalFront(goal: typeof RIGHT_GOAL, isLeft: boolean) {
    const ctx = this.ctx;
    const gx = goal.x;
    const y1 = goal.yMin;
    const y2 = goal.yMax;

    const p1_ground = worldToScreen(gx, y1, 0, this.camera);
    const p2_ground = worldToScreen(gx, y2, 0, this.camera);
    const p1_top = worldToScreen(gx, y1, GOAL_HEIGHT, this.camera);
    const p2_top = worldToScreen(gx, y2, GOAL_HEIGHT, this.camera);

    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(p1_ground.x + 1, p1_ground.y + 1);
    ctx.lineTo(p1_top.x + 1, p1_top.y + 1);
    ctx.lineTo(p2_top.x + 1, p2_top.y + 1);
    ctx.lineTo(p2_ground.x + 1, p2_ground.y + 1);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(p1_ground.x, p1_ground.y);
    ctx.lineTo(p1_top.x, p1_top.y);
    ctx.lineTo(p2_top.x, p2_top.y);
    ctx.lineTo(p2_ground.x, p2_ground.y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p1_ground.x - 1, p1_ground.y);
    ctx.lineTo(p1_top.x - 1, p1_top.y);
    ctx.stroke();
  }

  private drawGoal(goal: typeof RIGHT_GOAL, isLeft: boolean) {
    // Legacy: draws both (for compatibility)
    this.drawGoalBack(goal, isLeft);
    this.drawGoalFront(goal, isLeft);
    const ctx = this.ctx;
    const gx = goal.x;
    const y1 = goal.yMin;
    const y2 = goal.yMax;
    const backX = isLeft ? -GOAL_DEPTH : PITCH_LENGTH + GOAL_DEPTH;

    // Ground posts
    const p1_ground = worldToScreen(gx, y1, 0, this.camera);
    const p2_ground = worldToScreen(gx, y2, 0, this.camera);
    // Top posts
    const p1_top = worldToScreen(gx, y1, GOAL_HEIGHT, this.camera);
    const p2_top = worldToScreen(gx, y2, GOAL_HEIGHT, this.camera);

    // Back net ground & top
    const b1_ground = worldToScreen(backX, y1, 0, this.camera);
    const b2_ground = worldToScreen(backX, y2, 0, this.camera);
    const b1_top = worldToScreen(backX, y1, GOAL_HEIGHT * 0.85, this.camera);
    const b2_top = worldToScreen(backX, y2, GOAL_HEIGHT * 0.85, this.camera);

    // Net mesh with grid pattern (more detailed)
    ctx.fillStyle = 'rgba(240, 240, 240, 0.22)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 0.8;

    // Helper to draw net with grid
    const drawNetWithGrid = (
      p1: {x: number, y: number}, p2: {x: number, y: number},
      p3: {x: number, y: number}, p4: {x: number, y: number}
    ) => {
      // Fill
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.lineTo(p4.x, p4.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      
      // Grid lines (3x3)
      for (let i = 1; i < 4; i++) {
        const t = i / 4;
        // Horizontal
        ctx.beginPath();
        ctx.moveTo(p1.x + (p4.x - p1.x) * t, p1.y + (p4.y - p1.y) * t);
        ctx.lineTo(p2.x + (p3.x - p2.x) * t, p2.y + (p3.y - p2.y) * t);
        ctx.stroke();
        // Vertical
        ctx.beginPath();
        ctx.moveTo(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
        ctx.lineTo(p4.x + (p3.x - p4.x) * t, p4.y + (p3.y - p4.y) * t);
        ctx.stroke();
      }
    };

    // Back net wall
    drawNetWithGrid(b1_ground, b1_top, b2_top, b2_ground);
    // Top net roof
    drawNetWithGrid(p1_top, b1_top, b2_top, p2_top);
    // Side nets
    drawNetWithGrid(p1_ground, p1_top, b1_top, b1_ground);
    drawNetWithGrid(p2_ground, p2_top, b2_top, b2_ground);

    // White goal posts and crossbar (thicker, with shading)
    ctx.lineCap = 'round';
    // Shadow
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(p1_ground.x + 1, p1_ground.y + 1);
    ctx.lineTo(p1_top.x + 1, p1_top.y + 1);
    ctx.lineTo(p2_top.x + 1, p2_top.y + 1);
    ctx.lineTo(p2_ground.x + 1, p2_ground.y + 1);
    ctx.stroke();
    // Main posts (white with highlight)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(p1_ground.x, p1_ground.y);
    ctx.lineTo(p1_top.x, p1_top.y);
    ctx.lineTo(p2_top.x, p2_top.y);
    ctx.lineTo(p2_ground.x, p2_ground.y);
    ctx.stroke();
    // Highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p1_ground.x - 1, p1_ground.y);
    ctx.lineTo(p1_top.x - 1, p1_top.y);
    ctx.stroke();
  }

  /**
   * Player Ground Shadow — always projected from the player's CURRENT x/y
   * at ground level, so it stays attached under the sprite (including
   * mid-dive, where the sprite lifts off this exact anchor).
   */
  private drawPlayerShadow(player: Player) {
    const ctx = this.ctx;
    const pos = worldToScreen(player.x, player.y, 0, this.camera);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y + 2, 7, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Ball Ground Shadow
   */
  private drawBallShadow(ball: Ball) {
    const ctx = this.ctx;
    const pos = worldToScreen(ball.x, ball.y, 0, this.camera);
    // Shadow size shrinks slightly when ball is high
    const sizeScale = Math.max(0.4, 1 - ball.z / 220);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y + 1, 5 * sizeScale, 2.5 * sizeScale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * The Soccer Ball — hand-drawn procedural, proper pentagon pattern.
   */
  private drawBall(ball: Ball) {
    const ctx = this.ctx;
    const pos = worldToScreen(ball.x, ball.y, ball.z, this.camera);
    const r = ball.radius;
    const px = pos.x;
    const py = pos.y;

    // White base
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();

    // Black pentagons — classic soccer ball pattern
    // Center pentagon + 5 around it (simplified for small size)
    ctx.fillStyle = '#1e293b';
    const rot = ball.rotationAngle || 0;
    
    // Center pentagon (small)
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = rot + (i / 5) * Math.PI * 2 - Math.PI / 2;
      const x = px + Math.cos(a) * r * 0.35;
      const y = py + Math.sin(a) * r * 0.35;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    
    // 5 surrounding patches (partial pentagons at edges)
    for (let i = 0; i < 5; i++) {
      const a = rot + (i / 5) * Math.PI * 2 - Math.PI / 2 + Math.PI / 5;
      const cx = px + Math.cos(a) * r * 0.85;
      const cy = py + Math.sin(a) * r * 0.85;
      // Small pentagon at edge
      ctx.beginPath();
      for (let j = 0; j < 5; j++) {
        const pa = a + (j / 5) * Math.PI * 2;
        const x = cx + Math.cos(pa) * r * 0.25;
        const y = cy + Math.sin(pa) * r * 0.25;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Shading for 3D effect (subtle)
    const grad = ctx.createRadialGradient(px - r*0.3, py - r*0.3, r*0.1, px, py, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(0,0,0,0.15)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();

    // Outline
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * Chibi Pixel Art Player Character
   * Exactly reproducing the iconic retro art style from the screenshot
   */
  private drawChibiPlayer(player: Player, isSelected: boolean) {
    const ctx = this.ctx;
    const isHome = player.team === 'home';
    const isGK = player.position === 'GK';

    // Screen coordinate with vertical offset z
    const pos = worldToScreen(player.x, player.y, player.z, this.camera);
    const px = Math.round(pos.x);
    let py = Math.round(pos.y);

    // Direction facing
    // Angle in radians: determine if facing Left or Right
    const facingRight = Math.cos(player.facingAngle) >= 0;
    const dir = facingRight ? 1 : -1;

    // Running motion dynamics
    const currentSpeed = Math.hypot(player.vx, player.vy);
    const isMoving = currentSpeed > 6;
    const isRunning = (player.state === 'running' || player.state === 'dribbling') && isMoving;
    const bob = isRunning ? Math.sin(player.animFrame * 6) * 1.5 : 0;
    // Subtle athletic lean into forward run direction
    const lean = isRunning ? Math.max(-2, Math.min(2, Math.round(player.vx * 0.012))) : 0;

    this.drawPlayerBadge(player, px, py, isSelected);

    // 1. Slide tackle pose — dedicated slide sprite; falls back to the
    // legacy tilted composite when the pose art is not ready.
    if (player.state === 'tackling' || player.state === 'sliding') {
      const poseKey = this.poseBodyKeyForPlayer(player);
      if (poseKey && this.drawPoseSprite(px, py, player, dir, poseKey)) {
        return;
      }
      this.drawSlideTacklePlayer(ctx, px, py, player, isHome, isGK, dir);
      return;
    }

    // 2. Goalkeeper diving pose — tethered to the ground shadow: the sprite
    // anchor is the CURRENT ground projection (same point the shadow uses),
    // lifted by a clamped elevation, so sprite and shadow can never detach
    // during or after a dive.
    if (player.state === 'diving') {
      const ground = worldToScreen(player.x, player.y, 0, this.camera);
      const lift = Math.min(Math.max(0, player.z), 16) * this.camera.zoom;
      const dx = Math.round(ground.x);
      const dy = Math.round(ground.y - lift);
      // GK dive: arms-overhead throw body rotated 90deg head-first toward
      // the facing direction (dedicated dive sprite removed).
      if (player.position === 'GK') {
        if (this.drawRotatedSprite(dx, dy, player, dir, Math.PI / 2, 'gk-throw')) {
          return;
        }
      } else {
        const poseKey = this.poseBodyKeyForPlayer(player);
        if (poseKey && this.drawPoseSprite(dx, dy, player, dir, poseKey)) {
          return;
        }
      }
      this.drawDivingPlayer(ctx, dx, dy, player, isGK, dir);
      return;
    }

    // 2b. Prone (fallen) pose — victim of a hard sliding tackle, lying flat
    // on the ground (z=0, rotated 90deg onto their side). Distinct from the
    // mid-air diving stretch: no lift, body fully horizontal at the shadow.
    if (player.state === 'prone') {
      const ground = worldToScreen(player.x, player.y, 0, this.camera);
      const dx = Math.round(ground.x);
      const dy = Math.round(ground.y);
      const poseKey = this.poseBodyKeyForPlayer(player);
      if (poseKey && this.drawPoseSprite(dx, dy, player, dir, poseKey)) {
        return;
      }
      this.drawPronePlayer(ctx, dx, dy, player, isHome, isGK, dir);
      return;
    }

    // 2c. Posed action sprites (kick / celebrate / throw-in): dedicated body
    // art composited upright with the head; idle-body fallback otherwise.
    if (
      player.state === 'kicking' ||
      player.state === 'celebrating' ||
      player.state === 'throwing'
    ) {
      const poseKey = this.poseBodyKeyForPlayer(player);
      if (poseKey && this.drawPoseSprite(px, py, player, dir, poseKey)) {
        return;
      }
    }

    // 3. Normal / Running / Dribbling Chibi Player — detailed procedural (32-bit style)
    this.drawDetailedPlayer(ctx, px, py, player, isHome, isGK, dir, lean, bob, isRunning);
  }

  /**
   * Detailed 32-bit style procedural player — shading, highlights, facial detail.
   */
  private drawDetailedPlayer(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    player: Player,
    isHome: boolean, isGK: boolean,
    dir: number, lean: number, bob: number,
    isRunning: boolean
  ) {
    const currentSpeed = Math.hypot(player.vx, player.vy);
    const jersey = isGK ? '#fbc02d' : isHome ? '#e53935' : '#ec407a';
    const jerseyDark = isGK ? '#d4a017' : isHome ? '#b71c1c' : '#ad1457';
    const jerseyLight = isGK ? '#ffdf6b' : isHome ? '#f05545' : '#f06292';
    const skin = player.skinColor;
    const skinDark = '#e8b08a'; // shadow tone
    const skinLight = '#ffdbb8'; // highlight

    // === LEGS & BOOTS (with shading) ===
    const legSwing = isRunning ? Math.sin(player.animFrame * 1.4) * Math.min(3.5, 1.2 + currentSpeed * 0.015) : 0;
    
    // Boots with highlight
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(px - 4, py - 3 + (legSwing > 0 ? legSwing : 0), 3, 3);
    ctx.fillRect(px + 1, py - 3 - (legSwing < 0 ? legSwing : 0), 3, 3);
    ctx.fillStyle = '#4a4a4a'; // boot highlight
    ctx.fillRect(px - 4, py - 3 + (legSwing > 0 ? legSwing : 0), 3, 1);
    ctx.fillRect(px + 1, py - 3 - (legSwing < 0 ? legSwing : 0), 3, 1);

    // Socks with shading
    const sockColor = isGK ? '#fbc02d' : isHome ? '#e53935' : '#ec407a';
    ctx.fillStyle = sockColor;
    ctx.fillRect(px - 4, py - 6, 3, 3);
    ctx.fillRect(px + 1, py - 6, 3, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(px - 4, py - 4, 3, 1);
    ctx.fillRect(px + 1, py - 4, 3, 1);

    // Shorts with shading
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(px - 5, py - 10, 10, 5);
    ctx.fillStyle = '#334155'; // highlight
    ctx.fillRect(px - 5, py - 10, 10, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(px - 5, py - 7, 10, 1);

    // === TORSO / JERSEY (with shading and details) ===
    const torsoX = px + lean;
    
    // Jersey base with side shading
    ctx.fillStyle = jersey;
    ctx.fillRect(torsoX - 5, py - 17, 10, 8);
    ctx.fillStyle = jerseyDark; // side shadows
    ctx.fillRect(torsoX - 5, py - 17, 1, 8);
    ctx.fillRect(torsoX + 4, py - 17, 1, 8);
    ctx.fillStyle = jerseyLight; // center highlight
    ctx.fillRect(torsoX - 2, py - 17, 4, 2);

    // Collar with trim
    const collarColor = isGK ? '#212121' : isHome ? '#ffca28' : '#3949ab';
    ctx.fillStyle = collarColor;
    ctx.fillRect(torsoX - 2, py - 17, 4, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(torsoX - 2, py - 17, 4, 1);

    // Jersey number (simple)
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(torsoX - 1, py - 14, 2, 3);

    // === ARMS (with skin shading) ===
    ctx.fillStyle = jersey;
    if (player.state === 'celebrating') {
      ctx.fillRect(torsoX - 7, py - 20, 2, 6);
      ctx.fillRect(torsoX + 5, py - 20, 2, 6);
      // Hands with shading
      ctx.fillStyle = skin;
      ctx.fillRect(torsoX - 7, py - 22, 2, 2);
      ctx.fillRect(torsoX + 5, py - 22, 2, 2);
      ctx.fillStyle = skinDark;
      ctx.fillRect(torsoX - 7, py - 21, 2, 1);
      ctx.fillRect(torsoX + 5, py - 21, 2, 1);
    } else if (player.state === 'kicking') {
      // Kicking: one leg extended forward, arms for balance (detailed)
      const kickDir = dir;
      // Standing leg (with shading)
      ctx.fillStyle = '#212121';
      ctx.fillRect(torsoX - 2, py - 3, 3, 3);
      ctx.fillStyle = '#4a4a4a';
      ctx.fillRect(torsoX - 2, py - 3, 3, 1);
      ctx.fillStyle = sockColor;
      ctx.fillRect(torsoX - 2, py - 6, 3, 3);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(torsoX - 2, py - 4, 3, 1);
      // Kicking leg extended forward (with shading)
      ctx.fillStyle = '#212121';
      ctx.fillRect(torsoX + kickDir * 5, py - 5, 4, 3);
      ctx.fillStyle = '#4a4a4a';
      ctx.fillRect(torsoX + kickDir * 5, py - 5, 4, 1);
      ctx.fillStyle = sockColor;
      ctx.fillRect(torsoX + kickDir * 4, py - 8, 3, 3);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(torsoX + kickDir * 4, py - 6, 3, 1);
      // Arms out for balance (with shading)
      ctx.fillStyle = jersey;
      ctx.fillRect(torsoX - 8, py - 16, 2, 5);
      ctx.fillRect(torsoX + 6, py - 16, 2, 5);
      ctx.fillStyle = jerseyDark;
      ctx.fillRect(torsoX - 8, py - 12, 2, 1);
      ctx.fillRect(torsoX + 6, py - 12, 2, 1);
      ctx.fillStyle = skin;
      ctx.fillRect(torsoX - 8, py - 11, 2, 2);
      ctx.fillRect(torsoX + 6, py - 11, 2, 2);
      ctx.fillStyle = skinDark;
      ctx.fillRect(torsoX - 8, py - 10, 2, 1);
      ctx.fillRect(torsoX + 6, py - 10, 2, 1);
    } else if (player.state === 'throwing') {
      // Throw-in: both arms overhead (detailed)
      ctx.fillStyle = jersey;
      ctx.fillRect(torsoX - 7, py - 22, 3, 7);
      ctx.fillRect(torsoX + 4, py - 22, 3, 7);
      ctx.fillStyle = jerseyDark;
      ctx.fillRect(torsoX - 7, py - 16, 3, 1);
      ctx.fillRect(torsoX + 4, py - 16, 3, 1);
      ctx.fillStyle = skin;
      ctx.fillRect(torsoX - 7, py - 24, 3, 3);
      ctx.fillRect(torsoX + 4, py - 24, 3, 3);
      ctx.fillStyle = skinDark;
      ctx.fillRect(torsoX - 7, py - 22, 3, 1);
      ctx.fillRect(torsoX + 4, py - 22, 3, 1);
      // Ball above head with pentagon pattern
      const bx = torsoX;
      const by = py - 28;
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(bx - 1, by - 1, 2, 2);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.stroke();
    } else if (player.state === 'holding') {
      // Holding ball: arms cradling in front (detailed)
      ctx.fillStyle = jersey;
      ctx.fillRect(torsoX - 7, py - 16, 3, 5);
      ctx.fillRect(torsoX + 4, py - 16, 3, 5);
      ctx.fillStyle = jerseyDark;
      ctx.fillRect(torsoX - 7, py - 12, 3, 1);
      ctx.fillRect(torsoX + 4, py - 12, 3, 1);
      ctx.fillStyle = skin;
      ctx.fillRect(torsoX - 6, py - 12, 2, 2);
      ctx.fillRect(torsoX + 4, py - 12, 2, 2);
      ctx.fillStyle = skinDark;
      ctx.fillRect(torsoX - 6, py - 11, 2, 1);
      ctx.fillRect(torsoX + 4, py - 11, 2, 1);
      // Ball in hands
      const bx = torsoX;
      const by = py - 13;
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(bx, by, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(bx - 1, by - 1, 2, 2);
    } else {
      const armSwing = isRunning ? Math.sin(player.animFrame * 1.4) * (1.5 + currentSpeed * 0.01) : 0;
      // Sleeves
      ctx.fillRect(torsoX - 7, py - 16 + armSwing, 2, 4);
      ctx.fillRect(torsoX + 5, py - 16 - armSwing, 2, 4);
      ctx.fillStyle = jerseyDark;
      ctx.fillRect(torsoX - 7, py - 13 + armSwing, 2, 1);
      ctx.fillRect(torsoX + 5, py - 13 - armSwing, 2, 1);
      // Hands with shading
      ctx.fillStyle = isGK ? '#ffffff' : skin;
      ctx.fillRect(torsoX - 7, py - 11 + armSwing, 2, 2);
      ctx.fillRect(torsoX + 5, py - 11 - armSwing, 2, 2);
      if (!isGK) {
        ctx.fillStyle = skinDark;
        ctx.fillRect(torsoX - 7, py - 10 + armSwing, 2, 1);
        ctx.fillRect(torsoX + 5, py - 10 - armSwing, 2, 1);
      }
    }

    // === HEAD (detailed 32-bit style with variety) ===
    const headX = px + lean;
    const headY = py - 27 + bob;
    
    // Variety seed from player name (each player looks different)
    const seed = player.name ? player.name.charCodeAt(0) + player.name.length : 0;
    const variant = seed % 4;
    
    // Face base with shading
    ctx.fillStyle = skin;
    ctx.fillRect(headX - 5, headY, 10, 10);
    // Face shading (sides darker, top highlight)
    ctx.fillStyle = skinDark;
    ctx.fillRect(headX - 5, headY, 1, 10);
    ctx.fillRect(headX + 4, headY, 1, 10);
    ctx.fillStyle = skinLight;
    ctx.fillRect(headX - 4, headY, 8, 1);
    
    // Cheeks (subtle blush) — varies by player
    if (variant !== 3) {
      ctx.fillStyle = 'rgba(255,150,150,0.3)';
      ctx.fillRect(headX - 4, headY + 6, 2, 2);
      ctx.fillRect(headX + 2, headY + 6, 2, 2);
    }

    // Eyes — 4 variants for distinct looks
    if (variant === 0) {
      // Standard eyes with highlights
      ctx.fillStyle = '#ffffff';
      if (dir === 1) {
        ctx.fillRect(headX - 1, headY + 3, 3, 3);
        ctx.fillRect(headX + 3, headY + 3, 3, 3);
      } else {
        ctx.fillRect(headX - 6, headY + 3, 3, 3);
        ctx.fillRect(headX - 2, headY + 3, 3, 3);
      }
      ctx.fillStyle = '#1a1a2e';
      if (dir === 1) {
        ctx.fillRect(headX, headY + 4, 2, 2);
        ctx.fillRect(headX + 4, headY + 4, 2, 2);
      } else {
        ctx.fillRect(headX - 5, headY + 4, 2, 2);
        ctx.fillRect(headX - 1, headY + 4, 2, 2);
      }
    } else if (variant === 1) {
      // Determined angled eyes
      ctx.fillStyle = '#1a1a2e';
      if (dir === 1) {
        ctx.fillRect(headX - 1, headY + 3, 3, 2);
        ctx.fillRect(headX + 3, headY + 3, 3, 2);
        ctx.fillRect(headX - 1, headY + 3, 1, 1); // angled
        ctx.fillRect(headX + 5, headY + 3, 1, 1);
      } else {
        ctx.fillRect(headX - 6, headY + 3, 3, 2);
        ctx.fillRect(headX - 2, headY + 3, 3, 2);
      }
    } else if (variant === 2) {
      // Friendly round eyes
      ctx.fillStyle = '#1a1a2e';
      if (dir === 1) {
        ctx.fillRect(headX, headY + 4, 2, 2);
        ctx.fillRect(headX + 4, headY + 4, 2, 2);
      } else {
        ctx.fillRect(headX - 5, headY + 4, 2, 2);
        ctx.fillRect(headX - 1, headY + 4, 2, 2);
      }
      ctx.fillStyle = '#ffffff';
      if (dir === 1) {
        ctx.fillRect(headX, headY + 4, 1, 1);
        ctx.fillRect(headX + 4, headY + 4, 1, 1);
      } else {
        ctx.fillRect(headX - 5, headY + 4, 1, 1);
        ctx.fillRect(headX - 1, headY + 4, 1, 1);
      }
    } else {
      // Serious narrow eyes
      ctx.fillStyle = '#1a1a2e';
      if (dir === 1) {
        ctx.fillRect(headX - 1, headY + 4, 3, 1);
        ctx.fillRect(headX + 3, headY + 4, 3, 1);
      } else {
        ctx.fillRect(headX - 6, headY + 4, 3, 1);
        ctx.fillRect(headX - 2, headY + 4, 3, 1);
      }
    }

    // Eyebrows — vary by variant
    ctx.fillStyle = '#3e2723';
    if (variant === 1) {
      // Angry brows
      if (dir === 1) {
        ctx.fillRect(headX - 1, headY + 2, 3, 1);
        ctx.fillRect(headX + 3, headY + 1, 3, 1);
      } else {
        ctx.fillRect(headX - 6, headY + 1, 3, 1);
        ctx.fillRect(headX - 2, headY + 2, 3, 1);
      }
    } else {
      if (dir === 1) {
        ctx.fillRect(headX - 1, headY + 2, 3, 1);
        ctx.fillRect(headX + 3, headY + 2, 3, 1);
      } else {
        ctx.fillRect(headX - 6, headY + 2, 3, 1);
        ctx.fillRect(headX - 2, headY + 2, 3, 1);
      }
    }

    // Mouth — vary by variant
    if (variant === 0) {
      ctx.fillStyle = '#8d3b3b';
      ctx.fillRect(headX + (dir === 1 ? 0 : -2), headY + 7, 2, 1);
    } else if (variant === 1) {
      // Frown
      ctx.fillStyle = '#8d3b3b';
      ctx.fillRect(headX + (dir === 1 ? -1 : -3), headY + 8, 4, 1);
    } else if (variant === 2) {
      // Smile
      ctx.fillStyle = '#b91c1c';
      ctx.fillRect(headX + (dir === 1 ? -1 : -3), headY + 7, 4, 1);
      ctx.fillRect(headX + (dir === 1 ? 0 : -2), headY + 8, 2, 1);
    } else {
      // Flat serious
      ctx.fillStyle = '#8d3b3b';
      ctx.fillRect(headX + (dir === 1 ? -1 : -3), headY + 7, 4, 1);
    }

    // Hair with highlights
    this.drawDetailedHair(ctx, headX, headY, player.hair.style, player.hair.color, dir);
  }

  /**
   * Detailed hair with many distinct styles — Kairosoft-like variety.
   */
  private drawDetailedHair(
    ctx: CanvasRenderingContext2D,
    headX: number, headY: number,
    style: string, color: string, dir: number
  ) {
    const dark = 'rgba(0,0,0,0.3)';
    const light = 'rgba(255,255,255,0.25)';
    
    // Helper for highlight
    const highlight = (x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = light;
      ctx.fillRect(x, y, w, h);
    };

    switch (style) {
      case 'spiky':
        ctx.fillStyle = color;
        ctx.fillRect(headX - 5, headY - 2, 10, 3);
        // Spikes
        ctx.fillRect(headX - 4, headY - 4, 2, 2);
        ctx.fillRect(headX - 1, headY - 5, 2, 3);
        ctx.fillRect(headX + 2, headY - 4, 2, 2);
        highlight(headX - 4, headY - 4, 2, 1);
        highlight(headX - 1, headY - 5, 2, 1);
        break;
        
      case 'curly':
        ctx.fillStyle = color;
        ctx.fillRect(headX - 5, headY - 3, 10, 4);
        // Curls (bumps)
        ctx.fillRect(headX - 5, headY - 4, 3, 2);
        ctx.fillRect(headX - 2, headY - 5, 3, 2);
        ctx.fillRect(headX + 1, headY - 5, 3, 2);
        ctx.fillRect(headX + 3, headY - 4, 2, 2);
        highlight(headX - 2, headY - 5, 6, 1);
        break;
        
      case 'long':
        ctx.fillStyle = color;
        ctx.fillRect(headX - 5, headY - 2, 10, 4);
        ctx.fillRect(headX - 6, headY, 2, 7); // left side
        ctx.fillRect(headX + 4, headY, 2, 7); // right side
        highlight(headX - 4, headY - 2, 8, 1);
        break;
        
      case 'ponytail':
        ctx.fillStyle = color;
        ctx.fillRect(headX - 5, headY - 2, 10, 3);
        // Ponytail to one side
        const px = dir === 1 ? headX + 5 : headX - 6;
        ctx.fillRect(px, headY - 1, 2, 6);
        ctx.fillRect(px + (dir === 1 ? 1 : -1), headY + 3, 2, 3);
        highlight(headX - 4, headY - 2, 8, 1);
        break;
        
      case 'bald':
        // Just sides, no top
        ctx.fillStyle = color;
        ctx.fillRect(headX - 5, headY, 2, 4);
        ctx.fillRect(headX + 3, headY, 2, 4);
        break;
        
      case 'mohawk':
        ctx.fillStyle = color;
        ctx.fillRect(headX - 1, headY - 5, 3, 6);
        highlight(headX - 1, headY - 5, 3, 1);
        break;
        
      case 'afro':
        ctx.fillStyle = color;
        ctx.fillRect(headX - 6, headY - 5, 12, 6);
        ctx.fillRect(headX - 5, headY - 6, 10, 2);
        highlight(headX - 4, headY - 6, 8, 1);
        break;
        
      default: // 'short'
        ctx.fillStyle = color;
        ctx.fillRect(headX - 5, headY - 2, 10, 4);
        ctx.fillRect(headX - 5, headY, 1, 2);
        ctx.fillRect(headX + 4, headY, 1, 2);
        highlight(headX - 4, headY - 2, 8, 1);
        // Side shadow
        ctx.fillStyle = dark;
        ctx.fillRect(headX - 5, headY + 1, 10, 1);
        break;
    }
  }

  private drawSlideTacklePlayer(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    player: Player,
    isHome: boolean,
    isGK: boolean,
    dir: number
  ) {
    // Sliding tackle: composite tilted feet-first toward the facing direction.
    if (this.drawRotatedSprite(px, py, player, dir, (-Math.PI / 2) * 0.9)) {
      return;
    }
    const jerseyColor = isGK ? '#fbc02d' : isHome ? '#e53935' : '#ec407a';

    // Slide on ground: horizontal body
    ctx.fillStyle = '#1e293b'; // Cleats
    ctx.fillRect(px + dir * 10, py - 3, 4, 3);

    ctx.fillStyle = isHome ? '#e53935' : '#ec407a'; // Leg / sock
    ctx.fillRect(px + dir * 4, py - 4, 6, 3);

    ctx.fillStyle = '#1e293b'; // Shorts
    ctx.fillRect(px - dir * 2, py - 6, 7, 4);

    ctx.fillStyle = jerseyColor; // Torso
    ctx.fillRect(px - dir * 8, py - 8, 8, 5);

    // Head tilted
    ctx.fillStyle = player.skinColor;
    ctx.fillRect(px - dir * 14, py - 12, 8, 8);

    // Hair
    ctx.fillStyle = player.hair.color;
    ctx.fillRect(px - dir * 15, py - 14, 9, 4);
  }

  private drawPronePlayer(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    player: Player,
    isHome: boolean,
    isGK: boolean,
    dir: number
  ) {
    const jerseyColor = isGK ? '#fbc02d' : isHome ? '#e53935' : '#ec407a';

    // Prone: composite rotated 90deg, flat on the ground at the shadow anchor.
    if (this.drawRotatedSprite(px, py, player, dir, Math.PI / 2)) {
      return;
    }

    // Lying flat on the back/side: long horizontal silhouette at ground level.
    // Legs extended together.
    ctx.fillStyle = '#212121'; // Boots together at one end
    ctx.fillRect(px + 8, py - 3, 5, 3);
    ctx.fillStyle = isGK ? '#fbc02d' : jerseyColor; // Socks
    ctx.fillRect(px + 3, py - 4, 5, 3);

    // Shorts
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(px - 3, py - 6, 6, 4);

    // Torso flat (wider than tall: rotated 90deg feel)
    ctx.fillStyle = jerseyColor;
    ctx.fillRect(px - 11, py - 7, 8, 5);

    // Arms sprawled out to the sides
    ctx.fillStyle = jerseyColor;
    ctx.fillRect(px - 9, py - 11, 3, 4);
    ctx.fillRect(px - 6, py - 2, 3, 4);
    ctx.fillStyle = isGK ? '#ffffff' : player.skinColor;
    ctx.fillRect(px - 9, py - 13, 3, 2);
    ctx.fillRect(px - 6, py + 2, 3, 2);

    // Head resting on the ground at the other end
    ctx.fillStyle = player.skinColor;
    ctx.fillRect(px - 19, py - 10, 8, 7);
    ctx.fillStyle = player.hair.color;
    ctx.fillRect(px - 20, py - 12, 9, 3);
  }

  private drawDivingPlayer(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    player: Player,
    isGK: boolean,
    dir: number
  ) {
    // Diving: composite rotated 90deg head-first toward the facing direction.
    if (this.drawRotatedSprite(px, py, player, dir, Math.PI / 2)) {
      return;
    }
    const jerseyColor = '#fbc02d';

    // Horizontal diving stretch
    ctx.fillStyle = '#ffffff'; // White goalie gloves stretched out!
    ctx.fillRect(px + dir * 14, py - 12, 4, 3);

    // Arms
    ctx.fillStyle = jerseyColor;
    ctx.fillRect(px + dir * 8, py - 11, 6, 3);

    // Head
    ctx.fillStyle = player.skinColor;
    ctx.fillRect(px + dir * 2, py - 14, 8, 8);
    ctx.fillStyle = player.hair.color;
    ctx.fillRect(px + dir * 1, py - 16, 9, 3);

    // Torso
    ctx.fillStyle = jerseyColor;
    ctx.fillRect(px - dir * 5, py - 10, 8, 6);

    // Shorts & legs
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(px - dir * 11, py - 8, 6, 4);
    ctx.fillStyle = '#212121'; // Boots
    ctx.fillRect(px - dir * 16, py - 6, 5, 3);
  }

  /**
   * The on-pitch referee: chibi official in a black kit with a whistle
   * badge, drawn in the same pixel language as the players.
   */
  private drawRefereeShadow(wx: number, wy: number) {
    const ctx = this.ctx;
    const pos = worldToScreen(wx, wy, 0, this.camera);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y + 2, 7, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawReferee(wx: number, wy: number, facingAngle: number, vx: number = 0, vy: number = 0) {
    const ctx = this.ctx;
    const pos = worldToScreen(wx, wy, 0, this.camera);
    const px = Math.round(pos.x);
    const py = Math.round(pos.y);

    // Procedural referee (consistent style, no sprites)
    const dir = Math.cos(facingAngle) >= 0 ? 1 : -1;
    
    // Leg animation based on movement
    const speed = Math.hypot(vx, vy);
    const isMoving = speed > 5;
    const time = Date.now() / 200;
    const legSwing = isMoving ? Math.sin(time) * 2 : 0;

    // Boots (animated, with shading)
    ctx.fillStyle = '#212121';
    ctx.fillRect(px - 4, py - 3 + (legSwing > 0 ? legSwing : 0), 3, 3);
    ctx.fillRect(px + 1, py - 3 - (legSwing < 0 ? -legSwing : 0), 3, 3);
    ctx.fillStyle = '#4a4a4a';
    ctx.fillRect(px - 4, py - 3 + (legSwing > 0 ? legSwing : 0), 3, 1);
    ctx.fillRect(px + 1, py - 3 - (legSwing < 0 ? -legSwing : 0), 3, 1);

    // Socks (animated, with shading)
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(px - 4, py - 6 + (legSwing > 0 ? legSwing * 0.5 : 0), 3, 3);
    ctx.fillRect(px + 1, py - 6 - (legSwing < 0 ? -legSwing * 0.5 : 0), 3, 3);
    
    // Shorts (with shading)
    ctx.fillStyle = '#111827';
    ctx.fillRect(px - 5, py - 10, 10, 5);
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(px - 5, py - 10, 10, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(px - 5, py - 7, 10, 1);

    // Shirt (referee black) with shading, white trim + whistle badge
    ctx.fillStyle = '#212121';
    ctx.fillRect(px - 5, py - 17, 10, 8);
    ctx.fillStyle = '#2d2d2d'; // highlight
    ctx.fillRect(px - 4, py - 17, 3, 8);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; // side shadow
    ctx.fillRect(px + 3, py - 17, 2, 8);
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(px - 2, py - 17, 4, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(px - 2, py - 17, 4, 1);
    // Whistle badge
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(px - 1, py - 14, 2, 2);
    ctx.fillStyle = '#9ca3af';
    ctx.fillRect(px - 1, py - 13, 2, 1);

    // Arms (with shading)
    ctx.fillStyle = '#212121';
    ctx.fillRect(px - 7, py - 16, 2, 5);
    ctx.fillRect(px + 5, py - 16, 2, 5);
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(px - 7, py - 16, 1, 5);
    ctx.fillRect(px + 5, py - 16, 1, 5);

    // Hands (with shading)
    ctx.fillStyle = '#ffd1b3';
    ctx.fillRect(px - 7, py - 11, 2, 2);
    ctx.fillRect(px + 5, py - 11, 2, 2);
    ctx.fillStyle = '#e8b08a';
    ctx.fillRect(px - 7, py - 10, 2, 1);
    ctx.fillRect(px + 5, py - 10, 2, 1);

    // Head (with shading like players)
    ctx.fillStyle = '#ffd1b3';
    ctx.fillRect(px - 5, py - 27, 10, 10);
    ctx.fillStyle = '#e8b08a';
    ctx.fillRect(px - 5, py - 27, 1, 10);
    ctx.fillRect(px + 4, py - 27, 1, 10);
    ctx.fillStyle = '#ffdbb8';
    ctx.fillRect(px - 4, py - 27, 8, 1);

    // Eyes (detailed)
    ctx.fillStyle = '#ffffff';
    if (dir === 1) {
      ctx.fillRect(px - 1, py - 24, 3, 3);
      ctx.fillRect(px + 3, py - 24, 3, 3);
    } else {
      ctx.fillRect(px - 6, py - 24, 3, 3);
      ctx.fillRect(px - 2, py - 24, 3, 3);
    }
    ctx.fillStyle = '#1a1a2e';
    if (dir === 1) {
      ctx.fillRect(px, py - 23, 2, 2);
      ctx.fillRect(px + 4, py - 23, 2, 2);
    } else {
      ctx.fillRect(px - 5, py - 23, 2, 2);
      ctx.fillRect(px - 1, py - 23, 2, 2);
    }

    // Eyebrows (stern referee look)
    ctx.fillStyle = '#3e2723';
    if (dir === 1) {
      ctx.fillRect(px - 1, py - 25, 3, 1);
      ctx.fillRect(px + 3, py - 25, 3, 1);
    } else {
      ctx.fillRect(px - 6, py - 25, 3, 1);
      ctx.fillRect(px - 2, py - 25, 3, 1);
    }

    // Mouth (serious)
    ctx.fillStyle = '#8d3b3b';
    ctx.fillRect(px + (dir === 1 ? -1 : -3), py - 20, 4, 1);

    // Short grey hair cap
    ctx.fillStyle = '#9e9e9e';
    ctx.fillRect(px - 6, py - 30, 12, 5);
  }

  private drawHair(
    ctx: CanvasRenderingContext2D,
    px: number,
    headY: number,
    style: string,
    color: string,
    dir: number
  ) {
    ctx.fillStyle = color;
    // Base hair cap
    ctx.fillRect(px - 6, headY - 3, 12, 5);

    if (style === 'spiky') {
      // 3 spike tufts on top
      ctx.fillRect(px - 5, headY - 6, 3, 3);
      ctx.fillRect(px - 1, headY - 7, 3, 4);
      ctx.fillRect(px + 3, headY - 6, 3, 3);
    } else if (style === 'bangs') {
      // Forehead bangs
      ctx.fillRect(px - 4, headY + 1, 8, 3);
      ctx.fillRect(px + dir * 4, headY + 2, 2, 4);
    } else if (style === 'curly') {
      ctx.fillRect(px - 7, headY - 4, 14, 6);
      ctx.fillRect(px - 6, headY - 6, 12, 3);
    } else if (style === 'ponytail') {
      ctx.fillRect(px - dir * 8, headY - 4, 4, 4);
      ctx.fillRect(px - dir * 10, headY - 2, 3, 6);
    }
  }

  /**
   * Visual Effects (slide/impact dust, cheering emotes)
   */
  private drawVisualEffects(effects: VisualEffect[]) {
    const ctx = this.ctx;

    for (const eff of effects) {
      const pos = worldToScreen(eff.x, eff.y, eff.z, this.camera);
      const alpha = 1 - eff.life;

      if (eff.type === 'dust') {
        // Slide / kick dust cloud
        ctx.fillStyle = `rgba(215, 190, 150, ${alpha * 0.7})`;
        for (let i = 0; i < 5; i++) {
          const offsetX = (i - 2) * 4 * (1 + eff.life);
          const offsetY = -eff.life * 8;
          ctx.beginPath();
          ctx.arc(pos.x + offsetX, pos.y + offsetY, 3 * (1 - eff.life * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (eff.type === 'exclamation') {
        // Exclamation celebration badge
        ctx.fillStyle = `rgba(255, 235, 59, ${alpha})`;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.5;
        ctx.font = 'bold 16px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('GOAL!', pos.x, pos.y - eff.life * 20);
        ctx.strokeText('GOAL!', pos.x, pos.y - eff.life * 20);
      }
    }
  }
}
