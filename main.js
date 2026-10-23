'use strict';
// 自愈保护：若宿主环境（如其他 Electron 应用的终端）设置了 ELECTRON_RUN_AS_NODE，
// 本进程会以纯 Node 模式启动。此时清除该变量并以正常 Electron 模式重新拉起。
if (process.env.ELECTRON_RUN_AS_NODE) {
  const electronPath = require('electron'); // 纯 Node 模式下返回可执行文件路径
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.'], {
    cwd: __dirname, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.unref();
  process.exit(0);
}

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

const BALL_W = 88;             // 悬浮球窗口尺寸（球体 72px + 边距 8）
const BALL_MARGIN = 8;         // 球体在窗口内的边距
const PANEL = { w: 360, h: 202 }; // 16:9 横向卡片
const DOCK_PEEK = 22;          // 贴边收起后柱形条宽度
const EDGE_EPS = 6;            // "完全贴边"判定容差(px)
const GAP = 8;                 // 球与面板间距
const AWAY_MS = 3000;          // 鼠标离开面板 3 秒自动收起

const DEFAULTS = {
  taskName: '',
  focusMin: 25,
  bufferMin: 10,
  breakMin: 5,
  ballPos: null
};

let win = null;
let tray = null;
let mode = 'ball';        // 主进程逻辑态：'ball' | 'panel'（dock 仅为渲染态，见 docked）
let docked = null;         // null | 'left' | 'right' 已收起为柱形条
let animating = false;
let moveTimer = null;
let phaseTimer = null;
let psbId = null;
let lastMovedAt = 0;
let panelHold = false;     // 渲染进程输入焦点时暂停自动收起
let ballOff = { dx: 0, dy: 0 }; // 展开态球相对面板窗口原点的偏移
let awayMs = 0;            // 鼠标离开面板累计
let dockHoverMs = 0;       // 柱形条悬停累计
let dragging = false;      // 自实现拖拽中
let dragOffset = { x: 0, y: 0 };
let dragStartCursor = null;
let dragTimer = null;
let dragSafety = null;
let data = { settings: { ...DEFAULTS }, counts: {} };
let saveTimer = null;

// ---------- 数据持久化 ----------
function dataPath() { return path.join(app.getPath('userData'), 'data.json'); }

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    data.settings = { ...DEFAULTS, ...(raw.settings || {}) };
    data.counts = raw.counts || {};
    const cutoff = Date.now() - 60 * 86400e3;
    for (const k of Object.keys(data.counts)) {
      const t = Date.parse(k);
      if (!isNaN(t) && t < cutoff) delete data.counts[k];
    }
  } catch (e) { /* 首次启动，使用默认值 */ }
}

function persistNow() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(dataPath(), JSON.stringify(data, null, 2));
  } catch (e) { /* 忽略写盘错误 */ }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
}

// ---------- 基础工具 ----------
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function workAreaOf(bounds) { return screen.getDisplayMatching(bounds).workArea; }

// ---------- 窗口 ----------
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  let x = wa.x + wa.width - BALL_W - 30;
  let y = wa.y + Math.round(wa.height * 0.38);
  const p = data.settings.ballPos;
  if (p && typeof p.x === 'number' && typeof p.y === 'number') {
    x = clamp(p.x, wa.x - BALL_W + DOCK_PEEK, wa.x + wa.width - DOCK_PEEK);
    y = clamp(p.y, wa.y, wa.y + wa.height - BALL_W);
  }
  win = new BrowserWindow({
    width: BALL_W, height: BALL_W, x, y,
    transparent: true, frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    win.setIgnoreMouseEvents(true, { forward: true });
    detectDocked();
  });
  win.on('moved', () => {
    lastMovedAt = Date.now();
    awayMs = 0; dockHoverMs = 0;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(onMoveEnd, 220);
  });
  win.on('closed', () => { win = null; });
}

// 启动恢复：上次的柱形条收起位置 → 保持收起
function detectDocked() {
  if (!win) return;
  const b = win.getBounds();
  const wa = workAreaOf(b);
  if (b.x < wa.x - BALL_W / 2) {
    docked = 'left';
    win.webContents.send('mode-changed', { mode: 'dock', edge: 'left' });
  } else if (b.x > wa.x + wa.width - BALL_W / 2) {
    docked = 'right';
    win.webContents.send('mode-changed', { mode: 'dock', edge: 'right' });
  }
}

// ---------- 自实现拖拽（按住球任意位置拖动；窗口跟随光标，事件不丢失） ----------
function startDrag(dx, dy) {
  if (!win || mode !== 'ball' || docked || animating) return;
  dragging = true;
  dragOffset = { x: Number(dx) || 0, y: Number(dy) || 0 };
  dragStartCursor = screen.getCursorScreenPoint();
  lastMovedAt = Date.now();
  clearTimeout(dragSafety);
  dragSafety = setTimeout(() => endDrag(false), 8000); // 异常兜底
  clearInterval(dragTimer);
  dragTimer = setInterval(dragStep, 16);
}

function dragStep() {
  if (!dragging || !win) { endDrag(false); return; }
  const pt = screen.getCursorScreenPoint();
  const wa = screen.getDisplayMatching({ x: pt.x, y: pt.y, width: 1, height: 1 }).workArea;
  // 鼠标完全贴到屏幕边缘 → 立即结束拖拽并收起为柱形条
  if (pt.x <= wa.x + 1) { endDrag(false); dock('left'); return; }
  if (pt.x >= wa.x + wa.width - 1) { endDrag(false); dock('right'); return; }
  win.setPosition(Math.round(pt.x - dragOffset.x), Math.round(pt.y - dragOffset.y));
}

function endDrag(byUser) {
  if (!dragging) return;
  dragging = false;
  clearInterval(dragTimer);
  clearTimeout(dragSafety);
  if (!win) return;
  lastMovedAt = Date.now();
  if (byUser) {
    const pt = screen.getCursorScreenPoint();
    const moved = Math.hypot(pt.x - dragStartCursor.x, pt.y - dragStartCursor.y);
    if (moved < 6) { expandPanel(); return; } // 位移极小 → 视为单击 → 展开面板
    const b = win.getBounds();
    data.settings.ballPos = { x: b.x, y: b.y };
    persist();
    evaluateEdge(b.x, b.y); // 完全贴边 → 立即收起
  }
}

// 完全贴边判定（球边缘接触屏幕边缘，容差 EDGE_EPS）
function evaluateEdge(x, y) {
  if (!win) return;
  const wa = workAreaOf({ x, y, width: BALL_W, height: BALL_W });
  if (x <= wa.x + EDGE_EPS) { dock('left'); return; }
  if (x + BALL_W >= wa.x + wa.width - EDGE_EPS) { dock('right'); }
}

// ---------- 拖动结束（系统 moved 事件的兜底处理） ----------
function onMoveEnd() {
  if (!win || animating || dragging) return;
  const b = win.getBounds();
  if (mode === 'ball') {
    data.settings.ballPos = { x: b.x, y: b.y };
    persist();
    evaluateEdge(b.x, b.y);
  } else {
    // 面板拖动：球随窗口移动，更新球的绝对位置
    const bx = b.x + ballOff.dx, by = b.y + ballOff.dy;
    data.settings.ballPos = { x: bx, y: by };
    persist();
  }
}

// ---------- 动画 ----------
function animateTo(tx, ty, cb) {
  if (!win) return;
  animating = true;
  const [sx, sy] = win.getPosition();
  const frames = 12, dur = 180;
  let i = 0;
  const step = () => {
    if (!win) { animating = false; return; }
    i++;
    const t = Math.min(1, i / frames);
    const e = 1 - Math.pow(1 - t, 3);
    win.setPosition(Math.round(sx + (tx - sx) * e), Math.round(sy + (ty - sy) * e));
    if (i < frames) setTimeout(step, dur / frames);
    else { animating = false; if (cb) cb(); }
  };
  step();
}

// ---------- 贴边收起为柱形条 / 弹出 ----------
function dock(edge) {
  if (!win || docked === edge) return;
  const wa = workAreaOf(win.getBounds());
  const b = win.getBounds();
  const targetX = edge === 'left' ? wa.x - (BALL_W - DOCK_PEEK) : wa.x + wa.width - DOCK_PEEK;
  const cy = b.y + BALL_W / 2;
  const ty = clamp(Math.round(cy - BALL_W / 2), wa.y, wa.y + wa.height - BALL_W);
  docked = edge;
  win.webContents.send('mode-changed', { mode: 'dock', edge }); // 柱形条随窗口滑入边缘
  animateTo(targetX, ty, () => {
    data.settings.ballPos = { x: targetX, y: ty };
    persist();
  });
}

function slideOut() {
  if (!win || !docked) return;
  const wa = workAreaOf(win.getBounds());
  const b = win.getBounds();
  const targetX = docked === 'left' ? wa.x + 10 : wa.x + wa.width - BALL_W - 10;
  docked = null;
  dockHoverMs = 0;
  win.webContents.send('mode-changed', { mode: 'ball' });
  animateTo(targetX, b.y, () => {
    data.settings.ballPos = { x: targetX, y: b.y };
    persist();
  });
}

// ---------- 展开（点击触发，面板位于球下方，球保持可见且不动） ----------
function expandPanel() {
  if (!win || mode !== 'ball' || docked || animating) return;
  const b = win.getBounds(); // 球窗口
  const wa = workAreaOf(b);
  const px = clamp(b.x, wa.x, wa.x + wa.width - PANEL.w);
  let py = b.y + b.height + GAP;
  if (py + PANEL.h > wa.y + wa.height) py = b.y - PANEL.h - GAP; // 放不下则弹到上方
  py = clamp(py, wa.y, wa.y + wa.height - PANEL.h);

  const jx = Math.min(b.x, px), jy = Math.min(b.y, py);
  const jw = Math.max(b.x + b.width, px + PANEL.w) - jx;
  const jh = Math.max(b.y + b.height, py + PANEL.h) - jy;

  mode = 'panel';
  awayMs = 0;
  ballOff = { dx: b.x - jx, dy: b.y - jy };
  win.setBounds({ x: jx, y: jy, width: jw, height: jh });
  data.settings.ballPos = { x: b.x, y: b.y };
  persist();
  if (win) win.webContents.send('mode-changed', {
    mode: 'panel',
    ball: { x: BALL_MARGIN + ballOff.dx, y: BALL_MARGIN + ballOff.dy },
    panel: { x: px - jx, y: py - jy, w: PANEL.w, h: PANEL.h }
  });
}

// ---------- 收起（自动 / 手动，球回到原位） ----------
function collapsePanel() {
  if (!win || mode !== 'panel') return;
  const wa = workAreaOf(win.getBounds());
  const b = win.getBounds();
  const bx = clamp(b.x + ballOff.dx, wa.x, wa.x + wa.width - BALL_W);
  const by = clamp(b.y + ballOff.dy, wa.y, wa.y + wa.height - BALL_W);
  mode = 'ball';
  awayMs = 0;
  win.setBounds({ x: bx, y: by, width: BALL_W, height: BALL_W });
  data.settings.ballPos = { x: bx, y: by };
  persist();
  if (win) win.webContents.send('mode-changed', { mode: 'ball' });
}

// ---------- 光标轮询：柱形条悬停弹出 / 面板自动收起 ----------
function startCursorPolling() {
  setInterval(() => {
    if (!win || animating || dragging) return;
    if (Date.now() - lastMovedAt < 600) { awayMs = 0; dockHoverMs = 0; return; }
    const pt = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = pt.x >= b.x && pt.x < b.x + b.width &&
                   pt.y >= b.y && pt.y < b.y + b.height;

    if (docked) {
      // 柱形条悬停 300ms → 弹回悬浮球
      dockHoverMs = inside ? dockHoverMs + 200 : 0;
      if (dockHoverMs >= 300) { dockHoverMs = 0; slideOut(); }
    } else if (mode === 'panel') {
      // 鼠标离开面板 3 秒 → 自动收起（输入焦点时暂停）
      awayMs = (!inside && !panelHold) ? awayMs + 200 : 0;
      if (awayMs >= AWAY_MS) { awayMs = 0; collapsePanel(); }
    }
  }, 200);
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('get-data', () => ({ settings: data.settings, counts: data.counts }));

  ipcMain.on('set-settings', (e, patch) => {
    if (patch && typeof patch === 'object') {
      Object.assign(data.settings, patch);
      persist();
    }
  });

  ipcMain.handle('add-count', (e, key) => {
    data.counts[key] = (data.counts[key] || 0) + 1;
    persist();
    return data.counts[key];
  });

  ipcMain.on('arm-phase-timeout', (e, endAt) => {
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => {
      if (win) win.webContents.send('phase-timeout');
    }, Math.max(0, endAt - Date.now()));
  });

  ipcMain.on('psb', (e, on) => {
    if (on && psbId == null) psbId = powerSaveBlocker.start('prevent-display-sleep');
    else if (!on && psbId != null) { powerSaveBlocker.stop(psbId); psbId = null; }
  });

  ipcMain.on('set-interactive', (e, on) => {
    if (win) win.setIgnoreMouseEvents(!on, { forward: true });
  });

  // 自实现拖拽：renderer mousedown/mouseup 驱动
  ipcMain.on('drag-start', (e, dx, dy) => startDrag(dx, dy));
  ipcMain.on('drag-end', () => endDrag(true));

  // 面板"—"按钮手动收起
  ipcMain.on('show-ball', () => collapsePanel());

  // 输入焦点保持面板打开
  ipcMain.on('panel-hold', (e, on) => { panelHold = !!on; });
}

// ---------- 托盘 ----------
function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
    tray.setToolTip('特别番茄钟');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示悬浮球', click: () => { if (win) win.showInactive(); } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]));
  } catch (e) { /* 托盘失败不影响主功能 */ }
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  loadData();
  createWindow();
  createTray();
  setupIpc();
  startCursorPolling();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { clearTimeout(saveTimer); persistNow(); });
