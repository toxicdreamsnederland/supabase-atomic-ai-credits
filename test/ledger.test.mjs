import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CreditCapExceededError, consumeAiCredits, createInMemoryAtomicLedger } from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

test("1. SQL Migration includes SELECT ... FOR UPDATE, RLS, pinned search_path, idempotency key, and HARD_CREDIT_CAP_REACHED", () => {
  const sql = fs.readFileSync(path.join(ROOT_DIR, "sql", "001_atomic_ai_credit_ledger.sql"), "utf8");
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /SET search_path = public/i);
  assert.match(sql, /UNIQUE \(workspace_id, idempotency_key\)/i);
  assert.match(sql, /HARD_CREDIT_CAP_REACHED/);
});

test("2. Serialized concurrent calls cannot overshoot monthly cap (race condition prevented)", async () => {
  const ledger = createInMemoryAtomicLedger({
    ws_1: { monthlyCap: 100, creditsUsed: 80 }
  });

  // Fire 5 concurrent requests of 10 credits each (only 2 can succeed; 3 must fail with 429)
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map((i) =>
      ledger.consume({ workspaceId: "ws_1", amount: 10, idempotencyKey: `req_parallel_${i}` })
    )
  );

  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 2);
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((r) => r.reason instanceof CreditCapExceededError));
  assert.equal(ledger.getWallet("ws_1").creditsUsed, 100);
});

test("3. Duplicate idempotencyKey does not double-charge", async () => {
  const ledger = createInMemoryAtomicLedger({
    ws_2: { monthlyCap: 50, creditsUsed: 0 }
  });

  const first = await ledger.consume({ workspaceId: "ws_2", amount: 15, idempotencyKey: "retry_key_abc" });
  const second = await ledger.consume({ workspaceId: "ws_2", amount: 15, idempotencyKey: "retry_key_abc" });
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(ledger.getWallet("ws_2").creditsUsed, 15);
});

test("4. consumeAiCredits Supabase RPC wrapper maps HARD_CREDIT_CAP_REACHED to CreditCapExceededError (429)", async () => {
  const fakeSupabase = {
    async rpc() {
      return { data: null, error: { message: "HARD_CREDIT_CAP_REACHED: cap exceeded" } };
    }
  };
  await assert.rejects(
    () => consumeAiCredits(fakeSupabase, { workspaceId: "ws_x", amount: 10, idempotencyKey: "key_0001" }),
    (err) => err instanceof CreditCapExceededError && err.status === 429
  );
});

test("5. npm & GitHub Launch Readiness (package.json, CI workflow, TypeScript defs, Show HN kit & policy cleanliness)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "@dynonode/atomic-ai-credits");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.homepage, "https://supalaunch.dynonode.com/");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("src/") && pkg.files.includes("sql/"));
  assert.ok(pkg.exports && pkg.exports["."]);
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 6);

  assert.ok(fs.existsSync(path.join(ROOT_DIR, "src", "index.d.ts")));
  const vercelCfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "vercel.json"), "utf8"));
  assert.equal(vercelCfg.version, 2);
  const ciYml = fs.readFileSync(path.join(ROOT_DIR, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /node-version:\s*\[20,\s*22\]/);
  assert.match(ciYml, /node --test/);

  const hnMd = fs.readFileSync(path.join(ROOT_DIR, "SHOW_HN_LAUNCH.md"), "utf8");
  assert.match(hnMd, /Show HN:/);
  assert.match(hnMd, /SELECT \.\.\. FOR UPDATE/);

  const readme = fs.readFileSync(path.join(ROOT_DIR, "README.md"), "utf8");
  assert.match(readme, /actions\/workflows\/ci\.yml\/badge\.svg/);
  assert.match(readme, /https:\/\/supalaunch\.dynonode\.com\//);
  assert.match(readme, /74716344/);

  const forbidden = [
    "mol" + "lie",
    "dynono" + "des",
    "node" + "works",
    "node" + "drive",
    "8878" + "5816",
    "onbe" + "perkt",
    "unlim" + "ited"
  ];
  function scan(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) scan(full);
      else {
        const txt = fs.readFileSync(full, "utf8").toLowerCase();
        for (const w of forbidden) {
          assert.equal(txt.includes(w), false, `Forbidden term ${w} in ${full}`);
        }
      }
    }
  }
  scan(ROOT_DIR);
});
