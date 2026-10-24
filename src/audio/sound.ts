import * as THREE from 'three';
import type { WeatherId } from '../campaign/weather';
import type { Entity, Kind } from '../sim/entities';
import type { Effect, World } from '../sim/world';
import type { FrameEvents } from '../render/events';
import './sound.css';

/**
 * Procedural battlefield audio with WebAudio: no samples, everything is filtered noise and oscillators.
 * Sounds are placed relative to the camera: distance sets loudness, air absorption (a low-pass that closes
 * with range) and the speed-of-sound delay; the camera's right vector sets stereo pan.
 */

const SOUND_SPEED = 343;
const STORE_KEY = 'ad-sound';
/** Older builds stored only the mute flag. */
const OLD_KEY = 'ad-sound-muted';

interface Spatial {
  gain: number;
  pan: number;
  cutoff: number;
  delay: number;
}

/** A continuous sound whose level, pan and muffling follow its nearest source. */
class Loop {
  readonly input: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly panner: StereoPannerNode;
  private readonly out: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.input = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.panner = ctx.createStereoPanner();
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.input.connect(this.lp).connect(this.panner).connect(this.out).connect(dest);
  }

  set(s: Spatial | null, level = 1, tc = 0.06): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(s ? s.gain * level : 0, t, tc);
    if (!s) return;
    this.panner.pan.setTargetAtTime(s.pan, t, 0.08);
    this.lp.frequency.setTargetAtTime(s.cutoff, t, 0.1);
  }
}

/** Wind bed and rain hiss levels for each kind of weather. */
const WIND_LEVEL: Partial<Record<WeatherId, number>> = { overcast: 1.3, rain: 1.6, fog: 0.4, wind: 4, storm: 5 };
const RAIN_LEVEL: Partial<Record<WeatherId, number>> = { rain: 0.05, storm: 0.09 };

/**
 * Three seconds of noise that loops without a click: the end is crossfaded into the start, so the
 * waveform runs on continuously where the buffer wraps (brown noise drifts, so a plain loop would pop).
 */
function loopBuffer(ctx: AudioContext, next: () => number): AudioBuffer {
  const len = ctx.sampleRate * 3;
  const fade = Math.floor(ctx.sampleRate * 0.25);
  const x = new Float32Array(len + fade);
  for (let i = 0; i < x.length; i++) x[i] = next();
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const k = i < fade ? i / fade : 1;
    d[i] = i < fade ? x[i] * k + x[len + i] * (1 - k) : x[i];
  }
  return buf;
}

/** Stereo reverb impulse: decaying noise that darkens as it fades, like echoes off open country. */
function impulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const a = 1 - t * 0.97;
      lp += (Math.random() * 2 - 1 - lp) * a * 0.6;
      // A gap before the first echoes, then an exponential tail.
      const env = i < ctx.sampleRate * 0.02 ? 0 : Math.exp(-5.5 * t);
      d[i] = lp * env;
    }
  }
  return buf;
}

const JET: Partial<Record<Kind, number>> = { fighter: 2500, strike: 2500, sead: 2500, bomber: 4000, soj: 3500, airliner: 3500 };

export class SoundEngine {
  muted = false;
  /** Master volume and alert-tone volume, 0..1. */
  volume = 0.7;
  alerts = 0.6;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private ui!: GainNode;
  private white!: AudioBuffer;
  private brown!: AudioBuffer;
  private loops!: { jet: Loop; drone: Loop; cruise: Loop; ciws: Loop; gun35: Loop; wind: Loop; rain: Loop; helo: Loop };
  private jetFilter!: BiquadFilterNode;
  private droneOsc: OscillatorNode[] = [];
  private cruiseFilter!: BiquadFilterNode;
  private voices = 0;
  private lastAlert = -10;
  private stillFor = 0;
  private speedAvg = 1;
  /** Sim time each gun last fired: a short hold bridges the steps where it is between bursts. */
  private readonly lastShot = new WeakMap<object, number>();
  private suspendedByPause = false;
  private readonly btn: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly right = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { volume?: number; alerts?: number; muted?: boolean } | null;
      if (saved) {
        this.volume = clamp01(saved.volume ?? this.volume);
        this.alerts = clamp01(saved.alerts ?? this.alerts);
        this.muted = !!saved.muted;
      } else this.muted = localStorage.getItem(OLD_KEY) === '1';
    } catch {
      /* storage unavailable */
    }
    // A hidden tab stops the frame loop and with it the sim: silence the loops rather than leave them droning.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
    const start = (): void => this.start();
    window.addEventListener('pointerdown', start, { capture: true });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggle();
      start();
    });

    // Speaker button in the top bar; it opens a small panel with the volume sliders and mute.
    const wrap = document.createElement('div');
    wrap.className = 'snd';
    this.btn = document.createElement('button');
    this.btn.id = 'snd-btn';
    this.btn.title = 'Sound (M mutes)';
    this.btn.setAttribute('aria-haspopup', 'true');
    this.panel = document.createElement('div');
    this.panel.id = 'snd-panel';
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <label for="snd-vol">Volume <output id="snd-vol-v"></output></label>
      <input id="snd-vol" type="range" min="0" max="100" step="1">
      <label for="snd-alert">Alert tones <output id="snd-alert-v"></output></label>
      <input id="snd-alert" type="range" min="0" max="100" step="1">
      <button id="snd-mute" type="button">Mute</button>
      <p>M mutes or unmutes at any time.</p>`;
    wrap.append(this.btn, this.panel);
    const help = document.getElementById('help-btn');
    if (help) help.before(wrap);
    else document.body.append(wrap);

    const vol = this.panel.querySelector<HTMLInputElement>('#snd-vol')!;
    const alert = this.panel.querySelector<HTMLInputElement>('#snd-alert')!;
    vol.value = String(Math.round(this.volume * 100));
    alert.value = String(Math.round(this.alerts * 100));
    vol.addEventListener('input', () => {
      this.volume = Number(vol.value) / 100;
      this.muted = false;
      this.apply();
    });
    alert.addEventListener('input', () => {
      this.alerts = Number(alert.value) / 100;
      this.apply();
    });
    // A short tone so the alert level can be judged while dragging.
    alert.addEventListener('change', () => {
      if (this.ctx?.state === 'running') this.tone([784, 587], 0.16, 0.04, 'triangle', 0.25);
    });
    this.panel.querySelector('#snd-mute')!.addEventListener('click', () => this.toggle());
    this.btn.addEventListener('click', () => {
      this.panel.hidden = !this.panel.hidden;
      this.btn.setAttribute('aria-expanded', String(!this.panel.hidden));
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.panel.hidden && !wrap.contains(e.target as Node)) this.panel.hidden = true;
    });
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.panel.hidden = true;
        this.btn.focus();
      }
    });
    this.paint();
  }

  toggle(): void {
    this.muted = !this.muted;
    this.apply();
  }

  private apply(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ volume: this.volume, alerts: this.alerts, muted: this.muted }));
    } catch {
      /* storage unavailable */
    }
    if (this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
      this.ui.gain.setTargetAtTime(this.alerts * 0.8, this.ctx.currentTime, 0.05);
    }
    this.paint();
  }

  private paint(): void {
    const silent = this.muted || this.volume === 0;
    const waves = silent
      ? '<path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.4" fill="none"/>'
      : this.volume < 0.4
        ? '<path d="M11 5.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" stroke-width="1.3" fill="none"/>'
        : '<path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.6 3.6a6 6 0 0 1 0 8.8" stroke="currentColor" stroke-width="1.3" fill="none"/>';
    this.btn.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/>${waves}</svg>`;
    this.btn.setAttribute('aria-label', silent ? 'Sound settings, muted' : `Sound settings, volume ${Math.round(this.volume * 100)}%`);
    this.btn.classList.toggle('on', !silent && !!this.ctx);
    this.panel.querySelector('#snd-vol-v')!.textContent = this.muted ? 'muted' : `${Math.round(this.volume * 100)}%`;
    this.panel.querySelector('#snd-alert-v')!.textContent = `${Math.round(this.alerts * 100)}%`;
    const mute = this.panel.querySelector('#snd-mute')!;
    mute.textContent = this.muted ? 'Unmute' : 'Mute';
    mute.classList.toggle('on', this.muted);
  }

  /** Browsers only allow audio after a user gesture, so the graph is built on the first click or key. */
  private start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.suspendedByPause) void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.ui = ctx.createGain();
    this.ui.gain.value = this.alerts * 0.8;
    this.ui.connect(this.master);

    this.white = loopBuffer(ctx, () => Math.random() * 2 - 1);
    let last = 0;
    this.brown = loopBuffer(ctx, () => {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      return last * 3.5;
    });

    // A short room of hills: every effect sends a little to a reverb, which smooths and places the sound.
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 2.6);
    const wet = this.gain(0.32);
    this.sfx.connect(verb).connect(wet).connect(this.master);
    this.buildLoops();
    this.paint();
  }

  // ---------------------------------------------------------------- building blocks

  private noise(buf: AudioBuffer, t: number, stop?: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(t, Math.random() * 2.5);
    if (stop !== undefined) s.stop(stop);
    return s;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private gain(v: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = v;
    return g;
  }

  /** Attack to peak, then an exponential tail reaching silence after `decay` seconds. */
  private env(p: AudioParam, t: number, attack: number, peak: number, decay: number, hold = 0): void {
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(peak, t + attack);
    if (hold > 0) p.setValueAtTime(peak, t + attack + hold);
    p.exponentialRampToValueAtTime(0.0001, t + attack + hold + decay);
  }

  /** Output stage for a one-shot: distance gain, air absorption, pan. Returns null when inaudible or busy. */
  private oneShot(s: Spatial, level: number, life: number): GainNode | null {
    if (!this.ctx || this.muted) return null;
    const g = s.gain * level;
    if (g < 0.006 || (this.voices > 14 && g < 0.15) || this.voices > 24) return null;
    const ctx = this.ctx;
    const inp = this.gain(g);
    const lp = this.filter('lowpass', s.cutoff);
    const pan = ctx.createStereoPanner();
    pan.pan.value = s.pan;
    inp.connect(lp).connect(pan).connect(this.sfx);
    this.voices++;
    setTimeout(() => {
      this.voices--;
      inp.disconnect();
    }, (life + s.delay + 0.5) * 1000);
    return inp;
  }

  private buildLoops(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const mk = (): Loop => new Loop(ctx, this.sfx);
    this.loops = { jet: mk(), drone: mk(), cruise: mk(), ciws: mk(), gun35: mk(), wind: mk(), rain: mk(), helo: mk() };

    // Jet: broadband roar with a low rumble and a little turbine hiss.
    const L = this.loops;
    this.jetFilter = this.filter('bandpass', 550, 0.5);
    this.noise(this.white, t).connect(this.jetFilter).connect(L.jet.input);
    this.noise(this.white, t).connect(this.filter('highpass', 3200)).connect(this.gain(0.12)).connect(L.jet.input);
    this.noise(this.brown, t).connect(this.filter('lowpass', 220)).connect(this.gain(0.7)).connect(L.jet.input);

    // One-way attack drone: a buzzing two-stroke piston engine.
    const am = this.gain(0.75);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 11;
    lfo.connect(this.gain(0.25)).connect(am.gain);
    lfo.start(t);
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = 105;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = 210;
    o1.connect(this.gain(0.22)).connect(am);
    o2.connect(this.gain(0.06)).connect(am);
    o1.start(t);
    o2.start(t);
    this.droneOsc = [o1, o2];
    am.connect(this.filter('lowpass', 1800)).connect(L.drone.input);
    this.noise(this.white, t).connect(this.filter('bandpass', 900, 1)).connect(this.gain(0.08)).connect(L.drone.input);

    // Cruise missile / ARM: small turbojet whine.
    this.cruiseFilter = this.filter('bandpass', 2300, 1.6);
    this.noise(this.white, t).connect(this.cruiseFilter).connect(this.gain(0.9)).connect(L.cruise.input);
    const whine = ctx.createOscillator();
    whine.frequency.value = 5600;
    whine.connect(this.gain(0.025)).connect(L.cruise.input);
    whine.start(t);
    this.noise(this.brown, t).connect(this.filter('lowpass', 300)).connect(this.gain(0.4)).connect(L.cruise.input);

    // CIWS: a 75 Hz rate of fire gives the characteristic tearing "brrrt".
    const gate = this.gain(0.45);
    const rof = ctx.createOscillator();
    rof.type = 'square';
    rof.frequency.value = 75;
    rof.connect(this.gain(0.55)).connect(gate.gain);
    rof.start(t);
    this.noise(this.white, t).connect(this.filter('bandpass', 1100, 0.7)).connect(gate).connect(L.ciws.input);
    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    body.frequency.value = 75;
    body.connect(this.filter('lowpass', 520)).connect(this.gain(0.55)).connect(L.ciws.input);
    body.start(t);
    this.noise(this.brown, t).connect(this.gain(0.35)).connect(L.ciws.input);

    // 35 mm revolver cannon: about 17 heavy shots a second, each a deep thud with a sharp report.
    const pulse = ctx.createOscillator();
    // A falling sawtooth on the gain: each shot hits at full level and dies away before the next.
    pulse.type = 'sawtooth';
    pulse.frequency.value = 17;
    const shot = this.gain(0.5);
    const duty = this.gain(-0.5);
    pulse.connect(duty).connect(shot.gain);
    pulse.start(t);
    this.noise(this.brown, t).connect(this.filter('lowpass', 380)).connect(this.gain(1.6)).connect(shot);
    this.noise(this.white, t).connect(this.filter('bandpass', 1500, 0.8)).connect(this.gain(0.35)).connect(shot);
    const thud = ctx.createOscillator();
    thud.frequency.value = 52;
    thud.connect(this.gain(0.5)).connect(shot);
    thud.start(t);
    shot.connect(this.filter('lowpass', 2600)).connect(L.gun35.input);

    // Wind bed, slowly gusting.
    const gust = this.gain(0.7);
    const g2 = ctx.createOscillator();
    g2.frequency.value = 0.07;
    g2.connect(this.gain(0.3)).connect(gust.gain);
    g2.start(t);
    this.noise(this.brown, t).connect(this.filter('lowpass', 650)).connect(gust).connect(L.wind.input);

    // Attack helicopter: the thump of the blades over a turbine whine.
    const slap = this.gain(0.5);
    const blade = ctx.createOscillator();
    blade.type = 'sawtooth';
    blade.frequency.value = 19;
    blade.connect(this.gain(0.5)).connect(slap.gain);
    blade.start(t);
    this.noise(this.brown, t).connect(this.filter('lowpass', 500)).connect(slap).connect(L.helo.input);
    this.noise(this.white, t).connect(this.filter('bandpass', 2400, 3)).connect(this.gain(0.05)).connect(L.helo.input);

    // Rain: a soft broadband hiss with a little low patter.
    this.noise(this.white, t).connect(this.filter('bandpass', 2600, 0.4)).connect(L.rain.input);
    this.noise(this.brown, t).connect(this.filter('lowpass', 400)).connect(this.gain(0.4)).connect(L.rain.input);
  }

  // ---------------------------------------------------------------- placement

  private spatial(cam: THREE.Camera, x: number, y: number, z: number, ref: number, speed: number): Spatial {
    const p = this.tmp.set(x, y, z).sub(cam.position);
    const d = Math.max(1, p.length());
    return {
      gain: 1 / (1 + (d / ref) ** 1.25),
      pan: THREE.MathUtils.clamp(p.dot(this.right) / d, -1, 1) * 0.85,
      cutoff: THREE.MathUtils.clamp(20000 * Math.exp(-d / 3200), 220, 20000),
      delay: Math.min(d / SOUND_SPEED / Math.max(speed, 1), 2),
    };
  }

  private spatialSim(cam: THREE.Camera, p: { x: number; y: number; z: number }, ref: number, speed: number): Spatial {
    return this.spatial(cam, p.x, p.z, -p.y, ref, speed);
  }

  /** Doppler factor for an entity moving relative to the camera. */
  private doppler(cam: THREE.Camera, e: Entity): number {
    const dx = cam.position.x - e.pos.x;
    const dy = cam.position.y - e.pos.z;
    const dz = cam.position.z + e.pos.y;
    const d = Math.max(1, Math.hypot(dx, dy, dz));
    const vr = (e.vel.x * dx + e.vel.z * dy - e.vel.y * dz) / d;
    return THREE.MathUtils.clamp(SOUND_SPEED / (SOUND_SPEED - Math.min(vr, 300)), 0.55, 1.8);
  }

  // ---------------------------------------------------------------- one-shots

  private launch(code: string, s: Spatial): void {
    const dur = code === 'LR' ? 5.5 : code === 'MR' ? 4.5 : code === 'SH' ? 2.4 : 4;
    const level = code === 'LR' ? 1 : code === 'MR' ? 0.85 : code === 'SH' ? 0.65 : 0.5;
    const out = this.oneShot(s, level, dur + 3);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + s.delay;
    const end = t + dur + 3;
    // Ignition thump and crack.
    const th = ctx.createOscillator();
    th.frequency.setValueAtTime(85, t);
    th.frequency.exponentialRampToValueAtTime(32, t + 0.4);
    const thg = this.gain(0);
    this.env(thg.gain, t, 0.006, 0.9, 0.5);
    th.connect(thg).connect(out);
    th.start(t);
    th.stop(t + 0.7);
    const cr = this.gain(0);
    this.env(cr.gain, t, 0.003, 0.7, 0.2);
    this.noise(this.white, t, t + 0.3).connect(this.filter('lowpass', 2600)).connect(cr).connect(out);
    // Motor roar, flickering, receding (the low-pass closes as the missile climbs away).
    const lp = this.filter('lowpass', 2600);
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + dur + 2);
    const flick = this.gain(0.6);
    this.noise(this.white, t, end).connect(this.filter('lowpass', 28)).connect(this.gain(4)).connect(flick.gain);
    const roar = this.gain(0);
    this.env(roar.gain, t, 0.12, 0.85, dur * 0.6 + 2, dur * 0.4);
    this.noise(this.white, t, end).connect(lp).connect(flick).connect(roar).connect(out);
    const rum = this.gain(0);
    this.env(rum.gain, t, 0.1, 1.1, dur + 1.5);
    this.noise(this.brown, t, end).connect(this.filter('lowpass', 170)).connect(rum).connect(out);
  }

  /**
   * An explosion in layers: the shock-front crack, the fireball's roar (its low-pass sweeping down as it
   * rolls away), a sub-bass thump, a crackle of debris and, for big ones, a rolling echo off the hills.
   * Distance does the rest through the one-shot's air absorption and the reverb send.
   */
  private boom(kind: Effect['kind'], s: Spatial): void {
    const p =
      kind === 'small'
        ? { crack: 0.12, body: 1.3, sub: 0.8, subG: 0.55, cut: 4200, lvl: 0.75, debris: 0.9, echo: 0 }
        : kind === 'blast'
          ? { crack: 0.18, body: 2.6, sub: 1.6, subG: 0.9, cut: 3200, lvl: 1, debris: 2, echo: 0.6 }
          : { crack: 0.25, body: 4.8, sub: 3, subG: 1.1, cut: 2400, lvl: 1.3, debris: 3.5, echo: 1 };
    const out = this.oneShot(s, p.lvl, p.body + 6);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + s.delay;
    const jitter = 0.85 + Math.random() * 0.3;

    const cr = this.gain(0);
    this.env(cr.gain, t, 0.001, 1.1, p.crack);
    this.noise(this.white, t, t + p.crack + 0.1).connect(this.filter('highpass', 300)).connect(this.filter('lowpass', p.cut * jitter)).connect(cr).connect(out);

    const sweep = this.filter('lowpass', 1500 * jitter);
    sweep.frequency.setValueAtTime(1500 * jitter, t);
    sweep.frequency.exponentialRampToValueAtTime(140, t + p.body);
    const bd = this.gain(0);
    this.env(bd.gain, t, 0.008, 1.3, p.body);
    this.noise(this.brown, t, t + p.body + 0.1).connect(sweep).connect(bd).connect(out);

    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(72 * jitter, t);
    sub.frequency.exponentialRampToValueAtTime(22, t + p.sub);
    const sg = this.gain(0);
    this.env(sg.gain, t, 0.006, p.subG, p.sub);
    sub.connect(sg).connect(out);
    sub.start(t);
    sub.stop(t + p.sub + 0.1);

    // Debris and secondary pops: bandpassed noise chopped by an irregular gate.
    const chop = ctx.createOscillator();
    chop.type = 'square';
    chop.frequency.setValueAtTime(19 + Math.random() * 14, t);
    chop.frequency.linearRampToValueAtTime(7, t + p.debris);
    const gate = this.gain(0.5);
    chop.connect(this.gain(0.5)).connect(gate.gain);
    chop.start(t);
    chop.stop(t + p.debris + 0.6);
    const db = this.gain(0);
    db.gain.setValueAtTime(0.0001, t + 0.05);
    db.gain.exponentialRampToValueAtTime(0.28, t + 0.15);
    db.gain.exponentialRampToValueAtTime(0.0001, t + 0.15 + p.debris);
    this.noise(this.white, t, t + p.debris + 0.4).connect(this.filter('bandpass', 2600, 0.9)).connect(gate).connect(db).connect(out);

    if (p.echo > 0) {
      const rl = this.gain(0);
      rl.gain.setValueAtTime(0.0001, t + 0.3);
      rl.gain.exponentialRampToValueAtTime(0.6 * p.echo, t + 0.9);
      rl.gain.exponentialRampToValueAtTime(0.25 * p.echo, t + 1.8);
      rl.gain.exponentialRampToValueAtTime(0.45 * p.echo, t + 2.6);
      rl.gain.exponentialRampToValueAtTime(0.0001, t + 6);
      this.noise(this.brown, t, t + 6.1).connect(this.filter('lowpass', 240)).connect(rl).connect(out);
    }
  }

  private tone(freqs: number[], each: number, gap: number, type: OscillatorType, level: number): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.02;
    const lp = this.filter('lowpass', 2600);
    lp.connect(this.ui);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = this.gain(0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.01);
      g.gain.setValueAtTime(level, t + each - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + each);
      o.connect(g).connect(lp);
      o.start(t);
      o.stop(t + each + 0.02);
      t += each + gap;
    }
    setTimeout(() => lp.disconnect(), (t - ctx.currentTime + 0.5) * 1000);
  }

  // ---------------------------------------------------------------- per frame

  update(w: World, ev: FrameEvents, cam: THREE.PerspectiveCamera, visible: (e: Entity) => boolean, realDt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Pausing the sim pauses the soundscape too (one-shots resume where they were).
    this.stillFor = ev.simDt > 0 ? 0 : this.stillFor + realDt;
    if (this.stillFor > 0.25 && ctx.state === 'running') {
      this.suspendedByPause = true;
      void ctx.suspend();
      return;
    }
    if (this.stillFor === 0 && this.suspendedByPause) {
      this.suspendedByPause = false;
      void ctx.resume();
    }
    if (ctx.state !== 'running') return;
    // Time compression, smoothed: frames alternate between zero and two sim steps, which would jitter it.
    this.speedAvg += (Math.max(1, ev.simDt / Math.max(realDt, 1e-3)) - this.speedAvg) * Math.min(1, realDt * 4);
    const speed = Math.max(1, this.speedAvg);
    this.right.setFromMatrixColumn(cam.matrixWorld, 0);

    for (const m of ev.launches) {
      const p = m.trail[0] ?? m.pos;
      this.launch(m.spec.code, this.spatialSim(cam, p, m.spec.code === 'LR' ? 2600 : 2000, speed));
    }
    for (const f of ev.blasts) this.boom(f.kind, this.spatialSim(cam, f.pos, f.kind === 'small' ? 1600 : f.kind === 'blast' ? 2600 : 5000, speed));
    for (const l of ev.logs) {
      if (w.t - this.lastAlert < 2) continue;
      if (l.level === 'raid') {
        this.lastAlert = w.t;
        this.tone([784, 587, 784, 587], 0.16, 0.04, 'triangle', 0.25);
      } else if (l.level === 'damage') {
        this.lastAlert = w.t;
        this.tone([960, 960, 960], 0.08, 0.06, 'square', 0.12);
      }
    }

    // Continuous sources: the nearest of each kind drives its loop.
    let jet: { e: Entity; s: Spatial } | null = null;
    let drone: { e: Entity; s: Spatial } | null = null;
    let cruise: { e: Entity; s: Spatial } | null = null;
    let helo: Spatial | null = null;
    for (const e of w.entities) {
      if (!e.alive || !visible(e)) continue;
      if (e.kind === 'helo') {
        const s = this.spatialSim(cam, e.pos, 1600, speed);
        if (!helo || s.gain > helo.gain) helo = s;
        continue;
      }
      const ref = JET[e.kind] ?? (e.kind === 'drone' ? 1100 : e.kind === 'cruise' || e.kind === 'arm' ? 1500 : 0);
      if (!ref) continue;
      const s = this.spatialSim(cam, e.pos, ref, speed);
      if (JET[e.kind]) {
        if (!jet || s.gain > jet.s.gain) jet = { e, s };
      } else if (e.kind === 'drone') {
        if (!drone || s.gain > drone.s.gain) drone = { e, s };
      } else if (!cruise || s.gain > cruise.s.gain) cruise = { e, s };
    }
    const L = this.loops;
    const t = ctx.currentTime;
    L.jet.set(jet?.s ?? null, 0.9, 0.15);
    if (jet) this.jetFilter.frequency.setTargetAtTime(550 * this.doppler(cam, jet.e), t, 0.1);
    L.drone.set(drone?.s ?? null, 0.8, 0.15);
    if (drone) {
      const f = this.doppler(cam, drone.e);
      this.droneOsc[0].frequency.setTargetAtTime(105 * f, t, 0.1);
      this.droneOsc[1].frequency.setTargetAtTime(210 * f, t, 0.1);
    }
    L.cruise.set(cruise?.s ?? null, 0.7, 0.15);
    L.helo.set(helo, 0.9, 0.15);
    if (cruise) this.cruiseFilter.frequency.setTargetAtTime(2300 * this.doppler(cam, cruise.e), t, 0.1);

    let gun: Spatial | null = null;
    let gun35: Spatial | null = null;
    for (const c of w.ciws) {
      if (!c.site.alive || c.spec.kind === 'laser') continue;
      if (c.firing) this.lastShot.set(c, w.t);
      if (w.t - (this.lastShot.get(c) ?? -1e9) > 0.15) continue;
      const big = c.spec.kind === 'gun35';
      const s = this.spatialSim(cam, c.gun, big ? 2600 : 1800, speed);
      if (big) {
        if (!gun35 || s.gain > gun35.gain) gun35 = s;
      } else if (!gun || s.gain > gun.gain) gun = s;
    }
    L.ciws.set(gun, 1.1, 0.03);
    L.gun35.set(gun35, 1.2, 0.03);
    // Wind is louder near the ground and fades as the camera climbs.
    const alt = cam.position.y - w.terrain.groundAt(cam.position.x, -cam.position.z);
    const near = 1 / (1 + Math.max(0, alt) / 3000);
    L.wind.set({ gain: 0.05 * near * (WIND_LEVEL[w.weatherId] ?? 1), pan: 0, cutoff: 20000, delay: 0 }, 1, 0.5);
    L.rain.set({ gain: (RAIN_LEVEL[w.weatherId] ?? 0) / (1 + Math.max(0, alt) / 800), pan: 0, cutoff: 20000, delay: 0 }, 1, 0.5);
  }

  /** Thunder from a lightning strike at a three.js position: a sharp crack close by, a long rolling rumble far off. */
  thunder(p: THREE.Vector3, cam: THREE.Camera): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const d = Math.max(1, p.distanceTo(cam.position));
    const s = this.spatial(cam, p.x, p.y, p.z, 7000, 1);
    s.delay = Math.min(d / SOUND_SPEED, 9);
    const out = this.oneShot(s, 1.3, 9);
    if (!out) return;
    const t = this.ctx.currentTime + s.delay;
    if (d < 4000) {
      const cr = this.gain(0);
      this.env(cr.gain, t, 0.003, 1, 0.5);
      this.noise(this.white, t, t + 0.6).connect(this.filter('lowpass', 3800)).connect(cr).connect(out);
    }
    const rl = this.gain(0);
    rl.gain.setValueAtTime(0.0001, t);
    rl.gain.exponentialRampToValueAtTime(1.2, t + 0.2 + Math.random() * 0.4);
    rl.gain.exponentialRampToValueAtTime(0.45, t + 1.6);
    rl.gain.exponentialRampToValueAtTime(0.8, t + 2.6 + Math.random());
    rl.gain.exponentialRampToValueAtTime(0.0001, t + 8);
    this.noise(this.brown, t, t + 8.1).connect(this.filter('lowpass', 300)).connect(rl).connect(out);
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
}
