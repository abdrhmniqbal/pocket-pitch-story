import React from 'react';
import { MatchHalf, Team } from '../types/soccer';

interface ScoreboardHUDProps {
  homeTeam: Team;
  awayTeam: Team;
  half: MatchHalf;
  minutes: number;
  seconds: number;
}

export const ScoreboardHUD: React.FC<ScoreboardHUDProps> = ({
  homeTeam,
  awayTeam,
  half,
  minutes,
  seconds,
}) => {
  const pad = (n: number) => n.toString().padStart(2, '0');

  // Match half display label
  const halfLabel = half === 'FH' ? '1H' : half === 'HT' ? 'HT' : half === 'SH' ? '2H' : 'FT';

  return (
    <div className="absolute top-0 left-0 right-0 z-30 pointer-events-none flex flex-col items-center">
      <div className="w-full flex items-start justify-center gap-1 sm:gap-2 px-2 sm:px-6 pt-2">
        <div className="flex flex-col items-center min-w-0 flex-1 sm:flex-none">
          {/* Chunky main scoreboard panel */}
          <div className="kairo-panel bg-[#fff6d9] pl-2 pr-2 sm:pl-5 sm:pr-5 py-1.5 flex items-center gap-1.5 sm:gap-3 min-w-0 max-w-full relative">
            {/* Home Team */}
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <svg
                viewBox="0 0 24 24"
                className="w-5 h-5 sm:w-7 sm:h-7 shrink-0"
                fill={homeTeam.jerseyColor}
                stroke="#221a12"
                strokeWidth={1.5}
              >
                <path d="M7 3L2 8L6 11L7 9V21H17V9L18 11L22 8L17 3H14C14 4.5 13 5.5 12 5.5C11 5.5 10 4.5 10 3H7Z" />
              </svg>
              <div className="flex flex-col min-w-0">
                <span className="font-pixel text-[#221a12] text-[8px] sm:text-[10px] leading-tight truncate max-w-[22vw] sm:max-w-[160px]">
                  {homeTeam.name}
                </span>
                <span
                  className="h-1 mt-1 rounded-full"
                  style={{ backgroundColor: homeTeam.jerseyColor }}
                />
              </div>
            </div>

            {/* Chunky score box */}
            <div className="kairo-panel-sm bg-[#221a12] px-2 sm:px-4 py-1 flex items-center gap-1.5 sm:gap-2 shrink-0">
              <span className="font-pixel text-[#ffd93b] text-sm sm:text-xl">
                {homeTeam.score}
              </span>
              <span className="font-pixel text-[#fff6d9]/60 text-[10px] sm:text-sm">-</span>
              <span className="font-pixel text-[#ffd93b] text-sm sm:text-xl">
                {awayTeam.score}
              </span>
            </div>

            {/* Away Team */}
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <div className="flex flex-col min-w-0 items-end">
                <span className="font-pixel text-[#221a12] text-[8px] sm:text-[10px] leading-tight truncate max-w-[22vw] sm:max-w-[160px] text-right">
                  {awayTeam.name}
                </span>
                <span
                  className="h-1 mt-1 rounded-full w-full"
                  style={{ backgroundColor: awayTeam.jerseyColor }}
                />
              </div>
              <svg
                viewBox="0 0 24 24"
                className="w-5 h-5 sm:w-7 sm:h-7 shrink-0"
                fill={awayTeam.jerseyColor}
                stroke="#221a12"
                strokeWidth={1.5}
              >
                <path d="M7 3L2 8L6 11L7 9V21H17V9L18 11L22 8L17 3H14C14 4.5 13 5.5 12 5.5C11 5.5 10 4.5 10 3H7Z" />
              </svg>
            </div>
          </div>

          {/* Integrated clock tag hanging below the scoreboard */}
          <div className="kairo-panel-sm bg-[#29a3e8] px-3 sm:px-4 py-1 -mt-1 flex items-center gap-2">
            <span className="font-pixel text-white text-[8px] sm:text-[10px]">
              {halfLabel}
            </span>
            <span className="font-pixel text-[#221a12] bg-[#ffd93b] px-1.5 py-0.5 rounded text-[8px] sm:text-[10px]">
              {pad(minutes)}:{pad(seconds)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
