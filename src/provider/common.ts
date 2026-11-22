// Messages between the page script, the content script and the background.

export const TO_CONTENT = "rings-wallet:to-content";
export const TO_PAGE = "rings-wallet:to-page";
export const PORT_NAME = "rings-provider";

export type ProviderMethod = "connect" | "disconnect" | "signTransactions" | "signAndSendTransaction" | "signMessage" | "signIn";

export interface PageRequest {
  target: typeof TO_CONTENT;
  id: string;
  method: ProviderMethod;
  params: unknown;
}

export interface PageResponse {
  target: typeof TO_PAGE;
  id?: string;
  result?: unknown;
  error?: { message: string; code: number };
  /** Pushed by the background when the connected account changes or goes away. */
  event?: "accounts";
  accounts?: string[];
}

/** EIP-1193 and JSON-RPC error codes. */
export const REJECTED = 4001;
export const UNAUTHORIZED = 4100;
export const INTERNAL = -32603;

export interface ConnectParams {
  silent?: boolean;
}
export interface SignTransactionsParams {
  /** base64 wire transactions. */
  transactions: string[];
}
export interface SignAndSendParams {
  transaction: string;
  options?: { skipPreflight?: boolean; maxRetries?: number };
}
export interface SignMessageParams {
  /** base64 bytes. */
  message: string;
}
export interface SignInParams {
  input?: {
    domain?: string;
    statement?: string;
    uri?: string;
    version?: string;
    chainId?: string;
    nonce?: string;
    issuedAt?: string;
    expirationTime?: string;
    notBefore?: string;
    requestId?: string;
    resources?: string[];
  };
}
