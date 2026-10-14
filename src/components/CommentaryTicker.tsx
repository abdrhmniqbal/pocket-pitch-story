import React from 'react';
import { MatchCommentaryItem } from '../types/soccer';

interface CommentaryTickerProps {
  lastItem: MatchCommentaryItem | null;
}

export const CommentaryTicker: React.FC<CommentaryTickerProps> = ({ lastItem }) => {
  if (!lastItem) return null;

  const typeIcons: Record<string, string> = {
    goal: '⚽',
    shot: '💥',
    save: '🧤',
    tackle: '⚔️',
    pass: '👟',
    whistle: '📢',
    info: '📋',
    corner: '🚩',
    out: '📐',
  };

  const icon = typeIcons[lastItem.type] || '⚡';

  return (
    <div className="absolute bottom-[4.25rem] sm:bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-20 pointer-events-none w-max max-w-[94vw] sm:max-w-[520px] font-kairo-body">
      <div className="kairo-panel-sm bg-[#fff6d9] px-2.5 sm:px-3 py-1.5 flex items-center gap-2 max-w-full overflow-hidden">
        <span className="kairo-panel-sm bg-[#f04438] text-sm shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center">
          {icon}
        </span>
        <span className="text-[#221a12] text-xs sm:text-sm font-extrabold tracking-wide min-w-0 line-clamp-2 leading-tight">
          {lastItem.text}
        </span>
      </div>
    </div>
  );
};
