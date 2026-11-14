import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { mockApi } from "./mock/plugin.ts";

/**
 * BACKEND_URL を設定すると本物のバックエンドに転送し、設定しなければモックで動く。
 *   pnpm dev                                   モック
 *   BACKEND_URL=http://127.0.0.1:3000 pnpm dev 本物のバックエンド
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.BACKEND_URL;
  const proxy = backendUrl
    ? Object.fromEntries(["/api", "/oauth", "/xrpc"].map((prefix) => [prefix, { target: backendUrl }]))
    : undefined;
  return {
    plugins: [react(), ...(backendUrl ? [] : [mockApi()])],
    // モックで動いているかどうか。ログイン画面の案内に使う。
    define: { __MOCK__: JSON.stringify(!backendUrl) },
    server: {
      // OAuth のループバッククライアントは 127.0.0.1 を使うので、localhost ではなくこちらで開く。
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      ...(proxy ? { proxy } : {}),
    },
  };
});
