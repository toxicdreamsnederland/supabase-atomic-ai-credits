-- Race-condition-free Atomic AI Credit Ledger for Supabase / PostgreSQL
-- Prevents concurrent API requests from bypassing monthly AI usage quotas.

CREATE TABLE IF NOT EXISTS public.ai_credit_wallets (
  workspace_id uuid PRIMARY KEY,
  monthly_cap integer NOT NULL CHECK (monthly_cap >= 0),
  credits_used integer NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  period_key text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.ai_credit_wallets(workspace_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  delta integer NOT NULL,
  balance_after integer NOT NULL,
  model_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

ALTER TABLE public.ai_credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_credit_ledger ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_ai_credits(
  p_workspace_id uuid,
  p_amount integer,
  p_idempotency_key text,
  p_model_key text DEFAULT NULL
)
RETURNS TABLE (
  allowed boolean,
  idempotent boolean,
  credits_used integer,
  monthly_cap integer,
  remaining integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet public.ai_credit_wallets%ROWTYPE;
  v_existing public.ai_credit_ledger%ROWTYPE;
  v_current_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_new_used integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT';
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) < 4 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  -- Lock wallet row FOR UPDATE to serialize concurrent requests on the same workspace
  SELECT * INTO v_wallet
  FROM public.ai_credit_wallets
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  -- Auto-reset usage when rolling into a new UTC billing month
  IF v_wallet.period_key <> v_current_period THEN
    v_wallet.credits_used := 0;
    v_wallet.period_key := v_current_period;
  END IF;

  -- Idempotency check under lock: duplicate retries return previous result without double-charging
  SELECT * INTO v_existing
  FROM public.ai_credit_ledger
  WHERE workspace_id = p_workspace_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN QUERY SELECT
      true,
      true,
      v_wallet.credits_used,
      v_wallet.monthly_cap,
      GREATEST(0, v_wallet.monthly_cap - v_wallet.credits_used);
    RETURN;
  END IF;

  v_new_used := v_wallet.credits_used + p_amount;
  IF v_new_used > v_wallet.monthly_cap THEN
    RAISE EXCEPTION 'HARD_CREDIT_CAP_REACHED: requested %, used %, cap %', p_amount, v_wallet.credits_used, v_wallet.monthly_cap;
  END IF;

  UPDATE public.ai_credit_wallets
  SET credits_used = v_new_used,
      period_key = v_current_period,
      updated_at = now()
  WHERE workspace_id = p_workspace_id;

  INSERT INTO public.ai_credit_ledger (workspace_id, idempotency_key, delta, balance_after, model_key)
  VALUES (p_workspace_id, p_idempotency_key, -p_amount, GREATEST(0, v_wallet.monthly_cap - v_new_used), p_model_key);

  RETURN QUERY SELECT
    true,
    false,
    v_new_used,
    v_wallet.monthly_cap,
    GREATEST(0, v_wallet.monthly_cap - v_new_used);
END;
$$;
