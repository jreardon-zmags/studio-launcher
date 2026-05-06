'use strict';
const { deflateSync } = require('zlib');
const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const ASSETS_DIR = join(__dirname, '..', 'assets');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function createSolidPng(width, height, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(ASSETS_DIR, { recursive: true });
writeFileSync(join(ASSETS_DIR, 'icon-mac.png'), createSolidPng(18, 18, 30, 30, 30));
writeFileSync(join(ASSETS_DIR, 'icon-win.png'), createSolidPng(16, 16, 16, 185, 129));
writeFileSync(join(ASSETS_DIR, 'icon.png'), createSolidPng(512, 512, 16, 185, 129));
console.log('Icons written to assets/  (replace with designed assets before distribution)');
