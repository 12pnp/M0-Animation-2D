using System;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst
{
    /// <summary>
    ///     Bone world transforms from local poses: <c>Doc/Format/Pose-and-Mesh.md</c> §3–4, operation for operation.
    /// </summary>
    /// <remarks>
    ///     Pointer-based and allocation-free so jobs call it directly and tests run it outside Unity on pinned
    ///     arrays. Every expression keeps the spec's grouping; float results depend on it.
    /// </remarks>
    public static unsafe class PoseMath
    {
        /// <summary>
        ///     Copies every bone's setup values into its local pose.
        /// </summary>
        public static void SetupPose(BoneSetup* setup, BoneLocal* local, int boneCount)
        {
            for (int i = 0; i < boneCount; i++)
            {
                BoneSetup s = setup[i];
                local[i] = new BoneLocal
                {
                    X = s.X, Y = s.Y, Rotation = s.Rotation, ScaleX = s.ScaleX, ScaleY = s.ScaleY, ShearX = s.ShearX,
                    ShearY = s.ShearY, Inherit = s.Inherit
                };
            }
        }

        // §4.2
        internal static BoneWorld Root(BoneLocal l, float skeletonX, float skeletonY, float sx, float sy)
        {
            float rx = (l.Rotation + l.ShearX) * BoneMath.DegRad;
            float ry = (l.Rotation + 90 + l.ShearY) * BoneMath.DegRad;
            return new BoneWorld
            {
                A = BoneMath.Cos(rx) * l.ScaleX * sx,
                B = BoneMath.Cos(ry) * l.ScaleY * sx,
                C = BoneMath.Sin(rx) * l.ScaleX * sy,
                D = BoneMath.Sin(ry) * l.ScaleY * sy,
                X = l.X * sx + skeletonX,
                Y = l.Y * sy + skeletonY
            };
        }

        // §4.3–4.4
        internal static BoneWorld Child(BoneLocal l, BoneWorld p, float sx, float sy)
        {
            float pa = p.A, pb = p.B, pc = p.C, pd = p.D;
            BoneWorld w = new() { X = pa * l.X + pb * l.Y + p.X, Y = pc * l.X + pd * l.Y + p.Y };

            switch (l.Inherit)
            {
                case Inherit.Normal:
                {
                    float rx = (l.Rotation + l.ShearX) * BoneMath.DegRad;
                    float ry = (l.Rotation + 90 + l.ShearY) * BoneMath.DegRad;
                    float la = BoneMath.Cos(rx) * l.ScaleX, lb = BoneMath.Cos(ry) * l.ScaleY;
                    float lc = BoneMath.Sin(rx) * l.ScaleX, ld = BoneMath.Sin(ry) * l.ScaleY;
                    w.A = pa * la + pb * lc;
                    w.B = pa * lb + pb * ld;
                    w.C = pc * la + pd * lc;
                    w.D = pc * lb + pd * ld;
                    return w;
                }
                case Inherit.OnlyTranslation:
                {
                    float rx = (l.Rotation + l.ShearX) * BoneMath.DegRad;
                    float ry = (l.Rotation + 90 + l.ShearY) * BoneMath.DegRad;
                    w.A = BoneMath.Cos(rx) * l.ScaleX * sx;
                    w.B = BoneMath.Cos(ry) * l.ScaleY * sx;
                    w.C = BoneMath.Sin(rx) * l.ScaleX * sy;
                    w.D = BoneMath.Sin(ry) * l.ScaleY * sy;
                    return w;
                }
                case Inherit.NoRotationOrReflection:
                {
                    float sxi = 1 / sx, syi = 1 / sy;
                    float qa = pa * sxi, qc = pc * syi, qb, qd, r;
                    float s = qa * qa + qc * qc;
                    if (s > BoneMath.EpsilonSq)
                    {
                        s = Math.Abs(qa * pd * syi - pb * sxi * qc) / s;
                        qb = qc * s;
                        qd = qa * s;
                        r = l.Rotation - BoneMath.Atan2Deg(qc, qa);
                    }
                    else
                    {
                        qa = 0;
                        qc = 0;
                        qb = pb;
                        qd = pd;
                        r = l.Rotation - 90 + BoneMath.Atan2Deg(pd, pb);
                    }

                    float rx = (r + l.ShearX) * BoneMath.DegRad;
                    float ry = (r + l.ShearY + 90) * BoneMath.DegRad;
                    float la = BoneMath.Cos(rx) * l.ScaleX, lb = BoneMath.Cos(ry) * l.ScaleY;
                    float lc = BoneMath.Sin(rx) * l.ScaleX, ld = BoneMath.Sin(ry) * l.ScaleY;
                    w.A = (qa * la - qb * lc) * sx;
                    w.B = (qa * lb - qb * ld) * sx;
                    w.C = (qc * la + qd * lc) * sy;
                    w.D = (qc * lb + qd * ld) * sy;
                    return w;
                }
                default: // NoScale, NoScaleOrReflection
                {
                    float sxi = 1 / sx, syi = 1 / sy;
                    float t = l.Rotation * BoneMath.DegRad;
                    float cos = BoneMath.Cos(t), sin = BoneMath.Sin(t);
                    float za = (pa * cos + pb * sin) * sxi;
                    float zc = (pc * cos + pd * sin) * syi;
                    float s = 1 / BoneMath.Sqrt(za * za + zc * zc);
                    za *= s;
                    zc *= s;
                    float zb = -zc, zd = za;
                    if (l.Inherit == Inherit.NoScale && pa * pd - pb * pc < 0 != sx < 0 != sy < 0)
                    {
                        zb = -zb;
                        zd = -zd;
                    }

                    float rx = l.ShearX * BoneMath.DegRad;
                    float ry = (90 + l.ShearY) * BoneMath.DegRad;
                    float la = BoneMath.Cos(rx) * l.ScaleX, lb = BoneMath.Cos(ry) * l.ScaleY;
                    float lc = BoneMath.Sin(rx) * l.ScaleX, ld = BoneMath.Sin(ry) * l.ScaleY;
                    w.A = (za * la + zb * lc) * sx;
                    w.B = (za * lb + zb * ld) * sx;
                    w.C = (zc * la + zd * lc) * sy;
                    w.D = (zc * lb + zd * ld) * sy;
                    return w;
                }
            }
        }
    }
}