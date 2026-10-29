import { ApiError, type ErrorCode } from "@gem/shared";
import type { Contract, ContractInput, ContractOutput } from "@gem/shared/contracts";

/** An API error as `{ code, params }` (SPEC §1.3); the UI maps the code to `errors:<code>`. */
export class ApiClientError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly params: Record<string, string | number | boolean>,
    readonly status: number,
  ) {
    super(code);
    this.name = "ApiClientError";
  }
}

export const API_BASE = "/api/v1";

export function contractUrl(contract: Contract, input: { params?: unknown; query?: unknown }): string {
  let path = contract.path;
  const params = (input.params ?? {}) as Record<string, string | number>;
  path = path.replace(/:(\w+)/g, (_m, name: string) => encodeURIComponent(String(params[name] ?? "")));
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries((input.query ?? {}) as Record<string, unknown>)) {
    if (v !== undefined && v !== null && v !== "") query.set(k, String(v));
  }
  const qs = query.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * Thin `fetch` wrapper typed by the shared contracts (P0.md §5): `api.call(contract, input)`.
 * Responses are validated with the contract's Zod schema.
 */
async function call<C extends Contract>(
  contract: C,
  ...[input]: keyof ContractInput<C> extends never ? [input?: ContractInput<C>] : [input: ContractInput<C>]
): Promise<ContractOutput<C>> {
  const i = (input ?? {}) as { params?: unknown; query?: unknown; body?: unknown };
  const res = await fetch(contractUrl(contract, i), {
    method: contract.method,
    credentials: "same-origin",
    headers: i.body === undefined ? {} : { "content-type": "application/json" },
    body: i.body === undefined ? undefined : JSON.stringify(i.body),
  });
  if (!res.ok) {
    const parsed = ApiError.safeParse(await res.json().catch(() => null));
    if (parsed.success) throw new ApiClientError(parsed.data.code, parsed.data.params, res.status);
    throw new ApiClientError("internal", {}, res.status);
  }
  if (contract.responseKind === "text") return (await res.text()) as ContractOutput<C>;
  return contract.response.parse(await res.json()) as ContractOutput<C>;
}

export const api = { call };
