/**
 * モックで開発サーバーを起動し、実際のブラウザで全画面を通しで確かめる。
 *   pnpm e2e            確認だけ行う
 *   pnpm e2e <出力先>   スクリーンショットも保存する
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";

const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`確認に失敗: ${message}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!outDir) return;
  await page.waitForTimeout(700); // フェードインやスクロールが終わるのを待つ
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
}

/** 作品が n 件以上描き終わるのを待ち、失敗した作品がないことを確かめる。 */
async function waitForArtworks(page: Page, n: number, scope = ""): Promise<void> {
  await page.waitForFunction(
    ([count, sel]) => document.querySelectorAll(`${sel} .artwork-frame[data-phase="shown"]`).length >= (count as number),
    [n, scope] as const,
    { timeout: 20_000 },
  );
  const errors = await page.locator('.artwork-frame[data-phase="error"]').count();
  assert(errors === 0, `${errors} 件の作品が描画に失敗した`);
}

async function noHorizontalScroll(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `${where} で横スクロールが出ている（${overflow}px）`);
}

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: "warn" });
await server.listen();
const base = "http://127.0.0.1:5199";
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") problems.push(`${msg.type()}: ${msg.text()}`);
  });

  // ---- ギャラリー：1 枚ずつ流す配置（既定） ----
  await page.goto(base);
  await page.waitForSelector(".feed-slide");
  assert((await page.locator(".feed-slide").count()) === 8, "作品が 8 件ではない");
  await waitForArtworks(page, 1);
  assert((await page.locator(".feed-count").textContent())?.trim() === "1 / 8", "最初が 1 / 8 ではない");
  // 最初の作品と説明が 1 画面に収まっている。
  const box = await page.locator(".feed-slide").first().boundingBox();
  assert(box && box.y >= 0 && box.y + box.height <= 900, "最初の作品が 1 画面に収まっていない");
  await shot(page, "feed");

  // スクロールは自由に動き、止めた位置にとどまる（スナップで引き戻されない）。
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(400);
  const y1 = await page.evaluate(() => window.scrollY);
  await page.waitForTimeout(800);
  const y2 = await page.evaluate(() => window.scrollY);
  assert(Math.abs(y1 - 300) <= 2 && y2 === y1, `300px スクロールしたのに ${y1}px → ${y2}px になった`);

  // 連続してスクロールしている間、画面の更新が長く止まらない。
  const longestFrame = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = performance.now();
        let longest = 0;
        const end = last + 2500;
        const tick = (now: number) => {
          longest = Math.max(longest, now - last);
          last = now;
          window.scrollBy(0, 24);
          if (now < end) requestAnimationFrame(tick);
          else resolve(longest);
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(`スクロール中のいちばん長いフレーム: ${longestFrame.toFixed(1)}ms`);
  assert(longestFrame < 250, `スクロール中に ${longestFrame.toFixed(0)}ms 止まった`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => document.querySelector(".feed-count")?.textContent?.trim() === "1 / 8");

  // ボタンと j キーで、次の作品が画面の中央に来る。
  await page.getByRole("button", { name: "次の作品" }).click();
  await page.waitForFunction(() => document.querySelector(".feed-count")?.textContent?.trim() === "2 / 8");
  await page.keyboard.press("j");
  await page.waitForFunction(() => document.querySelector(".feed-count")?.textContent?.trim() === "3 / 8");
  await page.waitForTimeout(900);
  const third = await page.locator(".feed-slide").nth(2).boundingBox();
  assert(third && Math.abs(third.y + third.height / 2 - 450) < 40, "3 枚目が画面の中央に来ていない");
  await waitForArtworks(page, 3);
  await shot(page, "feed-3");

  // ---- 配置の切り替え：タイル。選んだ配置は開き直しても残る ----
  await page.getByRole("button", { name: "タイル" }).click();
  await page.waitForSelector(".tile");
  assert((await page.locator(".tile").count()) === 8, "タイルが 8 件ではない");
  assert((await page.locator(".masonry-column").count()) >= 3, "1280px 幅で列が 3 未満");
  await waitForArtworks(page, 8);
  await shot(page, "tiles");
  await page.reload();
  await page.waitForSelector(".tile");
  assert((await page.locator(".feed").count()) === 0, "開き直すと配置が戻ってしまう");
  const sandbox = await page.locator(".artwork-frame > iframe").first().getAttribute("sandbox");
  assert(sandbox === "allow-scripts", `sandbox 属性が ${sandbox}`);

  // ---- 作品詳細と個人ギャラリー ----
  await page.locator(".tile-art").first().click();
  await page.waitForSelector(".detail");
  await waitForArtworks(page, 1);
  await page.getByRole("link", { name: "← 前の作品" }).click();
  await page.waitForFunction(() => document.querySelector(".detail h1")?.textContent === "眠れない夜のプレイリスト");
  await page.goto(`${base}/u/yui.example.com`);
  await page.waitForSelector(".tile");
  assert((await page.locator(".tile").count()) === 5, "結さんの作品が 5 件ではない");
  await page.getByRole("button", { name: "1 枚ずつ" }).click();
  await page.waitForSelector(".feed-slide");
  await waitForArtworks(page, 1);
  await shot(page, "actor-feed");
  await page.goto(`${base}/u/nobody.example.com`);
  await page.waitForSelector(".state-error");

  // ---- ログイン → 初回登録 → 最初の作品 ----
  await page.goto(`${base}/manage`);
  await page.waitForURL(/\/login\?next=%2Fmanage/);
  await shot(page, "login");
  await page.getByLabel("ハンドル名").fill("newbie.example.com");
  await page.getByRole("button", { name: "Bluesky でログイン" }).click();
  await page.waitForURL(/\/register$/);
  const agree = page.getByRole("button", { name: "同意して最初の作品を作る" });
  assert(await agree.isDisabled(), "同意する前に登録できてしまう");
  await shot(page, "register");
  await page.getByRole("checkbox").check();
  await agree.click();
  await page.getByText("最初の作品を作っています").waitFor();
  await page.getByText("作品ができました").waitFor({ timeout: 20_000 });
  await shot(page, "register-done");
  await page.getByRole("link", { name: "自分のギャラリーを見る" }).click();
  await page.waitForSelector(".feed-slide");
  assert((await page.locator(".feed-slide").count()) === 1, "登録直後の作品が 1 件ではない");

  // ---- 投稿機能はない ----
  assert((await page.getByRole("link", { name: "投稿", exact: true }).count()) === 0, "メニューに投稿が残っている");
  await page.goto(`${base}/post`);
  await page.getByText("ページが見つかりません").waitFor();

  // ---- Bluesky に投稿があると作品が変化する。失敗したら管理画面から再試行できる ----
  const posted = await page.request.post(`${base}/__mock/post`, { data: { handle: "newbie.example.com", fail: true } });
  assert(posted.status() === 202, `モックの投稿が ${posted.status()} を返した`);
  await page.goto(`${base}/manage`);
  await page.waitForSelector('.badge[data-status="failed"]', { timeout: 20_000 });
  await shot(page, "manage-failed");
  await page.getByRole("button", { name: "再試行" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.badge[data-status="done"]').length === 2, null, {
    timeout: 20_000,
  });
  assert((await page.locator(".jobs li").count()) === 2, "生成の履歴が 2 件ではない");
  await shot(page, "manage");

  // ---- 管理：設定、ログアウト ----
  await page.getByRole("switch", { name: "ギャラリーに掲載する" }).click();
  await page.waitForSelector('.switch[aria-checked="false"]');
  await page.goto(base);
  await page.waitForSelector(".feed-slide");
  assert((await page.locator(".feed-slide").count()) === 8, "掲載をやめたのにギャラリーに残っている");
  await page.goto(`${base}/manage`);
  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.getByRole("link", { name: "ログイン" }).waitFor();

  // ---- スマートフォン幅 ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.waitForSelector(".feed-slide");
  await waitForArtworks(page, 1);
  await noHorizontalScroll(page, "ギャラリー（1 枚ずつ）");
  await shot(page, "mobile-feed");
  await page.getByRole("button", { name: "タイル" }).click();
  await page.waitForSelector(".tile");
  assert((await page.locator(".masonry-column").count()) === 1, "390px 幅で 1 列になっていない");
  await noHorizontalScroll(page, "ギャラリー（タイル）");
  await page.goto(`${base}/login`);
  await noHorizontalScroll(page, "ログイン");

  const unexpected = problems.filter((p) => !p.includes("404"));
  assert(unexpected.length === 0, `コンソールにエラーがある:\n${unexpected.join("\n")}`);
  console.log("OK: ギャラリー（2 つの配置とスクロール）、作品詳細、個人ギャラリー、ログイン、初回登録、再試行、管理、スマートフォン幅を確認した");
} finally {
  await browser.close();
  await server.close();
}
