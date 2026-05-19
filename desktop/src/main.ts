/**
 * @file Electron main process entry point.
 *
 * Lifecycle:
 *   1. App ready → start (or adopt) the embedded Express server.
 *   2. Build the application menu + system tray.
 *   3. Open the dashboard window (skipped when launched at login).
 *   4. On `window-all-closed`: keep the app running (tray-only mode).
 *   5. On `before-quit`: gracefully stop the server if we own it.
 *
 * The macOS single-instance guarantee is enforced via `requestSingleInstanceLock`
 * so double-launching just focuses the existing window.
 */

import { BrowserWindow, Notification, app, dialog, shell } from "electron";

import { APP_NAME } from "./constants";
import { isOpenAtLogin, launchedAtLogin, toggleOpenAtLogin } from "./login-item";
import { log } from "./logger";
import { focusOrCreateWindow, installApplicationMenu } from "./menu";
import { closeEmbeddedDatabase, startEmbeddedServer, type ServerHandle } from "./server-host";
import { createTray } from "./tray";
import { createDashboardWindow } from "./window";

interface AppState {
  serverHandle: ServerHandle | null;
  win: BrowserWindow | null;
  // Hold a reference to the tray so the GC doesn't collect it (electron quirk).
  tray: Electron.Tray | null;
  quitting: boolean;
}

const state: AppState = {
  serverHandle: null,
  win: null,
  tray: null,
  quitting: false,
};

function ensureWindow(): BrowserWindow {
  if (!state.serverHandle) {
    throw new Error("Cannot create window before the server is up.");
  }
  return focusOrCreateWindow(state.win, () => {
    const win = createDashboardWindow(state.serverHandle!.url);
    state.win = win;
    win.on("close", (event) => {
      if (state.quitting) return;
      // On macOS, "close" means "hide" — the tray stays, the server stays.
      event.preventDefault();
      win.hide();
      if (process.platform === "darwin") app.dock?.hide();
    });
    win.on("show", () => {
      if (process.platform === "darwin") app.dock?.show();
    });
    return win;
  });
}

async function restartServer(): Promise<void> {
  log.info("restarting server");
  if (state.serverHandle?.ownedByUs) {
    await state.serverHandle.stop();
  }
  state.serverHandle = await startEmbeddedServer();
  if (state.win && !state.win.isDestroyed()) {
    state.win
      .loadURL(state.serverHandle.url)
      .catch((err) => log.error("reload after restart failed", err));
  }
  new Notification({ title: APP_NAME, body: "Server restarted." }).show();
}

function openLogs(): void {
  const p = log.path();
  if (p) {
    void shell.showItemInFolder(p);
  } else {
    log.info("(no log file yet)");
  }
}

function openInBrowser(): void {
  if (state.serverHandle) void shell.openExternal(state.serverHandle.url);
}

function showFatalDialog(message: string, detail?: string): void {
  dialog.showErrorBox(`${APP_NAME} — Error`, detail ? `${message}\n\n${detail}` : message);
}

async function boot(): Promise<void> {
  try {
    state.serverHandle = await startEmbeddedServer();
  } catch (err) {
    log.error("server failed to start", err);
    showFatalDialog(
      "The dashboard server failed to start.",
      err instanceof Error ? err.message : String(err)
    );
    app.exit(1);
    return;
  }

  installApplicationMenu({
    showDashboard: () => ensureWindow(),
    reloadDashboard: () => state.win?.webContents.reload(),
    restartServer: () => {
      void restartServer().catch((err) =>
        showFatalDialog("Could not restart the server.", String(err))
      );
    },
    openLogs,
    toggleOpenAtLogin: () => {
      const next = toggleOpenAtLogin();
      log.info("open-at-login set to", next);
    },
    isOpenAtLogin,
  });

  state.tray = createTray({
    toggleWindow: () => {
      if (state.win && state.win.isVisible()) {
        state.win.hide();
        if (process.platform === "darwin") app.dock?.hide();
      } else {
        ensureWindow();
      }
    },
    showDashboard: () => ensureWindow(),
    restartServer: () => {
      void restartServer().catch((err) =>
        showFatalDialog("Could not restart the server.", String(err))
      );
    },
    openLogs,
    openInBrowser,
    toggleOpenAtLogin: () => toggleOpenAtLogin(),
    isOpenAtLogin,
    serverPort: () => state.serverHandle?.port ?? null,
  });

  // Skip the dashboard window when macOS launched us at login — the user just
  // logged in, they don't want a window jumping in their face. Tray only.
  if (!launchedAtLogin()) {
    ensureWindow();
  } else {
    log.info("launched at login — staying tray-only");
    if (process.platform === "darwin") app.dock?.hide();
  }
}

function wireLifecycle(): void {
  // Single-instance lock: second launches just focus the first window.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.exit(0);
    return;
  }
  app.on("second-instance", () => {
    if (state.serverHandle) ensureWindow();
  });

  app.on("activate", () => {
    if (state.serverHandle) ensureWindow();
  });

  app.on("window-all-closed", () => {
    // Stay alive: tray + server keep running on every platform.
  });

  app.on("before-quit", async (event) => {
    if (state.quitting) return;
    state.quitting = true;
    if (state.serverHandle?.ownedByUs) {
      event.preventDefault();
      try {
        await state.serverHandle.stop();
      } catch (err) {
        log.warn("server stop errored during quit", err);
      }
      // Close the SQLite handle once, here — not in stop(), which also runs on
      // "Restart Server" where the cached db module must stay usable.
      closeEmbeddedDatabase();
      app.exit(0);
    }
  });
}

app.setName(APP_NAME);
wireLifecycle();
app
  .whenReady()
  .then(boot)
  .catch((err) => {
    log.error("fatal during boot", err);
    showFatalDialog("Fatal error during startup.", String(err));
    app.exit(1);
  });
