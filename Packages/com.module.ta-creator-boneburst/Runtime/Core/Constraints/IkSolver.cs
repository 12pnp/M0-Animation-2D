using System;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst.Constraints
{
    /// <summary>
    ///     IK constraint: <c>Doc/Format/Constraints.md</c> §6, operation for operation.
    /// </summary>
    public static unsafe class IkSolver
    {
        private const float VolumeKnee = 0.7f, VolumeA = 0.25f, VolumeB = 0.642857f;

        public static void Update(in InstanceHeader h, int index)
        {
            ConstraintPose p = h.AppliedConstraints[index];
            if (p.Mix == 0) return;
            ConstraintBlob d = h.Blob.ConstraintDatas[index];
            BoneWorld target = h.World[d.Target];
            int* bones = h.Blob.ConstraintBones + d.BonesStart;
            switch (d.BonesCount)
            {
                case 1:
                    Apply1(h, bones[0], target.X, target.Y, p.Compress, p.Stretch, d.ScaleYMode, p.Mix);
                    break;
                case 2:
                    Apply2(h, bones[0], bones[1], target.X, target.Y, p.BendDirection, p.Stretch, d.ScaleYMode,
                        p.Softness, p.Mix);
                    break;
            }
        }

        private static void Apply1(in InstanceHeader h, int boneIndex, float targetX, float targetY, bool compress,
            bool stretch, ScaleYMode scaleYMode, float mix)
        {
            BoneSolve.ModifyLocal(h, boneIndex);
            BoneLocal* bone = h.Applied + boneIndex;
            BoneWorld world = h.World[boneIndex];
            BoneWorld parent = h.World[h.Blob.Bones[boneIndex].Parent];
            float pa = parent.A, pb = parent.B, pc = parent.C, pd = parent.D;
            float rotationIK = -bone->ShearX - bone->Rotation, tx, ty;
            switch (bone->Inherit)
            {
                case Inherit.OnlyTranslation:
                    tx = (targetX - world.X) * BoneMath.Sign(h.ScaleX);
                    ty = (targetY - world.Y) * BoneMath.Sign(h.ScaleY);
                    break;
                case Inherit.NoRotationOrReflection:
                {
                    float s = Math.Abs(pa * pd - pb * pc) / BoneMath.Max(BoneMath.Epsilon, pa * pa + pc * pc);
                    float sa = pa / h.ScaleX;
                    float sc = pc / h.ScaleY;
                    pb = -sc * s * h.ScaleX;
                    pd = sa * s * h.ScaleY;
                    rotationIK += BoneMath.Atan2Deg(sc, sa);
                    goto default;
                }
                default:
                {
                    float x = targetX - parent.X, y = targetY - parent.Y;
                    float det = pa * pd - pb * pc;
                    if (Math.Abs(det) <= BoneMath.Epsilon)
                    {
                        tx = 0;
                        ty = 0;
                    }
                    else
                    {
                        tx = (x * pd - y * pb) / det - bone->X;
                        ty = (y * pa - x * pc) / det - bone->Y;
                    }

                    break;
                }
            }

            rotationIK += BoneMath.Atan2Deg(ty, tx);
            if (bone->ScaleX < 0) rotationIK += 180;
            if (rotationIK > 180) rotationIK -= 360;
            else if (rotationIK <= -180) rotationIK += 360;
            bone->Rotation += rotationIK * mix;

            if (compress || stretch)
            {
                if (bone->Inherit == Inherit.NoScale || bone->Inherit == Inherit.NoScaleOrReflection)
                {
                    tx = targetX - world.X;
                    ty = targetY - world.Y;
                }

                float b = h.Blob.Bones[boneIndex].Length * bone->ScaleX;
                if (b > BoneMath.Epsilon)
                {
                    float dd = tx * tx + ty * ty;
                    if ((compress && dd < b * b) || (stretch && dd > b * b))
                    {
                        float s = (BoneMath.Sqrt(dd) / b - 1) * mix + 1;
                        bone->ScaleX *= s;
                        ScaleY(bone, s, scaleYMode);
                    }
                }
            }
        }

        private static void ScaleY(BoneLocal* bone, float s, ScaleYMode mode)
        {
            switch (mode)
            {
                case ScaleYMode.Uniform:
                    bone->ScaleY *= s;
                    break;
                case ScaleYMode.Volume:
                    bone->ScaleY /= s < VolumeKnee ? VolumeA + VolumeB * s : s;
                    break;
            }
        }

        private static void Apply2(in InstanceHeader h, int parentIndex, int childIndex, float targetX, float targetY,
            int bendDir, bool stretch, ScaleYMode scaleYMode, float softness, float mix)
        {
            BoneLocal* parent = h.Applied + parentIndex, child = h.Applied + childIndex;
            if (parent->Inherit != Inherit.Normal || child->Inherit != Inherit.Normal) return;
            BoneSolve.ModifyLocal(h, parentIndex);
            BoneSolve.ModifyLocal(h, childIndex);

            float px = parent->X, py = parent->Y, psx = parent->ScaleX, psy = parent->ScaleY, csx = child->ScaleX;
            int os1, os2, s2;
            if (psx < 0)
            {
                psx = -psx;
                os1 = 180;
                s2 = -1;
            }
            else
            {
                os1 = 0;
                s2 = 1;
            }

            if (psy < 0)
            {
                psy = -psy;
                s2 = -s2;
            }

            if (csx < 0)
            {
                csx = -csx;
                os2 = 180;
            }
            else
            {
                os2 = 0;
            }

            BoneWorld pw = h.World[parentIndex];
            float a = pw.A, b = pw.B, c = pw.C, d = pw.D;
            bool u = Math.Abs(psx - psy) <= BoneMath.Epsilon;
            float cwx, cwy;
            if (!u || stretch)
            {
                child->Y = 0;
                cwx = a * child->X + pw.X;
                cwy = c * child->X + pw.Y;
            }
            else
            {
                cwx = a * child->X + b * child->Y + pw.X;
                cwy = c * child->X + d * child->Y + pw.Y;
            }

            BoneWorld pp = h.World[h.Blob.Bones[parentIndex].Parent];
            a = pp.A;
            b = pp.B;
            c = pp.C;
            d = pp.D;
            float id = a * d - b * c, x = cwx - pp.X, y = cwy - pp.Y;
            id = Math.Abs(id) <= BoneMath.Epsilon ? 0 : 1 / id;
            float dx = (x * d - y * b) * id - px, dy = (y * a - x * c) * id - py;
            float l1 = BoneMath.Sqrt(dx * dx + dy * dy), l2 = h.Blob.Bones[childIndex].Length * csx, a1, a2;
            if (l1 < BoneMath.Epsilon)
            {
                Apply1(h, parentIndex, targetX, targetY, false, stretch, ScaleYMode.None, mix);
                child->Rotation = 0;
                return;
            }

            x = targetX - pp.X;
            y = targetY - pp.Y;
            float tx = (x * d - y * b) * id - px, ty = (y * a - x * c) * id - py;
            float dd = tx * tx + ty * ty;
            if (softness != 0)
            {
                softness *= psx * (csx + 1) * 0.5f;
                float td = BoneMath.Sqrt(dd), sd = td - l1 - l2 * psx + softness;
                if (sd > 0)
                {
                    float p = BoneMath.Min(1, sd / (softness * 2)) - 1;
                    p = (sd - softness * (1 - p * p)) / td;
                    tx -= p * tx;
                    ty -= p * ty;
                    dd = tx * tx + ty * ty;
                }
            }

            if (u)
            {
                l2 *= psx;
                float cos = (dd - l1 * l1 - l2 * l2) / (2 * l1 * l2);
                if (cos < -1)
                {
                    cos = -1;
                    a2 = BoneMath.Pi * bendDir;
                }
                else if (cos > 1)
                {
                    cos = 1;
                    a2 = 0;
                    if (stretch)
                    {
                        a = (BoneMath.Sqrt(dd) / (l1 + l2) - 1) * mix + 1;
                        parent->ScaleX *= a;
                        ScaleY(parent, a, scaleYMode);
                    }
                }
                else
                {
                    a2 = BoneMath.Acos(cos) * bendDir;
                }

                a = l1 + l2 * cos;
                b = l2 * BoneMath.Sin(a2);
                a1 = BoneMath.Atan2(ty * a - tx * b, tx * a + ty * b);
            }
            else
            {
                a = psx * l2;
                b = psy * l2;
                float aa = a * a, bb = b * b, ta = BoneMath.Atan2(ty, tx);
                c = bb * l1 * l1 + aa * dd - aa * bb;
                float c1 = -2 * bb * l1, c2 = bb - aa;
                d = c1 * c1 - 4 * c2 * c;
                bool solved = false;
                a1 = a2 = 0;
                if (d >= 0)
                {
                    float q = BoneMath.Sqrt(d);
                    if (c1 < 0) q = -q;
                    q = -(c1 + q) * 0.5f;
                    float r0 = q / c2, r1 = c / q;
                    float r = Math.Abs(r0) < Math.Abs(r1) ? r0 : r1;
                    r0 = dd - r * r;
                    if (r0 >= 0)
                    {
                        y = BoneMath.Sqrt(r0) * bendDir;
                        a1 = ta - BoneMath.Atan2(y, r);
                        a2 = BoneMath.Atan2(y / psy, (r - l1) / psx);
                        solved = true;
                    }
                }

                if (!solved)
                {
                    float minAngle = BoneMath.Pi, minX = l1 - a, minDist = minX * minX, minY = 0;
                    float maxAngle = 0, maxX = l1 + a, maxDist = maxX * maxX, maxY = 0;
                    c = -a * l1 / (aa - bb);
                    if (c >= -1 && c <= 1)
                    {
                        c = BoneMath.Acos(c);
                        x = a * BoneMath.Cos(c) + l1;
                        y = b * BoneMath.Sin(c);
                        d = x * x + y * y;
                        if (d < minDist)
                        {
                            minAngle = c;
                            minDist = d;
                            minX = x;
                            minY = y;
                        }

                        if (d > maxDist)
                        {
                            maxAngle = c;
                            maxDist = d;
                            maxX = x;
                            maxY = y;
                        }
                    }

                    if (dd <= (minDist + maxDist) * 0.5f)
                    {
                        a1 = ta - BoneMath.Atan2(minY * bendDir, minX);
                        a2 = minAngle * bendDir;
                    }
                    else
                    {
                        a1 = ta - BoneMath.Atan2(maxY * bendDir, maxX);
                        a2 = maxAngle * bendDir;
                    }
                }
            }

            float os = BoneMath.Atan2(child->Y, child->X) * s2;
            a1 = (a1 - os) * BoneMath.RadDeg + os1 - parent->Rotation;
            if (a1 > 180) a1 -= 360;
            else if (a1 <= -180) a1 += 360;
            parent->Rotation += a1 * mix;
            a2 = ((a2 + os) * BoneMath.RadDeg - child->ShearX) * s2 + os2 - child->Rotation;
            if (a2 > 180) a2 -= 360;
            else if (a2 <= -180) a2 += 360;
            child->Rotation += a2 * mix;
        }
    }
}