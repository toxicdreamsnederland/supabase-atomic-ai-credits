# Hacker News Launch Playbook — `@dynonode/atomic-ai-credits`

## 1. Submission Metadata

- **Title (79 chars):**  
  `Show HN: Atomic AI Credits – Postgres SELECT FOR UPDATE quota lock for Supabase`
- **Target URL:**  
  `https://github.com/dynonode/supabase-atomic-ai-credits`
- **Fallback / Companion Deep-Dive URL:**  
  `https://supalaunch.dynonode.com/blueprints/supabase-atomic-ai-credits/`

---

## 2. First Maker Comment (Post Immediately After Submitting)

Hi HN,

While auditing several Next.js + Supabase AI SaaS codebases over the past few months, I kept running into the exact same margin-bleed bug in route handlers:

1. Read `credits_used` and `monthly_cap` from `workspaces` via PostgREST (`SELECT`).
2. Check `if (credits_used + cost <= monthly_cap)` in TypeScript.
3. Call the upstream LLM (`Gemini 4 Argon`, `Claude Sonnet 5.5`, etc.).
4. Run `UPDATE workspaces SET credits_used = credits_used + cost`.

Under PostgreSQL's default `READ COMMITTED` isolation level, firing 10 concurrent requests from parallel browser tabs or client retries causes all 10 requests to read the same pre-commit `credits_used` snapshot. A workspace with 10 credits left routinely burns 100+ credits before the first `UPDATE` lands. Worse, if a client times out and retries with the same request ID, naive handlers bill the tenant twice.

Many teams reach for Upstash/Redis Lua scripts to fix this, which works for pure rate limiting, but introduces dual-write drift as soon as Stripe `invoice.paid` webhooks, team seat changes, or refunds need to reconcile against PostgreSQL.

I extracted our production ledger into a tiny, zero-dependency MIT package (`@dynonode/atomic-ai-credits`, ~110 lines of PL/pgSQL + ~100 lines of ESM/TypeScript definitions):

- **Single-RTT Row Lock:** `public.consume_ai_credits()` executes `SELECT * FROM public.ai_credit_wallets WHERE workspace_id = p_workspace_id FOR UPDATE`, serializing concurrent deductions per tenant without blocking unrelated tenants.
- **Idempotency Under Lock:** Checks `UNIQUE (workspace_id, idempotency_key)` in `public.ai_credit_ledger` inside the same transaction so network retries return the prior balance with `idempotent: true` and zero double-deduction.
- **Lazy UTC Period Reset:** Compares `period_key` against `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')` inside the row lock—avoiding midnight `pg_cron` batch spikes across inactive wallets.
- **RLS Enabled by Default:** Both `ai_credit_wallets` and `ai_credit_ledger` ship with Row-Level Security enabled so `anon`/`authenticated` PostgREST keys cannot mutate balances directly.

### Known Trade-offs & When NOT to Use This

- **Per-Tenant Lock Contention:** Because `FOR UPDATE` serializes writes per `workspace_id`, a single enterprise tenant firing >500 concurrent requests/sec against one wallet row will queue on that row lock (at ~1–2ms transaction duration). For single-tenant >1,000 RPS firehoses, sharded sub-wallets (`(workspace_id, bucket_id)` modulo `N`) or in-memory token buckets flushing asynchronously to Postgres are better fits. For 99% of multi-tenant B2B/indie SaaS apps (<50 RPS per single tenant), single-row `FOR UPDATE` adds <1.5ms overhead with strict ACID guarantees and zero extra infrastructure.
- **Pre-Reservation vs. Exact Post-Stream Token Settlement:** When streaming variable-length completions, reserve the bounded worst-case `max_tokens` cost upfront via `consume_ai_credits()`, then issue a negative-cost refund entry (or separate `refund_ai_credits` adjustment) once actual `usage` tokens arrive—never call the upstream model before acquiring the lock.

Happy to answer questions on PostgreSQL locking behavior, Supabase `SECURITY DEFINER` search-path hardening, or multi-tenant quota design.

---

## 3. Architecture & Isolation Benchmark Reference

| Strategy | Isolation / Primitive | Network Roundtrips | Over-Cap Leak Under 20x Parallel Load | Failure Mode / Operational Cost |
| :--- | :--- | :--- | :--- | :--- |
| App-Layer Read-Modify-Write | `READ COMMITTED` (`SELECT` + `UPDATE`) | 2 HTTP calls + LLM latency window | High (up to 19x overshoot) | Silent API margin loss |
| Optimistic CAS (`WHERE credits_used = $old`) | `READ COMMITTED` compare-and-swap | 1–N retries | 0% | High HTTP `409` / retry amplification for legitimate parallel tabs |
| `SERIALIZABLE` Transaction | `SQLSTATE 40001`SSI | 1–N retries (requires direct TCP pool, tricky via PostgREST) | 0% | Aborts concurrent transactions instead of queuing them cleanly |
| Redis Token Bucket + Postgres | Lua `EVALSHA` + webhook queue | 1 Redis + 1 async DB write | 0% (until Redis eviction/failover) | Two sources of truth during billing resets & refunds |
| **`@dynonode/atomic-ai-credits`** | **PL/pgSQL `SELECT ... FOR UPDATE` + `UNIQUE` key** | **1 Supabase `.rpc()` call** | **0%** | **Serializes per-workspace (>500 RPS/single-tenant needs bucket sharding)** |
