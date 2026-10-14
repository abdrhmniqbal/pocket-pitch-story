import React, { useState } from 'react';
import { CameraMode, MatchCommentaryItem, MatchHalf, MatchStats, PitchTheme, Team } from '../types/soccer';
import { soundEngine } from '../audio/soundEngine';
import { Volume2, VolumeX, Play, Pause, FastForward, RotateCcw, Eye, Shield, Activity } from 'lucide-react';

interface MatchMenuModalProps {
  isOpen: boolean;
  onClose: () => void;
  homeTeam: Team;
  awayTeam: Team;
  stats: MatchStats;
  gameSpeed: number;
  onSetGameSpeed: (speed: number) => void;
  pitchTheme: PitchTheme;
  onSetPitchTheme: (theme: PitchTheme) => void;
  cameraMode: CameraMode;
  onSetCameraMode: (mode: CameraMode) => void;
  commentaryLog: MatchCommentaryItem[];
  half: MatchHalf;
  onRestartKickoff: () => void;
  onStartSecondHalf: () => void;
  onRestartMatch: () => void;
  onSelectPlayer: (id: string) => void;
}

export const MatchMenuModal: React.FC<MatchMenuModalProps> = ({
  isOpen,
  onClose,
  homeTeam,
  awayTeam,
  stats,
  gameSpeed,
  onSetGameSpeed,
  pitchTheme,
  onSetPitchTheme,
  cameraMode,
  onSetCameraMode,
  commentaryLog,
  half,
  onRestartKickoff,
  onStartSecondHalf,
  onRestartMatch,
  onSelectPlayer,
}) => {
  const [activeTab, setActiveTab] = useState<'controls' | 'stats' | 'rosters' | 'log'>('controls');
  const [isMuted, setIsMuted] = useState(soundEngine.getMuted());
  const [volume, setVolume] = useState(soundEngine.getVolume());

  if (!isOpen) return null;

  const totalPossession = stats.homePossessionTime + stats.awayPossessionTime;
  const homePossPct = totalPossession > 0 ? Math.round((stats.homePossessionTime / totalPossession) * 100) : 50;
  const awayPossPct = 100 - homePossPct;

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    soundEngine.setMuted(next);
    soundEngine.playClick();
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    soundEngine.setVolume(val);
    if (isMuted && val > 0) {
      setIsMuted(false);
      soundEngine.setMuted(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/60 backdrop-blur-xs select-none font-kairo-body">
      <div className="kairo-panel bg-[#fff6d9] w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden text-[#221a12]">
        {/* Chunky title bar */}
        <div className="bg-[#f04438] px-4 py-2.5 flex items-center justify-between border-b-[3px] border-[#221a12]">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚽</span>
            <h2 className="font-pixel text-[10px] sm:text-xs tracking-wider text-white drop-shadow-[2px_2px_0_rgba(0,0,0,0.55)]">
              MATCH MENU!
            </h2>
          </div>
          <button
            onClick={() => {
              soundEngine.playClick();
              onClose();
            }}
            className="kairo-btn w-8 h-8 bg-[#ffd93b] text-[#221a12] font-pixel text-[10px] flex items-center justify-center cursor-pointer"
          >
            X
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex bg-[#e8d9a8] border-b-[3px] border-[#221a12] font-extrabold text-xs">
          {[
            { id: 'controls', label: 'Settings', icon: '⚙️' },
            { id: 'stats', label: 'Stats', icon: '📊' },
            { id: 'rosters', label: 'Squad', icon: '👥' },
            { id: 'log', label: 'Log', icon: '📜' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                soundEngine.playClick();
                setActiveTab(tab.id as any);
              }}
              className={`flex-1 py-2 px-1 text-center border-r-[3px] border-[#221a12] last:border-r-0 transition-all cursor-pointer flex items-center justify-center gap-1 ${
                activeTab === tab.id
                  ? 'bg-[#ffd93b] text-[#221a12]'
                  : 'text-[#6b5d2e] hover:bg-[#f2e6bd]'
              }`}
            >
              <span>{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Tab Body */}
        <div className="p-4 overflow-y-auto flex-1 space-y-4 text-xs sm:text-sm font-extrabold">
          {/* TAB 1: CONTROLS */}
          {activeTab === 'controls' && (
            <div className="space-y-4">
              {/* Simulation Speed */}
              <div>
                <label className="block text-[#6b5d2e] mb-1.5 uppercase text-[10px] tracking-wider font-black">
                  Game Speed!
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'Pause', val: 0, icon: <Pause className="w-3.5 h-3.5" /> },
                    { label: '1x Play', val: 1, icon: <Play className="w-3.5 h-3.5" /> },
                    { label: '2x Fast', val: 2, icon: <FastForward className="w-3.5 h-3.5" /> },
                    { label: '4x Zoom', val: 4, icon: <FastForward className="w-3.5 h-3.5" /> },
                  ].map((s) => (
                    <button
                      key={s.val}
                      onClick={() => {
                        soundEngine.playClick();
                        onSetGameSpeed(s.val);
                      }}
                      className={`kairo-btn py-2 px-1 flex flex-col items-center justify-center gap-1 cursor-pointer font-black text-[10px] sm:text-xs ${
                        gameSpeed === s.val
                          ? 'bg-[#43c828] text-white kairo-btn-selected'
                          : 'bg-white text-[#221a12]'
                      }`}
                    >
                      {s.icon}
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Pitch Theme */}
              <div>
                <label className="block text-[#6b5d2e] mb-1.5 uppercase text-[10px] tracking-wider font-black">
                  Pitch Style!
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'dirt', label: 'Dirt Pitch', desc: 'Schoolyard classic!' },
                    { id: 'grass', label: 'Grass Turf', desc: 'Lush and green!' },
                    { id: 'sunset', label: 'Sunset', desc: 'Golden evening!' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        soundEngine.playClick();
                        onSetPitchTheme(t.id as PitchTheme);
                      }}
                      className={`kairo-btn p-2 text-left cursor-pointer ${
                        pitchTheme === t.id
                          ? 'bg-[#29a3e8] text-white kairo-btn-selected'
                          : 'bg-white text-[#221a12]'
                      }`}
                    >
                      <div className="font-black text-xs">{t.label}</div>
                      <div className={`text-[10px] mt-0.5 ${pitchTheme === t.id ? 'text-white/85' : 'text-[#6b5d2e]'}`}>{t.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Camera Tracking */}
              <div>
                <label className="block text-[#6b5d2e] mb-1.5 uppercase text-[10px] tracking-wider font-black">
                  Camera Crew!
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'follow_ball', label: 'Ball Cam', desc: 'Chase the action!' },
                    { id: 'follow_star', label: 'Star Cam', desc: 'Follow your ace!' },
                    { id: 'center_pitch', label: 'Wide Cam', desc: 'See it all!' },
                  ].map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        soundEngine.playClick();
                        onSetCameraMode(c.id as CameraMode);
                      }}
                      className={`kairo-btn p-2 text-left cursor-pointer ${
                        cameraMode === c.id
                          ? 'bg-[#ff7a1a] text-white kairo-btn-selected'
                          : 'bg-white text-[#221a12]'
                      }`}
                    >
                      <div className="font-black text-xs">{c.label}</div>
                      <div className={`text-[10px] mt-0.5 ${cameraMode === c.id ? 'text-white/85' : 'text-[#6b5d2e]'}`}>{c.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Audio Controls */}
              <div>
                <label className="block text-[#6b5d2e] mb-1.5 uppercase text-[10px] tracking-wider font-black">
                  Sound Dugout!
                </label>
                <div className="kairo-panel-sm bg-white flex items-center gap-3 p-2.5">
                  <button
                    onClick={toggleMute}
                    className="kairo-btn p-1.5 bg-[#ffd93b] text-[#221a12] cursor-pointer"
                  >
                    {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    className="flex-1 accent-[#f04438] cursor-pointer"
                  />
                  <span className="text-[#6b5d2e] text-xs w-10 text-right font-black">
                    {isMuted ? 'MUTE' : `${Math.round(volume * 100)}%`}
                  </span>
                </div>
              </div>

              {/* Match Action Buttons */}
              <div className="pt-2 border-t-[3px] border-[#221a12]/15 flex flex-wrap gap-2">
                <button
                  onClick={() => {
                    soundEngine.playClick();
                    onRestartKickoff();
                    onClose();
                  }}
                  className="kairo-btn flex-1 py-2 px-3 bg-[#29a3e8] text-white font-black text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Kickoff Again!
                </button>

                {half === 'HT' && (
                  <button
                    onClick={() => {
                      soundEngine.playClick();
                      onStartSecondHalf();
                      onClose();
                    }}
                    className="kairo-btn flex-1 py-2 px-3 bg-[#43c828] text-white font-black text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    Start 2nd Half!
                  </button>
                )}

                <button
                  onClick={() => {
                    soundEngine.playClick();
                    onRestartMatch();
                    onClose();
                  }}
                  className="kairo-btn flex-1 py-2 px-3 bg-[#f04438] text-white font-black text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  New Match!
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: MATCH STATS */}
          {activeTab === 'stats' && (
            <div className="space-y-3">
              {/* Score header */}
              <div className="kairo-panel-sm bg-white flex items-center justify-around p-3 text-center">
                <div className="flex-1">
                  <div className="font-black text-[#f04438] text-sm">{homeTeam.name}</div>
                  <div className="font-pixel text-[#221a12] text-2xl mt-1">{homeTeam.score}</div>
                </div>
                <div className="font-pixel text-[#6b5d2e] text-[10px] px-2">VS</div>
                <div className="flex-1">
                  <div className="font-black text-[#29a3e8] text-sm">{awayTeam.name}</div>
                  <div className="font-pixel text-[#221a12] text-2xl mt-1">{awayTeam.score}</div>
                </div>
              </div>

              {/* Possession Bar */}
              <div className="kairo-panel-sm bg-white p-3">
                <div className="flex justify-between text-xs font-black mb-1">
                  <span className="text-[#f04438]">Ball Time: {homePossPct}%</span>
                  <span className="text-[#29a3e8]">{awayPossPct}%</span>
                </div>
                <div className="h-4 bg-[#e8d9a8] rounded-full overflow-hidden flex border-2 border-[#221a12]">
                  <div className="bg-[#f04438] transition-all" style={{ width: `${homePossPct}%` }} />
                  <div className="bg-[#29a3e8] transition-all" style={{ width: `${awayPossPct}%` }} />
                </div>
              </div>

              {/* Stat rows */}
              <div className="kairo-panel-sm bg-white p-3 space-y-1.5">
                {[
                  { label: 'Total Shots', home: stats.homeShots, away: stats.awayShots },
                  { label: 'Shots on Target', home: stats.homeShotsOnTarget, away: stats.awayShotsOnTarget },
                  { label: 'Completed Passes', home: stats.homePasses, away: stats.awayPasses },
                  { label: 'Slide Tackles', home: stats.homeTackles, away: stats.awayTackles },
                  { label: 'Goalkeeper Saves', home: stats.homeSaves, away: stats.awaySaves },
                  { label: 'Corner Kicks', home: stats.homeCorners, away: stats.awayCorners },
                  { label: 'Throw-Ins', home: stats.homeThrowIns, away: stats.awayThrowIns },
                ].map((row, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1 border-b-2 border-[#e8d9a8] last:border-none text-xs">
                    <span className="font-pixel text-[#f04438] text-[10px] w-12 text-center">{row.home}</span>
                    <span className="text-[#221a12] font-black">{row.label}</span>
                    <span className="font-pixel text-[#29a3e8] text-[10px] w-12 text-center">{row.away}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: ROSTERS */}
          {activeTab === 'rosters' && (
            <div className="space-y-4">
              {/* Home Team Squad */}
              <div>
                <h3 className="font-black text-[#f04438] text-xs mb-2 flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#f04438] border-2 border-[#221a12] inline-block" />
                  {homeTeam.name} Stars!
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {homeTeam.players.map((p) => (
                    <div
                      key={p.id}
                      onClick={() => {
                        soundEngine.playClick();
                        onSelectPlayer(p.id);
                        onClose();
                      }}
                      className="kairo-panel-sm bg-white hover:brightness-95 p-2 cursor-pointer flex items-center justify-between transition-all"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-pixel text-[10px] text-[#ff7a1a] w-6">#{p.number}</span>
                        <div>
                          <div className="font-black text-[#221a12] text-xs">{p.name}</div>
                          <div className="text-[10px] text-[#6b5d2e]">
                            SPD {p.stats.speed} • KCK {p.stats.kick} • DEF {p.stats.defense}
                          </div>
                        </div>
                      </div>
                      <span className="font-pixel text-[8px] px-1.5 py-1 rounded-md bg-[#f04438] text-white border-2 border-[#221a12]">
                        {p.position}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Away Team Squad */}
              <div>
                <h3 className="font-black text-[#29a3e8] text-xs mb-2 flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#29a3e8] border-2 border-[#221a12] inline-block" />
                  {awayTeam.name} Stars!
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {awayTeam.players.map((p) => (
                    <div
                      key={p.id}
                      onClick={() => {
                        soundEngine.playClick();
                        onSelectPlayer(p.id);
                        onClose();
                      }}
                      className="kairo-panel-sm bg-white hover:brightness-95 p-2 cursor-pointer flex items-center justify-between transition-all"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-pixel text-[10px] text-[#ff7a1a] w-6">#{p.number}</span>
                        <div>
                          <div className="font-black text-[#221a12] text-xs">{p.name}</div>
                          <div className="text-[10px] text-[#6b5d2e]">
                            SPD {p.stats.speed} • KCK {p.stats.kick} • DEF {p.stats.defense}
                          </div>
                        </div>
                      </div>
                      <span className="font-pixel text-[8px] px-1.5 py-1 rounded-md bg-[#29a3e8] text-white border-2 border-[#221a12]">
                        {p.position}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: EVENT LOG */}
          {activeTab === 'log' && (
            <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
              {commentaryLog.length === 0 ? (
                <div className="text-center text-[#6b5d2e] py-6">No match events yet. Kick off!</div>
              ) : (
                commentaryLog.map((log) => (
                  <div
                    key={log.id}
                    className="kairo-panel-sm bg-white p-2 flex items-start gap-2 text-xs"
                  >
                    <span className="font-pixel text-[#ff7a1a] text-[9px] shrink-0 mt-0.5">
                      {log.minute}&apos;
                    </span>
                    <span className="text-[#221a12] flex-1">{log.text}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bg-[#e8d9a8] px-4 py-2 border-t-[3px] border-[#221a12] flex justify-between items-center gap-2">
          <span className="text-[10px] text-[#6b5d2e] font-black hidden sm:inline">[Space] Pause • [1/2/4] Speed • [M] Mute • [C] Cam</span>
          <button
            onClick={() => {
              soundEngine.playClick();
              onClose();
            }}
            className="kairo-btn font-pixel px-3 py-2 bg-[#43c828] text-white text-[9px] sm:text-[10px] cursor-pointer ml-auto"
          >
            PLAY!
          </button>
        </div>
      </div>
    </div>
  );
};
