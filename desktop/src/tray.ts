/**
 * @file Menu-bar (system tray) icon and its context menu.
 *
 * The tray is the "always-on" surface of the app. Clicking it toggles the
 * dashboard window; right-clicking opens a menu with the high-frequency
 * actions. The image is a macOS "template" PNG so the OS tints it correctly
 * in both light and dark menu bars.
 */

import { Menu, Tray, app, nativeImage } from "electron";
import * as path from "node:path";

import { APP_NAME } from "./constants";
import { log } from "./logger";

export interface TrayActions {
  toggleWindow: () => void;
  showDashboard: () => void;
  restartServer: () => void;
  openLogs: () => void;
  openInBrowser: () => void;
  toggleOpenAtLogin: () => void;
  isOpenAtLogin: () => boolean;
  serverPort: () => number | null;
}

function trayImagePath(): string {
  // In dev, __dirname is desktop/out. In prod, it's inside the asar archive.
  // The PNG ships alongside the compiled main.js, copied by electron-builder.
  return path.join(__dirname, "..", "assets", "tray-icon-Template.png");
}

export function createTray(actions: TrayActions): Tray {
  const image = nativeImage.createFromPath(trayImagePath());
  if (image.isEmpty()) {
    log.warn("tray image is empty; falling back to in-memory placeholder", trayImagePath());
  } else {
    image.setTemplateImage(true);
  }

  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(APP_NAME);

  // Built fresh on each right-click so the port label and the "Open at Login"
  // checkbox always reflect current state. We intentionally do NOT call
  // `tray.setContextMenu` — on macOS that makes a left-click open the menu,
  // which would collide with the left-click "toggle window" behavior below.
  const buildMenu = (): Menu => {
    const port = actions.serverPort();
    const portLabel = port ? `Listening on :${port}` : "Server not running";
    return Menu.buildFromTemplate([
      { label: APP_NAME, enabled: false },
      { label: portLabel, enabled: false },
      { type: "separator" },
      { label: "Open Dashboard", click: () => actions.showDashboard() },
      { label: "Open in Browser…", click: () => actions.openInBrowser() },
      { type: "separator" },
      { label: "Restart Server", click: () => actions.restartServer() },
      { label: "Show Logs", click: () => actions.openLogs() },
      { type: "separator" },
      {
        label: "Open at Login",
        type: "checkbox",
        checked: actions.isOpenAtLogin(),
        click: () => actions.toggleOpenAtLogin(),
      },
      { type: "separator" },
      {
        label: `Version ${app.getVersion()}`,
        enabled: false,
      },
      { label: "Quit", role: "quit" },
    ]);
  };

  // Left-click toggles the dashboard window; right-click opens the menu.
  tray.on("click", () => actions.toggleWindow());
  tray.on("right-click", () => tray.popUpContextMenu(buildMenu()));
  return tray;
}
