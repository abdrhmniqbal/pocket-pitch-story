import React from 'react';
import { Ball, Team } from '../types/soccer';
import { PITCH_LENGTH, PITCH_WIDTH } from '../engine/physics';
import { soundEngine } from '../audio/soundEngine';

interface RadarHUDProps {
  homeTeam: Team;
  awayTeam: Team;
  ball: Ball;
  onOpenMenu: () => void;
}

export const RadarHUD: React.FC<RadarHUDProps> = ({
  homeTeam,
  awayTeam,
  ball,
  onOpenMenu,
}) => {
  return (
    <div className="absolute bottom-[max(0.5rem,env(safe-area-inset-bottom))] right-2 z-30 flex items-end gap-1.5 sm:gap-2 pointer-events-auto select-none">
      {/* Minimap in a chunky frame */}
      <div className="kairo-panel bg-[#2f9e2e] w-[88px] h-[56px] sm:w-[144px] sm:h-[90px] relative overflow-hidden p-0.5 shrink-0">
        {/* Pitch boundary lines */}
        <div className="absolute inset-1 border-2 border-white/80 rounded-sm pointer-events-none">
          {/* Halfway line */}
          <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 border-r-2 border-white/70" />
          {/* Center circle */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 sm:w-6 sm:h-6 rounded-full border-2 border-white/70" />
          {/* Left Goal box */}
          <div className="absolute top-1/4 bottom-1/4 left-0 w-3 border-r-2 border-y-2 border-white/70" />
          {/* Right Goal box */}
          <div className="absolute top-1/4 bottom-1/4 right-0 w-3 border-l-2 border-y-2 border-white/70" />
        </div>

        {/* Home Players (chunky orange dots) */}
        {homeTeam.players.map((p) => {
          const rx = (p.x / PITCH_LENGTH) * 100;
          const ry = (p.y / PITCH_WIDTH) * 100;
          return (
            <div
              key={p.id}
              className="absolute w-2 h-2 sm:w-2.5 sm:h-2.5 bg-[#ff7a1a] border border-[#221a12] rounded-[3px] -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${rx}%`, top: `${ry}%` }}
            />
          );
        })}

        {/* Away Players (chunky blue dots) */}
        {awayTeam.players.map((p) => {
          const rx = (p.x / PITCH_LENGTH) * 100;
          const ry = (p.y / PITCH_WIDTH) * 100;
          return (
            <div
              key={p.id}
              className="absolute w-2 h-2 sm:w-2.5 sm:h-2.5 bg-[#29a3e8] border border-[#221a12] rounded-[3px] -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${rx}%`, top: `${ry}%` }}
            />
          );
        })}

        {/* Soccer Ball (blinking white dot) */}
        <div
          className="absolute w-2 h-2 sm:w-2.5 sm:h-2.5 bg-white border border-[#221a12] rounded-full -translate-x-1/2 -translate-y-1/2 animate-pulse z-10"
          style={{
            left: `${(ball.x / PITCH_LENGTH) * 100}%`,
            top: `${(ball.y / PITCH_WIDTH) * 100}%`,
          }}
        />
      </div>

      {/* Chunky Menu button */}
      <button
        onClick={() => {
          soundEngine.playClick();
          onOpenMenu();
        }}
        className="kairo-btn font-pixel bg-[#ffd93b] text-[#221a12] text-[9px] sm:text-[11px] px-2.5 sm:px-4 py-2 sm:py-3 cursor-pointer shrink-0"
      >
        MENU
      </button>
    </div>
  );
};
