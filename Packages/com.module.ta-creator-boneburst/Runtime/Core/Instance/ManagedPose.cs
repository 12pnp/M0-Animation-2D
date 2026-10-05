using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Constraints;
using Unity.Mathematics;

namespace BoneBurst.Instance
{
    /// <summary>
    ///     Runs the same <see cref="TimelineApply" />, <see cref="SkeletonUpdate" /> and <see cref="MeshBuilder" /> code
    ///     as the pose and mesh jobs, synchronously on managed arrays: no job system, no Burst.
    /// </summary>
    /// <remarks>
    ///     For parity tests (the reference result Burst output is compared against) and for one-off work outside
    ///     the frame, such as an Editor preview. Never per frame at runtime; that is what the system is for.
    ///     <para>
    ///         The code under test takes pointers. Each call copies the instance arrays into unmanaged memory and
    ///         back, rather than pinning them: Mono refuses to pin arrays whose element type holds a <c>bool</c>.
    ///         The immutable blob is copied once per pose object.
    ///     </para>
    /// </remarks>
    public sealed unsafe class ManagedPose : IDisposable
    {
        /// <summary>
        ///     Applied (constrained) locals after the last world update.
        /// </summary>
        public readonly BoneLocal[] Applied;

        public readonly ConstraintPose[] AppliedConstraints;
        public readonly bool[] BoneActive;

        /// <summary>
        ///     As <see cref="InstanceData.BoneConstrained" /> and the other pose object's world and flags.
        /// </summary>
        public readonly bool[] BoneConstrained;

        public readonly bool[] ConstraintActive;
        public readonly bool[] ConstraintConstrained;
        public readonly ConstraintPose[] Constraints;
        public readonly BlobContent Content;

        /// <summary>
        ///     [0] events fired by the last <see cref="Pose" />, [1] the attachment epoch, [2] current command.
        /// </summary>
        public readonly int[] Counters = new int[3];

        public readonly float[] Deform;
        public readonly int[] DrawOrder;
        public readonly FiredEvent[] Events;

        public readonly int[] GpuInfluenceStart;

        /// <summary>
        ///     GPU skinning, as <c>GpuJob</c> and <c>LateMeshJob</c> run it (<see cref="GpuFrame" />): the influence
        ///     buffer (this blob alone, base 0), the pose record, and the static mesh.
        /// </summary>
        public readonly float4[] GpuInfluences;

        public readonly float[] GpuReach;
        public readonly int[] GpuTopology;
        public readonly int[] KeyAttachment;
        public readonly BoneLocal[] Local;

        public readonly BoneWorld[] OtherWorld;
        public readonly int[] OtherWorldFlags, OtherLocalFlags;
        public readonly float[] PathPositions, PathScratch;
        public readonly PhysicsState[] PhysicsStates;
        public readonly int[] SetupAttachments;

        public readonly SkeletonState[] Skeleton = { SkeletonState.Initial };
        public readonly SlotState[] Slots;

        public readonly BoneWorld[] World;
        public readonly int[] WorldFlags, LocalFlags;
        private readonly List<IntPtr> m_BlobMemory = new();
        private readonly float[] m_ClipFloats;
        private readonly int[] m_ClipInts, m_ClipSubmeshes;

        private readonly BlobView m_View;
        public float[] AppliedDeform;

        public int[] AppliedDrawOrder;

        /// <summary>
        ///     Slider-applied slots, draw order and deform when a slider keys them; otherwise the pose arrays.
        /// </summary>
        public SlotState[] AppliedSlots;

        /// <summary>
        ///     The update cache for the current skin (see <see cref="UpdateCacheBuilder" />).
        /// </summary>
        public int[] Cache = Array.Empty<int>();

        /// <summary>
        ///     Mesh bounds as the component applies them (<see cref="MeshBuilder.Bounds" />).
        /// </summary>
        public float3 Center, Extents;

        public float4 Color = new(1, 1, 1, 1);
        public MeshCounts Counts;
        public MeshCounts GpuCounts;
        public uint[] GpuIndices = Array.Empty<uint>();
        public float4[] GpuRecord = Array.Empty<float4>();
        public float4[] GpuSkinData = Array.Empty<float4>();

        /// <summary>
        ///     The last <see cref="GpuFrame" />'s path: <see cref="GpuMeshState.Built" />,
        ///     <see cref="GpuMeshState.Reused" /> or <see cref="GpuMeshState.NeedsCpu" />.
        /// </summary>
        public GpuMeshState GpuState;

        public SkeletonVertex[] GpuVertices = Array.Empty<SkeletonVertex>();
        public uint[] Indices = Array.Empty<uint>();
        public bool LinearColorSpace = true;
        public float3 Min, Max;

        /// <summary>
        ///     Rotation memory after the last <see cref="Pose" />, laid out as the command buffer's.
        /// </summary>
        public float[] Rotation = Array.Empty<float>();

        public float ScaleX = 1, ScaleY = 1, ZSpacing;
        public int[] SubmeshKeys, SubmeshIndexEnd;

        public float4[] Tint = Array.Empty<float4>();

        /// <summary>
        ///     Write tint black (<see cref="Tint" />: <c>uv2.xy, uv3.xy</c> per vertex).
        /// </summary>
        public bool TintBlack;

        /// <summary>
        ///     Per command of the last <see cref="Pose" />: the total alpha it applied with.
        /// </summary>
        public float[] TotalAlpha = Array.Empty<float>();

        public SkeletonVertex[] Vertices = Array.Empty<SkeletonVertex>();

        private int m_SkinVersion, m_DefaultSkinVersion;

        public ManagedPose(BlobContent content, int skin = -1)
        {
            Content = content ?? throw new ArgumentNullException(nameof(content));
            int bones = content.BoneSetups.Length, slots = content.SlotSetups.Length;
            int constraints = content.ConstraintSetups.Length;
            Local = new BoneLocal[bones];
            Applied = new BoneLocal[bones];
            World = new BoneWorld[bones];
            WorldFlags = new int[bones];
            LocalFlags = new int[bones];
            BoneConstrained = new bool[bones];
            OtherWorld = new BoneWorld[bones];
            OtherWorldFlags = new int[bones];
            OtherLocalFlags = new int[bones];
            BoneActive = new bool[bones];
            Slots = new SlotState[slots];
            DrawOrder = new int[slots];
            SetupAttachments = new int[slots];
            KeyAttachment = new int[content.AttachmentKeys.Length];
            Constraints = new ConstraintPose[constraints];
            AppliedConstraints = new ConstraintPose[constraints];
            ConstraintActive = new bool[constraints];
            ConstraintConstrained = new bool[constraints];
            PhysicsStates = new PhysicsState[constraints];
            for (int i = 0; i < constraints; i++) PhysicsStates[i] = PhysicsState.Initial;
            PathPositions = new float[content.PathPositionsTotal];
            PathScratch = new float[content.PathSpacesMax * 2 + content.PathCurvesMax + content.PathWorldMax];
            Deform = new float[content.DeformTotal];
            AppliedSlots = Slots;
            AppliedDrawOrder = DrawOrder;
            AppliedDeform = Deform;
            Events = new FiredEvent[math.max(content.MaxEventsPerApply * 2, 4)];
            SubmeshKeys = new int[math.max(slots, 1)];
            SubmeshIndexEnd = new int[math.max(slots, 1)];
            Clipper.Sizes(content.ClipPolygonMax, content.RenderVerticesMax, out int clipFloats, out int clipInts);
            m_ClipFloats = new float[clipFloats];
            m_ClipInts = new int[clipInts];
            m_ClipSubmeshes = new int[clipFloats > 0 ? 3 * (slots + 1) : 0];
            m_View = BlobViewOf(content);
            GpuInfluenceStart = new int[Math.Max(content.Attachments.Length, 1)];
            GpuInfluences = GpuSkin.Influences(content, GpuInfluenceStart);
            GpuTopology = new int[GpuSkin.TopologySize(slots)];
            GpuReach = new float[GpuSkin.ReachSize(bones)];
            InitializeSkin(content.SkinAt(skin));
        }

        /// <summary>
        ///     The physics clock (<c>skeleton.time</c>).
        /// </summary>
        public float Time
        {
            get => Skeleton[0].Time;
            set => Skeleton[0].Time = value;
        }

        /// <summary>
        ///     The skin shown, or null (default skin only).
        /// </summary>
        public BoneBurstSkin Skin { get; private set; }

        public void Dispose()
        {
            FreeBlob();
            GC.SuppressFinalize(this);
        }

        ~ManagedPose()
        {
            FreeBlob();
        }

        /// <summary>
        ///     <c>Skeleton.PhysicsTranslate</c>: every physics constraint, active or not.
        /// </summary>
        public void PhysicsTranslate(float x, float y)
        {
            fixed (PhysicsState* states = PhysicsStates)
            {
                foreach (int i in Content.PhysicsConstraints) PhysicsSolver.Translate(states + i, x, y);
            }
        }

        /// <summary>
        ///     <c>Skeleton.PhysicsRotate</c>: every physics constraint, active or not.
        /// </summary>
        public void PhysicsRotate(float x, float y, float degrees)
        {
            fixed (PhysicsState* states = PhysicsStates)
            {
                foreach (int i in Content.PhysicsConstraints) PhysicsSolver.Rotate(states + i, x, y, degrees);
            }
        }

        /// <summary>
        ///     A fresh skeleton showing <paramref name="skin" />, as <see cref="InstanceData.InitializeSkin" />.
        /// </summary>
        public void InitializeSkin(BoneBurstSkin skin)
        {
            Skin = skin;
            SlotOps.Fresh(Content, Slots, Deform);
            SetupPose();
            UpdateCache();
        }

        /// <summary>
        ///     <c>Skeleton.SetSkin</c>, as <see cref="InstanceData.SetSkin" />.
        /// </summary>
        public void SetSkin(BoneBurstSkin skin)
        {
            if (!SlotOps.SetSkin(Content, Slots, Deform, Skin, skin)) return;
            Skin = skin;
            UpdateCache();
        }

        /// <summary>
        ///     The stock attachment setter on one slot (-1 clears).
        /// </summary>
        public void SetAttachment(int slot, int attachment)
        {
            SlotOps.SetAttachment(Content, Slots, Deform, slot, attachment);
        }

        public void SetupPoseSlots()
        {
            SlotOps.SetupPoseSlots(Content, Slots, DrawOrder, Deform, Skin);
        }

        /// <summary>
        ///     <c>Skeleton.SetupPose</c>: bones, constraints, then slots. Physics state is kept.
        /// </summary>
        public void SetupPose()
        {
            for (int i = 0; i < Local.Length; i++)
            {
                BoneSetup s = Content.BoneSetups[i];
                Local[i] = new BoneLocal
                {
                    X = s.X, Y = s.Y, Rotation = s.Rotation, ScaleX = s.ScaleX, ScaleY = s.ScaleY, ShearX = s.ShearX,
                    ShearY = s.ShearY, Inherit = s.Inherit
                };
            }

            Array.Copy(Content.ConstraintSetups, Constraints, Constraints.Length);
            SetupPoseSlots();
        }

        /// <summary>
        ///     <c>Skeleton.UpdateCache</c> for the current skin, as <see cref="InstanceData.UpdateCache" />.
        /// </summary>
        public void UpdateCache()
        {
            Content.BoneActivation(Skin, BoneActive);
            Content.ConstraintActivation(Skin, BoneActive, ConstraintActive);
            ResolveAttachments();

            int[] slotAttachments = new int[Slots.Length];
            for (int i = 0; i < Slots.Length; i++) slotAttachments[i] = Slots[i].Attachment;
            UpdateCacheBuilder.Result result =
                UpdateCacheBuilder.Build(Content, Skin, BoneActive, ConstraintActive, slotAttachments);
            Cache = result.Cache;
            for (int i = 0; i < BoneConstrained.Length; i++)
            {
                if (result.BoneConstrained[i] == BoneConstrained[i]) continue;
                BoneConstrained[i] = result.BoneConstrained[i];
                (World[i], OtherWorld[i]) = (OtherWorld[i], World[i]);
                (WorldFlags[i], OtherWorldFlags[i]) = (OtherWorldFlags[i], WorldFlags[i]);
                (LocalFlags[i], OtherLocalFlags[i]) = (OtherLocalFlags[i], LocalFlags[i]);
            }

            Array.Copy(result.ConstraintConstrained, ConstraintConstrained, ConstraintConstrained.Length);
            if (result.SlotsConstrained && AppliedSlots == Slots)
            {
                AppliedSlots = new SlotState[Slots.Length];
                AppliedDrawOrder = new int[DrawOrder.Length];
                AppliedDeform = new float[Deform.Length];
            }
        }

        private void ResolveAttachments()
        {
            for (int i = 0; i < Slots.Length; i++) SetupAttachments[i] = Content.SetupAttachment(Skin, i);
            for (int i = 0; i < KeyAttachment.Length; i++)
            {
                AttachmentKey key = Content.AttachmentKeys[i];
                KeyAttachment[i] = Content.ResolveAttachment(Skin, key.Slot, key.Name);
            }

            m_SkinVersion = Skin?.Version ?? 0;
            m_DefaultSkinVersion = Content.DefaultSkin?.Version ?? 0;
        }

        /// <summary>
        ///     As <see cref="InstanceData.RefreshIfSkinEdited" />.
        /// </summary>
        private void RefreshIfSkinEdited()
        {
            if ((Skin?.Version ?? 0) != m_SkinVersion || (Content.DefaultSkin?.Version ?? 0) != m_DefaultSkinVersion)
                ResolveAttachments();
        }

        /// <summary>
        ///     What <c>PoseJob</c> does: this frame's commands (when the state applied), then the world update with
        ///     constraints.
        /// </summary>
        public void Pose(CommandBuffer buffer = null, PhysicsMode physics = PhysicsMode.Update)
        {
            RefreshIfSkinEdited();
            using Copies copies = new();
            InstanceHeader h = Header(copies);
            h.Physics = physics;
            *h.EventCount = 0;
            if (buffer != null)
            {
                Counters[1] = buffer.UnkeyedState;
                *h.UnkeyedState = buffer.UnkeyedState;
                ApplyCommand[] commands = buffer.Commands.ToArray();
                TotalAlpha = new float[commands.Length];
                Rotation = buffer.Rotation.ToArray();
                h.Commands = copies.Of(NonEmpty(commands));
                h.CommandCount = commands.Length;
                h.TotalAlpha = copies.Of(NonEmpty(TotalAlpha));
                h.Modes = copies.Of(NonEmpty(buffer.Modes.ToArray()));
                h.HoldFactors = copies.Of(NonEmpty(buffer.HoldFactors.ToArray()));
                h.Rotation = copies.Of(NonEmpty(Rotation));
                h.ApplyRan = true;
                TimelineApply.ApplyAll(h);
            }

            SkeletonUpdate.UpdateWorldTransform(h, physics);
        }

        /// <summary>
        ///     Only the world update (no animation): <c>Skeleton.UpdateWorldTransform(physics)</c>.
        /// </summary>
        public void UpdateWorldTransform(PhysicsMode physics)
        {
            using Copies copies = new();
            SkeletonUpdate.UpdateWorldTransform(Header(copies), physics);
        }

        /// <summary>
        ///     The events the last <see cref="Pose" /> fired.
        /// </summary>
        public FiredEvent[] FiredEvents()
        {
            FiredEvent[] fired = new FiredEvent[Math.Min(Counters[0], Events.Length)];
            Array.Copy(Events, fired, fired.Length);
            return fired;
        }

        /// <summary>
        ///     What <c>MeshJob</c> does, into <see cref="Vertices" /> / <see cref="Indices" />.
        /// </summary>
        public void BuildMesh()
        {
            {
                using Copies copies = new();
                InstanceHeader h = Header(copies);
                Counts = MeshBuilder.Measure(h);
            }

            Vertices = new SkeletonVertex[Counts.Vertices];
            Indices = new uint[Counts.Indices];
            Tint = TintBlack ? new float4[Counts.Vertices] : Array.Empty<float4>();
            {
                using Copies copies = new();
                InstanceHeader h = Header(copies);
                SkeletonVertex* vertices = copies.Of(NonEmpty(Vertices));
                uint* indices = copies.Of(NonEmpty(Indices));
                float4* tint = TintBlack ? copies.Of(NonEmpty(Tint)) : null;
                MeshBuilder.Fill(h, Counts, vertices, null, indices, tint, out Min, out Max);
                MeshBuilder.Bounds(h, Counts.Vertices, Min, Max, out Center, out Extents);
            }
        }

        /// <summary>
        ///     One GPU-skinned frame after <see cref="Pose" />: classify, rebuild the static mesh when the topology
        ///     changed, write the pose record, bounds into <see cref="Center" /> / <see cref="Extents" />. On a
        ///     <see cref="GpuMeshState.NeedsCpu" /> frame nothing is written and the static mesh is forgotten, as
        ///     <c>LateMeshJob</c> does; build the CPU mesh with <see cref="BuildMesh" />.
        /// </summary>
        public GpuMeshState GpuFrame()
        {
            GpuRecord = new float4[GpuSkin.RecordSize(World.Length, Slots.Length, TintBlack)];
            {
                using Copies copies = new();
                InstanceHeader h = Header(copies);
                GpuState = GpuSkin.Classify(h);
                if (GpuState == GpuMeshState.NeedsCpu)
                {
                    h.GpuTopology[0] = 0;
                    return GpuState;
                }

                if (GpuState == GpuMeshState.NeedsBuild)
                    GpuCounts = MeshBuilder.Count(h, h.SubmeshKeys, h.SubmeshIndexEnd);
            }

            if (GpuState == GpuMeshState.NeedsBuild)
            {
                GpuVertices = new SkeletonVertex[GpuCounts.Vertices];
                GpuSkinData = new float4[GpuCounts.Vertices];
                GpuIndices = new uint[GpuCounts.Indices];
                using Copies copies = new();
                InstanceHeader h = Header(copies);
                GpuSkin.Build(h, copies.Of(NonEmpty(GpuVertices)), copies.Of(NonEmpty(GpuSkinData)), null,
                    copies.Of(NonEmpty(GpuIndices)));
                GpuState = GpuMeshState.Built;
            }

            {
                using Copies copies = new();
                InstanceHeader h = Header(copies);
                GpuSkin.WriteRecord(h, copies.Of(NonEmpty(GpuRecord)));
                GpuSkin.Bounds(h, out Center, out Extents);
                if (GpuCounts.Vertices == 0) Center = Extents = float3.zero;
            }

            return GpuState;
        }

        /// <summary>
        ///     Setup pose, world update (no physics stepping) and mesh in one call.
        /// </summary>
        public void SetupPoseAndMesh()
        {
            SetupPose();
            Pose(null, PhysicsMode.None);
            BuildMesh();
        }

        private InstanceHeader Header(Copies copies)
        {
            int* counters = copies.Of(Counters);
            return new InstanceHeader
            {
                Blob = m_View,
                Local = copies.Of(NonEmpty(Local)),
                Applied = copies.Of(NonEmpty(Applied)),
                World = copies.Of(NonEmpty(World)),
                WorldFlags = copies.Of(NonEmpty(WorldFlags)),
                LocalFlags = copies.Of(NonEmpty(LocalFlags)),
                BoneActive = copies.Of(NonEmpty(BoneActive)),
                Slots = copies.Of(NonEmpty(Slots)),
                DrawOrder = copies.Of(NonEmpty(DrawOrder)),
                AppliedSlots = copies.Of(NonEmpty(AppliedSlots)),
                AppliedDrawOrder = copies.Of(NonEmpty(AppliedDrawOrder)),
                AppliedDeform = copies.Of(NonEmpty(AppliedDeform)),
                SubmeshKeys = copies.Of(SubmeshKeys),
                SubmeshIndexEnd = copies.Of(SubmeshIndexEnd),
                SetupAttachments = copies.Of(NonEmpty(SetupAttachments)),
                KeyAttachment = copies.Of(NonEmpty(KeyAttachment)),
                Constraints = copies.Of(NonEmpty(Constraints)),
                AppliedConstraints = copies.Of(NonEmpty(AppliedConstraints)),
                ConstraintActive = copies.Of(NonEmpty(ConstraintActive)),
                ConstraintConstrained = copies.Of(NonEmpty(ConstraintConstrained)),
                Deform = copies.Of(NonEmpty(Deform)),
                Events = copies.Of(Events),
                EventCount = counters,
                UnkeyedState = counters + 1,
                CurrentCommand = counters + 2,
                EventCapacity = Events.Length,
                Cache = copies.Of(NonEmpty(Cache)),
                CacheCount = Cache.Length,
                Skeleton = copies.Of(Skeleton),
                PhysicsStates = copies.Of(NonEmpty(PhysicsStates)),
                PathPositions = copies.Of(NonEmpty(PathPositions)),
                PathScratch = copies.Of(NonEmpty(PathScratch)),
                ClipFloats = m_ClipFloats.Length > 0 ? copies.Of(m_ClipFloats) : null,
                ClipInts = m_ClipInts.Length > 0 ? copies.Of(m_ClipInts) : null,
                ClipSubmeshes = m_ClipSubmeshes.Length > 0 ? copies.Of(m_ClipSubmeshes) : null,
                TintBlack = TintBlack,
                GpuBase = 0,
                GpuTopology = copies.Of(GpuTopology),
                GpuReach = copies.Of(GpuReach),
                GpuInfluenceStart = copies.Of(GpuInfluenceStart),
                Physics = PhysicsMode.Update,
                Color = Color,
                ScaleX = ScaleX,
                ScaleY = ScaleY,
                ZSpacing = ZSpacing,
                LinearColorSpace = LinearColorSpace
            };
        }

        private BlobView BlobViewOf(BlobContent c)
        {
            return new BlobView
            {
                Bones = BlobCopy(c.BoneSetups),
                Slots = BlobCopy(c.SlotSetups),
                Attachments = BlobCopy(c.Attachments),
                Vertices = BlobCopy(c.Vertices),
                BoneIndices = BlobCopy(c.Bones),
                Triangles = BlobCopy(c.Triangles),
                Uvs = BlobCopy(c.Uvs),
                Offsets = BlobCopy(c.Offsets),
                Animations = BlobCopy(c.Animations),
                Timelines = BlobCopy(c.Timelines),
                Frames = BlobCopy(c.Frames),
                Curves = BlobCopy(c.Curves),
                Ints = BlobCopy(c.Ints),
                DeformFrames = BlobCopy(c.DeformFrames),
                Events = BlobCopy(c.Events),
                SlotDeformStart = BlobCopy(c.SlotDeformStart),
                SlotDeformCapacity = BlobCopy(c.SlotDeformCapacity),
                TimelineSlots = BlobCopy(c.TimelineSlots),
                ConstraintSetups = BlobCopy(c.ConstraintSetups),
                ConstraintInfos = BlobCopy(c.ConstraintInfos),
                BoneChildren = BlobCopy(c.BoneChildren),
                ConstraintDatas = BlobCopy(c.ConstraintDatas),
                ConstraintBones = BlobCopy(c.ConstraintBones),
                TransformFroms = BlobCopy(c.TransformFroms),
                TransformTos = BlobCopy(c.TransformTos),
                PathLengths = BlobCopy(c.PathLengths),
                AnimationBones = BlobCopy(c.AnimationBones),
                FramePages = BlobCopy(c.FramePages),
                BoneCount = c.BoneSetups.Length,
                SlotCount = c.SlotSetups.Length,
                AttachmentCount = c.Attachments.Length,
                AnimationCount = c.Animations.Length,
                ConstraintCount = c.ConstraintSetups.Length,
                AttachmentKeyCount = c.AttachmentKeys.Length,
                DeformTotal = c.DeformTotal,
                MaxEventsPerApply = c.MaxEventsPerApply,
                ReferenceScale = c.ReferenceScale,
                PathSpacesMax = c.PathSpacesMax,
                PathCurvesMax = c.PathCurvesMax,
                PathWorldMax = c.PathWorldMax,
                PathPositionsTotal = c.PathPositionsTotal,
                ClipPolygonMax = c.ClipPolygonMax,
                RenderVerticesMax = c.RenderVerticesMax,
                RenderTrianglesMax = c.RenderTrianglesMax
            };
        }

        private T* BlobCopy<T>(T[] values) where T : unmanaged
        {
            long bytes = (long)values.Length * sizeof(T);
            IntPtr memory = Marshal.AllocHGlobal((IntPtr)Math.Max(bytes, sizeof(T)));
            fixed (T* source = values)
            {
                Buffer.MemoryCopy(source, (void*)memory, bytes, bytes);
            }

            m_BlobMemory.Add(memory);
            return (T*)memory;
        }

        private void FreeBlob()
        {
            foreach (IntPtr memory in m_BlobMemory) Marshal.FreeHGlobal(memory);

            m_BlobMemory.Clear();
        }

        private static T[] NonEmpty<T>(T[] values)
        {
            return values.Length > 0 ? values : new T[1];
        }

        /// <summary>
        ///     Unmanaged copies of managed arrays for one call, written back and freed on dispose. The same array
        ///     always maps to the same copy, so pointer identity (applied == pose) survives.
        /// </summary>
        private sealed class Copies : IDisposable
        {
            private readonly Dictionary<Array, IntPtr> m_Memory = new();
            private readonly List<Action> m_WriteBack = new();

            public void Dispose()
            {
                foreach (Action writeBack in m_WriteBack) writeBack();
            }

            public T* Of<T>(T[] values) where T : unmanaged
            {
                if (m_Memory.TryGetValue(values, out IntPtr existing)) return (T*)existing;
                long bytes = (long)values.Length * sizeof(T);
                IntPtr memory = Marshal.AllocHGlobal((IntPtr)Math.Max(bytes, sizeof(T)));
                fixed (T* source = values)
                {
                    Buffer.MemoryCopy(source, (void*)memory, bytes, bytes);
                }

                m_Memory.Add(values, memory);
                m_WriteBack.Add(() =>
                {
                    fixed (T* target = values)
                    {
                        Buffer.MemoryCopy((void*)memory, target, bytes, bytes);
                    }

                    Marshal.FreeHGlobal(memory);
                });
                return (T*)memory;
            }
        }
    }
}