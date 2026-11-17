import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { createGalleryIndex, type GalleryIndex } from "../gallery/index.ts";
import { syncArtworksFromPds } from "../gallery/sync.ts";
import { createJobRepository, type JobRepository } from "../jobs/repository.ts";
import { createUserRepository, type UserRepository } from "../users.ts";
import { type FeedAgent, handleEvent, type JetstreamEvent, type PullOptions, pullOnce } from "./consumer.ts";

const ALICE = "did:plc:alice";
const CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";

let users: UserRepository;
let jobs: JobRepository;
let gallery: GalleryIndex;

const artwork = (createdAt = "2026-11-14T00:00:00.000Z") => ({
  kind: "genesis",
  renderer: { runtime: "canvas2d", version: "1" },
  code: "export default function draw() {}",
  seed: 1,
  aspectRatio: { width: 1, height: 1 },
  generator: { id: "g", version: "1" },
  createdAt,
});

/** これから先の時刻のイベント（登録より後）。 */
const later = () => (Date.now() + 60_000) * 1000;

const postEvent = (rkey: string, record: unknown = { text: "初雪", createdAt: "2026-11-14T00:00:00.000Z" }, did = ALICE): JetstreamEvent => ({
  did,
  time_us: later(),
  kind: "commit",
  commit: { operation: "create", collection: "app.bsky.feed.post", rkey, cid: CID, record },
});

beforeEach(() => {
  const db = openDatabase(":memory:");
  users = createUserRepository(db);
  jobs = createJobRepository(db);
  gallery = createGalleryIndex(db);
  users.touch(ALICE, { handle: "alice.test" });
  users.consent(ALICE);
});

describe("Bluesky の投稿の監視", () => {
  it("登録済みの人の投稿から evolution ジョブを作る。レコードキーは投稿と同じ", () => {
    expect(handleEvent({ users, jobs, gallery }, postEvent("3post1"))).toBe("job");
    const [job] = jobs.listByDid(ALICE);
    expect(job).toMatchObject({
      kind: "evolution",
      rkey: "3post1",
      triggerUri: `at://${ALICE}/app.bsky.feed.post/3post1`,
      triggerCid: CID,
      status: "queued",
    });
  });

  it("同じ投稿が二度届いても、ジョブは 1 つ", () => {
    handleEvent({ users, jobs, gallery }, postEvent("3post1"));
    handleEvent({ users, jobs, gallery }, postEvent("3post1"));
    expect(jobs.listByDid(ALICE)).toHaveLength(1);
  });

  it.each([
    ["返信", { text: "a", reply: { parent: {}, root: {} } }],
    ["引用", { text: "a", embed: { $type: "app.bsky.embed.record" } }],
    ["画像つきの引用", { text: "a", embed: { $type: "app.bsky.embed.recordWithMedia" } }],
  ])("%sは対象外", (_, record) => {
    expect(handleEvent({ users, jobs, gallery }, postEvent("3post1", record))).toBe("ignored");
    expect(jobs.listByDid(ALICE)).toHaveLength(0);
  });

  it("画像つきのふつうの投稿は対象", () => {
    const record = { text: "写真", embed: { $type: "app.bsky.embed.images" } };
    expect(handleEvent({ users, jobs, gallery }, postEvent("3post1", record))).toBe("job");
  });

  it("登録していない人、未同意の人、生成を止めている人の投稿は対象外", () => {
    expect(handleEvent({ users, jobs, gallery }, postEvent("3p", undefined, "did:plc:stranger"))).toBe("ignored");
    users.touch("did:plc:bob", { handle: "bob.test" });
    expect(handleEvent({ users, jobs, gallery }, postEvent("3p", undefined, "did:plc:bob"))).toBe("ignored");
    users.updateSettings(ALICE, { generationEnabled: false, listed: true });
    expect(handleEvent({ users, jobs, gallery }, postEvent("3p"))).toBe("ignored");
  });

  it("登録より前の投稿、削除、更新は対象外", () => {
    const old = { ...postEvent("3old"), time_us: (Date.now() - 3_600_000) * 1000 };
    expect(handleEvent({ users, jobs, gallery }, old)).toBe("ignored");
    const deleted: JetstreamEvent = { did: ALICE, time_us: later(), kind: "commit", commit: { operation: "delete", collection: "app.bsky.feed.post", rkey: "3p" } };
    expect(handleEvent({ users, jobs, gallery }, deleted)).toBe("ignored");
    expect(handleEvent({ users, jobs, gallery }, { did: ALICE, time_us: later(), kind: "identity" })).toBe("ignored");
  });
});

describe("作品レコードの索引", () => {
  const artworkEvent = (operation: "create" | "delete", rkey: string, record?: unknown): JetstreamEvent => ({
    did: ALICE,
    time_us: later(),
    kind: "commit",
    commit: { operation, collection: "com.example.artsky.artwork", rkey, ...(record ? { cid: CID, record } : {}) },
  });

  it("作成されたら索引に入れ、削除されたら消す", () => {
    expect(handleEvent({ users, jobs, gallery }, artworkEvent("create", "3art1", artwork()))).toBe("indexed");
    expect(gallery.listByDid(ALICE, 10, 0)).toHaveLength(1);
    expect(handleEvent({ users, jobs, gallery }, artworkEvent("delete", "3art1"))).toBe("removed");
    expect(gallery.listByDid(ALICE, 10, 0)).toHaveLength(0);
  });

  it("形式の正しくないレコードは入れない", () => {
    expect(handleEvent({ users, jobs, gallery }, artworkEvent("create", "3art1", { code: 1 }))).toBe("ignored");
    expect(gallery.listByDid(ALICE, 10, 0)).toHaveLength(0);
  });

  it("PDS から読み直すと、索引は PDS の最新の作品 1 件だけになる", async () => {
    gallery.upsert({ did: ALICE, rkey: "3gone", cid: CID, record: artwork() }); // PDS では消された作品
    const pages = [
      { records: [{ uri: `at://${ALICE}/com.example.artsky.artwork/3art2`, cid: CID, value: artwork() }], cursor: "c1" },
      { records: [{ uri: `at://${ALICE}/com.example.artsky.artwork/3art1`, cid: CID, value: artwork() }, { uri: `at://${ALICE}/com.example.artsky.artwork/3bad`, cid: CID, value: {} }], cursor: "c2" },
      { records: [] },
    ];
    let call = 0;
    const agent = { com: { atproto: { repo: { listRecords: async () => ({ data: pages[call++] }) } } } };
    const count = await syncArtworksFromPds(agent as never, ALICE, gallery);
    expect(count).toBe(1);
    expect(gallery.listByDid(ALICE, 10, 0).map((a) => a.rkey)).toEqual(["3art2"]);
  });

  it("新しい作品が入ると古い作品は索引から消え、古い作品を後から受け取っても新しい作品は残る", () => {
    gallery.upsert({ did: ALICE, rkey: "3art1", cid: CID, record: artwork() });
    gallery.upsert({ did: ALICE, rkey: "3art2", cid: CID, record: artwork() });
    expect(gallery.listByDid(ALICE, 10, 0).map((a) => a.rkey)).toEqual(["3art2"]);
    gallery.upsert({ did: ALICE, rkey: "3art1", cid: CID, record: artwork() });
    expect(gallery.listByDid(ALICE, 10, 0).map((a) => a.rkey)).toEqual(["3art2"]);
  });
});

describe("Cron ごとの取り込み（pullOnce）", () => {
  /** 本物の WebSocket の代わり。open は次のタスクで届く。 */
  class FakeSocket extends EventTarget {
    static instances: FakeSocket[] = [];
    closed = false;
    readonly url: string;
    constructor(url: string, { fail = false } = {}) {
      super();
      this.url = url;
      FakeSocket.instances.push(this);
      setTimeout(() => {
        if (fail) this.close();
        else this.dispatchEvent(new Event("open"));
      }, 0);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
    receive(event: JetstreamEvent) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }
  }

  const NOW = Date.now() + 120_000; // 登録より後
  const NOW_US = NOW * 1000;
  let saved: number | undefined;
  const options = (extra: Partial<PullOptions> = {}): PullOptions => ({
    url: "wss://jetstream.test/subscribe",
    loadCursor: () => saved,
    saveCursor: (c) => void (saved = c),
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    idleMs: 20,
    maxMs: 1000,
    now: () => NOW,
    log: () => {},
    ...extra,
  });
  const event = (rkey: string, time_us: number): JetstreamEvent => ({ ...postEvent(rkey), time_us });
  /** 接続ができたら fn を呼ぶ */
  const onConnect = (fn: (socket: FakeSocket) => void) =>
    setTimeout(() => {
      const socket = FakeSocket.instances.at(-1)!;
      socket.addEventListener("open", () => fn(socket));
    }, 0);

  beforeEach(() => {
    FakeSocket.instances = [];
    saved = undefined;
  });

  it("登録済みの人と 2 つのコレクションに絞り、カーソルの少し前から読む", async () => {
    saved = NOW_US - 60_000_000;
    await pullOnce({ users, jobs, gallery }, options());
    const params = new URL(FakeSocket.instances[0]!.url).searchParams;
    expect(params.getAll("wantedCollections")).toEqual(["app.bsky.feed.post", "com.example.artsky.artwork"]);
    expect(params.getAll("wantedDids")).toEqual([ALICE]);
    expect(params.get("cursor")).toBe(String(NOW_US - 60_000_000 - 5_000_000));
  });

  it("届いた投稿からジョブを作り、接続した時刻に追いついたら切断してカーソルを保存する", async () => {
    saved = NOW_US - 60_000_000;
    onConnect((socket) => {
      socket.receive(event("3a", NOW_US - 30_000_000));
      socket.receive(event("3b", NOW_US + 1));
      socket.receive(event("3c", NOW_US + 2)); // 切断後は処理しない
    });
    const result = await pullOnce({ users, jobs, gallery }, options());
    expect(result).toMatchObject({ outcome: "pulled", events: 2, jobs: 2 });
    expect(jobs.listByDid(ALICE).map((j) => j.rkey).sort()).toEqual(["3a", "3b"]);
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    expect(saved).toBe(NOW_US + 1);
  });

  it("何も届かなければ、しばらくして切断し、カーソルを今に近づける", async () => {
    saved = NOW_US - 3600_000_000;
    const result = await pullOnce({ users, jobs, gallery }, options());
    expect(result).toMatchObject({ outcome: "pulled", events: 0 });
    expect(saved).toBe(NOW_US - 5_000_000);
  });

  it("上限時間で打ち切ったときは、処理したところまでしかカーソルを進めない", async () => {
    saved = NOW_US - 3600_000_000;
    onConnect((socket) => {
      socket.receive(event("3a", NOW_US - 1800_000_000));
      // idleMs より短い間隔で届き続ける
      const timer = setInterval(() => socket.receive({ did: ALICE, time_us: NOW_US - 1700_000_000, kind: "identity" }), 5);
      socket.addEventListener("close", () => clearInterval(timer));
    });
    await pullOnce({ users, jobs, gallery }, options({ maxMs: 60 }));
    expect(saved).toBe(NOW_US - 1700_000_000);
  });

  it("接続できなければカーソルを変えない", async () => {
    saved = NOW_US - 60_000_000;
    const result = await pullOnce(
      { users, jobs, gallery },
      options({ createSocket: (url) => new FakeSocket(url, { fail: true }) as unknown as WebSocket }),
    );
    expect(result.outcome).toBe("failed");
    expect(saved).toBe(NOW_US - 60_000_000);
  });

  it("登録者がいなければ接続しない", async () => {
    const db = openDatabase(":memory:");
    const empty = { users: createUserRepository(db), jobs: createJobRepository(db), gallery: createGalleryIndex(db) };
    const result = await pullOnce(empty, options());
    expect(result.outcome).toBe("no-users");
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("カーソルが古すぎれば、各人の直近の投稿を取り直し、今から読み始める", async () => {
    saved = NOW_US - 48 * 3600_000_000;
    const iso = (us: number) => new Date(us / 1000).toISOString();
    const feedAgent: FeedAgent = {
      async getAuthorFeed() {
        return {
          data: {
            feed: [
              { post: { uri: `at://${ALICE}/app.bsky.feed.post/3new`, cid: CID, author: { did: ALICE }, record: { text: "新しい", createdAt: iso(NOW_US - 60_000_000) } } },
              { post: { uri: `at://${ALICE}/app.bsky.feed.post/3old`, cid: CID, author: { did: ALICE }, record: { text: "古い", createdAt: iso(NOW_US - 72 * 3600_000_000) } } },
              { post: { uri: "at://did:plc:x/app.bsky.feed.post/3rp", cid: CID, author: { did: "did:plc:x" }, record: { text: "リポスト", createdAt: iso(NOW_US) } }, reason: {} },
            ],
          },
        };
      },
    };
    const result = await pullOnce({ users, jobs, gallery }, options({ feedAgent }));
    expect(result).toMatchObject({ backfilled: 1, jobs: 1 });
    expect(jobs.listByDid(ALICE).map((j) => j.rkey)).toEqual(["3new"]);
    expect(new URL(FakeSocket.instances[0]!.url).searchParams.has("cursor")).toBe(false);
    expect(saved).toBe(NOW_US - 5_000_000);
  });
});
