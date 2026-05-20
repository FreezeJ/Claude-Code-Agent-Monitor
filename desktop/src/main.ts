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
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { BrowserWindow, Notification, app, dialog, shell } from "electron";

import { APP_NAME } from "./constants";
import { isOpenAtLogin, launchedAtLogin, toggleOpenAtLogin } from "./login-item";
import { log } from "./logger";
import { focusOrCreateWindow, installApplicationMenu } from "./menu";
import {
  closeEmbeddedDatabase,
  getServerSnapshot,
  startEmbeddedServer,
  type ServerHandle,
} from "./server-host";
import { ensureUserPath } from "./shell-path";
import { createTray } from "./tray";
import { createDashboardWindow } from "./window";

interface AppState {
  serverHandle: ServerHandle | null;
  win: BrowserWindow | null;
  // Hold a reference to the tray so the GC doesn't collect it (electron quirk).
  tray: Electron.Tray | null;
  quitting: boolean;
  /** True while the quit-confirmation dialog is open; a second ⌘Q in this
   * window bypasses the dialog and lets macOS quit immediately. */
  confirmingQuit: boolean;
}

const state: AppState = {
  serverHandle: null,
  win: null,
  tray: null,
  quitting: false,
  confirmingQuit: false,
};

/**
 * Show the "Quit Claude Code Monitor?" confirmation dialog. Clicking Quit
 * runs the synchronous teardown and exits. Pressing ⌘Q again while the
 * dialog is open is caught by `before-quit` below and skips this prompt.
 */
function requestQuit(): void {
  if (state.quitting || state.confirmingQuit) return;
  state.confirmingQuit = true;
  const opts: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Quit", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: APP_NAME,
    message: "Quit Claude Code Monitor?",
    detail:
      "The embedded server will stop and your dashboard window will close. " +
      "Press ⌘Q again to skip this prompt and quit immediately.",
    noLink: true,
  };
  const parent = state.win && !state.win.isDestroyed() ? state.win : undefined;
  const promise = parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
  void promise
    .then((result) => {
      state.confirmingQuit = false;
      if (result.response === 0) {
        state.quitting = true;
        if (state.serverHandle?.ownedByUs) closeEmbeddedDatabase();
        app.exit(0);
      }
    })
    .catch(() => {
      state.confirmingQuit = false;
    });
}

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
      // We deliberately do NOT call `app.dock.hide()` here. With the red
      // close button leaving the app running, the user needs a visible
      // indication that it is still alive. The dock icon (clickable to
      // re-open the window) is exactly that signal; the menu-bar tray
      // icon backs it up. Login-launched startup is the only path that
      // hides the dock, since that user explicitly asked for unobtrusive
      // background behaviour.
      event.preventDefault();
      win.hide();
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
  // Recover the user's shell PATH before the server boots — a Finder/Dock or
  // login-launched app only inherits launchd's minimal PATH, which makes the
  // "Run Claude" feature unable to find the `claude` CLI.
  ensureUserPath();

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
    getSnapshot: () => getServerSnapshot(),
    requestQuit,
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

  app.on("before-quit", (event) => {
    // Second ⌘Q while the confirm dialog is up — bypass the prompt and let
    // macOS quit. We still close the SQLite handle on the way out so WAL is
    // checkpointed cleanly.
    if (state.confirmingQuit) {
      state.quitting = true;
      if (state.serverHandle?.ownedByUs) closeEmbeddedDatabase();
      return;
    }
    if (state.quitting) return;
    if (state.serverHandle?.ownedByUs) {
      event.preventDefault();
      requestQuit();
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
