// All sounds are synthesised with Web Audio, so there are no assets to load.
// The context can only start after a user gesture; `unlock()` is called from
// the menu's first key press or click.

type WhistleKind = 'short' | 'long' | 'end';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private brown: AudioBuffer | null = null;
  private crowdGain: GainNode | null = null;
  enabled = true;
  crowdEnabled = true;

  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    // Brown noise (integrated white noise): a soft rumble instead of hiss.
    this.brown = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      b[i] = last * 3.5;
    }
    this.startCrowd();
    this.applySettings();
  }

  applySettings(): void {
    if (!this.ctx || !this.master || !this.crowdGain) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.enabled ? 0.7 : 0, t, 0.05);
    this.crowdGain.gain.setTargetAtTime(this.crowdEnabled ? 0.03 : 0, t, 0.3);
  }

  kick(power: number): void {
    this.withCtx((ctx, out, t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.25 + 0.5 * power, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.16);
      this.noiseBurst(t, 0.035, 1500, 0.15 + 0.3 * power);
    });
  }

  bounce(power: number): void {
    this.withCtx((ctx, out, t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(95, t);
      o.frequency.exponentialRampToValueAtTime(55, t + 0.07);
      g.gain.setValueAtTime(0.1 + 0.3 * power, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.09);
    });
  }

  post(): void {
    this.withCtx((ctx, out, t) => {
      for (const [f, a] of [
        [523, 0.25],
        [1312, 0.12],
        [2210, 0.06],
      ]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(a, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.62);
      }
    });
  }

  save(): void {
    this.withCtx((_ctx, _out, t) => this.noiseBurst(t, 0.08, 500, 0.5));
  }

  whistle(kind: WhistleKind): void {
    this.withCtx((_ctx, _out, t) => {
      const blasts = kind === 'end' ? [0.25, 0.25, 0.8] : kind === 'long' ? [0.6] : [0.22];
      let at = t;
      for (const len of blasts) {
        this.tone(at, len);
        at += len + 0.12;
      }
    });
  }

  cheer(): void {
    this.withCtx((ctx, out, t) => {
      if (!this.noise) return;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 900;
      band.Q.value = 0.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.4);
      g.gain.setValueAtTime(0.35, t + 1.6);
      g.gain.exponentialRampToValueAtTime(0.001, t + 3.8);
      src.connect(band).connect(g).connect(out);
      src.start(t);
      src.stop(t + 4);
    });
  }

  blip(): void {
    this.withCtx((ctx, out, t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.07);
    });
  }

  private withCtx(fn: (ctx: AudioContext, out: AudioNode, t: number) => void): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    fn(this.ctx, this.master, this.ctx.currentTime);
  }

  /** Referee's pea whistle: ~2.9 kHz with a fast warble. */
  private tone(t: number, len: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    const g = ctx.createGain();
    o.frequency.value = 2900;
    lfo.frequency.value = 38;
    depth.gain.value = 140;
    lfo.connect(depth).connect(o.frequency);
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.setValueAtTime(0.12, t + len - 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(this.master!);
    o.start(t);
    lfo.start(t);
    o.stop(t + len + 0.02);
    lfo.stop(t + len + 0.02);
  }

  private noiseBurst(t: number, len: number, freq: number, gain: number): void {
    const ctx = this.ctx!;
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random());
    src.stop(t + len + 0.01);
  }

  /** Distant stadium rumble. Synthesis only goes so far: swap in a recorded loop for a real crowd. */
  private startCrowd(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'lowpass';
    band.frequency.value = 420;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    const swell = ctx.createOscillator();
    const swellDepth = ctx.createGain();
    swell.frequency.value = 0.07;
    swellDepth.gain.value = 0.01;
    swell.connect(swellDepth).connect(this.crowdGain.gain);
    src.connect(band).connect(this.crowdGain).connect(this.master!);
    src.start();
    swell.start();
  }
}

export const sfx = new Sfx();
