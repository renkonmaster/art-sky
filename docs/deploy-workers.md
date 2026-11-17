# Cloudflare Workers へのデプロイ

art-sky は Cloudflare Workers の無料プランだけで動かせる。

| 使うもの | 役割 |
|---|---|
| Workers | API、XRPC、OAuth（`backend/src/cloudflare.ts`） |
| Static Assets | 画面（`frontend/dist`） |
| D1 | 参加者、ジョブ、ギャラリーの索引、ログイン情報（SQLite） |
| Cron Trigger | 1 分ごとに Jetstream から投稿を取り込み、ジョブを処理する（`backend/src/cron.ts`） |

設定は `backend/wrangler.toml` にある。

## ローカルで動かす（アカウント不要）

```sh
pnpm build                          # リポジトリの直下で。frontend/dist を作る
cd backend
echo "COOKIE_SECRET=$(openssl rand -hex 32)" > .dev.vars   # 初回だけ（.dev.vars は git に入れない）
pnpm cf:dev                         # ローカルの D1 にスキーマを入れて、http://127.0.0.1:8787 で起動
```

- ローカルでは `PUBLIC_URL` を空にしておく。OAuth は開発用のループバッククライアント（`http://127.0.0.1:8787`）になる。
- Cron を手で動かすには、次を実行する。

  ```sh
  curl -X POST "http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=art-sky" \
    -H 'Content-Type: application/json' -d '{"cron":"* * * * *"}'
  ```

## デプロイする

```sh
cd backend
pnpm exec wrangler login                 # ブラウザで Cloudflare にログインする
pnpm exec wrangler d1 create art-sky     # 表示された database_id を wrangler.toml に書く
```

`wrangler.toml` の `[vars]` に `PUBLIC_URL` を書く。値は `https://art-sky.<アカウントのサブドメイン>.workers.dev` か独自ドメイン。OAuth のクライアント ID（`/client-metadata.json`）に使うので、HTTPS で公開する URL にする。

```sh
pnpm exec wrangler secret put COOKIE_SECRET   # 16 文字以上のランダムな文字列を入力する
(cd .. && pnpm build)                         # 画面をビルドする（frontend/dist）
pnpm cf:deploy                                # D1 のスキーマを適用してからデプロイする
```

## 今のサーバー（Node.js）のデータについて

移さなくてよい。

- ログイン情報（OAuth のセッション）は、発行したときのクライアント ID（公開 URL の `/client-metadata.json`）に結びついている。
  公開 URL が変われば以前のセッションは使えないので、参加者は新しい URL でログインし直す。
- 作品の正本は各人の PDS にある。ログインし直したときに、PDS から索引が作り直される。
- 参加者の登録（同意）は D1 には残っていないので、初回登録の画面がもう一度出る。
  初回登録は `self` の作品を上書きするだけなので、作品が増えることはない。

## 無料プランの制限との関係

| 制限 | art-sky での使い方 |
|---|---|
| CPU 時間 1 回 10ms | 最初の作品の生成（直近 100 件の推定）が約 3.5ms、投稿 1 件ぶんの更新は 0.1ms 未満 |
| D1 の書き込み 1 日 10 万行 | 投稿 1 件で約 20 行、Cron のカーソル保存で 1 日 1,440 行。参加者 100 人で 1 割強 |
| 外部へのリクエスト 1 回 50 件 | Cron 1 回で Jetstream 1 件と、ジョブ 1 件あたり数件。1 回に処理するジョブは 5 件まで |

## Node.js 版との違い

- 作品を Chromium で確かめる検証はしない。描画モジュールは全員共通の固定コードで、`pnpm try:rules` とテストで確かめている。
- 登録・再試行の直後のジョブは、応答を返したあとに `waitUntil` で 1 件だけ処理する。残りは次の Cron で処理する。
- Workers は `Request` の `redirect: "error"` に対応していないので、入口で `"manual"` に読み替えている（`cloudflare.ts` の冒頭）。
