using System.IO;
using BoneBurst.Data;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Playables;

namespace BoneBurst.Timeline.Tests
{
    /// <summary>
    ///     The flip mixer against a live skeleton: the greatest-weight clip wins, the flip the skeleton started with
    ///     shows when the empty space around the clips is heavier than any clip, stop restores that flip and captures
    ///     afresh, and a change leaves the instance dirty for the Editor's preview driver.
    /// </summary>
    public class BoneBurstFlipMixerTests
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
            if (m_Object != null) Object.DestroyImmediate(m_Object);
            if (m_Asset != null) Object.DestroyImmediate(m_Asset);
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
            m_Object = new GameObject("BoneBurst flip mixer test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        private ScriptPlayable<BoneBurstFlipMixer> BuildMixer(BoneBurstSkeleton skeleton, int inputs)
        {
            m_Graph = PlayableGraph.Create("BoneBurst flip mixer test");
            ScriptPlayable<BoneBurstFlipMixer> mixer = ScriptPlayable<BoneBurstFlipMixer>.Create(m_Graph, inputs);
            ScriptPlayableOutput output = ScriptPlayableOutput.Create(m_Graph, "skeleton");
            output.SetSourcePlayable(mixer);
            output.SetUserData(skeleton);
            return mixer;
        }

        private ScriptPlayable<BoneBurstFlipBehaviour> AddClip(
            ScriptPlayable<BoneBurstFlipMixer> mixer, int input, BoneBurstFlipBehaviour template)
        {
            ScriptPlayable<BoneBurstFlipBehaviour> clip =
                ScriptPlayable<BoneBurstFlipBehaviour>.Create(m_Graph, template);
            mixer.ConnectInput(input, clip, 0);
            mixer.SetInputWeight(input, 0f);
            return clip;
        }

        /// <summary>
        ///     What <c>BoneBurstEditModePreview.Tick</c> does: one zero-delta frame when work is pending.
        /// </summary>
        private static void DriverTick()
        {
            if (!BoneBurstSystem.HasPendingWork) return;
            BoneBurstSystem.Schedule(0);
            BoneBurstSystem.Complete();
        }

        [Test]
        public void GreatestWeightClipWins_OriginalCapturedOnTheFirstFrame()
        {
            BoneBurstSkeleton skeleton = Spawn();
            skeleton.FlipX = true;
            ScriptPlayable<BoneBurstFlipMixer> mixer = BuildMixer(skeleton, 2);
            AddClip(mixer, 0, new BoneBurstFlipBehaviour { flipX = false, flipY = false });
            AddClip(mixer, 1, new BoneBurstFlipBehaviour { flipX = true, flipY = true });

            mixer.SetInputWeight(0, 0.6f);
            mixer.SetInputWeight(1, 0.4f);
            m_Graph.Evaluate(0);
            Assert.IsFalse(skeleton.FlipX, "the heavier clip (no flip) wins over the skeleton's own flipX");
            Assert.IsFalse(skeleton.FlipY);

            mixer.SetInputWeight(0, 0.4f);
            mixer.SetInputWeight(1, 0.6f);
            m_Graph.Evaluate(0);
            Assert.IsTrue(skeleton.FlipX, "the now-heavier flip clip wins");
            Assert.IsTrue(skeleton.FlipY);
        }

        [Test]
        public void EmptySpaceHeavierThanAnyClip_RestoresTheOriginalFlip()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstFlipMixer> mixer = BuildMixer(skeleton, 2);
            AddClip(mixer, 0, new BoneBurstFlipBehaviour { flipY = true });
            AddClip(mixer, 1, new BoneBurstFlipBehaviour { flipY = true });

            mixer.SetInputWeight(0, 0.3f);
            mixer.SetInputWeight(1, 0.3f);
            m_Graph.Evaluate(0);
            Assert.IsFalse(skeleton.FlipY,
                "two partial clips leave more empty space than either weighs, so the original flip shows");

            mixer.SetInputWeight(1, 0.7f);
            m_Graph.Evaluate(0);
            Assert.IsTrue(skeleton.FlipY, "a clip the empty space cannot outweigh applies its flip");
        }

        [Test]
        public void Stop_RestoresTheOriginalFlip_AndCapturesFreshNextTime()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstFlipMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstFlipBehaviour { flipX = true });

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            Assert.IsTrue(skeleton.FlipX);

            mixer.GetBehaviour().OnStop();
            Assert.IsFalse(skeleton.FlipX, "stop restores the flip the skeleton started with");

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            Assert.IsTrue(skeleton.FlipX, "the next evaluation captures afresh and applies the clip again");
        }

        [Test]
        public void FlipChange_LeavesWorkPending_AndTheDriverTickMeshes()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstFlipMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstFlipBehaviour { flipX = true });

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            Assert.IsTrue(skeleton.FlipX);
            Assert.IsTrue(BoneBurstSystem.HasPendingWork, "the flip change must leave the instance dirty");

            DriverTick();
            Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "the driver tick re-meshed the flipped skeleton");
        }
    }
}