'use strict';
// Web Audio 合成提示音（无音频文件资产）
const Chime = {
  ctx: null,

  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  note(freq, start, dur, vol) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.start(start);
    o.stop(start + dur + 0.05);
  },

  // up=true 上行清亮（专注/缓冲结束）；up=false 下行舒缓（本轮完成）
  play(up) {
    try {
      const ctx = this.ensure();
      const t = ctx.currentTime + 0.02;
      if (up) {
        this.note(880, t, 0.22, 0.16);
        this.note(1318, t + 0.16, 0.36, 0.16);
      } else {
        this.note(660, t, 0.22, 0.16);
        this.note(440, t + 0.16, 0.42, 0.16);
      }
    } catch (e) { /* 音频失败不影响功能 */ }
  }
};
