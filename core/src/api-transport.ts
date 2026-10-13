export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type RequestOptions = Pick<RequestInit, "signal">;

type RequestBehavior = {
  allowNotModified?: boolean;
  /** false never signs the user out on a 401; a function decides from the response body. */
  notifyUnauthorized?: boolean | ((body: string) => boolean);
  /** Overrides the default 30s deadline, for routes the server lets run longer. */
  timeoutMs?: number;
};

export type SearchStream = "local" | "tidal" | `${"local" | "tidal"}_album` | `${"local" | "tidal"}_artist`;
export type SearchOffsets = Partial<Record<SearchStream, number>>;

export type PageParams = {
  limit?: number;
  offset?: number;
  q?: string;
  sort?: "recent" | "title" | "artist" | "album" | "duration";
  searchOffsets?: SearchOffsets;
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

let authGeneration = 0;
export function advanceAuthGeneration(): void { authGeneration += 1; }

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

function abortError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

function abortReason(signal: AbortSignal): unknown {
  // Some runtimes' AbortSignal has no `reason`; theirs gets a plain AbortError.
  return signal.reason instanceof Error ? signal.reason : abortError();
}

/** Settle with `work`, or reject as soon as `signal` aborts. */
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}

/**
 * Single fetch chokepoint for credentials, headers, cancellation, deadlines,
 * unauthorized-session notification, and normalized HTTP errors. The deadline
 * and the caller's abort stay in force until `read` has consumed the
 * response, so a body that stalls after the headers arrive rejects with an
 * AbortError instead of hanging. Form uploads have no deadline (they can be
 * large), only the caller's abort.
 */
export async function fetchAndRead<T>(
  path: string,
  init: RequestInit,
  behavior: RequestBehavior,
  read: (response: Response) => T | Promise<T>,
): Promise<T> {
  const generation = authGeneration;
  const isForm =
    typeof FormData !== "undefined" && init.body instanceof FormData;
  const controller = new AbortController();
  const timer = isForm
    ? undefined
    : setTimeout(() => controller.abort(), behavior.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const callerSignal = init.signal ?? undefined;
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) controller.abort();

  try {
    const response = await fetch(apiUrl(path), {
      ...init,
      signal: controller.signal,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    });
    // Browsers fail an aborted body read by themselves; racing the signal
    // also covers runtimes whose bodies don't.
    return await untilAborted(
      controller.signal,
      (async () => {
        await throwIfFailed(response, behavior, generation);
        return read(response);
      })(),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

async function throwIfFailed(
  response: Response,
  behavior: RequestBehavior,
  generation: number,
): Promise<void> {
  if (response.ok || (behavior.allowNotModified && response.status === 304)) return;
  const text = (await response.text().catch(() => "")).trim();
  const notify = behavior.notifyUnauthorized;
  if (
    response.status === 401 &&
    generation === authGeneration &&
    notify !== false &&
    (typeof notify !== "function" || notify(text))
  ) {
    onUnauthorized?.();
  }
  throw new ApiError(response.status, text || response.statusText);
}

/**
 * `fetchAndRead` that hands back the response once its headers arrive. The
 * deadline and the caller's abort no longer apply to its body, so this is
 * for callers that don't need the body or own its lifetime; anything that
 * reads the body should do it in `fetchAndRead`'s `read`.
 */
export function rawFetch(
  path: string,
  init: RequestInit = {},
  behavior: RequestBehavior = {},
): Promise<Response> {
  return fetchAndRead(path, init, behavior, (response) => response);
}

export async function fetchPage<T>(
  path: string,
  params: PageParams = {},
): Promise<{ items: T[]; total: number }> {
  return fetchAndRead(
    `${path}${buildQuery({ limit: params.limit, offset: params.offset, q: params.q, sort: params.sort })}`,
    { signal: params.signal },
    {},
    async (response) => {
      const items = ((await response.json()) ?? []) as T[];
      const totalHeader = response.headers.get("X-Total-Count");
      const total = totalHeader ? parseInt(totalHeader, 10) : items.length;
      return { items, total: Number.isFinite(total) ? total : items.length };
    },
  );
}

/** Value-returning request for endpoints that promise JSON. */
export async function request<T>(
  path: string,
  init: RequestInit = {},
  behavior: RequestBehavior = {},
): Promise<T> {
  return fetchAndRead(path, init, behavior, (response) => readJson<T>(response));
}

/** Read a JSON body; anything but JSON is an ApiError. */
export async function readJson<T>(response: Response): Promise<T> {
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
  behavior: RequestBehavior = {},
): Promise<void> {
  await rawFetch(path, init, behavior);
}
