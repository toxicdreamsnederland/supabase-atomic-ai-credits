export interface CreditCapErrorDetails {
  workspaceId?: string;
  amount?: number;
  used?: number;
  cap?: number;
}

export declare class CreditCapExceededError extends Error {
  code: "HARD_CREDIT_CAP_REACHED";
  status: 429;
  details: CreditCapErrorDetails;
  constructor(message: string, details?: CreditCapErrorDetails);
}

export interface ConsumeAiCreditsInput {
  workspaceId: string;
  amount: number;
  idempotencyKey: string;
  modelKey?: string | null;
}

export interface ConsumeAiCreditsResult {
  allowed: boolean;
  idempotent: boolean;
  creditsUsed: number;
  monthlyCap: number;
  remaining: number;
}

export interface MinimalSupabaseRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export declare function consumeAiCredits(
  supabase: MinimalSupabaseRpcClient,
  input: ConsumeAiCreditsInput
): Promise<ConsumeAiCreditsResult>;

export interface WalletSeed {
  monthlyCap: number;
  creditsUsed?: number;
}

export declare function createInMemoryAtomicLedger(
  initialWallets?: Record<string, WalletSeed>
): {
  consume(input: ConsumeAiCreditsInput): Promise<ConsumeAiCreditsResult>;
  getWallet(workspaceId: string): { monthlyCap: number; creditsUsed: number } | undefined;
};
