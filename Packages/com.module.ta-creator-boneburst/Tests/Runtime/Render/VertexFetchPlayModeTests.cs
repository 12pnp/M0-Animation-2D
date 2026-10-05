using System.Collections;
using System.IO;
using BoneBurst.Data;
using NUnit.Framework;
using Unity.Collections;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     CPU skinning, GPU vertex fetch (<see cref="BoneBurstFetch" />): the same pose drawn through the shared
    ///     vertex buffer (<c>BONE_BURST_FETCH</c>) and through the per-mesh upload gives the same pixels, for both
    ///     shaders, with and without tint black. Covers the shader side the vertex-parity tests cannot: colour
    ///     unpacking, UVs, the tint buffer and the per-renderer base.
    /// </summary>
    public class VertexFetchPlayModeTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        private const string Synthetic = "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/synthetic";

        // Half-precision colour maths: the two paths may round the last bit differently.
        private const float Tolerance = 2e-3f;
        private BoneBurstAsset m_Asset;
        private bool m_FetchWas;

        private GameObject m_Object, m_Camera;
        private Texture2D m_Page;
        private RenderTexture m_Target;

        [SetUp]
        public void SetUp()
        {
            if (!BoneBurstGpu.IsSupported) Assert.Ignore("vertex fetch needs structured buffers in vertex shaders");
            m_FetchWas = BoneBurstFetch.Enabled;
        }

        [TearDown]
        public void TearDown()
        {
            BoneBurstFetch.Enabled = m_FetchWas;
            if (m_Object != null) Object.Destroy(m_Object);
            if (m_Camera != null) Object.Destroy(m_Camera);
            if (m_Asset != null) Object.Destroy(m_Asset);
            if (m_Page != null) Object.Destroy(m_Page);
            if (m_Target != null) m_Target.Release();
        }

        [UnityTest]
        public IEnumerator Fetch_DrawsLikeUpload(
            [Values("spineboy", "synthetic")] string skeletonName,
            [Values("BoneBurst/Unlit", "BoneBurst/Lit2D")]
            string shaderName,
            [Values(false, true)] bool tintBlack)
        {
            BoneBurstSkeleton skeleton = skeletonName == "spineboy"
                ? Spawn($"{Samples}/spineboy-pro/spineboy-pro.json", $"{Samples}/spineboy-pro/spineboy-pro.atlas.txt",
                    $"{Samples}/spineboy-pro/spineboy-pro.png", 0.01f, shaderName, tintBlack)
                : Spawn($"{Synthetic}/gpu.json", $"{Synthetic}/synthetic.atlas.txt", null, 0.01f, shaderName,
                    tintBlack);

            BoneBurstFetch.Enabled = true;
            yield return BoneBurstFrames.Next();
            skeleton.SetupPose();
            yield return BoneBurstFrames.Next();
            Assert.IsTrue(skeleton.LastMeshFetched, "the second frame should take vertex fetch");
            yield return WarmShaders(skeleton);
            Assert.IsTrue(skeleton.LastMeshFetched, "still on vertex fetch after the warm-up");
            Color[] fetched = Render(skeleton);

            BoneBurstFetch.Enabled = false;
            skeleton.SetupPose();
            yield return BoneBurstFrames.Next();
            Assert.IsFalse(skeleton.LastMeshFetched, "fetch off: the per-mesh upload");
            yield return WarmShaders(skeleton);
            Color[] uploaded = Render(skeleton);

            float worst = 0;
            int covered = 0, differing = 0;
            for (int i = 0; i < fetched.Length; i++)
            {
                Color d = fetched[i] - uploaded[i];
                float diff = Mathf.Max(Mathf.Max(Mathf.Abs(d.r), Mathf.Abs(d.g)),
                    Mathf.Max(Mathf.Abs(d.b), Mathf.Abs(d.a)));
                worst = Mathf.Max(worst, diff);
                if (diff > Tolerance) differing++;
                if (uploaded[i].a > 0 || uploaded[i].r > 0) covered++;
            }

            Debug.Log($"[VertexFetch] {skeletonName} {shaderName} tint={tintBlack}: covered {covered} px, " +
                      $"{differing} differ, max |fetch - upload| {worst:G3}");
            if (worst > Tolerance)
            {
                // Both images beside the test log, to see what differs.
                string stem = Path.Combine(Application.temporaryCachePath,
                    $"vertexfetch_{skeletonName}_{shaderName.Replace('/', '_')}_{tintBlack}");
                Save(fetched, stem + "_fetch.png");
                Save(uploaded, stem + "_upload.png");
                Debug.Log($"[VertexFetch] images: {stem}_fetch.png / _upload.png");
            }

            Assert.Greater(covered, 500, "nothing drawn: a blank comparison proves nothing");
            Assert.LessOrEqual(worst, Tolerance, "vertex fetch draws differently from the per-mesh upload");
        }

        /// <summary>
        ///     A still skeleton beside an animating one: the animating one rotates the upload ring every frame, and
        ///     the still one's vertices must reach every ring buffer (each is <see cref="BoneBurstFetch.RingSize" />
        ///     frames old when it comes round). Drawn after several rotations, it matches the per-mesh upload.
        /// </summary>
        [UnityTest]
        public IEnumerator StillSkeleton_SurvivesRingRotation()
        {
            BoneBurstSkeleton still = Spawn($"{Samples}/spineboy-pro/spineboy-pro.json",
                $"{Samples}/spineboy-pro/spineboy-pro.atlas.txt", $"{Samples}/spineboy-pro/spineboy-pro.png", 0.01f,
                "BoneBurst/Unlit", false);
            GameObject moving = new("BoneBurst ring neighbour");
            moving.SetActive(false);
            moving.transform.position = new Vector3(500, 0, 0); // out of the camera; FullUpdate still meshes it
            BoneBurstSkeleton animated = moving.AddComponent<BoneBurstSkeleton>();
            animated.Asset = m_Asset;
            moving.SetActive(true);
            animated.PlayAnimation("walk", true);
            try
            {
                BoneBurstFetch.Enabled = true;
                // Walk first, so each ring buffer holds a different pose of it; the pose it stops on reaches only
                // the buffer of that frame by its own writes.
                still.PlayAnimation("walk", true);
                for (int frame = 0; frame < 8; frame++) yield return BoneBurstFrames.Next();
                yield return WaitForShaderCompile(still);
                still.StopAnimation();
                yield return BoneBurstFrames.Next();
                for (int frame = 0; frame < BoneBurstFetch.RingSize * 3; frame++)
                    yield return BoneBurstFrames.Next(); // the still skeleton is not re-meshed; the ring turns

                Assert.IsTrue(still.LastMeshFetched, "the still skeleton is on vertex fetch");
                Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "only the animating neighbour is re-meshed");
                Color[] fetched = Render(still);

                // The same pose through the per-mesh upload: re-mesh without changing it.
                BoneBurstFetch.Enabled = false;
                still.Color = still.Color;
                yield return BoneBurstFrames.Next();
                Assert.IsFalse(still.LastMeshFetched, "fetch off: the per-mesh upload");
                Color[] uploaded = Render(still);

                float worst = 0;
                int covered = 0;
                for (int i = 0; i < fetched.Length; i++)
                {
                    Color d = fetched[i] - uploaded[i];
                    worst = Mathf.Max(worst,
                        Mathf.Max(Mathf.Max(Mathf.Abs(d.r), Mathf.Abs(d.g)),
                            Mathf.Max(Mathf.Abs(d.b), Mathf.Abs(d.a))));
                    if (uploaded[i].a > 0 || uploaded[i].r > 0) covered++;
                }

                Debug.Log($"[VertexFetch] still beside animating, after ring rotations: covered {covered} px, " +
                          $"max |fetch - upload| {worst:G3}");
                Assert.Greater(covered, 500, "nothing drawn: a blank comparison proves nothing");
                Assert.LessOrEqual(worst, Tolerance, "the still skeleton's last pose was lost in the ring");
            }
            finally
            {
                Object.Destroy(moving);
            }
        }

        /// <summary>
        ///     Draws once and waits while the Editor compiles shader variants, without touching the pose.
        /// </summary>
        private IEnumerator WaitForShaderCompile(BoneBurstSkeleton skeleton)
        {
            Render(skeleton);
#if UNITY_EDITOR
            for (int frame = 0; frame < 600 && ShaderUtil.anythingCompiling; frame++)
                yield return BoneBurstFrames.Next();
#endif
            yield return BoneBurstFrames.Next();
        }

        /// <summary>
        ///     A GPU-skinned skeleton whose animation deforms a mesh falls back to the CPU mesh every frame; from its
        ///     second fallback that CPU mesh goes through vertex fetch, and draws as the per-mesh upload does.
        /// </summary>
        [UnityTest]
        public IEnumerator GpuFallback_UsesFetch_DrawsLikeUpload()
        {
            BoneBurstSkeleton skeleton = Spawn($"{Samples}/spineboy-pro/spineboy-pro.json",
                $"{Samples}/spineboy-pro/spineboy-pro.atlas.txt", $"{Samples}/spineboy-pro/spineboy-pro.png", 0.01f,
                "BoneBurst/Unlit", false);
            skeleton.GpuSkinning = true;
            skeleton.PlayAnimation("walk", true);
            skeleton.TimeScale = 0; // a fixed pose; every frame still re-poses and re-meshes while it plays

            BoneBurstFetch.Enabled = true;
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(GpuMeshState.Cpu, skeleton.LastGpuState, "walk deforms: the GPU path falls back");
            Assert.IsTrue(skeleton.LastMeshFetched, "a repeated fallback should take vertex fetch");
            yield return WarmShaders(skeleton);
            Assert.IsTrue(skeleton.LastMeshFetched, "still on vertex fetch after the warm-up");
            Color[] fetched = Render(skeleton);

            BoneBurstFetch.Enabled = false;
            yield return BoneBurstFrames.Next();
            Assert.IsFalse(skeleton.LastMeshFetched, "fetch off: the per-mesh upload");
            yield return WarmShaders(skeleton);
            Color[] uploaded = Render(skeleton);

            float worst = 0;
            int covered = 0;
            for (int i = 0; i < fetched.Length; i++)
            {
                Color d = fetched[i] - uploaded[i];
                worst = Mathf.Max(worst,
                    Mathf.Max(Mathf.Max(Mathf.Abs(d.r), Mathf.Abs(d.g)), Mathf.Max(Mathf.Abs(d.b), Mathf.Abs(d.a))));
                if (uploaded[i].a > 0 || uploaded[i].r > 0) covered++;
            }

            Debug.Log($"[VertexFetch] GPU fallback walk: covered {covered} px, max |fetch - upload| {worst:G3}");
            Assert.Greater(covered, 500, "nothing drawn: a blank comparison proves nothing");
            Assert.LessOrEqual(worst, Tolerance, "the fallback's vertex fetch draws differently from its upload");
        }

        /// <summary>
        ///     A GPU instance's CPU fallback is built after the frame's fetch copy job; its range reaches the bound
        ///     ring buffer through the late copy (<c>BoneBurstFetch.ScheduleLate</c>). With a moving pose, the bound
        ///     buffer must hold this frame's vertices, not the previous frame's.
        /// </summary>
        [UnityTest]
        public IEnumerator GpuFallback_BoundBufferHoldsThisFramesVertices()
        {
            BoneBurstSkeleton skeleton = Spawn($"{Samples}/spineboy-pro/spineboy-pro.json",
                $"{Samples}/spineboy-pro/spineboy-pro.atlas.txt", $"{Samples}/spineboy-pro/spineboy-pro.png", 0.01f,
                "BoneBurst/Unlit", false);
            skeleton.GpuSkinning = true;
            skeleton.PlayAnimation("walk", true); // deforms: falls back every frame; moves every frame
            BoneBurstFetch.Enabled = true;
            for (int frame = 0; frame < 3; frame++) yield return BoneBurstFrames.Next();

            for (int frame = 0; frame < 5; frame++)
            {
                yield return BoneBurstFrames.Next();
                Assert.AreEqual(GpuMeshState.Cpu, skeleton.LastGpuState, "walk deforms: the GPU path falls back");
                Assert.IsTrue(skeleton.LastMeshFetched, "the fallback takes vertex fetch");
                int count = skeleton.Data.Output[0].VertexCount;
                int start = skeleton.Data.FetchBase;
                SkeletonVertex[] bound = new SkeletonVertex[count];
                BoneBurstFetch.BoundVertexBuffer.GetData(bound, 0, start, count);
                NativeArray<SkeletonVertex> current = BoneBurstFetch.VertexData;
                int differing = 0;
                for (int i = 0; i < count; i++)
                {
                    SkeletonVertex a = bound[i], b = current[start + i];
                    if (!a.Position.Equals(b.Position) || !a.Uv.Equals(b.Uv) || a.A != b.A) differing++;
                }

                Assert.AreEqual(0, differing, $"frame {frame}: the bound buffer holds a stale fallback pose");
            }
        }

        /// <summary>
        ///     The Editor compiles a shader variant on first use and draws a cyan placeholder meanwhile (the first run
        ///     after a recompile compared that placeholder against real output). Draw once, then wait for the compile.
        ///     Players compile every variant at build time, so this is Editor-only.
        /// </summary>
        private IEnumerator WarmShaders(BoneBurstSkeleton skeleton)
        {
            Render(skeleton);
#if UNITY_EDITOR
            for (int frame = 0; frame < 600 && ShaderUtil.anythingCompiling; frame++)
            {
                skeleton.SetupPose();
                yield return BoneBurstFrames.Next();
            }
#endif
            skeleton.SetupPose();
            yield return BoneBurstFrames.Next();
        }

        private BoneBurstSkeleton Spawn(string skeletonPath, string atlasPath, string pngPath, float scale,
            string shaderName,
            bool tintBlack)
        {
            Assert.IsTrue(File.Exists(skeletonPath), $"missing {skeletonPath}");
            string atlasText = File.ReadAllText(atlasPath);
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            BakedTestData.Assign(m_Asset, skeletonPath, atlasText, scale);
            m_Asset.TintBlack = tintBlack;
            Shader shader = Shader.Find(shaderName);
            Assert.IsNotNull(shader, shaderName);
            m_Asset.SetShader(shader);
            m_Page = pngPath != null ? LoadPng(pngPath) : Checker();
            int pages = AtlasReader.Read(atlasText).Pages.Count;
            Texture2D[] pageTextures = new Texture2D[pages];
            for (int i = 0; i < pages; i++) pageTextures[i] = m_Page;
            m_Asset.SetPageTextures(pageTextures);

            m_Object = new GameObject("BoneBurst vertex fetch test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        private Color[] Render(BoneBurstSkeleton skeleton)
        {
            const int Size = 256;
            if (m_Camera == null)
            {
                m_Camera = new GameObject("BoneBurst vertex fetch camera");
                Camera camera = m_Camera.AddComponent<Camera>();
                camera.orthographic = true;
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = Color.clear;
                camera.enabled = false;
                m_Target = new RenderTexture(Size, Size, 24, RenderTextureFormat.ARGBHalf,
                    RenderTextureReadWrite.Linear);
                camera.targetTexture = m_Target;
                Bounds bounds = skeleton.GetComponent<MeshRenderer>().bounds;
                camera.transform.position = new Vector3(bounds.center.x, bounds.center.y, -10);
                camera.orthographicSize = Mathf.Max(bounds.extents.x, bounds.extents.y) * 1.1f + 0.01f;
            }

            Camera cam = m_Camera.GetComponent<Camera>();
            cam.Render();
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = m_Target;
            Texture2D read = new(Size, Size, TextureFormat.RGBAFloat, false, true);
            read.ReadPixels(new Rect(0, 0, Size, Size), 0, 0);
            read.Apply();
            RenderTexture.active = previous;
            Color[] pixels = read.GetPixels();
            Object.Destroy(read);
            return pixels;
        }

        private static void Save(Color[] pixels, string path)
        {
            int size = (int)Mathf.Sqrt(pixels.Length);
            Texture2D image = new(size, size, TextureFormat.RGBA32, false);
            image.SetPixels(pixels);
            image.Apply();
            File.WriteAllBytes(path, image.EncodeToPNG());
            Object.Destroy(image);
        }

        private static Texture2D LoadPng(string path)
        {
            Texture2D texture = new(2, 2, TextureFormat.RGBA32, false);
            Assert.IsTrue(texture.LoadImage(File.ReadAllBytes(path)), $"cannot read {path}");
            return texture;
        }

        // A page with structure, so a wrong UV shows up as a different pixel.
        private static Texture2D Checker()
        {
            const int Size = 64;
            Texture2D texture = new(Size, Size, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
            Color32[] pixels = new Color32[Size * Size];
            for (int i = 0; i < pixels.Length; i++)
            {
                int x = i % Size, y = i / Size;
                pixels[i] = new Color32((byte)(x * 4), (byte)(y * 4), (byte)((x ^ y) * 4), (byte)(128 + (x + y) % 128));
            }

            texture.SetPixels32(pixels);
            texture.Apply();
            return texture;
        }
    }
}