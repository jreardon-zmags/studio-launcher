'use strict';

/**
 * Studio Launcher — tray-only Electron app.
 *
 * No BrowserWindow. No native modules. No ABI concerns.
 * Features: per-app submenu (Open/Restart/Stop), crash notifications,
 * Start All / Stop All, 10s status polling, PM2-not-found guard.
 */

const { app, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const { exec } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

// ---------------------------------------------------------------------------
// Config — merge apps.json with optional machine-local apps.local.json
// ---------------------------------------------------------------------------

function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function loadApps() {
  const base = JSON.parse(readFileSync(join(__dirname, 'apps.json'), 'utf8'));
  const localPath = join(__dirname, 'apps.local.json');
  if (existsSync(localPath)) {
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    if (local.apps) {
      for (const localApp of local.apps) {
        const idx = base.apps.findIndex((a) => a.id === localApp.id);
        if (idx >= 0) base.apps[idx] = { ...base.apps[idx], ...localApp };
        else base.apps.push(localApp);
      }
    }
  }
  return base.apps.map((a) => ({ ...a, ecosystemPath: expandHome(a.ecosystemPath) }));
}

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => { /* focus would go here if we had a window */ });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tray = null;
let pollTimer = null;
const apps = loadApps();
const status = {};    // appId -> 'online' | 'stopped' | 'starting' | 'unknown'
const prevStatus = {}; // appId -> previous value — used for crash detection
const monit = {};     // appId -> { cpu: number, memory: number } | null

// ---------------------------------------------------------------------------
// PM2 helpers
// ---------------------------------------------------------------------------

function pm2Available() {
  return new Promise((resolve) => {
    exec('pm2 --version', (err) => resolve(!err));
  });
}

function pm2List() {
  return new Promise((resolve) => {
    exec('pm2 jlist', (err, stdout) => {
      if (err) return resolve([]);
      try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
    });
  });
}

function pm2Start(ecosystemPath, pm2Names) {
  return new Promise((resolve) => {
    const onlyFlag = pm2Names.map((n) => `--only ${n}`).join(' ');
    exec(`pm2 start "${ecosystemPath}" ${onlyFlag}`, resolve);
  });
}

function pm2Stop(pm2Names) {
  return new Promise((resolve) => {
    exec(`pm2 stop ${pm2Names.join(' ')}`, resolve);
  });
}

function pm2Restart(pm2Names) {
  return new Promise((resolve) => {
    exec(`pm2 restart ${pm2Names.join(' ')}`, resolve);
  });
}

function isOnline(list, pm2Names) {
  return pm2Names.every((name) => {
    const proc = list.find((p) => p.name === name);
    return proc && proc.pm2_env?.status === 'online';
  });
}

function getMonit(list, pm2Names) {
  const procs = pm2Names.map((name) => list.find((p) => p.name === name)).filter(Boolean);
  if (!procs.length) return null;
  const cpu = procs.reduce((s, p) => s + (p.monit?.cpu ?? 0), 0);
  const memory = procs.reduce((s, p) => s + (p.monit?.memory ?? 0), 0);
  return { cpu, memory };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

function waitForHealth(healthUrl, timeout = 30_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      fetch(healthUrl)
        .then((r) => { if (r.ok) resolve(true); else retry(); })
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() < deadline) setTimeout(check, 500);
      else resolve(false);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// App actions
// ---------------------------------------------------------------------------

async function startApp(appDef) {
  if (status[appDef.id] === 'starting') return;
  status[appDef.id] = 'starting';
  rebuildMenu();

  if (existsSync(appDef.ecosystemPath)) {
    await pm2Start(appDef.ecosystemPath, appDef.pm2Names);
    await waitForHealth(appDef.healthUrl);
  }
  await refreshStatus();
}

async function openApp(appDef) {
  const list = await pm2List();
  if (isOnline(list, appDef.pm2Names)) {
    shell.openExternal(appDef.url);
    return;
  }
  await startApp(appDef);
  shell.openExternal(appDef.url);
}

async function stopApp(appDef) {
  await pm2Stop(appDef.pm2Names);
  await refreshStatus();
}

function openLogs(appDef) {
  const name = appDef.pm2Names[0];
  if (process.platform === 'darwin') {
    exec(`osascript -e 'tell application "Terminal" to do script "pm2 logs ${name}"'`);
  } else {
    exec(`start cmd /k "pm2 logs ${name}"`, { shell: true });
  }
}

async function restartApp(appDef) {
  status[appDef.id] = 'starting';
  rebuildMenu();
  await pm2Restart(appDef.pm2Names);
  await waitForHealth(appDef.healthUrl);
  await refreshStatus();
}

async function startAll() {
  const list = await pm2List();
  const stopped = apps.filter((a) => !isOnline(list, a.pm2Names));
  await Promise.all(stopped.map((a) => startApp(a)));
}

async function stopAll() {
  await Promise.all(apps.map((a) => pm2Stop(a.pm2Names)));
  await refreshStatus();
}

// ---------------------------------------------------------------------------
// Crash notifications
// ---------------------------------------------------------------------------

function notifyCrash(appDef) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: `${appDef.name} went offline`,
    body: 'Click the tray icon to restart.',
    silent: false,
  });
  n.on('click', () => openApp(appDef));
  n.show();
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

async function refreshStatus() {
  const hasPm2 = await pm2Available();
  if (!hasPm2) {
    for (const a of apps) status[a.id] = 'unknown';
    rebuildMenu(true);
    return;
  }

  const list = await pm2List();
  for (const a of apps) {
    if (status[a.id] === 'starting') continue;
    const next = isOnline(list, a.pm2Names) ? 'online' : 'stopped';

    // Crash detection: was running, now stopped
    if (prevStatus[a.id] === 'online' && next === 'stopped') {
      notifyCrash(a);
    }

    prevStatus[a.id] = status[a.id];
    status[a.id] = next;
    monit[a.id] = next === 'online' ? getMonit(list, a.pm2Names) : null;
  }
  rebuildMenu();
}

// ---------------------------------------------------------------------------
// Tray menu
// ---------------------------------------------------------------------------

const DOT = { online: '🟢', stopped: '🔴', starting: '🟡', unknown: '⚪' };

function rebuildMenu(pm2Missing = false) {
  if (!tray) return;

  let items;

  if (pm2Missing) {
    items = [
      { label: '⚠️  PM2 not found', enabled: false },
      { label: 'Install: npm install -g pm2', enabled: false },
    ];
  } else {
    items = apps.map((a) => {
      const s = status[a.id] ?? 'unknown';
      const online = s === 'online';
      const starting = s === 'starting';
      const dot = DOT[s];
      const label = starting ? `🟡 ${a.name} — starting…` : `${dot} ${a.name}`;

      const m = monit[a.id];
      const resourceLabel = m
        ? `CPU: ${m.cpu.toFixed(1)}%  RAM: ${(m.memory / 1024 / 1024).toFixed(0)} MB`
        : null;

      return {
        label,
        submenu: [
          { label: 'Open', click: () => openApp(a) },
          { label: 'Restart', enabled: online, click: () => restartApp(a) },
          { label: 'View Logs', click: () => openLogs(a) },
          { type: 'separator' },
          { label: 'Stop', enabled: online, click: () => stopApp(a) },
          ...(resourceLabel ? [{ type: 'separator' }, { label: resourceLabel, enabled: false }] : []),
        ],
      };
    });
  }

  const anyOnline = apps.some((a) => status[a.id] === 'online');
  const anyStopped = apps.some((a) => status[a.id] === 'stopped');

  const menu = Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    { label: 'Start All', enabled: anyStopped, click: startAll },
    { label: 'Stop All', enabled: anyOnline, click: stopAll },
    { type: 'separator' },
    { label: 'Quit Launcher', click: () => { clearInterval(pollTimer); app.quit(); } },
  ]);

  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Tray icon
// ---------------------------------------------------------------------------

function getTrayIcon() {
  const file = process.platform === 'darwin' ? 'icon-mac.png' : 'icon-win.png';
  const img = nativeImage.createFromPath(join(__dirname, 'assets', file));
  if (process.platform === 'darwin' && !img.isEmpty()) img.setTemplateImage(true);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  app.dock?.hide();
  app.setLoginItemSettings({ openAtLogin: true });

  tray = new Tray(getTrayIcon());
  tray.setToolTip('Studio Launcher');

  if (process.platform === 'darwin') {
    tray.on('click', () => tray.popUpContextMenu());
  }

  await refreshStatus();
  pollTimer = setInterval(refreshStatus, 10_000);
});

app.on('window-all-closed', () => {});
