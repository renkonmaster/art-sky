# backend

ログイン、Bluesky と PDS への読み書き、作品の生成、ギャラリー用の索引を受け持つ。
役割と API は [docs/roles.md](../docs/roles.md)、技術選定は [docs/tech-stack.md](../docs/tech-stack.md)、
作品レコードの形式は [docs/lexicon.md](../docs/lexicon.md) を参照。

## 流れ

```
初回登録：直近 100 件の投稿（返信・引用・リポストを除く）とプロフィール統計を取得
        → 投稿の特徴を計算（features/stats.ts）
        → Claude が感情・個性を推定し、描画関数を生成（generation/claude.ts）
        → Chromium で実行して検証（validation/chromium.ts）
        → 本人の PDS に com.example.artsky.artwork を保存（genesis）→ ギャラリーの索引に入れる

投稿時  ：登録済みの人が Bluesky に投稿する（このサイトに投稿機能はない）
        → Jetstream でその投稿を見つけ、ジョブを作る（jetstream/consumer.ts）
        → 今回の投稿 1 件と前作品（code・params・state）から次の作品を生成（evolution）
        → 検証 → PDS に保存（レコードキーは元の投稿と同じ）→ 索引に入れる
```

推定結果（`state.analysis`）と投稿の特徴（`state.features`）は作品レコードに入れて引き継ぐ。
PDS のレコードは公開されるので、推定結果も公開される（初回登録の同意画面で説明している）。

## ファイル構成

| パス | 役割 |
|---|---|
| `src/server.ts` | 起動。API、ワーカー、投稿の監視を 1 つのプロセスで動かす。ビルドした画面があれば配る |
| `src/api/app.ts` | `/oauth/*`、`/api/*`、`/xrpc/*`（[docs/api.md](../docs/api.md)）。形は `@art-sky/api` のスキーマに従う |
| `src/auth/oauth.ts` | AT Protocol OAuth クライアント。求める権限は作品レコードの読み書きだけ |
| `src/jetstream/consumer.ts` | Bluesky の投稿と作品レコードの変更を Jetstream で受け取る |
| `src/jobs/` | 生成ジョブの状態管理、実行、ワーカー |
| `src/generation/` | プロンプト、Claude 呼び出し、出力の検査、レコードの組み立て |
| `src/validation/chromium.ts` | 生成した `code` を Chromium で実行して確かめる |
| `src/gallery/` | ギャラリーの索引（PDS の写し）と、PDS からの読み直し |
| `src/bluesky/posts.ts` | プロフィール統計と直近の投稿の取得 |
| `src/features/stats.ts` | 投稿の量・時間帯・文体の特徴（すべて整数） |
| `src/users.ts`、`src/db/` | 参加者・同意・設定、SQLite のスキーマ、OAuth のストア |

## ギャラリーの索引

作品の正本は本人の PDS にあり、索引（`artworks` テーブル）はその写し。次の 3 つの経路で入る。

1. 生成ジョブが PDS に保存した直後
2. Jetstream で作品レコードの作成・更新・削除を受け取ったとき（PDS で直接消された作品も消える）
3. ログイン時に、その人の PDS から作品の一覧を読み直したとき（索引が欠けても、これで元に戻る）

どの経路でも、入れる前に `@art-sky/api` の `ArtworkRecord` で検証する。

## 開発

```bash
pnpm install
pnpm exec playwright install chromium   # 検証用のブラウザ
cp .env.example .env                    # ANTHROPIC_API_KEY を設定
pnpm dev                                # http://127.0.0.1:3000 で API、ワーカー、投稿の監視を起動
pnpm test                               # ネット不要（Chromium の検証テストは、Chromium があれば実行する）
pnpm typecheck
pnpm e2e                                # ビルドした画面とつないでブラウザで確かめる（先に直下で pnpm build）
pnpm try:generate                       # fixtures/ の投稿で作品を 1 つ生成して out/ に書き出す（Claude API の料金がかかる）
```

画面も一緒に動かすときは、リポジトリの直下で `pnpm dev`（[README.md](../README.md)）。
ローカルでログインを試すときは、`localhost` ではなく `http://127.0.0.1:5173` で開く
（ループバッククライアントの戻り先が一致しないため）。
