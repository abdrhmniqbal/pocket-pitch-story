/**
 * Pocket League Match Day - Retro Pixel Art Football Simulation
 * Inspired by Kairosoft's Pocket League Story
 */

import React, { useEffect, useRef, useState } from 'react';
import { CameraMode, CardBanner, MatchCommentaryItem, PitchTheme, Player } from './types/soccer';
import { createInitialTeams } from './engine/teamData';
import { MatchEngine } from './engine/matchEngine';
import { SoccerRenderer } from './engine/renderer';
import { ScoreboardHUD } from './components/ScoreboardHUD';
import { PlayerCardHUD } from './components/PlayerCardHUD';
import { RadarHUD } from './components/RadarHUD';
import { MatchMenuModal } from './components/MatchMenuModal';
import { MatchEventBanner } from './components/MatchEventBanner';
import { CommentaryTicker } from './components/CommentaryTicker';
import { soundEngine } from './audio/soundEngine';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<MatchEngine | null>(null);
  const rendererRef = useRef<SoccerRenderer | null>(null);

  // React state for HUD updates
  const [minutes, setMinutes] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [half, setHalf] = useState<'FH' | 'HT' | 'SH' | 'FT'>('FH');
  const [homeScore, setHomeScore] = useState(0);
  const [awayScore, setAwayScore] = useState(0);
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [gameSpeed, setGameSpeed] = useState(1);
  const [pitchTheme, setPitchTheme] = useState<PitchTheme>('dirt');
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow_ball');
  const [commentaryLog, setCommentaryLog] = useState<MatchCommentaryItem[]>([]);
  const [lastCommentary, setLastCommentary] = useState<MatchCommentaryItem | null>(null);

  // Goal sequence state
  const [isGoalSequence, setIsGoalSequence] = useState(false);
  const [goalTeam, setGoalTeam] = useState<'home' | 'away' | null>(null);
  const [goalScorer, setGoalScorer] = useState<Player | null>(null);

  // Half-time / full-time banner state (mirrors engine.state each HUD tick)
  const [cardBanner, setCardBanner] = useState<CardBanner | null>(null);
  const [showHalfTimeBanner, setShowHalfTimeBanner] = useState(false);
  const [showSecondHalfBanner, setShowSecondHalfBanner] = useState(false);
  const [showFullTimeBanner, setShowFullTimeBanner] = useState(false);

  // Initialize Match Engine and Renderer
  useEffect(() => {
    const { home, away } = createInitialTeams();
    const engine = new MatchEngine(home, away);
    engineRef.current = engine;

    // Initial state
    setSelectedPlayer(engine.getSelectedPlayer());

    // Commentary callback
    engine.onCommentary = (text, type, team) => {
      const item: MatchCommentaryItem = {
        id: `com-${Date.now()}-${Math.random()}`,
        minute: engine.state.matchMinutes,
        second: engine.state.matchSeconds,
        half: engine.state.half === 'FH' ? '1H' : '2H',
        text,
        type,
        team,
      };
      setLastCommentary(item);
      setCommentaryLog((prev) => [item, ...prev.slice(0, 49)]);
    };

    // Goal scored callback
    engine.onGoalScored = (team, scorer) => {
      setIsGoalSequence(true);
      setGoalTeam(team);
      setGoalScorer(scorer);
      setHomeScore(engine.homeTeam.score);
      setAwayScore(engine.awayTeam.score);
    };

    // Initial comment
    engine.addCommentary('Kick off! Sun Rays vs Blue Stars — a fresh 0-0! What a day for football!', 'info');

    if (canvasRef.current) {
      const renderer = new SoccerRenderer(canvasRef.current);
      rendererRef.current = renderer;
      renderer.resize(window.innerWidth, window.innerHeight);
    }

    const handleResize = () => {
      if (canvasRef.current && rendererRef.current) {
        rendererRef.current.resize(window.innerWidth, window.innerHeight);
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Main 60 FPS Game Loop
  useEffect(() => {
    let animationFrameId: number;
    let lastTime = performance.now();
    let hudUpdateCounter = 0;

    const gameLoop = (currentTime: number) => {
      const dt = (currentTime - lastTime) / 1000;
      lastTime = currentTime;

      const engine = engineRef.current;
      const renderer = rendererRef.current;

      if (engine && renderer) {
        // Step engine physics and AI
        engine.update(dt);

        // Update camera position
        const activePlayer = engine.getSelectedPlayer();
        renderer.updateCamera(engine.ball, activePlayer, cameraMode, dt);

        // Render frame onto canvas
        renderer.render(
          engine.homeTeam,
          engine.awayTeam,
          engine.ball,
          engine.visualEffects,
          {
            pitchTheme,
            cameraMode,
            selectedPlayerId: engine.state.selectedPlayerId,
          },
          engine.state.referee
        );

        // Throttle React state HUD updates to ~15 FPS to conserve CPU and ensure smooth 60fps render
        hudUpdateCounter++;
        if (hudUpdateCounter % 4 === 0) {
          setMinutes(engine.state.matchMinutes);
          setSeconds(engine.state.matchSeconds);
          setHalf(engine.state.half);
          setHomeScore(engine.homeTeam.score);
          setAwayScore(engine.awayTeam.score);
          setSelectedPlayer(engine.getSelectedPlayer());
          setIsGoalSequence(engine.state.isGoalSequence);
          setShowHalfTimeBanner(engine.state.showHalfTimeBanner);
          setShowSecondHalfBanner(engine.state.showSecondHalfBanner);
          setShowFullTimeBanner(engine.state.showFullTimeBanner);
          setCardBanner(engine.state.cardBanner ? { ...engine.state.cardBanner } : null);
          if (engine.state.isGoalSequence) {
            setGoalTeam(engine.state.goalTeam);
            setGoalScorer(engine.state.goalScorer);
          }
        }
      }

      animationFrameId = requestAnimationFrame(gameLoop);
    };

    animationFrameId = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [cameraMode, pitchTheme]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isMenuOpen && e.key !== 'Escape') return;

      const engine = engineRef.current;
      if (!engine) return;

      if (e.code === 'Space') {
        e.preventDefault();
        const nextSpeed = gameSpeed === 0 ? 1 : 0;
        setGameSpeed(nextSpeed);
        engine.state.gameSpeed = nextSpeed;
        soundEngine.playClick();
      } else if (e.key === '1') {
        setGameSpeed(1);
        engine.state.gameSpeed = 1;
        soundEngine.playClick();
      } else if (e.key === '2') {
        setGameSpeed(2);
        engine.state.gameSpeed = 2;
        soundEngine.playClick();
      } else if (e.key === '4') {
        setGameSpeed(4);
        engine.state.gameSpeed = 4;
        soundEngine.playClick();
      } else if (e.key === 'm' || e.key === 'M') {
        soundEngine.setMuted(!soundEngine.getMuted());
      } else if (e.key === 'c' || e.key === 'C') {
        setCameraMode((prev) => (prev === 'follow_ball' ? 'follow_star' : prev === 'follow_star' ? 'center_pitch' : 'follow_ball'));
        soundEngine.playClick();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        cycleNextPlayer();
      } else if (e.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMenuOpen, gameSpeed]);

  const cycleNextPlayer = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const all = engine.getAllPlayers();
    const curIdx = all.findIndex((p) => p.id === engine.state.selectedPlayerId);
    const nextIdx = (curIdx + 1) % all.length;
    engine.setSelectedPlayer(all[nextIdx].id);
    setSelectedPlayer(all[nextIdx]);
    soundEngine.playClick();
  };

  const handleFollowPlayerToggle = () => {
    setCameraMode((prev) => (prev === 'follow_star' ? 'follow_ball' : 'follow_star'));
  };

  const engine = engineRef.current;
  const homeTeam = engine?.homeTeam || createInitialTeams().home;
  const awayTeam = engine?.awayTeam || createInitialTeams().away;
  const stats = engine?.stats || {
    homePossessionTime: 320,
    awayPossessionTime: 280,
    homeShots: 4,
    awayShots: 2,
    homeShotsOnTarget: 3,
    awayShotsOnTarget: 1,
    homePasses: 42,
    awayPasses: 36,
    homeTackles: 8,
    awayTackles: 6,
    homeSaves: 1,
    awaySaves: 2,
    homeCorners: 2,
    awayCorners: 1,
    homeThrowIns: 5,
    awayThrowIns: 4,
  };
  const ball = engine?.ball || {
    x: 550,
    y: 340,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    radius: 5,
    carrierId: null,
    lastTouchTeam: 'home',
    lastTouchPlayerId: null,
    rotationAngle: 0,
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#16241c] select-none font-sans" style={{ height: '100dvh' }}>
      {/* 2D Canvas for Pixel Rendering */}
      <canvas
        ref={canvasRef}
        className="w-full h-full block pixelated cursor-grab active:cursor-grabbing"
      />

      {/* Top HUD: Scoreboard Banner (Sun Rays 1 - 0 Blue Stars) & FH 25:16 Clock */}
      <ScoreboardHUD
        homeTeam={{ ...homeTeam, score: homeScore }}
        awayTeam={{ ...awayTeam, score: awayScore }}
        half={half}
        minutes={minutes}
        seconds={seconds}
      />

      {/* Bottom Commentary Ticker */}
      <CommentaryTicker lastItem={lastCommentary} />

      {/* Bottom Left HUD: Player Monitor Card ([DF] Brown) */}
      {selectedPlayer && (
        <PlayerCardHUD
          player={selectedPlayer}
          onNextPlayer={cycleNextPlayer}
          onFollowPlayer={handleFollowPlayerToggle}
          isFollowing={cameraMode === 'follow_star'}
        />
      )}

      {/* Bottom Right HUD: Mini-Radar Pitch & Menu Button */}
      <RadarHUD
        homeTeam={homeTeam}
        awayTeam={awayTeam}
        ball={ball}
        onOpenMenu={() => setIsMenuOpen(true)}
      />

      {/* Goal Celebration + Half-Time / Second-Half / Full-Time Arcade Popups */}
      <MatchEventBanner
        isGoalSequence={isGoalSequence}
        goalTeam={goalTeam}
        goalScorer={goalScorer}
        homeTeamName={homeTeam.name}
        awayTeamName={awayTeam.name}
        homeScore={homeScore}
        awayScore={awayScore}
        showHalfTimeBanner={showHalfTimeBanner}
        showSecondHalfBanner={showSecondHalfBanner}
        showFullTimeBanner={showFullTimeBanner}
        cardBanner={cardBanner}
      />

      {/* Match Control Center Modal */}
      <MatchMenuModal
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        homeTeam={homeTeam}
        awayTeam={awayTeam}
        stats={stats}
        gameSpeed={gameSpeed}
        onSetGameSpeed={(speed) => {
          setGameSpeed(speed);
          if (engine) engine.state.gameSpeed = speed;
        }}
        pitchTheme={pitchTheme}
        onSetPitchTheme={(theme) => setPitchTheme(theme)}
        cameraMode={cameraMode}
        onSetCameraMode={(mode) => setCameraMode(mode)}
        commentaryLog={commentaryLog}
        half={half}
        onRestartKickoff={() => {
          if (engine) engine.resetKickoff('home');
        }}
        onStartSecondHalf={() => {
          if (engine) engine.startSecondHalf();
        }}
        onRestartMatch={() => {
          if (engine) engine.restartFullMatch();
        }}
        onSelectPlayer={(id) => {
          if (engine) {
            engine.setSelectedPlayer(id);
            setSelectedPlayer(engine.getSelectedPlayer());
            setCameraMode('follow_star');
          }
        }}
      />
    </div>
  );
}
