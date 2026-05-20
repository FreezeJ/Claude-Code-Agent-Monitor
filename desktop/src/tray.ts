/**
 * @file Menu-bar (system tray) icon and its context menu.
 *
 * The tray is the "always-on" surface of the app. A single click opens the
 * menu showing live status snapshots from the embedded server plus an Open
 * Dashboard action. The image is a macOS "template" PNG so the OS tints it
 * correctly in both light and dark menu bars.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { Menu, Tray, app, nativeImage } from "electron";
import * as path from "node:path";

import { APP_NAME } from "./constants";
import { log } from "./logger";

export interface TrayActions {
  showDashboard: () => void;
  restartServer: () => void;
  openLogs: () => void;
  openInBrowser: () => void;
  toggleOpenAtLogin: () => void;
  isOpenAtLogin: () => boolean;
  serverPort: () => number | null;
  /** Live status snapshot fetched fresh each time the menu opens. */
  getSnapshot: () => ServerSnapshot | null;
  /** Prompt the same quit-confirmation dialog ⌘Q triggers. */
  requestQuit: () => void;
}

export interface ServerSnapshot {
  activeSessions: number;
  workingAgents: number;
  eventsToday: number;
}

/**
 * Tray icon PNG location. In dev `__dirname` is `desktop/out/`, so `../assets`
 * resolves to `desktop/assets/`. In the packaged app the PNG ships outside
 * the asar archive via `extraResources` (see electron-builder.yml), so we
 * read it from `process.resourcesPath/assets/`. Loading template PNGs from
 * inside asar can yield empty `nativeImage` results, which is why we keep
 * them unpacked.
 */
function trayImagePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "assets", "tray-icon-Template.png");
  }
  return path.join(__dirname, "..", "assets", "tray-icon-Template.png");
}

export function createTray(actions: TrayActions): Tray {
  const imagePath = trayImagePath();
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) {
    log.warn("tray image is empty; falling back to in-memory placeholder", imagePath);
  } else {
    image.setTemplateImage(true);
  }

  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(APP_NAME);

  // Singular/plural helper so "1 active session" doesn't read as "1 active sessions".
  const plural = (n: number, singular: string, pluralForm?: string): string =>
    `${n.toLocaleString()} ${n === 1 ? singular : (pluralForm ?? singular + "s")}`;

  // Built fresh on each click so the port, status snapshot, and the
  // "Open at Login" checkbox always reflect current state. Snapshot rows
  // are intentionally `enabled` (with a click handler that opens the
  // dashboard) instead of `enabled: false` — disabled menu items get
  // dimmed by macOS, which looked sickly next to the actionable rows
  // below them. Clicking any row now lands on the dashboard where the
  // user can see the same numbers in context.
  const buildMenu = (): Menu => {
    const port = actions.serverPort();
    const portLabel = port ? `🟢  Listening on :${port}` : "🔴  Server not running";
    const snap = actions.getSnapshot();
    const open = (): void => actions.showDashboard();
    const snapshotItems: Electron.MenuItemConstructorOptions[] = snap
      ? [
          { type: "separator" },
          { label: `📊   ${plural(snap.activeSessions, "active session")}`, click: open },
          { label: `🤖   ${plural(snap.workingAgents, "working agent")}`, click: open },
          { label: `📥   ${plural(snap.eventsToday, "event")} today`, click: open },
        ]
      : [{ type: "separator" }, { label: "Snapshot unavailable", enabled: false }];

    return Menu.buildFromTemplate([
      { label: APP_NAME, enabled: false },
      { label: portLabel, enabled: false },
      ...snapshotItems,
      { type: "separator" },
      { label: "Open Dashboard", accelerator: "CmdOrCtrl+O", click: open },
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
      { label: `Version ${app.getVersion()}`, enabled: false },
      {
        label: "Quit Claude Code Monitor",
        accelerator: "CmdOrCtrl+Q",
        click: () => actions.requestQuit(),
      },
    ]);
  };

  // Single click (left or right) opens the menu — the conventional macOS
  // menu-bar utility pattern. Opening the dashboard is the first action in
  // the menu, so it's still one click + Enter to surface the window.
  const showMenu = (): void => tray.popUpContextMenu(buildMenu());
  tray.on("click", showMenu);
  tray.on("right-click", showMenu);
  return tray;
}
