using System.IO;
using BoneBurst.Data;
using NUnit.Framework;
using UnityEngine;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     The rim light settings on <see cref="BoneBurstAsset" /> (Doc/Review/BoneBurst-RimLight-Plan.md R2,
    ///     Doc/Review/BoneBurst-TextureSplit-Plan.md §5): off by default (strength 0, the shader skips it), carried into
    ///     every page material, updated live, and each page's rim mask white when it has none.
    /// </summary>
    public class BoneBurstRimTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        private BoneBurstAsset m_Asset;
        private Texture2D m_Mask, m_Page;

        [SetUp]
        public void SetUp()
        {
            string atlasText = File.ReadAllText($"{Samples}/spineboy-pro/spineboy-pro.atlas.txt");
            SkeletonDef skeleton =
                SkeletonJsonReader.Read(File.ReadAllText($"{Samples}/spineboy-pro/spineboy-pro.json"), 0.01f);
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            m_Asset.name = "rim";
            m_Asset.SetDataBytes(BoneBurstDataWriter.Write(skeleton, AtlasReader.Read(atlasText), 0.01f));
            m_Asset.SetShader(Shader.Find("BoneBurst/Lit2D"));
            m_Mask = new Texture2D(2, 2);
            m_Page = new Texture2D(2, 2);
            m_Asset.SetPageTextures(new[] { m_Page });
        }

        [TearDown]
        public void TearDown()
        {
            if (m_Asset != null) Object.DestroyImmediate(m_Asset);
            Object.DestroyImmediate(m_Mask);
            Object.DestroyImmediate(m_Page);
        }

        [Test]
        public void Rim_IsOffByDefault_WithAWhiteMask()
        {
            Material material = m_Asset.MaterialFor(0, BlendMode.Normal);
            Assert.That(material, Is.Not.Null);
            Assert.AreEqual(0f, material.GetFloat("_RimStrength"), "a new asset has no rim");
            Assert.AreEqual(Texture2D.whiteTexture, material.GetTexture("_RimMaskTex"), "no mask: every edge");
        }

        [Test]
        public void SetRim_ReachesBuiltAndNewMaterials()
        {
            Material before = m_Asset.MaterialFor(0, BlendMode.Normal);
            m_Asset.SetRim(new Color(1, 0.5f, 0.25f, 1), 2, 3, new Vector2(1, 0));
            m_Asset.SetRimMaskTextures(new[] { m_Mask });
            Material after = m_Asset.MaterialFor(0, BlendMode.Additive);
            foreach (Material material in new[] { before, after })
            {
                Assert.AreEqual(2f, material.GetFloat("_RimStrength"), material.name);
                Assert.AreEqual(3f, material.GetFloat("_RimWidth"), material.name);
                Assert.AreEqual(new Vector4(1, 0, 0, 0), material.GetVector("_RimDirection"), material.name);
                Assert.AreEqual(new Color(1, 0.5f, 0.25f, 1), material.GetColor("_RimColor"), material.name);
                Assert.AreEqual(m_Mask, material.GetTexture("_RimMaskTex"), material.name);
            }
        }
    }
}