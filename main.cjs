'use strict';

/**
 * Studio Launcher — tray-only Electron app.
 *
 * No BrowserWindow. No native modules. No ABI concerns.
 * Does exactly three things:
 *   1. Shows a system tray icon with per-app status
 *   2. Starts apps via PM2 on demand
 *   3. Opens apps in the system browser
 */

const { app, Tray, Menu, nativeImage, shell } = require('electron');
const { exec } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { join, resolve } = require('path');
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
    // local.apps entries override by id
    if (local.apps) {
      for (const localApp of local.apps) {
        const idx = base.apps.findIndex((a) => a.id === localApp.id);
        if (idx >= 0) base.apps[idx] = { ...base.apps[idx], ...localApp };
        else base.apps.push(localApp);
      }
    }
  }
  // Expand ~ in ecosystemPath
  return base.apps.map((a) => ({ ...a, ecosystemPath: expandHome(a.ecosystemPath) }));
}

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tray = null;
let pollTimer = null;
const status = {}; // appId -> 'online' | 'stopped' | 'starting' | 'unknown'
const apps = loadApps();

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

function isOnline(list, pm2Names) {
  return pm2Names.every((name) => {
    const proc = list.find((p) => p.name === name);
    return proc && proc.pm2_env?.status === 'online';
  });
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
// Open an app — start if needed, then open browser
// ---------------------------------------------------------------------------

async function openApp(appDef) {
  const names = appDef.pm2Names;
  const list = await pm2List();

  if (isOnline(list, names)) {
    shell.openExternal(appDef.url);
    return;
  }

  // Mark as starting so the menu reflects it
  status[appDef.id] = 'starting';
  rebuildMenu();

  if (!existsSync(appDef.ecosystemPath)) {
    // Fallback: just open the URL and hope for the best
    shell.openExternal(appDef.url);
    return;
  }

  await pm2Start(appDef.ecosystemPath, names);
  await waitForHealth(appDef.healthUrl);
  shell.openExternal(appDef.url);
  await refreshStatus();
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
    if (status[a.id] === 'starting') continue; // don't overwrite mid-start
    status[a.id] = isOnline(list, a.pm2Names) ? 'online' : 'stopped';
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
      const dot = DOT[status[a.id] ?? 'unknown'];
      const label = status[a.id] === 'starting'
        ? `🟡 ${a.name} — starting…`
        : `${dot} ${a.name}`;
      return { label, click: () => openApp(a) };
    });
  }

  const menu = Menu.buildFromTemplate([
    ...items,
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
  // No dock icon on macOS — this is a tray-only app
  app.dock?.hide();

  // Register as a login item so the launcher starts with the OS
  app.setLoginItemSettings({ openAtLogin: true });

  tray = new Tray(getTrayIcon());
  tray.setToolTip('Studio Launcher');

  // macOS: left-click shows the context menu (default is right-click only)
  if (process.platform === 'darwin') {
    tray.on('click', () => tray.popUpContextMenu());
  }

  // Initial status + start polling
  await refreshStatus();
  pollTimer = setInterval(refreshStatus, 10_000);
});

// Keep the process alive even with no windows open
app.on('window-all-closed', () => {});
