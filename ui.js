'use strict';
// UI 编排：手动阶段流转、三按钮行为、滑块双向绑定、自实现拖拽、穿透、渲染刷新
//
// 状态机（每个阶段结束后均需手动开启下一阶段）：
//   IDLE --开始--> FOCUS --到点--> FOCUS_WAIT --开始--> (BUFFER | BREAK)
//   BUFFER --到点--> BUFFER_WAIT --开始--> BREAK
//   BREAK --到点--> IDLE（番茄 +1）
//   运行中取消 --> IDLE（不计番茄）
//   FOCUS_WAIT / BUFFER_WAIT 取消 --> BREAK（跳过缓冲直接休息，本轮保留）
const PHASE_LONG = {
  IDLE: '准备开始',
  FOCUS: '专注中',
  FOCUS_WAIT: '专注结束 — 开始进缓冲，取消直接休息',
  BUFFER: '缓冲中（延迟休息）',
  BUFFER_WAIT: '缓冲结束 — 点开始进入休息',
  BREAK: '休息中'
};
const RING_C = 194.8; // 2π × 31

const $ = (id) => document.getElementById(id);

const UI = {
  lastInteractive: null,

  async init() {
    await Settings.load();
    this.applyTaskName();
    this.refreshSettingsControls();
    this.bindButtons();
    this.bindSettings();
    this.bindBall();
    this.bindMouse();
    this.bindMode();
    window.pomodoro.onPhaseTimeout(() => this.handleTimeout());
    this.render();
    setInterval(() => this.tick(), 500);
  },

  // ---------- 按钮 ----------
  // 主开始动作：IDLE→专注；等待态→下一阶段
  onPrimary() {
    const p = Timer.phase;
    if (p === 'IDLE') {
      this.startPhase('FOCUS');
      this.pulse();
    } else if (p === 'FOCUS_WAIT') {
      this.startPhase(Settings.bufferMin > 0 ? 'BUFFER' : 'BREAK');
      this.pulse();
    } else if (p === 'BUFFER_WAIT') {
      this.startPhase('BREAK');
      this.pulse();
    }
  },

  bindButtons() {
    $('btnStart').addEventListener('click', () => this.onPrimary());

    // 重新开始：清零重开当前阶段；等待态则重开刚结束的阶段
    $('btnRestart').addEventListener('click', () => {
      const p = Timer.phase;
      if (p === 'IDLE') return;
      if (p === 'FOCUS' || p === 'FOCUS_WAIT') this.startPhase('FOCUS');
      else if (p === 'BUFFER' || p === 'BUFFER_WAIT') this.startPhase('BUFFER');
      else if (p === 'BREAK') this.startPhase('BREAK');
    });

    // 取消：运行中→放弃计时回 IDLE；等待态→跳过缓冲直接休息
    $('btnCancel').addEventListener('click', () => {
      const p = Timer.phase;
      if (p === 'IDLE') return;
      if (p === 'FOCUS_WAIT' || p === 'BUFFER_WAIT') {
        this.startPhase('BREAK');
      } else {
        Timer.cancel();
        window.pomodoro.setPowerSave(false);
      }
      this.render();
    });

    $('btnCollapse').addEventListener('click', () => window.pomodoro.showBall());

    // 球面快捷按钮：待机/等待态直接开始；运行中重开本阶段
    $('ballQuick').addEventListener('mousedown', (e) => e.stopPropagation());
    $('ballQuick').addEventListener('click', (e) => {
      e.stopPropagation();
      const p = Timer.phase;
      if (p === 'IDLE' || p === 'FOCUS_WAIT' || p === 'BUFFER_WAIT') {
        this.onPrimary();
      } else {
        Timer.restart(this.phaseDurationMs());
      }
      this.render();
    });
  },

  phaseDurationMs(phase) {
    const m = phase === 'FOCUS' ? Settings.focusMin
            : phase === 'BUFFER' ? Settings.bufferMin
            : phase === 'BREAK' ? Settings.breakMin : 0;
    return m * 60000;
  },

  startPhase(phase) {
    const ms = this.phaseDurationMs(phase);
    if (!ms) return;
    Timer.begin(phase, ms);
    // 专注/缓冲及其等待期间保持屏幕常亮（等待时大概率仍在收尾工作）
    const working = phase === 'FOCUS' || phase === 'BUFFER' ||
                    phase === 'FOCUS_WAIT' || phase === 'BUFFER_WAIT';
    window.pomodoro.setPowerSave(working);
  },

  // ---------- 阶段流转（每阶段到点 → 等待手动开启） ----------
  handleTimeout() {
    const p = Timer.phase;
    if (p === 'IDLE' || !Timer.phaseEndAt) return;
    if (Date.now() < Timer.phaseEndAt) return; // 兜底通道误触发防护

    if (p === 'FOCUS') {
      this.setWaiting('FOCUS_WAIT');
      if (Settings.bufferMin > 0) {
        this.notify('专注结束 🍅', '还差一点？点【开始】延迟休息（缓冲 ' + Settings.bufferMin + ' 分钟）；完成？点【取消】直接休息');
      } else {
        this.notify('专注结束 🍅', '点【开始】进入休息');
      }
      Chime.play(true);
    } else if (p === 'BUFFER') {
      this.setWaiting('BUFFER_WAIT');
      this.notify('缓冲结束', '点【开始】进入休息');
      Chime.play(true);
    } else if (p === 'BREAK') {
      Timer.cancel();
      window.pomodoro.setPowerSave(false);
      this.addTodayCount();
      this.notify('本轮完成！', '番茄 +1 🍅 点【开始】开启下一轮专注');
      Chime.play(false);
    }
    this.pulse();
    this.render();
  },

  setWaiting(phase) {
    Timer.phase = phase;
    Timer.phaseDuration = 0;
    Timer.phaseEndAt = 0;
  },

  async addTodayCount() {
    const key = Settings.todayKey();
    const n = await window.pomodoro.addCount(key);
    Settings.counts[key] = n;
    this.render();
  },

  // ---------- 定时刷新 ----------
  tick() {
    if (Timer.phaseEndAt && Date.now() >= Timer.phaseEndAt) this.handleTimeout();
    this.render();
  },

  // 各阶段倒计时显示：运行中显示剩余；等待态预览下一阶段时长
  displayMs() {
    const p = Timer.phase;
    if (p === 'IDLE') return Settings.focusMin * 60000;
    if (p === 'FOCUS_WAIT') return (Settings.bufferMin > 0 ? Settings.bufferMin : Settings.breakMin) * 60000;
    if (p === 'BUFFER_WAIT') return Settings.breakMin * 60000;
    return Timer.remainingMs();
  },

  shortLabel(p) {
    if (p === 'FOCUS_WAIT') return Settings.bufferMin > 0 ? '可缓冲' : '可休息';
    if (p === 'BUFFER_WAIT') return '可休息';
    return { IDLE: '待开始', FOCUS: '专注', BUFFER: '缓冲', BREAK: '休息' }[p];
  },

  render() {
    const phase = Timer.phase;
    document.body.dataset.phase = phase;

    const txt = this.fmt(this.displayMs());
    $('ballTime').textContent = phase === 'IDLE' ? '🍅' + Settings.todayCount() : txt;
    $('ballPhase').textContent = this.shortLabel(phase);
    $('bigTime').textContent = txt;
    $('phaseLabel').textContent = Settings.taskName
      ? PHASE_LONG[phase] + ' · ' + Settings.taskName
      : PHASE_LONG[phase];

    const p = Timer.progress();
    $('progressFill').style.width = (p * 100).toFixed(2) + '%';
    $('ringFg').style.strokeDashoffset = (RING_C * (1 - p)).toFixed(1);

    $('btnRestart').disabled = phase === 'IDLE';
    $('btnCancel').disabled = phase === 'IDLE';

    // 快捷按钮图标：待机/等待 → ▶ 开始；运行中 → ↻ 重开本阶段
    const waiting = phase === 'IDLE' || phase === 'FOCUS_WAIT' || phase === 'BUFFER_WAIT';
    $('ballQuick').textContent = waiting ? '▶' : '↻';
    $('ballQuick').title = waiting ? '直接开始计时' : '重新开始本阶段';

    $('todayCount').textContent = '🍅 × ' + Settings.todayCount();
  },

  fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  },

  pulse() {
    const b = $('ball');
    b.classList.remove('pulse');
    void b.offsetWidth;
    b.classList.add('pulse');
  },

  notify(title, body) {
    try { new window.Notification(title, { body, silent: true }); } catch (e) {}
  },

  // ---------- 任务名 ----------
  applyTaskName() { $('taskName').value = Settings.taskName; },

  // ---------- 滑块 + 数字输入双向绑定 ----------
  bindSettings() {
    const items = [
      { key: 'focusMin', slider: 'focusSlider', num: 'focusNum' },
      { key: 'bufferMin', slider: 'bufferSlider', num: 'bufferNum' },
      { key: 'breakMin', slider: 'breakSlider', num: 'breakNum' }
    ];
    for (const it of items) {
      const s = $(it.slider), n = $(it.num);
      const min = Number(s.min), max = Number(s.max);

      s.addEventListener('input', () => {
        const v = this.clamp(parseInt(s.value, 10), min, max);
        this.applySetting(it.key, v, s, n);
      });

      n.addEventListener('input', () => {
        const v = parseInt(n.value, 10);
        if (isNaN(v) || v < min || v > max) return; // 范围外等 change 钳制
        this.applySetting(it.key, v, s, n);
      });

      n.addEventListener('change', () => {
        let v = parseInt(n.value, 10);
        if (isNaN(v)) v = Settings[it.key];
        v = this.clamp(v, min, max);
        this.applySetting(it.key, v, s, n);
      });
    }

    const task = $('taskName');
    task.addEventListener('input', () => {
      Settings.taskName = task.value;
      Settings.save();
      this.render();
    });
    // 输入焦点时通知主进程保持面板打开（鼠标离开也不自动收起）
    task.addEventListener('focus', () => window.pomodoro.panelHold(true));
    task.addEventListener('blur', () => window.pomodoro.panelHold(false));
  },

  applySetting(key, v, s, n) {
    if (Settings[key] === v && String(s.value) === String(v) && String(n.value) === String(v)) return;
    Settings[key] = v;
    if (String(s.value) !== String(v)) s.value = v;
    if (String(n.value) !== String(v)) n.value = v;
    this.paintSlider(s, v);
    Settings.save();
    this.render();
  },

  paintSlider(s, v) {
    const min = Number(s.min), max = Number(s.max);
    const pct = ((v - min) / (max - min)) * 100;
    s.style.background =
      `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, ` +
      `rgba(120,105,80,.18) ${pct}%, rgba(120,105,80,.18) 100%)`;
  },

  refreshSettingsControls() {
    const items = [
      { key: 'focusMin', slider: 'focusSlider', num: 'focusNum' },
      { key: 'bufferMin', slider: 'bufferSlider', num: 'bufferNum' },
      { key: 'breakMin', slider: 'breakSlider', num: 'breakNum' }
    ];
    for (const it of items) {
      const s = $(it.slider), n = $(it.num);
      s.value = Settings[it.key];
      n.value = Settings[it.key];
      this.paintSlider(s, Settings[it.key]);
    }
  },

  clamp(v, min, max) { return Math.min(max, Math.max(min, v)); },

  // ---------- 球交互：按住任意位置拖拽（主进程跟随光标），单击展开 ----------
  bindBall() {
    const ball = $('ball');
    ball.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      window.pomodoro.dragStart(e.clientX, e.clientY);
    });
    // 窗口跟随光标移动，mouseup 始终落在窗口内
    window.addEventListener('mouseup', () => window.pomodoro.dragEnd());
  },

  // ---------- 点击穿透：命中球/面板/柱形条才可交互 ----------
  bindMouse() {
    document.addEventListener('mousemove', (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const hit = !!(el && el.closest && el.closest('.hit'));
      if (hit !== this.lastInteractive) {
        this.lastInteractive = hit;
        window.pomodoro.setInteractive(hit);
      }
    });
  },

  // ---------- 模式切换：ball / panel / dock（柱形条） ----------
  bindMode() {
    window.pomodoro.onModeChanged((m) => {
      const isDock = m.mode === 'dock';
      document.body.classList.toggle('mode-ball', m.mode === 'ball');
      document.body.classList.toggle('mode-panel', m.mode === 'panel');
      document.body.classList.toggle('docked', isDock);
      document.body.classList.toggle('dock-left', isDock && m.edge === 'left');
      document.body.classList.toggle('dock-right', isDock && m.edge === 'right');
      const ball = $('ball'), panel = $('panel');
      if (m.mode === 'panel' && m.ball && m.panel) {
        ball.style.left = m.ball.x + 'px';
        ball.style.top = m.ball.y + 'px';
        panel.style.left = m.panel.x + 'px';
        panel.style.top = m.panel.y + 'px';
        panel.style.width = m.panel.w + 'px';
        panel.style.height = m.panel.h + 'px';
      } else {
        ball.style.left = ''; ball.style.top = '';
        panel.style.left = ''; panel.style.top = '';
        panel.style.width = ''; panel.style.height = '';
      }
    });
  }
};

UI.init();
