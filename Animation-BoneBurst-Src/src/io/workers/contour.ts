import { type Contour, traceContour } from "@/core/atlas/contour";
import { canUseWorkers, poolSize, WorkerCrashed, WorkerPool } from "./WorkerPool";

export interface ContourRequest {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

let pool: WorkerPool<ContourRequest, Contour> | null | undefined;

function contourPool() {
  if (pool === undefined) {
    pool = canUseWorkers()
      ? new WorkerPool(
          () => new Worker(new URL("./contour.worker.ts", import.meta.url), { type: "module" }),
          poolSize(2))
      : null;
  }
  return pool;
}

/** A mask image's outline for clipping, per decoded image (one trace each). */
const cache = new WeakMap<ImageData, Promise<Contour>>();

/**
 * `traceContour` on a worker: a large mask is millions of pixels to walk.
 * The pixels are copied, not transferred — they are the asset's cached
 * ones. Without workers, or when one cannot start, it runs here.
 */
export function contourOffThread(pixels: ImageData): Promise<Contour> {
  let hit = cache.get(pixels);
  if (!hit) {
    hit = trace(pixels);
    cache.set(pixels, hit);
  }
  return hit;
}

async function trace(pixels: ImageData): Promise<Contour> {
  const p = contourPool();
  if (p) {
    try {
      return await p.run({ rgba: pixels.data, width: pixels.width, height: pixels.height });
    } catch (err) {
      if (!(err instanceof WorkerCrashed)) throw err;
      p.dispose();
      pool = null;
    }
  }
  return traceContour(pixels.data, pixels.width, pixels.height, { stride: 4 });
}
