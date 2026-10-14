/**
 * Web Audio API retro 16-bit sound engine for Pocket League Match Day
 * Zero external audio assets required; entirely synthesized for instant playback.
 */

class SoundEngine {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private volume: number = 0.6;
  private crowdNode: AudioNode | null = null;
  private crowdGain: GainNode | null = null;

  constructor() {
    // Initialized on first user interaction to comply with browser autoplay policies
  }

  private initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
    if (this.crowdGain) {
      this.crowdGain.gain.setValueAtTime(muted ? 0 : 0.05 * this.volume, this.ctx?.currentTime || 0);
    }
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.crowdGain && !this.isMuted) {
      this.crowdGain.gain.setValueAtTime(0.05 * this.volume, this.ctx?.currentTime || 0);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  /**
   * Authentic Referee Whistle: Dual high frequencies with gentle vibrato flutter
   */
  public playWhistle(short: boolean = false) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const duration = short ? 0.22 : 0.65;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const vibrato = this.ctx.createOscillator();
    const vibratoGain = this.ctx.createGain();
    const masterGain = this.ctx.createGain();

    osc1.type = 'triangle';
    osc2.type = 'sine';

    osc1.frequency.setValueAtTime(2600, t);
    osc2.frequency.setValueAtTime(2900, t);

    // Flutter
    vibrato.frequency.setValueAtTime(32, t);
    vibratoGain.gain.setValueAtTime(140, t);
    vibrato.connect(osc1.frequency);
    vibrato.connect(osc2.frequency);

    masterGain.gain.setValueAtTime(0, t);
    masterGain.gain.linearRampToValueAtTime(0.18 * this.volume, t + 0.02);
    masterGain.gain.setValueAtTime(0.18 * this.volume, t + duration - 0.04);
    masterGain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    osc1.connect(masterGain);
    osc2.connect(masterGain);
    masterGain.connect(this.ctx.destination);

    vibrato.start(t);
    osc1.start(t);
    osc2.start(t);

    vibrato.stop(t + duration);
    osc1.stop(t + duration);
    osc2.stop(t + duration);
  }

  /**
   * Double whistle for halftime / fulltime
   */
  public playDoubleWhistle() {
    this.playWhistle(true);
    setTimeout(() => {
      this.playWhistle(false);
    }, 280);
  }

  /**
   * Ball kick / pass thump
   */
  public playKick(power: number = 0.5) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    const startFreq = 220 + power * 120;
    osc.frequency.setValueAtTime(startFreq, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);

    gain.gain.setValueAtTime(0.3 * this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(t);
    osc.stop(t + 0.12);
  }

  /**
   * Throw-in aerodynamic release whoosh sound
   */
  public playThrow() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.18);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.sin((i / bufferSize) * Math.PI);
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, t);
    filter.frequency.exponentialRampToValueAtTime(320, t + 0.18);
    filter.Q.setValueAtTime(2.2, t);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.24 * this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(t);
  }

  /**
   * Slide tackle / clash sparkle sound
   */
  public playTackle() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    // White noise sweep
    const bufferSize = this.ctx.sampleRate * 0.12;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1200, t);
    filter.frequency.exponentialRampToValueAtTime(300, t + 0.12);
    filter.Q.setValueAtTime(3, t);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.22 * this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(t);
  }

  /**
   * Goalkeeper save glove impact
   */
  public playSave() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.18);

    gain.gain.setValueAtTime(0.25 * this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(t);
    osc.stop(t + 0.18);
  }

  /**
   * Post clang metallic ping
   */
  public playPostHit() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc1.type = 'square';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(1420, t);
    osc2.frequency.setValueAtTime(2150, t);

    gain.gain.setValueAtTime(0.2 * this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.35);
    osc2.stop(t + 0.35);
  }

  /**
   * Crowd roar upon a goal!
   */
  public playCrowdGoal() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const duration = 2.4;

    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(450, t);
    filter.frequency.linearRampToValueAtTime(1400, t + 0.4);
    filter.frequency.exponentialRampToValueAtTime(500, t + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.28 * this.volume, t + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(t);

    // Also play celebratory chime
    this.playCelebrationChime();
  }

  /**
   * 8-bit retro fanfare when goal is scored
   */
  private playCelebrationChime() {
    if (this.isMuted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6

    notes.forEach((freq, idx) => {
      const startTime = t + 0.08 + idx * 0.12;
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.18 * this.volume, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.28);

      osc.connect(gain);
      gain.connect(this.ctx!.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.28);
    });
  }

  /**
   * Gentle UI click
   */
  public playClick() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.04);

    gain.gain.setValueAtTime(0.1 * this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(t);
    osc.stop(t + 0.04);
  }
}

export const soundEngine = new SoundEngine();
