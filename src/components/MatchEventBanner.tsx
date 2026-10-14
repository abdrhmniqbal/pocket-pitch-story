import React, { useEffect } from 'react';
import confetti from 'canvas-confetti';
import { CardBanner, Player } from '../types/soccer';

interface MatchEventBannerProps {
  isGoalSequence: boolean;
  goalTeam: 'home' | 'away' | null;
  goalScorer: Player | null;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  showHalfTimeBanner: boolean;
  showSecondHalfBanner: boolean;
  showFullTimeBanner: boolean;
  cardBanner?: CardBanner | null;
}

export const MatchEventBanner: React.FC<MatchEventBannerProps> = ({
  isGoalSequence,
  goalTeam,
  goalScorer,
  homeTeamName,
  awayTeamName,
  homeScore,
  awayScore,
  showHalfTimeBanner,
  showSecondHalfBanner,
  showFullTimeBanner,
  cardBanner,
}) => {
  useEffect(() => {
    if (isGoalSequence) {
      // Fire festive retro confetti burst!
      try {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.4 },
          colors: goalTeam === 'home' ? ['#ef4444', '#f59e0b', '#ffffff'] : ['#ec4899', '#3b82f6', '#ffffff'],
        });
      } catch {
        // Fallback gracefully if canvas-confetti is not loaded
      }
    }
  }, [isGoalSequence, goalTeam]);

  useEffect(() => {
    if (showFullTimeBanner) {
      // Celebrate the final whistle with a retro confetti burst!
      try {
        confetti({
          particleCount: 120,
          spread: 100,
          origin: { y: 0.4 },
          colors: ['#ffd93b', '#f04438', '#29a3e8', '#ffffff'],
        });
      } catch {
        // Fallback gracefully if canvas-confetti is not loaded
      }
    }
  }, [showFullTimeBanner]);

  const scoreLine = `${homeTeamName} ${homeScore} - ${awayScore} ${awayTeamName}`;

  // Position badge colors: same as the player card
  const positionBadgeStyles: Record<string, string> = {
    GK: 'bg-[#ffb52e] text-[#221a12]',
    DF: 'bg-[#29a3e8] text-white',
    MF: 'bg-[#43c828] text-white',
    FW: 'bg-[#f04438] text-white',
  };

  // Card panel shares the Kairosoft-chunky panel language (transient,
  // pointer-events-none: never an overlay, rides below the main event line).
  const cardTeamName = cardBanner ? (cardBanner.team === 'home' ? homeTeamName : awayTeamName) : '';
  const cardPanel = cardBanner ? (
    <div className="absolute top-[196px] sm:top-[212px] left-1/2 -translate-x-1/2 z-40 pointer-events-none w-max max-w-[92vw] flex justify-center">
      <div className={`kairo-panel ${cardBanner.kind === 'yellow' ? 'bg-[#ffd93b]' : 'bg-[#f04438]'} px-3 sm:px-5 py-1.5 sm:py-2 flex flex-col items-center text-center max-w-full`}>
        <span className={`font-pixel ${cardBanner.kind === 'yellow' ? 'text-[#221a12]' : 'text-white'} text-xs sm:text-base drop-shadow-[2px_2px_0_rgba(34,26,18,0.9)] whitespace-nowrap`}>
          {cardBanner.kind === 'yellow' ? '🟨 YELLOW CARD' : '🟥 RED CARD — SENT OFF'}
        </span>
        <span className="font-kairo-body font-black text-[#221a12] text-xs sm:text-sm truncate max-w-full">
          {cardBanner.playerName} ({cardTeamName})
        </span>
        <span className="font-kairo-body font-extrabold text-[#221a12]/70 text-[10px] sm:text-xs truncate max-w-full">
          {cardBanner.reason}
        </span>
      </div>
    </div>
  ) : null;

  // Full-time result takes priority, then half-time, then goals, then kickoff.
  let main: React.ReactNode = null;

  if (showFullTimeBanner) {
    const result =
      homeScore > awayScore
        ? `${homeTeamName} win!`
        : awayScore > homeScore
          ? `${awayTeamName} win!`
          : "It's a draw!";
    main = (
      <div className="absolute top-[92px] sm:top-[104px] left-1/2 -translate-x-1/2 z-40 pointer-events-none w-max max-w-[92vw] flex justify-center">
        <div className="kairo-panel bg-[#ffd93b] px-3 sm:px-5 py-1.5 sm:py-2 flex flex-col items-center text-center max-w-full">
          <span className="font-pixel text-[#f04438] text-xs sm:text-base drop-shadow-[2px_2px_0_rgba(34,26,18,0.9)] whitespace-nowrap">
            FULL TIME!
          </span>
          <span className="font-kairo-body font-black text-[#221a12] text-xs sm:text-sm truncate max-w-full">
            {scoreLine}
          </span>
          <span className="font-kairo-body font-extrabold text-[#6b5d2e] text-[10px] sm:text-xs truncate max-w-full">
            {result}
          </span>
        </div>
      </div>
    );
  } else if (showHalfTimeBanner) {
    main = (
      <div className="absolute top-[92px] sm:top-[104px] left-1/2 -translate-x-1/2 z-40 pointer-events-none w-max max-w-[92vw] flex justify-center">
        <div className="kairo-panel bg-[#ff7a1a] px-3 sm:px-5 py-1.5 sm:py-2 flex flex-col items-center text-center max-w-full">
          <span className="font-pixel text-white text-xs sm:text-base drop-shadow-[2px_2px_0_rgba(34,26,18,0.9)] whitespace-nowrap">
            HALF TIME
          </span>
          <span className="font-kairo-body font-black text-[#221a12] text-xs sm:text-sm truncate max-w-full">
            {scoreLine}
          </span>
          <span className="font-kairo-body font-extrabold text-[#221a12]/70 text-[10px] sm:text-xs truncate max-w-full">
            Second half coming up...
          </span>
        </div>
      </div>
    );
  } else if (isGoalSequence) {
    const teamName = goalTeam === 'home' ? homeTeamName : awayTeamName;

    main = (
      <div className="absolute top-[92px] sm:top-[104px] left-1/2 -translate-x-1/2 z-40 pointer-events-none w-max max-w-[92vw] flex justify-center">
        <div className="kairo-panel bg-[#ffd93b] px-3 sm:px-5 py-1.5 sm:py-2 flex flex-col items-center text-center max-w-full">
          <span className="font-pixel text-[#f04438] text-xs sm:text-base drop-shadow-[2px_2px_0_rgba(34,26,18,0.9)] whitespace-nowrap">
            ⚽ GOOOAL! ⚽
          </span>
          <span className="font-kairo-body font-black text-[#221a12] text-xs sm:text-sm truncate max-w-full">
            {teamName} score!
          </span>
          {goalScorer && (
            <div className="flex items-center justify-center gap-1.5 max-w-full">
              <span
                className={`${positionBadgeStyles[goalScorer.position] || 'bg-[#29a3e8] text-white'} font-pixel text-[8px] sm:text-[10px] px-1.5 py-0.5 rounded-md border-2 border-[#221a12] shrink-0`}
              >
                {goalScorer.position}
              </span>
              <span className="font-kairo-body font-extrabold text-[#6b5d2e] text-[10px] sm:text-xs truncate">
                #{goalScorer.number} {goalScorer.name}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  } else if (showSecondHalfBanner) {
    main = (
      <div className="absolute top-[92px] sm:top-[104px] left-1/2 -translate-x-1/2 z-40 pointer-events-none w-max max-w-[92vw] flex justify-center">
        <div className="kairo-panel bg-[#43c828] px-3 sm:px-5 py-1.5 sm:py-2 flex flex-col items-center text-center max-w-full">
          <span className="font-pixel text-white text-xs sm:text-base drop-shadow-[2px_2px_0_rgba(34,26,18,0.9)] whitespace-nowrap">
            SECOND HALF
          </span>
          <span className="font-kairo-body font-black text-[#221a12] text-xs sm:text-sm truncate max-w-full">
            {awayTeamName} to kick off!
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      {main}
      {cardPanel}
    </>
  );
};
