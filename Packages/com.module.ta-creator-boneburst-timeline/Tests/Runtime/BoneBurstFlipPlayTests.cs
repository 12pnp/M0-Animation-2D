using System.Collections;
using System.Collections.Generic;
using System.IO;
using BoneBurst.Data;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.TestTools;

namespace BoneBurst.Timeline.Tests
{
    /// <summary>
    ///     The flip mixer in play mode: a flip lands in the same evaluation (the mesh mirrors at once), and stop
    ///     restores the original flip the same way.
    /// </summary>
    public class BoneBurstFlipPlayTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        private BoneBurstAsset m_Asset;
        private PlayableGraph m_Graph;

        private GameObject m_Object;

        [TearDown]
        public void TearDown()
        {
            if (m_Graph.IsValid()) m_Graph.Destroy();
            if (m_Object != null) Object.Destroy(m_Object);
            if (m_Asset != null) Object.Destroy(m_Asset);
        }

        private static IEnumerator Next()
        {
            yield return null;
            yield return new WaitForEndOfFrame();
            Assert.AreEqual(BoneBurstSystem.FramesScheduled, BoneBurstSystem.FramesCompleted,
                "resumed before BoneBurstSystem.Complete; the frame's output is not applied yet");
        }

        private BoneBurstSkeleton Spawn()
        {
            string atlasText = File.ReadAllText($"{Samples}/spineboy-pro/spineboy-pro.atlas.txt");
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            SkeletonDef skeleton =
                SkeletonJsonReader.Read(File.ReadAllText($"{Samples}/spineboy-pro/spineboy-pro.json"), 0.01f);
            m_Asset.SetDataBytes(BoneBurstDataWriter.Write(skeleton, AtlasReader.Read(atlasText), 0.01f));
            int pages = AtlasReader.Read(atlasText).Pages.Count;
            Texture2D[] pageTextures = new Texture2D[pages];
            for (int i = 0; i < pages; i++) pageTextures[i] = new Texture2D(2, 2);
            m_Asset.SetPageTextures(pageTextures);
            m_Object = new GameObject("BoneBurst flip play test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        private ScriptPlayable<BoneBurstFlipMixer> BuildMixer(BoneBurstSkeleton skeleton, int inputs)
        {
            m_Graph = PlayableGraph.Create("BoneBurst flip play test");
            ScriptPlayable<BoneBurstFlipMixer> mixer = ScriptPlayable<BoneBurstFlipMixer>.Create(m_Graph, inputs);
            ScriptPlayableOutput output = ScriptPlayableOutput.Create(m_Graph, "skeleton");
            output.SetSourcePlayable(mixer);
            output.SetUserData(skeleton);
            return mixer;
        }

        [UnityTest]
        public IEnumerator FlipApplies_InTheSameEvaluation_AndStopRestoresIt()
        {
            BoneBurstSkeleton skeleton = Spawn();
            for (int i = 0; i < 2; i++) yield return Next();

            List<Vector3> before = new();
            skeleton.GetCpuVertices(before, new List<Color32>(), new List<Vector2>());

            ScriptPlayable<BoneBurstFlipMixer> mixer = BuildMixer(skeleton, 1);
            ScriptPlayable<BoneBurstFlipBehaviour> clip =
                ScriptPlayable<BoneBurstFlipBehaviour>.Create(m_Graph, new BoneBurstFlipBehaviour { flipX = true });
            mixer.ConnectInput(0, clip, 0);
            mixer.SetInputWeight(0, 1f);

            // No yield: the mesh must already mirror around the X axis.
            m_Graph.Evaluate(0);
            List<Vector3> flipped = new();
            skeleton.GetCpuVertices(flipped, new List<Color32>(), new List<Vector2>());
            Assert.AreEqual(before.Count, flipped.Count);
            float worst = 0;
            for (int i = 0; i < before.Count; i++)
                worst = Mathf.Max(worst,
                    Mathf.Abs(flipped[i].x + before[i].x),
                    Mathf.Abs(flipped[i].y - before[i].y));

            Assert.That(worst, Is.LessThanOrEqualTo(1e-5f),
                $"the flip was not posed in the same evaluation; largest difference {worst}");

            mixer.GetBehaviour().OnStop();
            Assert.IsFalse(skeleton.FlipX, "stop restores the original flip");

            List<Vector3> restored = new();
            skeleton.GetCpuVertices(restored, new List<Color32>(), new List<Vector2>());
            worst = 0;
            for (int i = 0; i < before.Count; i++)
                worst = Mathf.Max(worst,
                    Mathf.Abs(restored[i].x - before[i].x),
                    Mathf.Abs(restored[i].y - before[i].y));

            Assert.That(worst, Is.LessThanOrEqualTo(1e-5f),
                $"stop did not restore the original mesh in the same evaluation; largest difference {worst}");
        }
    }
}