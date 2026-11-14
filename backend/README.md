# backend

ログイン、Bluesky と PDS への読み書き、作品の生成、ギャラリー用の索引を受け持つ。
役割と API は [docs/roles.md](../docs/roles.md)、技術選定は [docs/tech-stack.md](../docs/tech-stack.md)、
作品レコードの形式は [docs/lexicon.md](../docs/lexicon.md) を参照。

## 生成の流れ

```
初回登録：直近 100 件の投稿（返信・引用・リポストを除く）とプロフィール統計を取得
        → 投稿の特徴を計算（features/stats.ts）
        → Claude が感情・個性を推定し、描画関数を生成（generation/claude.ts）
        → 検証 → 本人の PDS に com.example.artsky.artwork を保存（genesis）

投稿時  ：今回の投稿 1 件と前作品（code・params・state）から次の作品を生成（evolution）
```

推定結果（`state.analysis`）と投稿の特徴（`state.features`）は作品レコードに入れて引き継ぐ。
PDS のレコードは公開されるので、推定結果も公開される。

## ファイル構成

| パス | 役割 | 状態 |
|---|---|---|
| `src/config.ts` | Claude API の設定（モデル、effort） | ✓ |
| `src/bluesky/posts.ts` | プロフィール統計と直近の投稿の取得 | ✓ |
| `src/features/stats.ts` | 投稿の量・時間帯・文体の特徴（すべて整数） | ✓ |
| `src/generation/` | プロンプト、Claude 呼び出し、出力の検査、レコードの組み立て | ✓ |
| `src/auth/oauth.ts` | AT Protocol OAuth クライアント（state と session は SQLite） | ✓ |
| `src/db/` | SQLite のスキーマ、OAuth のストア | ✓ |
| `src/users.ts` | 参加者、同意、設定 | ✓ |
| `src/api/app.ts` | `/oauth/*`、`/api/*`（roles.md） | ✓ |
| `src/jobs/` | 生成ジョブの状態管理、実行、ワーカー | ✓ |
| `src/server.ts` | API とワーカーの起動 | ✓ |
| 検証（Chromium） | 生成した `code` を実行して確かめる | 未着手（今は形式の検査だけ） |
| 索引（Jetstream） | ギャラリー用の索引と XRPC | 未着手 |

## 開発

```bash
pnpm install
cp .env.example .env   # ANTHROPIC_API_KEY などを設定
pnpm dev               # http://127.0.0.1:3000 で API とワーカーを起動
pnpm test              # ネット不要
pnpm typecheck
pnpm try:generate      # fixtures/ の投稿で作品を 1 つ生成して out/ に書き出す（Claude API の料金がかかる）
```

ローカルでログインを試すときは、`localhost` ではなく `http://127.0.0.1:3000` で開く
（ループバッククライアントの戻り先が一致しないため）。
