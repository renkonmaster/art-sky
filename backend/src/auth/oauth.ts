/**
 * AT Protocol OAuth クライアント。skymood の oauth.js を移植したもの。
 * - publicUrl なし：開発用のループバッククライアント（http://127.0.0.1 で開く）
 * - publicUrl あり：/client-metadata.json を公開する Web クライアント（HTTPS 必須）
 *
 * Node.js と Cloudflare Workers の両方で動くよう、Node.js 専用の部品は使わない。
 *   - ハンドル名の解決：DNS ではなく公開 AppView の XRPC（resolveHandle）
 *   - 鍵・乱数・ハッシュ：WebCrypto（jose）
 * state と session は DB に保存する（db/oauthStores.ts）。保存形式は以前の NodeOAuthClient と同じ。
 */
import { JoseKey } from "@atproto/jwk-jose";
import { OAuthClient } from "@atproto/oauth-client";
import type { Sql } from "../db/database.ts";
import { createOAuthStores } from "../db/oauthStores.ts";
import { ARTWORK_COLLECTION } from "../generation/record.ts";

/** 必要な操作だけに絞る（docs/tech-stack.md「ログインの権限」） */
/** このサイトからは投稿しないので、作品レコードの読み書きだけを求める。 */
export const SCOPE = ["atproto", `repo:${ARTWORK_COLLECTION}`].join(" ");

/** ハンドル名の解決に使う公開 AppView。 */
const HANDLE_RESOLVER = "https://public.api.bsky.app";

/**
 * トークンの更新を同じキーごとに 1 つずつ行うロック。API と定期実行が同じ人のセッションを
 * 同時に更新すると、片方の更新トークンが失効してログインが切れるため。
 *   1. 同じプロセスの中では Promise をつないで順番にする
 *   2. プロセス（Workers のインスタンス）をまたぐ分は、DB の kv テーブルに期限つきの印を置く
 */
export function createRequestLock(db: Sql, { ttlMs = 30_000, waitMs = 15_000 } = {}) {
  const tails = new Map<string, Promise<unknown>>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function withDbLock<T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> {
    const key = `lock:${name}`;
    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = Date.now();
      // 印がないか、期限が切れていれば取る（値は「期限|持ち主」）
      const { changes } = await db.run(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value
         WHERE CAST(substr(kv.value, 1, instr(kv.value, '|') - 1) AS INTEGER) < ?`,
        key,
        `${now + ttlMs}|${token}`,
        now,
      );
      if (changes > 0) break;
      if (now > deadline) throw new Error(`ロックを取れませんでした: ${name}`);
      await sleep(100);
    }
    try {
      return await fn();
    } finally {
      await db.run("DELETE FROM kv WHERE key = ? AND value LIKE ?", key, `%|${token}`);
    }
  }

  return async <T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> => {
    const prev = tails.get(name) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => withDbLock(name, fn));
    tails.set(name, run);
    try {
      return await run;
    } finally {
      if (tails.get(name) === run) tails.delete(name);
    }
  };
}

/** WebCrypto の digest。OAuth クライアントは { name: "sha256" } の形でアルゴリズムを渡す。 */
async function digest(bytes: Uint8Array, algorithm: { name: string }): Promise<Uint8Array> {
  const name = algorithm.name.replace(/^sha(\d+)$/, "SHA-$1");
  return new Uint8Array(await crypto.subtle.digest(name, bytes as Uint8Array<ArrayBuffer>));
}

export function createOAuthClient({ db, publicUrl, port }: { db: Sql; publicUrl?: string; port: number }): OAuthClient {
  const isLoopback = !publicUrl;
  const base = isLoopback ? `http://127.0.0.1:${port}` : publicUrl.replace(/\/$/, "");
  const redirectUri = `${base}/oauth/callback` as const;

  const clientId = isLoopback
    ? `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`
    : `${base}/client-metadata.json`;

  return new OAuthClient({
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
    responseMode: "query",
    handleResolver: HANDLE_RESOLVER,
    ...createOAuthStores(db),
    runtimeImplementation: {
      requestLock: createRequestLock(db),
      createKey: (algs) => JoseKey.generate(algs),
      getRandomValues: (length) => crypto.getRandomValues(new Uint8Array(length)),
      digest,
    },
  });
}
