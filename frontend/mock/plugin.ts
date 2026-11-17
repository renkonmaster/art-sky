import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { MockBackend } from "./backend.ts";

const PREFIXES = ["/api/", "/oauth/", "/xrpc/", "/__mock/"];

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * 開発サーバーに、バックエンドの代わりをするモックを組み込む。
 * フロントエンドのコードは本物のバックエンドと同じ URL を呼ぶので、切り替えてもコードは変わらない。
 */
export function mockApi(options: { delayMs?: number } = {}): Plugin {
  const delayMs = options.delayMs ?? 250;
  return {
    name: "art-sky-mock-api",
    configureServer(server) {
      const backend = new MockBackend();
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://mock");
        if (!PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return next();
        try {
          const body = req.method === "GET" ? undefined : await readBody(req);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const out = backend.handle({
            method: req.method ?? "GET",
            path: url.pathname,
            query: url.searchParams,
            body,
            cookie: req.headers.cookie,
          });
          res.statusCode = out.status;
          for (const [name, value] of Object.entries(out.headers ?? {})) res.setHeader(name, value);
          if (out.raw) return res.end(out.raw);
          if (out.body === undefined) return res.end();
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(out.body));
        } catch (err) {
          server.config.logger.error(String(err));
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "InternalError", message: String(err) }));
        }
      });
    },
  };
}
