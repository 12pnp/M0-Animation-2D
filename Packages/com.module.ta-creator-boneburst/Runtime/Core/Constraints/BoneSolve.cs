using System;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst.Constraints
{
    /// <summary>
    ///     A bone's applied pose inside a world update: the validity counters, world from local, local from world
    ///     (<c>Doc/Format/Constraints.md</c> §4–5), operation for operation.
    /// </summary>
    /// <remarks>
    ///     <see cref="InstanceHeader.Applied" /> holds the applied locals and <see cref="InstanceHeader.World" /> the
    ///     applied world; <see cref="InstanceHeader.WorldFlags" /> / <see cref="InstanceHeader.LocalFlags" /> are
    ///     the stock <c>world</c> / <c>local</c> ints.
    /// </remarks>
    public static unsafe class BoneSolve
    {
        /// <summary>
        ///     The update-cache entry for a bone: recompute unless already current this update.
        /// </summary>
        public static void Update(in InstanceHeader h, int bone)
        {
            if (h.WorldFlags[bone] != h.Skeleton->Update) UpdateWorldTransform(h, bone);
        }

        public static void UpdateWorldTransform(in InstanceHeader h, int bone)
        {
            int u = h.Skeleton->Update;
            if (h.LocalFlags[bone] == u)
                UpdateLocalTransform(h, bone);
            else
                h.WorldFlags[bone] = u;

            int parent = h.Blob.Bones[bone].Parent;
            h.World[bone] = parent < 0
                ? PoseMath.Root(h.Applied[bone], h.X, h.Y, h.ScaleX, h.ScaleY)
                : PoseMath.Child(h.Applied[bone], h.World[parent], h.ScaleX, h.ScaleY);
        }

        public static void ValidateLocalTransform(in InstanceHeader h, int bone)
        {
            if (h.LocalFlags[bone] == h.Skeleton->Update) UpdateLocalTransform(h, bone);
        }

        /// <summary>
        ///     Before a constraint edits the local fields.
        /// </summary>
        public static void ModifyLocal(in InstanceHeader h, int bone)
        {
            int u = h.Skeleton->Update;
            if (h.LocalFlags[bone] == u) UpdateLocalTransform(h, bone);

            h.WorldFlags[bone] = 0;
            ResetWorld(h, bone, u);
        }

        /// <summary>
        ///     Before a constraint edits the world matrix.
        /// </summary>
        public static void ModifyWorld(in InstanceHeader h, int bone)
        {
            int u = h.Skeleton->Update;
            h.LocalFlags[bone] = u;
            h.WorldFlags[bone] = u;
            ResetWorld(h, bone, u);
        }

        private static void ResetWorld(in InstanceHeader h, int bone, int u)
        {
            BoneSetup s = h.Blob.Bones[bone];
            for (int k = s.ChildStart; k < s.ChildStart + s.ChildCount; k++)
            {
                int child = h.Blob.BoneChildren[k];
                if (h.WorldFlags[child] != u) continue;
                if (h.LocalFlags[child] == u) UpdateLocalTransform(h, child);
                h.WorldFlags[child] = 0;
                ResetWorld(h, child, u);
            }
        }

        /// <summary>
        ///     §5: the applied locals from the applied world matrix.
        /// </summary>
        public static void UpdateLocalTransform(in InstanceHeader h, int bone)
        {
            h.LocalFlags[bone] = 0;
            h.WorldFlags[bone] = h.Skeleton->Update;
            BoneWorld w = h.World[bone];
            BoneLocal* l = h.Applied + bone;
            float sx = h.ScaleX, sy = h.ScaleY;
            int parent = h.Blob.Bones[bone].Parent;
            if (parent < 0)
            {
                float rsxi = 1 / sx, rsyi = 1 / sy;
                l->X = (w.X - h.X) * rsxi;
                l->Y = (w.Y - h.Y) * rsyi;
                SetR(l, w.A * rsxi, w.B * rsxi, w.C * rsyi, w.D * rsyi, 0);
                return;
            }

            BoneWorld p = h.World[parent];
            float pa = p.A, pb = p.B, pc = p.C, pd = p.D;
            float pad = pa * pd - pb * pc;
            float pid = 1 / pad;
            float ia = pd * pid, ib = pb * pid, ic = pc * pid, id = pa * pid;
            float dx = w.X - p.X, dy = w.Y - p.Y;
            l->X = dx * ia - dy * ib;
            l->Y = dy * id - dx * ic;

            switch (l->Inherit)
            {
                case Inherit.Normal:
                    SetR(l, ia * w.A - ib * w.C, ia * w.B - ib * w.D, id * w.C - ic * w.A, id * w.D - ic * w.B, 0);
                    return;
                case Inherit.OnlyTranslation:
                {
                    float sxi = 1 / sx, syi = 1 / sy;
                    SetR(l, w.A * sxi, w.B * sxi, w.C * syi, w.D * syi, 0);
                    return;
                }
                case Inherit.NoRotationOrReflection:
                {
                    float sxi = 1 / sx, syi = 1 / sy;
                    float qa = pa * sxi, qc = pc * syi;
                    float wa = w.A * sxi, wb = w.B * sxi, wc = w.C * syi, wd = w.D * syi;
                    float s = 1 / (qa * qa + qc * qc);
                    float det = 1 / Math.Abs(pad * sxi * syi);
                    SetR(l, (qa * wa + qc * wc) * s, (qa * wb + qc * wd) * s, (qa * wc - qc * wa) * det,
                        (qa * wd - qc * wb) * det, BoneMath.Atan2Deg(qc, qa));
                    return;
                }
                default: // NoScale, NoScaleOrReflection
                {
                    float sxi = 1 / sx, syi = 1 / sy;
                    float wa = w.A * sxi, wb = w.B * sxi, wc = w.C * syi, wd = w.D * syi;
                    float tx = pd * w.A - pb * w.C;
                    float ty = pa * w.C - pc * w.A;
                    if (pad < 0)
                    {
                        tx = -tx;
                        ty = -ty;
                    }

                    float r = BoneMath.Atan2Deg(ty, tx);
                    l->Rotation = r;
                    r *= BoneMath.DegRad;
                    float cs = BoneMath.Cos(r), sn = BoneMath.Sin(r);
                    float za = (pa * cs + pb * sn) * sxi;
                    float zc = (pc * cs + pd * sn) * syi;
                    float k = 1 / BoneMath.Sqrt(za * za + zc * zc);
                    za *= k;
                    zc *= k;
                    float si = l->Inherit == Inherit.NoScale && pad < 0 != sx < 0 != sy < 0 ? -1 : 1;
                    SetS(l, za * wa + zc * wc, za * wb + zc * wd, (za * wc - zc * wa) * si, (za * wd - zc * wb) * si);
                    return;
                }
            }
        }

        private static void SetR(BoneLocal* l, float ra, float rb, float rc, float rd, float ro)
        {
            l->ShearX = 0;
            float x = ra * ra + rc * rc, y = rb * rb + rd * rd;
            if (x > BoneMath.EpsilonSq)
            {
                float r = BoneMath.Atan2Deg(rc, ra);
                l->Rotation = r + ro;
                l->ScaleX = BoneMath.Sqrt(x);
                l->ScaleY = BoneMath.Sqrt(y);
                if (y > BoneMath.EpsilonSq)
                {
                    float shearY = BoneMath.Atan2Deg(rd, rb);
                    if (ra * rd - rb * rc < 0)
                    {
                        l->ScaleY = -l->ScaleY;
                        shearY += 90 - r;
                    }
                    else
                    {
                        shearY -= 90 + r;
                    }

                    if (shearY > 180) shearY -= 360;
                    else if (shearY <= -180) shearY += 360;
                    l->ShearY = shearY;
                }
                else
                {
                    l->ShearY = 0;
                }
            }
            else
            {
                l->ScaleX = 0;
                l->ScaleY = BoneMath.Sqrt(y);
                l->ShearY = 0;
                l->Rotation = y > BoneMath.EpsilonSq ? BoneMath.Atan2Deg(rd, rb) - 90 + ro : ro;
            }
        }

        private static void SetS(BoneLocal* l, float ra, float rb, float rc, float rd)
        {
            float x = ra * ra + rc * rc, y = rb * rb + rd * rd;
            if (x > BoneMath.EpsilonSq)
            {
                l->ShearX = BoneMath.Atan2Deg(rc, ra);
                l->ScaleX = BoneMath.Sqrt(x);
            }
            else
            {
                l->ShearX = 0;
                l->ScaleX = 0;
            }

            l->ScaleY = BoneMath.Sqrt(y);
            if (y > BoneMath.EpsilonSq)
            {
                float shearY = BoneMath.Atan2Deg(rd, rb);
                if (ra * rd - rb * rc < 0)
                {
                    l->ScaleY = -l->ScaleY;
                    shearY += 90;
                }
                else
                {
                    shearY -= 90;
                }

                if (shearY > 180) shearY -= 360;
                else if (shearY <= -180) shearY += 360;
                l->ShearY = shearY;
            }
            else
            {
                l->ShearY = 0;
            }
        }
    }
}