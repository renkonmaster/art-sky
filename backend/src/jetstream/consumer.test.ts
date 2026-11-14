import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { createGalleryIndex, type GalleryIndex } from "../gallery/index.ts";
import { syncArtworksFromPds } from "../gallery/sync.ts";
import { createJobRepository, type JobRepository } from "../jobs/repository.ts";
import { createUserRepository, type UserRepository } from "../users.ts";
import { handleEvent, type JetstreamEvent, startConsumer } from "./consumer.ts";

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

  it("PDS から読み直すと、索引が PDS と同じ内容になる", async () => {
    gallery.upsert({ did: ALICE, rkey: "3gone", cid: CID, record: artwork() }); // PDS では消された作品
    const pages = [
      { records: [{ uri: `at://${ALICE}/com.example.artsky.artwork/3art2`, cid: CID, value: artwork() }], cursor: "c1" },
      { records: [{ uri: `at://${ALICE}/com.example.artsky.artwork/3art1`, cid: CID, value: artwork() }, { uri: `at://${ALICE}/com.example.artsky.artwork/3bad`, cid: CID, value: {} }], cursor: "c2" },
      { records: [] },
    ];
    let call = 0;
    const agent = { com: { atproto: { repo: { listRecords: async () => ({ data: pages[call++] }) } } } };
    const count = await syncArtworksFromPds(agent as never, ALICE, gallery);
    expect(count).toBe(2);
    expect(gallery.listByDid(ALICE, 10, 0).map((a) => a.rkey)).toEqual(["3art2", "3art1"]);
  });
});

describe("接続", () => {
  class FakeSocket extends EventTarget {
    static instances: FakeSocket[] = [];
    closed = false;
    readonly url: string;
    constructor(url: string) {
      super();
      this.url = url;
      FakeSocket.instances.push(this);
    }
    close() {
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
    receive(event: JetstreamEvent) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }
  }

  beforeEach(() => {
    FakeSocket.instances = [];
  });

  it("登録済みの人と 2 つのコレクションに絞って購読し、カーソルを保存して再開する", () => {
    let saved: number | undefined = 1_700_000_000_000_000;
    const consumer = startConsumer(
      { users, jobs, gallery },
      {
        url: "wss://jetstream.test/subscribe",
        loadCursor: () => saved,
        saveCursor: (c) => void (saved = c),
        createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
        log: () => {},
      },
    );
    const socket = FakeSocket.instances[0]!;
    const params = new URL(socket.url).searchParams;
    expect(params.getAll("wantedCollections")).toEqual(["app.bsky.feed.post", "com.example.artsky.artwork"]);
    expect(params.getAll("wantedDids")).toEqual([ALICE]);
    expect(params.get("cursor")).toBe(String(1_700_000_000_000_000 - 5_000_000)); // 少し前から再開する

    const event = postEvent("3post1");
    socket.receive(event);
    expect(jobs.listByDid(ALICE)).toHaveLength(1);

    // 登録者が増えたら、その人も含めて接続し直す。
    users.touch("did:plc:bob", { handle: "bob.test" });
    users.consent("did:plc:bob");
    consumer.refresh();
    expect(socket.closed).toBe(true);
    expect(new URL(FakeSocket.instances[1]!.url).searchParams.getAll("wantedDids")).toEqual([ALICE, "did:plc:bob"]);

    consumer.stop();
    expect(saved).toBe(event.time_us);
    expect(FakeSocket.instances).toHaveLength(2); // 止めたあとは接続し直さない
  });

  it("登録者がいなければ接続しない", () => {
    const db = openDatabase(":memory:");
    const empty = { users: createUserRepository(db), jobs: createJobRepository(db), gallery: createGalleryIndex(db) };
    const consumer = startConsumer(empty, {
      loadCursor: () => undefined,
      saveCursor: () => {},
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      log: () => {},
    });
    expect(FakeSocket.instances).toHaveLength(0);
    consumer.stop();
  });
});
