# `@dynonode/atomic-ai-credits`

[![CI](https://github.com/dynonode/supabase-atomic-ai-credits/actions/workflows/ci.yml/badge.svg)](https://github.com/dynonode/supabase-atomic-ai-credits/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](./LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-339933.svg)](./package.json)

> **Zero-dependency PostgreSQL & Supabase atomic AI credit ledger (`SELECT ... FOR UPDATE` + idempotency key + UTC billing-period auto-reset + hard monthly caps).**

Most AI SaaS starter templates meter LLM usage with an application-layer check-then-act pattern:

```ts
// ❌ Vulnerable TOCTOU (Time-of-Check to Time-of-Use) race condition:
const { data } = await supabase.from("workspaces").select("credits_used, monthly_cap").eq("id", wsId).single();
if (data.credits_used + 10 <= data.monthly_cap) {
  await supabase.from("workspaces").update({ credits_used: data.credits_used + 10 }).eq("id", wsId);
}
```

Under PostgreSQL's default `READ COMMITTED` isolation, 10 concurrent HTTP requests reading `credits_used = 90` against `monthly_cap = 100` all evaluate `90 + 10 <= 100` as `true` before any `UPDATE` commits—allowing **190 credits** of upstream LLM calls (`Gemini 4 Argon`, `Claude Sonnet 5.5`, etc.) on a 100-credit cap.

`@dynonode/atomic-ai-credits` moves row locking, idempotent retry deduplication, and UTC monthly rollover into a single deterministic PostgreSQL RPC (`public.consume_ai_credits`).

---

## Race-Condition Proof & Architecture Comparison

Tested scenario: Tenant wallet has `credits_used = 80` and `monthly_cap = 100` (20 credits left). Client fires **10 parallel requests** of `10` credits each, plus **3 network retries** carrying duplicate `idempotencyKey` values.

| Metering Pattern | Concurrent Calls Allowed | Actual Credits Consumed | Duplicate Retry Double-Charge | Extra Infra Required |
| :--- | :--- | :--- | :--- | :--- |
| Naive JS `SELECT` then `UPDATE` (`READ COMMITTED`) | up to 10 / 10 | **180 / 100** (80% over-cap bleed) | Yes (charges again) | None |
| Postgres `SERIALIZABLE` without row-lock RPC | 1–2 + serialization `40001` errors | 90–100 (requires client retry loops) | Requires separate table | None |
| External Redis Lua + async Postgres sync | 2 / 10 | 100 / 100 | No (if TTL matches) | Redis cluster + dual-write drift risk |
| **`@dynonode/atomic-ai-credits` (`SELECT ... FOR UPDATE`)** | **Exact 2 / 10** (`8` get `429`) | **Exact 100 / 100** (`0` bleed) | **No** (`idempotent: true`) | **0 (Pure PostgreSQL / Supabase)** |

---

## 3-Step Copy-Paste Quickstart

### Step 1 — Install Package

```bash
npm install @dynonode/atomic-ai-credits
```

### Step 2 — Run SQL Migration in Supabase SQL Editor

Paste [`sql/001_atomic_ai_credit_ledger.sql`](./sql/001_atomic_ai_credit_ledger.sql) into your Supabase SQL Editor (or copy into `supabase/migrations/`). It provisions:
- `public.ai_credit_wallets` (`workspace_id`, `monthly_cap`, `credits_used`, `period_key` UTC `YYYY-MM`) with `ROW LEVEL SECURITY` enabled.
- `public.ai_credit_ledger` (`UNIQUE (workspace_id, idempotency_key)`, `delta`, `balance_after`, `model_key`) with `ROW LEVEL SECURITY` enabled.
- `public.consume_ai_credits(p_workspace_id, p_amount, p_idempotency_key, p_model_key)` `SECURITY DEFINER` RPC executing `SELECT * FROM public.ai_credit_wallets WHERE workspace_id = p_workspace_id FOR UPDATE`.

```sql
-- Seed a bounded tenant wallet (e.g., 500 monthly credits):
INSERT INTO public.ai_credit_wallets (workspace_id, monthly_cap)
VALUES ('00000000-0000-0000-0000-000000000001', 500)
ON CONFLICT (workspace_id) DO UPDATE SET monthly_cap = EXCLUDED.monthly_cap;
```

### Step 3 — Guard Your Next.js / Edge / Node Route Handler

```ts
import { createClient } from "@supabase/supabase-js";
import { consumeAiCredits, CreditCapExceededError } from "@dynonode/atomic-ai-credits";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  const requestId = req.headers.get("x-idempotency-key") ?? crypto.randomUUID();
  const workspaceId = "00000000-0000-0000-0000-000000000001";

  try {
    const quota = await consumeAiCredits(supabaseAdmin, {
      workspaceId,
      amount: 5,
      idempotencyKey: requestId,
      modelKey: "google/gemini-4-argon"
    });

    // Safe to invoke upstream LLM API — budget is atomically reserved:
    return Response.json({
      ok: true,
      idempotentReplay: quota.idempotent,
      remainingCredits: quota.remaining,
      monthlyCap: quota.monthlyCap
    });
  } catch (err) {
    if (err instanceof CreditCapExceededError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: err.status } // HTTP 429
      );
    }
    throw err;
  }
}
```

---

## 1-Click Edge / Serverless Deployment

Includes [`vercel.json`](./vercel.json) with strict security headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`) for instant Next.js 15 / Edge Route deployment on Vercel or Cloudflare Workers.

---

## Run Tests Locally

Zero external dependencies. Uses Node's built-in `node:test` runner (`>=20.0.0`):

```bash
npm test
```

---

## Related Production Tooling

If you want the full multi-tenant Next.js 15 App Router + Tailwind CSS v4 + Supabase SSR codebase already wired around this pattern (7 RLS tables, SHA-256 team invite seat caps, zero-SDK WebCrypto Stripe HMAC webhooks, and bounded `>=75%` gross margin SaaS plan templates), inspect **[SupaLaunch Kit](https://supalaunch.dynonode.com/)** or read the deep-dive engineering blueprint at [`supalaunch.dynonode.com/blueprints/supabase-atomic-ai-credits/`](https://supalaunch.dynonode.com/blueprints/supabase-atomic-ai-credits/).

*MIT License · Maintained by Toxic Dreams (d/b/a [DynoNode](https://dynonode.com), Dirk Boutsstraat 22, 5753 BD Deurne, NL · KvK 74716344 · VAT NL002407479B40).*
