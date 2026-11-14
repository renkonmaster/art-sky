# 技術選定

2026-11-14 時点。バージョンは npm の最新版を確認したもの。

## 全体構成

生成側とギャラリー側は別のアプリにし、PDS 上の作品レコードだけでつなぐ（[lexicon.md](lexicon.md)）。

```
            ┌──────────── generator ────────────┐
Bluesky の投稿 ─Jetstream→ │ ジョブ → Claude → 検証(Chromium) │ → putRecord → 本人の PDS
            └───────────────────────────────────┘                     │
                                                                  Jetstream
            ┌──────────── appview ──────────────┐                     │
web(閲覧) ← │ XRPC API ← 索引(SQLite) ← 購読    │ ←───────────────────┘
            └───────────────────────────────────┘
```

## リポジトリ構成

pnpm workspace のモノレポにする。役割分担は [roles.md](roles.md)、API は [api.md](api.md)。

```
lexicons/              Lexicon JSON（正本）
packages/
  api/                 API と作品レコードのスキーマ（Zod）。フロントエンドとバックエンドで共有する
  renderer/            描画環境 canvas2d v1（作品を動かす iframe 用の HTML を作る）
backend/               ログイン、作品の生成、ギャラリーの索引と API（1 つのサーバーの中でモジュールを分ける。roles.md）
frontend/              画面。開発時はモックでバックエンドなしでも動く
```

`packages/renderer` は、バックエンドの検証とフロントエンドの描画で同じものを使う。

> 以下の「generator」と「appview」は、バックエンドの中の 2 つのモジュール（生成と索引）を指す。

### 試作 SkyMood から引き継いだもの

`backend/` は、空のアートを作る試作 SkyMood（JavaScript + Express）を元にしている。
次のものは TypeScript に移して使い、それ以外（Express の画面、SVG の空の描画、PNG 出力）は使わない。

| SkyMood | 移した先 | 変えたこと |
|---|---|---|
| `fetchPosts.js` | `backend/src/bluesky/posts.ts` | 300 件 → 100 件。返信・引用・リポストを除く（Plan.md 10 節） |
| `stats.js` | `backend/src/features/stats.ts` | PDS に保存できるよう、値をすべて整数にした |
| `analyze.js` | `backend/src/generation/`（Claude の出力の `analysis`） | 描画関数の生成と同じ 1 回の呼び出しで推定する。キーワード辞書による簡易判定はやめた |
| `oauth.js` | `backend/src/auth/oauth.ts` | スコープを `transition:generic` から必要な操作だけに絞った |

## 共通

| 用途 | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript 7 | AT Protocol の公式 SDK が TypeScript |
| 実行環境 | Node.js 26 LTS | 現行の LTS |
| パッケージ管理 | pnpm 12（workspace） | モノレポでパッケージを共有しやすい |
| Lexicon の型生成 | `@atproto/lex-cli` | スキーマから型と検証関数を生成する |
| テスト | Vitest 5 | |
| Lint・整形 | Biome 2 | 1 つのツールで済む |

## generator（生成側）

| 用途 | 選定 | 理由 |
|---|---|---|
| API | Hono 4 + `@hono/node-server` | 軽量で型が強い |
| ログイン | `@atproto/oauth-client-node` | AT Protocol 公式の OAuth クライアント |
| Bluesky API | `@atproto/api` | 投稿とプロフィールの取得、レコード書き込み |
| DB | SQLite（Node.js 標準の `node:sqlite`） | 初期版は 1 台で足りる。ネイティブモジュールのビルドが要らない。表が少ないので ORM は使わず SQL を直接書く |
| ジョブ | SQLite のジョブテーブルをワーカーが取得 | Redis などを増やさずに済む |
| 描画関数の生成 | Claude API（`@anthropic-ai/sdk`、`claude-opus-5-5`） | コード生成の品質が高い |
| 生成結果の検証 | Playwright + ヘッドレス Chromium | ギャラリーと同じブラウザ・同じ renderer で実行できる |

### ログインの権限

OAuth のスコープは必要な操作だけに絞る。

- `repo:com.example.artsky.artwork`（作品レコードの読み書き）

直近 100 件の投稿と総投稿数は公開情報なので、ログインせずに公開 AppView の `app.bsky.feed.getAuthorFeed` と `app.bsky.actor.getProfile` から取得する。

### 投稿の監視

このサイトからは投稿しない。登録済みの人が Bluesky に投稿したら、それをきっかけに作品を作る。

- Jetstream を `app.bsky.feed.post` と登録済みの DID で絞って購読し、新しい投稿ごとに evolution ジョブを作る。
- 返信・引用・リポストは対象外にする。
- カーソルを DB に保存し、停止していた間の投稿も再開時に拾う。

### ジョブ

- ジョブテーブルは元投稿の URI に一意制約をかける。同じ投稿のジョブは 1 つしか作られない。
- 状態は `queued` → `generating` → `validating` → `saving` → `done`、失敗したら `failed`。
- 再試行は `failed` のジョブを `queued` に戻すだけにする。作品のレコードキーは元投稿と同じなので、保存が二重に走っても重複しない。

### Claude API の使い方

- モデルは `claude-opus-5-5`、思考は adaptive、effort は `high` から始めて調整する。
- 構造化出力（`output_config.format`）で `code`、`params`、`title`、`state` を JSON で受け取る。
- 出力が長くなりうるのでストリーミングで受け取る。
- 安全分類器による拒否に備えて、サーバー側フォールバック（`fallbacks: "default"`）を有効にする。
- 投稿履歴を外部 AI に送るため、利用開始時に送信内容と送信先を説明する（Plan.md 10 節）。

### 検証の内容

生成した `code` は、PDS に保存する前に Chromium 上の renderer で実行し、次を確かめる。

1. スキーマに合っている。
2. 例外を出さずに、制限時間内に描画が終わる。
3. 何かが描かれている（キャンバスが空ではない）。
4. 同じ `seed` で 2 回描くと、同じ画像になる。

失敗したときは、エラー内容を添えて Claude に作り直させる（回数に上限を設ける）。

## appview（ギャラリー側）

| 用途 | 選定 | 理由 |
|---|---|---|
| 購読 | Jetstream（Node.js 標準の WebSocket） | `wantedCollections` で作品レコードだけを受け取れる |
| API | Hono 4、Lexicon で定義した XRPC query | 他のクライアントからも使える |
| DB | SQLite（`node:sqlite`） | generator とは別のファイルにする |
| DID の解決 | `@atproto/identity` | DID からハンドル名と PDS を調べる |

- Jetstream のカーソルを DB に保存し、再起動しても続きから受け取る。
- 受け取ったレコードは `packages/lexicon` で検証し、不正なものは索引に入れない。
- 索引が壊れたときは、参加者の PDS から `com.atproto.repo.listRecords` で作り直す。

## web（画面）

| 用途 | 選定 | 理由 |
|---|---|---|
| フレームワーク | React 19 + Vite 8（SPA） | 初期版は SEO や OGP が要らない |
| 作品の描画 | `packages/renderer` の iframe ランナー | 別オリジンに置き、`sandbox="allow-scripts"` と CSP で隔離する |

作品詳細を SNS で共有したときの OGP 画像が必要になったら、SSR かサムネイル配信を追加する。

## 未決定

- ホスティング先。SQLite を置く永続ディスクと、Chromium を動かせる環境が必要。
- サムネイルの保存先（検証時に PNG を作れるので、置き場所だけ決めればよい）。
