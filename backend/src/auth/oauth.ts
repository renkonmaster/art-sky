/**
 * AT Protocol OAuth クライアント。skymood の oauth.js を移植したもの。
 * - publicUrl なし：開発用のループバッククライアント（http://127.0.0.1 で開く）
 * - publicUrl あり：/client-metadata.json を公開する Web クライアント（HTTPS 必須）
 *
 * state と session は SQLite に保存する（db/oauthStores.ts）。
 */
import { NodeOAuthClient } from "@atproto/oauth-client-node";
import type { Database } from "../db/database.ts";
import { createOAuthStores } from "../db/oauthStores.ts";
import { ARTWORK_COLLECTION } from "../generation/record.ts";

/** 必要な操作だけに絞る（docs/tech-stack.md「ログインの権限」） */
export const SCOPE = ["atproto", "repo:app.bsky.feed.post?action=create", `repo:${ARTWORK_COLLECTION}`].join(" ");

/**
 * トークンの更新を同じキーごとに 1 つずつ行うロック。API とワーカーが同じ人のセッションを
 * 同時に更新すると、片方の更新トークンが失効してログインが切れるため。
 * 1 プロセスで動かす前提。複数台にするときは DB などを使ったロックに替える。
 */
function createInProcessLock() {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> => {
    const prev = tails.get(name) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    tails.set(name, run);
    try {
      return await run;
    } finally {
      if (tails.get(name) === run) tails.delete(name);
    }
  };
}

export function createOAuthClient({ db, publicUrl, port }: { db: Database; publicUrl?: string; port: number }): NodeOAuthClient {
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
    ...createOAuthStores(db),
    requestLock: createInProcessLock(),
  });
}
