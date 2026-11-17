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

コレクション `com.example.artsky.artwork`、レコードキーは `self`（1 人 1 件）。

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

- 作品は 1 人につき 1 件だけで、レコードキーは常に `self`。genesis も evolution も同じキーへの `putRecord` で上書きする。
  過去の作品は PDS にも残さない。`previous` は上書き前のレコード（URI と CID）を指す。
- 同じ投稿を何度処理しても作り直さない。いまの作品の `trigger` がその投稿なら、生成せずに終える。
- 以前の方式（投稿ごとに TID のキーで作った作品）が残っていれば、次に作品を保存したあとで PDS から削除する。

### 入力

- **genesis**：直近 100 件の投稿と、`app.bsky.actor.getProfile` の統計（総投稿数など）から生成する。
- **evolution**：今回の投稿、前作品（`code`、`params`、`state`）、生成時点の統計から生成する。

投稿本文はレコードに保存しない。元の投稿は `trigger` からたどる。

### 数値は整数だけ

AT Protocol のデータモデルは小数を扱えず、小数を含むレコードは PDS に拒否される。
`params` と `state` の中も含めて、数値はすべて整数にする。
0〜1 の割合は 1000 倍した整数（‰）で表し、描画関数の中で 1000 で割る。
生成側は保存前に小数がないことを確かめ、あれば作り直させる。

### `state` の中身（generator `artsky-claude`）

`state` の形は `generator.id` ごとに決める。`artsky-claude` では次の 2 つのキーを生成側が書き、
それ以外のキーは Claude が次の作品のために自由に書く（パレット、モチーフ、作品数など）。

| キー | 内容 |
|---|---|
| `analysis` | 投稿から推定した感情と個性の傾向。毎回更新する |
| `features` | genesis の時点で直近の投稿から計算した特徴。以後の作品にそのまま引き継ぐ |

`analysis`（値はすべて整数）

| フィールド | 範囲 | 内容 |
|---|---|---|
| `valence` | -1000〜1000 | 不快〜快 |
| `arousal` | 0〜1000 | 落ち着き〜興奮 |
| `dominant` | | 最も強い感情（`mix` のキーのどれか） |
| `mix` | 各 0〜1000、合計 1000 | `joy` `calm` `excitement` `nostalgia` `sadness` `anxiety` `anger` `neutral` の割合 |
| `personality` | 各 0〜1000、500 が平均 | Big Five：`openness` `conscientiousness` `extraversion` `agreeableness` `neuroticism` |

genesis では直近の投稿全体から推定し、evolution では前作品の `analysis` を今回の投稿 1 件の分だけ動かす。

`features`（値はすべて整数、割合は ‰）

| フィールド | 内容 |
|---|---|
| `postsAnalyzed` | 計算に使った投稿の件数 |
| `spanDays` | 最も古い投稿から最も新しい投稿までの日数 |
| `postsPerDayX100` | 1 日あたりの投稿数 × 100 |
| `activity` | 投稿の多さ（1 日 0 件で 0、50 件でおよそ 1000 の対数スケール） |
| `peakMinute` | よく投稿する時刻（その日の何分目か、0〜1439、円周平均） |
| `hourHistogram` | 0〜23 時ごとの投稿数（24 要素） |
| `hourSpread` | 投稿時刻のばらつき（0 なら毎回同じ時間帯） |
| `avgLength` | 本文の平均の長さ |
| `exclaim` `question` `emoji` `media` `link` | 「!」「?」、絵文字、添付、リンクを含む投稿の割合 |
| `avgLikesX100` `maxLikes` | 1 投稿あたりのいいね数 × 100、最大のいいね数 |
| `langCount` | 使われた言語の数 |
| `vocabDiversity` | 語彙の多様さ（文字 2-gram の異なり数 ÷ 延べ数） |

> **公開範囲**：PDS のレコードは誰でも読める。`analysis` には推定した性格の傾向が入るので、
> 初回登録の同意画面で「推定結果が作品と一緒に公開される」ことを説明する（Plan.md 10 節）。

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
