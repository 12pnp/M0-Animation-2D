using System;
using System.Collections.Generic;
using AssetRuntime;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using Cysharp.Threading.Tasks;
using ModuleP1;
using UnityEditor;
using UnityEngine;
using BlendMode = BoneBurst.Data.BlendMode;
using Object = UnityEngine.Object;

namespace BoneBurst
{
    /// <summary>
    ///     A Spine 4.3 skeleton for BoneBurst: AssetSystem references to its baked data (<c>.sbdata</c>: skeleton,
    ///     atlas and name keys), its atlas page textures and its shader, plus how it renders. Builds its
    ///     <see cref="SkeletonBlob" /> on first use and shares it with every instance.
    /// </summary>
    /// <remarks>
    ///     The asset holds references, never objects: the AssetSystem decides what is in memory
    ///     (<c>Doc/Review/BoneBurst-AssetSystemPlan.md</c>). The data is baked from a Spine JSON export by
    ///     <see cref="BoneBurstDataWriter" /> (layout: <c>Doc/Format/BakedData.md</c>), with the load scale already
    ///     applied, and read once with <see cref="BoneBurstDataReader" /> into the blob; the data's handle is released
    ///     right after, since nothing reads the bytes again. In the Editor every reference answers synchronously by
    ///     GUID; in a player, await <see cref="PrepareAsync" /> (or let <see cref="BoneBurstSkeleton" /> do it).
    /// </remarks>
    [CreateAssetMenu(menuName = "BoneBurst/Skeleton Asset", fileName = "BoneBurstAsset")]
    public sealed class BoneBurstAsset : ScriptableObject
    {
        /// <summary>
        ///     How long a load waits for the AssetRuntime service to start (an asset may build before the
        ///     <see cref="AssetRuntimeHost" />'s <c>Awake</c>; M2 native core plan §5.7 D3).
        /// </summary>
        private const float ServiceTimeoutSeconds = 15f;

        /// <summary>
        ///     Stands in for the AssetSystem's data load when set (tests: a project without a loader cannot deliver
        ///     data late). Null in shipped code.
        /// </summary>
        internal static Func<BoneBurstAsset, UniTask<byte[]>> LoadDataOverride;

        private static readonly int s_RimMaskTex = Shader.PropertyToID("_RimMaskTex");
        private static readonly int s_RimColor = Shader.PropertyToID("_RimColor");
        private static readonly int s_RimStrength = Shader.PropertyToID("_RimStrength");
        private static readonly int s_RimWidth = Shader.PropertyToID("_RimWidth");
        private static readonly int s_RimDirection = Shader.PropertyToID("_RimDirection");

        /// <summary>
        ///     Assets holding a built blob. <c>AssetDatabase.DeleteAsset</c> destroys an asset without
        ///     <see cref="OnDisable" /> or <c>OnDestroy</c> (checked 2026-10-01), so its blob would stay allocated until
        ///     the domain unloads; the Editor frees those through <see cref="FreeDestroyed" />.
        /// </summary>
        private static readonly List<BoneBurstAsset> s_Built = new();

        [Tooltip("The baked .sbdata.bytes file (skeleton, atlas and name keys, at the scale they were baked " +
                 "with), as an AssetSystem reference. Read once into the blob, then released.")]
        [SerializeField]
        [ExpectBuiltInAsset(AssetTypeCodes.TextAsset)]
        private IndexGenericAsset m_Data;

        [Tooltip("The atlas pages as AssetSystem references, in the atlas file's page order: the GUID is the pivot, " +
                 "the ints are baked (the bake and the scan both do). A page without a reference renders untextured.")]
        [SerializeField]
        [ExpectBuiltInAsset(AssetTypeCodes.Texture)]
        private IndexGenericAsset[] m_Pages = Array.Empty<IndexGenericAsset>();

        // A direct reference, not an AssetSystem one: the BoneBurst shaders are package files, never addressable, so
        // a reference to them could not resolve in a player; a direct one puts the shader in the build with the asset
        // (Doc/Review/BoneBurst-PlayerShader-Plan.md, option c).
        [Tooltip("Shader for every page material. Empty: BoneBurst/Unlit. BoneBurst/Lit2D is lit by URP 2D lights.")]
        [SerializeField]
        private Shader m_Shader;

        [Header("Rim light (BoneBurst/Lit2D)")]
        [Tooltip(
            "Painted rim masks, one per atlas page (the page's <page>_rim.png, R channel, any resolution; half is " +
            "the default), as AssetSystem references written by the bake. Empty: the rim follows every edge. " +
            "Doc/Review/BoneBurst-TextureSplit-Plan.md §5.")]
        [SerializeField]
        [ExpectBuiltInAsset(AssetTypeCodes.Texture)]
        private IndexGenericAsset[] m_RimMasks = Array.Empty<IndexGenericAsset>();

        [Tooltip("The rim's colour; its alpha scales the strength.")]
        [SerializeField]
        private Color m_RimColor = Color.white;

        [Tooltip("0 turns the rim off (the shader skips it).")]
        [SerializeField]
        [Range(0, 4)]
        private float m_RimStrength;

        [Tooltip("How far past the outline the shader looks, in atlas texels; keep it within the atlas padding.")]
        [SerializeField]
        [Range(0.5f, 4)]
        private float m_RimWidth = 1.5f;

        [Tooltip("The side the rim light comes from, in world X / Y (up is +Y).")]
        [SerializeField]
        private Vector2 m_RimDirection = new(-0.7f, 0.7f);

        [Tooltip("Two-colour tinting: slots' dark colours reach the shader (extra vertex streams, as spine-unity's " +
                 "Tint Black). Turns the materials' _TINT_BLACK_ON on.")]
        public bool TintBlack;

        [Tooltip("Crossfade duration when switching animations, unless a pair below says otherwise. " +
                 "0.2 matches spine-unity's import default.")]
        public float DefaultMix = 0.2f;

        [Tooltip("Crossfade durations for specific animation pairs.")]
        public MixPair[] Mixes = Array.Empty<MixPair>();

        private readonly HashSet<int> m_DeliveredPages = new();

        private SkeletonBlob m_Blob;

        // ---- in-memory content: an asset built in code (tests, generated skeletons) has no files to reference. None
        // of it is serialized; a reference is the only thing a saved asset carries. ----

        [NonSerialized]
        private byte[] m_InMemoryData;

        [NonSerialized]
        private Texture2D[] m_InMemoryPages = Array.Empty<Texture2D>();

        [NonSerialized]
        private Texture2D[] m_InMemoryRimMasks = Array.Empty<Texture2D>();

        private BoneBurstKeyTable m_Keys;
        private Material[] m_Materials, m_GpuMaterials, m_FetchMaterials;

        [NonSerialized]
        private Texture2D[] m_PageCache = Array.Empty<Texture2D>();

        private AssetHandle<Texture2D>[] m_PageHandles = Array.Empty<AssetHandle<Texture2D>>();
        private bool m_PagesRequested;
        private bool m_Pma;
        private UniTaskCompletionSource m_Prepare;
        private AssetHandle<Texture2D>[] m_RimMaskHandles = Array.Empty<AssetHandle<Texture2D>>();

        private BoneAnimationStateData m_StateData;
        private bool m_WarnedNoLoader;

        /// <summary>
        ///     The baked data as an AssetSystem reference.
        /// </summary>
        public IndexGenericAsset DataReference => m_Data;

        /// <summary>
        ///     The atlas pages as AssetSystem references, in the atlas's page order.
        /// </summary>
        public IndexGenericAsset[] PageReferences => m_Pages;

        /// <summary>
        ///     The shader every page material uses; null means BoneBurst/Unlit.
        /// </summary>
        public Shader Shader => m_Shader;

        /// <summary>
        ///     Whether the asset has data to build from: a reference, or in-memory bytes (<see cref="SetDataBytes" />).
        /// </summary>
        public bool HasData => m_Data.IsValid || m_InMemoryData != null;

        /// <summary>
        ///     The rim masks as AssetSystem references, by atlas page; an invalid one means no mask on that page.
        /// </summary>
        public IndexGenericAsset[] RimMaskReferences => m_RimMasks;

        /// <summary>
        ///     The skeleton's name keys, baked into its data; read with the blob on first use.
        /// </summary>
        /// <exception cref="SkeletonFormatException">The data cannot be read.</exception>
        /// <exception cref="InvalidOperationException">No data is assigned.</exception>
        public BoneBurstKeyTable Keys
        {
            get
            {
                _ = Blob;
                return m_Keys;
            }
        }

        /// <summary>
        ///     Mix settings shared by every instance of this asset, as spine-unity shares one per asset.
        /// </summary>
        /// <exception cref="ArgumentException">A mix pair names an animation the skeleton does not have.</exception>
        public BoneAnimationStateData AnimationStateData
        {
            get
            {
                SkeletonBlob blob = Blob;
                if (m_StateData != null && m_StateData.Content == blob.Content) return m_StateData;
                BoneAnimationStateData data = new(blob.Content)
                {
                    DefaultMix = DefaultMix,
                    EventKeyIds = EventKeyIds(blob.Content.Skeleton.Events.Length)
                };
                foreach (MixPair pair in Mixes)
                {
                    if (string.IsNullOrEmpty(pair.From) || string.IsNullOrEmpty(pair.To)) continue;
                    data.SetMix(pair.From, pair.To, pair.Duration);
                }

                m_StateData = data;
                return data;
            }
        }

        /// <summary>
        ///     Whether the blob is built.
        /// </summary>
        public bool IsReady => m_Blob != null && m_Blob.IsCreated;

        /// <summary>
        ///     The shared blob, built on first call from data in hand: in-memory bytes, the loader's cache, or (Editor)
        ///     the data's GUID. In a player, <see cref="PrepareAsync" /> must have loaded the data first.
        /// </summary>
        /// <exception cref="SkeletonFormatException">The data cannot be read.</exception>
        /// <exception cref="InvalidOperationException">No data is assigned, or it is not loaded yet.</exception>
        public SkeletonBlob Blob
        {
            get
            {
                if (IsReady) return m_Blob;
                byte[] bytes = DataInHand();
                if (bytes == null)
                    throw new InvalidOperationException(m_Data.IsValid
                        ? $"{name}: the baked data is not loaded; await PrepareAsync() first."
                        : $"{name}: assign the baked skeleton data (.sbdata.bytes).");

                Build(bytes);
                return m_Blob;
            }
        }

        /// <summary>
        ///     Whether an AssetRuntime load can be answered: in Play Mode, with a service running or a host in the scene
        ///     that will start one. Otherwise the Editor resolves by GUID and a player has nothing to load from.
        /// </summary>
        private static bool CanLoad => Application.isPlaying &&
                                       (AssetService.Current != null ||
                                        FindAnyObjectByType<AssetRuntimeHost>() != null);

        /// <summary>
        ///     Whether the atlas pages use premultiplied alpha.
        /// </summary>
        public bool PremultipliedAlpha
        {
            get
            {
                _ = Blob;
                return m_Pma;
            }
        }

        private void OnDisable()
        {
            Free();
            s_Built.Remove(this);
        }

#if UNITY_EDITOR
        // Rim values edited in the inspector reach the live materials at once.
        private void OnValidate()
        {
            ApplyRimToAll();
        }
#endif

        /// <summary>
        ///     Replaces the data reference (the bake uses this).
        /// </summary>
        public void SetData(IndexGenericAsset data)
        {
            m_Data = data;
        }

        /// <summary>
        ///     Replaces the page references (the bake uses this).
        /// </summary>
        public void SetPages(IndexGenericAsset[] pages)
        {
            m_Pages = pages ?? Array.Empty<IndexGenericAsset>();
        }

        /// <summary>
        ///     Replaces the shader (the bake uses this); null means BoneBurst/Unlit.
        /// </summary>
        public void SetShader(Shader shader)
        {
            m_Shader = shader;
        }

        /// <summary>
        ///     Builds from these bytes instead of the data reference. Never saved.
        /// </summary>
        internal void SetDataBytes(byte[] data)
        {
            m_InMemoryData = data;
        }

        /// <summary>
        ///     Uses these page textures, in the atlas's page order, before any page reference. Never saved.
        /// </summary>
        internal void SetPageTextures(Texture2D[] pages)
        {
            m_InMemoryPages = pages != null ? (Texture2D[])pages.Clone() : Array.Empty<Texture2D>();
        }

        /// <summary>
        ///     Uses these rim masks, by page, instead of the references. Never saved.
        /// </summary>
        internal void SetRimMaskTextures(Texture2D[] masks)
        {
            m_InMemoryRimMasks = masks != null ? (Texture2D[])masks.Clone() : Array.Empty<Texture2D>();
            ApplyRimToAll();
        }

        /// <summary>
        ///     Sets the rim light (<c>BoneBurst/Lit2D</c>; strength 0 is off) and updates every built material.
        /// </summary>
        public void SetRim(Color color, float strength, float width, Vector2 direction)
        {
            m_RimColor = color;
            m_RimStrength = Mathf.Max(0, strength);
            m_RimWidth = Mathf.Max(0.01f, width);
            m_RimDirection = direction;
            ApplyRimToAll();
        }

        /// <summary>
        ///     Replaces the rim mask references, by page (the bake uses this).
        /// </summary>
        public void SetRimMasks(IndexGenericAsset[] masks)
        {
            m_RimMasks = masks ?? Array.Empty<IndexGenericAsset>();
            foreach (AssetHandle<Texture2D> handle in m_RimMaskHandles) handle?.Dispose();
            m_RimMaskHandles = Array.Empty<AssetHandle<Texture2D>>();
            RequestRimMasks();
            ApplyRimToAll();
        }

        /// <summary>
        ///     The export's name for a baked key of <paramref name="kind" />.
        /// </summary>
        /// <exception cref="ArgumentException">The key is not baked, or names something of another kind.</exception>
        public string NameOf(int keyId, BoneBurstKeyKind kind)
        {
            if (!Keys.TryGet(keyId, out BoneBurstKeyTable.Entry entry))
                throw new ArgumentException($"{name} has no key with id {keyId}.", nameof(keyId));

            if (entry.Kind != kind)
                throw new ArgumentException($"key '{entry.Key}' names {entry.Kind} '{entry.Name}', expected {kind}.",
                    nameof(keyId));

            return entry.Name;
        }

        /// <summary>
        ///     Each event's baked key id, by event index.
        /// </summary>
        private int[] EventKeyIds(int eventCount)
        {
            int[] ids = new int[eventCount];
            foreach (BoneBurstKeyTable.Entry entry in Keys.Entries)
                if (entry.Kind == BoneBurstKeyKind.Event)
                    ids[entry.Index] = entry.Key.Id;

            return ids;
        }

        /// <summary>
        ///     The blob when it is built or its data is in hand (it is built then); false while the data still has to
        ///     load (<see cref="PrepareAsync" />) or none is assigned.
        /// </summary>
        /// <exception cref="SkeletonFormatException">The data in hand cannot be read.</exception>
        public bool TryGetBlob(out SkeletonBlob blob)
        {
            if (!IsReady)
            {
                byte[] bytes = DataInHand();
                if (bytes != null) Build(bytes);
            }

            blob = IsReady ? m_Blob : null;
            return blob != null;
        }

        /// <summary>
        ///     Loads the data through the AssetSystem, builds the blob, releases the data, and asks for the pages and
        ///     the shader. Every caller shares one load; completes at once when the blob is built. Not cancellable:
        ///     the load is shared by every skeleton waiting on this asset.
        /// </summary>
        /// <exception cref="InvalidOperationException">No data is assigned, or the AssetSystem cannot load it.</exception>
        /// <exception cref="SkeletonFormatException">The data cannot be read.</exception>
        public UniTask PrepareAsync()
        {
            if (TryGetBlob(out _)) return UniTask.CompletedTask;
            // A completion source, not a Preserve()d task: several skeletons await it while it is still pending.
            // A finished one (a failed load) is replaced, so the next call retries.
            if (m_Prepare == null || m_Prepare.Task.Status != UniTaskStatus.Pending)
            {
                m_Prepare = new UniTaskCompletionSource();
                RunPrepare(m_Prepare).Forget();
            }

            return m_Prepare.Task;
        }

        private async UniTaskVoid RunPrepare(UniTaskCompletionSource done)
        {
            try
            {
                await LoadData();
                done.TrySetResult();
            }
            catch (Exception e)
            {
                done.TrySetException(e);
            }
        }

        /// <summary>
        ///     Waits for the running AssetRuntime service before a load. V2 loads by GUID with no group wrapper to wait for
        ///     (D2), and refuses a reference SmartAddresser has not indexed (D0), so that is checked first.
        /// </summary>
        /// <exception cref="InvalidOperationException">The reference is not indexed, or no service started in time.</exception>
        private async UniTask WaitForService(IndexGenericAsset reference)
        {
            if (!reference.IsBaked)
                throw new InvalidOperationException(
                    $"{name}: {reference.AssetGuid} is not indexed (SmartAddresser Apply then Index); the AssetRuntime " +
                    "loads only indexed references.");

            if (await AssetService.WaitForCurrentAsync(TimeSpan.FromSeconds(ServiceTimeoutSeconds)) != null) return;
            throw new InvalidOperationException(
                $"{name}: no AssetRuntime service started within {ServiceTimeoutSeconds} s (guid {reference.AssetGuid}); " +
                "is an AssetRuntimeHost in the scene?");
        }

        private async UniTask LoadData()
        {
            if (LoadDataOverride != null)
            {
                byte[] bytes = await LoadDataOverride(this);
                if (this != null && !IsReady) Build(bytes);
                return;
            }

            if (!m_Data.IsValid)
                throw new InvalidOperationException($"{name}: assign the baked skeleton data (.sbdata.bytes).");

            byte[] data = await LoadDataBytesAsync();
            if (this != null && !IsReady) Build(data);
        }

        /// <summary>
        ///     The baked data bytes through the AssetRuntime: the load <see cref="PrepareAsync" /> makes, for callers that
        ///     want the bytes themselves (the load-time benchmark). The handle is released before returning; the bytes
        ///     are a copy.
        /// </summary>
        /// <exception cref="InvalidOperationException">No data reference, it is not indexed, or nothing loads it.</exception>
        public async UniTask<byte[]> LoadDataBytesAsync()
        {
            if (!m_Data.IsValid)
                throw new InvalidOperationException($"{name}: assign the baked skeleton data (.sbdata.bytes).");

            await WaitForService(m_Data);
            using AssetHandle<TextAsset> handle = await m_Data.LoadHandleAsync<TextAsset>();
            if (handle == null || handle.Asset == null)
                throw new InvalidOperationException(
                    $"{name}: the AssetRuntime found no data (guid {m_Data.AssetGuid}); is an AssetRuntimeHost in the scene?");

            return handle.Asset.bytes;
        }

        /// <summary>
        ///     The data bytes that need no wait, or null: in-memory bytes, then the reference through
        ///     <see cref="Resolve{T}" />.
        /// </summary>
        private byte[] DataInHand()
        {
            if (m_InMemoryData != null) return m_InMemoryData;
            TextAsset data = Resolve<TextAsset>(m_Data);
            return data != null ? data.bytes : null;
        }

        private void Build(byte[] bytes)
        {
            BoneBurstData data = BoneBurstDataReader.Read(bytes);
            AtlasDef atlas = data.Atlas;
            SkeletonDef skeleton = data.Skeleton;
            m_Keys = new BoneBurstKeyTable(data.Keys, data.KeyIds);
            m_Blob = BlobBuilder.Build(skeleton, atlas);
            if (!s_Built.Contains(this)) s_Built.Add(this);
            m_Pma = atlas.Pages.Count > 0 && atlas.Pages[0].Pma;
            int unaddressed = atlas.Pages.Count;
            for (int i = 0; i < atlas.Pages.Count; i++)
                if (InMemoryPage(i) != null || (i < m_Pages.Length && m_Pages[i].IsValid))
                    unaddressed--;

            if (unaddressed > 0)
                Debug.LogError(
                    $"{name}: {unaddressed} of the atlas's {atlas.Pages.Count} pages have no AssetSystem reference; they render untextured.",
                    this);

            RequestPages();
            RequestRimMasks();
        }

        /// <summary>
        ///     A reference's asset in hand, through the one resolution path: the loader's cache, then (Editor) the GUID
        ///     cache. Null when only an asynchronous load can answer, or the reference is empty.
        /// </summary>
        private static T Resolve<T>(IndexGenericAsset reference) where T : Object
        {
            if (!reference.IsValid) return null;
            T loaded = reference.GetLoaded<T>();
#if UNITY_EDITOR
            // No service, or not loaded yet: the editor answers by the reference's GUID.
            if (loaded == null)
            {
                string path = AssetDatabase.GUIDToAssetPath(reference.AssetGuid);
                if (!string.IsNullOrEmpty(path)) loaded = AssetDatabase.LoadAssetAtPath<T>(path);
            }
#endif
            return loaded;
        }

        /// <summary>
        ///     The material for an atlas page and blend mode, created once and reused. <paramref name="gpu" />: the
        ///     GPU-skinning variant (<c>BONE_BURST_GPU</c> on), a separate material so the SRP Batcher keeps both.
        ///     <paramref name="vertexFetch" />: the vertex-fetch variant (<c>BONE_BURST_FETCH</c>,
        ///     <see cref="BoneBurstFetch" />).
        /// </summary>
        public Material MaterialFor(int page, BlendMode blend, bool gpu = false, bool vertexFetch = false)
        {
            _ = Blob;
            int count = m_Blob.PageCount * 4;
            ref Material[] materials =
                ref gpu ? ref m_GpuMaterials : ref vertexFetch ? ref m_FetchMaterials : ref m_Materials;
            if (materials == null || materials.Length != count) materials = new Material[count];

            int key = page * 4 + (int)blend;
            if (page < 0 || key >= count) return null;

            if (materials[key] != null) return materials[key];

            Shader shader = ResolveShader();
            if (shader == null)
            {
                Debug.LogError($"{name}: shader BoneBurst/Unlit not found.", this);
                return null;
            }

            Material material = new(shader)
            {
                name = $"{name} p{page} {blend}{(gpu ? " GPU" : vertexFetch ? " Fetch" : "")}",
                hideFlags = HideFlags.DontSave
            };
            Texture2D pageTexture = ResolvePage(page);
            if (pageTexture != null) material.mainTexture = pageTexture;

            BoneBurstMaterials.Configure(material, blend, m_Pma, TintBlack, gpu, vertexFetch);
            ApplyRim(material, page);
            materials[key] = material;
            return material;
        }

        // ---- the atlas page lifecycle: references are the data, the cache is a convenience, handles are the
        // lifetime. ResolvePage answers what is in hand; RequestPages loads what is not, holding one refcounted
        // handle per page (every skeleton sharing this asset shares it); PageLoaded lands the arrivals and Free
        // releases the handles. ----

        /// <summary>
        ///     The page texture in hand: in-memory, then an earlier delivery (the cache), then
        ///     <see cref="Resolve{T}" />. Null when
        ///     only an asynchronous load can answer — warned once per asset when no loader exists at all.
        /// </summary>
        private Texture2D ResolvePage(int page)
        {
            Texture2D inMemory = InMemoryPage(page);
            if (inMemory != null) return inMemory;
            if (page < m_PageCache.Length && m_PageCache[page] != null) return m_PageCache[page];
            if (page >= m_Pages.Length || !m_Pages[page].IsValid) return null;

            Texture2D addressed = Resolve<Texture2D>(m_Pages[page]);
            if (addressed == null && !CanLoad && !m_WarnedNoLoader)
            {
                m_WarnedNoLoader = true;
                Debug.LogWarning(
                    $"{name}: page {page} is an AssetSystem reference, but no AssetRuntime runs; it renders untextured.",
                    this);
            }

            return addressed;
        }

        /// <summary>
        ///     Asks the AssetSystem for every page that <see cref="ResolvePage" /> cannot answer synchronously, once
        ///     per session: a loader must exist (in the Editor without one, the GUID cache answers instead), and the
        ///     arrivals land through <see cref="PageLoaded" /> while the handles wait for <see cref="Free" />.
        /// </summary>
        private void RequestPages()
        {
            if (m_PagesRequested || !CanLoad) return;
            m_PagesRequested = true;
            for (int page = 0; page < m_Blob.PageCount && page < m_Pages.Length; page++)
            {
                if (InMemoryPage(page) != null || (page < m_PageCache.Length && m_PageCache[page] != null)) continue;
                if (!m_Pages[page].IsValid) continue;
                LoadPage(page);
            }
        }

        private async void LoadPage(int page)
        {
            try
            {
                await WaitForService(m_Pages[page]);
                AssetHandle<Texture2D> handle = await m_Pages[page].LoadHandleAsync<Texture2D>();
                if (handle == null || handle.Asset == null)
                {
                    Debug.LogWarning(
                        $"{name}: the AssetSystem found no texture for page {page} (guid {m_Pages[page].AssetGuid}).",
                        this);
                    return;
                }

                if (m_PageHandles.Length < m_Blob.PageCount) Array.Resize(ref m_PageHandles, m_Blob.PageCount);

                m_PageHandles[page]?.Dispose();
                m_PageHandles[page] = handle;
                PageLoaded(page, handle.Asset);
            }
            catch (OperationCanceledException)
            {
                // The service shut down (quit, scene change) with this load pending: nothing to report.
            }
            catch (Exception e)
            {
                Debug.LogWarning(
                    $"{name}: page {page} did not load through the AssetSystem: {e.Message}.", this);
            }
        }

        /// <summary>
        ///     A page source delivers a page texture, on the main thread: it lands in the page cache and every
        ///     already-cached material of that page takes it. Late duplicates are ignored.
        /// </summary>
        internal void PageLoaded(int page, Texture2D texture)
        {
            if (texture == null || m_Blob == null || page < 0 || page >= m_Blob.PageCount) return;
            if (!m_DeliveredPages.Add(page)) return; // a late duplicate delivery is ignored
            if (InMemoryPage(page) != null) return;
            if (m_PageCache.Length < m_Blob.PageCount) Array.Resize(ref m_PageCache, m_Blob.PageCount);
            m_PageCache[page] = texture;

            ApplyPageTexture(m_Materials, page, texture);
            ApplyPageTexture(m_GpuMaterials, page, texture);
            ApplyPageTexture(m_FetchMaterials, page, texture);
        }

        private Texture2D InMemoryPage(int page)
        {
            return page >= 0 && page < m_InMemoryPages.Length ? m_InMemoryPages[page] : null;
        }

        private static void ApplyPageTexture(Material[] materials, int page, Texture texture)
        {
            if (materials == null) return;
            for (int blend = 0; blend < 4; blend++)
            {
                Material material = materials[page * 4 + blend];
                if (material != null) material.mainTexture = texture;
            }
        }

        // ---- the shader: a direct reference, nothing to load. ----

        /// <summary>
        ///     The asset's shader, or BoneBurst/Unlit when it has none.
        /// </summary>
        private Shader ResolveShader()
        {
            return m_Shader != null ? m_Shader : Shader.Find("BoneBurst/Unlit");
        }

        // ---- the rim ramp: in hand, request, load — the same three steps as a page. ----

        private Texture2D ResolveRimMask(int page)
        {
            if (page < m_InMemoryRimMasks.Length && m_InMemoryRimMasks[page] != null) return m_InMemoryRimMasks[page];
            if (page < m_RimMaskHandles.Length && m_RimMaskHandles[page]?.Asset != null)
                return m_RimMaskHandles[page].Asset;
            return page < m_RimMasks.Length ? Resolve<Texture2D>(m_RimMasks[page]) : null;
        }

        private void RequestRimMasks()
        {
            if (!CanLoad) return;
            if (m_RimMaskHandles.Length != m_RimMasks.Length) Array.Resize(ref m_RimMaskHandles, m_RimMasks.Length);

            for (int page = 0; page < m_RimMasks.Length; page++)
            {
                if (!m_RimMasks[page].IsValid || m_RimMaskHandles[page] != null) continue;
                if (Resolve<Texture2D>(m_RimMasks[page]) != null) continue;
                LoadRimMask(page);
            }
        }

        private async void LoadRimMask(int page)
        {
            IndexGenericAsset reference = m_RimMasks[page];
            try
            {
                await WaitForService(reference);
                AssetHandle<Texture2D> handle = await reference.LoadHandleAsync<Texture2D>();
                if (handle == null || handle.Asset == null)
                {
                    Debug.LogWarning(
                        $"{name}: the AssetSystem found no rim mask for page {page} (guid {reference.AssetGuid}); " +
                        "the rim follows every edge there.", this);
                    return;
                }

                if (page >= m_RimMaskHandles.Length)
                {
                    handle.Dispose();
                    return;
                }

                m_RimMaskHandles[page]?.Dispose();
                m_RimMaskHandles[page] = handle;
                ApplyRimToAll();
            }
            catch (OperationCanceledException)
            {
                // The service shut down (quit, scene change) with this load pending: nothing to report.
            }
            catch (Exception e)
            {
                Debug.LogWarning(
                    $"{name}: the rim mask for page {page} did not load through the AssetSystem: {e.Message}.", this);
            }
        }

        private void ApplyRim(Material material, int page)
        {
            Texture2D mask = ResolveRimMask(page);
            material.SetTexture(s_RimMaskTex, mask != null ? mask : Texture2D.whiteTexture);
            material.SetColor(s_RimColor, m_RimColor);
            material.SetFloat(s_RimStrength, m_RimStrength);
            material.SetFloat(s_RimWidth, m_RimWidth);
            material.SetVector(s_RimDirection, m_RimDirection);
        }

        private void ApplyRimToAll()
        {
            foreach (Material[] materials in new[] { m_Materials, m_GpuMaterials, m_FetchMaterials })
            {
                if (materials == null) continue;
                // Materials are keyed page × 4 + blend mode (MaterialFor).
                for (int i = 0; i < materials.Length; i++)
                    if (materials[i] != null)
                        ApplyRim(materials[i], i / 4);
            }
        }

        /// <summary>
        ///     Frees the blob and materials of every asset destroyed since it built them. Only the Editor destroys
        ///     assets this way; it calls this each editor update and before a script reload.
        /// </summary>
        internal static void FreeDestroyed()
        {
            for (int i = s_Built.Count - 1; i >= 0; i--)
            {
                // A destroyed asset compares equal to null; its managed fields are still there to free.
                if (s_Built[i] != null) continue;
                s_Built[i].Free();
                s_Built.RemoveAt(i);
            }
        }

        internal void Free()
        {
            // Jobs may still read the blob; finish them before freeing its memory.
            if (m_Blob != null)
            {
                BoneBurstSystem.DetachAll(m_Blob);
                BoneBurstGpu.ReleaseBlob(m_Blob);
            }

            foreach (AssetHandle<Texture2D> handle in
                     m_PageHandles) handle?.Dispose(); // release the AssetSystem's references; idempotent per handle

            Array.Clear(m_PageHandles, 0, m_PageHandles.Length);
            foreach (AssetHandle<Texture2D> handle in m_RimMaskHandles) handle?.Dispose();
            m_RimMaskHandles = Array.Empty<AssetHandle<Texture2D>>();
            // The released pages may unload: forget them, so the next build asks again.
            Array.Clear(m_PageCache, 0, m_PageCache.Length);
            m_DeliveredPages.Clear();
            m_PagesRequested = false;
            m_Blob?.Dispose();
            m_Blob = null;
            m_Keys = null;
            m_StateData = null;
            DestroyAll(ref m_Materials);
            DestroyAll(ref m_GpuMaterials);
            DestroyAll(ref m_FetchMaterials);
        }

        private static void DestroyAll(ref Material[] materials)
        {
            if (materials == null) return;
            foreach (Material material in materials)
                if (material != null)
                    DestroyImmediate(material);

            materials = null;
        }

        /// <summary>
        ///     A crossfade duration for one ordered pair of animations.
        /// </summary>
        [Serializable]
        public struct MixPair
        {
            public string From, To;
            public float Duration;
        }
    }
}