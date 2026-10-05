using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Instance;

namespace BoneBurst.Constraints
{
    /// <summary>
    ///     Slider: <c>Doc/Format/Constraints.md</c> §8. Applies its animation to the applied pose.
    /// </summary>
    public static unsafe class SliderSolver
    {
        public static void Update(in InstanceHeader h, int index)
        {
            ConstraintPose* p = h.AppliedConstraints + index;
            if (p->Mix == 0) return;
            ConstraintBlob* d = h.Blob.ConstraintDatas + index;
            if (d->Animation < 0) return;
            AnimationBlob animation = h.Blob.Animations[d->Animation];
            int bone = d->Target;
            if (bone >= 0)
            {
                if (!h.BoneActive[bone]) return;
                if (d->Local) BoneSolve.ValidateLocalTransform(h, bone);
                // The slider's Offsets are all zero: property.Value reads six zeros (§8.1).
                float time = d->Offset +
                             (TransformSolver.Value(h, d->Property, bone, d->Local, d->Offsets) - d->PropertyOffset) *
                             d->Scale;
                time = d->Loop ? animation.Duration + time % animation.Duration : BoneMath.Max(0, time);
                p->Time = time;
                // An unconstrained slider's applied pose is its pose: the time persists (§8.2).
                if (!h.ConstraintConstrained[index]) h.Constraints[index].Time = time;
            }

            for (int i = 0; i < animation.BonesCount; i++)
                BoneSolve.ModifyLocal(h, h.Blob.AnimationBones[animation.BonesStart + i]);

            InstanceHeader applied = h;
            applied.Local = h.Applied;
            applied.Slots = h.AppliedSlots;
            applied.DrawOrder = h.AppliedDrawOrder;
            applied.Deform = h.AppliedDeform;
            applied.Constraints = h.AppliedConstraints;
            TimelineApply.ApplyAnimation(applied, d->Animation, p->Time, p->Time, d->Loop, p->Mix, d->Additive);
        }
    }
}