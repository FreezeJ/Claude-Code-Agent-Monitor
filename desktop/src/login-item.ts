/**
 * @file macOS Login Items integration.
 *
 * Uses Electron's first-party API (which wraps the modern
 * `SMAppService` / `ServiceManagement` framework on macOS 13+) instead of
 * dropping a LaunchAgent plist. This makes the toggle show up in
 * System Settings → General → Login Items where users expect to manage it.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { app } from "electron";

export function isOpenAtLogin(): boolean {
  if (process.platform !== "darwin") return false;
  return app.getLoginItemSettings().openAtLogin;
}

export function setOpenAtLogin(enabled: boolean): void {
  if (process.platform !== "darwin") return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Start hidden — the user just logged in, they didn't ask for a window
    // to appear. The tray icon makes the app's presence obvious.
    openAsHidden: true,
  });
}

export function toggleOpenAtLogin(): boolean {
  const next = !isOpenAtLogin();
  setOpenAtLogin(next);
  return next;
}

/**
 * Returns true if the current process was launched by macOS at login (as
 * opposed to the user double-clicking the app). When true, we keep the
 * window hidden and only show the tray icon.
 */
export function launchedAtLogin(): boolean {
  if (process.platform !== "darwin") return false;
  return app.getLoginItemSettings().wasOpenedAtLogin;
}
