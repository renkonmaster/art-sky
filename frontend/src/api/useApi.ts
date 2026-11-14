import { useEffect, useState } from "react";

export type Loadable<T> =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "ok"; data: T; error?: undefined }
  | { status: "error"; data?: undefined; error: Error };

/**
 * 非同期の取得を 1 回行う。deps が変わったら取り直し、古い取得は中断する。
 */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: load は deps で管理する
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ok", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", error: error instanceof Error ? error : new Error(String(error)) });
        }
      },
    );
    return () => controller.abort();
  }, deps);
  return state;
}
