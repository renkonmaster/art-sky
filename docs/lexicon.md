# 作品レコードの仕様

生成側とギャラリー側は、本人の PDS に保存した作品レコードだけを介してつながる。
生成側はレコードを書き、ギャラリー側はレコードを読んで描画する。
両者が直接通信する必要はない。

```
[生成側] --putRecord--> [本人の PDS] --読み取り/Jetstream--> [ギャラリー側]
```

スキーマ: [lexicons/com/example/artsky/artwork.json](../lexicons/com/example/artsky/artwork.json)

> NSID の `com.example.artsky` は仮の名前。運営者が管理するドメインに置き換える。

## レコード

コレクション `com.example.artsky.artwork`、レコードキーは TID。

| フィールド | 必須 | 内容 |
|---|---|---|
| `kind` | ○ | `genesis`（初回）または `evolution`（投稿ごと） |
| `trigger` | evolution で○ | きっかけの投稿（strongRef） |
| `previous` | evolution で○ | 前作品（strongRef） |
| `renderer` | ○ | 描画環境 `{ runtime, version, animated }` |
| `code` | ○ | 描画関数のソース（最大 64KB） |
| `params` |  | 描画関数に渡すパラメータ |
| `seed` | ○ | 乱数シード（0〜2^32-1） |
| `aspectRatio` | ○ | 縦横比 |
| `title` |  | 作品タイトル |
| `generator` | ○ | 生成方式 `{ id, version, model }` |
| `inputs` |  | 入力の要約（投稿件数、期間、生成時点の投稿数などの統計） |
| `state` |  | 次の生成に引き継ぐ状態。描画には使わない |
| `createdAt` | ○ | 生成日時 |

### レコードキーの決め方

- **evolution**：元投稿と同じレコードキー（TID）を使う。
  同じ投稿を何度処理しても同じキーへの `putRecord` になるので、作品は重複しない。
- **genesis**：登録時に新しい TID を発行する。重複防止は生成ジョブ側で行う。

### 入力

- **genesis**：直近 100 件の投稿と、`app.bsky.actor.getProfile` の統計（総投稿数など）から生成する。
- **evolution**：今回の投稿、前作品（`code`、`params`、`state`）、生成時点の統計から生成する。

投稿本文はレコードに保存しない。元の投稿は `trigger` からたどる。

## 描画環境 `canvas2d` バージョン 1

`code` は次の形の ES モジュールとする。

```js
export default function draw(ctx, env) {
  // ctx: CanvasRenderingContext2D
  // env.width, env.height: 描画する画素数（aspectRatio に従う）
  // env.params: レコードの params（なければ {}）
  // env.random(): [0, 1) の疑似乱数。seed から決まる
  // env.frame, env.time: アニメーション用（静止画では 0）
}
```

- **乱数**：`env.random()` は mulberry32 を `seed` で初期化したもの。
  `Math.random` と `Date` は使わない（使うと再現できない）。
- **静止画**（`animated: false`）：`draw` を 1 回だけ呼ぶ。
- **アニメーション**（`animated: true`）：毎フレーム `draw` を呼ぶ。
  `env.frame` は 0 からの連番、`env.time` は開始からの秒数。
- **大きさ**：表示側が画素数を決める。描画関数は `env.width` と `env.height` に対する比率で描く。
- **禁止事項**：外部通信、DOM 操作、`import` は使えない。

### ギャラリー側での実行

PDS には誰でも任意のレコードを書けるので、`code` は信頼できない入力として扱う。

- `sandbox="allow-scripts"` を付けた別オリジンの iframe で実行する（`allow-same-origin` は付けない）。
- iframe には `default-src 'none'` を基本とする CSP をかけ、外部通信を禁止する。
- 表示前にスキーマ検証を行い、不正なレコードは索引に入れない。
- 1 フレームの実行時間に上限を設け、超えたら描画を止める。

描画環境の仕様を変えるときは `version` を上げ、古いバージョンの実装も残す。
