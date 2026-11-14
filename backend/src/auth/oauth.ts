/**
 * AT Protocol OAuth クライアント。skymood の oauth.js を移植したもの。
 * - publicUrl なし：開発用のループバッククライアント（http://127.0.0.1 で開く）
 * - publicUrl あり：/client-metadata.json を公開する Web クライアント（HTTPS 必須）
 *
 * TODO: ストアはメモリ上にあり、再起動でログインが切れる。SQLite に移す（docs/tech-stack.md）。
 */
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState } from "@atproto/oauth-client-node";
import { ARTWORK_COLLECTION } from "../generation/record.ts";

/** 必要な操作だけに絞る（docs/tech-stack.md「ログインの権限」） */
export const SCOPE = ["atproto", "repo:app.bsky.feed.post?action=create", `repo:${ARTWORK_COLLECTION}`].join(" ");

function memoryStore<T>() {
  const map = new Map<string, T>();
  return {
    async set(key: string, value: T) {
      map.set(key, value);
    },
    async get(key: string) {
      return map.get(key);
    },
    async del(key: string) {
      map.delete(key);
    },
  };
}

export function createOAuthClient({ publicUrl, port }: { publicUrl?: string; port: number }): NodeOAuthClient {
  const isLoopback = !publicUrl;
  const base = isLoopback ? `http://127.0.0.1:${port}` : publicUrl.replace(/\/$/, "");
  const redirectUri = `${base}/oauth/callback` as const;

  const clientId = isLoopback
    ? `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`
    : `${base}/client-metadata.json`;

  return new NodeOAuthClient({
    clientMetadata: {
      client_id: clientId,
      client_name: "art-sky",
      ...(isLoopback ? {} : { client_uri: base }),
      redirect_uris: [redirectUri],
      scope: SCOPE,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    },
    stateStore: memoryStore<NodeSavedState>(),
    sessionStore: memoryStore<NodeSavedSession>(),
  });
}
