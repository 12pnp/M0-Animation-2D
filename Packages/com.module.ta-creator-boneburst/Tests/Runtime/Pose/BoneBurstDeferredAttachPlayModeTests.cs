using System.Collections;
using BoneBurst.Data;
using Cysharp.Threading.Tasks;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     A <see cref="BoneBurstSkeleton" /> enabled before its asset's data is loaded (a player, where the data comes
    ///     through the AssetSystem) attaches when the data arrives — and not at all when it was disabled meanwhile.
    ///     The arrival is driven through <see cref="BoneBurstAsset.LoadDataOverride" />: M0 has no AssetManager to
    ///     deliver it (<c>Doc/Review/BoneBurst-AssetSystemPlan.md</c> P1).
    /// </summary>
    public class BoneBurstDeferredAttachPlayModeTests
    {
        private const string Json =
            "{\"skeleton\":{\"spine\":\"4.3.00\"}," +
            "\"bones\":[{\"name\":\"root\"},{\"name\":\"x\",\"parent\":\"root\"}]," +
            "\"slots\":[{\"name\":\"x\",\"bone\":\"x\"}]," +
            "\"skins\":[{\"name\":\"default\"}]}";

        private UniTaskCompletionSource<byte[]> m_Arrival;
        private BoneBurstAsset m_Asset;
        private int m_Loads;

        private GameObject m_Object;

        [SetUp]
        public void SetUp()
        {
            m_Arrival = new UniTaskCompletionSource<byte[]>();
            m_Loads = 0;
            BoneBurstAsset.LoadDataOverride = _ =>
            {
                m_Loads++;
                return m_Arrival.Task;
            };
        }

        [TearDown]
        public void TearDown()
        {
            BoneBurstAsset.LoadDataOverride = null;
            if (m_Object != null) Object.Destroy(m_Object);
            if (m_Asset != null) Object.Destroy(m_Asset);
        }

        private static byte[] Bytes()
        {
            return BoneBurstDataWriter.Write(SkeletonJsonReader.Read(Json, 0.01f), AtlasReader.Read(string.Empty),
                0.01f);
        }

        private BoneBurstSkeleton Spawn()
        {
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            m_Asset.name = "deferred";
            m_Asset.SetPageTextures(new Texture2D[0]);
            m_Object = new GameObject("BoneBurst deferred attach test");
            m_Object.SetActive(false);
            BoneBurstSkeleton skeleton = m_Object.AddComponent<BoneBurstSkeleton>();
            skeleton.Asset = m_Asset;
            m_Object.SetActive(true);
            return skeleton;
        }

        [UnityTest]
        public IEnumerator EnabledBeforeTheData_AttachesWhenItArrives()
        {
            BoneBurstSkeleton skeleton = Spawn();
            Assert.IsNull(skeleton.Data, "no data in hand, so nothing attaches yet");
            Assert.IsFalse(m_Asset.IsReady);
            Assert.AreEqual(1, m_Loads, "the enable asked for the data");

            m_Arrival.TrySetResult(Bytes());
            yield return null;

            Assert.IsTrue(m_Asset.IsReady, "the arrival built the blob");
            Assert.IsNotNull(skeleton.Data, "and the waiting skeleton attached");
            Assert.AreEqual(1, m_Loads, "one load");
        }

        [UnityTest]
        public IEnumerator DisabledBeforeTheData_StaysDetached_ThenAttachesOnTheNextEnable()
        {
            BoneBurstSkeleton skeleton = Spawn();
            m_Object.SetActive(false);

            m_Arrival.TrySetResult(Bytes());
            yield return null;

            Assert.IsTrue(m_Asset.IsReady, "the data still builds the shared blob");
            Assert.IsNull(skeleton.Data, "a disabled skeleton does not attach");

            m_Object.SetActive(true);
            Assert.IsNotNull(skeleton.Data, "the next enable attaches at once: the blob is ready");
            Assert.AreEqual(1, m_Loads, "no second load");
        }

        [UnityTest]
        public IEnumerator TwoSkeletonsWaiting_ShareOneLoad()
        {
            BoneBurstSkeleton first = Spawn();
            GameObject second = new("BoneBurst deferred attach test 2");
            try
            {
                second.SetActive(false);
                BoneBurstSkeleton other = second.AddComponent<BoneBurstSkeleton>();
                other.Asset = m_Asset;
                second.SetActive(true);

                m_Arrival.TrySetResult(Bytes());
                yield return null;

                Assert.AreEqual(1, m_Loads, "both skeletons wait on one load");
                Assert.IsNotNull(first.Data);
                Assert.IsNotNull(other.Data);
            }
            finally
            {
                Object.Destroy(second);
            }
        }
    }
}