// Generates the extension icons (rounded indigo square with a white "flow"
// arrow) as PNG files without any image dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // Arrow: a horizontal bar plus a triangular head.
  const inArrow = (x, y) => {
    const u = x / size;
    const v = y / size;
    const bar = u >= 0.2 && u <= 0.55 && Math.abs(v - 0.5) <= 0.09;
    const head = u >= 0.5 && u <= 0.8 && Math.abs(v - 0.5) <= (0.8 - u) * 0.95;
    return bar || head;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let hits = 0;
      let arrow = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        if (inRounded(x + dx, y + dy)) {
          hits++;
          if (inArrow(x + dx, y + dy)) arrow++;
        }
      }
      const t = (x + y) / (2 * size);
      const bg = [Math.round(79 + (124 - 79) * t), Math.round(70 + (58 - 70) * t), Math.round(229 + (237 - 229) * t)];
      const a = arrow / Math.max(hits, 1);
      px[i] = Math.round(bg[0] * (1 - a) + 255 * a);
      px[i + 1] = Math.round(bg[1] * (1 - a) + 255 * a);
      px[i + 2] = Math.round(bg[2] * (1 - a) + 255 * a);
      px[i + 3] = Math.round((hits / 4) * 255);
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`public/icons/icon${size}.png`, render(size));
console.log('icons written to public/icons');
