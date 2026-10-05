using System;
using System.Collections.Generic;
using System.Diagnostics;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Instance;
using BoneBurst.Jobs;
using Unity.Collections;
using Unity.Jobs;
using Unity.Mathematics;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.LowLevel;
using UnityEngine.PlayerLoop;
using UnityEngine.Rendering;
using Debug = UnityEngine.Debug;

namespace BoneBurst
{
    /// <summary>
    ///     The one system that ticks every BoneBurst skeleton: no per-instance Update or LateUpdate exists.
    /// </summary>
    /// <remarks>
    ///     Two PlayerLoop entries frame the work (plan §4): <see cref="Schedule" /> right after
    ///     <c>Update.ScriptRunBehaviourUpdate</c>, so gameplay has set this frame's animations, and
    ///     <see cref="Complete" /> at the end of <c>PreLateUpdate</c>, after <c>ScriptRunBehaviourLateUpdate</c>, so
    ///     jobs run beside the Animator and LateUpdate scripts and finish before <c>PostLateUpdate</c> renders. A
    ///     LateUpdate that reads pose data calls <see cref="CompleteNow" /> first.
    ///     <para>
    ///         Only dirty instances are posed and meshed; an unchanged skeleton costs nothing per frame. The mesh of
    ///         every dirty instance is written by <see cref="MeshJob" /> into the instance's persistent scratch, and
    ///         <see cref="BoneBurstSkeleton.UploadCpuMesh" /> uploads it into the <c>Mesh</c>'s existing buffers
    ///         (vertices only while the topology is unchanged).
    ///     </para>
    ///     <para>
    ///         GPU-skinned instances (<see cref="BoneBurstSkeleton.GpuSkinning" />) skip the mesh job: <see cref="GpuJob" />
    ///         writes their pose records, and only a topology change or a CPU fallback builds a mesh, in
    ///         <see cref="LateMeshJob" /> at <see cref="Complete" /> (<c>Doc/Format/GpuSkinning.md</c> §3).
    ///     </para>
    /// </remarks>
    public static class BoneBurstSystem
    {
        private const MeshUpdateFlags ApplyFlags = MeshUpdateFlags.DontRecalculateBounds |
                                                   MeshUpdateFlags.DontValidateIndices |
                                                   MeshUpdateFlags.DontNotifyMeshUsers |
                                                   MeshUpdateFlags.DontResetBoneBounds;

        /// <summary>
        ///     Main-thread time of the two PlayerLoop entries; read with <c>ProfilerRecorder</c>.
        /// </summary>
        public static readonly ProfilerMarker ScheduleMarker = new(ProfilerCategory.Scripts, "BoneBurst.Schedule");

        public static readonly ProfilerMarker CompleteMarker = new(ProfilerCategory.Scripts, "BoneBurst.Complete");

        // The per-instance managed phases inside Schedule and Complete.
        private static readonly ProfilerMarker s_AdvanceMarker = new(ProfilerCategory.Scripts, "BoneBurst.Advance");
        private static readonly ProfilerMarker s_HeadersMarker = new(ProfilerCategory.Scripts, "BoneBurst.Headers");
        private static readonly ProfilerMarker s_ApplyMarker = new(ProfilerCategory.Scripts, "BoneBurst.ApplyMeshes");
        private static readonly ProfilerMarker s_EventsMarker = new(ProfilerCategory.Scripts, "BoneBurst.Events");

        private static readonly ProfilerMarker s_CpuApplyMarker =
            new(ProfilerCategory.Scripts, "BoneBurst.ApplyCpuMeshes");

        private static readonly InstanceTable s_Instances = new();
        private static JobHandle s_Frame;
        private static bool s_Scheduled;

        // Per row, parallel to the table's dense rows. Bare instances (Add() with no component) have a null owner.
        private static readonly List<BoneBurstSkeleton> s_Owners = new();
        private static NativeList<InstanceHeader> s_Headers;

        private static readonly List<(BoneBurstHandle handle, BoneBurstSkeleton owner)> s_PendingAdds = new();
        private static readonly List<InstanceData> s_PendingDisposals = new();
        private static readonly List<BoneBurstSkeleton> s_Dirty = new();
        private static readonly List<BoneBurstSkeleton> s_Playing = new();
        private static readonly List<BoneBurstSkeleton> s_PlayingSnapshot = new();

        // The frame in flight: which owners are being meshed, and their MeshData.
        private static readonly List<BoneBurstSkeleton> s_FrameOwners = new();
        private static readonly List<Mesh> s_FrameMeshes = new();

        // Posed this frame but not meshed (UpdateMode.EverythingExceptMesh while invisible): events only.
        private static readonly List<BoneBurstSkeleton> s_FramePoseOnly = new();
        private static NativeArray<int> s_FrameMeshRows;
        private static NativeArray<int> s_FrameRows;
        private static bool s_FrameHasMeshes;
        private static Mesh s_Scratch;

        // GPU-skinned owners this frame, parallel to s_FrameGpuRows.
        private static readonly List<BoneBurstSkeleton> s_FrameGpuOwners = new();
        private static NativeArray<int> s_FrameGpuRows;
        private static readonly List<BoneBurstSkeleton> s_LateOwners = new();
        private static readonly List<Mesh> s_LateMeshes = new();
        private static readonly List<int> s_LateRows = new();
        private static readonly List<BoneBurstSkeleton> s_FallbackOwners = new();
        private static readonly List<int> s_FallbackRows = new();

        private static BoneBurstPhaseTimes s_Phases;

        private static int s_TopologyChanges;

        /// <summary>
        ///     <c>QualitySettings.activeColorSpace</c> is linear; read once per frame in <see cref="Schedule" />
        ///     rather than once per instance header.
        /// </summary>
        internal static bool LinearColorSpace { get; private set; }

        /// <summary>
        ///     Frames scheduled since the last install. Diagnostic; proves the PlayerLoop entries run.
        /// </summary>
        public static int FramesScheduled { get; private set; }

        /// <summary>
        ///     Frames completed since the last install.
        /// </summary>
        public static int FramesCompleted { get; private set; }

        /// <summary>
        ///     Instances posed and meshed in the last scheduled frame. Diagnostic; 0 when nothing changed.
        /// </summary>
        public static int LastFrameMeshed { get; private set; }

        /// <summary>
        ///     Instances posed in the last scheduled frame, meshed or not (invisible skeletons in
        ///     <see cref="BoneBurstUpdateMode.EverythingExceptMesh" /> are posed only).
        /// </summary>
        public static int LastFramePosed { get; private set; }

        /// <summary>
        ///     CPU meshes whose topology (layout, indices, submeshes) was re-declared in the last completed frame;
        ///     the rest uploaded vertices only. Diagnostic.
        /// </summary>
        public static int LastFrameTopologyChanges { get; private set; }

        /// <summary>
        ///     Times each phase of the frame with a <see cref="System.Diagnostics.Stopwatch" /> timestamp and publishes
        ///     them in <see cref="LastFramePhases" />. Off by default. The benchmark turns it on: a release player's
        ///     <c>ProfilerRecorder</c> reads nothing from the <c>BoneBurst.*</c> markers (Perf2 plan P0).
        /// </summary>
        public static bool TimePhases { get; set; }

        /// <summary>
        ///     The phases of the last completed frame, in milliseconds, while <see cref="TimePhases" /> is on.
        /// </summary>
        public static BoneBurstPhaseTimes LastFramePhases { get; private set; }

        /// <summary>
        ///     GPU-skinned instances in the last completed frame whose static mesh was reused (pose records only).
        /// </summary>
        public static int LastFrameGpuReused { get; private set; }

        /// <summary>
        ///     GPU-skinned instances in the last completed frame whose static mesh was rebuilt.
        /// </summary>
        public static int LastFrameGpuBuilt { get; private set; }

        /// <summary>
        ///     GPU-skinned instances in the last completed frame that fell back to a CPU mesh.
        /// </summary>
        public static int LastFrameGpuFallback { get; private set; }

        /// <summary>
        ///     Instances with a row this frame (adds and removes apply at the next schedule).
        /// </summary>
        public static int InstanceCount => s_Instances.RowCount;

        /// <summary>
        ///     True while both PlayerLoop entries are installed.
        /// </summary>
        public static bool IsInstalled { get; private set; }

        /// <summary>
        ///     True when a <see cref="Schedule(float)" /> has something to do: an instance to pose or mesh, one to add,
        ///     or data to free. The Edit-mode preview ticks only then.
        /// </summary>
        internal static bool HasPendingWork =>
            s_Dirty.Count > 0 || s_PendingAdds.Count > 0 || s_PendingDisposals.Count > 0;

        private static Mesh Scratch
        {
            get
            {
                if (s_Scratch == null)
                    s_Scratch = new Mesh { name = "BoneBurst scratch", hideFlags = HideFlags.HideAndDontSave };

                return s_Scratch;
            }
        }

        internal static void CountTopology()
        {
            s_TopologyChanges++;
        }

        /// <summary>
        ///     Registers a bare instance with no skeleton. It joins the frame at the next <see cref="Schedule" />.
        /// </summary>
        public static BoneBurstHandle Add()
        {
            return Add(null);
        }

        internal static BoneBurstHandle Add(BoneBurstSkeleton owner)
        {
            BoneBurstHandle handle = s_Instances.Add();
            s_PendingAdds.Add((handle, owner));
            if (owner != null)
                // Through MarkDirty: OnEnable may already have queued the owner (ApplySkin). A second entry in
                // s_Dirty would re-read the flags after the first cleared them and drop NeedsSetupPose.
                MarkDirty(owner, InstanceFlags.NeedsSetupPose);

            return handle;
        }

        /// <summary>
        ///     Unregisters an instance. The handle is stale at once; its row is freed at the next schedule.
        /// </summary>
        /// <exception cref="InvalidOperationException">The handle is None or already stale.</exception>
        public static void Remove(BoneBurstHandle handle)
        {
            Remove(handle, null);
        }

        /// <summary>
        ///     Unregisters an instance and frees its data once no job can read it.
        /// </summary>
        internal static void Remove(BoneBurstHandle handle, InstanceData data)
        {
            s_Instances.Remove(handle);
            s_PendingAdds.RemoveAll(p => p.handle == handle);
            if (data != null) s_PendingDisposals.Add(data);

            // A mesh in flight belongs to a component that is going away: let the scratch mesh absorb the write.
            for (int i = 0; i < s_FrameOwners.Count; i++)
                if (s_FrameOwners[i] != null && s_FrameOwners[i].Data == data && data != null)
                {
                    s_FrameOwners[i] = null;
                    s_FrameMeshes[i] = Scratch;
                }

            for (int i = 0; i < s_FrameGpuOwners.Count; i++)
                if (s_FrameGpuOwners[i] != null && s_FrameGpuOwners[i].Data == data && data != null)
                    s_FrameGpuOwners[i] = null;
        }

        /// <summary>
        ///     True while the handle names a registered instance.
        /// </summary>
        public static bool IsAlive(BoneBurstHandle handle)
        {
            return s_Instances.IsAlive(handle);
        }

        /// <summary>
        ///     Queues an instance for posing and meshing at the next schedule.
        /// </summary>
        /// <summary>
        ///     Takes a detached owner out of the dirty queue, so re-enabling it in the same frame queues it once.
        /// </summary>
        internal static void Unqueue(BoneBurstSkeleton owner)
        {
            if (owner.PendingFlags != InstanceFlags.None) s_Dirty.Remove(owner);
        }

        internal static void MarkDirty(BoneBurstSkeleton owner, InstanceFlags flags)
        {
            if (owner.PendingFlags == InstanceFlags.None) s_Dirty.Add(owner);

            owner.PendingFlags |= flags | InstanceFlags.Dirty;
        }

        /// <summary>
        ///     Starts or stops advancing an instance's animation every frame.
        /// </summary>
        internal static void SetPlaying(BoneBurstSkeleton owner, bool playing)
        {
            bool listed = s_Playing.Contains(owner);
            if (playing && !listed) s_Playing.Add(owner);
            else if (!playing && listed) s_Playing.Remove(owner);
        }

        /// <summary>
        ///     Removes every instance that uses <paramref name="blob" />, before the blob's memory is freed.
        /// </summary>
        internal static void DetachAll(SkeletonBlob blob)
        {
            CompleteNow();
            for (int i = s_Owners.Count - 1; i >= 0; i--)
                if (s_Owners[i] != null && s_Owners[i].Data != null && s_Owners[i].Data.Blob == blob)
                    s_Owners[i].Detach();

            foreach ((BoneBurstHandle _, BoneBurstSkeleton owner) in s_PendingAdds.ToArray())
                if (owner != null && owner.Data != null && owner.Data.Blob == blob)
                    owner.Detach();

            FlushDisposals();
        }

        /// <summary>
        ///     Waits for this frame's jobs. Call before reading pose or mesh data mid-frame, or before changing an
        ///     instance's native data; cheap when nothing runs.
        /// </summary>
        public static void CompleteNow()
        {
            if (s_Scheduled) s_Frame.Complete();
        }

        /// <summary>
        ///     Re-poses and re-meshes one instance right now, with no time passing: the frame in flight completes
        ///     first, then the instance's current animation state applies and poses through the same job and apply
        ///     paths as a scheduled frame. The Timeline mixer calls this after <c>SetAnimation</c>, so a clip's first
        ///     pose shows in the same evaluation — what spine-unity's mixer does with
        ///     <c>skeletonAnimation.Update(0)</c> + <c>Renderer.LateUpdate()</c>.
        /// </summary>
        /// <remarks>
        ///     Safe more than once per evaluation: each call settles the frame in flight (a no-op after the first) and
        ///     then runs its own single-row pass. <see cref="BoneBurstUpdateMode.Nothing" /> and
        ///     <see cref="BoneBurstUpdateMode.OnlyAnimationStatus" /> instances are left alone, as the scheduled
        ///     frame leaves them.
        /// </remarks>
        internal static void ReapplyNow(BoneBurstSkeleton owner)
        {
            if (owner == null || owner.Data == null || !s_Instances.IsAlive(owner.Handle)) return;
            if (owner.UpdateMode != BoneBurstUpdateMode.FullUpdate &&
                owner.UpdateMode != BoneBurstUpdateMode.EverythingExceptMesh) return;

            Complete();
            ApplyStructure();
            if (owner.Data == null || !s_Instances.IsAlive(owner.Handle)) return; // a completed listener removed it

            BoneAnimationState state = owner.AnimationState;
            owner.SteadyThisFrame = false;
            state.Update(0);
            if (owner.Data == null) return; // a listener disabled it
            state.Apply(owner.Buffer);
            owner.AppliedThisFrame = true;

            LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear;
            int row = s_Instances.RowOf(owner.Handle);
            bool meshed = owner.UpdateMode == BoneBurstUpdateMode.FullUpdate;
            bool gpu = meshed && owner.GpuSkinning && BoneBurstGpu.IsSupported;
            if (gpu) BoneBurstGpu.Attach(owner.Data, owner.Asset.TintBlack);
            else if (!owner.GpuSkinning) BoneBurstGpu.Release(owner.Data);
            bool fetch = BoneBurstFetch.Active;
            bool fetched = meshed && fetch && (!gpu || owner.Data.FetchNeeded > 0);
            if (fetched) BoneBurstFetch.Attach(owner.Data);
            else BoneBurstFetch.Release(owner.Data);

            InstanceHeader header = owner.Header(InstanceFlags.Dirty);
            if (fetched) BoneBurstFetch.Point(ref header, owner.Data);
            s_Headers[row] = header;

            s_FrameOwners.Clear();
            s_FrameMeshes.Clear();
            s_FrameGpuOwners.Clear();
            List<int> poseRows = new(), meshRows = new(), gpuRows = new();
            if (gpu)
            {
                poseRows.Add(row);
                gpuRows.Add(row);
                s_FrameGpuOwners.Add(owner);
                BoneBurstGpu.MarkWritten(owner.Data.GpuBase, owner.Data.GpuSize);
            }
            else if (meshed)
            {
                meshRows.Add(row);
                s_FrameOwners.Add(owner);
                s_FrameMeshes.Add(owner.Mesh);
            }

            else if (!meshed)
            {
                poseRows.Add(row);
            }

            JobHandle frame = ScheduleJobs(poseRows, meshRows, gpuRows, fetch);
            frame.Complete();

            for (int i = 0; i < s_FrameOwners.Count; i++)
            {
                BoneBurstSkeleton cpu = s_FrameOwners[i];
                if (cpu != null && cpu.Data != null)
                {
                    cpu.UploadCpuMesh();
                    cpu.ApplyMeshOutput();
                }
            }

            CompleteGpu();
            if (fetch) BoneBurstFetch.EndFrame();
            DeliverEvents(owner);
            s_FrameRows.Dispose();
            s_FrameMeshRows.Dispose();
            s_FrameGpuRows.Dispose();
            s_FrameOwners.Clear();
            s_FrameMeshes.Clear();
            s_FrameGpuOwners.Clear();
        }

        /// <summary>
        ///     Inserts the two PlayerLoop entries. Idempotent: removes earlier copies first, so an Editor play
        ///     session that inherits last session's loop does not tick twice.
        /// </summary>
        public static void Install()
        {
            PlayerLoopSystem root = PlayerLoop.GetCurrentPlayerLoop();
            RemoveOurs(ref root);
            bool scheduleIn = InsertAfter(ref root, typeof(Update), typeof(Update.ScriptRunBehaviourUpdate),
                new PlayerLoopSystem { type = typeof(BoneBurstSchedule), updateDelegate = Schedule });
            bool completeIn = InsertAtEnd(ref root, typeof(PreLateUpdate),
                new PlayerLoopSystem { type = typeof(BoneBurstComplete), updateDelegate = Complete });
            if (!scheduleIn || !completeIn)
                // Loud, not silent: without both entries no skeleton would ever update.
                throw new InvalidOperationException(
                    "BoneBurst: PlayerLoop has no Update.ScriptRunBehaviourUpdate or PreLateUpdate; not installed.");

            PlayerLoop.SetPlayerLoop(root);
            IsInstalled = true;
        }

        /// <summary>
        ///     Removes the PlayerLoop entries, finishes any running frame, detaches every skeleton and frees the system's
        ///     memory, leaving it empty: a later <see cref="Schedule()" /> (the Edit-mode preview after Play) starts clean.
        /// </summary>
        /// <remarks>
        ///     Detaching first keeps the instance table and the per-row data in step. Freeing the headers while the table
        ///     still held rows let a skeleton disabled afterwards queue a removal whose row move then indexed an empty
        ///     header list (2026-10-01, the Edit-mode preview after leaving Play mode).
        /// </remarks>
        public static void Uninstall()
        {
            Complete();
            for (int i = s_Owners.Count - 1; i >= 0; i--)
                if (s_Owners[i] != null)
                    s_Owners[i].Detach();

            foreach ((BoneBurstHandle _, BoneBurstSkeleton owner) in s_PendingAdds.ToArray())
                if (owner != null)
                    owner.Detach();

            PlayerLoopSystem root = PlayerLoop.GetCurrentPlayerLoop();
            RemoveOurs(ref root);
            PlayerLoop.SetPlayerLoop(root);
            IsInstalled = false;
            FlushDisposals();
            if (s_Headers.IsCreated) s_Headers.Dispose();
            BoneBurstGpu.Dispose();
            BoneBurstFetch.Dispose();
            s_Instances.Clear();
            s_Owners.Clear();
            s_PendingAdds.Clear();
            s_Dirty.Clear();
            s_Playing.Clear();
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetForPlaySession()
        {
            // Statics survive between play sessions when domain reload is off; start each session empty.
            Complete();
            s_Instances.Clear();
            s_Owners.Clear();
            s_PendingAdds.Clear();
            s_Dirty.Clear();
            s_Playing.Clear();
            FlushDisposals();
            if (s_Headers.IsCreated) s_Headers.Dispose();
            BoneBurstGpu.Dispose();
            BoneBurstFetch.Dispose();
            FramesScheduled = 0;
            FramesCompleted = 0;
            Install();
            // In the Editor this fires on leaving Play mode; without it the entries would keep ticking in Edit mode.
            Application.quitting -= Uninstall;
            Application.quitting += Uninstall;
        }

        internal static void Schedule()
        {
            Schedule(Time.deltaTime, Time.unscaledDeltaTime);
        }

        /// <param name="delta">Seconds to advance playing skeletons on both clocks (the Edit-mode preview passes 0).</param>
        internal static void Schedule(float delta)
        {
            Schedule(delta, delta);
        }

        /// <param name="delta">
        ///     Seconds to advance playing skeletons on the scaled clock: the frame's delta, or 0 for the Edit-mode
        ///     preview.
        /// </param>
        /// <param name="unscaledDelta">
        ///     Seconds on the unscaled clock, for skeletons with
        ///     <see cref="BoneBurstSkeleton.UnscaledTime" /> set.
        /// </param>
        internal static void Schedule(float delta, float unscaledDelta)
        {
            using ProfilerMarker.AutoScope scope = ScheduleMarker.Auto();
            long scheduleStart = Stamp();
            // The previous frame always completed in PreLateUpdate; anything removed since is safe to free now.
            FlushDisposals();
            ApplyStructure();

            s_FrameOwners.Clear();
            s_FrameMeshes.Clear();
            s_FrameGpuOwners.Clear();

            // Advance every playing skeleton; each one is posed and meshed this frame.
            // A snapshot: listeners called from Update may enable, disable or start other skeletons.
            s_PlayingSnapshot.Clear();
            s_PlayingSnapshot.AddRange(s_Playing);
            long advanceStart = Stamp();
            s_AdvanceMarker.Begin();
            foreach (BoneBurstSkeleton owner in s_PlayingSnapshot)
            {
                if (owner == null || owner.Data == null)
                {
                    s_Playing.Remove(owner);
                    continue;
                }

                // Invisible skeletons do what their UpdateWhenInvisible allows (Skins-TintBlack-Culling.md §4.3).
                if (owner.UpdateMode == BoneBurstUpdateMode.Nothing) continue;

                // spine-unity order: Update (Start/Interrupt/End/Dispose delivered), then Apply (commands).
                BoneAnimationState state = owner.AnimationState;
                float scaled = (owner.UnscaledTime ? unscaledDelta : delta) * owner.TimeScale;
                // The steady state does both in one step, with nothing to deliver (Perf2 plan P6).
                if (owner.UpdateMode != BoneBurstUpdateMode.OnlyAnimationStatus &&
                    state.TryAdvanceSteady(scaled, out ApplyCommand steady, out int unkeyed))
                {
                    owner.AdvancePhysics(scaled);
                    owner.SteadyThisFrame = true;
                    owner.SteadyCommand = steady;
                    owner.SteadyUnkeyedState = unkeyed;
                    owner.AppliedThisFrame = true;
                    MarkDirty(owner, InstanceFlags.Dirty);
                    continue;
                }

                owner.SteadyThisFrame = false;
                state.Update(scaled);
                if (owner.Data == null) continue; // a listener disabled it
                owner.AdvancePhysics(scaled);
                if (owner.UpdateMode == BoneBurstUpdateMode.OnlyAnimationStatus) continue;
                state.Apply(owner.Buffer);
                owner.AppliedThisFrame = true;
                MarkDirty(owner, InstanceFlags.Dirty);
                // A skeleton with physics keeps stepping when no animation plays.
                if (!state.HasEntries && !owner.Data.HasPhysics) s_Playing.Remove(owner);
            }

            s_AdvanceMarker.End();
            long advanceEnd = Stamp();

            s_FramePoseOnly.Clear();
            List<int> rows = new(), poseRows = new(), meshRows = new(), gpuRows = new();
            bool gpuSupported = BoneBurstGpu.IsSupported;
            bool fetch = BoneBurstFetch.Active;
            LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear;
            s_HeadersMarker.Begin();
            foreach (BoneBurstSkeleton owner in s_Dirty)
            {
                InstanceFlags flags = owner.PendingFlags;
                owner.PendingFlags = InstanceFlags.None;
                // A second entry for the same owner (flags already taken this frame) must not pose or mesh it
                // twice: the second build would lose NeedsSetupPose, and would see the first build's topology.
                if (flags == InstanceFlags.None || owner.Data == null || !s_Instances.IsAlive(owner.Handle)) continue;

                int row = s_Instances.RowOf(owner.Handle);
                // The mesh: when visible (FullUpdate), and always after a reset (the first mesh gives the bounds
                // visibility needs, as spine-unity builds one after init whatever the mode).
                bool meshed = owner.UpdateMode == BoneBurstUpdateMode.FullUpdate ||
                              (flags & InstanceFlags.NeedsSetupPose) != 0;
                bool gpu = meshed && owner.GpuSkinning && gpuSupported;
                if (gpu) BoneBurstGpu.Attach(owner.Data, owner.Asset.TintBlack);
                else if (!owner.GpuSkinning) BoneBurstGpu.Release(owner.Data);
                // CPU-meshed instances, and GPU ones that have fallen back to the CPU mesh before (deform, clipping):
                // their fallback frames then use vertex fetch too. FetchNeeded is 0 until a first CPU mesh.
                if (meshed && fetch && (!gpu || owner.Data.FetchNeeded > 0)) BoneBurstFetch.Attach(owner.Data);
                else BoneBurstFetch.Release(owner.Data);
                s_Headers[row] = owner.Header(flags);
                rows.Add(row);
                if (gpu)
                {
                    poseRows.Add(row);
                    gpuRows.Add(row);
                    s_FrameGpuOwners.Add(owner);
                    BoneBurstGpu.MarkWritten(owner.Data.GpuBase, owner.Data.GpuSize);
                }
                else if (meshed)
                {
                    meshRows.Add(row);
                    s_FrameOwners.Add(owner);
                    s_FrameMeshes.Add(owner.Mesh);
                }
                else
                {
                    poseRows.Add(row);
                    s_FramePoseOnly.Add(owner);
                }
            }

            // After every attach: an attach may grow (move) the shared fetch lists.
            if (fetch)
            {
                for (int i = 0; i < meshRows.Count; i++)
                {
                    InstanceHeader header = s_Headers[meshRows[i]];
                    BoneBurstFetch.Point(ref header, s_FrameOwners[i].Data);
                    s_Headers[meshRows[i]] = header;
                }

                // GPU rows too: a frame that falls back to the CPU mesh (CompleteGpu) writes through the same header.
                for (int i = 0; i < gpuRows.Count; i++)
                {
                    InstanceHeader header = s_Headers[gpuRows[i]];
                    BoneBurstFetch.Point(ref header, s_FrameGpuOwners[i].Data);
                    s_Headers[gpuRows[i]] = header;
                }
            }

            s_HeadersMarker.End();
            long headersEnd = Stamp();
            s_Dirty.Clear();
            LastFrameMeshed = meshRows.Count;
            LastFramePosed = rows.Count;
            s_Frame = default;
            s_FrameHasMeshes = rows.Count > 0;
            if (s_FrameHasMeshes) s_Frame = ScheduleJobs(poseRows, meshRows, gpuRows, fetch);

            s_Scheduled = true;
            FramesScheduled++;
            if (TimePhases)
            {
                long scheduleEnd = Stamp();
                s_Phases = new BoneBurstPhaseTimes
                {
                    Schedule = Ms(scheduleStart, scheduleEnd),
                    Advance = Ms(advanceStart, advanceEnd),
                    Headers = Ms(advanceEnd, headersEnd),
                    JobSetup = Ms(headersEnd, scheduleEnd)
                };
            }
        }

        internal static void Complete()
        {
            if (!s_Scheduled) return;

            using ProfilerMarker.AutoScope scope = CompleteMarker.Auto();
            long completeStart = Stamp();
            s_Frame.Complete();
            long waitEnd = Stamp();
            s_Scheduled = false;
            FramesCompleted++;
            if (!s_FrameHasMeshes)
            {
                PublishPhases(completeStart, waitEnd, waitEnd, waitEnd);
                return;
            }

            s_FrameHasMeshes = false;
            s_TopologyChanges = 0;
            s_ApplyMarker.Begin();
            s_CpuApplyMarker.Begin();
            for (int i = 0; i < s_FrameOwners.Count; i++)
            {
                BoneBurstSkeleton owner = s_FrameOwners[i];
                if (owner != null && owner.Data != null)
                {
                    owner.UploadCpuMesh();
                    owner.ApplyMeshOutput();
                }
            }

            s_CpuApplyMarker.End();

            CompleteGpu();
            // After CompleteGpu: GPU instances falling back to the CPU mesh write their vertices there too.
            BoneBurstFetch.EndFrame();
            s_ApplyMarker.End();
            long applyEnd = Stamp();
            s_EventsMarker.Begin();

            // Events after every mesh is applied, so a callback sees this frame's pose and may change anything.
            for (int i = 0; i < s_FrameOwners.Count; i++)
            {
                BoneBurstSkeleton owner = s_FrameOwners[i];
                if (owner != null && owner.Data != null && owner.AppliedThisFrame) DeliverEvents(owner);
            }

            for (int i = 0; i < s_FrameGpuOwners.Count; i++)
            {
                BoneBurstSkeleton owner = s_FrameGpuOwners[i];
                if (owner != null && owner.Data != null && owner.AppliedThisFrame) DeliverEvents(owner);
            }

            foreach (BoneBurstSkeleton owner in s_FramePoseOnly)
                if (owner != null && owner.Data != null && owner.AppliedThisFrame)
                    DeliverEvents(owner);

            s_EventsMarker.End();
            PublishPhases(completeStart, waitEnd, applyEnd, Stamp());
            LastFrameTopologyChanges = s_TopologyChanges;
            s_FramePoseOnly.Clear();
            s_FrameRows.Dispose();
            s_FrameMeshRows.Dispose();
            s_FrameGpuRows.Dispose();
            s_FrameOwners.Clear();
            s_FrameMeshes.Clear();
            s_FrameGpuOwners.Clear();
        }

        /// <summary>
        ///     GPU-skinned owners: the meshes <see cref="GpuJob" /> left are built now, static-mesh rebuilds in
        ///     <see cref="LateMeshJob" /> and CPU fallbacks in <see cref="MeshJob" /> beside it; then every owner
        ///     applies its output and the pose records are uploaded.
        /// </summary>
        private static void CompleteGpu()
        {
            int reused = 0, built = 0, fallback = 0;
            s_LateOwners.Clear();
            s_LateMeshes.Clear();
            s_LateRows.Clear();
            s_FallbackOwners.Clear();
            s_FallbackRows.Clear();
            for (int i = 0; i < s_FrameGpuOwners.Count; i++)
            {
                BoneBurstSkeleton owner = s_FrameGpuOwners[i];
                if (owner == null || owner.Data == null) continue;
                GpuMeshState state = owner.Data.Output[0].Gpu;
                if (state == GpuMeshState.Reused)
                {
                    reused++;
                    continue;
                }

                if (state == GpuMeshState.NeedsCpu)
                {
                    fallback++;
                    s_FallbackOwners.Add(owner);
                    s_FallbackRows.Add(s_FrameGpuRows[i]);
                    continue;
                }

                built++;
                s_LateOwners.Add(owner);
                s_LateMeshes.Add(owner.Mesh);
                s_LateRows.Add(s_FrameGpuRows[i]);
            }

            if (s_LateOwners.Count > 0 || s_FallbackOwners.Count > 0)
            {
                NativeArray<int> rows = new(s_LateRows.ToArray(), Allocator.TempJob);
                NativeArray<int> fallbackRows = new(s_FallbackRows.ToArray(), Allocator.TempJob);
                bool rebuild = rows.Length > 0;
                Mesh.MeshDataArray meshes = rebuild ? Mesh.AllocateWritableMeshData(rows.Length) : default;
                JobHandle late = rebuild
                    ? new LateMeshJob { Headers = s_Headers.AsArray(), Rows = rows, Meshes = meshes }.Schedule(
                        rows.Length, 1)
                    : default;
                JobHandle cpu = fallbackRows.Length > 0
                    ? new MeshJob { Headers = s_Headers.AsArray(), Rows = fallbackRows }.Schedule(fallbackRows.Length,
                        1)
                    : default;
                // The fallbacks' fetch ranges into the locked ring buffer, after their mesh job (off the main thread).
                NativeArray<int2> fetchRanges = new(s_FallbackOwners.Count, Allocator.TempJob);
                int ranges = 0;
                foreach (BoneBurstSkeleton owner in s_FallbackOwners)
                {
                    int2 range = BoneBurstFetch.RangeOf(owner.Data);
                    if (range.y > 0) fetchRanges[ranges++] = range;
                }

                JobHandle copied = BoneBurstFetch.ScheduleLate(fetchRanges.GetSubArray(0, ranges), cpu);
                JobHandle.CombineDependencies(late, copied).Complete();
                fetchRanges.Dispose();
                rows.Dispose();
                fallbackRows.Dispose();
                if (rebuild) Mesh.ApplyAndDisposeWritableMeshData(meshes, s_LateMeshes, ApplyFlags);
                foreach (BoneBurstSkeleton owner in s_FallbackOwners)
                {
                    // Its fetch range was copied by BoneBurstFetch.ScheduleLate above; UploadCpuMesh marks tint.
                    owner.UploadCpuMesh();

                    // The static GPU mesh is gone from the Mesh: the next GPU-eligible frame rebuilds it.
                    if (owner.Data.GpuTopology.IsCreated) owner.Data.GpuTopology[0] = 0;
                }
            }

            for (int i = 0; i < s_FrameGpuOwners.Count; i++)
            {
                BoneBurstSkeleton owner = s_FrameGpuOwners[i];
                if (owner != null && owner.Data != null) owner.ApplyMeshOutput();
            }

            if (s_FrameGpuOwners.Count > 0) BoneBurstGpu.Upload();
            LastFrameGpuReused = reused;
            LastFrameGpuBuilt = built;
            LastFrameGpuFallback = fallback;
        }

        /// <summary>
        ///     Schedules one frame's jobs over the header rows and returns the handle that completes them. Pose-only
        ///     and GPU rows: <see cref="PoseJob" />, then <see cref="GpuJob" /> for the GPU ones. CPU-meshed rows:
        ///     <see cref="PoseMeshJob" />, which poses and meshes in one work item. Then the vertex-fetch copy into the
        ///     locked GPU buffer, after every mesh write. One instance per work item: larger batches measured slower
        ///     (Perf2 plan P1). The row arrays live until <see cref="Complete" /> (or the caller) disposes them.
        /// </summary>
        private static JobHandle ScheduleJobs(List<int> poseRows, List<int> meshRows, List<int> gpuRows, bool fetch)
        {
            NativeArray<InstanceHeader> headers = s_Headers.AsArray();
            s_FrameRows = new NativeArray<int>(poseRows.ToArray(), Allocator.TempJob);
            s_FrameMeshRows = new NativeArray<int>(meshRows.ToArray(), Allocator.TempJob);
            s_FrameGpuRows = new NativeArray<int>(gpuRows.ToArray(), Allocator.TempJob);
            JobHandle pose = new PoseJob { Headers = headers, Rows = s_FrameRows }.Schedule(poseRows.Count, 1);
            JobHandle meshes =
                new PoseMeshJob { Headers = headers, Rows = s_FrameMeshRows }.Schedule(meshRows.Count, 1);
            JobHandle gpu = gpuRows.Count > 0
                ? new GpuJob { Headers = headers, Rows = s_FrameGpuRows, Pose = BoneBurstGpu.PoseData }
                    .Schedule(gpuRows.Count, 1, pose)
                : pose;
            JobHandle frame = JobHandle.CombineDependencies(meshes, gpu);
            if (fetch) frame = BoneBurstFetch.BeginFrame(frame);

            JobHandle.ScheduleBatchedJobs();
            return frame;
        }

        private static long Stamp()
        {
            return TimePhases ? Stopwatch.GetTimestamp() : 0;
        }

        private static double Ms(long from, long to)
        {
            return (to - from) * 1000.0 / Stopwatch.Frequency;
        }

        private static void PublishPhases(long completeStart, long waitEnd, long applyEnd, long eventsEnd)
        {
            if (!TimePhases) return;
            s_Phases.Wait = Ms(completeStart, waitEnd);
            s_Phases.Apply = Ms(waitEnd, applyEnd);
            s_Phases.Events = Ms(applyEnd, eventsEnd);
            s_Phases.Complete = Ms(completeStart, eventsEnd);
            LastFramePhases = s_Phases;
        }

        private static void DeliverEvents(BoneBurstSkeleton owner)
        {
            InstanceData data = owner.Data;
            owner.AppliedThisFrame = false;
            int fired = data.Counters[0];
            if (fired > data.Events.Length)
            {
                Debug.LogError(
                    $"BoneBurst: {owner.name} fired {fired} events in one frame; only {data.Events.Length} fit. The rest were dropped.",
                    owner);
                fired = data.Events.Length;
            }

            ReadOnlySpan<FiredEvent> events = data.Events.AsReadOnlySpan().Slice(0, fired);
            if (owner.SteadyThisFrame)
            {
                // A steady frame with no event and no Complete has nothing to deliver; the rest go the same way.
                owner.SteadyThisFrame = false;
                if (owner.AnimationState.SteadyNeedsAfter(fired)) owner.AnimationState.AfterSteady(events);
                return;
            }

            owner.AnimationState.AfterApply(owner.Buffer, events,
                data.TotalAlpha.AsArray().AsReadOnlySpan(), data.Rotation.AsArray().AsReadOnlySpan());
        }

        /// <summary>
        ///     Applies queued removes and adds, keeping owners and headers parallel to the table's rows.
        /// </summary>
        private static void ApplyStructure()
        {
            if (!s_Headers.IsCreated) s_Headers = new NativeList<InstanceHeader>(64, Allocator.Persistent);

            s_Instances.Apply(MoveRow);
            int rows = s_Instances.RowCount;
            while (s_Owners.Count < rows) s_Owners.Add(null);
            if (s_Owners.Count > rows) s_Owners.RemoveRange(rows, s_Owners.Count - rows);
            s_Headers.Resize(rows, NativeArrayOptions.ClearMemory);

            foreach ((BoneBurstHandle handle, BoneBurstSkeleton owner) in s_PendingAdds)
            {
                int row = s_Instances.RowOf(handle);
                s_Owners[row] = owner;
                s_Headers[row] = default;
            }

            s_PendingAdds.Clear();
        }

        private static void MoveRow(int from, int to)
        {
            s_Owners[to] = s_Owners[from];
            s_Headers[to] = s_Headers[from];
        }

        private static void FlushDisposals()
        {
            foreach (InstanceData data in s_PendingDisposals) data.Dispose();

            s_PendingDisposals.Clear();
        }

        private static bool InsertAfter(ref PlayerLoopSystem root, Type phase, Type after, PlayerLoopSystem entry)
        {
            for (int i = 0; i < root.subSystemList.Length; i++)
            {
                if (root.subSystemList[i].type != phase) continue;

                PlayerLoopSystem[] children = root.subSystemList[i].subSystemList;
                int index = Array.FindIndex(children, child => child.type == after);
                if (index < 0) return false;

                PlayerLoopSystem[] grown = new PlayerLoopSystem[children.Length + 1];
                Array.Copy(children, 0, grown, 0, index + 1);
                grown[index + 1] = entry;
                Array.Copy(children, index + 1, grown, index + 2, children.Length - index - 1);
                root.subSystemList[i].subSystemList = grown;
                return true;
            }

            return false;
        }

        private static bool InsertAtEnd(ref PlayerLoopSystem root, Type phase, PlayerLoopSystem entry)
        {
            for (int i = 0; i < root.subSystemList.Length; i++)
            {
                if (root.subSystemList[i].type != phase) continue;

                PlayerLoopSystem[] children = root.subSystemList[i].subSystemList ?? Array.Empty<PlayerLoopSystem>();
                PlayerLoopSystem[] grown = new PlayerLoopSystem[children.Length + 1];
                Array.Copy(children, grown, children.Length);
                grown[children.Length] = entry;
                root.subSystemList[i].subSystemList = grown;
                return true;
            }

            return false;
        }

        private static void RemoveOurs(ref PlayerLoopSystem root)
        {
            if (root.subSystemList == null) return;

            for (int i = 0; i < root.subSystemList.Length; i++)
            {
                PlayerLoopSystem[] children = root.subSystemList[i].subSystemList;
                if (children == null) continue;

                root.subSystemList[i].subSystemList = Array.FindAll(children,
                    child => child.type != typeof(BoneBurstSchedule) && child.type != typeof(BoneBurstComplete));
            }
        }

        /// <summary>
        ///     PlayerLoop marker for <see cref="Schedule" />.
        /// </summary>
        public struct BoneBurstSchedule
        {
        }

        /// <summary>
        ///     PlayerLoop marker for <see cref="Complete" />.
        /// </summary>
        public struct BoneBurstComplete
        {
        }
    }
}