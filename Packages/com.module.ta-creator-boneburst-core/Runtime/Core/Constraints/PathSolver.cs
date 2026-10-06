using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst.Constraints
{
    /// <summary>
    ///     Path constraint: <c>Doc/Format/Constraints-Path-Physics.md</c> §3, operation for operation.
    /// </summary>
    /// <remarks>
    ///     Scratch (spaces, lengths, curves, world vertices) is shared per instance: every entry read is written
    ///     first in the same call, except <c>spaces[0]</c>, which nothing writes and stays 0. The positions buffer
    ///     is per constraint and never cleared, because Chain modes can read an entry an earlier call wrote (§3.9).
    /// </remarks>
    public static unsafe class PathSolver
    {
        private const int None = -1, Before = -2, After = -3;

        public static void Update(in InstanceHeader h, int index)
        {
            ConstraintBlob* d = h.Blob.ConstraintDatas + index;
            int slot = d->Target;
            int attachment = h.AppliedSlots[slot].Attachment;
            if (attachment < 0 || h.Blob.Attachments[attachment].Kind != AttachmentKind.Path) return;
            AttachmentBlob path = h.Blob.Attachments[attachment];
            ConstraintPose p = h.AppliedConstraints[index];
            float mixRotate = p.MixRotate, mixX = p.MixX, mixY = p.MixY;
            if (mixRotate == 0 && mixX == 0 && mixY == 0) return;

            bool tangents = d->RotateMode == RotateMode.Tangent, scale = d->RotateMode == RotateMode.ChainScale;
            int boneCount = d->BonesCount, spacesCount = tangents ? boneCount : boneCount + 1;
            int* bones = h.Blob.ConstraintBones + d->BonesStart;
            int spacesMax = h.Blob.PathSpacesMax;
            float* spaces = h.PathScratch, lengths = spaces + spacesMax;
            float spacing = p.Spacing;

            switch (d->SpacingMode)
            {
                case SpacingMode.Percent:
                    if (scale)
                        for (int i = 0, n = spacesCount - 1; i < n; i++)
                            lengths[i] = WorldLength(h, bones[i]);

                    for (int i = 1; i < spacesCount; i++) spaces[i] = spacing;
                    break;
                case SpacingMode.Proportional:
                {
                    float sum = 0;
                    for (int i = 0, n = spacesCount - 1; i < n;)
                    {
                        float setupLength = h.Blob.Bones[bones[i]].Length;
                        if (setupLength < BoneMath.Epsilon)
                        {
                            if (scale) lengths[i] = 0;
                            spaces[++i] = spacing;
                        }
                        else
                        {
                            float length = WorldLength(h, bones[i]);
                            if (scale) lengths[i] = length;
                            spaces[++i] = length;
                            sum += length;
                        }
                    }

                    if (sum > 0)
                    {
                        sum = spacesCount / sum * spacing;
                        for (int i = 1; i < spacesCount; i++) spaces[i] *= sum;
                    }

                    break;
                }
                default:
                {
                    bool lengthSpacing = d->SpacingMode == SpacingMode.Length;
                    for (int i = 0, n = spacesCount - 1; i < n;)
                    {
                        float setupLength = h.Blob.Bones[bones[i]].Length;
                        if (setupLength < BoneMath.Epsilon)
                        {
                            if (scale) lengths[i] = 0;
                            spaces[++i] = spacing;
                        }
                        else
                        {
                            float length = WorldLength(h, bones[i]);
                            if (scale) lengths[i] = length;
                            spaces[++i] = (lengthSpacing ? BoneMath.Max(0, setupLength + spacing) : spacing) *
                                length / setupLength;
                        }
                    }

                    break;
                }
            }

            float* positions = h.PathPositions + d->PositionsStart;
            ComputeWorldPositions(h, d, p.Position, slot, path, spacesCount, tangents, spaces, positions);
            float boneX = positions[0], boneY = positions[1], offsetRotation = d->OffsetRotation;
            bool tip;
            if (offsetRotation == 0)
            {
                tip = d->RotateMode == RotateMode.Chain;
            }
            else
            {
                tip = false;
                BoneWorld sb = h.World[h.Blob.Slots[slot].Bone];
                offsetRotation *= sb.A * sb.D - sb.B * sb.C > 0 ? BoneMath.DegRad : -BoneMath.DegRad;
            }

            for (int i = 0, ip = 3; i < boneCount; i++, ip += 3)
            {
                int boneIndex = bones[i];
                BoneSolve.ModifyWorld(h, boneIndex);
                BoneWorld* bone = h.World + boneIndex;
                bone->X += (boneX - bone->X) * mixX;
                bone->Y += (boneY - bone->Y) * mixY;
                float x = positions[ip], y = positions[ip + 1], dx = x - boneX, dy = y - boneY;
                if (scale)
                {
                    float length = lengths[i];
                    if (length >= BoneMath.Epsilon)
                    {
                        float s = (BoneMath.Sqrt(dx * dx + dy * dy) / length - 1) * mixRotate + 1;
                        bone->A *= s;
                        bone->C *= s;
                    }
                }

                boneX = x;
                boneY = y;
                if (mixRotate > 0)
                {
                    float a = bone->A, b = bone->B, c = bone->C, dd = bone->D, r, cos, sin;
                    if (tangents) r = positions[ip - 1];
                    else if (spaces[i + 1] < BoneMath.Epsilon) r = positions[ip + 2];
                    else r = BoneMath.Atan2(dy, dx);
                    r -= BoneMath.Atan2(c, a);
                    if (tip)
                    {
                        cos = BoneMath.Cos(r);
                        sin = BoneMath.Sin(r);
                        float length = h.Blob.Bones[boneIndex].Length;
                        boneX += (length * (cos * a - sin * c) - dx) * mixRotate;
                        boneY += (length * (sin * a + cos * c) - dy) * mixRotate;
                    }
                    else
                    {
                        r += offsetRotation;
                    }

                    if (r > BoneMath.Pi) r -= BoneMath.Pi2;
                    else if (r < -BoneMath.Pi) r += BoneMath.Pi2;
                    r *= mixRotate;
                    cos = BoneMath.Cos(r);
                    sin = BoneMath.Sin(r);
                    bone->A = cos * a - sin * c;
                    bone->B = cos * b - sin * dd;
                    bone->C = sin * a + cos * c;
                    bone->D = sin * b + cos * dd;
                }
            }
        }

        private static float WorldLength(in InstanceHeader h, int bone)
        {
            float setupLength = h.Blob.Bones[bone].Length;
            BoneWorld w = h.World[bone];
            float x = setupLength * w.A, y = setupLength * w.C;
            return BoneMath.Sqrt(x * x + y * y);
        }

        private static void ComputeWorldPositions(in InstanceHeader h, ConstraintBlob* d, float position, int slot,
            in AttachmentBlob path, int spacesCount, bool tangents, float* spaces, float* output)
        {
            int spacesMax = h.Blob.PathSpacesMax;
            float* curves = h.PathScratch + spacesMax * 2;
            float* world = curves + h.Blob.PathCurvesMax;
            bool closed = path.Closed;
            int verticesLength = path.VertexCount * 2, curveCount = verticesLength / 6, prevCurve = None;
            float pathLength, multiplier;

            if (!path.ConstantSpeed)
            {
                float* lengths = h.Blob.PathLengths + path.LengthsStart;
                curveCount -= closed ? 1 : 2;
                pathLength = lengths[curveCount];
                if (d->PositionMode == PositionMode.Percent) position *= pathLength;
                multiplier = Multiplier(d->SpacingMode, pathLength, spacesCount);
                for (int i = 0, o = 0, curve = 0; i < spacesCount; i++, o += 3)
                {
                    float space = spaces[i] * multiplier;
                    position += space;
                    float pp = position;
                    if (closed)
                    {
                        pp %= pathLength;
                        if (pp < 0) pp += pathLength;
                        curve = 0;
                    }
                    else if (pp < 0)
                    {
                        if (prevCurve != Before)
                        {
                            prevCurve = Before;
                            VertexWorld.Compute(h, slot, path, 2, 4, world, 0);
                        }

                        AddBeforePosition(pp, world, 0, output, o);
                        continue;
                    }
                    else if (pp > pathLength)
                    {
                        if (prevCurve != After)
                        {
                            prevCurve = After;
                            VertexWorld.Compute(h, slot, path, verticesLength - 6, 4, world, 0);
                        }

                        AddAfterPosition(pp - pathLength, world, 0, output, o);
                        continue;
                    }

                    for (;; curve++)
                    {
                        float length = lengths[curve];
                        if (pp > length) continue;
                        if (curve == 0)
                        {
                            pp /= length;
                        }
                        else
                        {
                            float prev = lengths[curve - 1];
                            pp = (pp - prev) / (length - prev);
                        }

                        break;
                    }

                    if (curve != prevCurve)
                    {
                        prevCurve = curve;
                        if (closed && curve == curveCount)
                        {
                            VertexWorld.Compute(h, slot, path, verticesLength - 4, 4, world, 0);
                            VertexWorld.Compute(h, slot, path, 0, 4, world, 4);
                        }
                        else
                        {
                            VertexWorld.Compute(h, slot, path, curve * 6 + 2, 8, world, 0);
                        }
                    }

                    AddCurvePosition(pp, world[0], world[1], world[2], world[3], world[4], world[5], world[6],
                        world[7], output, o, tangents || (i > 0 && space < BoneMath.Epsilon));
                }

                return;
            }

            // Constant speed: world arc lengths.
            if (closed)
            {
                verticesLength += 2;
                VertexWorld.Compute(h, slot, path, 2, verticesLength - 4, world, 0);
                VertexWorld.Compute(h, slot, path, 0, 2, world, verticesLength - 4);
                world[verticesLength - 2] = world[0];
                world[verticesLength - 1] = world[1];
            }
            else
            {
                curveCount--;
                verticesLength -= 4;
                VertexWorld.Compute(h, slot, path, 2, verticesLength, world, 0);
            }

            pathLength = 0;
            float x1 = world[0], y1 = world[1], cx1 = 0, cy1 = 0, cx2 = 0, cy2 = 0, x2 = 0, y2 = 0;
            float tmpx, tmpy, dddfx, dddfy, ddfx, ddfy, dfx, dfy;
            for (int i = 0, w = 2; i < curveCount; i++, w += 6)
            {
                cx1 = world[w];
                cy1 = world[w + 1];
                cx2 = world[w + 2];
                cy2 = world[w + 3];
                x2 = world[w + 4];
                y2 = world[w + 5];
                tmpx = (x1 - cx1 * 2 + cx2) * 0.1875f;
                tmpy = (y1 - cy1 * 2 + cy2) * 0.1875f;
                dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.09375f;
                dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.09375f;
                ddfx = tmpx * 2 + dddfx;
                ddfy = tmpy * 2 + dddfy;
                dfx = (cx1 - x1) * 0.75f + tmpx + dddfx * 0.16666667f;
                dfy = (cy1 - y1) * 0.75f + tmpy + dddfy * 0.16666667f;
                pathLength += BoneMath.Sqrt(dfx * dfx + dfy * dfy);
                dfx += ddfx;
                dfy += ddfy;
                ddfx += dddfx;
                ddfy += dddfy;
                pathLength += BoneMath.Sqrt(dfx * dfx + dfy * dfy);
                dfx += ddfx;
                dfy += ddfy;
                pathLength += BoneMath.Sqrt(dfx * dfx + dfy * dfy);
                dfx += ddfx + dddfx;
                dfy += ddfy + dddfy;
                pathLength += BoneMath.Sqrt(dfx * dfx + dfy * dfy);
                curves[i] = pathLength;
                x1 = x2;
                y1 = y2;
            }

            if (d->PositionMode == PositionMode.Percent) position *= pathLength;
            multiplier = Multiplier(d->SpacingMode, pathLength, spacesCount);

            float* segments = stackalloc float[10];
            float curveLength = 0;
            for (int i = 0, o = 0, curve = 0, segment = 0; i < spacesCount; i++, o += 3)
            {
                float space = spaces[i] * multiplier;
                position += space;
                float pp = position;
                if (closed)
                {
                    pp %= pathLength;
                    if (pp < 0) pp += pathLength;
                    curve = 0;
                    segment = 0;
                }
                else if (pp < 0)
                {
                    AddBeforePosition(pp, world, 0, output, o);
                    continue;
                }
                else if (pp > pathLength)
                {
                    AddAfterPosition(pp - pathLength, world, verticesLength - 4, output, o);
                    continue;
                }

                for (;; curve++)
                {
                    float length = curves[curve];
                    if (pp > length) continue;
                    if (curve == 0)
                    {
                        pp /= length;
                    }
                    else
                    {
                        float prev = curves[curve - 1];
                        pp = (pp - prev) / (length - prev);
                    }

                    break;
                }

                if (curve != prevCurve)
                {
                    prevCurve = curve;
                    int ii = curve * 6;
                    x1 = world[ii];
                    y1 = world[ii + 1];
                    cx1 = world[ii + 2];
                    cy1 = world[ii + 3];
                    cx2 = world[ii + 4];
                    cy2 = world[ii + 5];
                    x2 = world[ii + 6];
                    y2 = world[ii + 7];
                    tmpx = (x1 - cx1 * 2 + cx2) * 0.03f;
                    tmpy = (y1 - cy1 * 2 + cy2) * 0.03f;
                    dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.006f;
                    dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.006f;
                    ddfx = tmpx * 2 + dddfx;
                    ddfy = tmpy * 2 + dddfy;
                    dfx = (cx1 - x1) * 0.3f + tmpx + dddfx * 0.16666667f;
                    dfy = (cy1 - y1) * 0.3f + tmpy + dddfy * 0.16666667f;
                    curveLength = BoneMath.Sqrt(dfx * dfx + dfy * dfy);
                    segments[0] = curveLength;
                    for (int k = 1; k < 8; k++)
                    {
                        dfx += ddfx;
                        dfy += ddfy;
                        ddfx += dddfx;
                        ddfy += dddfy;
                        curveLength += BoneMath.Sqrt(dfx * dfx + dfy * dfy);
                        segments[k] = curveLength;
                    }

                    dfx += ddfx;
                    dfy += ddfy;
                    curveLength += BoneMath.Sqrt(dfx * dfx + dfy * dfy);
                    segments[8] = curveLength;
                    dfx += ddfx + dddfx;
                    dfy += ddfy + dddfy;
                    curveLength += BoneMath.Sqrt(dfx * dfx + dfy * dfy);
                    segments[9] = curveLength;
                    segment = 0;
                }

                pp *= curveLength;
                for (;; segment++)
                {
                    float length = segments[segment];
                    if (pp > length) continue;
                    if (segment == 0)
                    {
                        pp /= length;
                    }
                    else
                    {
                        float prev = segments[segment - 1];
                        pp = segment + (pp - prev) / (length - prev);
                    }

                    break;
                }

                AddCurvePosition(pp * 0.1f, x1, y1, cx1, cy1, cx2, cy2, x2, y2, output, o,
                    tangents || (i > 0 && space < BoneMath.Epsilon));
            }
        }

        private static float Multiplier(SpacingMode mode, float pathLength, int spacesCount)
        {
            switch (mode)
            {
                case SpacingMode.Percent: return pathLength;
                case SpacingMode.Proportional: return pathLength / spacesCount;
                default: return 1;
            }
        }

        private static void AddBeforePosition(float p, float* temp, int i, float* output, int o)
        {
            float x1 = temp[i], y1 = temp[i + 1], dx = temp[i + 2] - x1, dy = temp[i + 3] - y1;
            float r = BoneMath.Atan2(dy, dx);
            output[o] = x1 + p * BoneMath.Cos(r);
            output[o + 1] = y1 + p * BoneMath.Sin(r);
            output[o + 2] = r;
        }

        private static void AddAfterPosition(float p, float* temp, int i, float* output, int o)
        {
            float x1 = temp[i + 2], y1 = temp[i + 3], dx = x1 - temp[i], dy = y1 - temp[i + 1];
            float r = BoneMath.Atan2(dy, dx);
            output[o] = x1 + p * BoneMath.Cos(r);
            output[o + 1] = y1 + p * BoneMath.Sin(r);
            output[o + 2] = r;
        }

        private static void AddCurvePosition(float p, float x1, float y1, float cx1, float cy1, float cx2, float cy2,
            float x2, float y2, float* output, int o, bool tangents)
        {
            if (p < BoneMath.Epsilon || float.IsNaN(p))
            {
                output[o] = x1;
                output[o + 1] = y1;
                output[o + 2] = BoneMath.Atan2(cy1 - y1, cx1 - x1);
                return;
            }

            float tt = p * p, ttt = tt * p, u = 1 - p, uu = u * u, uuu = uu * u;
            float ut = u * p, ut3 = ut * 3, uut3 = u * ut3, utt3 = ut3 * p;
            float x = x1 * uuu + cx1 * uut3 + cx2 * utt3 + x2 * ttt, y = y1 * uuu + cy1 * uut3 + cy2 * utt3 + y2 * ttt;
            output[o] = x;
            output[o + 1] = y;
            if (tangents)
            {
                if (p < 0.001f)
                    output[o + 2] = BoneMath.Atan2(cy1 - y1, cx1 - x1);
                else
                    output[o + 2] = BoneMath.Atan2(y - (y1 * uu + cy1 * ut * 2 + cy2 * tt),
                        x - (x1 * uu + cx1 * ut * 2 + cx2 * tt));
            }
        }
    }
}