import type { LunkrApiEnvelope } from "./contracts.js";

export interface HttpResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly setCookies: readonly string[];
}

export class SecureHttpClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly timeoutMs = 30_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "https:") {
      throw new Error("Lunkr HTTP 客户端只允许 HTTPS");
    }
  }

  async json<T = unknown>(options: {
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly query?: Readonly<Record<string, string | undefined>>;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<HttpResponse<T>> {
    const url = new URL(options.path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const response = await this.fetchImpl(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        Accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "text/x-json; charset=UTF-8" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal,
    });
    const text = await response.text();
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      throw new Error(`Lunkr HTTP 返回了非 JSON 响应（status=${response.status}）`);
    }
    return {
      status: response.status,
      body,
      setCookies: getSetCookies(response.headers),
    };
  }

  async lunkr<T = unknown>(options: {
    readonly apiPath: string;
    readonly func: string;
    readonly sid?: string;
    readonly uid?: string;
    readonly cookie?: string;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method?: "GET" | "POST";
  }): Promise<HttpResponse<LunkrApiEnvelope<T>>> {
    return this.json<LunkrApiEnvelope<T>>({
      path: options.apiPath,
      ...(options.method === undefined ? {} : { method: options.method }),
      query: {
        func: options.func,
        sid: options.sid,
        uid: options.uid,
      },
      ...(options.method === "GET"
        ? {}
        : { body: options.body ?? {} }),
      headers: {
        ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
        ...options.headers,
      },
    });
  }
}

function getSetCookies(headers: Headers): readonly string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.();
  if (values && values.length > 0) return values;
  const single = headers.get("set-cookie");
  return single === null ? [] : [single];
}
