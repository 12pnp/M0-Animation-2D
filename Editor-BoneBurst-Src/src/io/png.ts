/**
 * PNG files read and written by the editor itself (E4-PLAN step 14), so pixels survive exactly:
 * a canvas stores colours premultiplied and rounds semi-transparent ones. Deflate is the
 * platform's (`CompressionStream`, in browsers and Node alike). Reads 8-bit grey, RGB, palette,
 * grey + alpha and RGBA, not interlaced; writes 8-bit RGBA. Pixels are RGBA with straight alpha.
 */

export interface PngImage { readonly width: number; readonly height: number; readonly pixels: Uint8ClampedArray }

/** Refused: what is wrong with the file. */
export class PngRefused extends Error {}

/** The largest side read, as for PSD files. */
const SIDE = 16384;
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Channels per pixel for each colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export async function decodePng(bytes: Uint8Array, file = "the image"): Promise<PngImage> {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new PngRefused(`${file} is not a PNG file.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  let palette: Uint8Array | null = null, alpha: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  for (;;) {
    if (at + 12 > bytes.length) throw new PngRefused(`${file} ends before its last chunk.`);
    const length = view.getUint32(at), name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 8 + length;
    if (end + 4 > bytes.length) throw new PngRefused(`${file} ends inside its ${name} chunk.`);
    if (crc32(bytes, at + 4, end) !== view.getUint32(end)) throw new PngRefused(`${file} is damaged (its ${name} chunk does not check).`);
    const body = bytes.subarray(at + 8, end);
    if (name === "IHDR") {
      width = view.getUint32(at + 8); height = view.getUint32(at + 12);
      depth = body[8]!; type = body[9]!; interlace = body[12]!;
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") alpha = body;
    else if (name === "IDAT") data.push(body);
    else if (name === "IEND") break;
    at = end + 4;
  }
  const channels = CHANNELS[type];
  if (!channels || !width || !height) throw new PngRefused(`${file} has no image header this editor reads.`);
  if (depth !== 8) throw new PngRefused(`${file} has ${depth} bits per channel; save it with 8.`);
  if (interlace) throw new PngRefused(`${file} is interlaced; save it without interlacing.`);
  if (width > SIDE || height > SIDE) throw new PngRefused(`${file} is ${width} × ${height}; the largest side read is ${SIDE}.`);
  if (type === 3 && !palette) throw new PngRefused(`${file} has a palette colour type but no palette.`);
  const joined = new Uint8Array(data.reduce((n, d) => n + d.length, 0));
  data.reduce((o, d) => (joined.set(d, o), o + d.length), 0);
  const raw = await through(joined, new DecompressionStream("deflate"));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new PngRefused(`${file} holds fewer pixels than its size.`);
  const rows = unfilter(raw, stride, channels, height, file);
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels, d = i * 4;
    switch (type) {
      case 0: px[d] = px[d + 1] = px[d + 2] = rows[s]!; px[d + 3] = alpha && alpha.length >= 2 && view16(alpha) === rows[s] ? 0 : 255; break;
      case 2: {
        px[d] = rows[s]!; px[d + 1] = rows[s + 1]!; px[d + 2] = rows[s + 2]!;
        px[d + 3] = alpha && alpha.length >= 6 && alpha[1] === rows[s] && alpha[3] === rows[s + 1] && alpha[5] === rows[s + 2] ? 0 : 255;
        break;
      }
      case 3: {
        const k = rows[s]!;
        if (k * 3 + 2 >= palette!.length) throw new PngRefused(`${file} uses a colour its palette does not have.`);
        px[d] = palette![k * 3]!; px[d + 1] = palette![k * 3 + 1]!; px[d + 2] = palette![k * 3 + 2]!;
        px[d + 3] = alpha && k < alpha.length ? alpha[k]! : 255;
        break;
      }
      case 4: px[d] = px[d + 1] = px[d + 2] = rows[s]!; px[d + 3] = rows[s + 1]!; break;
      default: px[d] = rows[s]!; px[d + 1] = rows[s + 1]!; px[d + 2] = rows[s + 2]!; px[d + 3] = rows[s + 3]!;
    }
  }
  return { width, height, pixels: px };
}

/** A grey tRNS value (two bytes, 8-bit images use the low one). */
const view16 = (a: Uint8Array) => a[1]!;

function unfilter(raw: Uint8Array, stride: number, bpp: number, height: number, file: string): Uint8Array {
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!, src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp]! : 0, b = y ? out[up + x]! : 0, c = y && x >= bpp ? out[up + x - bpp]! : 0;
      let v = raw[src + x]!;
      switch (f) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
        default: throw new PngRefused(`${file} has a row filter PNG does not define (${f}).`);
      }
      out[row + x] = v & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** An 8-bit RGBA PNG; each row filtered the way that leaves the smallest sum (PNG's usual guess). */
export async function encodePng(img: PngImage): Promise<Uint8Array> {
  const { width, height, pixels } = img, stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height), trial = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride, up = row - stride;
    let best = Infinity, bestF = 0;
    const out = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = pixels[row + x]!, a = x >= 4 ? pixels[row + x - 4]! : 0, b = y ? pixels[up + x]! : 0, c = y && x >= 4 ? pixels[up + x - 4]! : 0;
        const p = (f === 0 ? v : f === 1 ? v - a : f === 2 ? v - b : f === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c)) & 0xff;
        trial[x] = p;
        sum += p < 128 ? p : 256 - p;
      }
      if (sum < best) { best = sum; bestF = f; out.set(trial); }
    }
    raw[y * (stride + 1)] = bestF;
  }
  const idat = await through(raw, new CompressionStream("deflate"));
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const chunks = [chunk("IHDR", header), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const file = new Uint8Array(8 + chunks.reduce((n, c) => n + c.length, 0));
  file.set(SIGNATURE, 0);
  chunks.reduce((o, c) => (file.set(c, o), o + c.length), 8);
  return file;
}

function chunk(name: string, body: Uint8Array): Uint8Array {
  const c = new Uint8Array(12 + body.length), v = new DataView(c.buffer);
  v.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) c[4 + i] = name.charCodeAt(i);
  c.set(body, 8);
  v.setUint32(8 + body.length, crc32(c, 4, 8 + body.length));
  return c;
}
