using System.Collections;
using System.Collections.Generic;
using System.IO;
using BoneBurst.Data;
using NUnit.Framework;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.TestTools;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Plan §8 performance numbers: N skeletons animating, CPU mesh vs GPU skinning, main-thread time of the
    ///     two BoneBurst PlayerLoop entries (<see cref="BoneBurstSystem.ScheduleMarker" />,
    ///     <see cref="BoneBurstSystem.CompleteMarker" />), frame time and GC bytes. Reports what it measures; it
    ///     asserts only that it measured. Explicit: run it from the Test Runner on purpose, in a player build for
    ///     numbers worth publishing.
    /// </summary>
    [Explicit]
    [Category("Performance")]
    public class BoneBurstPerfTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        private const int Warmup = 30, Measured = 120;

        private readonly List<GameObject> m_Objects = new();
        private BoneBurstAsset m_Asset;

        [TearDown]
        public void TearDown()
        {
            foreach (GameObject o in m_Objects) Object.Destroy(o);
            m_Objects.Clear();
            if (m_Asset != null) Object.Destroy(m_Asset);
        }

        [UnityTest]
        public IEnumerator Spineboy_Walk_CpuVsGpu([Values(100, 500, 2000)] int count, [Values(false, true)] bool gpu)
        {
            if (gpu && !BoneBurstGpu.IsSupported) Assert.Ignore("GPU skinning needs shader model 4.5");
            string folder = $"{Samples}/spineboy-pro";
            string atlas = File.ReadAllText($"{folder}/spineboy-pro.atlas.txt");
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            BakedTestData.Assign(m_Asset, $"{folder}/spineboy-pro.json", atlas, BakedTestData.DefaultScale);
            int pages = AtlasReader.Read(atlas).Pages.Count;
            Texture2D[] pageTextures = new Texture2D[pages];
            for (int i = 0; i < pages; i++) pageTextures[i] = new Texture2D(2, 2);
            m_Asset.SetPageTextures(pageTextures);
            for (int i = 0; i < count; i++)
            {
                GameObject o = new($"perf {i}");
                o.SetActive(false);
                o.transform.position = new Vector3(i % 50 * 0.2f, i / 50 * 0.2f, 0);
                BoneBurstSkeleton skeleton = o.AddComponent<BoneBurstSkeleton>();
                skeleton.Asset = m_Asset;
                skeleton.GpuSkinning = gpu;
                // Culling must not skip work: measure the full update.
                skeleton.UpdateWhenInvisible = BoneBurstUpdateMode.FullUpdate;
                o.SetActive(true);
                skeleton.PlayAnimation("walk", true);
                m_Objects.Add(o);
            }

            for (int i = 0; i < Warmup; i++) yield return null;
            using ProfilerRecorder schedule = ProfilerRecorder.StartNew(ProfilerCategory.Scripts, "BoneBurst.Schedule");
            using ProfilerRecorder complete = ProfilerRecorder.StartNew(ProfilerCategory.Scripts, "BoneBurst.Complete");
            using ProfilerRecorder gc = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame");
            double scheduleNs = 0, completeNs = 0, frameSeconds = 0;
            long gcBytes = 0;
            int reused = 0, built = 0, fallback = 0, meshed = 0;
            for (int i = 0; i < Measured; i++)
            {
                yield return null;
                scheduleNs += schedule.LastValue;
                completeNs += complete.LastValue;
                gcBytes += gc.LastValue;
                frameSeconds += Time.unscaledDeltaTime;
                reused += BoneBurstSystem.LastFrameGpuReused;
                built += BoneBurstSystem.LastFrameGpuBuilt;
                fallback += BoneBurstSystem.LastFrameGpuFallback;
                meshed += BoneBurstSystem.LastFrameMeshed;
            }

            Assert.That(scheduleNs, Is.GreaterThan(0), "the Schedule marker recorded nothing");
            Debug.Log($"BoneBurst perf: {count} × spineboy-pro walk, {(gpu ? "GPU" : "CPU")}: " +
                      $"Schedule {scheduleNs / Measured / 1e6:F3} ms, Complete {completeNs / Measured / 1e6:F3} ms, " +
                      $"frame {frameSeconds / Measured * 1e3:F2} ms, GC {gcBytes / Measured} B/frame; " +
                      $"per frame: CPU meshes {meshed / (float)Measured:F0}, GPU reused {reused / (float)Measured:F0}, " +
                      $"rebuilt {built / (float)Measured:F1}, fallback {fallback / (float)Measured:F1}");
        }
    }
}