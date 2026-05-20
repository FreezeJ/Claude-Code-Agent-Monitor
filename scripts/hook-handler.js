#!/usr/bin/env node

/**
 * Claude Code hook handler.
 * Receives hook event JSON on stdin and forwards it to every live Agent
 * Dashboard server. Designed to fail silently so it never blocks Claude
 * Code, and to fan out across multiple dashboards (e.g. the macOS desktop
 * app running alongside `npm run dev`) so each one keeps its real-time
 * stream.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const http = require("http");

const hookType = process.argv[2] || "unknown";

/**
 * Resolve every live dashboard server's port via the discovery file. Falls
 * back to the `CLAUDE_DASHBOARD_PORT` override or the conventional 4820 if
 * the discovery module can't load for any reason. Never throws.
 */
function resolvePorts() {
  try {
    return require("../server/lib/server-info").resolveAllDashboardPorts();
  } catch {
    const envPort = parseInt(process.env.CLAUDE_DASHBOARD_PORT || "", 10);
    return [Number.isInteger(envPort) && envPort > 0 ? envPort : 4820];
  }
}

const ports = resolvePorts();

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let parsedData;
  try {
    parsedData = JSON.parse(input);
  } catch {
    parsedData = { raw: input };
  }

  const payload = JSON.stringify({
    hook_type: hookType,
    data: parsedData,
  });
  const contentLength = Buffer.byteLength(payload);

  // Fan out one POST per live server. Each per-target promise always
  // resolves (never rejects), so a single dead listener cannot starve the
  // others and we can wait on Promise.all without a single failure exiting
  // the process early.
  const sends = ports.map(
    (port) =>
      new Promise((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/hooks/event",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": contentLength,
            },
            timeout: 3000,
          },
          (res) => {
            res.resume();
            res.once("end", resolve);
            res.once("close", resolve);
          }
        );
        req.on("error", resolve);
        req.on("timeout", () => {
          req.destroy();
          resolve();
        });
        req.write(payload);
        req.end();
      })
  );

  Promise.all(sends).finally(() => process.exit(0));
});

// Safety net timeout — guarantees the hook never blocks Claude Code even if
// every dashboard hangs forever.
setTimeout(() => process.exit(0), 5000);
