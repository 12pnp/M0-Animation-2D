using System;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst.Constraints
{
    /// <summary>
    ///     Physics constraint: <c>Doc/Format/Constraints-Path-Physics.md</c> §4, operation for operation.
    /// </summary>
    /// <remarks>
    ///     The simulation state lives in <see cref="InstanceHeader.PhysicsStates" /> and persists across frames;
    ///     skin changes and the setup pose leave it alone, as in the stock runtime.
    /// </remarks>
    public static unsafe class PhysicsSolver
    {
        /// <summary>
        ///     §4.6 <c>Reset</c>: offsets, lags and velocities to 0, the clock to the skeleton's time.
        /// </summary>
        public static void Reset(PhysicsState* s, float time)
        {
            s->Remaining = 0;
            s->LastTime = time;
            s->Reset = true;
            s->XOffset = s->XLag = s->XVelocity = 0;
            s->YOffset = s->YLag = s->YVelocity = 0;
            s->RotateOffset = s->RotateLag = s->RotateVelocity = 0;
            s->ScaleOffset = s->ScaleLag = s->ScaleVelocity = 0;
        }

        /// <summary>
        ///     §4.6 <c>Translate</c>: the bone is seen as having moved by (x, y) more.
        /// </summary>
        public static void Translate(PhysicsState* s, float x, float y)
        {
            s->Ux -= x;
            s->Uy -= y;
            s->Cx -= x;
            s->Cy -= y;
        }

        /// <summary>
        ///     §4.6 <c>Rotate</c>: the remembered centre rotated about (x, y).
        /// </summary>
        public static void Rotate(PhysicsState* s, float x, float y, float degrees)
        {
            float r = degrees * BoneMath.DegRad, cos = BoneMath.Cos(r), sin = BoneMath.Sin(r);
            float dx = s->Cx - x, dy = s->Cy - y;
            Translate(s, dx * cos - dy * sin - dx, dx * sin + dy * cos - dy);
        }

        public static void Update(in InstanceHeader h, int index, PhysicsMode physics)
        {
            ConstraintPose p = h.AppliedConstraints[index];
            float mix = p.Mix;
            if (mix == 0) return;
            ConstraintBlob* data = h.Blob.ConstraintDatas + index;
            PhysicsState* s = h.PhysicsStates + index;
            SkeletonState* skeleton = h.Skeleton;
            bool x = data->X > 0,
                y = data->Y > 0,
                rotateOrShearX = data->Rotate > 0 || data->ShearX > 0,
                scaleX = data->ScaleX > 0;
            int boneIndex = data->Target;
            BoneWorld* bone = h.World + boneIndex;
            float l = h.Blob.Bones[boneIndex].Length, t = data->Step, z = 0;

            if (physics == PhysicsMode.None) return;
            BoneSolve.ModifyWorld(h, boneIndex);
            switch (physics)
            {
                case PhysicsMode.Reset:
                    Reset(s, skeleton->Time);
                    goto case PhysicsMode.Update;
                case PhysicsMode.Update:
                {
                    float delta = BoneMath.Max(skeleton->Time - s->LastTime, 0), aa = s->Remaining;
                    s->Remaining += delta;
                    s->LastTime = skeleton->Time;

                    float bx = bone->X, by = bone->Y;
                    if (s->Reset)
                    {
                        s->Reset = false;
                        s->Ux = bx;
                        s->Uy = by;
                    }
                    else
                    {
                        float a = s->Remaining, i = p.Inertia, f = h.Blob.ReferenceScale, d = -1, m = 0, e = 0;
                        float qx = data->Limit * delta, qy = qx * Math.Abs(h.ScaleY);
                        qx *= Math.Abs(h.ScaleX);
                        if (x || y)
                        {
                            if (x)
                            {
                                float u = (s->Ux - bx) * i;
                                s->XOffset += u > qx ? qx : u < -qx ? -qx : u;
                                s->Ux = bx;
                            }

                            if (y)
                            {
                                float u = (s->Uy - by) * i;
                                s->YOffset += u > qy ? qy : u < -qy ? -qy : u;
                                s->Uy = by;
                            }

                            if (a >= t)
                            {
                                float xs = s->XOffset, ys = s->YOffset;
                                d = BoneMath.Pow(p.Damping, 60 * t);
                                m = t * p.MassInverse;
                                e = p.Strength;
                                float w = f * p.Wind, g = f * p.Gravity;
                                float ax = (w * skeleton->WindX + g * skeleton->GravityX) * h.ScaleX;
                                float ay = (w * skeleton->WindY + g * skeleton->GravityY) * h.ScaleY;
                                do
                                {
                                    if (x)
                                    {
                                        s->XVelocity += (ax - s->XOffset * e) * m;
                                        s->XOffset += s->XVelocity * t;
                                        s->XVelocity *= d;
                                    }

                                    if (y)
                                    {
                                        s->YVelocity -= (ay + s->YOffset * e) * m;
                                        s->YOffset += s->YVelocity * t;
                                        s->YVelocity *= d;
                                    }

                                    a -= t;
                                } while (a >= t);

                                s->XLag = s->XOffset - xs;
                                s->YLag = s->YOffset - ys;
                            }

                            z = BoneMath.Max(0, 1 - a / t);
                            if (x) bone->X += (s->XOffset - s->XLag * z) * mix * data->X;
                            if (y) bone->Y += (s->YOffset - s->YLag * z) * mix * data->Y;
                        }

                        if (rotateOrShearX || scaleX)
                        {
                            float ca = BoneMath.Atan2(bone->C, bone->A), c, sn, mr = 0;
                            float dx = s->Cx - bone->X, dy = s->Cy - bone->Y;
                            if (dx > qx) dx = qx;
                            else if (dx < -qx) dx = -qx;
                            if (dy > qy) dy = qy;
                            else if (dy < -qy) dy = -qy;
                            if (rotateOrShearX)
                            {
                                mr = (data->Rotate + data->ShearX) * mix;
                                z = s->RotateLag * BoneMath.Max(0, 1 - aa / t);
                                float r = BoneMath.Atan2(dy + s->Ty, dx + s->Tx) - ca - (s->RotateOffset - z) * mr;
                                s->RotateOffset += (r - BoneMath.Ceil(r * BoneMath.InvPi2 - 0.5f) * BoneMath.Pi2) * i;
                                r = (s->RotateOffset - z) * mr + ca;
                                c = BoneMath.Cos(r);
                                sn = BoneMath.Sin(r);
                                if (scaleX)
                                {
                                    r = l * WorldScaleX(bone);
                                    if (r > 0) s->ScaleOffset += (dx * c + dy * sn) * i / r;
                                }
                            }
                            else
                            {
                                c = BoneMath.Cos(ca);
                                sn = BoneMath.Sin(ca);
                                float r = l * WorldScaleX(bone) - s->ScaleLag * BoneMath.Max(0, 1 - aa / t);
                                if (r > 0) s->ScaleOffset += (dx * c + dy * sn) * i / r;
                            }

                            a = s->Remaining;
                            if (a >= t)
                            {
                                if (d == -1)
                                {
                                    d = BoneMath.Pow(p.Damping, 60 * t);
                                    m = t * p.MassInverse;
                                    e = p.Strength;
                                }

                                float ax = p.Wind * skeleton->WindX + p.Gravity * skeleton->GravityX;
                                float ay = p.Wind * skeleton->WindY + p.Gravity * skeleton->GravityY;
                                float rs = s->RotateOffset, ss = s->ScaleOffset, hl = l / f;
                                while (true)
                                {
                                    a -= t;
                                    if (scaleX)
                                    {
                                        s->ScaleVelocity += (ax * c - ay * sn - s->ScaleOffset * e) * m;
                                        s->ScaleOffset += s->ScaleVelocity * t;
                                        s->ScaleVelocity *= d;
                                    }

                                    if (rotateOrShearX)
                                    {
                                        s->RotateVelocity -= ((ax * sn + ay * c) * hl + s->RotateOffset * e) * m;
                                        s->RotateOffset += s->RotateVelocity * t;
                                        s->RotateVelocity *= d;
                                        if (a < t) break;
                                        float r = s->RotateOffset * mr + ca;
                                        c = BoneMath.Cos(r);
                                        sn = BoneMath.Sin(r);
                                    }
                                    else if (a < t)
                                    {
                                        break;
                                    }
                                }

                                s->RotateLag = s->RotateOffset - rs;
                                s->ScaleLag = s->ScaleOffset - ss;
                            }

                            z = BoneMath.Max(0, 1 - a / t);
                        }

                        s->Remaining = a;
                    }

                    s->Cx = bone->X;
                    s->Cy = bone->Y;
                    break;
                }
                case PhysicsMode.Pose:
                    z = BoneMath.Max(0, 1 - s->Remaining / t);
                    if (x) bone->X += (s->XOffset - s->XLag * z) * mix * data->X;
                    if (y) bone->Y += (s->YOffset - s->YLag * z) * mix * data->Y;
                    break;
            }

            if (rotateOrShearX)
            {
                float o = (s->RotateOffset - s->RotateLag * z) * mix, sn, c, a;
                if (data->ShearX > 0)
                {
                    float r = 0;
                    if (data->Rotate > 0)
                    {
                        r = o * data->Rotate;
                        sn = BoneMath.Sin(r);
                        c = BoneMath.Cos(r);
                        a = bone->B;
                        bone->B = c * a - sn * bone->D;
                        bone->D = sn * a + c * bone->D;
                    }

                    r += o * data->ShearX;
                    sn = BoneMath.Sin(r);
                    c = BoneMath.Cos(r);
                    a = bone->A;
                    bone->A = c * a - sn * bone->C;
                    bone->C = sn * a + c * bone->C;
                }
                else
                {
                    o *= data->Rotate;
                    sn = BoneMath.Sin(o);
                    c = BoneMath.Cos(o);
                    a = bone->A;
                    bone->A = c * a - sn * bone->C;
                    bone->C = sn * a + c * bone->C;
                    a = bone->B;
                    bone->B = c * a - sn * bone->D;
                    bone->D = sn * a + c * bone->D;
                }
            }

            if (scaleX)
            {
                float sc = 1 + (s->ScaleOffset - s->ScaleLag * z) * mix * data->ScaleX;
                bone->A *= sc;
                bone->C *= sc;
                if (data->ScaleYMode == ScaleYMode.Uniform)
                {
                    bone->B *= sc;
                    bone->D *= sc;
                }
                else if (data->ScaleYMode == ScaleYMode.Volume)
                {
                    sc = Math.Abs(sc);
                    sc = sc >= 0.7f ? 1 / sc : 4 - 3.67347f * sc;
                    bone->B *= sc;
                    bone->D *= sc;
                }
            }

            if (physics != PhysicsMode.Pose)
            {
                s->Tx = l * bone->A;
                s->Ty = l * bone->C;
            }
        }

        private static float WorldScaleX(BoneWorld* bone)
        {
            return BoneMath.Sqrt(bone->A * bone->A + bone->C * bone->C);
        }
    }
}