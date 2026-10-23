'use strict';
// 设置与番茄计数（数据由主进程 JSON 持久化，经 IPC 读写）
const Settings = {
  taskName: '',
  focusMin: 25,   // 核心时长，位于滑块(5-45)正中
  bufferMin: 10,  // 0 = 跳过缓冲；上限 25
  breakMin: 5,
  counts: {},     // { "YYYY-MM-DD": 番茄数 }

  async load() {
    const d = await window.pomodoro.getData();
    const s = (d && d.settings) || {};
    this.taskName = typeof s.taskName === 'string' ? s.taskName : '';
    this.focusMin = Number.isFinite(s.focusMin) ? s.focusMin : 25;
    this.bufferMin = Number.isFinite(s.bufferMin) ? s.bufferMin : 10;
    this.breakMin = Number.isFinite(s.breakMin) ? s.breakMin : 5;
    this.counts = (d && d.counts) || {};
  },

  save() {
    window.pomodoro.setSettings({
      taskName: this.taskName,
      focusMin: this.focusMin,
      bufferMin: this.bufferMin,
      breakMin: this.breakMin
    });
  },

  // 本地时区 YYYY-MM-DD
  todayKey() { return new Date().toLocaleDateString('sv-SE'); },

  // 显示即清零：永远只读当天
  todayCount() { return this.counts[this.todayKey()] || 0; }
};
