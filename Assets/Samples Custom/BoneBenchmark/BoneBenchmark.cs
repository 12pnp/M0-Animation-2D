using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Cysharp.Threading.Tasks;
using ModuleP1;
using Spine.Unity;
using BoneBurst;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.SceneManagement;
using Random = System.Random;

/// <summary>
///     Stock spine-unity against BoneBurst in a real scene: N copies of one skeleton, all on screen, animating,
///     measured per frame and written to CSV. One configuration per scene load; a suite reloads the scene between
///     configurations so no runtime inherits the previous one's state.
/// </summary>
/// <remarks>
///     Fair by construction: the same export (BoneBurstDemo/mix-and-match-pro, skin <see cref="Skin" />), scale, grid, camera, animation and
///     seeded start times on every side; nothing culled (FullUpdate on both); vSync off. Stock runs once
///     single-threaded and once with its own threaded animation + mesh generation (spine-unity 4.3
///     SkeletonUpdateSystem). Stock draws with the URP 2D Spine shader, BoneBurst with BoneBurst/Unlit.
///     Player command line (overrides the Inspector): <c>-boneBench</c> (run the suite and quit),
///     <c>-runtime Stock|StockThreaded|BurstCpu|BurstGpu</c>, <c>-count N</c>, <c>-anim name</c>,
///     <c>-warmup N</c>, <c>-frames N</c>, <c>-repeats N</c>, <c>-anims a,b,…</c> (suite animations; <c>switch</c>
///     keeps changing animation), <c>-out dir</c>, <c>-quit</c> (quit after a single run),
///     <c>-profileTo dir</c> (development players: a Profiler .raw capture of exactly the measured frames),
///     <c>-loadBench N</c> (load time instead of frame time: <see cref="BoneBenchmarkLoad" />),
///     <c>-counts a,b,…</c> and <c>-runtimes a,b,…</c> (narrow the suite).
///     Editor numbers include Editor overhead and job safety checks; the summary marks them.
/// </remarks>
public sealed class BoneBenchmark : MonoBehaviour
{
    public enum BenchRuntime
    {
        Stock,
        StockThreaded,
        BurstCpu,
        BurstGpu
    }

    [Serializable]
    public struct BenchConfig
    {
        public BenchRuntime Runtime;
        public int Count;
        public string Animation;
    }

    [Header("Content")]
    public BoneBurstAsset BurstAsset;
    public SkeletonDataAsset StockAsset;
    [Tooltip("Skin worn on both sides: mix-and-match-pro's default skin is empty.")]
    public string Skin = "full-skins/girl";
    [Tooltip("Stock atlas material replacement: the same texture with the URP 2D Spine shader.")]
    public Material StockMaterial;
    public Camera Camera;

    [Header("Single run (Inspector, Play mode)")]
    public BenchRuntime Runtime = BenchRuntime.BurstCpu;
    public int Count = 500;
    public string Animation = "walk";

    [Header("Suite")]
    [Tooltip("Run every runtime × count × animation, reloading the scene between runs.")]
    public bool RunSuite;
    public int[] SuiteCounts = { 100, 500, 2000 };
    [Tooltip("\"switch\": every skeleton changes animation every 0.5–1.5 s (seeded, the same sequence per skeleton on " +
             "every runtime), crossfading by the asset's mix (0.2 s on both).")]
    public string[] SuiteAnimations = { "idle", "walk", SwitchMode };
    [Tooltip("Each repeat reverses the runtime order, so drift and heat cancel (ABBA).")]
    public int SuiteRepeats = 2;
    [Tooltip("In a player, quit after the suite.")]
    public bool QuitWhenDone = true;

    [Header("Measurement")]
    public int WarmupFrames = 60;
    public int MeasuredFrames = 600;
    public int Seed = 12345;
    [Tooltip("Empty: persistentDataPath/BoneBenchmark. The -out argument wins.")]
    public string OutputFolder;

    /// <summary>
    ///     The animation name that makes every skeleton keep changing animation (<see cref="SwitchAnimations" />).
    /// </summary>
    public const string SwitchMode = "switch";

    // Transform constraints (walk, run), attachment changes, draw order and IK (pickaxe-action, shovel-run): switching
    // between them changes poses, mixes and topology. mix-and-match-pro has no event timelines (spineboy-pro, the
    // skeleton before 2026-10-02, had; Assets/Docs-Plan/Demo-MixAndMatch-Plan.md).
    static readonly string[] SwitchAnimations = { "idle", "walk", "run", "pickaxe-action", "shovel-run" };

    const float CellHeight = 1f;
    const float CellWidth = 0.75f;
    const float SkeletonHeight = 9f;

    static readonly string[] s_Columns =
    {
        "frame_ms", "cpu_main_ms", "cpu_render_ms", "gpu_ms", "gc_bytes", "script_update_ms", "script_late_ms",
        "burst_schedule_ms", "burst_complete_ms", "burst_topology",
        // Perf2 plan P0: BoneBurst's phases (BoneBurstSystem.TimePhases, release players too) and Unity's own
        // main-thread render submit, present wait and whole player loop.
        "burst_advance_ms", "burst_headers_ms", "burst_jobsetup_ms", "burst_wait_ms", "burst_apply_ms",
        "burst_events_ms", "unity_render_ms", "unity_present_wait_ms", "playerloop_ms"
    };

    // Survives scene reloads within one suite.
    static List<BenchConfig> s_Queue;
    static int s_Next;
    static string s_RunId;
    static string s_OutDir;
    static bool s_QuitAfterRun;
    static string s_ProfileTo;
    static int s_LoadBench;
    static BenchRuntime[] s_Runtimes;

    readonly List<GameObject> m_Spawned = new();
    readonly List<Spine.AnimationState> m_StockStates = new();
    readonly List<BoneBurstSkeleton> m_BurstSkeletons = new();
    float[] m_NextSwitch;
    int[] m_Switches;
    float m_Clock;
    readonly FrameTiming[] m_Timing = new FrameTiming[1];
    BenchConfig m_Config;
    int m_Frame;
    double[][] m_Samples;
    ProfilerRecorder m_Gc, m_ScriptUpdate, m_ScriptLate, m_BurstSchedule, m_BurstComplete;
    ProfilerRecorder m_Render, m_PresentWait, m_PlayerLoop;
    bool m_Done;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    static void ResetForPlaySession()
    {
        s_LoadBench = 0;
        s_Runtimes = null;
        // Statics survive between Editor play sessions when domain reload is off; a stopped suite must not resume.
        s_Queue = null;
        s_Next = 0;
        s_OutDir = null;
        s_QuitAfterRun = false;
        s_ProfileTo = null;
    }

    IEnumerator Start()
    {
        QualitySettings.vSyncCount = 0;
        Application.targetFrameRate = -1;
        // A player whose window loses focus stops updating (Player Settings run-in-background is off here),
        // which stalls a long suite mid-run.
        Application.runInBackground = true;
        if (BurstAsset != null)
        {
            // The asset's data comes through the AssetRuntime (AssetRuntimeHost on [AssetManager] in this scene): wait for it, so no
            // skeleton spawns before its blob exists and nothing waiting is timed.
            UniTask prepare = BurstAsset.PrepareAsync();
            while (prepare.Status == UniTaskStatus.Pending) yield return null;
            if (prepare.Status != UniTaskStatus.Succeeded)
            {
                string reason = "unknown";
                try
                {
                    prepare.GetAwaiter().GetResult();
                }
                catch (Exception e)
                {
                    reason = e.Message;
                }

                Debug.LogError($"[BoneBenchmark] {BurstAsset.name} did not load: {reason}");
                m_Done = true;
                if (!Application.isEditor) Application.Quit(1);
                yield break;
            }
        }

        ReadCommandLine();

        if (s_Queue == null)
        {
            s_RunId = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
            if (s_OutDir == null && !string.IsNullOrEmpty(OutputFolder)) s_OutDir = OutputFolder;
            s_OutDir ??= Path.Combine(Application.persistentDataPath, "BoneBenchmark");
            Directory.CreateDirectory(s_OutDir);
            s_Queue = RunSuite ? BuildSuite() : new List<BenchConfig>
            {
                new() { Runtime = Runtime, Count = Count, Animation = Animation }
            };
            s_Next = 0;
            Debug.Log($"[BoneBenchmark] run {s_RunId}: {s_Queue.Count} configuration(s), output {s_OutDir}");

            if (s_LoadBench > 0)
            {
                // Load time instead of frame time: measure, write loadtime.csv, quit (BoneBenchmarkLoad). The bytes
                // timed are the asset's own data file, loaded once through the AssetRuntime (BoneBurstAsset).
                UniTask<byte[]> load = BurstAsset.LoadDataBytesAsync();
                while (load.Status == UniTaskStatus.Pending) yield return null;
                byte[] data = load.GetAwaiter().GetResult();
                List<BoneBenchmarkLoad.Row> rows = BoneBenchmarkLoad.Measure(data, StockAsset, s_LoadBench);
                string backend = Application.isEditor ? "Editor" : Backend;
                string path = BoneBenchmarkLoad.Write(s_OutDir, s_RunId, backend, s_LoadBench, rows);
                foreach (BoneBenchmarkLoad.Row row in rows)
                {
                    Debug.Log($"[BoneBenchmark] load {row.Metric}: median {row.MedianMs:F3} ms, p95 {row.P95Ms:F3}, min {row.MinMs:F3}");
                }

                Debug.Log($"[BoneBenchmark] load time written to {path}");
                s_Queue = null;
                s_LoadBench = 0;
                m_Done = true;
                if (!Application.isEditor) Application.Quit();
                yield break;
            }
        }

        if (s_Next >= s_Queue.Count)
        {
            Finish();
            yield break;
        }

        m_Config = s_Queue[s_Next];
        if (!Validate()) yield break;
        Spawn();
        FitCamera();
        GC.Collect();

        m_Samples = new double[s_Columns.Length][];
        for (int c = 0; c < s_Columns.Length; c++)
        {
            m_Samples[c] = new double[MeasuredFrames];
        }

        m_Gc = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame");
        m_ScriptUpdate = ProfilerRecorder.StartNew(ProfilerCategory.Scripts, "Update.ScriptRunBehaviourUpdate");
        m_ScriptLate = ProfilerRecorder.StartNew(ProfilerCategory.Scripts, "PreLateUpdate.ScriptRunBehaviourLateUpdate");
        m_BurstSchedule = ProfilerRecorder.StartNew(ProfilerCategory.Scripts, "BoneBurst.Schedule");
        m_BurstComplete = ProfilerRecorder.StartNew(ProfilerCategory.Scripts, "BoneBurst.Complete");
        m_Render = ProfilerRecorder.StartNew(ProfilerCategory.Render, "PostLateUpdate.FinishFrameRendering");
        m_PresentWait = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Gfx.WaitForPresentOnGfxThread");
        m_PlayerLoop = ProfilerRecorder.StartNew(ProfilerCategory.Internal, "PlayerLoop");
        BoneBurstSystem.TimePhases = m_Config.Runtime is BenchRuntime.BurstCpu or BenchRuntime.BurstGpu;
        Debug.Log($"[BoneBenchmark] {s_Next + 1}/{s_Queue.Count}: {Describe(m_Config)}");
    }

    void OnDestroy()
    {
        m_Gc.Dispose();
        m_ScriptUpdate.Dispose();
        m_ScriptLate.Dispose();
        m_BurstSchedule.Dispose();
        m_BurstComplete.Dispose();
        m_Render.Dispose();
        m_PresentWait.Dispose();
        m_PlayerLoop.Dispose();
        BoneBurstSystem.TimePhases = false;
    }

    void Update()
    {
        if (m_Done || m_Samples == null) return;
        m_Frame++;
        if (m_NextSwitch != null) SwitchDue();
        FrameTimingManager.CaptureFrameTimings();
        if (m_Frame <= WarmupFrames) return;

        int i = m_Frame - WarmupFrames - 1;
        if (i == 0) StartProfile();
        bool timed = FrameTimingManager.GetLatestTimings(1, m_Timing) > 0;
        m_Samples[0][i] = Time.unscaledDeltaTime * 1000.0;
        m_Samples[1][i] = timed ? m_Timing[0].cpuMainThreadFrameTime : double.NaN;
        m_Samples[2][i] = timed ? m_Timing[0].cpuRenderThreadFrameTime : double.NaN;
        m_Samples[3][i] = timed ? m_Timing[0].gpuFrameTime : double.NaN;
        m_Samples[4][i] = m_Gc.Valid ? m_Gc.LastValue : double.NaN;
        m_Samples[5][i] = Milliseconds(m_ScriptUpdate);
        m_Samples[6][i] = Milliseconds(m_ScriptLate);
        m_Samples[7][i] = Milliseconds(m_BurstSchedule);
        m_Samples[8][i] = Milliseconds(m_BurstComplete);
        // CPU meshes whose topology was re-declared last frame (works in release players, unlike the markers).
        m_Samples[9][i] = m_Config.Runtime is BenchRuntime.BurstCpu or BenchRuntime.BurstGpu
            ? BoneBurstSystem.LastFrameTopologyChanges
            : double.NaN;
        // The last completed frame's phases, the same frame the topology count describes.
        bool phases = BoneBurstSystem.TimePhases;
        BoneBurstPhaseTimes p = BoneBurstSystem.LastFramePhases;
        if (phases && !m_BurstSchedule.Valid) m_Samples[7][i] = p.Schedule;
        if (phases && !m_BurstComplete.Valid) m_Samples[8][i] = p.Complete;
        m_Samples[10][i] = phases ? p.Advance : double.NaN;
        m_Samples[11][i] = phases ? p.Headers : double.NaN;
        m_Samples[12][i] = phases ? p.JobSetup : double.NaN;
        m_Samples[13][i] = phases ? p.Wait : double.NaN;
        m_Samples[14][i] = phases ? p.Apply : double.NaN;
        m_Samples[15][i] = phases ? p.Events : double.NaN;
        m_Samples[16][i] = Milliseconds(m_Render);
        m_Samples[17][i] = Milliseconds(m_PresentWait);
        m_Samples[18][i] = Milliseconds(m_PlayerLoop);

        if (i + 1 < MeasuredFrames) return;
        m_Done = true;
        StopProfile();
        Write();
        s_Next++;
        LoadNext();
    }

    // ---- Configuration ----

    List<BenchConfig> BuildSuite()
    {
        BenchRuntime[] order = s_Runtimes ??
                               new[] { BenchRuntime.Stock, BenchRuntime.StockThreaded, BenchRuntime.BurstCpu, BenchRuntime.BurstGpu };
        List<BenchConfig> queue = new();
        for (int repeat = 0; repeat < Mathf.Max(1, SuiteRepeats); repeat++)
        {
            foreach (string animation in SuiteAnimations)
            {
                foreach (int count in SuiteCounts)
                {
                    for (int k = 0; k < order.Length; k++)
                    {
                        BenchRuntime runtime = repeat % 2 == 0 ? order[k] : order[order.Length - 1 - k];
                        queue.Add(new BenchConfig { Runtime = runtime, Count = count, Animation = animation });
                    }
                }
            }
        }

        return queue;
    }

    void ReadCommandLine()
    {
        string[] args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length; i++)
        {
            string next = i + 1 < args.Length ? args[i + 1] : null;
            switch (args[i])
            {
                case "-boneBench": RunSuite = true; break;
                case "-quit": s_QuitAfterRun = true; break;
                case "-profileTo" when next != null: s_ProfileTo = next; break;
                case "-runtime" when next != null: Runtime = Enum.Parse<BenchRuntime>(next, true); RunSuite = false; break;
                case "-count" when next != null: Count = int.Parse(next, CultureInfo.InvariantCulture); break;
                case "-anim" when next != null: Animation = next; break;
                case "-warmup" when next != null: WarmupFrames = int.Parse(next, CultureInfo.InvariantCulture); break;
                case "-frames" when next != null: MeasuredFrames = int.Parse(next, CultureInfo.InvariantCulture); break;
                case "-repeats" when next != null: SuiteRepeats = int.Parse(next, CultureInfo.InvariantCulture); break;
                case "-anims" when next != null: SuiteAnimations = next.Split(','); break;
                case "-out" when next != null: s_OutDir ??= next; break;
                case "-loadBench" when next != null: s_LoadBench = int.Parse(next, CultureInfo.InvariantCulture); break;
                case "-counts" when next != null:
                    SuiteCounts = Array.ConvertAll(next.Split(','), c => int.Parse(c, CultureInfo.InvariantCulture));
                    break;
                case "-runtimes" when next != null:
                    s_Runtimes = Array.ConvertAll(next.Split(','), r => Enum.Parse<BenchRuntime>(r, true));
                    break;
            }
        }
    }

    bool Validate()
    {
        string problem = null;
        if (BurstAsset == null || StockAsset == null || StockMaterial == null || Camera == null)
        {
            problem = "assign BurstAsset, StockAsset, StockMaterial and Camera";
        }
        else if (m_Config.Runtime == BenchRuntime.BurstGpu && !BoneBurstGpu.IsSupported)
        {
            problem = "GPU skinning is not supported on this device";
        }
        else if (m_Config.Count <= 0 || MeasuredFrames <= 0)
        {
            problem = "count and measured frames must be positive";
        }

        if (problem == null) return true;
        Debug.LogError($"[BoneBenchmark] {Describe(m_Config)} skipped: {problem}", this);
        m_Done = true;
        s_Next++;
        LoadNext();
        return false;
    }

    // ---- Scene ----

    void Spawn()
    {
        (int columns, int rows) = Grid(m_Config.Count);
        float scale = CellHeight * 0.9f / SkeletonHeight;
        Random random = new(Seed);
        bool switching = m_Config.Animation == SwitchMode;
        if (switching)
        {
            m_NextSwitch = new float[m_Config.Count];
            m_Switches = new int[m_Config.Count];
            m_Clock = 0;
        }

        for (int n = 0; n < m_Config.Count; n++)
        {
            Vector3 position = new(
                (n % columns - (columns - 1) * 0.5f) * CellWidth,
                (n / columns - (rows - 1) * 0.5f) * CellHeight - CellHeight * 0.45f, 0f);
            // Drawn in the same order with the same seed on every side.
            float startTime = (float)random.NextDouble() * 10f;
            string animation = m_Config.Animation;
            if (switching)
            {
                animation = SwitchAnimations[Pick(n, 0)];
                m_NextSwitch[n] = SwitchDelay(n, 0);
            }

            GameObject spawned = m_Config.Runtime is BenchRuntime.Stock or BenchRuntime.StockThreaded
                ? SpawnStock(startTime, m_Config.Runtime == BenchRuntime.StockThreaded, animation)
                : SpawnBurst(startTime, m_Config.Runtime == BenchRuntime.BurstGpu, animation);
            spawned.name = $"{m_Config.Runtime} {n}";
            spawned.transform.SetPositionAndRotation(position, Quaternion.identity);
            spawned.transform.localScale = new Vector3(scale, scale, 1f);
            m_Spawned.Add(spawned);
        }
    }

    GameObject SpawnStock(float startTime, bool threaded, string animationName)
    {
        SkeletonComponents<SkeletonRenderer, SkeletonAnimation> components =
            SkeletonAnimation.NewSkeletonAnimationGameObject(StockAsset, true);
        SkeletonRenderer skeletonRenderer = components.skeletonRenderer;
        SkeletonAnimation animation = components.skeletonAnimation;
        skeletonRenderer.updateWhenInvisible = UpdateMode.FullUpdate;
        skeletonRenderer.ThreadedMeshGeneration = threaded ? SettingsTriState.Enable : SettingsTriState.Disable;
        animation.ThreadedAnimation = threaded ? SettingsTriState.Enable : SettingsTriState.Disable;
        foreach (AtlasAssetBase atlas in StockAsset.atlasAssets)
        {
            foreach (Material material in atlas.Materials)
            {
                skeletonRenderer.CustomMaterialOverride[material] = StockMaterial;
            }
        }

        animation.Skeleton.SetSkin(Skin);
        animation.Skeleton.SetupPoseSlots();
        Spine.TrackEntry entry = animation.AnimationState.SetAnimation(0, animationName, true);
        entry.TrackTime = startTime;
        m_StockStates.Add(animation.AnimationState);
        return skeletonRenderer.gameObject;
    }

    GameObject SpawnBurst(float startTime, bool gpu, string animationName)
    {
        GameObject spawned = new();
        spawned.SetActive(false);
        BoneBurstSkeleton skeleton = spawned.AddComponent<BoneBurstSkeleton>();
        skeleton.Asset = BurstAsset;
        skeleton.GpuSkinning = gpu;
        skeleton.UpdateWhenInvisible = BoneBurstUpdateMode.FullUpdate;
        spawned.SetActive(true);
        skeleton.SetSkin(Skin);
        skeleton.PlayAnimation(animationName, true);
        skeleton.AnimationState.GetTrack(0).TrackTime = startTime;
        m_BurstSkeletons.Add(skeleton);
        return spawned;
    }

    // ---- Animation switching ----

    /// <summary>
    ///     Switches every skeleton whose time has come, crossfading (stock: <c>AnimationState.SetAnimation</c>;
    ///     BoneBurst: <c>PlayAnimation</c>, both with the asset's 0.2 s mix). The clock is the benchmark's own, so
    ///     both runtimes switch on the same frames.
    /// </summary>
    void SwitchDue()
    {
        m_Clock += Time.deltaTime;
        for (int n = 0; n < m_NextSwitch.Length; n++)
        {
            if (m_NextSwitch[n] > m_Clock) continue;
            int count = ++m_Switches[n];
            string animation = SwitchAnimations[Pick(n, count)];
            if (n < m_StockStates.Count) m_StockStates[n].SetAnimation(0, animation, true);
            else if (n < m_BurstSkeletons.Count) m_BurstSkeletons[n].PlayAnimation(animation, true);
            m_NextSwitch[n] = m_Clock + SwitchDelay(n, count);
        }
    }

    // Deterministic per skeleton and switch: the same sequence on every runtime, without per-skeleton state.
    static int Pick(int skeleton, int switchIndex)
    {
        return (int)(Hash((uint)skeleton, (uint)switchIndex, 17u) % (uint)SwitchAnimations.Length);
    }

    static float SwitchDelay(int skeleton, int switchIndex)
    {
        return 0.5f + Hash((uint)skeleton, (uint)switchIndex, 31u) % 1000u / 1000f;
    }

    static uint Hash(uint a, uint b, uint c)
    {
        uint h = a * 0x9E3779B1u ^ b * 0x85EBCA77u ^ c * 0xC2B2AE3Du;
        h ^= h >> 15;
        h *= 0x2C1B3C6Du;
        h ^= h >> 12;
        return h;
    }

    void FitCamera()
    {
        (int columns, int rows) = Grid(m_Config.Count);
        Camera.orthographic = true;
        Camera.transform.position = new Vector3(0f, 0f, -10f);
        float aspect = Mathf.Max(0.1f, Camera.aspect);
        Camera.orthographicSize = Mathf.Max(rows * CellHeight * 0.5f, columns * CellWidth * 0.5f / aspect) * 1.05f;
    }

    static (int columns, int rows) Grid(int count)
    {
        int columns = Mathf.Max(1, Mathf.CeilToInt(Mathf.Sqrt(count * 16f / 9f * CellHeight / CellWidth)));
        int rows = Mathf.CeilToInt(count / (float)columns);
        return (columns, rows);
    }

    void LoadNext()
    {
        foreach (GameObject spawned in m_Spawned)
        {
            Destroy(spawned);
        }

        m_Spawned.Clear();
        if (s_Next >= s_Queue.Count)
        {
            Finish();
            return;
        }

        string path = gameObject.scene.path;
#if UNITY_EDITOR
        UnityEditor.SceneManagement.EditorSceneManager.LoadSceneInPlayMode(path, new LoadSceneParameters(LoadSceneMode.Single));
#else
        SceneManager.LoadScene(path);
#endif
    }

    void Finish()
    {
        Debug.Log($"[BoneBenchmark] run {s_RunId} done: {s_Queue?.Count ?? 0} configuration(s). Summary: " +
                  Path.Combine(s_OutDir ?? "", "summary.csv"));
        s_Queue = null;
        m_Done = true;
        bool quit = (QuitWhenDone && RunSuite) || s_QuitAfterRun;
        if (quit && !Application.isEditor) Application.Quit();
    }

    // ---- Output ----

    // A Profiler binary capture of exactly the measured frames (development players), one file per configuration.
    void StartProfile()
    {
        if (string.IsNullOrEmpty(s_ProfileTo) || !Debug.isDebugBuild) return;
        string file = Path.Combine(s_ProfileTo, $"{s_RunId}_{s_Next:D2}_{m_Config.Runtime}_{m_Config.Count}_{m_Config.Animation}.raw");
        Directory.CreateDirectory(s_ProfileTo);
        UnityEngine.Profiling.Profiler.logFile = file;
        UnityEngine.Profiling.Profiler.enableBinaryLog = true;
        UnityEngine.Profiling.Profiler.enabled = true;
    }

    static void StopProfile()
    {
        if (string.IsNullOrEmpty(s_ProfileTo) || !UnityEngine.Profiling.Profiler.enabled) return;
        UnityEngine.Profiling.Profiler.enabled = false;
        UnityEngine.Profiling.Profiler.enableBinaryLog = false;
        UnityEngine.Profiling.Profiler.logFile = string.Empty;
    }

    // Marker recorders report nanoseconds. A release player records Unity's built-in markers (the player loop,
    // script runs) but not script ProfilerMarkers such as BoneBurst.*: NaN there, and the phase columns stand in.
    static double Milliseconds(ProfilerRecorder recorder)
    {
        return recorder.Valid ? recorder.LastValue / 1e6 : double.NaN;
    }

    void Write()
    {
        string name = $"{s_RunId}_{s_Next:D2}_{m_Config.Runtime}_{m_Config.Count}_{m_Config.Animation}.csv";
        StringBuilder frames = new();
        frames.AppendLine(string.Join(",", s_Columns));
        for (int i = 0; i < MeasuredFrames; i++)
        {
            for (int c = 0; c < s_Columns.Length; c++)
            {
                if (c > 0) frames.Append(',');
                frames.Append(Format(m_Samples[c][i]));
            }

            frames.AppendLine();
        }

        File.WriteAllText(Path.Combine(s_OutDir, name), frames.ToString());

        string summaryPath = Path.Combine(s_OutDir, "summary.csv");
        // A summary written with other columns would misalign every new row: set it aside and start a new one.
        if (File.Exists(summaryPath))
        {
            string first;
            using (StreamReader reader = new(summaryPath)) first = reader.ReadLine() ?? "";
            if (!first.EndsWith($",{s_Columns[^1]}_mean", StringComparison.Ordinal))
            {
                File.Move(summaryPath, Path.Combine(s_OutDir, $"summary_before_{s_RunId}.csv"));
            }
        }

        bool header = !File.Exists(summaryPath);
        StringBuilder summary = new();
        if (header)
        {
            summary.Append("run_id,index,runtime,count,animation,frames,editor,development,platform,graphics,device,cpu_cores,resolution,backend");
            foreach (string column in s_Columns)
            {
                summary.Append($",{column}_median,{column}_p95,{column}_mean");
            }

            summary.AppendLine();
        }

        summary.Append(string.Join(",", s_RunId, s_Next.ToString(CultureInfo.InvariantCulture), m_Config.Runtime,
            m_Config.Count.ToString(CultureInfo.InvariantCulture), m_Config.Animation,
            MeasuredFrames.ToString(CultureInfo.InvariantCulture), Application.isEditor ? "1" : "0",
            Debug.isDebugBuild ? "1" : "0", Application.platform, SystemInfo.graphicsDeviceType,
            Csv(SystemInfo.deviceModel), SystemInfo.processorCount.ToString(CultureInfo.InvariantCulture),
            $"{Screen.width}x{Screen.height}", Backend));
        StringBuilder log = new();
        for (int c = 0; c < s_Columns.Length; c++)
        {
            (double median, double p95, double mean) = Stats(m_Samples[c]);
            summary.Append($",{Format(median)},{Format(p95)},{Format(mean)}");
            if (!double.IsNaN(median)) log.Append($" {s_Columns[c]} {median:F3}/{p95:F3}");
        }

        summary.AppendLine();
        File.AppendAllText(summaryPath, summary.ToString());
        Debug.Log($"[BoneBenchmark] {Describe(m_Config)} median/p95:{log}{(Application.isEditor ? " (EDITOR: not representative)" : "")}");
    }

    static (double median, double p95, double mean) Stats(double[] values)
    {
        List<double> valid = new();
        foreach (double value in values)
        {
            if (!double.IsNaN(value)) valid.Add(value);
        }

        if (valid.Count == 0) return (double.NaN, double.NaN, double.NaN);
        valid.Sort();
        double sum = 0;
        foreach (double value in valid) sum += value;
        return (valid[valid.Count / 2], valid[Mathf.Min(valid.Count - 1, (int)(valid.Count * 0.95))], sum / valid.Count);
    }

    static string Format(double value)
    {
        return double.IsNaN(value) ? "" : value.ToString("G6", CultureInfo.InvariantCulture);
    }

    static string Backend =>
#if ENABLE_IL2CPP
        "IL2CPP";
#else
        "Mono";
#endif

    static string Csv(string text)
    {
        return text.Replace(',', ' ');
    }

    static string Describe(BenchConfig config)
    {
        return $"{config.Runtime} × {config.Count} '{config.Animation}'";
    }
}
