import { type Contour, traceContour } from "@/core/atlas/contour";
import { serveWorker } from "./WorkerPool";
import type { ContourRequest } from "./contour";

serveWorker<ContourRequest, Contour>((r) => traceContour(r.rgba, r.width, r.height, { stride: 4 }), () => []);
