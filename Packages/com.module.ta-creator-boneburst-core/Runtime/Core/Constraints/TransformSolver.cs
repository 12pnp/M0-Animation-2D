using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst.Constraints
{
    /// <summary>
    ///     Transform constraint: <c>Doc/Format/Constraints.md</c> §7, operation for operation. The slider reads its
    ///     driving bone through <see cref="Value" />.
    /// </summary>
    public static unsafe class TransformSolver
    {
        public static void Update(in InstanceHeader h, int index)
        {
            ConstraintPose p = h.AppliedConstraints[index];
            if (p.MixRotate == 0 && p.MixX == 0 && p.MixY == 0 && p.MixScaleX == 0 && p.MixScaleY == 0 &&
                p.MixShearY == 0) return;
            ConstraintBlob* d = h.Blob.ConstraintDatas + index;
            int source = d->Target;
            if (d->LocalSource) BoneSolve.ValidateLocalTransform(h, source);
            int* bones = h.Blob.ConstraintBones + d->BonesStart;
            for (int b = 0; b < d->BonesCount; b++)
            {
                int bone = bones[b];
                if (d->LocalTarget) BoneSolve.ModifyLocal(h, bone);
                else BoneSolve.ModifyWorld(h, bone);
                for (int f = 0; f < d->FromCount; f++)
                {
                    TransformFromBlob from = h.Blob.TransformFroms[d->FromStart + f];
                    float value = Value(h, from.Property, source, d->LocalSource, d->Offsets) - from.Offset;
                    for (int t = 0; t < from.ToCount; t++)
                    {
                        TransformToBlob to = h.Blob.TransformTos[from.ToStart + t];
                        if (Mix(p, to.Property) == 0) continue;
                        float clamped = to.Offset + value * to.Scale;
                        if (d->Clamp)
                            clamped = to.Offset < to.Max
                                ? Clamp(clamped, to.Offset, to.Max)
                                : Clamp(clamped, to.Max, to.Offset);

                        Apply(h, p, to.Property, bone, clamped, d->LocalTarget, d->Additive);
                    }
                }
            }
        }

        private static float Clamp(float value, float min, float max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }

        private static float Mix(in ConstraintPose p, TransformProperty property)
        {
            switch (property)
            {
                case TransformProperty.Rotate: return p.MixRotate;
                case TransformProperty.X: return p.MixX;
                case TransformProperty.Y: return p.MixY;
                case TransformProperty.ScaleX: return p.MixScaleX;
                case TransformProperty.ScaleY: return p.MixScaleY;
                default: return p.MixShearY;
            }
        }

        /// <summary>
        ///     §7.3: a From property of the source's applied pose.
        /// </summary>
        public static float Value(in InstanceHeader h, TransformProperty property, int source, bool local,
            float* offsets)
        {
            if (local)
            {
                BoneLocal l = h.Applied[source];
                switch (property)
                {
                    case TransformProperty.Rotate: return l.Rotation + offsets[0];
                    case TransformProperty.X: return l.X + offsets[1];
                    case TransformProperty.Y: return l.Y + offsets[2];
                    case TransformProperty.ScaleX: return l.ScaleX + offsets[3];
                    case TransformProperty.ScaleY: return l.ScaleY + offsets[4];
                    default: return l.ShearY + offsets[5];
                }
            }

            BoneWorld s = h.World[source];
            float sx = h.ScaleX, sy = h.ScaleY;
            switch (property)
            {
                case TransformProperty.Rotate:
                {
                    float det = (s.A * s.D - s.B * s.C) * sx * sy;
                    float v = BoneMath.Atan2(s.C / sy, s.A / sx) * BoneMath.RadDeg +
                              (det > 0 ? offsets[0] : -offsets[0]);
                    if (v < 0) v += 360;
                    return v;
                }
                case TransformProperty.X:
                    return (offsets[1] * s.A + offsets[2] * s.B + s.X) / sx;
                case TransformProperty.Y:
                    return (offsets[1] * s.C + offsets[2] * s.D + s.Y) / sy;
                case TransformProperty.ScaleX:
                {
                    float a = s.A / sx, c = s.C / sy;
                    return BoneMath.Sqrt(a * a + c * c) + offsets[3];
                }
                case TransformProperty.ScaleY:
                {
                    float b = s.B / sx, d = s.D / sy;
                    return BoneMath.Sqrt(b * b + d * d) + offsets[4];
                }
                default:
                {
                    float ix = 1 / sx, iy = 1 / sy;
                    return (BoneMath.Atan2(s.D * iy, s.B * ix) - BoneMath.Atan2(s.C * iy, s.A * ix)) *
                        BoneMath.RadDeg - 90 + offsets[5];
                }
            }
        }

        /// <summary>
        ///     §7.4: a To property onto a constrained bone.
        /// </summary>
        private static void Apply(in InstanceHeader h, in ConstraintPose p, TransformProperty property, int boneIndex,
            float value, bool local, bool additive)
        {
            float sx = h.ScaleX, sy = h.ScaleY;
            if (local)
            {
                BoneLocal* l = h.Applied + boneIndex;
                switch (property)
                {
                    case TransformProperty.Rotate:
                        l->Rotation += (additive ? value : value - l->Rotation) * p.MixRotate;
                        return;
                    case TransformProperty.X:
                        l->X += (additive ? value : value - l->X) * p.MixX;
                        return;
                    case TransformProperty.Y:
                        l->Y += (additive ? value : value - l->Y) * p.MixY;
                        return;
                    case TransformProperty.ScaleX:
                        if (additive) l->ScaleX *= 1 + (value - 1) * p.MixScaleX;
                        else if (l->ScaleX != 0) l->ScaleX += (value - l->ScaleX) * p.MixScaleX;
                        return;
                    case TransformProperty.ScaleY:
                        if (additive) l->ScaleY *= 1 + (value - 1) * p.MixScaleY;
                        else if (l->ScaleY != 0) l->ScaleY += (value - l->ScaleY) * p.MixScaleY;
                        return;
                    default:
                        if (!additive) value -= l->ShearY;
                        l->ShearY += value * p.MixShearY;
                        return;
                }
            }

            BoneWorld* w = h.World + boneIndex;
            switch (property)
            {
                case TransformProperty.Rotate:
                {
                    float ix = 1 / sx, iy = 1 / sy;
                    float a = w->A * ix, b = w->B * ix, c = w->C * iy, d = w->D * iy;
                    float v = value * BoneMath.DegRad;
                    if (!additive) v -= BoneMath.Atan2(c, a);
                    if (v > BoneMath.Pi) v -= BoneMath.Pi2;
                    else if (v < -BoneMath.Pi) v += BoneMath.Pi2;
                    v *= p.MixRotate;
                    float cs = BoneMath.Cos(v), sn = BoneMath.Sin(v);
                    w->A = (cs * a - sn * c) * sx;
                    w->B = (cs * b - sn * d) * sx;
                    w->C = (sn * a + cs * c) * sy;
                    w->D = (sn * b + cs * d) * sy;
                    return;
                }
                case TransformProperty.X:
                    if (!additive) value -= w->X / sx;
                    w->X += value * p.MixX * sx;
                    return;
                case TransformProperty.Y:
                    if (!additive) value -= w->Y / sy;
                    w->Y += value * p.MixY * sy;
                    return;
                case TransformProperty.ScaleX:
                    if (additive)
                    {
                        float s = 1 + (value - 1) * p.MixScaleX;
                        w->A *= s;
                        w->C *= s;
                    }
                    else
                    {
                        float a = w->A / sx, c = w->C / sy;
                        float s = BoneMath.Sqrt(a * a + c * c);
                        if (s != 0)
                        {
                            s = 1 + (value - s) * p.MixScaleX / s;
                            w->A *= s;
                            w->C *= s;
                        }
                    }

                    return;
                case TransformProperty.ScaleY:
                    if (additive)
                    {
                        float s = 1 + (value - 1) * p.MixScaleY;
                        w->B *= s;
                        w->D *= s;
                    }
                    else
                    {
                        float b = w->B / sx, d = w->D / sy;
                        float s = BoneMath.Sqrt(b * b + d * d);
                        if (s != 0)
                        {
                            s = 1 + (value - s) * p.MixScaleY / s;
                            w->B *= s;
                            w->D *= s;
                        }
                    }

                    return;
                default:
                {
                    float b = w->B / sx, d = w->D / sy;
                    float by = BoneMath.Atan2(d, b);
                    float v = (value + 90) * BoneMath.DegRad;
                    if (additive)
                    {
                        v -= BoneMath.HalfPi;
                    }
                    else
                    {
                        v -= by - BoneMath.Atan2(w->C / sy, w->A / sx);
                        if (v > BoneMath.Pi) v -= BoneMath.Pi2;
                        else if (v < -BoneMath.Pi) v += BoneMath.Pi2;
                    }

                    v = by + v * p.MixShearY;
                    float s = BoneMath.Sqrt(b * b + d * d);
                    w->B = BoneMath.Cos(v) * s * sx;
                    w->D = BoneMath.Sin(v) * s * sy;
                    return;
                }
            }
        }
    }
}