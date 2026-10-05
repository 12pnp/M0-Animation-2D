using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using AssetRuntime;
using Cysharp.Threading.Tasks;
using ModuleP1;
using BoneBurst;
using BoneBurst.Anim;
using UnityEngine;
using UnityEngine.Rendering;

namespace BoneBurstLoadTest
{
    /// <summary>
    ///     Spawns skeletons through AssetSystem V2 (<c>SpawnAsync</c> of an indexed prefab) on a 45° lattice facing the
    ///     camera, step by step, until the median frame time goes over 16.67 ms (under 60 FPS)
    ///     (Assets/Docs-Plan/BoneBurst-LoadTest-Plan.md). Each skeleton sorts through its prefab's <see cref="SortingGroup" />
    ///     (Sort 3D As 2D), its order set from its distance to the camera: nearer draws on top.
    /// </summary>
    public sealed class BoneBurstLoadTest : MonoBehaviour
    {
        [Tooltip("BoneBurstSkeleton + SortingGroup (Sort 3D As 2D), indexed by SmartAddresser.")]
        [SerializeField]
        [ExpectBuiltInAsset(AssetTypeCodes.PrefabPlain)]
        IndexGenericAsset m_Prefab;

        [SerializeField] Camera m_Camera;

        [Tooltip("Shaders the page materials find by name (Shader.Find): a reference here keeps them, with their " +
                 "runtime variants, in a build of this scene alone.")]
        [SerializeField] Shader[] m_IncludeShaders = Array.Empty<Shader>();
        [Tooltip("Spawn this many and keep measuring. 0: ramp by Step until under 60 FPS.")]
        [SerializeField] int m_FixedCount = 4000;

        [Tooltip("Animations handed out in turn, each from a random start time, so the skeletons do not move in step.")]
        [SerializeField] string[] m_Animations =
            { "idle", "walk", "run", "dance", "aware", "pickaxe-action", "shovel-run", "sword-equip" };

        [SerializeField] int m_Start = 100;
        [SerializeField] int m_Step = 100;
        [SerializeField] int m_WarmupFrames = 60;
        [SerializeField] int m_MeasuredFrames = 120;
        [SerializeField] float m_TargetMs = 1000f / 60f;

        [Tooltip("Lattice spacing in world units (a skeleton is about 4.8 wide).")]
        [SerializeField] float m_Spacing = 3f;

        [Tooltip("Skeletons per row; rows go back from the camera.")]
        [SerializeField] int m_Columns = 20;

        readonly List<GameObject> m_Spawned = new();
        string m_Status = "starting";
        bool m_Quit;

        void Awake()
        {
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = -1;
            Application.runInBackground = true;
            m_Quit = Array.IndexOf(Environment.GetCommandLineArgs(), "-quit") >= 0;
        }

        void Start()
        {
            RunAsync(this.GetCancellationTokenOnDestroy()).Forget();
        }

        async UniTaskVoid RunAsync(System.Threading.CancellationToken token)
        {
            if (m_FixedCount > 0)
            {
                await RunFixedAsync(token);
                return;
            }

            StringBuilder csv = new("count,median_ms,fps\n");
            int lastGood = 0;
            double lastGoodMs = 0;
            for (int target = m_Start;; target += m_Step)
            {
                m_Status = $"spawning to {target}";
                while (m_Spawned.Count < target)
                {
                    InstanceHandle<BoneBurstSkeleton> handle = await m_Prefab.SpawnAsync<BoneBurstSkeleton>(
                        cancellationToken: token);
                    if (handle == null || !handle.IsValid)
                    {
                        m_Status = $"SpawnAsync failed at {m_Spawned.Count} (is an AssetRuntimeHost in the scene?)";
                        Debug.LogError("[LoadTest] " + m_Status);
                        return;
                    }

                    Place(handle.Component, m_Spawned.Count);
                    m_Spawned.Add(handle.GameObject);
                }

                for (int i = 0; i < m_WarmupFrames; i++) await UniTask.Yield(PlayerLoopTiming.Update, token);
                double[] frames = new double[m_MeasuredFrames];
                for (int i = 0; i < frames.Length; i++)
                {
                    await UniTask.Yield(PlayerLoopTiming.Update, token);
                    frames[i] = Time.unscaledDeltaTime * 1000.0;
                }

                Array.Sort(frames);
                double median = frames[frames.Length / 2];
                csv.AppendLine(string.Format(CultureInfo.InvariantCulture, "{0},{1:F3},{2:F1}", target, median, 1000 / median));
                Debug.Log($"[LoadTest] {target} skeletons: median {median:F2} ms ({1000 / median:F0} FPS)");
                if (median > m_TargetMs)
                {
                    m_Status = $"under 60 FPS at {target} ({median:F2} ms). Last at >= 60 FPS: {lastGood} ({lastGoodMs:F2} ms)";
                    Debug.Log("[LoadTest] DONE: " + m_Status);
                    break;
                }

                lastGood = target;
                lastGoodMs = median;
                m_Status = $"{target} skeletons: {median:F2} ms ({1000 / median:F0} FPS)";
            }

            string folder = Path.Combine(Application.persistentDataPath, "BoneBurstLoadTest");
            Directory.CreateDirectory(folder);
            string file = Path.Combine(folder, $"loadtest_{DateTime.Now:yyyyMMdd-HHmmss}.csv");
            File.WriteAllText(file, csv.ToString());
            Debug.Log("[LoadTest] written " + file);
            if (m_Quit && !Application.isEditor) Application.Quit();
        }

        // A fixed count, then a running median per window of frames: the on-screen line and a log line each window.
        async UniTask RunFixedAsync(System.Threading.CancellationToken token)
        {
            m_Status = $"spawning {m_FixedCount}";
            while (m_Spawned.Count < m_FixedCount)
            {
                InstanceHandle<BoneBurstSkeleton> handle = await m_Prefab.SpawnAsync<BoneBurstSkeleton>(
                    cancellationToken: token);
                if (handle == null || !handle.IsValid)
                {
                    m_Status = $"SpawnAsync failed at {m_Spawned.Count} (is an AssetRuntimeHost in the scene?)";
                    Debug.LogError("[LoadTest] " + m_Status);
                    return;
                }

                Place(handle.Component, m_Spawned.Count);
                Animate(handle.Component, m_Spawned.Count);
                m_Spawned.Add(handle.GameObject);
            }

            for (int i = 0; i < m_WarmupFrames; i++) await UniTask.Yield(PlayerLoopTiming.Update, token);
            double[] frames = new double[m_MeasuredFrames];
            for (int window = 1;; window++)
            {
                for (int i = 0; i < frames.Length; i++)
                {
                    await UniTask.Yield(PlayerLoopTiming.Update, token);
                    frames[i] = Time.unscaledDeltaTime * 1000.0;
                }

                Array.Sort(frames);
                double median = frames[frames.Length / 2];
                m_Status = $"{m_FixedCount} skeletons, {m_Animations.Length} animations: median {median:F2} ms " +
                           $"({1000 / median:F0} FPS), p95 {frames[frames.Length * 95 / 100]:F2} ms";
                Debug.Log($"[LoadTest] window {window}: " + m_Status);
            }
        }

        void Animate(BoneBurstSkeleton skeleton, int index)
        {
            if (m_Animations.Length == 0) return;
            skeleton.PlayAnimation(m_Animations[index % m_Animations.Length], true);
            BoneTrackEntry track = skeleton.AnimationState.GetTrack(0);
            if (track != null) track.TrackTime = UnityEngine.Random.value * 2f;
        }

        // The next free point of a grid rotated 45° about Y, nearest the camera first: rows run diagonally across the
        // view. The skeleton faces the camera and sorts by depth (nearer = higher order).
        void Place(BoneBurstSkeleton skeleton, int index)
        {
            Vector2Int cell = Cell(index);
            Quaternion diagonal = Quaternion.Euler(0, 45, 0);
            Vector3 position = diagonal * new Vector3(cell.x * m_Spacing, 0, cell.y * m_Spacing);
            Transform t = skeleton.transform;
            t.position = position;
            Vector3 toCamera = m_Camera.transform.position - position;
            toCamera.y = 0;
            if (toCamera.sqrMagnitude > 1e-6f) t.rotation = Quaternion.LookRotation(-toCamera.normalized, Vector3.up);
            SortingGroup group = skeleton.GetComponent<SortingGroup>();
            float depth = Vector3.Dot(position - m_Camera.transform.position, m_Camera.transform.forward);
            group.sortingOrder = Mathf.Clamp(Mathf.RoundToInt(-depth * 10), short.MinValue, short.MaxValue);
        }

        // Rows of m_Columns going back from the camera, centred: the field grows backward as the count rises.
        Vector2Int Cell(int index)
        {
            return new Vector2Int(index % m_Columns - m_Columns / 2, index / m_Columns);
        }

        void OnGUI()
        {
            GUI.Label(new Rect(12, 12, 900, 24), $"BoneBurst load test (AssetSystem V2): {m_Spawned.Count} skeletons. {m_Status}");
        }
    }
}
