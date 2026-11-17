# 技術選定

2026-11-14 時点（生成方式は 2026-11-17 に更新）。バージョンは npm の最新版を確認したもの。

作品の生成に AI は使わない。投稿から規則で状態を推定し（`packages/art` の estimate.js）、
全員共通の描画モジュール（draw.js）と組にして作品にする。作品は PDS に 1 人 1 件（レコードキー `self`）だけ保存する。

## 全体構成

生成側とギャラリー側は別のアプリにし、PDS 上の作品レコードだけでつなぐ（[lexicon.md](lexicon.md)）。

```
            ┌──────────── generator ────────────┐
Bluesky の投稿 ─Jetstream→ │ ジョブ → 推定 → 検証(Chromium)   │ → putRecord → 本人の PDS
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
  art/                 投稿からの推定（estimate.js）と共通の描画モジュール（draw.js）
backend/               ログイン、作品の生成、ギャラリーの索引と API（1 つのサーバーの中でモジュールを分ける。roles.md）
frontend/              画面。開発時はモックでバックエンドなしでも動く
```

`packages/renderer` は、バックエンドの検証とフロントエンドの描画で同じものを使う。
`packages/api` のスキーマは、フロントエンドの API クライアントとバックエンドの応答の両方で使う。
バックエンドのテストは応答をこのスキーマで検証するので、形が食い違えばテストで分かる。

> 以下の「generator」と「appview」は、バックエンドの中の 2 つのモジュール（生成と索引）を指す。

### 試作 SkyMood から引き継いだもの

`backend/` は、空のアートを作る試作 SkyMood（JavaScript + Express）を元にしている。
次のものは TypeScript に移して使い、それ以外（Express の画面、SVG の空の描画、PNG 出力）は使わない。

| SkyMood | 移した先 | 変えたこと |
|---|---|---|
| `fetchPosts.js` | `backend/src/bluesky/posts.ts` | 300 件 → 100 件。返信・引用・リポストを除く（Plan.md 10 節） |
| `stats.js` | `backend/src/features/stats.ts` | PDS に保存できるよう、値をすべて整数にした |
| `analyze.js` | `packages/art/src/estimate.js` | キーワード辞書による判定を作り直した（日本語・英語、否定、強調、絵文字、顔文字） |
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
| ログイン | `@atproto/oauth-client`（＋ `@atproto/jwk-jose`） | AT Protocol 公式の OAuth クライアント。Node.js 専用版（oauth-client-node）は DNS と node:crypto を使うので、Workers でも動くよう汎用版を WebCrypto と XRPC のハンドル解決で使う。トークン更新のロックは DB に置く |
| Bluesky API | `@atproto/api` | 投稿とプロフィールの取得、レコード書き込み |
| DB | SQLite（Node.js では `node:sqlite`、Cloudflare Workers では D1） | リポジトリは非同期の `Sql`（get / all / run）だけを使うので、同じ SQL がどちらでも動く（`backend/src/db/`）。表が少ないので ORM は使わず SQL を直接書く。D1 のスキーマは `backend/migrations/` |
| ジョブ | SQLite のジョブテーブルを定期実行（1 分ごと）で処理 | Redis などを増やさずに済む。Cloudflare Workers の Cron でも同じ形で動く |
| 作品の生成 | 規則による推定（`@art-sky/art`） | 外部 API に投稿を送らず、費用もかからない。同じ入力からは同じ作品になる |
| 生成結果の検証 | Playwright + ヘッドレス Chromium | ギャラリーと同じブラウザ・同じ renderer で実行できる |

### ログインの権限

OAuth のスコープは必要な操作だけに絞る。

- `repo:com.example.artsky.artwork`（作品レコードの読み書き）

直近 100 件の投稿と総投稿数は公開情報なので、ログインせずに公開 AppView の `app.bsky.feed.getAuthorFeed` と `app.bsky.actor.getProfile` から取得する。

### 投稿の監視

このサイトからは投稿しない。登録済みの人が Bluesky に投稿したら、それをきっかけに作品を作る。

- 接続はつなぎっぱなしにしない。1 分ごとの定期実行で Jetstream に短くつなぎ、前回のカーソルの続きから今までの分を受け取って切断する（`backend/src/jetstream/consumer.ts` の `pullOnce`）。
- 購読は `app.bsky.feed.post` と作品のコレクション、登録済みの DID で絞り、新しい投稿ごとに evolution ジョブを作る。
- 返信・引用・リポストは対象外にする。
- カーソルを DB に保存する。Jetstream がさかのぼれるのはおよそ 1 日分なので、カーソルが 20 時間より古ければ、各人の直近の投稿を公開 AppView から取り直す。
- ジョブは 1 回の定期実行で件数と時間に上限を決めて処理し、残りは次回に回す。登録と再試行の直後は、定期実行を待たずに処理する。

### ジョブ

- ジョブテーブルは元投稿の URI に一意制約をかける。同じ投稿のジョブは 1 つしか作られない。
- 状態は `queued` → `generating` → `validating` → `saving` → `done`、失敗したら `failed`。
- 再試行は `failed` のジョブを `queued` に戻すだけにする。作品は `self` を上書きし、前作品の元投稿が同じならジョブを飛ばすので、保存が二重に走っても重複しない。

### 生成のしかた

- genesis：直近の投稿から感情の割合、投稿の多さ、時間帯、「!」や絵文字の割合を推定する。画風（`lines` `poly` `orbit`）もここで決め、以後は変えない。
- evolution：前作品の `params` を、新しい投稿 1 件の分だけ少し動かす。
- 乱数のシードは DID から作るので、同じ人の作品は同じ骨格を保ったまま変化する。

### 検証の内容

生成した `code` は、PDS に保存する前に Chromium 上の renderer で実行し、次を確かめる。

1. スキーマに合っている。
2. 例外を出さずに、制限時間内に描画が終わる。
3. 何かが描かれている（キャンバスが空ではない）。
4. 同じ `seed` で 2 回描くと、同じ画像になる。

失敗したときはジョブを `failed` にする（描画モジュールは共通なので、ふつうは失敗しない）。

## appview（ギャラリー側）

| 用途 | 選定 | 理由 |
|---|---|---|
| 購読 | Jetstream（Node.js 標準の WebSocket） | `wantedCollections` で作品レコードだけを受け取れる |
| API | Hono 4、Lexicon で定義した XRPC query | 他のクライアントからも使える |
| DB | 生成側と同じ DB（`artworks` テーブル） | 1 つのサーバーの中でモジュールを分けている |
| DID の解決 | `@atproto/identity` | DID からハンドル名と PDS を調べる |

- Jetstream のカーソルを DB に保存し、次の定期実行で続きから受け取る。
- 受け取ったレコードは `packages/lexicon` で検証し、不正なものは索引に入れない。
- 索引が壊れたときは、参加者の PDS から `com.atproto.repo.listRecords` で作り直す。

## web（画面）

| 用途 | 選定 | 理由 |
|---|---|---|
| フレームワーク | React 19 + Vite 8（SPA） | 初期版は SEO や OGP が要らない |
| 作品の描画 | `packages/renderer` の iframe ランナー | 別オリジンに置き、`sandbox="allow-scripts"` と CSP で隔離する |

作品詳細を SNS で共有したときの OGP 画像が必要になったら、SSR かサムネイル配信を追加する。

## 公開先

Cloudflare Workers の無料プラン（Workers ＋ Static Assets ＋ D1 ＋ Cron）。手順は [deploy-workers.md](deploy-workers.md)。
Node.js のサーバー（`backend/src/server.ts`）でも同じ部品で動く。

## 未決定

- サムネイルの保存先（OGP 画像が必要になったら決める。Workers では Chromium で PNG を作れないので、画面側で描いたものを保存するなど）。
