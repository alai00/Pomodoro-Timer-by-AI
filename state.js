'use strict';
// 状态机 + 时间戳计时核心（IDLE / FOCUS / BUFFER / BREAK）
// 采用时间戳差值而非累加计数，休眠/节流后依然精确
const Timer = {
  phase: 'IDLE',
  phaseEndAt: 0,      // 本阶段结束时间戳(ms)
  phaseDuration: 0,   // 本阶段总时长(ms)，用于进度环

  isRunning() { return this.phase !== 'IDLE'; },

  begin(phase, durationMs) {
    this.phase = phase;
    this.phaseDuration = durationMs;
    this.phaseEndAt = Date.now() + durationMs;
    window.pomodoro.armPhaseTimeout(this.phaseEndAt); // 主进程兜底
  },

  // 重新开始本阶段：清零并以新时长重开
  restart(durationMs) {
    this.phaseDuration = durationMs;
    this.phaseEndAt = Date.now() + durationMs;
    window.pomodoro.armPhaseTimeout(this.phaseEndAt);
  },

  cancel() {
    this.phase = 'IDLE';
    this.phaseDuration = 0;
    this.phaseEndAt = 0;
  },

  remainingMs() {
    return this.phase === 'IDLE' ? 0 : Math.max(0, this.phaseEndAt - Date.now());
  },

  // 已进行比例 0~1
  progress() {
    if (this.phase === 'IDLE' || !this.phaseDuration) return 0;
    const start = this.phaseEndAt - this.phaseDuration;
    return Math.min(1, Math.max(0, (Date.now() - start) / this.phaseDuration));
  }
};
