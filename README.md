# art-sky

Bluesky の投稿から、その人だけの Generative Art を育てるサービス。

- Bluesky でログインして登録すると、直近 100 件の投稿から最初の作品を作る。AI は使わず、投稿の単語・絵文字・記号と投稿の振る舞い（時間帯、ペース、「!」の多さなど）から描画のパラメーターを推定する（[packages/art](packages/art)）。
- 作品は 1 人 1 枚。画風（流れの線・軌道の多角形）は最初の作品で決まり、以後は投稿のたびに変わる。直近の投稿 1 件ずつが絵に「跡」として足され、投稿の数で全体の流れや軌道も動く。画風の決め方を変えたときだけ、次の投稿で 1 回決め直す。
- Bluesky に投稿すると、その投稿をきっかけに作品が次の姿に変わる（このサイトから投稿する機能はない）。
- 作品は本人の PDS に公開のレコード（キー `self` の 1 件だけ。毎回上書き）として保存し、ギャラリーではそのレコードの描画関数をその場で実行して表示する。

要件は [Plan.md](Plan.md)、設計は [docs/](docs/) にある。

## 動かす

Node.js 26 以上と pnpm が必要。

```sh
pnpm install
pnpm --filter @art-sky/backend exec playwright install chromium   # 生成したコードの検証に使う
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

インターネットに公開するときは、`backend/.env.production` に `PUBLIC_URL`（HTTPS の URL）と `COOKIE_SECRET` を設定する（[backend/.env.example](backend/.env.example)）。`pnpm start` と systemd のサービスだけがこのファイルを読む。

### systemd と ngrok で常駐させる

ngrok の認証を済ませ、割り当てられたドメインを `PUBLIC_URL` に設定してから実行する。

```sh
pnpm build
deploy/install-service.sh --tunnel <ngrok のドメイン>
# 手動起動したサーバーや ngrok がある場合は、先にそのプロセスを終了する。
systemctl --user start art-sky art-sky-tunnel
```

両サービスは systemd 起動時に自動起動し、異常終了時にも再起動する。PC の電源が切れている間やスリープ中、WSL が停止している間は公開できない。Windows 起動時に WSL 自体を起動する設定は別途必要。

```sh
systemctl --user status art-sky art-sky-tunnel
tail -f backend/data/server.log
journalctl --user -u art-sky-tunnel -f
# 停止（自動起動も解除する場合は stop を disable --now に置き換える）
systemctl --user stop art-sky-tunnel art-sky
```

更新時は `pnpm build` のあとに `systemctl --user restart art-sky` を実行する。開発用サーバーも既定では 3000 番ポートを使うため、`pnpm dev` と同時には起動しない。

## 確認

| コマンド | 内容 |
|---|---|
| `pnpm typecheck` | 型チェック |
| `pnpm test` | 単体テスト。backend の API は、frontend と同じスキーマで応答を検証する |
| `pnpm build && pnpm --filter @art-sky/backend e2e` | ビルドした画面と本物の backend をつないで、ブラウザで通しで確かめる |
| `pnpm --filter @art-sky/frontend e2e` | 架空のデータ（モック）で、画面だけを確かめる |
| `pnpm --filter @art-sky/backend try:rules` | 3 つの画風の作品を作り、Chromium の検証に通す |
| `node backend/scripts/migrate-to-self.ts --db <DB> --port <PORT> [--apply]` | 以前の方式（投稿ごとのレコード）の作品を `self` 1 件にまとめ、残りを PDS から消す |
| `playground/art.html` | 推定と描画を試すページ（`playground/` を静的に配信して開く） |

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
