// 효과음·성우·배경음악.
// 1순위: ElevenLabs로 생성한 mp3 에셋(public/audio/*) 을 AudioBuffer로 재생(저지연·겹침 가능).
// 폴백: 에셋이 아직 안 받아졌거나 없으면 WebAudio 합성음으로 대체.
// 브라우저 자동재생 정책 때문에 첫 사용자 입력 때 unlock()을 한 번 호출해야 한다.

let ctx: AudioContext | null = null;
let enabled = true;

// 볼륨(0~1) — localStorage에 저장. 배경음은 기본을 낮게.
function loadVol(key: string, def: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? '');
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : def;
}
let musicVol = loadVol('sp_vol_music', 0.12);
let sfxVol = loadVol('sp_vol_sfx', 0.9);

export function setMusicVolume(v: number): void {
  musicVol = Math.max(0, Math.min(1, v));
  localStorage.setItem('sp_vol_music', String(musicVol));
  if (music) music.volume = musicVol;
}
export function setSfxVolume(v: number): void {
  sfxVol = Math.max(0, Math.min(1, v));
  localStorage.setItem('sp_vol_sfx', String(sfxVol));
}
export function getMusicVolume(): number { return musicVol; }
export function getSfxVolume(): number { return sfxVol; }

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

// ── 에셋(mp3) 로딩/재생 ───────────────────────────────────────────────────────
// BASE_URL: 로컬 '/', GitHub Pages '/seven-poker/'. 어느 경로에 올려도 오디오가 맞게 로딩되게.
const B = import.meta.env.BASE_URL;
const SFX_URL: Record<string, string> = {
  deal: `${B}audio/sfx/deal.mp3`,
  chip: `${B}audio/sfx/chip.mp3`,
  win: `${B}audio/sfx/win.mp3`,
  turn: `${B}audio/sfx/turn.mp3`,
  lose: `${B}audio/sfx/lose.mp3`,
};
const VOICE_URL: Record<string, string> = {
  start: `${B}audio/voice/start.mp3`,
  yourturn: `${B}audio/voice/yourturn.mp3`,
  check: `${B}audio/voice/check.mp3`,
  call: `${B}audio/voice/call.mp3`,
  bbing: `${B}audio/voice/bbing.mp3`,
  ddadang: `${B}audio/voice/ddadang.mp3`,
  half: `${B}audio/voice/half.mp3`,
  die: `${B}audio/voice/die.mp3`,
  win: `${B}audio/voice/win.mp3`,
  lose: `${B}audio/voice/lose.mp3`,
};
const buffers: Record<string, AudioBuffer> = {};
let preloaded = false;

async function loadOne(url: string): Promise<void> {
  const c = ac();
  if (!c || buffers[url]) return;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    buffers[url] = await c.decodeAudioData(await res.arrayBuffer());
  } catch { /* 에셋 없음 → 폴백 사용 */ }
}
function preload(): void {
  if (preloaded) return;
  preloaded = true;
  [...Object.values(SFX_URL), ...Object.values(VOICE_URL)].forEach((u) => void loadOne(u));
}
function playBuffer(url: string, gain = 1): boolean {
  const c = ac();
  const b = buffers[url];
  if (!c || !b) return false;
  const s = c.createBufferSource();
  s.buffer = b;
  const g = c.createGain();
  g.gain.value = gain * sfxVol;
  s.connect(g).connect(c.destination);
  s.start();
  return true;
}

// ── 배경 음악(HTMLAudio 루프) ─────────────────────────────────────────────────
let music: HTMLAudioElement | null = null;
export const bgm = {
  start(): void {
    if (!enabled) return;
    if (!music) {
      music = new Audio(`${import.meta.env.BASE_URL}audio/music/table.mp3`);
      music.loop = true;
    }
    music.volume = musicVol;
    void music.play().catch(() => { /* 사용자 입력 전이면 무시 */ });
  },
  stop(): void { if (music) { music.pause(); music.currentTime = 0; } },
};

// ── 잠금 해제 / 음소거 ────────────────────────────────────────────────────────
export function unlock(): void {
  const c = ac();
  if (c && c.state === 'suspended') void c.resume();
  preload();
}
export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (!on) { if (ctx) void ctx.suspend(); bgm.stop(); }
  else if (ctx) void ctx.resume();
}
export function isSoundEnabled(): boolean { return enabled; }

// ── 합성음(폴백) ──────────────────────────────────────────────────────────────
function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; when?: number; slideTo?: number } = {}): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + (opts.when ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + dur);
  const peak = opts.gain ?? 0.2;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}
function noise(dur: number, gain = 0.15, when = 0, hp = 1200): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + when;
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  const filt = c.createBiquadFilter();
  filt.type = 'highpass';
  filt.frequency.value = hp;
  src.connect(filt).connect(g).connect(c.destination);
  src.start(t0);
}
const synth = {
  click: () => tone(320, 0.06, { type: 'square', gain: 0.08 }),
  card: () => { noise(0.07, 0.12, 0, 2500); tone(900, 0.05, { type: 'triangle', gain: 0.05, slideTo: 1300 }); },
  deal: () => { for (let i = 0; i < 4; i++) noise(0.05, 0.1, i * 0.08, 2500); },
  chip: () => { noise(0.04, 0.1, 0, 3500); tone(1500, 0.05, { type: 'triangle', gain: 0.06 }); },
  bet: () => { noise(0.05, 0.13, 0, 3000); tone(1400, 0.06, { type: 'triangle', gain: 0.07 }); },
  check: () => { tone(180, 0.08, { gain: 0.18 }); tone(120, 0.1, { gain: 0.12, when: 0.02 }); },
  die: () => tone(380, 0.28, { type: 'sawtooth', gain: 0.12, slideTo: 130 }),
  turn: () => { tone(660, 0.12, { gain: 0.18 }); tone(990, 0.16, { gain: 0.16, when: 0.1 }); },
  select: () => tone(720, 0.05, { type: 'triangle', gain: 0.08 }),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: 'triangle', gain: 0.16, when: i * 0.09 })),
  lose: () => { tone(440, 0.2, { gain: 0.12, slideTo: 330 }); tone(330, 0.32, { gain: 0.12, when: 0.18, slideTo: 220 }); },
};

// 에셋 우선, 없으면 합성음
function play(name: keyof typeof synth, gain = 1): void {
  const url = SFX_URL[name];
  if (url && playBuffer(url, gain)) return;
  synth[name]();
}

export const sfx = {
  click: () => play('click'),
  card: () => play('card'),
  deal: () => play('deal'),
  chip: () => play('chip'),
  bet: () => { if (!playBuffer(SFX_URL.chip)) synth.bet(); }, // 베팅도 칩 에셋 사용
  check: () => play('check'),
  die: () => play('die'),
  turn: () => play('turn'),
  select: () => play('select'),
  win: () => play('win'),
  lose: () => play('lose'),
  jackpot: () => { /* win 에셋이 환호까지 포함 — 별도 합성음 생략 */ },
};

// 성우 음성(에셋만, 없으면 무음)
export function voice(name: keyof typeof VOICE_URL): void {
  playBuffer(VOICE_URL[name], 1);
}
