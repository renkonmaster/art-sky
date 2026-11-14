# art-sky

Bluesky の投稿から、その人だけの Generative Art を育てるサービス。

- Bluesky でログインして登録すると、直近 100 件の投稿から最初の作品（描画関数）を Claude が生成する。
- 以後は、Bluesky に投稿するたびに、その投稿をきっかけに作品が次の姿に変わる（このサイトから投稿する機能はない）。
- 作品は本人の PDS に公開のレコードとして保存し、ギャラリーではそのレコードの描画関数をその場で実行して表示する。

要件は [Plan.md](Plan.md)、設計は [docs/](docs/) にある。

## 動かす

Node.js 26 以上と pnpm が必要。

```sh
pnpm install
pnpm --filter @art-sky/backend exec playwright install chromium   # 生成したコードの検証に使う
cp backend/.env.example backend/.env                              # ANTHROPIC_API_KEY を書く
pnpm dev
```

<http://127.0.0.1:5173> を開く（`localhost` ではなく `127.0.0.1`。Bluesky のログインがこの形を要求するため）。

`pnpm dev` は次の 2 つを同時に起動する。

| もの | URL | 内容 |
|---|---|---|
| frontend | <http://127.0.0.1:5173> | 画面。API は backend に転送する |
| backend | <http://127.0.0.1:3000> | ログイン、作品の生成、投稿の監視、ギャラリーの索引と API |

ログインして「同意して最初の作品を作る」を押すと、1 分ほどで最初の作品ができる。
そのあと Bluesky（公式アプリなど）で投稿すると、数秒で生成が始まり、作品が増える。
本物の Bluesky アカウントに作品レコードが公開で保存されるので、試すときはテスト用のアカウントを使うとよい。

## 本番と同じ形で動かす

画面をビルドすると、backend がその画面も配る（1 つのサーバーで全部動く）。

```sh
pnpm build
pnpm start      # http://127.0.0.1:3000
```

インターネットに公開するときは、`backend/.env` に `PUBLIC_URL`（HTTPS の URL）と `COOKIE_SECRET` を設定する（[backend/.env.example](backend/.env.example)）。

## 確認

| コマンド | 内容 |
|---|---|
| `pnpm typecheck` | 型チェック |
| `pnpm test` | 単体テスト。backend の API は、frontend と同じスキーマで応答を検証する |
| `pnpm build && pnpm --filter @art-sky/backend e2e` | ビルドした画面と本物の backend をつないで、ブラウザで通しで確かめる |
| `pnpm --filter @art-sky/frontend e2e` | 架空のデータ（モック）で、画面だけを確かめる |
| `pnpm --filter @art-sky/backend try:generate` | Claude で作品を 1 つ生成して `backend/out/` に書き出す（API の料金がかかる） |

## 構成

```
lexicons/              Lexicon（作品レコードとギャラリー API の定義）
packages/api/          API と作品レコードのスキーマ。frontend と backend が同じものを使う
packages/renderer/     描画環境。作品のコードを隔離して動かす。frontend の表示と backend の検証で使う
backend/               ログイン、生成、投稿の監視、索引、API
frontend/              画面
docs/                  設計（役割分担、API、Lexicon、技術選定）
```

バックエンドなしで画面だけ触りたいときは `pnpm dev:mock`（架空の参加者と作品で動く）。
