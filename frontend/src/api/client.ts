import { ErrorBody, type RouteName, routes } from "@art-sky/api";
import type { z } from "zod";

type Route<N extends RouteName> = (typeof routes)[N];
type InputOf<R, K extends string> = R extends Record<K, infer S extends z.ZodType> ? z.input<S> : undefined;
type Output<N extends RouteName> = z.output<Route<N>["response"]>;

export interface CallOptions<N extends RouteName> {
  /** パスの中の :id などに入れる値。 */
  params?: Record<string, string>;
  query?: InputOf<Route<N>, "query">;
  body?: InputOf<Route<N>, "body">;
  signal?: AbortSignal;
}

/** API がエラーを返した。code は docs/api.md のエラーコード。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @art-sky/api の routes に載っている API を呼ぶ。
 * レスポンスは同じスキーマで検証するので、バックエンドと形が食い違えばここで気づける。
 */
export async function callApi<N extends RouteName>(name: N, options: CallOptions<N> = {}): Promise<Output<N>> {
  const route: (typeof routes)[RouteName] = routes[name];
  let path: string = route.path;
  for (const [key, value] of Object.entries(options.params ?? {})) {
    path = path.replace(`:${key}`, encodeURIComponent(value));
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries((options.query ?? {}) as Record<string, unknown>)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const url = search.size > 0 ? `${path}?${search}` : path;

  const init: RequestInit = { method: route.method, credentials: "same-origin" };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, init);

  if (!res.ok) {
    const parsed = ErrorBody.safeParse(await res.json().catch(() => null));
    throw new ApiError(
      res.status,
      parsed.success ? parsed.data.error : "InternalError",
      (parsed.success && parsed.data.message) || `リクエストに失敗しました（${res.status}）`,
    );
  }
  return route.response.parse(await res.json()) as Output<N>;
}
