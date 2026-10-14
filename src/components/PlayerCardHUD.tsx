import React from 'react';
import { Player } from '../types/soccer';
import { soundEngine } from '../audio/soundEngine';

interface PlayerCardHUDProps {
  player: Player;
  onNextPlayer: () => void;
  onFollowPlayer: () => void;
  isFollowing: boolean;
}

export const PlayerCardHUD: React.FC<PlayerCardHUDProps> = ({
  player,
  onNextPlayer,
  onFollowPlayer,
  isFollowing,
}) => {
  // Position badge colors: saturated Kairosoft palette
  const positionBadgeStyles: Record<string, string> = {
    GK: 'bg-[#ffb52e] text-[#221a12]',
    DF: 'bg-[#29a3e8] text-white',
    MF: 'bg-[#43c828] text-white',
    FW: 'bg-[#f04438] text-white',
  };

  const posStyle = positionBadgeStyles[player.position] || 'bg-[#29a3e8] text-white';

  return (
    <div className="absolute bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-2 z-30 pointer-events-auto select-none">
      {/* Single merged chunky player card: head + position + name */}
      <div className="kairo-panel-sm bg-[#ffd93b] p-1.5 sm:p-2 flex items-center gap-1.5 sm:gap-2">
        {/* Head portrait — tap toggles camera follow */}
        <div
          onClick={() => {
            soundEngine.playClick();
            onFollowPlayer();
          }}
          title="Tap to toggle camera focus on this player"
          className="bg-[#221a12] rounded-md p-1 flex items-center justify-center relative overflow-hidden cursor-pointer hover:brightness-110 active:translate-y-0.5 transition-all shrink-0"
        >
          <div className="w-7 h-7 sm:w-9 sm:h-9 bg-[#3a5f4a] rounded flex items-center justify-center relative shrink-0">
            {/* Hair */}
            <div
              className="absolute top-1 w-4 sm:w-5 h-2 rounded-t"
              style={{ backgroundColor: player.hair.color }}
            />
            {/* Face */}
            <div
              className="absolute top-2.5 w-3.5 sm:w-4 h-3 rounded-sm flex items-center justify-around px-0.5"
              style={{ backgroundColor: player.skinColor }}
            >
              <div className="w-0.5 h-0.5 bg-black rounded-full" />
              <div className="w-0.5 h-0.5 bg-black rounded-full" />
            </div>
          </div>
          {isFollowing && (
            <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[#ffd93b] animate-ping" />
          )}
        </div>

        {/* Position badge */}
        <div
          className={`${posStyle} font-pixel text-[8px] sm:text-[10px] px-1.5 py-1 rounded-md border-2 border-[#221a12] shrink-0`}
        >
          {player.position}
        </div>

        {/* Name — tap cycles to next player */}
        <div
          onClick={() => {
            soundEngine.playClick();
            onNextPlayer();
          }}
          title="Tap to cycle players"
          className="cursor-pointer hover:brightness-105 active:translate-y-0.5 transition-all min-w-0 pr-1"
        >
          <span className="font-pixel text-[#221a12] text-[8px] sm:text-[10px] leading-tight truncate block">
            {player.name}
          </span>
        </div>
      </div>
    </div>
  );
};
