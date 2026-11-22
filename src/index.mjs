export class CreditCapExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CreditCapExceededError";
    this.code = "HARD_CREDIT_CAP_REACHED";
    this.status = 429;
    this.details = details;
  }
}

/**
 * Calls the PostgreSQL `consume_ai_credits` RPC through a Supabase client.
 */
export async function consumeAiCredits(supabase, { workspaceId, amount, idempotencyKey, modelKey = null }) {
  if (!supabase || typeof supabase.rpc !== "function") {
    throw new Error("A Supabase client instance with .rpc() is required.");
  }
  const { data, error } = await supabase.rpc("consume_ai_credits", {
    p_workspace_id: workspaceId,
    p_amount: amount,
    p_idempotency_key: idempotencyKey,
    p_model_key: modelKey
  });

  if (error) {
    const msg = String(error.message || "");
    if (msg.includes("HARD_CREDIT_CAP_REACHED")) {
      throw new CreditCapExceededError("Monthly AI credit cap reached for workspace.", { workspaceId, amount });
    }
    throw new Error(msg || "CREDIT_LEDGER_ERROR");
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    idempotent: Boolean(row?.idempotent),
    creditsUsed: Number(row?.credits_used || 0),
    monthlyCap: Number(row?.monthly_cap || 0),
    remaining: Number(row?.remaining || 0)
  };
}

/**
 * Deterministic single-writer queue simulator matching PostgreSQL `SELECT ... FOR UPDATE` semantics
 * for local unit tests without a running Postgres server.
 */
export function createInMemoryAtomicLedger(initialWallets = {}) {
  const wallets = new Map();
  const seenKeys = new Map();
  let lockChain = Promise.resolve();

  for (const [id, w] of Object.entries(initialWallets)) {
    wallets.set(id, { monthlyCap: Number(w.monthlyCap), creditsUsed: Number(w.creditsUsed || 0) });
    seenKeys.set(id, new Set());
  }

  return {
    consume({ workspaceId, amount, idempotencyKey }) {
      const task = lockChain.then(() => {
        if (!Number.isInteger(amount) || amount <= 0) throw new Error("INVALID_CREDIT_AMOUNT");
        if (!idempotencyKey || String(idempotencyKey).length < 4) throw new Error("INVALID_IDEMPOTENCY_KEY");

        const wallet = wallets.get(workspaceId);
        if (!wallet) throw new Error("WALLET_NOT_FOUND");
        const keySet = seenKeys.get(workspaceId);

        if (keySet.has(idempotencyKey)) {
          return {
            allowed: true,
            idempotent: true,
            creditsUsed: wallet.creditsUsed,
            monthlyCap: wallet.monthlyCap,
            remaining: Math.max(0, wallet.monthlyCap - wallet.creditsUsed)
          };
        }

        if (wallet.creditsUsed + amount > wallet.monthlyCap) {
          throw new CreditCapExceededError(
            `HARD_CREDIT_CAP_REACHED: requested ${amount}, used ${wallet.creditsUsed}, cap ${wallet.monthlyCap}`,
            { workspaceId, amount, used: wallet.creditsUsed, cap: wallet.monthlyCap }
          );
        }

        wallet.creditsUsed += amount;
        keySet.add(idempotencyKey);

        return {
          allowed: true,
          idempotent: false,
          creditsUsed: wallet.creditsUsed,
          monthlyCap: wallet.monthlyCap,
          remaining: Math.max(0, wallet.monthlyCap - wallet.creditsUsed)
        };
      });

      lockChain = task.catch(() => {});
      return task;
    },
    getWallet(workspaceId) {
      return wallets.get(workspaceId);
    }
  };
}
