using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using NUnit.Framework;
using Unity.Collections;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using BlendMode = BoneBurst.Data.BlendMode;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;
using Random = System.Random;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Old vs new shader keywords (2026-09-29). Old: <c>_TINT_BLACK_ON</c> and <c>_STRAIGHT_ALPHA_INPUT</c> as
    ///     <c>shader_feature_local</c>, kept as a fixture in <c>LegacyShaders/</c>. New: <c>_TINT_BLACK_ON</c> as
    ///     <c>multi_compile_local</c>, straight alpha as a branch on <c>_StraightAlphaInput</c>.
    /// </summary>
    /// <remarks>
    ///     Fair conditions: both sides draw the same mesh, textures, render target, globals and material values,
    ///     configured by the same <see cref="BoneBurstMaterials.Configure" /> call (the old side adds the keyword the
    ///     old <c>Configure</c> set). Pixel checks blend One/Zero so the target holds the raw fragment output.
    ///     Timings keep Configure's Normal blend: One/Zero reads as opaque to a tile GPU, whose hidden-surface
    ///     removal then skips the covered layers and the test times nothing. They alternate old/new in ABBA order
    ///     after a warm-up, with async shader compilation off, and are inconclusive unless doubling the draws
    ///     at least 1.6× the time (proof the samples are GPU-bound).
    ///     "Old as shipped" is the old material with its <c>shader_feature</c> keywords off: the only variant a
    ///     player build keeps when no material asset uses them.
    /// </remarks>
    public class KeywordVariantComparisonTests
    {
        private const string ShaderDir = "Packages/com.module.ta-creator-boneburst/Shaders";
        private const int Size = 256;

        // Half-precision fragment math: a reordered expression may move the last bit.
        private const float SameTolerance = 2e-3f;

        // A missing keyword changes colour by far more than this.
        private const float DifferentThreshold = 0.02f;

        private static readonly string[] s_ShapeLightKeywords =
            { "USE_SHAPE_LIGHT_TYPE_0", "USE_SHAPE_LIGHT_TYPE_1", "USE_SHAPE_LIGHT_TYPE_2", "USE_SHAPE_LIGHT_TYPE_3" };

        private readonly List<Object> m_Owned = new();
        private bool m_AsyncCompilation;
        private bool[] m_GlobalShapeLight;
        private Mesh m_Grid;
        private Texture2D m_LightTexture;
        private Texture2D m_PremultipliedTexture;
        private Texture2D m_StraightTexture;
        private RenderTexture m_Target;

        [SetUp]
        public void SetUp()
        {
            m_AsyncCompilation = ShaderUtil.allowAsyncCompilation;
            ShaderUtil.allowAsyncCompilation = false;
            m_GlobalShapeLight = new bool[s_ShapeLightKeywords.Length];
            for (int i = 0; i < s_ShapeLightKeywords.Length; i++)
                m_GlobalShapeLight[i] = Shader.IsKeywordEnabled(s_ShapeLightKeywords[i]);

            m_Target = Own(new RenderTexture(Size, Size, 0, RenderTextureFormat.ARGBFloat,
                RenderTextureReadWrite.Linear));
            m_Target.Create();
            (m_StraightTexture, m_PremultipliedTexture) = BuildAtlasPages(64);
            m_LightTexture = BuildLightTexture();
            m_Grid = BuildMesh(8, 1, new Random(1234));
        }

        [TearDown]
        public void TearDown()
        {
            ShaderUtil.allowAsyncCompilation = m_AsyncCompilation;
            for (int i = 0; i < s_ShapeLightKeywords.Length; i++)
                if (m_GlobalShapeLight[i]) Shader.EnableKeyword(s_ShapeLightKeywords[i]);
                else Shader.DisableKeyword(s_ShapeLightKeywords[i]);

            if (m_Target != null) m_Target.Release();
            foreach (Object owned in m_Owned) Object.DestroyImmediate(owned);

            m_Owned.Clear();
        }

        // ---- 1. Build guard: every keyword Configure sets on a runtime material survives stripping ----

        [TestCase("BoneBurst-Unlit.shader")]
        [TestCase("BoneBurst-Lit2D.shader")]
        public void RuntimeKeywords_AreMultiCompile(string file)
        {
            string source = File.ReadAllText(Path.Combine(ShaderDir, file));
            string[] runtimeKeywords =
                { BoneBurstMaterials.GpuKeyword, BoneBurstMaterials.FetchKeyword, "_TINT_BLACK_ON" };
            foreach (string keyword in runtimeKeywords)
            {
                Assert.IsFalse(Regex.IsMatch(source, $@"#pragma\s+shader_feature\w*\s[^\n]*\b{keyword}\b"),
                    $"{file}: {keyword} is shader_feature; runtime materials would lose it in a player build");
                Assert.IsTrue(Regex.IsMatch(source, $@"#pragma\s+multi_compile\w*\s[^\n]*\b{keyword}\b"),
                    $"{file}: {keyword} not declared multi_compile");
            }

            Assert.IsFalse(source.Contains("_STRAIGHT_ALPHA_INPUT"), $"{file}: straight alpha is a branch now");
        }

        // ---- 2. Pixels: new == old in the Editor; old as shipped differs whenever a keyword matters ----

        [TestCase("Unlit", "BoneBurstUnlit", false, false, false)]
        [TestCase("Unlit", "BoneBurstUnlit", false, true, false)]
        [TestCase("Unlit", "BoneBurstUnlit", true, false, false)]
        [TestCase("Unlit", "BoneBurstUnlit", true, true, false)]
        [TestCase("Unlit", "BoneBurstUnlitForward", true, true, false)]
        [TestCase("Lit2D", "BoneBurstLit2D", false, false, false)]
        [TestCase("Lit2D", "BoneBurstLit2D", false, true, false)]
        [TestCase("Lit2D", "BoneBurstLit2D", true, false, false)]
        [TestCase("Lit2D", "BoneBurstLit2D", true, true, false)]
        [TestCase("Lit2D", "BoneBurstLit2D", false, true, true)]
        [TestCase("Lit2D", "BoneBurstLit2D", true, true, true)]
        [TestCase("Lit2D", "BoneBurstNormals", true, true, false)]
        [TestCase("Lit2D", "BoneBurstUnlitForward", true, true, false)]
        public void Pixels_NewMatchesOld(string shader, string pass, bool tintBlack, bool straight, bool shapeLight)
        {
            Color[] newPixels = Render(CreateMaterial(shader, Side.New, tintBlack, straight), pass, m_Grid, shapeLight);
            Color[] oldPixels = Render(CreateMaterial(shader, Side.OldEditor, tintBlack, straight), pass, m_Grid,
                shapeLight);
            Color[] shippedPixels =
                Render(CreateMaterial(shader, Side.OldAsShipped, tintBlack, straight), pass, m_Grid, shapeLight);

            (float newVsOld, int covered) = MaxDifference(newPixels, oldPixels);
            (float newVsShipped, int _) = MaxDifference(newPixels, shippedPixels);
            Debug.Log($"[KeywordVariant] {shader}/{pass} tint={tintBlack} straight={straight} light={shapeLight}: " +
                      $"covered {covered} px, max |new - old| {newVsOld:G3}, max |new - old as shipped| {newVsShipped:G3}");

            Assert.Greater(covered, Size * Size / 4, "nothing drawn: a zero-coverage pass proves nothing");
            Assert.LessOrEqual(newVsOld, SameTolerance, "new shader output differs from the old keyword variant");

            // The normals pass reads only coverage, which neither keyword changes.
            bool keywordMatters = pass != "BoneBurstNormals" && (tintBlack || straight);
            if (keywordMatters)
                Assert.Greater(newVsShipped, DifferentThreshold,
                    "old as shipped should differ: the stripped variant ignores tint black / straight alpha");
        }

        // ---- 3. Cost: the branch vs the keyword variant, same workload ----

        [TestCase("Unlit", "BoneBurstUnlit", false, false, false)]
        [TestCase("Unlit", "BoneBurstUnlit", false, true, false)]
        [TestCase("Unlit", "BoneBurstUnlit", true, true, false)]
        [TestCase("Lit2D", "BoneBurstLit2D", false, false, true)]
        [TestCase("Lit2D", "BoneBurstLit2D", false, true, true)]
        [TestCase("Lit2D", "BoneBurstLit2D", true, true, true)]
        public void Timing_NewWithinBudgetOfOld(string shader, string pass, bool tintBlack, bool straight,
            bool shapeLight)
        {
            const int TargetSize = 2048;
            const int Layers = 24;
            const int DrawsPerSample = 8;
            const int Rounds = 12;

            RenderTexture target =
                Own(new RenderTexture(TargetSize, TargetSize, 0, RenderTextureFormat.ARGBHalf,
                    RenderTextureReadWrite.Linear));
            target.Create();
            try
            {
                Mesh stack = BuildMesh(1, Layers, new Random(99));
                Material newMaterial = CreateMaterial(shader, Side.New, tintBlack, straight, false);
                Material oldMaterial = CreateMaterial(shader, Side.OldEditor, tintBlack, straight, false);
                CommandBuffer newBuffer =
                    BuildTimingBuffer(newMaterial, pass, stack, target, shapeLight, DrawsPerSample);
                CommandBuffer oldBuffer =
                    BuildTimingBuffer(oldMaterial, pass, stack, target, shapeLight, DrawsPerSample);

                CommandBuffer doubleBuffer = BuildTimingBuffer(newMaterial, pass, stack, target, shapeLight,
                    2 * DrawsPerSample);
                for (int i = 0; i < 3; i++)
                {
                    TimeSample(newBuffer, target);
                    TimeSample(oldBuffer, target);
                    TimeSample(doubleBuffer, target);
                }

                List<double> singleTimes = new();
                List<double> doubleTimes = new();
                for (int i = 0; i < 5; i++)
                {
                    singleTimes.Add(TimeSample(newBuffer, target));
                    doubleTimes.Add(TimeSample(doubleBuffer, target));
                }

                doubleBuffer.Release();
                double scaling = Median(doubleTimes) / Median(singleTimes);

                List<double> newTimes = new();
                List<double> oldTimes = new();
                for (int round = 0; round < Rounds; round++)
                {
                    // ABBA: whichever side runs first alternates, so drift and thermal state cancel.
                    bool newFirst = round % 2 == 0;
                    (newFirst ? newTimes : oldTimes).Add(TimeSample(newFirst ? newBuffer : oldBuffer, target));
                    (newFirst ? oldTimes : newTimes).Add(TimeSample(newFirst ? oldBuffer : newBuffer, target));
                }

                newBuffer.Release();
                oldBuffer.Release();
                double newMedian = Median(newTimes);
                double oldMedian = Median(oldTimes);
                double ratio = newMedian / oldMedian;
                long fragments = (long)TargetSize * TargetSize * Layers * DrawsPerSample;
                Debug.Log($"[KeywordVariant] timing {shader}/{pass} tint={tintBlack} straight={straight} " +
                          $"light={shapeLight} on {SystemInfo.graphicsDeviceType} ({fragments / 1e6:F0} M fragments/sample): " +
                          $"old {oldMedian:F2} ms, new {newMedian:F2} ms, new/old {ratio:F3} " +
                          $"(old {Spread(oldTimes)}, new {Spread(newTimes)}); 2x draws took {scaling:F2}x");

                if (scaling < 1.6)
                    Assert.Inconclusive($"timing is not GPU-bound (2x draws took {scaling:F2}x the time)");

                // Loose on purpose: wall-clock on a shared Editor GPU. A real regression is a multiple, not 25%.
                Assert.Less(ratio, 1.25, "the uniform branch costs noticeably more than the keyword variant");
            }
            finally
            {
                target.Release();
            }
        }

        // ---- Materials ----

        private Material CreateMaterial(string shader, Side side, bool tintBlack, bool straight, bool rawOutput = true)
        {
            string name = side == Side.New ? $"BoneBurst/{shader}" : $"Hidden/BoneBurstTests/Legacy{shader}";
            Shader found = Shader.Find(name);
            Assert.IsNotNull(found, $"shader {name} not found");
            Assert.IsTrue(found.isSupported, $"shader {name} does not compile on {SystemInfo.graphicsDeviceType}");
            Material material = Own(new Material(found));
            material.mainTexture = straight ? m_StraightTexture : m_PremultipliedTexture;
            BoneBurstMaterials.Configure(material, BlendMode.Normal, !straight, tintBlack);
            if (side == Side.OldEditor && straight)
                // What the old Configure also did.
                material.EnableKeyword("_STRAIGHT_ALPHA_INPUT");

            if (side == Side.OldAsShipped)
            {
                // A player build keeps only the shader_feature-off variant when no material asset enables them.
                material.DisableKeyword("_STRAIGHT_ALPHA_INPUT");
                material.DisableKeyword("_TINT_BLACK_ON");
            }

            material.SetColor("_Color", new Color(0.9f, 0.75f, 1f, 0.85f));
            material.SetColor("_Black", new Color(0.15f, 0.05f, 0.2f, 0f));
            if (rawOutput)
            {
                material.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.One);
                material.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.Zero);
            }

            material.SetFloat("_Cull", (float)CullMode.Off);
            return material;
        }

        // ---- Drawing ----

        private void SetGlobals(CommandBuffer buffer, bool shapeLight)
        {
            buffer.SetViewProjectionMatrices(Matrix4x4.identity, Matrix4x4.identity);
            foreach (string keyword in s_ShapeLightKeywords) buffer.DisableShaderKeyword(keyword);

            if (!shapeLight) return;
            buffer.EnableShaderKeyword(s_ShapeLightKeywords[0]);
            buffer.SetGlobalTexture("_ShapeLightTexture0", m_LightTexture);
            buffer.SetGlobalVector("_ShapeLightBlendFactors0", new Vector4(1f, 0.2f, 0f, 0f));
            buffer.SetGlobalVector("_ShapeLightMaskFilter0", Vector4.zero);
            buffer.SetGlobalVector("_ShapeLightInvertedFilter0", Vector4.zero);
            buffer.SetGlobalFloat("_HDREmulationScale", 1f);
        }

        private Color[] Render(Material material, string passName, Mesh mesh, bool shapeLight)
        {
            int pass = material.FindPass(passName);
            Assert.GreaterOrEqual(pass, 0, $"{material.shader.name} has no pass {passName}");
            using CommandBuffer buffer = new() { name = "BoneBurst keyword comparison" };
            buffer.SetRenderTarget(m_Target);
            buffer.ClearRenderTarget(false, true, Color.clear);
            SetGlobals(buffer, shapeLight);
            buffer.DrawMesh(mesh, Matrix4x4.identity, material, 0, pass);
            Graphics.ExecuteCommandBuffer(buffer);
            AsyncGPUReadbackRequest request = AsyncGPUReadback.Request(m_Target);
            request.WaitForCompletion();
            Assert.IsFalse(request.hasError, "readback failed");
            NativeArray<Color> data = request.GetData<Color>();
            return data.ToArray();
        }

        private CommandBuffer BuildTimingBuffer(Material material, string passName, Mesh mesh, RenderTexture target,
            bool shapeLight, int draws)
        {
            int pass = material.FindPass(passName);
            Assert.GreaterOrEqual(pass, 0, $"{material.shader.name} has no pass {passName}");
            CommandBuffer buffer = new() { name = "BoneBurst keyword timing" };
            buffer.SetRenderTarget(target);
            buffer.ClearRenderTarget(false, true, Color.clear);
            SetGlobals(buffer, shapeLight);
            for (int i = 0; i < draws; i++) buffer.DrawMesh(mesh, Matrix4x4.identity, material, 0, pass);

            return buffer;
        }

        private static double TimeSample(CommandBuffer buffer, RenderTexture target)
        {
            Stopwatch watch = Stopwatch.StartNew();
            Graphics.ExecuteCommandBuffer(buffer);
            // A one-pixel readback waits for the GPU to finish the draws.
            AsyncGPUReadbackRequest request = AsyncGPUReadback.Request(target, 0, 0, 1, 0, 1, 0, 1);
            request.WaitForCompletion();
            watch.Stop();
            return watch.Elapsed.TotalMilliseconds;
        }

        // ---- Fixtures ----

        /// <summary>
        ///     <paramref name="cells" />² quads tiling clip space, each <paramref name="layers" /> deep. Per quad: a
        ///     premultiplied vertex colour (every 5th with alpha 0, an additive slot), a premultiplied dark colour in
        ///     uv2/uv3, and UVs over the whole atlas page.
        /// </summary>
        private Mesh BuildMesh(int cells, int layers, Random random)
        {
            List<Vector3> positions = new();
            List<Color32> colors = new();
            List<Vector2> uv = new();
            List<Vector2> uv2 = new();
            List<Vector2> uv3 = new();
            List<int> indices = new();
            float step = 2f / cells;
            int quad = 0;
            for (int layer = 0; layer < layers; layer++)
            for (int y = 0; y < cells; y++)
            for (int x = 0; x < cells; x++, quad++)
            {
                float x0 = -1f + x * step;
                float y0 = -1f + y * step;
                float alpha = quad % 5 == 4 ? 0f : 0.25f + 0.75f * (float)random.NextDouble();
                Color32 color = new((byte)(255 * alpha * random.NextDouble()),
                    (byte)(255 * alpha * random.NextDouble()), (byte)(255 * alpha * random.NextDouble()),
                    (byte)(255 * alpha));
                float darkAlpha = alpha == 0f ? 1f : alpha;
                Vector2 dark01 = new((float)random.NextDouble() * 0.5f * darkAlpha,
                    (float)random.NextDouble() * 0.5f * darkAlpha);
                Vector2 dark2 = new((float)random.NextDouble() * 0.5f * darkAlpha, 0f);
                int first = positions.Count;
                positions.Add(new Vector3(x0, y0, 0.5f));
                positions.Add(new Vector3(x0 + step, y0, 0.5f));
                positions.Add(new Vector3(x0 + step, y0 + step, 0.5f));
                positions.Add(new Vector3(x0, y0 + step, 0.5f));
                uv.Add(new Vector2(0f, 0f));
                uv.Add(new Vector2(1f, 0f));
                uv.Add(new Vector2(1f, 1f));
                uv.Add(new Vector2(0f, 1f));
                for (int v = 0; v < 4; v++)
                {
                    colors.Add(color);
                    uv2.Add(dark01);
                    uv3.Add(dark2);
                }

                indices.Add(first);
                indices.Add(first + 1);
                indices.Add(first + 2);
                indices.Add(first);
                indices.Add(first + 2);
                indices.Add(first + 3);
            }

            Mesh mesh = Own(new Mesh { name = "BoneBurst keyword comparison", indexFormat = IndexFormat.UInt32 });
            mesh.SetVertices(positions);
            mesh.SetColors(colors);
            mesh.SetUVs(0, uv);
            mesh.SetUVs(1, uv2);
            mesh.SetUVs(2, uv3);
            mesh.SetTriangles(indices, 0);
            mesh.bounds = new Bounds(Vector3.zero, new Vector3(4f, 4f, 4f));
            return mesh;
        }

        /// <summary>
        ///     The same page twice: straight alpha, and premultiplied from it (as a PMA export would store it).
        ///     Alpha steps through 0…1 so both the un-premultiply and the premultiply paths see every case.
        /// </summary>
        private (Texture2D straight, Texture2D premultiplied) BuildAtlasPages(int size)
        {
            Random random = new(42);
            Color32[] straight = new Color32[size * size];
            Color32[] premultiplied = new Color32[size * size];
            for (int i = 0; i < straight.Length; i++)
            {
                int x = i % size;
                int y = i / size;
                byte a = (byte)((x + 3 * y) % 9 * 255 / 8);
                byte r = (byte)random.Next(256);
                byte g = (byte)random.Next(256);
                byte b = (byte)random.Next(256);
                straight[i] = new Color32(r, g, b, a);
                premultiplied[i] = new Color32((byte)(r * a / 255), (byte)(g * a / 255), (byte)(b * a / 255), a);
            }

            return (MakeTexture(size, straight, "straight"), MakeTexture(size, premultiplied, "premultiplied"));
        }

        private Texture2D BuildLightTexture()
        {
            const int LightSize = 16;
            Color32[] pixels = new Color32[LightSize * LightSize];
            for (int i = 0; i < pixels.Length; i++)
            {
                int x = i % LightSize;
                int y = i / LightSize;
                pixels[i] = new Color32((byte)(64 + x * 12), (byte)(64 + y * 12), 160, 255);
            }

            Texture2D texture = MakeTexture(LightSize, pixels, "light");
            texture.filterMode = FilterMode.Bilinear;
            return texture;
        }

        private Texture2D MakeTexture(int size, Color32[] pixels, string name)
        {
            Texture2D texture = Own(new Texture2D(size, size, TextureFormat.RGBA32, false, true)
            {
                name = $"BoneBurst keyword comparison {name}", filterMode = FilterMode.Point,
                wrapMode = TextureWrapMode.Clamp
            });
            texture.SetPixels32(pixels);
            texture.Apply(false, false);
            return texture;
        }

        private T Own<T>(T owned) where T : Object
        {
            owned.hideFlags = HideFlags.HideAndDontSave;
            m_Owned.Add(owned);
            return owned;
        }

        // ---- Statistics ----

        private static (float max, int covered) MaxDifference(Color[] a, Color[] b)
        {
            Assert.AreEqual(a.Length, b.Length);
            float max = 0f;
            int covered = 0;
            for (int i = 0; i < a.Length; i++)
            {
                Color d = a[i] - b[i];
                max = Mathf.Max(max,
                    Mathf.Max(Mathf.Max(Mathf.Abs(d.r), Mathf.Abs(d.g)), Mathf.Max(Mathf.Abs(d.b), Mathf.Abs(d.a))));
                if (a[i] != Color.clear || b[i] != Color.clear) covered++;
            }

            return (max, covered);
        }

        private static double Median(List<double> values)
        {
            List<double> sorted = new(values);
            sorted.Sort();
            int mid = sorted.Count / 2;
            return sorted.Count % 2 == 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
        }

        private static string Spread(List<double> values)
        {
            List<double> sorted = new(values);
            sorted.Sort();
            return $"min {sorted[0]:F2}, max {sorted[sorted.Count - 1]:F2}";
        }

        private enum Side
        {
            New,
            OldEditor,
            OldAsShipped
        }
    }
}