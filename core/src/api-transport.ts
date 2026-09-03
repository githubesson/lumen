export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type RequestOptions = Pick<RequestInit, "signal">;

type RequestBehavior = {
  notifyUnauthorized?: boolean;
};

export type PageParams = {
  limit?: number;
  offset?: number;
  q?: string;
  signal?: AbortSignal;
};

/**
 * Base URL prepended to every request and media URL. Empty on web (same-origin
 * via Vite proxy or Electron). Absolute on mobile (e.g. "https://host.tld").
 */
let baseUrl = "";

export function setBaseUrl(value: string): void {
  baseUrl = value.replace(/\/+$/, "");
}

export function getBaseUrl(): string {
  return baseUrl;
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl}${path}`;
}

/** Return whether a URL points at the configured API origin. */
export function isApiOrigin(rawUrl: string): boolean {
  if (!/^https?:\/\//i.test(rawUrl)) return true;
  if (!baseUrl) return false;
  try {
    return new URL(rawUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler | null = null;

/** Register the central handler invoked when an authenticated request is rejected. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

/** Build a query string while preserving meaningful zero and false values. */
export function buildQuery(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const serialized = qs.toString();
  return serialized ? `?${serialized}` : "";
}

/**
 * Single fetch chokepoint for credentials, headers, cancellation, deadlines,
 * unauthorized-session notification, and normalized HTTP errors.
 */
export async function rawFetch(
  path: string,
  init: RequestInit = {},
  behavior: RequestBehavior = {},
): Promise<Response> {
  const isForm =
    typeof FormData !== "undefined" && init.body instanceof FormData;
  const timeout = new AbortController();
  const timer = isForm
    ? undefined
    : setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const callerSignal = init.signal ?? undefined;
  const onCallerAbort = () => timeout.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) timeout.abort();

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      signal: timeout.signal,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }

  if (!response.ok) {
    if (response.status === 401 && behavior.notifyUnauthorized !== false) {
      onUnauthorized?.();
    }
    const text = await response.text().catch(() => "");
    throw new ApiError(
      response.status,
      text.trim() || response.statusText,
    );
  }
  return response;
}

export async function fetchPage<T>(
  path: string,
  params: PageParams = {},
): Promise<{ items: T[]; total: number }> {
  const response = await rawFetch(
    `${path}${buildQuery({ limit: params.limit, offset: params.offset, q: params.q })}`,
    { signal: params.signal },
  );
  const items = ((await response.json()) ?? []) as T[];
  const totalHeader = response.headers.get("X-Total-Count");
  const total = totalHeader ? parseInt(totalHeader, 10) : items.length;
  return { items, total: Number.isFinite(total) ? total : items.length };
}

/** Value-returning request for endpoints that promise JSON. */
export async function request<T>(
  path: string,
  init: RequestInit = {},
  behavior: RequestBehavior = {},
): Promise<T> {
  const response = await rawFetch(path, init, behavior);
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 204 || !contentType.includes("application/json")) {
    throw new ApiError(
      response.status,
      "Unexpected non-JSON response from the server.",
    );
  }
  return (await response.json()) as T;
}

/** Request for endpoints that intentionally return no response body. */
export async function requestVoid(
  path: string,
  init: RequestInit = {},
): Promise<void> {
  await rawFetch(path, init);
}
