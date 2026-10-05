using System;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Constraints;
using BoneBurst.Data;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Mathematics;

namespace BoneBurst.Instance
{
    /// <summary>
    ///     A bone's local pose: what timelines write and the world pass reads.
    /// </summary>
    public struct BoneLocal
    {
        public float X, Y, Rotation, ScaleX, ScaleY, ShearX, ShearY;
        public Inherit Inherit;
    }

    /// <summary>
    ///     A bone's world transform in skeleton space: <c>[a b x; c d y]</c>, as Spine names it.
    /// </summary>
    public struct BoneWorld
    {
        public float A, B, C, D, X, Y;
    }

    /// <summary>
    ///     A slot's current state.
    /// </summary>
    public struct SlotState
    {
        public float4 Color;
        public float3 DarkColor;
        public bool HasDarkColor;

        /// <summary>
        ///     Index into the blob's attachments, or -1.
        /// </summary>
        public int Attachment;

        /// <summary>
        ///     Sequence frame; -1 means the attachment's setup frame.
        /// </summary>
        public int SequenceIndex;

        /// <summary>
        ///     Floats in use in this slot's deform buffer; 0 means no deform (setup vertices).
        /// </summary>
        public int DeformCount;

        /// <summary>
        ///     Attachment bookkeeping of one <c>AnimationState.Apply</c> (Timelines.md §5.5).
        /// </summary>
        public int AttachmentState;
    }

    /// <summary>
    ///     What <c>MeshJob</c> reports back per instance for the main thread to apply.
    /// </summary>
    public struct MeshOutput
    {
        public float3 Min, Max;

        /// <summary>
        ///     <c>Mesh.bounds</c> as spine-unity's <c>GetMeshBounds</c> computes it (Pose-and-Mesh.md §7.7).
        /// </summary>
        public float3 Center, Extents;

        public int VertexCount, IndexCount, SubmeshCount;

        /// <summary>
        ///     Hash of the submesh material keys; the main thread re-assigns materials only when it changes.
        /// </summary>
        public int SubmeshHash;

        /// <summary>
        ///     GPU skinning: which path this frame's mesh took (<see cref="GpuMeshState.Cpu" /> otherwise).
        /// </summary>
        public GpuMeshState Gpu;

        /// <summary>
        ///     CPU mesh: hash of everything but the vertex data (counts, index format, tint streams, submesh ends and
        ///     keys, every index). 0 means the mesh on the <c>Mesh</c> is not this path's (new, or GPU-built).
        /// </summary>
        public uint Topology;

        /// <summary>
        ///     CPU mesh: the topology equals the one already on the <c>Mesh</c>, so only the vertex data is
        ///     uploaded, into the existing buffers (no re-declared layout, indices or submeshes).
        /// </summary>
        public bool VerticesOnly;

        /// <summary>
        ///     CPU mesh: 32-bit indices (more than 65535 vertices).
        /// </summary>
        public bool WideIndices;

        /// <summary>
        ///     CPU mesh: the tint-black stream was written (the job's <see cref="InstanceHeader.TintBlack" />).
        /// </summary>
        public bool TintStream;

        /// <summary>
        ///     CPU mesh: the vertices went into the shared fetch list (<c>BoneBurstFetch</c>), not the
        ///     instance's scratch; the <c>Mesh</c> carries topology only.
        /// </summary>
        public bool Fetched;
    }

    [Flags]
    public enum InstanceFlags
    {
        None = 0,

        /// <summary>
        ///     Reset bones and slots to the setup pose before posing.
        /// </summary>
        NeedsSetupPose = 1,

        /// <summary>
        ///     Pose and mesh must be rebuilt this frame.
        /// </summary>
        Dirty = 2
    }

    /// <summary>
    ///     Everything a job needs for one instance: pointers into its <see cref="InstanceData" /> and its blob.
    ///     Fixed size, so compacting rows moves only this header.
    /// </summary>
    public unsafe struct InstanceHeader
    {
        public BlobView Blob;

        [NativeDisableUnsafePtrRestriction]
        public BoneLocal* Local;

        [NativeDisableUnsafePtrRestriction]
        public BoneWorld* World;

        [NativeDisableUnsafePtrRestriction]
        public bool* BoneActive;

        [NativeDisableUnsafePtrRestriction]
        public SlotState* Slots;

        [NativeDisableUnsafePtrRestriction]
        public int* DrawOrder;

        [NativeDisableUnsafePtrRestriction]
        public int* SubmeshKeys;

        [NativeDisableUnsafePtrRestriction]
        public int* SubmeshIndexEnd;

        [NativeDisableUnsafePtrRestriction]
        public MeshOutput* Output;

        /// <summary>
        ///     CPU mesh scratch the mesh job fills and the main thread uploads (<see cref="InstanceData" />).
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public UnsafeList<SkeletonVertex>* CpuVertices;

        [NativeDisableUnsafePtrRestriction]
        public UnsafeList<float4>* CpuTint;

        [NativeDisableUnsafePtrRestriction]
        public UnsafeList<ushort>* CpuIndices16;

        [NativeDisableUnsafePtrRestriction]
        public UnsafeList<uint>* CpuIndices32;

        /// <summary>
        ///     Vertex fetch (<c>BoneBurstFetch</c>): this instance's range in the shared vertex and tint
        ///     lists, and its size; null when the instance has no range this frame.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public SkeletonVertex* FetchVertices;

        [NativeDisableUnsafePtrRestriction]
        public float4* FetchTint;

        public int FetchCapacity;

        [NativeDisableUnsafePtrRestriction]
        public int* SetupAttachments;

        [NativeDisableUnsafePtrRestriction]
        public int* KeyAttachment;

        [NativeDisableUnsafePtrRestriction]
        public ConstraintPose* Constraints;

        [NativeDisableUnsafePtrRestriction]
        public bool* ConstraintActive;

        [NativeDisableUnsafePtrRestriction]
        public float* Deform;

        [NativeDisableUnsafePtrRestriction]
        public FiredEvent* Events;

        [NativeDisableUnsafePtrRestriction]
        public int* EventCount;

        [NativeDisableUnsafePtrRestriction]
        public int* UnkeyedState;

        public int EventCapacity;

        /// <summary>
        ///     Applied (constrained) bone locals: a copy of <see cref="Local" /> made at the start of every world
        ///     update, then edited by constraints (Constraints.md §2). <see cref="World" /> is the applied world.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public BoneLocal* Applied;

        /// <summary>
        ///     Per bone: the <c>world</c> and <c>local</c> validity counters (Constraints.md §4.2).
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public int* WorldFlags;

        [NativeDisableUnsafePtrRestriction]
        public int* LocalFlags;

        /// <summary>
        ///     Applied constraint poses, copied from <see cref="Constraints" /> each world update; sliders write them.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public ConstraintPose* AppliedConstraints;

        /// <summary>
        ///     Per constraint: a slider keys it, so its applied pose is separate from its pose.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public bool* ConstraintConstrained;

        /// <summary>
        ///     What rendering reads: the same arrays as <see cref="Slots" />, <see cref="DrawOrder" /> and
        ///     <see cref="Deform" /> unless a slider keys slots or draw order, then separate copies.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public SlotState* AppliedSlots;

        [NativeDisableUnsafePtrRestriction]
        public int* AppliedDrawOrder;

        [NativeDisableUnsafePtrRestriction]
        public float* AppliedDeform;

        /// <summary>
        ///     The update cache for the current skin: a bone index (≥ 0) or <c>~constraint</c> (&lt; 0).
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public int* Cache;

        public int CacheCount;

        [NativeDisableUnsafePtrRestriction]
        public SkeletonState* Skeleton;

        [NativeDisableUnsafePtrRestriction]
        public PhysicsState* PhysicsStates;

        /// <summary>
        ///     Path constraints' persistent positions (never cleared), and per-instance path scratch.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public float* PathPositions;

        [NativeDisableUnsafePtrRestriction]
        public float* PathScratch;

        /// <summary>
        ///     How physics steps in this frame's world update.
        /// </summary>
        public PhysicsMode Physics;

        /// <summary>
        ///     Clipping scratch (<see cref="Clipper" />) and the clipping path's per-submesh start, end and pre-active
        ///     clip (3 × (slots + 1) ints); null when the skeleton has no clipping attachment.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public float* ClipFloats;

        [NativeDisableUnsafePtrRestriction]
        public int* ClipInts;

        [NativeDisableUnsafePtrRestriction]
        public int* ClipSubmeshes;

        /// <summary>
        ///     Write the tint-black vertex streams (<c>uv2</c>, <c>uv3</c>).
        /// </summary>
        public bool TintBlack;

        /// <summary>
        ///     GPU skinning (<c>Doc/Format/GpuSkinning.md</c>): the instance's pose record base in the global pose
        ///     buffer, or -1 when it is CPU-skinned.
        /// </summary>
        public int GpuBase;

        /// <summary>
        ///     The topology key the static GPU mesh was built from (<see cref="GpuSkin.TopologySize" /> ints).
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public int* GpuTopology;

        /// <summary>
        ///     Per bone: the box of the static mesh's local positions bound to it (<see cref="GpuSkin.ReachStride" />
        ///     floats), then <see cref="GpuSkin.ReachStats" /> weight statistics.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public float* GpuReach;

        /// <summary>
        ///     Per blob attachment: its first influence in the global influence buffer, or -1 when unweighted.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public int* GpuInfluenceStart;

        /// <summary>
        ///     This frame's entry applies, in stock order (per track: mixing-out entries oldest first, then the
        ///     current one), with their per-timeline buffers.
        /// </summary>
        [NativeDisableUnsafePtrRestriction]
        public ApplyCommand* Commands;

        public int CommandCount;

        /// <summary>
        ///     The animation state applied this frame (even with no commands): run the end-of-apply reset.
        /// </summary>
        public bool ApplyRan;

        [NativeDisableUnsafePtrRestriction]
        public float* TotalAlpha;

        [NativeDisableUnsafePtrRestriction]
        public byte* Modes;

        [NativeDisableUnsafePtrRestriction]
        public float* HoldFactors;

        [NativeDisableUnsafePtrRestriction]
        public float* Rotation;

        [NativeDisableUnsafePtrRestriction]
        public int* CurrentCommand;

        public float4 Color;
        public float X, Y, ScaleX, ScaleY;
        public float ZSpacing;
        public bool PremultipliedAlpha;

        /// <summary>
        ///     The project renders in linear colour space (affects additive vertex colours only).
        /// </summary>
        public bool LinearColorSpace;

        public InstanceFlags Flags;
    }

    /// <summary>
    ///     The native memory one skeleton instance owns: pose, slots, draw order, mesh output. Allocated once when
    ///     the instance is added, freed when it is removed and no job can still read it.
    /// </summary>
    public sealed unsafe class InstanceData : IDisposable
    {
        public readonly SkeletonBlob Blob;

        // Constraint solving (P5): Constraints.md, Constraints-Path-Physics.md.
        public NativeArray<BoneLocal> Applied;
        public NativeArray<ConstraintPose> AppliedConstraints;
        public NativeArray<float> AppliedDeform;

        public NativeArray<int> AppliedDrawOrder;

        /// <summary>
        ///     Created only when a slider keys slots or draw order (<see cref="SlotsConstrained" />).
        /// </summary>
        public NativeArray<SlotState> AppliedSlots;

        public NativeArray<bool> BoneActive;

        /// <summary>
        ///     Per bone: its applied pose is the constrained pose object. Stock keeps a world transform (and
        ///     validity flags) on each of a bone's two pose objects; <see cref="World" /> holds the applied one and
        ///     these the other, swapped when an update cache changes which object applies.
        /// </summary>
        public bool[] BoneConstrained;

        public NativeList<int> Cache;

        /// <summary>
        ///     Clipping scratch; created only when the skeleton has a clipping attachment.
        /// </summary>
        public NativeArray<float> ClipFloats;

        public NativeArray<int> ClipInts, ClipSubmeshes;

        /// <summary>
        ///     This frame's commands and their per-timeline data, filled by the main thread before the pose job.
        /// </summary>
        public NativeList<ApplyCommand> Commands;

        public NativeArray<bool> ConstraintActive;
        public NativeArray<bool> ConstraintConstrained;

        public NativeArray<ConstraintPose> Constraints;

        /// <summary>
        ///     [0] events fired this frame (may exceed capacity: overflow is reported), [1] the unkeyed state counter.
        /// </summary>
        public NativeArray<int> Counters;

        public NativeList<ushort> CpuIndices16;
        public NativeList<uint> CpuIndices32;
        public NativeList<float4> CpuTint;

        /// <summary>
        ///     The CPU mesh, written by the mesh job and uploaded into the existing <c>Mesh</c> buffers on the main
        ///     thread; persistent, so an unchanged topology re-uses both these lists and the GPU buffers.
        /// </summary>
        public NativeList<SkeletonVertex> CpuVertices;

        /// <summary>
        ///     Every slot's deform buffer, at the blob's <c>SlotDeformStart</c>.
        /// </summary>
        public NativeArray<float> Deform;

        public NativeArray<int> DrawOrder;

        public NativeArray<FiredEvent> Events;

        /// <summary>
        ///     Vertex fetch (<c>BoneBurstFetch</c>): the range in the shared vertex list, and the vertex count
        ///     the last CPU mesh needed (sizes the next range).
        /// </summary>
        internal int FetchBase = -1, FetchSize, FetchGeneration, FetchNeeded;

        internal int GpuBase = -1, GpuSize, GpuGeneration;
        internal int* GpuInfluenceStart;

        public NativeArray<float> GpuReach;

        /// <summary>
        ///     GPU skinning state, created by <see cref="EnsureGpu" />: the static mesh's topology key and bone
        ///     reach, and the pose record range <c>BoneBurstGpu</c> gave this instance.
        /// </summary>
        public NativeArray<int> GpuTopology;

        public NativeList<float> HoldFactors;

        /// <summary>
        ///     Per blob attachment key: the attachment it names under the current skin, or -1.
        /// </summary>
        public NativeArray<int> KeyAttachment;

        public NativeArray<BoneLocal> Local;
        public NativeList<byte> Modes;

        public BoneWorld[] OtherWorld;
        public int[] OtherWorldFlags, OtherLocalFlags;

        public NativeArray<MeshOutput> Output;
        public NativeArray<float> PathPositions, PathScratch;
        public NativeArray<PhysicsState> PhysicsStates;
        public NativeList<float> Rotation;

        /// <summary>
        ///     Per slot: the setup attachment under the current skin.
        /// </summary>
        public NativeArray<int> SetupAttachments;

        public NativeArray<SkeletonState> Skeleton;
        public NativeArray<SlotState> Slots;

        /// <summary>
        ///     Per submesh: the index count that ends it (indices are global across submeshes).
        /// </summary>
        public NativeArray<int> SubmeshIndexEnd;

        /// <summary>
        ///     Per submesh: <c>page × 4 + blend</c>. Capacity = slot count, the most submeshes possible.
        /// </summary>
        public NativeArray<int> SubmeshKeys;

        public NativeList<float> TotalAlpha;
        public NativeArray<BoneWorld> World;
        public NativeArray<int> WorldFlags, LocalFlags;

        private int m_SkinVersion, m_DefaultSkinVersion;

        public InstanceData(SkeletonBlob blob)
        {
            Blob = blob ?? throw new ArgumentNullException(nameof(blob));
            int bones = math.max(blob.BoneCount, 1), slots = math.max(blob.SlotCount, 1);
            Local = new NativeArray<BoneLocal>(bones, Allocator.Persistent);
            World = new NativeArray<BoneWorld>(bones, Allocator.Persistent);
            BoneActive = new NativeArray<bool>(bones, Allocator.Persistent);
            Slots = new NativeArray<SlotState>(slots, Allocator.Persistent);
            DrawOrder = new NativeArray<int>(slots, Allocator.Persistent);
            SubmeshKeys = new NativeArray<int>(slots, Allocator.Persistent);
            SubmeshIndexEnd = new NativeArray<int>(slots, Allocator.Persistent);
            Output = new NativeArray<MeshOutput>(1, Allocator.Persistent);
            CpuVertices = new NativeList<SkeletonVertex>(0, Allocator.Persistent);
            CpuTint = new NativeList<float4>(0, Allocator.Persistent);
            CpuIndices16 = new NativeList<ushort>(0, Allocator.Persistent);
            CpuIndices32 = new NativeList<uint>(0, Allocator.Persistent);
            SetupAttachments = new NativeArray<int>(slots, Allocator.Persistent);
            KeyAttachment = new NativeArray<int>(math.max(blob.Content.AttachmentKeys.Length, 1), Allocator.Persistent);
            Constraints = new NativeArray<ConstraintPose>(math.max(blob.Content.ConstraintSetups.Length, 1),
                Allocator.Persistent);
            ConstraintActive = new NativeArray<bool>(math.max(blob.Content.ConstraintSetups.Length, 1),
                Allocator.Persistent);
            Deform = new NativeArray<float>(math.max(blob.Content.DeformTotal, 1), Allocator.Persistent);
            Events = new NativeArray<FiredEvent>(EventCapacityFor(blob), Allocator.Persistent);
            Counters = new NativeArray<int>(3, Allocator.Persistent);
            int constraints = math.max(blob.Content.ConstraintSetups.Length, 1);
            Applied = new NativeArray<BoneLocal>(bones, Allocator.Persistent);
            BoneConstrained = new bool[bones];
            OtherWorld = new BoneWorld[bones];
            OtherWorldFlags = new int[bones];
            OtherLocalFlags = new int[bones];
            WorldFlags = new NativeArray<int>(bones, Allocator.Persistent);
            LocalFlags = new NativeArray<int>(bones, Allocator.Persistent);
            AppliedConstraints = new NativeArray<ConstraintPose>(constraints, Allocator.Persistent);
            ConstraintConstrained = new NativeArray<bool>(constraints, Allocator.Persistent);
            Cache = new NativeList<int>(bones + constraints, Allocator.Persistent);
            Skeleton = new NativeArray<SkeletonState>(1, Allocator.Persistent);
            Skeleton[0] = SkeletonState.Initial;
            PhysicsStates = new NativeArray<PhysicsState>(constraints, Allocator.Persistent);
            for (int i = 0; i < constraints; i++) PhysicsStates[i] = PhysicsState.Initial;
            BlobContent c = blob.Content;
            PathPositions = new NativeArray<float>(math.max(c.PathPositionsTotal, 1), Allocator.Persistent);
            Clipper.Sizes(c.ClipPolygonMax, c.RenderVerticesMax, out int clipFloats, out int clipInts);
            if (clipFloats > 0)
            {
                ClipFloats = new NativeArray<float>(clipFloats, Allocator.Persistent);
                ClipInts = new NativeArray<int>(clipInts, Allocator.Persistent);
                ClipSubmeshes = new NativeArray<int>(3 * (slots + 1), Allocator.Persistent);
            }

            PathScratch = new NativeArray<float>(
                math.max(c.PathSpacesMax * 2 + c.PathCurvesMax + c.PathWorldMax, 1), Allocator.Persistent);
            Commands = new NativeList<ApplyCommand>(4, Allocator.Persistent);
            TotalAlpha = new NativeList<float>(4, Allocator.Persistent);
            Modes = new NativeList<byte>(64, Allocator.Persistent);
            HoldFactors = new NativeList<float>(0, Allocator.Persistent);
            Rotation = new NativeList<float>(0, Allocator.Persistent);
            InitializeSkin(null);
        }

        /// <summary>
        ///     The current skin's update cache constrains a slot or the draw order.
        /// </summary>
        public bool SlotsConstrained { get; private set; }

        /// <summary>
        ///     An active physics constraint exists under the current skin: the instance steps every frame.
        /// </summary>
        public bool HasPhysics { get; private set; }

        /// <summary>
        ///     The skin shown, or null (default skin only).
        /// </summary>
        public BoneBurstSkin Skin { get; private set; }

        public void Dispose()
        {
            if (!Local.IsCreated) return;

            Local.Dispose();
            World.Dispose();
            BoneActive.Dispose();
            Slots.Dispose();
            DrawOrder.Dispose();
            SubmeshKeys.Dispose();
            SubmeshIndexEnd.Dispose();
            Output.Dispose();
            CpuVertices.Dispose();
            CpuTint.Dispose();
            CpuIndices16.Dispose();
            CpuIndices32.Dispose();
            SetupAttachments.Dispose();
            KeyAttachment.Dispose();
            Constraints.Dispose();
            ConstraintActive.Dispose();
            Deform.Dispose();
            Events.Dispose();
            Counters.Dispose();
            Commands.Dispose();
            TotalAlpha.Dispose();
            Modes.Dispose();
            HoldFactors.Dispose();
            Rotation.Dispose();
            Applied.Dispose();
            WorldFlags.Dispose();
            LocalFlags.Dispose();
            AppliedConstraints.Dispose();
            ConstraintConstrained.Dispose();
            if (AppliedSlots.IsCreated)
            {
                AppliedSlots.Dispose();
                AppliedDrawOrder.Dispose();
                AppliedDeform.Dispose();
            }

            Cache.Dispose();
            Skeleton.Dispose();
            PhysicsStates.Dispose();
            PathPositions.Dispose();
            PathScratch.Dispose();
            if (ClipFloats.IsCreated)
            {
                ClipFloats.Dispose();
                ClipInts.Dispose();
                ClipSubmeshes.Dispose();
            }

            if (GpuTopology.IsCreated)
            {
                GpuTopology.Dispose();
                GpuReach.Dispose();
            }
        }

        /// <summary>
        ///     Allocates the GPU skinning state once; the topology starts unbuilt.
        /// </summary>
        public void EnsureGpu()
        {
            if (GpuTopology.IsCreated) return;
            GpuTopology = new NativeArray<int>(GpuSkin.TopologySize(Blob.SlotCount), Allocator.Persistent);
            GpuReach = new NativeArray<float>(GpuSkin.ReachSize(Blob.BoneCount), Allocator.Persistent);
        }

        /// <summary>
        ///     Forgets the static GPU mesh: the next GPU frame rebuilds it.
        /// </summary>
        public void InvalidateGpuMesh()
        {
            if (GpuTopology.IsCreated) GpuTopology[0] = 0;
        }

        /// <summary>
        ///     A fresh skeleton showing <paramref name="skin" />: the skin set, then every slot, constraint and deform
        ///     back to the setup pose (what a stock skeleton looks like right after <c>new Skeleton</c> and
        ///     <c>SetSkin</c>). Bones reset in the pose job (<see cref="InstanceFlags.NeedsSetupPose" />).
        /// </summary>
        public void InitializeSkin(BoneBurstSkin skin)
        {
            CheckSkin(skin);
            Skin = skin;
            SlotOps.Fresh(Blob.Content, Slots.AsSpan().Slice(0, Blob.SlotCount), Deform.AsSpan());
            SetupPoseSlots();
            SetupPoseConstraints();
            // After the slots: path sorting reads their attachments.
            UpdateCache();
        }

        /// <summary>
        ///     <c>Skeleton.SetSkin</c>: only slots showing the old skin's attachments switch, or on a first skin the
        ///     slots whose setup placeholder the new skin has (<c>Skins-TintBlack-Culling.md</c> §1.6). Call
        ///     <see cref="SetupPoseSlots" /> afterwards for exactly the new skin's setup attachments.
        /// </summary>
        public void SetSkin(BoneBurstSkin skin)
        {
            CheckSkin(skin);
            if (!SlotOps.SetSkin(Blob.Content, Slots.AsSpan(), Deform.AsSpan(), Skin, skin)) return;
            Skin = skin;
            UpdateCache();
        }

        /// <summary>
        ///     <c>Skeleton.SetupPoseSlots</c>: setup draw order, colours and attachments under the current skin.
        /// </summary>
        public void SetupPoseSlots()
        {
            SlotOps.SetupPoseSlots(Blob.Content, Slots.AsSpan().Slice(0, Blob.SlotCount),
                DrawOrder.AsSpan().Slice(0, Blob.SlotCount), Deform.AsSpan(), Skin);
        }

        /// <summary>
        ///     Every constraint's pose back to its setup values (the constraint half of <c>SetupPoseBones</c>).
        /// </summary>
        public void SetupPoseConstraints()
        {
            for (int i = 0; i < Blob.Content.ConstraintSetups.Length; i++)
                Constraints[i] = Blob.Content.ConstraintSetups[i];
        }

        /// <summary>
        ///     Shows <paramref name="attachment" /> (a blob attachment index, or -1) on a slot, through the stock
        ///     attachment setter.
        /// </summary>
        public void SetAttachment(int slot, int attachment)
        {
            SlotOps.SetAttachment(Blob.Content, Slots.AsSpan(), Deform.AsSpan(), slot, attachment);
        }

        /// <summary>
        ///     <c>Skeleton.UpdateCache</c> for the current skin: bone and constraint activation, attachment
        ///     resolution for timelines, and the update order. Runs on the main thread, never per frame.
        /// </summary>
        /// <remarks>
        ///     Setting a skin runs it. Call it yourself after editing the skin already shown, as in the stock
        ///     runtime.
        /// </remarks>
        public void UpdateCache()
        {
            BlobContent content = Blob.Content;
            BoneBurstSkin skin = Skin;
            bool[] active = new bool[Blob.BoneCount];
            content.BoneActivation(skin, active);
            for (int i = 0; i < active.Length; i++) BoneActive[i] = active[i];

            bool[] constraintActive = new bool[content.ConstraintInfos.Length];
            content.ConstraintActivation(skin, active, constraintActive);
            for (int i = 0; i < constraintActive.Length; i++) ConstraintActive[i] = constraintActive[i];

            ResolveAttachments();

            int[] slotAttachments = new int[Blob.SlotCount];
            for (int i = 0; i < slotAttachments.Length; i++) slotAttachments[i] = Slots[i].Attachment;
            UpdateCacheBuilder.Result result =
                UpdateCacheBuilder.Build(content, skin, active, constraintActive, slotAttachments);
            Cache.Clear();
            foreach (int entry in result.Cache) Cache.Add(entry);
            for (int i = 0; i < Blob.BoneCount; i++)
            {
                if (result.BoneConstrained[i] == BoneConstrained[i]) continue;
                BoneConstrained[i] = result.BoneConstrained[i];
                (World[i], OtherWorld[i]) = (OtherWorld[i], World[i]);
                (WorldFlags[i], OtherWorldFlags[i]) = (OtherWorldFlags[i], WorldFlags[i]);
                (LocalFlags[i], OtherLocalFlags[i]) = (OtherLocalFlags[i], LocalFlags[i]);
            }

            for (int i = 0; i < result.ConstraintConstrained.Length; i++)
                ConstraintConstrained[i] = result.ConstraintConstrained[i];

            HasPhysics = false;
            for (int i = 0; i < constraintActive.Length; i++)
                HasPhysics |= constraintActive[i] && content.ConstraintInfos[i].Kind == ConstraintKind.Physics;

            SlotsConstrained = result.SlotsConstrained;
            if (SlotsConstrained && !AppliedSlots.IsCreated)
            {
                AppliedSlots = new NativeArray<SlotState>(Slots.Length, Allocator.Persistent);
                AppliedDrawOrder = new NativeArray<int>(DrawOrder.Length, Allocator.Persistent);
                AppliedDeform = new NativeArray<float>(Deform.Length, Allocator.Persistent);
            }
        }

        /// <summary>
        ///     Re-resolves what timelines and the end-of-apply reset look up (setup and keyed attachments) when the
        ///     current or default skin was edited since. Stock resolves those through the live skin every apply;
        ///     activation and update order still wait for <see cref="UpdateCache" />, as in stock.
        /// </summary>
        public void RefreshIfSkinEdited()
        {
            BoneBurstSkin defaultSkin = Blob.Content.DefaultSkin;
            if ((Skin?.Version ?? 0) != m_SkinVersion || (defaultSkin?.Version ?? 0) != m_DefaultSkinVersion)
                ResolveAttachments();
        }

        private void ResolveAttachments()
        {
            BlobContent content = Blob.Content;
            for (int i = 0; i < Blob.SlotCount; i++) SetupAttachments[i] = content.SetupAttachment(Skin, i);

            for (int i = 0; i < content.AttachmentKeys.Length; i++)
            {
                AttachmentKey key = content.AttachmentKeys[i];
                KeyAttachment[i] = content.ResolveAttachment(Skin, key.Slot, key.Name);
            }

            m_SkinVersion = Skin?.Version ?? 0;
            m_DefaultSkinVersion = content.DefaultSkin?.Version ?? 0;
        }

        private void CheckSkin(BoneBurstSkin skin)
        {
            if (skin != null && skin.Content != Blob.Content)
                throw new ArgumentException($"skin '{skin.Name}' belongs to another skeleton", nameof(skin));
        }

        /// <summary>
        ///     Room for the events two applies in one frame can fire.
        /// </summary>
        public static int EventCapacityFor(SkeletonBlob blob)
        {
            return math.max(blob.Content.MaxEventsPerApply * 2, 4);
        }

        public InstanceHeader Header(float4 color, float scaleX, float scaleY, bool pma, InstanceFlags flags)
        {
            return new InstanceHeader
            {
                Blob = Blob.View,
                Local = (BoneLocal*)Local.GetUnsafePtr(),
                World = (BoneWorld*)World.GetUnsafePtr(),
                BoneActive = (bool*)BoneActive.GetUnsafePtr(),
                Slots = (SlotState*)Slots.GetUnsafePtr(),
                DrawOrder = (int*)DrawOrder.GetUnsafePtr(),
                SubmeshKeys = (int*)SubmeshKeys.GetUnsafePtr(),
                SubmeshIndexEnd = (int*)SubmeshIndexEnd.GetUnsafePtr(),
                SetupAttachments = (int*)SetupAttachments.GetUnsafePtr(),
                KeyAttachment = (int*)KeyAttachment.GetUnsafePtr(),
                Constraints = (ConstraintPose*)Constraints.GetUnsafePtr(),
                ConstraintActive = (bool*)ConstraintActive.GetUnsafePtr(),
                Deform = (float*)Deform.GetUnsafePtr(),
                Events = (FiredEvent*)Events.GetUnsafePtr(),
                EventCount = (int*)Counters.GetUnsafePtr(),
                UnkeyedState = (int*)Counters.GetUnsafePtr() + 1,
                CurrentCommand = (int*)Counters.GetUnsafePtr() + 2,
                Commands = Commands.GetUnsafePtr(),
                CommandCount = Commands.Length,
                TotalAlpha = TotalAlpha.GetUnsafePtr(),
                Modes = Modes.GetUnsafePtr(),
                HoldFactors = HoldFactors.GetUnsafePtr(),
                Rotation = Rotation.GetUnsafePtr(),
                EventCapacity = Events.Length,
                Output = (MeshOutput*)Output.GetUnsafePtr(),
                CpuVertices = CpuVertices.GetUnsafeList(),
                CpuTint = CpuTint.GetUnsafeList(),
                CpuIndices16 = CpuIndices16.GetUnsafeList(),
                CpuIndices32 = CpuIndices32.GetUnsafeList(),
                Applied = (BoneLocal*)Applied.GetUnsafePtr(),
                WorldFlags = (int*)WorldFlags.GetUnsafePtr(),
                LocalFlags = (int*)LocalFlags.GetUnsafePtr(),
                AppliedConstraints = (ConstraintPose*)AppliedConstraints.GetUnsafePtr(),
                ConstraintConstrained = (bool*)ConstraintConstrained.GetUnsafePtr(),
                AppliedSlots = SlotsConstrained
                    ? (SlotState*)AppliedSlots.GetUnsafePtr()
                    : (SlotState*)Slots.GetUnsafePtr(),
                AppliedDrawOrder = SlotsConstrained
                    ? (int*)AppliedDrawOrder.GetUnsafePtr()
                    : (int*)DrawOrder.GetUnsafePtr(),
                AppliedDeform = SlotsConstrained ? (float*)AppliedDeform.GetUnsafePtr() : (float*)Deform.GetUnsafePtr(),
                Cache = Cache.GetUnsafePtr(),
                CacheCount = Cache.Length,
                Skeleton = (SkeletonState*)Skeleton.GetUnsafePtr(),
                PhysicsStates = (PhysicsState*)PhysicsStates.GetUnsafePtr(),
                PathPositions = (float*)PathPositions.GetUnsafePtr(),
                PathScratch = (float*)PathScratch.GetUnsafePtr(),
                ClipFloats = ClipFloats.IsCreated ? (float*)ClipFloats.GetUnsafePtr() : null,
                ClipInts = ClipInts.IsCreated ? (int*)ClipInts.GetUnsafePtr() : null,
                ClipSubmeshes = ClipSubmeshes.IsCreated ? (int*)ClipSubmeshes.GetUnsafePtr() : null,
                Physics = PhysicsMode.Update,
                GpuBase = GpuBase,
                GpuInfluenceStart = GpuInfluenceStart,
                GpuTopology = GpuTopology.IsCreated ? (int*)GpuTopology.GetUnsafePtr() : null,
                GpuReach = GpuReach.IsCreated ? (float*)GpuReach.GetUnsafePtr() : null,
                Color = color,
                ScaleX = scaleX,
                ScaleY = scaleY,
                PremultipliedAlpha = pma,
                Flags = flags
            };
        }
    }
}