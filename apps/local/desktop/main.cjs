// Desktop helper (Electron): a tray / menu-bar app and nothing else. It has no windows. It starts the
// local service (optionally at login), shows its status and the one-time pairing code, and opens the
// Shipline hub in the user's browser, where all the work happens. The service binds to 127.0.0.1 only.
// OPEN-QUESTION #2: Electron chosen over Tauri for v1 (see README). A tray helper is small enough
// that swapping to Tauri later means replacing this folder, not the service.
const { app, clipboard, Menu, nativeImage, shell, Tray } = require('electron');
const path = require('path');

let server;
let tray;

function statusLabel() {
  if (!server) return 'Starting...';
  const signedIn = server.isSignedIn() ? 'signed in to Shipline' : 'not signed in to Shipline';
  const sessions = server.activeSessionCount();
  return `Running on 127.0.0.1:${server.port} (${signedIn}, ${sessions} session${sessions === 1 ? '' : 's'})`;
}

function buildMenu() {
  const code = server ? server.pairingCode() : '...';
  return Menu.buildFromTemplate([
    { label: 'Shipline Local', enabled: false },
    { label: statusLabel(), enabled: false },
    { type: 'separator' },
    {
      label: `Pairing code: ${code}  (click to copy)`,
      enabled: !!server,
      click: () => clipboard.writeText(code),
    },
    {
      label: 'New pairing code',
      enabled: !!server,
      click: () => {
        server.regeneratePairingCode();
        refresh();
      },
    },
    {
      label: `Paired browsers: ${server ? server.pairedBrowsers() : 0}  (click to unpair all)`,
      enabled: !!server && server.pairedBrowsers() > 0,
      click: () => {
        server.revokeAllPairings();
        refresh();
      },
    },
    { type: 'separator' },
    { label: 'Open Shipline', enabled: !!server, click: () => void shell.openExternal(server.hubUrl) },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit Shipline Local', click: () => app.quit() },
  ]);
}

function refresh() {
  if (tray) tray.setContextMenu(buildMenu());
}

async function start() {
  if (process.platform === 'darwin') app.dock.hide();

  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip('Shipline Local');
  refresh();

  const { startLocalServer } = require(path.join(__dirname, '..', 'dist', 'server', 'index.js'));
  server = await startLocalServer({ port: Number(process.env.SHIPLINE_LOCAL_PORT || 4777) });
  refresh();
  // The pairing code is one-time and sign-in state changes while the menu is closed: keep it fresh.
  setInterval(refresh, 3000).unref();
}

// Only one tray helper at a time (the port is fixed).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start);
  // A tray app keeps running with no windows.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    if (server) void server.close();
  });
}
