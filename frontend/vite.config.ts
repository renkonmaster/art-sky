import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { mockApi } from "./mock/plugin.ts";

/**
 * 開発サーバーは、既定で本物のバックエンド（http://127.0.0.1:3000）につなぐ。
 * 作品は、バックエンドが Claude で生成して PDS に保存した描画関数をそのまま使う。
 *
 *   pnpm dev                                    本物のバックエンドにつなぐ（backend も起動しておく）
 *   BACKEND_URL=http://example:3000 pnpm dev    別の場所のバックエンドにつなぐ
 *   pnpm dev:mock                               バックエンドなしで、架空のデータ（mock/）で画面だけ動かす
 */
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // モックを使うのは、開発サーバーを MOCK=1 で動かすときだけ。ビルドした画面は必ず本物のバックエンドと使う。
  const useMock = command === "serve" && env.MOCK === "1";
  const backendUrl = useMock ? undefined : env.BACKEND_URL || "http://127.0.0.1:3000";
  const proxy = backendUrl
    ? Object.fromEntries(["/api", "/oauth", "/xrpc"].map((prefix) => [prefix, { target: backendUrl }]))
    : undefined;
  return {
    plugins: [react(), ...(useMock ? [mockApi()] : [])],
    // モックで動いているかどうか。ログイン画面の案内に使う。
    define: { __MOCK__: JSON.stringify(useMock) },
    server: {
      // OAuth のループバッククライアントは 127.0.0.1 を使うので、localhost ではなくこちらで開く。
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      ...(proxy ? { proxy } : {}),
    },
  };
});
