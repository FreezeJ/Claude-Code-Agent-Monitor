#!/usr/bin/env node

/**
 * Repro & verify GitHub issue #156:
 *   "Compaction agents stored with ended_at < started_at → negative
 *    avgDuration in workflows analytics"
 *
 * Usage:
 *   node scripts/repro-issue-156.js            Run repro + verify the fix.
 *   node scripts/repro-issue-156.js --cleanup  Remove fixture rows.
 *
 * What this script does
 * ─────────────────────
 *  1. Loads server/db (which runs the startup repair migration introduced
 *     for this issue — any pre-existing broken rows in your DB are healed
 *     at that moment).
 *  2. Inserts a synthetic compaction agent the *broken* way: started_at is
 *     stamped to wall-clock NOW and ended_at to a transcript timestamp 60s
 *     in the past. This is exactly how the pre-fix ingestion path in
 *     server/routes/hooks.js misbehaved.
 *  3. Prints the BEFORE state — note duration_sec is negative.
 *  4. Re-applies the repair migration manually (same SQL the server runs
 *     on startup) and prints the AFTER state — duration_sec is 0 and the
 *     invariant started_at <= ended_at holds.
 *
 * Re-running is safe — the fixture session is recreated each time. Use
 * --cleanup to remove it when you are done.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const path = require("path");
const { db, stmts } = require(path.join(__dirname, "..", "server", "db"));

const FIXTURE = {
  sessionId: "demo-issue156-compaction-bug",
  mainAgentId: "demo-issue156-main",
  compactionAgentId: "demo-issue156-compact-broken",
};

const args = new Set(process.argv.slice(2));
const CLEANUP = args.has("--cleanup");

function fmtRow(row) {
  if (!row) return "  (row missing)";
  const dur =
    row.ended_at && row.started_at
      ? (
          (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 1000
        ).toFixed(3)
      : "n/a";
  return [
    `  id           = ${row.id}`,
    `  started_at   = ${row.started_at}`,
    `  ended_at     = ${row.ended_at}`,
    `  duration_sec = ${dur}`,
  ].join("\n");
}

function deleteFixture() {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM events WHERE session_id = ?").run(FIXTURE.sessionId);
    db.prepare("DELETE FROM agents WHERE session_id = ?").run(FIXTURE.sessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(FIXTURE.sessionId);
  });
  tx();
}

function insertBrokenCompaction() {
  const tx = db.transaction(() => {
    stmts.insertSession.run(
      FIXTURE.sessionId,
      "Issue #156 repro — broken compaction row",
      "completed",
      "/tmp",
      "claude-sonnet-4-6",
      null
    );
    stmts.insertAgent.run(
      FIXTURE.mainAgentId,
      FIXTURE.sessionId,
      "Main Agent",
      "main",
      null,
      "completed",
      null,
      null,
      null
    );
    // Synthetic compaction row — mirrors the *pre-fix* ingestion path:
    //   started_at = NOW (insertAgent default, set by SQL strftime('now'))
    //   ended_at   = transcript timestamp 60s in the past
    // The invariant ended_at < started_at therefore holds, and the workflows
    // analytics aggregation produces a negative avgDuration.
    stmts.insertAgent.run(
      FIXTURE.compactionAgentId,
      FIXTURE.sessionId,
      "Context Compaction",
      "subagent",
      "compaction",
      "completed",
      "Automatic conversation context compression",
      FIXTURE.mainAgentId,
      null
    );
    const pastTs = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE agents SET ended_at = ? WHERE id = ?").run(
      pastTs,
      FIXTURE.compactionAgentId
    );
  });
  tx();
}

function applyRepairMigration() {
  // Same SQL the server runs on startup (server/db.js startup-repair block).
  const res = db
    .prepare(
      `UPDATE agents SET
         started_at = ended_at,
         updated_at = ended_at
       WHERE subagent_type = 'compaction'
         AND ended_at IS NOT NULL
         AND julianday(ended_at) < julianday(started_at)`
    )
    .run();
  return res.changes;
}

function getCompactionAvgDurationSec() {
  // Mirror of the SELECT in server/routes/workflows.js for the compaction type.
  const row = db
    .prepare(
      `SELECT AVG(
         CASE WHEN ended_at IS NOT NULL
           THEN (julianday(ended_at) - julianday(started_at)) * 86400
           ELSE NULL END
       ) AS avg_duration
       FROM agents WHERE subagent_type = 'compaction' AND type = 'subagent'`
    )
    .get();
  return row?.avg_duration ?? null;
}

function main() {
  if (CLEANUP) {
    deleteFixture();
    console.log("Removed fixture session and rows for issue #156.");
    return;
  }

  console.log("Issue #156 repro — compaction agent timestamp invariant");
  console.log("=========================================================\n");

  // Start from a clean slate so the script is rerunnable.
  deleteFixture();
  insertBrokenCompaction();

  const before = db
    .prepare("SELECT id, started_at, ended_at FROM agents WHERE id = ?")
    .get(FIXTURE.compactionAgentId);
  console.log("BEFORE repair (simulates pre-fix ingestion):");
  console.log(fmtRow(before));
  const avgBefore = getCompactionAvgDurationSec();
  console.log(
    `  avgDuration (compaction, all rows) = ${avgBefore?.toFixed(3) ?? "null"} sec\n`
  );

  if (!before || new Date(before.ended_at) >= new Date(before.started_at)) {
    console.log(
      "  !! expected ended_at < started_at but invariant already holds.\n" +
        "     This usually means seed bypassed the broken path — investigate.\n"
    );
    process.exitCode = 1;
    return;
  }

  const changed = applyRepairMigration();
  console.log(`Applied repair migration — ${changed} row(s) healed.\n`);

  const after = db
    .prepare("SELECT id, started_at, ended_at FROM agents WHERE id = ?")
    .get(FIXTURE.compactionAgentId);
  console.log("AFTER repair:");
  console.log(fmtRow(after));
  const avgAfter = getCompactionAvgDurationSec();
  console.log(
    `  avgDuration (compaction, all rows) = ${avgAfter?.toFixed(3) ?? "null"} sec\n`
  );

  const ok =
    after &&
    after.started_at === after.ended_at &&
    new Date(after.ended_at).getTime() >= new Date(after.started_at).getTime();

  if (ok) {
    console.log("PASS — invariant restored and avgDuration is non-negative.");
    console.log("       The same repair runs automatically on every server start.");
    console.log("\nRun `node scripts/repro-issue-156.js --cleanup` to remove the fixture.");
  } else {
    console.log("FAIL — repair did not restore the invariant. Inspect the migration.");
    process.exitCode = 1;
  }
}

main();
