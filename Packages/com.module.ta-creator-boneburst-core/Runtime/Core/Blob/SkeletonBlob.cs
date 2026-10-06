using System;
using System.Collections.Generic;
using BoneBurst.Anim;
using BoneBurst.Data;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Mathematics;

namespace BoneBurst.Blob
{
    /// <summary>
    ///     Setup data of one bone, as jobs read it.
    /// </summary>
    public struct BoneSetup
    {
        public float X, Y, Rotation, ScaleX, ScaleY, ShearX, ShearY;

        /// <summary>
        ///     Earlier bone, or -1 for the root.
        /// </summary>
        public int Parent;

        public Inherit Inherit;
        public bool SkinRequired;

        /// <summary>
        ///     Setup bone length (loader-scaled); IK, path and physics read it.
        /// </summary>
        public float Length;

        /// <summary>
        ///     Children in <see cref="BlobView.BoneChildren" />, in bone index order (the stock <c>children</c> list).
        /// </summary>
        public int ChildStart, ChildCount;
    }

    /// <summary>
    ///     Setup data of one slot, as jobs read it.
    /// </summary>
    public struct SlotSetup
    {
        public int Bone;
        public float4 Color;
        public float3 DarkColor;
        public bool HasDarkColor;
        public BlendMode Blend;
    }

    /// <summary>
    ///     One attachment flattened: offsets into the blob's shared arrays. Only regions and meshes render; the
    ///     other kinds are kept so constraints and queries can use them later.
    /// </summary>
    public struct AttachmentBlob
    {
        public AttachmentKind Kind;

        /// <summary>
        ///     Vertex count (4 for a region).
        /// </summary>
        public int VertexCount;

        /// <summary>
        ///     Unweighted: <c>2 × VertexCount</c> floats in <see cref="SkeletonBlob.Vertices" /> (x, y).
        ///     Weighted: <c>3 × influences</c> floats (x, y, weight), with <see cref="BonesStart" /> set.
        /// </summary>
        public int VerticesStart;

        /// <summary>
        ///     Start in <see cref="SkeletonBlob.Bones" />, or -1 when unweighted. Per vertex: an influence count, then
        ///     that many bone indices.
        /// </summary>
        public int BonesStart;

        public int TriangleStart, TriangleCount;

        /// <summary>
        ///     Sequence frames. Frame <c>k</c> has <c>2 × VertexCount</c> UV floats at
        ///     <c>UvStart + k × 2 × VertexCount</c>, and a region's 8 local offsets at <c>OffsetStart + 8k</c>.
        /// </summary>
        public int FrameCount;

        public int SetupFrame;
        public int UvStart, OffsetStart;

        /// <summary>
        ///     Atlas page of frame 0, or -1 without a region. Each frame's own page (sequences can span pages) is at
        ///     <see cref="PageStart" /> in <see cref="BlobView.FramePages" />.
        /// </summary>
        public int Page;

        public int PageStart;

        public float4 Color;

        /// <summary>
        ///     The attachment whose timelines drive this one (itself, or a linked mesh's source).
        /// </summary>
        public int TimelineAttachment;

        /// <summary>
        ///     Extra slots this attachment's deform and sequence timelines also apply to, in
        ///     <see cref="BlobView.TimelineSlots" />.
        /// </summary>
        public int TimelineSlotsStart, TimelineSlotsCount;

        /// <summary>
        ///     Path: closed, constant speed, and its cumulative setup curve lengths in
        ///     <see cref="BlobView.PathLengths" />.
        /// </summary>
        public bool Closed, ConstantSpeed;

        public int LengthsStart;

        /// <summary>
        ///     Clipping: the slot that ends the clip (-1: none), and the convex / inverse flags.
        /// </summary>
        public int ClipEndSlot;

        public bool ClipConvex, ClipInverse;
    }

    /// <summary>
    ///     The pointers and counts a job needs to read a <see cref="SkeletonBlob" />. Blittable; valid while the
    ///     blob lives.
    /// </summary>
    public unsafe struct BlobView
    {
        [NativeDisableUnsafePtrRestriction]
        public BoneSetup* Bones;

        [NativeDisableUnsafePtrRestriction]
        public SlotSetup* Slots;

        [NativeDisableUnsafePtrRestriction]
        public AttachmentBlob* Attachments;

        [NativeDisableUnsafePtrRestriction]
        public float* Vertices;

        [NativeDisableUnsafePtrRestriction]
        public int* BoneIndices;

        [NativeDisableUnsafePtrRestriction]
        public int* Triangles;

        [NativeDisableUnsafePtrRestriction]
        public float* Uvs;

        [NativeDisableUnsafePtrRestriction]
        public float* Offsets;

        [NativeDisableUnsafePtrRestriction]
        public AnimationBlob* Animations;

        [NativeDisableUnsafePtrRestriction]
        public TimelineBlob* Timelines;

        [NativeDisableUnsafePtrRestriction]
        public float* Frames;

        [NativeDisableUnsafePtrRestriction]
        public float* Curves;

        [NativeDisableUnsafePtrRestriction]
        public int* Ints;

        [NativeDisableUnsafePtrRestriction]
        public float* DeformFrames;

        [NativeDisableUnsafePtrRestriction]
        public EventBlob* Events;

        [NativeDisableUnsafePtrRestriction]
        public int* SlotDeformStart;

        [NativeDisableUnsafePtrRestriction]
        public int* SlotDeformCapacity;

        [NativeDisableUnsafePtrRestriction]
        public int* TimelineSlots;

        [NativeDisableUnsafePtrRestriction]
        public ConstraintPose* ConstraintSetups;

        [NativeDisableUnsafePtrRestriction]
        public ConstraintInfo* ConstraintInfos;

        [NativeDisableUnsafePtrRestriction]
        public int* BoneChildren;

        [NativeDisableUnsafePtrRestriction]
        public ConstraintBlob* ConstraintDatas;

        [NativeDisableUnsafePtrRestriction]
        public int* ConstraintBones;

        [NativeDisableUnsafePtrRestriction]
        public TransformFromBlob* TransformFroms;

        [NativeDisableUnsafePtrRestriction]
        public TransformToBlob* TransformTos;

        [NativeDisableUnsafePtrRestriction]
        public float* PathLengths;

        [NativeDisableUnsafePtrRestriction]
        public int* AnimationBones;

        [NativeDisableUnsafePtrRestriction]
        public int* FramePages;

        public int BoneCount, SlotCount, AttachmentCount, AnimationCount, ConstraintCount, AttachmentKeyCount;
        public int DeformTotal;

        /// <summary>
        ///     The most events one animation can fire in one apply (every key, twice when the time wraps).
        /// </summary>
        public int MaxEventsPerApply;

        /// <summary>
        ///     Physics <c>referenceScale</c> (100 × loader scale by default).
        /// </summary>
        public float ReferenceScale;

        /// <summary>
        ///     Path scratch sizes (floats): spaces, lengths, curves, world vertices; see <see cref="BlobContent" />.
        /// </summary>
        public int PathSpacesMax, PathCurvesMax, PathWorldMax, PathPositionsTotal;

        /// <summary>
        ///     Clipping scratch sizes: the largest clipping polygon (floats), the largest rendered attachment
        ///     (floats of x,y) and triangle list; the polygon size is 0 when the skeleton has no clipping.
        /// </summary>
        public int ClipPolygonMax, RenderVerticesMax, RenderTrianglesMax;
    }

    /// <summary>
    ///     The blob's content as managed arrays: what <see cref="BlobBuilder" /> produces, before it is copied into
    ///     native memory. Kept separate so the pose and mesh maths can be tested outside Unity on pinned arrays.
    /// </summary>
    public sealed class BlobContent
    {
        /// <summary>
        ///     Per animation (<see cref="AnimationBlob.BonesStart" />): the bones its bone timelines key, first
        ///     appearance first. A slider calls <c>ModifyLocal</c> on them before applying.
        /// </summary>
        public int[] AnimationBones;

        public AnimationBlob[] Animations;

        /// <summary>
        ///     The attachment each index in <see cref="Attachments" /> was built from.
        /// </summary>
        public AttachmentDef[] AttachmentDefs;

        /// <summary>
        ///     Every (slot, name) an attachment timeline can switch to; indices are what those timelines store.
        /// </summary>
        public AttachmentKey[] AttachmentKeys;

        public AttachmentBlob[] Attachments;
        public int[] BoneChildren;
        public BoneSetup[] BoneSetups;
        public int[] Bones;

        /// <summary>
        ///     Clipping scratch sizes (see <see cref="BlobView.ClipPolygonMax" />).
        /// </summary>
        public int ClipPolygonMax, RenderVerticesMax, RenderTrianglesMax;

        public int[] ConstraintBones;

        /// <summary>
        ///     Solver data (P5): per constraint, and the arrays its entries index.
        /// </summary>
        public ConstraintBlob[] ConstraintDatas;

        public ConstraintInfo[] ConstraintInfos;

        public ConstraintPose[] ConstraintSetups;
        public float[] Curves;

        public BoneBurstSkin DefaultSkin;
        public float[] DeformFrames;

        public int DeformTotal;

        /// <summary>
        ///     Strings keyed events carry; <see cref="EventBlob.String" /> indexes it (-1: null).
        /// </summary>
        public string[] EventStrings;

        public EventBlob[] Events;

        /// <summary>
        ///     Per rendered attachment and sequence frame: its atlas page (<see cref="AttachmentBlob.PageStart" />).
        /// </summary>
        public int[] FramePages;

        public float[] Frames;
        public int[] Ints;
        public int MaxEventsPerApply;

        /// <summary>
        ///     The most timelines any one animation has.
        /// </summary>
        public int MaxTimelines;

        public float[] Offsets;

        public int PageCount;
        public float[] PathLengths;

        /// <summary>
        ///     Largest spaces list (bones + 1), bone count, curve count and world-vertex buffer of any path
        ///     constraint, and the total of every path constraint's persistent positions buffer.
        /// </summary>
        public int PathSpacesMax, PathCurvesMax, PathWorldMax, PathPositionsTotal;

        /// <summary>
        ///     Indices of the physics constraints, in constraint order (stock <c>skeleton.physics</c>).
        /// </summary>
        public int[] PhysicsConstraints;

        public float ReferenceScale;

        /// <summary>
        ///     Setup attachment placeholder name per slot (null for none).
        /// </summary>
        public string[] SetupAttachmentNames;

        /// <summary>
        ///     The model the content was built from, for name lookups and later phases (timelines, constraints).
        /// </summary>
        public SkeletonDef Skeleton;

        /// <summary>
        ///     The file's skins, in file order, as <see cref="BoneBurstSkin" />s (built at load, shared by every
        ///     instance). <see cref="DefaultSkin" /> is one of them, or null.
        /// </summary>
        public BoneBurstSkin[] Skins;

        /// <summary>
        ///     Per slot: start and size of its deform buffer in an instance's deform arena (0 size: never deformed).
        /// </summary>
        public int[] SlotDeformStart, SlotDeformCapacity;

        public SlotSetup[] SlotSetups;

        /// <summary>
        ///     Per timeline (index into <see cref="Timelines" />): the property IDs it keys (Timelines.md §6), used
        ///     to decide how a replaced animation mixes out.
        /// </summary>
        public ulong[][] TimelineIds;

        /// <summary>
        ///     Per timeline: an instant timeline (attachment, draw order, inherit, sequence, event, physics reset)
        ///     is never held.
        /// </summary>
        public bool[] TimelineInstant;

        public int[] TimelineSlots;
        public TimelineBlob[] Timelines;
        public TransformFromBlob[] TransformFroms;
        public TransformToBlob[] TransformTos;
        public int[] Triangles;
        public float[] Uvs;
        public float[] Vertices;

        /// <summary>
        ///     Index of the skin named <paramref name="name" />, or -1.
        /// </summary>
        public int FindSkin(string name)
        {
            return Array.FindIndex(Skins, s => s.Name == name);
        }

        /// <summary>
        ///     The file skin named <paramref name="name" /> (first match, ordinal), or null.
        /// </summary>
        public BoneBurstSkin GetSkin(string name)
        {
            return Array.Find(Skins, s => s.Name == name);
        }

        /// <summary>
        ///     The file skin at <paramref name="index" />, or null for -1.
        /// </summary>
        public BoneBurstSkin SkinAt(int index)
        {
            return index < 0 ? null : Skins[index];
        }

        /// <summary>
        ///     Attachment index for a slot's placeholder: the given skin first, then the default skin, as Spine
        ///     resolves it (<c>Doc/Format/Pose-and-Mesh.md</c> §2.3). -1 when neither has it.
        /// </summary>
        public int ResolveAttachment(BoneBurstSkin skin, int slot, string placeholder)
        {
            if (placeholder == null) return -1;

            int index = skin?.GetAttachment(slot, placeholder) ?? -1;
            if (index >= 0) return index;
            return DefaultSkin?.GetAttachment(slot, placeholder) ?? -1;
        }

        /// <summary>
        ///     The setup-pose attachment of <paramref name="slot" /> under <paramref name="skin" />, or -1.
        /// </summary>
        public int SetupAttachment(BoneBurstSkin skin, int slot)
        {
            return ResolveAttachment(skin, slot, SetupAttachmentNames[slot]);
        }

        /// <summary>
        ///     Constraint activation (Timelines.md §1.4, Skins-TintBlack-Culling.md §1.7): the source bone is
        ///     active, and a skin-required constraint is listed by the current skin.
        /// </summary>
        public void ConstraintActivation(BoneBurstSkin skin, bool[] boneActive, bool[] active)
        {
            for (int i = 0; i < ConstraintInfos.Length; i++)
            {
                ConstraintInfo info = ConstraintInfos[i];
                bool sourceActive = info.SourceBone < 0 || boneActive[info.SourceBone];
                bool inSkin = !info.SkinRequired || (skin != null && Contains(skin.Constraints, i));
                active[i] = sourceActive && inSkin;
            }
        }

        /// <summary>
        ///     Bone activation for a skin (<c>Doc/Format/Pose-and-Mesh.md</c> §3.1): bones that do not require a
        ///     skin are active; a skin-required bone is active when the skin (never the default skin) lists it or
        ///     a descendant. A child of an inactive bone stays active and reads its parent's stale transform, as
        ///     the stock runtime does.
        /// </summary>
        public void BoneActivation(BoneBurstSkin skin, bool[] active)
        {
            BoneDef[] bones = Skeleton.Bones;
            for (int i = 0; i < bones.Length; i++) active[i] = !bones[i].SkinRequired;

            if (skin == null) return;

            foreach (int listed in skin.Bones)
                for (int b = listed; b >= 0; b = bones[b].Parent)
                    active[b] = true;
        }

        private static bool Contains(IReadOnlyList<int> list, int value)
        {
            for (int i = 0; i < list.Count; i++)
                if (list[i] == value)
                    return true;

            return false;
        }
    }

    /// <summary>
    ///     Immutable runtime data of one skeleton asset: setup pose, attachments with atlas UVs already resolved,
    ///     in persistent native arrays that every instance of the asset shares.
    /// </summary>
    /// <remarks>
    ///     Built once from a <see cref="BlobContent" />. Jobs read it through <see cref="View" />; name lookups stay
    ///     managed in <see cref="Content" /> and run only when the API is called, never per frame.
    /// </remarks>
    public sealed unsafe class SkeletonBlob : IDisposable
    {
        public readonly BlobContent Content;
        private readonly BlobView m_External;
        private readonly bool m_HasExternal;
        public NativeArray<int> AnimationBones;
        public NativeArray<AnimationBlob> Animations;
        public NativeArray<AttachmentBlob> Attachments;
        public NativeArray<int> BoneChildren;
        public NativeArray<BoneSetup> BoneSetups;
        public NativeArray<int> Bones;
        public NativeArray<int> ConstraintBones;
        public NativeArray<ConstraintBlob> ConstraintDatas;
        public NativeArray<ConstraintInfo> ConstraintInfos;
        public NativeArray<ConstraintPose> ConstraintSetups;
        public NativeArray<float> Curves;
        public NativeArray<float> DeformFrames;
        public NativeArray<EventBlob> Events;
        public NativeArray<int> FramePages;
        public NativeArray<float> Frames;
        public NativeArray<int> Ints;
        public NativeArray<float> Offsets;
        public NativeArray<float> PathLengths;
        public NativeArray<int> SlotDeformCapacity;
        public NativeArray<int> SlotDeformStart;
        public NativeArray<SlotSetup> SlotSetups;
        public NativeArray<int> TimelineSlots;
        public NativeArray<TimelineBlob> Timelines;
        public NativeArray<TransformFromBlob> TransformFroms;
        public NativeArray<TransformToBlob> TransformTos;
        public NativeArray<int> Triangles;
        public NativeArray<float> Uvs;
        public NativeArray<float> Vertices;

        /// <summary>
        ///     A blob whose arrays are owned elsewhere (an Entities BlobAsset): <see cref="View" /> returns
        ///     <paramref name="view" /> and nothing is copied or freed. The caller keeps the data alive for as long as
        ///     this object and every instance made from it are in use.
        /// </summary>
        public SkeletonBlob(BlobContent content, in BlobView view)
        {
            Content = content ?? throw new ArgumentNullException(nameof(content));
            m_External = view;
            m_HasExternal = true;
        }

        public SkeletonBlob(BlobContent content)
        {
            Content = content ?? throw new ArgumentNullException(nameof(content));
            BoneSetups = Native(content.BoneSetups);
            SlotSetups = Native(content.SlotSetups);
            Attachments = Native(content.Attachments);
            Vertices = Native(content.Vertices);
            Bones = Native(content.Bones);
            Triangles = Native(content.Triangles);
            Uvs = Native(content.Uvs);
            Offsets = Native(content.Offsets);
            Animations = Native(content.Animations);
            Timelines = Native(content.Timelines);
            Frames = Native(content.Frames);
            Curves = Native(content.Curves);
            Ints = Native(content.Ints);
            DeformFrames = Native(content.DeformFrames);
            Events = Native(content.Events);
            SlotDeformStart = Native(content.SlotDeformStart);
            SlotDeformCapacity = Native(content.SlotDeformCapacity);
            TimelineSlots = Native(content.TimelineSlots);
            ConstraintSetups = Native(content.ConstraintSetups);
            ConstraintInfos = Native(content.ConstraintInfos);
            BoneChildren = Native(content.BoneChildren);
            ConstraintDatas = Native(content.ConstraintDatas);
            ConstraintBones = Native(content.ConstraintBones);
            TransformFroms = Native(content.TransformFroms);
            TransformTos = Native(content.TransformTos);
            PathLengths = Native(content.PathLengths);
            AnimationBones = Native(content.AnimationBones);
            FramePages = Native(content.FramePages);
        }

        public SkeletonDef Skeleton => Content.Skeleton;
        public int PageCount => Content.PageCount;
        public int BoneCount => Content.BoneSetups.Length;
        public int SlotCount => Content.SlotSetups.Length;
        public bool IsCreated => m_HasExternal || BoneSetups.IsCreated;

        public BlobView View => m_HasExternal ? m_External : ViewOfArrays();

        private BlobView ViewOfArrays()
        {
            return new BlobView
            {
            Bones = (BoneSetup*)BoneSetups.GetUnsafeReadOnlyPtr(),
            Slots = (SlotSetup*)SlotSetups.GetUnsafeReadOnlyPtr(),
            Attachments = (AttachmentBlob*)Attachments.GetUnsafeReadOnlyPtr(),
            Vertices = (float*)Vertices.GetUnsafeReadOnlyPtr(),
            BoneIndices = (int*)Bones.GetUnsafeReadOnlyPtr(),
            Triangles = (int*)Triangles.GetUnsafeReadOnlyPtr(),
            Uvs = (float*)Uvs.GetUnsafeReadOnlyPtr(),
            Offsets = (float*)Offsets.GetUnsafeReadOnlyPtr(),
            Animations = (AnimationBlob*)Animations.GetUnsafeReadOnlyPtr(),
            Timelines = (TimelineBlob*)Timelines.GetUnsafeReadOnlyPtr(),
            Frames = (float*)Frames.GetUnsafeReadOnlyPtr(),
            Curves = (float*)Curves.GetUnsafeReadOnlyPtr(),
            Ints = (int*)Ints.GetUnsafeReadOnlyPtr(),
            DeformFrames = (float*)DeformFrames.GetUnsafeReadOnlyPtr(),
            Events = (EventBlob*)Events.GetUnsafeReadOnlyPtr(),
            SlotDeformStart = (int*)SlotDeformStart.GetUnsafeReadOnlyPtr(),
            SlotDeformCapacity = (int*)SlotDeformCapacity.GetUnsafeReadOnlyPtr(),
            TimelineSlots = (int*)TimelineSlots.GetUnsafeReadOnlyPtr(),
            ConstraintSetups = (ConstraintPose*)ConstraintSetups.GetUnsafeReadOnlyPtr(),
            ConstraintInfos = (ConstraintInfo*)ConstraintInfos.GetUnsafeReadOnlyPtr(),
            BoneChildren = (int*)BoneChildren.GetUnsafeReadOnlyPtr(),
            ConstraintDatas = (ConstraintBlob*)ConstraintDatas.GetUnsafeReadOnlyPtr(),
            ConstraintBones = (int*)ConstraintBones.GetUnsafeReadOnlyPtr(),
            TransformFroms = (TransformFromBlob*)TransformFroms.GetUnsafeReadOnlyPtr(),
            TransformTos = (TransformToBlob*)TransformTos.GetUnsafeReadOnlyPtr(),
            PathLengths = (float*)PathLengths.GetUnsafeReadOnlyPtr(),
            AnimationBones = (int*)AnimationBones.GetUnsafeReadOnlyPtr(),
            FramePages = (int*)FramePages.GetUnsafeReadOnlyPtr(),
            BoneCount = BoneCount,
            SlotCount = SlotCount,
            AttachmentCount = Content.Attachments.Length,
            AnimationCount = Content.Animations.Length,
            ConstraintCount = Content.Skeleton.Constraints.Length,
            AttachmentKeyCount = Content.AttachmentKeys.Length,
            DeformTotal = Content.DeformTotal,
            MaxEventsPerApply = Content.MaxEventsPerApply,
            ReferenceScale = Content.ReferenceScale,
            PathSpacesMax = Content.PathSpacesMax,
            PathCurvesMax = Content.PathCurvesMax,
            PathWorldMax = Content.PathWorldMax,
            PathPositionsTotal = Content.PathPositionsTotal,
            ClipPolygonMax = Content.ClipPolygonMax,
            RenderVerticesMax = Content.RenderVerticesMax,
            RenderTrianglesMax = Content.RenderTrianglesMax
            };
        }

        /// <summary>
        ///     The file's skins, in file order.
        /// </summary>
        public IReadOnlyList<BoneBurstSkin> Skins => Content.Skins;

        public void Dispose()
        {
            if (m_HasExternal || !BoneSetups.IsCreated) return;

            BoneSetups.Dispose();
            SlotSetups.Dispose();
            Attachments.Dispose();
            Vertices.Dispose();
            Bones.Dispose();
            Triangles.Dispose();
            Uvs.Dispose();
            Offsets.Dispose();
            Animations.Dispose();
            Timelines.Dispose();
            Frames.Dispose();
            Curves.Dispose();
            Ints.Dispose();
            DeformFrames.Dispose();
            Events.Dispose();
            SlotDeformStart.Dispose();
            SlotDeformCapacity.Dispose();
            TimelineSlots.Dispose();
            ConstraintSetups.Dispose();
            ConstraintInfos.Dispose();
            BoneChildren.Dispose();
            ConstraintDatas.Dispose();
            ConstraintBones.Dispose();
            TransformFroms.Dispose();
            TransformTos.Dispose();
            PathLengths.Dispose();
            AnimationBones.Dispose();
            FramePages.Dispose();
        }

        public int FindSkin(string name)
        {
            return Content.FindSkin(name);
        }

        /// <summary>
        ///     The file skin named <paramref name="name" />, or null. Combine skins with
        ///     <see cref="BoneBurstSkin.AddSkin" /> into a <c>new BoneBurstSkin(name, blob)</c>.
        /// </summary>
        public BoneBurstSkin GetSkin(string name)
        {
            return Content.GetSkin(name);
        }

        /// <summary>
        ///     Index of the animation named <paramref name="name" />, or -1.
        /// </summary>
        public int FindAnimation(string name)
        {
            return Array.FindIndex(Content.Skeleton.Animations, a => a.Name == name);
        }

        private static NativeArray<T> Native<T>(T[] values) where T : struct
        {
            // Zero-length arrays still get one element, so a view never holds a null pointer.
            NativeArray<T> array = new(math.max(values.Length, 1), Allocator.Persistent);
            NativeArray<T>.Copy(values, array, values.Length);
            return array;
        }
    }
}