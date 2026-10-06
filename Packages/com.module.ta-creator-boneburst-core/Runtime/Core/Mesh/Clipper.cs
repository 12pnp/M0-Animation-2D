namespace BoneBurst
{
    /// <summary>
    ///     Scratch memory and state of one clip: <c>SkeletonClipping</c> as <c>Doc/Format/Clipping.md</c> §1.1–3
    ///     describes it, on flat arenas sized from the blob (<see cref="Sizes" />), so it runs in Burst.
    /// </summary>
    public unsafe struct Clipper
    {
        public float* Polygon, Sorted, Polys, BufA, BufB, Frags, Verts;
        public int* Indices, Concave, Triangles, PolyFloats, PolyIdx, PolyIdxCount;

        /// <summary>
        ///     Per decomposed polygon: capacity in floats (<see cref="Polys" />) and in indices (<see cref="PolyIdx" />).
        /// </summary>
        public int PolyCap, IdxCap;

        /// <summary>
        ///     Closed convex clipping polygons of the active clip, each at <c>Polys + k × PolyCap</c> with
        ///     <c>PolyFloats[k]</c> floats.
        /// </summary>
        public int PolygonCount;

        /// <summary>
        ///     The active clip's attachment, or -1.
        /// </summary>
        public int Active;

        public int EndSlot;
        public bool Inverse;

        public bool IsClipping => Active >= 0;

        /// <summary>
        ///     Floats and ints of scratch a skeleton needs: 0 and 0 when it has no clipping attachment.
        /// </summary>
        public static void Sizes(int clipPolygonMax, int renderVerticesMax, out int floats, out int ints)
        {
            if (clipPolygonMax == 0)
            {
                floats = ints = 0;
                return;
            }

            int m = clipPolygonMax / 2 + 2, polyCap = (3 * m + 4) * 2, buf = 4 * m + 32;
            floats = (clipPolygonMax + 8) * 2 + m * polyCap + buf * 2 + m * (buf + 2) + 16 + renderVerticesMax + 8;
            ints = m * 5 + m * (3 * m + 4) + m + 16;
        }

        /// <summary>
        ///     Lays the arenas out for a skeleton; see <see cref="Sizes" />.
        /// </summary>
        public static Clipper Create(float* floats, int* ints, int clipPolygonMax, int renderVerticesMax)
        {
            Clipper c = new() { Active = -1, EndSlot = -1 };
            if (clipPolygonMax == 0) return c;
            int m = clipPolygonMax / 2 + 2, buf = 4 * m + 32;
            c.PolyCap = (3 * m + 4) * 2;
            c.IdxCap = 3 * m + 4;
            float* f = floats;
            c.Polygon = f;
            f += clipPolygonMax + 8;
            c.Sorted = f;
            f += clipPolygonMax + 8;
            c.Polys = f;
            f += m * c.PolyCap;
            c.BufA = f;
            f += buf;
            c.BufB = f;
            f += buf;
            c.Frags = f;
            f += m * (buf + 2) + 16;
            c.Verts = f;
            int* i = ints;
            c.Indices = i;
            i += m;
            c.Concave = i;
            i += m;
            c.Triangles = i;
            i += 3 * m;
            c.PolyFloats = i;
            i += m;
            c.PolyIdx = i;
            i += m * c.IdxCap;
            c.PolyIdxCount = i;
            return c;
        }

        /// <summary>
        ///     <c>ClipEnd(slot)</c>: ends the active clip when <paramref name="slot" /> is its end slot.
        /// </summary>
        public void End(int slot)
        {
            if (Active >= 0 && EndSlot == slot) End();
        }

        /// <summary>
        ///     <c>ClipEnd()</c>.
        /// </summary>
        public void End()
        {
            Active = -1;
            PolygonCount = 0;
        }

        /// <summary>
        ///     <c>ClipStart</c> (§2): ignored while a clip is active. <paramref name="n" /> floats of world vertices
        ///     are already in <see cref="Polygon" />.
        /// </summary>
        public void Start(int attachment, int n, int endSlot, bool convexFlag, bool inverse)
        {
            Active = attachment;
            EndSlot = endSlot;
            Inverse = inverse;
            bool convex = MakeClockwise(Polygon, n);
            if (convex || inverse || convexFlag)
            {
                if (!convex) n = MakeConvex(Polygon, n, Sorted);
                Polygon[n] = Polygon[0];
                Polygon[n + 1] = Polygon[1];
                n += 2;
                for (int k = 0; k < n; k++) Polys[k] = Polygon[k];
                PolyFloats[0] = n;
                PolygonCount = 1;
                return;
            }

            int triangles = Triangulate(n / 2);
            Decompose(triangles);
        }

        // §2.3
        private static bool MakeClockwise(float* p, int n)
        {
            int m = n / 2;
            bool noCw = true, noCcw = true;
            float area = 0;
            float prevX = p[n - 2], prevY = p[n - 1], currX = p[0], currY = p[1];
            for (int k = 1; k < m; k++)
            {
                float nextX = p[2 * k], nextY = p[2 * k + 1];
                area = area + (currX * nextY - nextX * currY);
                float cross = (currX - prevX) * (nextY - currY) - (currY - prevY) * (nextX - currX);
                noCcw = noCcw & (cross <= 0);
                noCw = noCw & (cross >= 0);
                prevX = currX;
                prevY = currY;
                currX = nextX;
                currY = nextY;
            }

            area = area + (currX * p[1] - p[0] * currY);
            float crossLast = (currX - prevX) * (p[1] - currY) - (currY - prevY) * (p[0] - currX);
            noCcw = noCcw & (crossLast <= 0);
            noCw = noCw & (crossLast >= 0);
            if (area >= 0)
            {
                for (int a = 0, b = m - 1; a < b; a++, b--)
                {
                    float x = p[2 * a], y = p[2 * a + 1];
                    p[2 * a] = p[2 * b];
                    p[2 * a + 1] = p[2 * b + 1];
                    p[2 * b] = x;
                    p[2 * b + 1] = y;
                }

                return noCw;
            }

            return noCcw;
        }

        // §2.4
        private static int MakeConvex(float* v, int n, float* sorted)
        {
            sorted[0] = v[0];
            sorted[1] = v[1];
            for (int i = 2; i < n; i += 2)
            {
                float x = v[i], y = v[i + 1];
                int p = i - 2;
                while (p >= 0 && (sorted[p] > x || (sorted[p] == x && sorted[p + 1] > y)))
                {
                    sorted[p + 2] = sorted[p];
                    sorted[p + 3] = sorted[p + 1];
                    p -= 2;
                }

                sorted[p + 2] = x;
                sorted[p + 3] = y;
            }

            v[0] = sorted[0];
            v[1] = sorted[1];
            v[2] = sorted[2];
            v[3] = sorted[3];
            int s = 4;
            for (int i = 4; i < n; i += 2, s += 2)
            {
                float x = sorted[i], y = sorted[i + 1];
                while (Turn(v, s, x, y) >= 0)
                {
                    s -= 2;
                    if (s == 2) break;
                }

                v[s] = x;
                v[s + 1] = y;
            }

            v[s] = sorted[n - 4];
            v[s + 1] = sorted[n - 3];
            int t = s;
            s += 2;
            for (int i = n - 6; i >= 0; i -= 2, s += 2)
            {
                float x = sorted[i], y = sorted[i + 1];
                while (Turn(v, s, x, y) >= 0)
                {
                    s -= 2;
                    if (s == t) break;
                }

                v[s] = x;
                v[s + 1] = y;
            }

            return s - 2;
        }

        private static float Turn(float* v, int s, float x, float y)
        {
            return (v[s - 2] - v[s - 4]) * (y - v[s - 3]) - (v[s - 1] - v[s - 3]) * (x - v[s - 4]);
        }

        private static bool PositiveArea(float p1x, float p1y, float p2x, float p2y, float p3x, float p3y)
        {
            return p1x * (p3y - p2y) + p2x * (p1y - p3y) + p3x * (p2y - p1y) >= 0;
        }

        private bool IsConcave(int idx, int count)
        {
            int pv = Indices[idx > 0 ? idx - 1 : count - 1],
                cu = Indices[idx],
                nx = Indices[idx + 1 < count ? idx + 1 : 0];
            float* v = Polygon;
            return !PositiveArea(v[2 * pv], v[2 * pv + 1], v[2 * cu], v[2 * cu + 1], v[2 * nx], v[2 * nx + 1]);
        }

        // §2.5: ear clipping into Triangles; returns the index count.
        private int Triangulate(int m)
        {
            float* v = Polygon;
            for (int i = 0; i < m; i++) Indices[i] = i;
            for (int i = 0; i < m; i++) Concave[i] = IsConcave(i, m) ? 1 : 0;
            int count = 0, vertexCount = m;
            while (vertexCount > 3)
            {
                int previous = vertexCount - 1, i = 0, next = 1;
                while (true)
                {
                    if (Concave[i] == 0)
                    {
                        int a = Indices[previous], b = Indices[i], c = Indices[next];
                        float p1x = v[2 * a], p1y = v[2 * a + 1], p2x = v[2 * b], p2y = v[2 * b + 1];
                        float p3x = v[2 * c], p3y = v[2 * c + 1];
                        bool blocked = false;
                        for (int ii = next + 1 < vertexCount ? next + 1 : 0; ii != previous;)
                        {
                            if (Concave[ii] != 0)
                            {
                                int w = Indices[ii];
                                float vx = v[2 * w], vy = v[2 * w + 1];
                                if (PositiveArea(p3x, p3y, p1x, p1y, vx, vy) &&
                                    PositiveArea(p1x, p1y, p2x, p2y, vx, vy) &&
                                    PositiveArea(p2x, p2y, p3x, p3y, vx, vy))
                                {
                                    blocked = true;
                                    break;
                                }
                            }

                            ii++;
                            if (ii == vertexCount) ii = 0;
                        }

                        if (!blocked) break;
                    }

                    if (next == 0)
                    {
                        do
                        {
                            if (Concave[i] == 0) break;
                            i--;
                        } while (i > 0);

                        previous = i > 0 ? i - 1 : vertexCount - 1;
                        next = i + 1 < vertexCount ? i + 1 : 0;
                        break;
                    }

                    previous = i;
                    i = next;
                    next++;
                    if (next == vertexCount) next = 0;
                }

                Triangles[count++] = Indices[previous];
                Triangles[count++] = Indices[i];
                Triangles[count++] = Indices[next];
                for (int k = i; k < vertexCount - 1; k++)
                {
                    Indices[k] = Indices[k + 1];
                    Concave[k] = Concave[k + 1];
                }

                vertexCount--;
                int previousIndex = i > 0 ? i - 1 : vertexCount - 1;
                int nextIndex = i < vertexCount ? i : 0;
                Concave[previousIndex] = IsConcave(previousIndex, vertexCount) ? 1 : 0;
                Concave[nextIndex] = IsConcave(nextIndex, vertexCount) ? 1 : 0;
            }

            if (vertexCount == 3)
            {
                Triangles[count++] = Indices[2];
                Triangles[count++] = Indices[0];
                Triangles[count++] = Indices[1];
            }

            return count;
        }

        private int Winding(float ax, float ay, float bx, float by, float cx, float cy)
        {
            return PositiveArea(ax, ay, bx, by, cx, cy) ? 1 : -1;
        }

        private void AddPoint(int poly, float x, float y)
        {
            float* p = Polys + poly * PolyCap;
            int n = PolyFloats[poly];
            p[n] = x;
            p[n + 1] = y;
            PolyFloats[poly] = n + 2;
        }

        // §2.6: triangles to closed convex polygons.
        private void Decompose(int triangleCount)
        {
            float* v = Polygon;
            int polys = 0, current = -1, fanBaseIndex = -1, lastWinding = 0;
            for (int k = 0; k < triangleCount; k += 3)
            {
                int t1 = Triangles[k], t2 = Triangles[k + 1], t3 = Triangles[k + 2];
                float ax = v[2 * t1], ay = v[2 * t1 + 1], bx = v[2 * t2], by = v[2 * t2 + 1];
                float cx = v[2 * t3], cy = v[2 * t3 + 1];
                if (current >= 0 && fanBaseIndex == t1)
                {
                    float* p = Polys + current * PolyCap;
                    int n = PolyFloats[current];
                    if (Winding(p[n - 4], p[n - 3], p[n - 2], p[n - 1], cx, cy) == lastWinding &&
                        Winding(cx, cy, p[0], p[1], p[2], p[3]) == lastWinding)
                    {
                        AddPoint(current, cx, cy);
                        PolyIdx[current * IdxCap + PolyIdxCount[current]++] = t3;
                        continue;
                    }
                }

                current = polys++;
                PolyFloats[current] = 0;
                AddPoint(current, ax, ay);
                AddPoint(current, bx, by);
                AddPoint(current, cx, cy);
                int* idx = PolyIdx + current * IdxCap;
                idx[0] = t1;
                idx[1] = t2;
                idx[2] = t3;
                PolyIdxCount[current] = 3;
                lastWinding = Winding(ax, ay, bx, by, cx, cy);
                fanBaseIndex = t1;
            }

            for (int i = 0; i < polys; i++)
            {
                int* idx = PolyIdx + i * IdxCap;
                if (PolyIdxCount[i] == 0) continue;
                int firstIndex = idx[0], lastIndex = idx[PolyIdxCount[i] - 1];
                float* p = Polys + i * PolyCap;
                int n = PolyFloats[i];
                float prevPrevX = p[n - 4], prevPrevY = p[n - 3], prevX = p[n - 2], prevY = p[n - 1];
                float firstX = p[0], firstY = p[1], secondX = p[2], secondY = p[3];
                int winding = Winding(prevPrevX, prevPrevY, prevX, prevY, firstX, firstY);
                for (int ii = 0; ii < polys; ii++)
                {
                    if (ii == i) continue;
                    if (PolyIdxCount[ii] != 3) continue;
                    int* o = PolyIdx + ii * IdxCap;
                    float* op = Polys + ii * PolyCap;
                    float x = op[PolyFloats[ii] - 2], y = op[PolyFloats[ii] - 1];
                    if (o[0] != firstIndex || o[1] != lastIndex) continue;
                    if (Winding(prevPrevX, prevPrevY, prevX, prevY, x, y) == winding &&
                        Winding(x, y, firstX, firstY, secondX, secondY) == winding)
                    {
                        PolyFloats[ii] = 0;
                        PolyIdxCount[ii] = 0;
                        AddPoint(i, x, y);
                        idx[PolyIdxCount[i]++] = o[2];
                        lastIndex = o[2];
                        prevPrevX = prevX;
                        prevPrevY = prevY;
                        prevX = x;
                        prevY = y;
                        ii = -1;
                    }
                }
            }

            // Pass 3: drop the emptied polygons (keeping creation order) and close the rest.
            int kept = 0;
            for (int i = 0; i < polys; i++)
            {
                if (PolyFloats[i] == 0) continue;
                if (kept != i)
                {
                    float* from = Polys + i * PolyCap, to = Polys + kept * PolyCap;
                    for (int k = 0; k < PolyFloats[i]; k++) to[k] = from[k];
                    PolyFloats[kept] = PolyFloats[i];
                }

                float* p = Polys + kept * PolyCap;
                AddPoint(kept, p[0], p[1]);
                kept++;
            }

            PolygonCount = kept;
        }

        /// <summary>
        ///     §3.1: one triangle against polygon <paramref name="polygon" />. Returns whether anything was cut;
        ///     <paramref name="result" /> / <paramref name="resultFloats" /> hold the piece without its closing point
        ///     (0 floats: fully outside).
        /// </summary>
        public bool Clip(float x1, float y1, float x2, float y2, float x3, float y3, int polygon, out float* result,
            out int resultFloats)
        {
            float* poly = Polys + polygon * PolyCap;
            int polyLength = PolyFloats[polygon];
            float* input = BufA, output = BufB;
            input[0] = x1;
            input[1] = y1;
            input[2] = x2;
            input[3] = y2;
            input[4] = x3;
            input[5] = y3;
            input[6] = x1;
            input[7] = y1;
            int inCount = 8, outCount = 0;
            bool clipped = false;
            int last = polyLength - 4;
            for (int i = 0;; i += 2)
            {
                float edgeX = poly[i], edgeY = poly[i + 1];
                float ex = edgeX - poly[i + 2], ey = edgeY - poly[i + 3];
                float ax = input[0], ay = input[1];
                float s1 = ey * (edgeX - ax) - ex * (edgeY - ay);
                for (int ii = 2; ii <= inCount - 2; ii += 2)
                {
                    float bx = input[ii], by = input[ii + 1];
                    float s2 = ey * (edgeX - bx) - ex * (edgeY - by);
                    if (s1 > 0)
                    {
                        if (s2 > 0)
                        {
                            output[outCount++] = bx;
                            output[outCount++] = by;
                        }
                        else
                        {
                            float ix = bx - ax, iy = by - ay, t = s1 / (ix * ey - iy * ex);
                            if (t >= 0 && t <= 1)
                            {
                                output[outCount++] = ax + ix * t;
                                output[outCount++] = ay + iy * t;
                                clipped = true;
                            }
                            else
                            {
                                output[outCount++] = bx;
                                output[outCount++] = by;
                            }
                        }
                    }
                    else if (s2 > 0)
                    {
                        float ix = bx - ax, iy = by - ay, t = s1 / (ix * ey - iy * ex);
                        if (t >= 0 && t <= 1)
                        {
                            output[outCount++] = ax + ix * t;
                            output[outCount++] = ay + iy * t;
                            output[outCount++] = bx;
                            output[outCount++] = by;
                            clipped = true;
                        }
                        else
                        {
                            output[outCount++] = bx;
                            output[outCount++] = by;
                        }
                    }
                    else
                    {
                        clipped = true;
                    }

                    ax = bx;
                    ay = by;
                    s1 = s2;
                }

                if (outCount == 0)
                {
                    result = output;
                    resultFloats = 0;
                    return true;
                }

                output[outCount] = output[0];
                output[outCount + 1] = output[1];
                outCount += 2;
                if (i == last) break;
                float* swap = input;
                input = output;
                output = swap;
                inCount = outCount;
                outCount = 0;
            }

            result = output;
            resultFloats = outCount - 2;
            return clipped;
        }

        /// <summary>
        ///     §3.3: the parts of one triangle outside polygon 0, as fragments <c>[size, x, y, …]</c> in
        ///     <see cref="Frags" />. Returns the float count used.
        /// </summary>
        public int ClipInverse(float x1, float y1, float x2, float y2, float x3, float y3)
        {
            float* poly = Polys;
            int polyLength = PolyFloats[0];
            float* input = BufA, output = BufB, frags = Frags;
            input[0] = x1;
            input[1] = y1;
            input[2] = x2;
            input[3] = y2;
            input[4] = x3;
            input[5] = y3;
            input[6] = x1;
            input[7] = y1;
            int inCount = 8, outCount = 0, fragCount = 0;
            int vLast = polyLength - 4;
            for (int i = 0;; i += 2)
            {
                float edgeX = poly[i], edgeY = poly[i + 1];
                float ex = edgeX - poly[i + 2], ey = edgeY - poly[i + 3];
                int fragmentStart = fragCount++;
                float ax = input[0], ay = input[1];
                float s1 = ey * (edgeX - ax) - ex * (edgeY - ay);
                for (int ii = 2; ii <= inCount - 2; ii += 2)
                {
                    float bx = input[ii], by = input[ii + 1];
                    float s2 = ey * (edgeX - bx) - ex * (edgeY - by);
                    if (s1 > 0)
                    {
                        if (s2 > 0)
                        {
                            output[outCount++] = bx;
                            output[outCount++] = by;
                        }
                        else
                        {
                            float ix = bx - ax, iy = by - ay, t = s1 / (ix * ey - iy * ex);
                            if (t >= 0 && t <= 1)
                            {
                                float cx = ax + ix * t, cy = ay + iy * t;
                                output[outCount++] = cx;
                                output[outCount++] = cy;
                                frags[fragCount++] = cx;
                                frags[fragCount++] = cy;
                                frags[fragCount++] = bx;
                                frags[fragCount++] = by;
                            }
                            else
                            {
                                output[outCount++] = bx;
                                output[outCount++] = by;
                            }
                        }
                    }
                    else if (s2 > 0)
                    {
                        float ix = bx - ax, iy = by - ay, t = s1 / (ix * ey - iy * ex);
                        if (t >= 0 && t <= 1)
                        {
                            float cx = ax + ix * t, cy = ay + iy * t;
                            frags[fragCount++] = cx;
                            frags[fragCount++] = cy;
                            output[outCount++] = cx;
                            output[outCount++] = cy;
                            output[outCount++] = bx;
                            output[outCount++] = by;
                        }
                        else
                        {
                            output[outCount++] = bx;
                            output[outCount++] = by;
                        }
                    }
                    else
                    {
                        frags[fragCount++] = bx;
                        frags[fragCount++] = by;
                    }

                    ax = bx;
                    ay = by;
                    s1 = s2;
                }

                int fragmentSize = fragCount - fragmentStart - 1;
                if (fragmentSize >= 6) frags[fragmentStart] = fragmentSize;
                else fragCount = fragmentStart;
                if (outCount == 0) break;
                output[outCount] = output[0];
                output[outCount + 1] = output[1];
                outCount += 2;
                if (i == vLast) break;
                float* swap = input;
                input = output;
                output = swap;
                inCount = outCount;
                outCount = 0;
            }

            return fragCount;
        }
    }
}