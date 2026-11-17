import { deflateSync } from "node:zlib";

/**
 * モックの参加者の、仮のアバター画像（PNG）を作る。本物では Bluesky のプロフィール画像が入る。
 * 作品の絵と見分けやすいよう、2 色のグラデーションに丸を 1 つ置いただけの単純な絵にする。
 */
export function mockAvatarPng(seed: number, size = 256): Uint8Array {
  const hue = seed % 360;
  const [r1, g1, b1] = hsl(hue, 0.65, 0.55);
  const [r2, g2, b2] = hsl((hue + 50) % 360, 0.7, 0.35);
  const cx = size / 2;
  const cy = size * 0.42;
  const radius = size * 0.22;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      let r = r1 + (r2 - r1) * t;
      let g = g1 + (g2 - g1) * t;
      let b = b1 + (b2 - b1) * t;
      const d = Math.hypot(x - cx, y - cy);
      // 頭と肩の形（よくある人型のアイコン）
      const shoulders = Math.hypot((x - size / 2) / (size * 0.38), (y - size * 1.02) / (size * 0.36)) < 1;
      if (d < radius || shoulders) [r, g, b] = [r + (255 - r) * 0.82, g + (255 - g) * 0.82, b + (255 - b) * 0.82];
      const i = row + 1 + x * 3;
      raw[i] = Math.round(r);
      raw[i + 1] = Math.round(g);
      raw[i + 2] = Math.round(b);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // ビット深度
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}
