/**
 * 本物のバックエンドと、ビルドしたフロントエンドをつないで、ブラウザで通しで確かめる。
 *
 *   pnpm build            （リポジトリの直下で。frontend/dist を作る）
 *   pnpm --filter @art-sky/backend e2e [スクリーンショットの出力先]
 *
 * 外部サービス（Bluesky の認可、Jetstream）は使わない。代わりに、
 *   - DB に参加者と作品を入れておく。作品は、生成器（generation/rules.ts）で作ったレコード
 *     （fixtures/generated-artwork.json）を使う
 *   - ログイン済みの Cookie をこのスクリプトで作る（本物と同じ署名）
 * 生成ジョブは OAuth のセッションがないので失敗するが、その失敗が画面に正しく出ることを確かめる。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { chromium, type Page } from "playwright";
import { openDatabase } from "../src/db/database.ts";
import { createGalleryIndex } from "../src/gallery/index.ts";
import { createJobRepository } from "../src/jobs/repository.ts";
import { createUserRepository } from "../src/users.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`確認に失敗: ${message}`);
}

if (!existsSync(path.join(root, "frontend/dist/index.html"))) {
  console.error("frontend/dist がありません。先にリポジトリの直下で pnpm build を実行してください。");
  process.exit(1);
}

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "e2e-secret-0123456789abcdef";
const CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
const ALICE = "did:plc:e2ealice000000000000000a";
const BOB = "did:plc:e2ebob0000000000000000b";
const CAROL = "did:plc:e2ecarol00000000000000c";

// ---- DB に参加者と作品を入れる ----
const dir = mkdtempSync(path.join(tmpdir(), "art-sky-e2e-"));
const dbPath = path.join(dir, "e2e.sqlite");
{
  const db = openDatabase(dbPath);
  const users = createUserRepository(db);
  const gallery = createGalleryIndex(db);
  const jobs = createJobRepository(db);
  // 生成器で作った作品レコード。題名・日時だけ変えて、それぞれの人の作品として使う。
  const generated = JSON.parse(readFileSync(path.join(here, "../fixtures/generated-artwork.json"), "utf8")) as Record<string, unknown>;
  const record = (title: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    ...generated,
    kind: "genesis",
    title,
    createdAt,
    ...extra,
  });
  const post = (did: string, rkey: string) => ({ uri: `at://${did}/app.bsky.feed.post/${rkey}`, cid: CID });

  await users.touch(ALICE, { handle: "alice.e2e.test", displayName: "アリス" });
  await users.consent(ALICE);
  assert(await gallery.upsert({ did: ALICE, rkey: "3e2ea1", cid: CID, record: record("はじまり", "2026-11-10T03:00:00.000Z") }), "seed");
  assert(
    await gallery.upsert({
      did: ALICE,
      rkey: "3e2ea2",
      cid: CID,
      record: record("二作目", "2026-11-13T03:00:00.000Z", {
        kind: "evolution",
        trigger: post(ALICE, "3e2ea2"),
        previous: { uri: `at://${ALICE}/com.example.artsky.artwork/3e2ea1`, cid: CID },
        seed: 20261113,
      }),
    }),
    "seed",
  );
  const done = await jobs.enqueueGenesis(ALICE, "3e2ea1");
  await jobs.claimNext();
  await jobs.complete(done.id, { uri: `at://${ALICE}/com.example.artsky.artwork/3e2ea1`, cid: CID });

  await users.touch(BOB, { handle: "bob.e2e.test" });
  await users.consent(BOB);
  assert(await gallery.upsert({ did: BOB, rkey: "3e2eb1", cid: CID, record: record("星", "2026-11-14T03:00:00.000Z", { seed: 20261114 }) }), "seed");

  // キャロルはログインしただけで、まだ登録していない。
  await users.touch(CAROL, { handle: "carol.e2e.test" });
  db.close();
}

// ---- バックエンドを本番と同じ形で起動する（ビルドした画面も配る） ----
const server = spawn(process.execPath, ["src/server.ts"], {
  cwd: path.resolve(here, ".."),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    PUBLIC_URL: "",
    COOKIE_SECRET: SECRET,
    DB_PATH: dbPath,
    VALIDATE: "off",
    // 外部の Jetstream にはつながない（閉じたポートを指す。つながらなくても他は動くことも確かめる）。
    JETSTREAM_URL: "ws://127.0.0.1:9/subscribe",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/me`)).ok) return;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`バックエンドが起動しませんでした:\n${serverLog}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!outDir) return;
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
}

async function waitForArtworks(page: Page, n: number): Promise<void> {
  await page.waitForFunction((count) => document.querySelectorAll('.artwork-frame[data-phase="shown"]').length >= count, n, {
    timeout: 20_000,
  });
  assert((await page.locator('.artwork-frame[data-phase="error"]').count()) === 0, "描画に失敗した作品がある");
}

/** 本物と同じ署名のセッション Cookie を作って、その人としてログインした状態にする。 */
async function loginAs(page: Page, did: string): Promise<void> {
  const [pair] = (await serializeSigned("artsky_sid", did, SECRET, { path: "/" })).split(";");
  const [name, ...rest] = (pair ?? "").split("=");
  await page.context().clearCookies();
  await page.context().addCookies([{ name: name ?? "", value: rest.join("="), url: BASE }]);
}

const browser = await chromium.launch();
try {
  await waitForServer();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", acceptDownloads: true });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") problems.push(`${msg.type()}: ${msg.text()}`);
  });

  // ---- ギャラリー（ログイン不要）：本物の索引から作品が出て、その場で描画される ----
  await page.goto(BASE);
  await page.waitForSelector(".feed-slide");
  assert((await page.locator(".feed-slide").count()) === 2, "参加者ごとの最新作品が 2 件ではない");
  await waitForArtworks(page, 1);
  // 新しい順：ボブ（11/14）、アリスの二作目（11/13）
  assert((await page.locator(".feed-slide .tile-name").first().textContent()) === "bob.e2e.test", "新しい順に並んでいない");
  await shot(page, "service-gallery");
  await page.getByRole("button", { name: "タイル" }).click();
  await page.waitForSelector(".tile");
  await waitForArtworks(page, 2);

  // 画面のパスを直接開いても（再読み込みしても）表示される。
  await page.goto(`${BASE}/u/alice.e2e.test`);
  await page.waitForSelector(".tile");
  // 作品は 1 人 1 件：二作目を入れた時点で、はじまりは索引から消えている
  assert((await page.locator(".tile").count()) === 1, "アリスの作品が 1 件ではない");
  await page.locator(".tile-art").first().click();
  await page.waitForSelector(".detail");
  assert(await page.getByText("投稿をきっかけに変化した作品").isVisible(), "最新の作品（二作目）が開かない");
  assert(await page.getByText("Bluesky で見る").isVisible(), "元の投稿へのリンクがない");
  assert((await page.getByRole("link", { name: "← 前の作品" }).count()) === 0, "消えた前の作品へのリンクがある");
  await page.goto(`${BASE}/u/nobody.e2e.test`);
  await page.waitForSelector(".state-error");

  // ---- 未ログインで管理画面を開くと、ログイン画面へ ----
  await page.goto(`${BASE}/manage`);
  await page.waitForURL(/\/login\?next=%2Fmanage/);
  assert((await page.locator(".hint").count()) === 0, "本物のバックエンドなのに、モックの案内が出ている");

  // ---- 登録済みの人：管理画面、設定、名刺 ----
  await loginAs(page, ALICE);
  await page.goto(`${BASE}/manage`);
  await page.waitForSelector(".jobs li");
  assert((await page.locator('.badge[data-status="done"]').count()) === 1, "生成の履歴が出ていない");
  await shot(page, "service-manage");
  await page.getByRole("switch", { name: "ギャラリーに掲載する" }).click();
  await page.waitForSelector('.switch[aria-checked="false"]');
  await page.goto(BASE);
  await page.waitForSelector(".tile");
  assert((await page.locator(".tile").count()) === 1, "掲載をやめたのにギャラリーに残っている");
  await page.goto(`${BASE}/manage`);
  await page.getByRole("switch", { name: "ギャラリーに掲載する" }).click();
  await page.waitForSelector('.switch[aria-checked="true"]');
  await page.reload();
  await page.waitForSelector('.switch[aria-checked="true"]'); // 設定が保存されている

  await page.goto(`${BASE}/u/${ALICE}/3e2ea2`);
  await page.getByRole("link", { name: "この作品を名刺にする" }).click();
  await page.waitForSelector('.card-canvas[data-ready="true"]', { timeout: 20_000 });
  await shot(page, "service-card");

  // ---- 未登録の人：同意して登録すると、生成ジョブができる ----
  await loginAs(page, CAROL);
  await page.goto(`${BASE}/manage`);
  await page.waitForURL(/\/register$/);
  assert(await page.getByText("公開されるもの").isVisible(), "推定結果が公開されることの説明がない");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "同意して最初の作品を作る" }).click();
  await page.getByText("最初の作品を作っています").waitFor();
  // OAuth のセッションがないので、生成は「ログインの期限切れ」で失敗する。その理由が画面に出て、再試行できる。
  await page.getByText("ログインの有効期限が切れました").first().waitFor({ timeout: 20_000 });
  assert(await page.getByRole("button", { name: "もう一度生成する" }).isVisible(), "再試行のボタンがない");
  await shot(page, "service-register-failed");
  await page.getByRole("button", { name: "もう一度生成する" }).click();
  await page.getByText("ログインの有効期限が切れました").first().waitFor({ timeout: 20_000 });
  await page.goto(`${BASE}/manage`);
  await page.waitForSelector('.badge[data-status="failed"]');
  assert((await page.locator(".jobs li").count()) === 1, "再試行でジョブが増えてしまった");
  assert(await page.getByText("2 回目").isVisible(), "再試行の回数が出ていない");

  // ---- ログアウト ----
  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.getByRole("link", { name: "ログイン" }).waitFor();
  const me = (await (await page.request.get(`${BASE}/api/me`)).json()) as { user: unknown };
  assert(me.user === null, "ログアウト後もログイン状態のまま");

  const unexpected = problems.filter((p) => !/40[149]|409|willReadFrequently/.test(p));
  assert(unexpected.length === 0, `コンソールにエラーがある:\n${unexpected.join("\n")}`);
  console.log("OK: 本物のバックエンドで、ギャラリー、作品詳細、管理、設定、名刺、初回登録、失敗と再試行、ログアウトを確認した");
} catch (err) {
  console.error(`---- バックエンドのログ ----\n${serverLog}`);
  throw err;
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  rmSync(dir, { recursive: true, force: true });
}
