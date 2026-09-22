// API client. All requests proxy through Next.js rewrites to the FastAPI
// backend at 127.0.0.1:8000 (configured in next.config.js). The frontend
// never talks to a different origin.

export type User = {
  id: number;
  handle: string;
  display_name: string;
  phone: string;
};

export type Txn = {
  id: number;
  kind: string;
  status: string;
  amount_bdt: string;
  direction: "in" | "out";
  counterparty: string | null;
  counterparty_phone: string | null;
  note: string | null;
  created_at: string;
  completed_at: string | null;
};

export type PendingRequest = {
  id: number;
  asker_handle: string;
  asker_phone: string;
  amount_bdt: string;
  note: string | null;
  created_at: string;
};

export type SavingsGoal = {
  id: number;
  festival: string;
  target_amount_bdt: string;
  saved_amount_bdt: string;
  target_date: string | null;
};

export type ReviewCard = {
  kind: "send" | "request" | "split" | "pay_bill";
  amount_bdt: string;
  recipient_label?: string | null;
  recipient_phone?: string | null;
  recipients?: string[] | null;
  note?: string | null;
  resulting_balance_bdt: string;
  initiator_handle: string;
  initiator_phone: string;
};

export type AgentActResponse = {
  text: string;
  card?: ReviewCard | null;
  pending_id?: number | null;
  action: string;
  idempotent_replay?: boolean;
  data?: Record<string, unknown> | null;
};

export type AgentConfirmResponse = {
  text: string;
  success: boolean;
  new_balance_bdt?: string | null;
  data?: Record<string, unknown> | null;
};

export type HistoryResponse = {
  user_id: number;
  handle: string;
  balance_bdt: string;
  txns: Txn[];
  timeline: { date: string; balance: number }[];
};

const BASE = "/api";

async function httpJson<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit
): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    ...init,
  });
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      if (j?.detail) detail += `: ${JSON.stringify(j.detail)}`;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return (await r.json()) as T;
}

export const api = {
  listUsers: () => httpJson<User[]>("GET", "/users"),
  getUser: (id: number) => httpJson<User>("GET", `/users/${id}`),
  getUserByHandle: (handle: string) =>
    httpJson<User>("GET", `/users/handle/${handle}`),
  getBalance: (id: number) =>
    httpJson<{ user_id: number; handle: string; balance_bdt: string; as_of: string }>(
      "GET",
      `/users/${id}/balance`
    ),
  getHistory: (id: number) => httpJson<HistoryResponse>("GET", `/users/${id}/history`),
  getRequests: (id: number) => httpJson<PendingRequest[]>("GET", `/users/${id}/requests`),
  getSavingsGoals: (id: number) => httpJson<SavingsGoal[]>("GET", `/users/${id}/savings-goals`),
  createSavingsGoal: (id: number, body: { festival: string; target_amount_bdt: string }) =>
    httpJson<SavingsGoal>("POST", `/users/${id}/savings-goals`, body),
  contributeSavings: (id: number, goalId: number, body: { amount_bdt: string; idempotency_key: string }) =>
    httpJson<SavingsGoal>("POST", `/users/${id}/savings-goals/${goalId}/contribute`, body),
  listBillers: () =>
    httpJson<{ id: number; name: string; category: string; account_number: string }[]>(
      "GET",
      "/billers"
    ),
  agentAct: (body: { user_id: number; text: string; idempotency_key: string }) =>
    httpJson<AgentActResponse>("POST", "/agent/act", body),
  agentConfirm: (body: {
    user_id: number;
    pending_id: number;
    idempotency_key: string;
    decision: "confirm" | "decline";
  }) => httpJson<AgentConfirmResponse>("POST", "/agent/confirm", body),
  agentChat: (body: { user_id: number; text: string }) =>
    httpJson<{ text: string; action: string }>("POST", "/agent/chat", body),
  payRequest: (requestId: number, idempotencyKey: string) =>
    httpJson<{ success: boolean; new_balance_bdt: string }>(
      "POST",
      `/requests/${requestId}/pay?idempotency_key=${encodeURIComponent(idempotencyKey)}`
    ),
  declineRequest: (requestId: number) =>
    httpJson<{ success: boolean }>("POST", `/requests/${requestId}/decline`),
  transcribe: async (blob: Blob): Promise<string> => {
    const fd = new FormData();
    fd.append("audio", blob, "audio.webm");
    const r = await fetch(`${BASE}/voice/transcribe`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(`transcribe ${r.status}`);
    const j = await r.json();
    return j.text as string;
  },
  getHealth: () => httpJson<{
    ok: boolean;
    ollama_reachable: boolean;
    ollama_url: string;
    openrouter_reachable: boolean;
    openrouter_configured: boolean;
    regex_fallback: boolean;
  }>("GET", "/health"),
  getSettings: () => httpJson<Record<string, unknown>>("GET", "/settings"),
  patchSettings: (patch: Record<string, unknown>) =>
    httpJson<Record<string, unknown>>("PATCH", "/settings", patch),
};