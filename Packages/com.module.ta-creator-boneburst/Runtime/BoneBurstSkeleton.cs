using System;
using System.Collections.Generic;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Constraints;
using BoneBurst.Instance;
using Cysharp.Threading.Tasks;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Mathematics;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.Rendering;
using BlendMode = BoneBurst.Data.BlendMode;
using CommandBuffer = BoneBurst.Anim.CommandBuffer;

namespace BoneBurst
{
    /// <summary>
    ///     A Spine skeleton rendered by BoneBurst. It holds no per-frame code: <see cref="BoneBurstSystem" /> poses
    ///     and meshes every instance in Burst jobs, and this component only owns the instance's data and mesh.
    /// </summary>
    /// <summary>
    ///     What an invisible skeleton still does each frame: spine-unity's <c>UpdateMode</c>
    ///     (<c>Doc/Format/Skins-TintBlack-Culling.md</c> §4).
    /// </summary>
    public enum BoneBurstUpdateMode
    {
        /// <summary>
        ///     Nothing: time, tracks and physics freeze; GameObject movement is not gathered.
        /// </summary>
        Nothing = 0,

        /// <summary>
        ///     Advance time and tracks (Start/End/Complete bookkeeping), apply nothing.
        /// </summary>
        OnlyAnimationStatus = 1,

        /// <summary>
        ///     Everything but the mesh: pose, constraints, physics and events stay current.
        /// </summary>
        EverythingExceptMesh = 2,

        /// <summary>
        ///     Everything, the mesh included.
        /// </summary>
        FullUpdate = 3
    }

    /// <remarks>
    ///     Runs in Edit mode too (<c>ExecuteAlways</c>), so the Scene view shows the skeleton: the Editor's
    ///     <c>BoneBurstEditModePreview</c> poses and meshes it whenever it changes, frozen at the start animation's
    ///     first frame. Its mesh is never saved (<c>HideFlags.DontSave</c>), nor are the runtime materials.
    /// </remarks>
    [ExecuteAlways]
    [DisallowMultipleComponent]
    [RequireComponent(typeof(MeshFilter), typeof(MeshRenderer))]
    [AddComponentMenu("BoneBurst/BoneBurst Skeleton")]
    public sealed class BoneBurstSkeleton : MonoBehaviour
    {
        private const MeshUpdateFlags UploadFlags = MeshUpdateFlags.DontRecalculateBounds |
                                                    MeshUpdateFlags.DontValidateIndices |
                                                    MeshUpdateFlags.DontNotifyMeshUsers |
                                                    MeshUpdateFlags.DontResetBoneBounds;

        // Bounds with a margin: Mesh.bounds is a native call per skeleton per frame; it is set 10% larger than the exact
        // bounds and left alone while the exact bounds stay inside it and are not much smaller (so culling stays
        // tight). Invalid for a new Mesh, and after a topology change or a GPU rebuild.
        private const float BoundsMargin = 1.1f, BoundsTooLoose = 1.5f;

        private static readonly HashSet<BoneBurstSkeleton> s_PreviewRestarts = new();

        private static readonly VertexAttributeDescriptor[] s_Layout =
        {
            new(VertexAttribute.Position, VertexAttributeFormat.Float32, 3),
            new(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4),
            new(VertexAttribute.TexCoord0, VertexAttributeFormat.Float32, 2)
        };

        // Tint black on a second stream: uv2 (TEXCOORD1) and uv3 (TEXCOORD2), as spine-unity writes them.
        private static readonly VertexAttributeDescriptor[] s_TintLayout =
        {
            new(VertexAttribute.Position, VertexAttributeFormat.Float32, 3),
            new(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4),
            new(VertexAttribute.TexCoord0, VertexAttributeFormat.Float32, 2),
            new(VertexAttribute.TexCoord1, VertexAttributeFormat.Float32, 2, 1),
            new(VertexAttribute.TexCoord2, VertexAttributeFormat.Float32, 2, 1)
        };

        /// <summary>
        ///     Declares the Mesh's vertex layout, uploads the indices and sets the submeshes from the scratch.
        /// </summary>
        private static readonly ProfilerMarker s_TopologyMarker =
            new(ProfilerCategory.Scripts, "BoneBurst.SetTopology");

        [Tooltip("The skeleton to render.")]
        public BoneBurstAsset Asset;

        [Tooltip("Skin to show. Empty: the default skin only.")]
        [SerializeField]
        [BoneBurstKeyOf(BoneBurstKeyKind.Skin)]
        private BoneBurstKey m_Skin;

        [Tooltip("Tints the whole skeleton.")]
        [SerializeField]
        private Color m_Color = Color.white;

        [SerializeField]
        private bool m_FlipX, m_FlipY;

        [Tooltip("Z distance between slots in draw order; 0 keeps the mesh flat.")]
        [SerializeField]
        private float m_ZSpacing;

        [Tooltip("Animation to play on enable. Empty: setup pose.")]
        [SerializeField]
        [BoneBurstKeyOf(BoneBurstKeyKind.Animation)]
        private BoneBurstKey m_Animation;

        [SerializeField]
        private bool m_Loop = true;

        [Tooltip("Multiplies the animation speed.")]
        public float TimeScale = 1;

        [Tooltip("Advance this skeleton with unscaled game time (Time.unscaledDeltaTime), so pausing Time.timeScale " +
                 "does not freeze it. The Timeline animation track sets this when a clip starts.")]
        public bool UnscaledTime;

        [Tooltip(
            "How much of the GameObject's movement physics constraints feel, per axis (spine-unity default 1, 1).")]
        public Vector2 PhysicsPositionInheritance = Vector2.one;

        [Tooltip("How much of the GameObject's Z rotation physics constraints feel (spine-unity default 1).")]
        public float PhysicsRotationInheritance = 1;

        [Tooltip("Largest position change per frame passed to physics, per axis.")]
        public Vector2 PhysicsPositionLimit = Vector2.positiveInfinity;

        [Tooltip("Largest rotation change per frame (degrees) passed to physics.")]
        public float PhysicsRotationLimit = float.MaxValue;

        [Tooltip("What the skeleton still does while its renderer is not visible to any camera (spine-unity's " +
                 "Update When Invisible).")]
        public BoneBurstUpdateMode UpdateWhenInvisible = BoneBurstUpdateMode.FullUpdate;

        [Tooltip("Skin vertices on the GPU: the mesh is rebuilt only when attachments, sequence frames or draw " +
                 "order change; each frame uploads bone transforms and slot colours. Frames with active clipping " +
                 "or deform fall back to the CPU mesh by themselves. Needs shader model 4.5.")]
        [SerializeField]
        private bool m_GpuSkinning;

        internal readonly CommandBuffer Buffer = new();
        internal bool AppliedThisFrame;

        internal InstanceData Data;
        internal BoneBurstHandle Handle;
        internal Mesh Mesh;
        internal InstanceFlags PendingFlags;
        internal MeshRenderer Renderer;
        internal ApplyCommand SteadyCommand;

        // This frame took BoneAnimationState.TryAdvanceSteady: its one command, not Buffer, goes into the header.
        internal bool SteadyThisFrame;
        internal int SteadyUnkeyedState;
        internal int SubmeshHash = int.MinValue;
        private Bounds m_Bounds;
        private bool m_BoundsValid;
        private GpuMeshState m_LastGpuState;
        private Vector3 m_LastPosition;
        private float m_LastRotation;
        private Material[] m_Materials = Array.Empty<Material>();
        private PhysicsMode m_NextPhysics = PhysicsMode.Update;
        private int m_UserValue = -1;

        /// <summary>
        ///     The mode in force: <see cref="BoneBurstUpdateMode.FullUpdate" /> while visible, otherwise
        ///     <see cref="UpdateWhenInvisible" />. A skeleton starts in its invisible mode until Unity reports it
        ///     visible, as spine-unity's does; its first mesh is built regardless.
        /// </summary>
        public BoneBurstUpdateMode UpdateMode { get; private set; } = BoneBurstUpdateMode.FullUpdate;

        /// <summary>
        ///     The animation state: tracks, queueing, crossfades and listeners, as stock <c>AnimationState</c>.
        ///     Null until the component is enabled.
        /// </summary>
        public BoneAnimationState AnimationState { get; private set; }

        /// <summary>
        ///     Skin on the GPU (<c>Doc/Format/GpuSkinning.md</c>). Frames that cannot (active clipping, deform on a
        ///     rendered slot) build a CPU mesh instead, and so does every frame on a platform without shader
        ///     model 4.5 (<see cref="BoneBurstGpu.IsSupported" />).
        /// </summary>
        public bool GpuSkinning
        {
            get => m_GpuSkinning;
            set
            {
                if (m_GpuSkinning == value) return;
                m_GpuSkinning = value;
                MarkDirty();
            }
        }

        /// <summary>
        ///     The path this skeleton's last applied mesh took: <see cref="GpuMeshState.Cpu" />,
        ///     <see cref="GpuMeshState.Built" /> or <see cref="GpuMeshState.Reused" />.
        /// </summary>
        /// <remarks>
        ///     Cached when the mesh is applied, not read from <c>Data.Output</c>: between Schedule and Complete a job
        ///     writes that field, and it holds the job's transient NeedsBuild or NeedsCpu until Complete settles it.
        /// </remarks>
        public GpuMeshState LastGpuState => Data != null ? m_LastGpuState : GpuMeshState.Cpu;

        /// <summary>
        ///     True while the skeleton is registered and has instance data.
        /// </summary>
        public bool IsValid => Data != null && BoneBurstSystem.IsAlive(Handle);

        public SkeletonBlob Blob => Data?.Blob;

        /// <summary>
        ///     The initial skin's baked key (empty: default skin only). Setting it restarts the skeleton on that skin
        ///     in the setup pose, as spine-unity's <c>initialSkinName</c> does; to swap skins while animating, use
        ///     <see cref="SetSkin(BoneBurstSkin)" />.
        /// </summary>
        /// <remarks>
        ///     A key, not a name: a skin whose name an animation also has bakes as <c>name (A)</c>
        ///     (<see cref="BoneBurstKeyTable" />). A key the skeleton lacks logs an error and shows the default skin.
        /// </remarks>
        public BoneBurstKey Skin
        {
            get => m_Skin;
            set
            {
                m_Skin = value;
                if (Data != null) ApplySkin();
            }
        }

        /// <summary>
        ///     The skin shown now (a file skin or a combined one), or null for the default skin only.
        /// </summary>
        public BoneBurstSkin CurrentSkin => Data?.Skin;

        public Color Color
        {
            get => m_Color;
            set
            {
                m_Color = value;
                MarkDirty();
            }
        }

        public bool FlipX
        {
            get => m_FlipX;
            set
            {
                m_FlipX = value;
                MarkDirty();
            }
        }

        public bool FlipY
        {
            get => m_FlipY;
            set
            {
                m_FlipY = value;
                MarkDirty();
            }
        }

        /// <summary>
        ///     The playing animation's name, or null.
        /// </summary>
        public string AnimationName => AnimationState?.GetTrack(0)?.Name;

        /// <summary>
        ///     The baked key of the animation played on enable (empty: setup pose), looped per the serialized
        ///     Loop toggle. Setting it while enabled plays that animation now, or stops on an empty key.
        /// </summary>
        /// <exception cref="ArgumentException">Enabled, and the key is not one of the skeleton's animations.</exception>
        public BoneBurstKey Animation
        {
            get => m_Animation;
            set
            {
                if (Data == null)
                {
                    m_Animation = value;
                }
                else if (value.IsEmpty)
                {
                    m_Animation = value;
                    StopAnimation();
                }
                else
                {
                    PlayAnimation(value, m_Loop);
                    m_Animation = value;
                }
            }
        }

        /// <summary>
        ///     The physics clock (<c>skeleton.time</c>): advanced by each frame's scaled delta.
        /// </summary>
        public float PhysicsTime
        {
            get
            {
                if (Data == null) return 0;
                BoneBurstSystem.CompleteNow();
                return Data.Skeleton[0].Time;
            }
        }

        /// <summary>
        ///     The last CPU mesh took vertex fetch (<see cref="BoneBurstFetch" />). Diagnostic.
        /// </summary>
        internal bool LastMeshFetched => Data != null && Data.Output[0].Fetched;

        private void OnEnable()
        {
            if (Asset == null)
            {
                // In Edit mode a component just added has no asset yet; that is not an error until Play.
                if (Application.isPlaying) Debug.LogError($"{name}: BoneBurstSkeleton has no asset.", this);
                return;
            }

            SkeletonBlob blob;
            try
            {
                if (!Asset.TryGetBlob(out blob))
                {
                    // The data still has to load through the AssetSystem (a player): attach when it arrives.
                    AttachWhenPrepared(Asset).Forget();
                    return;
                }
            }
            catch (Exception e)
            {
                Debug.LogException(e, this);
                return;
            }

            Attach(blob);
        }

        private void OnDisable()
        {
            Detach();
        }

        private void OnBecameInvisible()
        {
            UpdateMode = UpdateWhenInvisible;
        }

        private void OnBecameVisible()
        {
            BoneBurstUpdateMode previous = UpdateMode;
            UpdateMode = BoneBurstUpdateMode.FullUpdate;
            // The mesh is stale in every other mode; rebuild it at the next update.
            if (previous != BoneBurstUpdateMode.FullUpdate) MarkDirty();
        }

        private void OnValidate()
        {
            if (!Application.isPlaying)
            {
                // Edit-mode preview: any change (asset, skin, animation, flips, Undo) rebuilds the instance, outside
                // OnValidate, which may not create or destroy objects (RestartQueuedPreviews).
                s_PreviewRestarts.Add(this);
                return;
            }

            if (Data != null)
            {
                ApplySkin();
                // The serialized toggle bypasses the property; re-mesh on either path.
                MarkDirty();
            }
        }

        /// <summary>
        ///     Keyed events and Complete notifications (<see cref="BoneBurstEvent.IsComplete" />), in stock
        ///     <c>AnimationState</c> order, delivered at the end of the frame's BoneBurst update.
        /// </summary>
        public event Action<BoneBurstSkeleton, BoneBurstEvent> Event;

        /// <summary>
        ///     <c>Skeleton.SetSkin</c>: only slots showing the old skin's attachments switch (on a first skin, the
        ///     slots whose setup placeholder the new skin has). Call <see cref="SetupPoseSlots" /> afterwards to
        ///     show exactly the new skin's setup attachments. Setting the current skin again does nothing.
        /// </summary>
        /// <example>
        ///     <code>
        ///     BoneBurstSkin look = new("look", skeleton.Blob);
        ///     look.AddSkin(skeleton.Blob.GetSkin("skin-base"));
        ///     look.AddSkin(skeleton.Blob.GetSkin("clothes/hoodie"));
        ///     skeleton.SetSkin(look);
        ///     skeleton.SetupPoseSlots();
        ///     </code>
        /// </example>
        /// <exception cref="ArgumentException">The skin belongs to another skeleton.</exception>
        public void SetSkin(BoneBurstSkin skin)
        {
            if (Data == null) return;
            BoneBurstSystem.CompleteNow();
            Data.SetSkin(skin);
            MarkDirty();
            if (Data.HasPhysics) BoneBurstSystem.SetPlaying(this, true);
        }

        /// <summary>
        ///     <see cref="SetSkin(BoneBurstSkin)" /> with a skin of the file, by name.
        /// </summary>
        /// <exception cref="ArgumentException">No skin has that name.</exception>
        public void SetSkin(string skinName)
        {
            if (Data == null) return;
            BoneBurstSkin skin = Data.Blob.GetSkin(skinName) ??
                                 throw new ArgumentException($"skin not found: {skinName}", nameof(skinName));
            SetSkin(skin);
        }

        /// <summary>
        ///     <see cref="SetSkin(string)" /> by baked key (<see cref="BoneBurstAsset.Keys" />).
        /// </summary>
        public void SetSkin(BoneBurstKey key)
        {
            SetSkin(key.Id);
        }

        /// <summary>
        ///     <see cref="SetSkin(string)" /> by baked key id (<see cref="BoneBurstKey.Id" />).
        /// </summary>
        public void SetSkin(int keyId)
        {
            SetSkin(Asset.NameOf(keyId, BoneBurstKeyKind.Skin));
        }

        /// <summary>
        ///     Shows a slot's attachment by placeholder name (current skin, then the default skin), or clears it
        ///     with a null placeholder, as <c>Skeleton.SetAttachment</c>.
        /// </summary>
        /// <exception cref="ArgumentException">The slot or the attachment is not found.</exception>
        public void SetAttachment(string slotName, string placeholder)
        {
            if (Data == null) return;
            if (slotName == null) throw new ArgumentNullException(nameof(slotName));
            int slot = Array.FindIndex(Data.Blob.Skeleton.Slots, s => s.Name == slotName);
            if (slot < 0) throw new ArgumentException($"slot not found: {slotName}", nameof(slotName));
            int attachment = -1;
            if (placeholder != null)
            {
                attachment = Data.Blob.Content.ResolveAttachment(Data.Skin, slot, placeholder);
                if (attachment < 0)
                    throw new ArgumentException($"attachment not found: {placeholder}, for slot: {slotName}",
                        nameof(placeholder));
            }

            BoneBurstSystem.CompleteNow();
            Data.SetAttachment(slot, attachment);
            MarkDirty();
        }

        /// <summary>
        ///     <c>Skeleton.SetupPoseSlots</c>: setup draw order, slot colours and setup attachments under the current
        ///     skin.
        /// </summary>
        public void SetupPoseSlots()
        {
            if (Data == null) return;
            BoneBurstSystem.CompleteNow();
            Data.SetupPoseSlots();
            MarkDirty();
        }

        /// <summary>
        ///     <see cref="PlayAnimation(string, bool)" /> by baked key (<see cref="BoneBurstAsset.Keys" />).
        /// </summary>
        public void PlayAnimation(BoneBurstKey key, bool loop)
        {
            PlayAnimation(key.Id, loop);
        }

        /// <summary>
        ///     <see cref="PlayAnimation(string, bool)" /> by baked key id (<see cref="BoneBurstKey.Id" />).
        /// </summary>
        /// <exception cref="ArgumentException">The id is not one of the skeleton's animations.</exception>
        public void PlayAnimation(int keyId, bool loop)
        {
            PlayAnimation(Asset.NameOf(keyId, BoneBurstKeyKind.Animation), loop);
        }

        /// <summary>
        ///     Plays an animation on track 0, replacing the current one with a crossfade of the asset's mix duration
        ///     for that pair (<see cref="BoneBurstAsset.DefaultMix" /> unless a pair says otherwise), as spine-unity's
        ///     <c>SetAnimation</c>.
        /// </summary>
        /// <exception cref="ArgumentException">The skeleton has no animation of that name.</exception>
        public void PlayAnimation(string animationName, bool loop)
        {
            // Animations bake first, so an animation's key is always its own name (Doc/Format/NameKeys.md §2).
            if (Data == null)
            {
                m_Animation = animationName;
                m_Loop = loop;
                return;
            }

            int index = Array.FindIndex(Data.Blob.Skeleton.Animations, a => a.Name == animationName);
            if (index < 0)
                throw new ArgumentException($"{Asset.name} has no animation '{animationName}'.", nameof(animationName));

            AnimationState.SetAnimation(0, index, loop);
            BoneBurstSystem.SetPlaying(this, true);
        }

        /// <summary>
        ///     Stops the animation. The pose stays as it is.
        /// </summary>
        public void StopAnimation()
        {
            AnimationState?.ClearTracks();
        }

        internal void RaiseEvent(BoneBurstEvent e)
        {
            Event?.Invoke(this, e);
        }

        /// <summary>
        ///     <c>Skeleton.SetupPose</c>: bones, constraints and slots back to the setup pose. Physics state is
        ///     kept, as in the stock runtime.
        /// </summary>
        public void SetupPose()
        {
            if (Data == null) return;
            BoneBurstSystem.CompleteNow();
            Data.SetupPoseConstraints();
            Data.SetupPoseSlots();
            MarkDirty(InstanceFlags.NeedsSetupPose);
        }

        /// <summary>
        ///     Waits for <paramref name="asset" />'s data, then attaches — unless this component was disabled,
        ///     destroyed, given another asset, or attached by a later enable meanwhile.
        /// </summary>
        private async UniTaskVoid AttachWhenPrepared(BoneBurstAsset asset)
        {
            try
            {
                await asset.PrepareAsync();
            }
            catch (Exception e)
            {
                if (this != null) Debug.LogException(e, this);
                return;
            }

            if (this == null || !isActiveAndEnabled || Asset != asset || Data != null) return;
            Attach(asset.Blob);
        }

        /// <summary>
        ///     Registers the instance for <paramref name="blob" />: the rest of an enable once the data is in hand.
        /// </summary>
        private void Attach(SkeletonBlob blob)
        {
            Data = new InstanceData(blob);
            m_LastPosition = transform.position;
            m_LastRotation = transform.rotation.eulerAngles.z;
            m_NextPhysics = PhysicsMode.Update;
            // The Edit-mode preview always meshes: Scene view visibility callbacks are not a play-time signal.
            UpdateMode = Application.isPlaying ? UpdateWhenInvisible : BoneBurstUpdateMode.FullUpdate;
            Renderer = GetComponent<MeshRenderer>();
            Mesh = new Mesh { name = $"{name} (BoneBurst)", hideFlags = HideFlags.DontSave };
            m_BoundsValid = false;
            Mesh.MarkDynamic();
            GetComponent<MeshFilter>().sharedMesh = Mesh;
            SubmeshHash = int.MinValue;
            AnimationState = new BoneAnimationState(Asset.AnimationStateData);
            AnimationState.Start += _ => BoneBurstSystem.SetPlaying(this, true);
            AnimationState.Event += (_, e) => Event?.Invoke(this, e);
            AnimationState.Complete += entry =>
                Event?.Invoke(this, new BoneBurstEvent(null, BoneBurstKey.EmptyId, 0, 0, null, 0, 0,
                    entry.AnimationTime, true));
            ApplySkin(false);
            Handle = BoneBurstSystem.Add(this);
            if (!m_Animation.IsEmpty)
                try
                {
                    PlayAnimation(m_Animation, m_Loop);
                }
                catch (ArgumentException e)
                {
                    Debug.LogError(e.Message, this);
                }
        }

        /// <summary>
        ///     Unregisters the instance and frees its mesh. Its native data is freed once no job can read it.
        /// </summary>
        internal void Detach()
        {
            if (Data == null) return;
            BoneBurstSystem.SetPlaying(this, false);
            BoneBurstGpu.Release(Data);
            BoneBurstFetch.Release(Data);
            m_UserValue = -1;
            m_LastGpuState = GpuMeshState.Cpu;
            BoneBurstSystem.Remove(Handle, Data);
            Handle = BoneBurstHandle.None;
            Data = null;
            BoneBurstSystem.Unqueue(this);
            PendingFlags = InstanceFlags.None;
            if (Mesh != null)
            {
                MeshFilter filter = GetComponent<MeshFilter>();
                if (filter != null && filter.sharedMesh == Mesh) filter.sharedMesh = null;
                if (Application.isPlaying) Destroy(Mesh);
                else DestroyImmediate(Mesh);
                Mesh = null;
            }
        }

        /// <summary>
        ///     Edit mode: rebuilds every skeleton changed since the last call (<see cref="OnValidate" />), so the
        ///     Scene view shows the new asset, skin or start animation. Called by the Editor's preview driver.
        /// </summary>
        internal static void RestartQueuedPreviews()
        {
            if (s_PreviewRestarts.Count == 0) return;
            BoneBurstSkeleton[] queued = new BoneBurstSkeleton[s_PreviewRestarts.Count];
            s_PreviewRestarts.CopyTo(queued);
            s_PreviewRestarts.Clear();
            foreach (BoneBurstSkeleton skeleton in queued)
                if (skeleton != null)
                    skeleton.RestartPreview();
        }

        /// <summary>
        ///     Edit mode: drops the instance and builds it again from the serialized fields. No-op while disabled.
        /// </summary>
        internal void RestartPreview()
        {
            if (!isActiveAndEnabled) return;
            Detach();
            OnEnable();
        }

        private void ApplySkin(bool complete = true)
        {
            BoneBurstSkin skin = null;
            if (!m_Skin.IsEmpty)
                // By key, never by the key's text: a suffixed key ("x (A)") is not the skin's name.
                try
                {
                    skin = Data.Blob.GetSkin(Asset.NameOf(m_Skin.Id, BoneBurstKeyKind.Skin));
                }
                catch (ArgumentException e)
                {
                    Debug.LogError($"{name}: skin '{m_Skin}' not found ({e.Message}); showing the default skin.", this);
                }

            if (complete) BoneBurstSystem.CompleteNow();
            Data.InitializeSkin(skin);
            MarkDirty(InstanceFlags.NeedsSetupPose);
            // Physics steps every frame, animated or not, as spine-unity's does.
            if (Data.HasPhysics) BoneBurstSystem.SetPlaying(this, true);
        }

        /// <summary>
        ///     Moves every physics constraint's remembered position, as if the skeleton moved by (x, y) in skeleton
        ///     space (stock <c>Skeleton.PhysicsTranslate</c>).
        /// </summary>
        public unsafe void PhysicsTranslate(float x, float y)
        {
            if (Data == null) return;
            BoneBurstSystem.CompleteNow();
            PhysicsState* states = States();
            foreach (int i in Data.Blob.Content.PhysicsConstraints) PhysicsSolver.Translate(states + i, x, y);
        }

        /// <summary>
        ///     Rotates every physics constraint's remembered position about (x, y) (stock
        ///     <c>Skeleton.PhysicsRotate</c>).
        /// </summary>
        public unsafe void PhysicsRotate(float x, float y, float degrees)
        {
            if (Data == null) return;
            BoneBurstSystem.CompleteNow();
            PhysicsState* states = States();
            foreach (int i in Data.Blob.Content.PhysicsConstraints) PhysicsSolver.Rotate(states + i, x, y, degrees);
        }

        /// <summary>
        ///     Resets every physics constraint at the next update (<c>UpdateWorldTransform(Physics.Reset)</c>).
        /// </summary>
        public void ResetPhysics()
        {
            m_NextPhysics = PhysicsMode.Reset;
            MarkDirty();
        }

        private unsafe PhysicsState* States()
        {
            return (PhysicsState*)NativeArrayUnsafeUtility.GetUnsafePtr(
                Data.PhysicsStates);
        }

        /// <summary>
        ///     After <c>state.Update</c> and before <c>state.Apply</c>, as spine-unity orders it: advance the physics
        ///     clock, then feed this frame's GameObject movement to physics (Constraints.md §10.3–10.4).
        /// </summary>
        internal unsafe void AdvancePhysics(float delta)
        {
            Data.Skeleton[0] = AdvanceTime(Data.Skeleton[0], delta);
            if (!Data.HasPhysics) return;
            if (PhysicsPositionInheritance != Vector2.zero)
            {
                Vector3 position = transform.position;
                Vector3 moved = transform.InverseTransformVector(position - m_LastPosition);
                m_LastPosition = position;
                float dx = Mathf.Clamp(moved.x * PhysicsPositionInheritance.x, -PhysicsPositionLimit.x,
                    PhysicsPositionLimit.x);
                float dy = Mathf.Clamp(moved.y * PhysicsPositionInheritance.y, -PhysicsPositionLimit.y,
                    PhysicsPositionLimit.y);
                PhysicsState* states = States();
                foreach (int i in Data.Blob.Content.PhysicsConstraints) PhysicsSolver.Translate(states + i, dx, dy);
            }

            if (PhysicsRotationInheritance != 0)
            {
                float rotation = transform.rotation.eulerAngles.z, turned = rotation - m_LastRotation;
                m_LastRotation = rotation;
                if (turned > 180) turned -= 360;
                else if (turned < -180) turned += 360;
                // Clamped before the factor, as spine-unity does (its tooltip says the opposite).
                turned = Mathf.Clamp(turned, -PhysicsRotationLimit, PhysicsRotationLimit);
                float degrees = PhysicsRotationInheritance * turned;
                PhysicsState* states = States();
                foreach (int i in Data.Blob.Content.PhysicsConstraints) PhysicsSolver.Rotate(states + i, 0, 0, degrees);
            }
        }

        private static SkeletonState AdvanceTime(SkeletonState state, float delta)
        {
            state.Time += delta;
            return state;
        }

        internal void MarkDirty(InstanceFlags extra = InstanceFlags.None)
        {
            if (Data == null) return;
            BoneBurstSystem.MarkDirty(this, extra | InstanceFlags.Dirty);
        }

        /// <summary>
        ///     After the mesh job: uploads the CPU mesh scratch into this skeleton's <c>Mesh</c>. With an unchanged
        ///     topology only the vertex data goes up, into the existing buffers; otherwise the layout, indices and
        ///     submeshes are declared first (<see cref="MeshOutput.VerticesOnly" />).
        /// </summary>
        internal void UploadCpuMesh()
        {
            MeshOutput output = Data.Output[0];
            // The job's flag, not the asset's: the asset may have changed since the job read it.
            bool tint = output.TintStream;
            // The vertex count sizes the next frame's fetch range (BoneBurstFetch.Attach).
            Data.FetchNeeded = output.VertexCount;
            if (output.Fetched)
            {
                // Vertex fetch: the Mesh keeps the topology only; its vertex buffer is sized but never read.
                if (!output.VerticesOnly) SetTopology(output, s_Layout);
                BoneBurstFetch.MarkTint(tint);
                return;
            }

            if (!output.VerticesOnly) SetTopology(output, tint ? s_TintLayout : s_Layout);
            if (output.VertexCount == 0) return;
            Mesh.SetVertexBufferData(Data.CpuVertices.AsArray(), 0, 0, output.VertexCount, 0, UploadFlags);
            if (tint) Mesh.SetVertexBufferData(Data.CpuTint.AsArray(), 0, 0, output.VertexCount, 1, UploadFlags);
        }

        /// <summary>
        ///     The last CPU mesh's vertices, from wherever that frame put them: the <c>Mesh</c>, or the shared
        ///     vertex-fetch list (<see cref="BoneBurstFetch" />), whose <c>Mesh</c> holds only the topology. Tint is
        ///     (uv2.xy, uv3.xy) per vertex, filled only with tint black. For tests and tools; completes the frame's
        ///     jobs first.
        /// </summary>
        internal void GetCpuVertices(List<Vector3> positions,
            List<Color32> colors, List<Vector2> uvs,
            List<Vector4> tint = null)
        {
            BoneBurstSystem.CompleteNow();
            MeshOutput output = Data.Output[0];
            positions.Clear();
            colors.Clear();
            uvs.Clear();
            tint?.Clear();
            if (!output.Fetched)
            {
                Mesh.GetVertices(positions);
                Mesh.GetColors(colors);
                Mesh.GetUVs(0, uvs);
                if (tint == null || !output.TintStream) return;
                List<Vector2> uv2 = new(), uv3 = new();
                Mesh.GetUVs(1, uv2);
                Mesh.GetUVs(2, uv3);
                for (int i = 0; i < uv2.Count; i++) tint.Add(new Vector4(uv2[i].x, uv2[i].y, uv3[i].x, uv3[i].y));
                return;
            }

            NativeArray<SkeletonVertex> all = BoneBurstFetch.VertexData;
            for (int i = 0; i < output.VertexCount; i++)
            {
                SkeletonVertex v = all[Data.FetchBase + i];
                positions.Add(v.Position);
                colors.Add(new Color32(v.R, v.G, v.B, v.A));
                uvs.Add(v.Uv);
            }

            if (tint == null || !output.TintStream) return;
            NativeArray<float4> allTint = BoneBurstFetch.TintData;
            for (int i = 0; i < output.VertexCount; i++) tint.Add(allTint[Data.FetchBase + i]);
        }

        private void SetTopology(in MeshOutput output, VertexAttributeDescriptor[] layout)
        {
            using ProfilerMarker.AutoScope scope = s_TopologyMarker.Auto();
            BoneBurstSystem.CountTopology();
            Mesh.SetVertexBufferParams(output.VertexCount, layout);
            if (output.WideIndices)
            {
                Mesh.SetIndexBufferParams(output.IndexCount, IndexFormat.UInt32);
                Mesh.SetIndexBufferData(Data.CpuIndices32.AsArray(), 0, 0, output.IndexCount, UploadFlags);
            }
            else
            {
                Mesh.SetIndexBufferParams(output.IndexCount, IndexFormat.UInt16);
                Mesh.SetIndexBufferData(Data.CpuIndices16.AsArray(), 0, 0, output.IndexCount, UploadFlags);
            }

            NativeArray<SubMeshDescriptor> submeshes = new(output.SubmeshCount,
                Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            int start = 0;
            for (int s = 0; s < output.SubmeshCount; s++)
            {
                int end = Data.SubmeshIndexEnd[s];
                submeshes[s] = new SubMeshDescriptor(start, end - start);
                start = end;
            }

            Mesh.SetSubMeshes(submeshes, UploadFlags);
            submeshes.Dispose();
        }

        private void ApplyBounds(in MeshOutput output, bool replaced)
        {
            if (output.VertexCount == 0)
            {
                if (!m_BoundsValid || m_Bounds.size != Vector3.zero || replaced) Mesh.bounds = m_Bounds = default;
                m_BoundsValid = true;
                return;
            }

            Vector3 center = output.Center, extents = output.Extents;
            if (m_BoundsValid && !replaced && Fits(center, extents)) return;
            float pad = 0.02f * Mathf.Max(extents.x, extents.y);
            m_Bounds = new Bounds { center = center, extents = extents * BoundsMargin + new Vector3(pad, pad, 0) };
            Mesh.bounds = m_Bounds;
            m_BoundsValid = true;
        }

        private bool Fits(Vector3 center, Vector3 extents)
        {
            Vector3 min = center - extents, max = center + extents;
            Vector3 setMin = m_Bounds.min, setMax = m_Bounds.max, setExtents = m_Bounds.extents;
            for (int axis = 0; axis < 3; axis++)
            {
                if (min[axis] < setMin[axis] || max[axis] > setMax[axis]) return false;
                if (setExtents[axis] > extents[axis] * BoundsTooLoose + 0.05f * Mathf.Max(extents.x, extents.y))
                    return false;
            }

            return true;
        }

        /// <summary>
        ///     After the mesh job: bounds, and materials when the submesh layout changed.
        /// </summary>
        internal void ApplyMeshOutput()
        {
            MeshOutput output = Data.Output[0];
            m_LastGpuState = output.Gpu;
            // A topology change or a GPU static-mesh rebuild replaced the mesh data: its bounds must be set again.
            bool replaced = output.Gpu == GpuMeshState.Built ||
                            (output.Gpu == GpuMeshState.Cpu && !output.VerticesOnly);
            ApplyBounds(output, replaced);

            bool gpu = output.Gpu == GpuMeshState.Built || output.Gpu == GpuMeshState.Reused;
            if (output.Fetched && m_UserValue != Data.FetchBase)
            {
                // The fetch shader finds this instance's vertices at unity_RendererUserValue.
                m_UserValue = Data.FetchBase;
                Renderer.SetShaderUserValue((uint)Data.FetchBase);
            }

            if (gpu && m_UserValue != Data.GpuBase)
            {
                // The shader finds this instance's pose record at unity_RendererUserValue.
                m_UserValue = Data.GpuBase;
                Renderer.SetShaderUserValue((uint)Data.GpuBase);
            }

            if (output.SubmeshHash == SubmeshHash && m_Materials.Length == output.SubmeshCount) return;

            SubmeshHash = output.SubmeshHash;
            if (m_Materials.Length != output.SubmeshCount) m_Materials = new Material[output.SubmeshCount];

            for (int i = 0; i < output.SubmeshCount; i++)
            {
                int key = Data.SubmeshKeys[i];
                m_Materials[i] = Asset.MaterialFor(key >> 2, (BlendMode)(key & 3), gpu, output.Fetched);
            }

            Renderer.sharedMaterials = m_Materials;
        }

        private static void Copy<T>(List<T> from, NativeList<T> to)
            where T : unmanaged
        {
            to.Resize(from.Count, NativeArrayOptions.UninitializedMemory);
            for (int i = 0; i < from.Count; i++) to[i] = from[i];
        }

        /// <summary>
        ///     The header the system stores for this instance's row.
        /// </summary>
        internal InstanceHeader Header(InstanceFlags flags)
        {
            Data.RefreshIfSkinEdited();
            if (AppliedThisFrame && SteadyThisFrame)
            {
                // The steady step's one Fast command; it reads no modes, hold factors or rotation memory.
                Data.Counters[1] = SteadyUnkeyedState;
                Data.Commands.Resize(1, NativeArrayOptions.UninitializedMemory);
                Data.Commands[0] = SteadyCommand;
                Data.Modes.Clear();
                Data.HoldFactors.Clear();
                Data.Rotation.Clear();
                Data.TotalAlpha.Resize(1, NativeArrayOptions.ClearMemory);
            }
            else if (AppliedThisFrame)
            {
                // Commands into native memory before the header takes its pointers (lists may reallocate).
                Data.Counters[1] = Buffer.UnkeyedState;
                Copy(Buffer.Commands, Data.Commands);
                Copy(Buffer.Modes, Data.Modes);
                Copy(Buffer.HoldFactors, Data.HoldFactors);
                Copy(Buffer.Rotation, Data.Rotation);
                Data.TotalAlpha.Resize(Buffer.Commands.Count, NativeArrayOptions.ClearMemory);
            }
            else
            {
                Data.Commands.Clear();
            }

            float4 color = new(m_Color.r, m_Color.g, m_Color.b, m_Color.a);
            InstanceHeader header = Data.Header(color, m_FlipX ? -1 : 1, m_FlipY ? -1 : 1, Asset.PremultipliedAlpha,
                flags);
            header.ZSpacing = m_ZSpacing;
            header.LinearColorSpace = BoneBurstSystem.LinearColorSpace;
            header.ApplyRan = AppliedThisFrame;
            header.TintBlack = Asset.TintBlack;
            header.Physics = m_NextPhysics;
            m_NextPhysics = PhysicsMode.Update;
            return header;
        }
    }
}