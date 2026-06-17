// A tiny, dependency-free ZIP writer (STORE method — no compression). Enough to bundle the
// generated files into a downloadable archive without pulling in a zip library, which fits
// Koine's "self-contained, no dependencies" ethos. Generated code is small and text, so the
// lack of compression is fine.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** Builds a STORE-method .zip Blob from {path -> text} entries. */
export function makeZip(files: { path: string; contents: string }[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;

  const push = (u: Uint8Array) => {
    chunks.push(u);
    offset += u.length;
  };

  // Local file headers + data.
  for (const f of files) {
    const nameBytes = enc.encode(f.path);
    const data = enc.encode(f.contents);
    const crc = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // local file header signature
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0x0800, true); // flags: UTF-8 names
    header.setUint16(8, 0, true); // method: store
    header.setUint16(10, 0, true); // mod time
    header.setUint16(12, 0, true); // mod date
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true); // compressed size
    header.setUint32(22, data.length, true); // uncompressed size
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true); // extra length

    entries.push({ nameBytes, data, crc, offset });
    push(new Uint8Array(header.buffer));
    push(nameBytes);
    push(data);
  }

  // Central directory.
  const cdStart = offset;
  for (const e of entries) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central dir signature
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0x0800, true); // flags: UTF-8
    cd.setUint16(10, 0, true); // method
    cd.setUint16(12, 0, true); // time
    cd.setUint16(14, 0, true); // date
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.data.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, e.nameBytes.length, true);
    cd.setUint16(30, 0, true); // extra
    cd.setUint16(32, 0, true); // comment
    cd.setUint16(34, 0, true); // disk number
    cd.setUint16(36, 0, true); // internal attrs
    cd.setUint32(38, 0, true); // external attrs
    cd.setUint32(42, e.offset, true); // local header offset
    push(new Uint8Array(cd.buffer));
    push(e.nameBytes);
  }
  const cdSize = offset - cdStart;

  // End of central directory.
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  push(new Uint8Array(eocd.buffer));

  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}

/** Triggers a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
