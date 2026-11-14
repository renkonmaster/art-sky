# API 仕様

## 定義の置き場所

| API | 正本 | TypeScript から使うもの |
|---|---|---|
| ギャラリー（ログイン不要） | [lexicons/com/example/artsky/gallery/](../lexicons/com/example/artsky/gallery/) | [packages/api/src/gallery.ts](../packages/api/src/gallery.ts) |
| 内部 API（ログインあり） | [packages/api/src/app.ts](../packages/api/src/app.ts) | 同左 |
| エンドポイント一覧 | [packages/api/src/routes.ts](../packages/api/src/routes.ts) | 同左 |
| 作品レコード | [lexicons/com/example/artsky/artwork.json](../lexicons/com/example/artsky/artwork.json) | [packages/api/src/artwork.ts](../packages/api/src/artwork.ts) |

- フロントエンドとバックエンドは `@art-sky/api` を読み込み、同じスキーマでリクエストとレスポンスを検証する。
- Lexicon と Zod スキーマが食い違っていないかは、`packages/api` のテストで確かめる。
- 項目の詳細はスキーマのコメントを正とし、この文書には決まりごとと一覧だけを書く。

## 共通の決まり

### エラー

失敗したときは、下の形の JSON を返す（XRPC のエラー形式と同じ）。

```json
{ "error": "NotFound", "message": "作品が見つかりません" }
```

| error | ステータス | 意味 |
|---|---|---|
| `InvalidRequest` | 400 | リクエストがスキーマに合わない |
| `AuthRequired` | 401 | ログインが必要、またはセッション切れ |
| `NotFound` | 404 | 対象がない、または自分のものではない |
| `ActorNotFound` | 404 | 参加者が見つからない、または掲載していない |
| `AlreadyRegistered` | 409 | 初回登録は済んでいる |
| `NotRegistered` | 409 | 初回登録がまだ |
| `JobNotRetryable` | 409 | 再試行できない状態のジョブ |
| `RateLimited` | 429 | 回数制限に達した |
| `InternalError` | 500 | サーバー内部のエラー |
| `UpstreamError` | 502 | Bluesky や PDS が一時的に使えない |

### 一覧

- `limit` は 1〜100（既定 30）。
- 続きがあるときはレスポンスに `cursor` が入る。次のリクエストにそのまま渡す。中身に意味はない。

### 日時

ISO 8601 の文字列（例：`2026-11-14T07:31:00.000Z`）。

## 認証（画面遷移）

ブラウザのページ移動で使い、JSON は返さない。

| メソッド | パス | 動き |
|---|---|---|
| GET | `/oauth/login?handle=&returnTo=` | Bluesky の認可画面へリダイレクトする |
| GET | `/oauth/callback` | セッション Cookie を発行し、`returnTo` へリダイレクトする |
| POST | `/oauth/logout` | セッションを消して 204 を返す |

- `returnTo` は `/` で始まるサイト内のパスだけ受け付ける（既定は `/`）。
- ログインに失敗したら `/login?error=<理由>` へリダイレクトする。理由は `invalid_handle`（ハンドル名が見つからない）、`access_denied`（許可が取り消された）、`failed`（その他）。
- 求める権限は、作品レコード（`com.example.artsky.artwork`）の読み書きだけ。投稿の権限は求めない。
- セッション Cookie は HttpOnly、SameSite=Lax。

## 内部 API

| メソッド | パス | ログイン | 成功時 | 内容 |
|---|---|---|---|---|
| GET | `/api/me` | 不要 | 200 | ログイン中のユーザー。ログインしていなければ `{ "user": null }` |
| POST | `/api/register` | 必要 | 202 | 初回登録し、最初の作品の生成ジョブを返す |
| GET | `/api/jobs` | 必要 | 200 | 自分のジョブ一覧（新しい順、`status` で絞り込める） |
| GET | `/api/jobs/:id` | 必要 | 200 | ジョブ 1 件 |
| POST | `/api/jobs/:id/retry` | 必要 | 202 | 失敗したジョブを再試行する |
| GET | `/api/settings` | 必要 | 200 | 設定 |
| PATCH | `/api/settings` | 必要 | 200 | 送った項目だけ設定を変える |

### 初回登録

- 投稿履歴を外部 AI（Claude）に送り、推定結果（感情や性格の傾向）が作品と一緒に公開されるため、`consent.externalAi: true` がないと受け付けない。
- 直近 100 件の投稿と、総投稿数などの統計を取得して genesis ジョブを作る。
- 登録済みなら 409 `AlreadyRegistered`。最初の作品の生成に失敗した場合は、登録し直すのではなくジョブを再試行する。

### 作品が変化するきっかけ

このサイトに投稿する機能はない。利用者は Bluesky（公式アプリなど）でふつうに投稿する。
バックエンドは登録済みの人の新しい投稿を Jetstream で見つけ、evolution ジョブを自動で作る。

- 対象は本人の通常のテキスト投稿（返信・引用・リポストは対象外）。
- 生成を停止している間の投稿では、ジョブを作らない。
- ジョブは元投稿の URI ごとに 1 つだけ作る。同じ投稿を二度見つけても重複しない。

### ジョブ

- 状態は `queued` → `generating` → `validating` → `saving` → `done`。失敗したら `failed`。
- 同じユーザーのジョブは作成順に 1 つずつ処理する（evolution は前の作品が必要なため）。
- 失敗したら `error.code` に理由が入る。`error.retryable` が true のときだけ再試行できる。
  - `auth_expired` は再ログインしてから再試行する。
  - `refusal` と `invalid_output` は、再試行で直ることもあるが、繰り返し失敗することもある。
- フロントエンドは `done` か `failed` になるまで、`GET /api/jobs/:id` を 2 秒ごとに呼ぶ。

## ギャラリー API（XRPC）

| パス | 内容 |
|---|---|
| `GET /xrpc/com.example.artsky.gallery.listLatest?limit=&cursor=` | 掲載中の参加者ごとに最新作品 1 件（更新が新しい順） |
| `GET /xrpc/com.example.artsky.gallery.listByActor?actor=&limit=&cursor=` | 1 人の作品（新しい順）と作者情報 |
| `GET /xrpc/com.example.artsky.gallery.getArtwork?uri=` | 作品 1 件と、前後の作品の URI |

- `actor` には DID とハンドル名のどちらでも指定できる。
- 掲載をやめた人の作品は返さない（`ActorNotFound` または `NotFound`）。
- 作品は `artworkView.record` にレコードそのもの（`code`、`params`、`seed` など）が入る。
  フロントエンドは `ArtworkRecord` で検証してから描画する。
- 一覧にもコードが入るので、1 件あたり最大 64KB になる。サムネイルを用意したら、一覧ではサムネイルを返すように変える。
