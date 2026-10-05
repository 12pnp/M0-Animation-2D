using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using BoneBurst.Data;
using ModuleP1;
using ModuleP1.AssetSystemEditor.Mapping;
using UnityEditor;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using Object = UnityEngine.Object;

namespace BoneBurst.Editor
{
    /// <summary>
    ///     Bakes a Spine export folder (one <c>.json</c> or <c>.skel.bytes</c>, one <c>.atlas.txt</c>, the atlas page
    ///     textures) into an
    ///     output folder that holds only what BoneBurst loads: <c>&lt;name&gt;.sbdata.bytes</c>, a copy of each
    ///     page texture, and <c>&lt;name&gt;_BoneBurst.asset</c>. No UI: <see cref="BoneBurstBakePopup" /> and
    ///     <see cref="BoneBurstBakeMenu" /> call it.
    /// </summary>
    /// <remarks>
    ///     <para>
    ///         Never destroys authored work (<c>CLAUDE.md</c> §6). The export folder is only read. Every target path is
    ///         checked before anything is written: it must be empty or hold a file this bake made from this export
    ///         (recorded in its importer's <c>userData</c>). Anything else, of any type, stops the bake with nothing
    ///         written. A rebake rewrites its own files in place, so their GUIDs and every scene reference survive.
    ///         No <c>AssetDatabase.DeleteAsset</c>.
    ///     </para>
    ///     <para>
    ///         The runtime asset carries no bake settings. The source folder, the source digest and the texture
    ///         settings live in the data file's importer <c>userData</c>; the scale is in the data's header.
    ///     </para>
    /// </remarks>
    public static class BoneBurstBake
    {
        public const string DataExtension = ".sbdata.bytes";
        private const string BinaryExtension = ".skel.bytes";
        public const string AssetSuffix = "_BoneBurst.asset";
        private const string VariantInfix = "_BoneBurst_";
        private const string Marker = "BoneBurstBake";

        /// <summary>
        ///     Asset label on every data file a bake writes, so <see cref="FindPreviousData" /> searches the label
        ///     index instead of reading the importer of every <c>TextAsset</c> in the project.
        /// </summary>
        public const string DataLabel = "BoneBurstData";

        /// <summary>
        ///     The file name ending of a page's painted rim mask (Doc/Review/BoneBurst-TextureSplit-Plan.md §5).
        /// </summary>
        public const string RimSuffix = "_rim.png";

        /// <summary>
        ///     The rim mask file of a page, <c>&lt;page&gt;_rim.png</c> in the same folder, or null when there is none.
        /// </summary>
        public static string RimMaskOf(string page)
        {
            string path =
                $"{Path.GetDirectoryName(page)?.Replace('\\', '/')}/{Path.GetFileNameWithoutExtension(page)}{RimSuffix}";
            return AssetDatabase.LoadAssetAtPath<Texture2D>(path) != null ? path : null;
        }

        // ---- Source -------------------------------------------------------------------------------------------

        /// <summary>
        ///     The export in <paramref name="folder" />, or null with every reason it cannot be baked, in one message,
        ///     in <paramref name="error" />: a click reports all there is to fix at once.
        /// </summary>
        public static Source FindSource(string folder, out string error)
        {
            error = null;
            folder = folder?.Replace('\\', '/').TrimEnd('/');
            if (string.IsNullOrEmpty(folder) || !AssetDatabase.IsValidFolder(folder))
            {
                error = $"'{folder}' is not a project folder.";
                return null;
            }

            List<string> problems = new();
            string[] files = Directory.GetFiles(folder).Select(f => f.Replace('\\', '/')).ToArray();
            string[] jsons = files.Where(f => f.EndsWith(".json", StringComparison.OrdinalIgnoreCase)).ToArray();
            string[] binaries = files.Where(f => f.EndsWith(BinaryExtension, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            string[] atlases = files.Where(f => f.EndsWith(".atlas.txt", StringComparison.OrdinalIgnoreCase)).ToArray();
            // One JSON export wins (the folder may hold its binary twin too); without JSON, one binary export.
            string export = jsons.Length == 1 ? jsons[0] :
                jsons.Length == 0 && binaries.Length == 1 ? binaries[0] : null;
            if (export == null)
                problems.Add($"it has {jsons.Length} .json and {binaries.Length} {BinaryExtension} files; " +
                             $"exactly one Spine export is needed (one .json, or else one {BinaryExtension})");

            if (atlases.Length != 1) problems.Add($"it has {atlases.Length} .atlas.txt files; exactly one is needed");

            string[] pages = null;
            if (atlases.Length == 1)
            {
                AtlasDef atlas = null;
                try
                {
                    atlas = AtlasReader.Read(File.ReadAllText(atlases[0]));
                }
                catch (SkeletonFormatException e)
                {
                    problems.Add($"{Path.GetFileName(atlases[0])} cannot be read: {e.Message}");
                }

                if (atlas != null && atlas.Pages.Count == 0)
                {
                    problems.Add($"{Path.GetFileName(atlases[0])} names no atlas pages");
                }
                else if (atlas != null)
                {
                    pages = new string[atlas.Pages.Count];
                    List<string> missing = new();
                    for (int i = 0; i < pages.Length; i++)
                    {
                        pages[i] = $"{folder}/{atlas.Pages[i].Name}";
                        if (AssetDatabase.LoadAssetAtPath<Texture2D>(pages[i]) == null)
                            missing.Add(atlas.Pages[i].Name);
                    }

                    if (missing.Count > 0)
                        problems.Add($"it is missing the atlas page texture(s): {string.Join(", ", missing)}");
                }
            }

            if (problems.Count > 0)
            {
                error = $"{folder} cannot be baked:\n- " + string.Join("\n- ", problems);
                return null;
            }

            return new Source { Folder = folder, Export = export, Atlas = atlases[0], Pages = pages };
        }

        // ---- Settings -----------------------------------------------------------------------------------------

        /// <summary>
        ///     Settings for a bake of <paramref name="source" />: the previous bake's, when there is one, else the
        ///     defaults (output <c>&lt;parent&gt;/&lt;name&gt;_BoneBurst</c>). The caller owns the returned object.
        /// </summary>
        /// <param name="source">The export to bake.</param>
        /// <param name="previous">
        ///     The earlier bake's data file, when the caller knows it (a rebake of one asset); else it is looked up by
        ///     <see cref="DataLabel" />.
        /// </param>
        public static BoneBurstBakeSettings SettingsFor(Source source, string previous = null)
        {
            BoneBurstBakeSettings settings = ScriptableObject.CreateInstance<BoneBurstBakeSettings>();
            settings.hideFlags = HideFlags.DontSave;
            settings.Name = source.BaseName;
            string parent = Path.GetDirectoryName(source.Folder)?.Replace('\\', '/');
            settings.OutputFolder = $"{parent}/{source.BaseName}_BoneBurst";

            previous ??= FindPreviousData(source.Guid);
            Record record = previous != null ? ReadRecord(previous) : null;
            if (record == null || record.Source != source.Guid) return settings;

            settings.Name = Path.GetFileName(previous)
                .Substring(0, Path.GetFileName(previous).Length - DataExtension.Length);
            settings.OutputFolder = Path.GetDirectoryName(previous)?.Replace('\\', '/');
            settings.MaxTextureSize = (BoneBurstBakeSettings.TextureSize)record.MaxTextureSize;
            settings.CompressTextures = record.CompressTextures;
            try
            {
                settings.Scale = BoneBurstDataReader.Read(File.ReadAllBytes(previous)).Scale;
            }
            catch (SkeletonFormatException e)
            {
                Debug.LogWarning($"BoneBurst bake: the previous data {previous} cannot be read ({e.Message}); " +
                                 "using the default scale.");
            }

            if (AssetDatabase.LoadAssetAtPath<Object>(AssetPath(settings)) is BoneBurstAsset asset)
            {
                settings.Shader = BoneBurstBakeSettings.ChoiceOf(asset.Shader);
                settings.TintBlack = asset.TintBlack;
                settings.DefaultMix = asset.DefaultMix;
                settings.Mixes = (BoneBurstAsset.MixPair[])asset.Mixes.Clone();
            }

            settings.Variants = FindVariants(settings, previous);
            return settings;
        }

        /// <summary>
        ///     The variants beside an earlier bake: every <c>&lt;name&gt;_BoneBurst_&lt;suffix&gt;.asset</c> in its
        ///     output folder that uses its data file.
        /// </summary>
        private static BoneBurstBakeSettings.Variant[] FindVariants(BoneBurstBakeSettings s, string dataPath)
        {
            string prefix = $"{s.Name}{VariantInfix}";
            List<BoneBurstBakeSettings.Variant> variants = new();
            string[] files = Directory.GetFiles(s.OutputFolder, $"{prefix}*.asset");
            Array.Sort(files, StringComparer.Ordinal);
            foreach (string file in files)
            {
                string path = file.Replace('\\', '/');
                if (!(AssetDatabase.LoadAssetAtPath<Object>(path) is BoneBurstAsset variant) ||
                    DataPathOf(variant) != dataPath)
                    continue;

                string fileName = Path.GetFileNameWithoutExtension(path);
                variants.Add(new BoneBurstBakeSettings.Variant
                {
                    Suffix = fileName.Substring(prefix.Length),
                    Shader = BoneBurstBakeSettings.ChoiceOf(variant.Shader),
                    TintBlack = variant.TintBlack
                });
            }

            return variants.ToArray();
        }

        /// <summary>
        ///     The data file an earlier bake of the source folder with this GUID wrote, or null. Only labelled data
        ///     files are searched (<see cref="DataLabel" />); the asset's Rebake command passes its own data instead.
        /// </summary>
        private static string FindPreviousData(string sourceGuid)
        {
            foreach (string guid in AssetDatabase.FindAssets($"l:{DataLabel}"))
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (!path.EndsWith(DataExtension)) continue;
                Record record = ReadRecord(path);
                if (record != null && record.Source == sourceGuid) return path;
            }

            return null;
        }

        /// <summary>
        ///     The export an asset was baked from, for a rebake without the popup. Null with the reason when the
        ///     asset was not made by a bake or its export has moved away.
        /// </summary>
        public static Source SourceOf(BoneBurstAsset asset, out string error)
        {
            error = null;
            string data = DataPathOf(asset);
            Record record = data != null ? ReadRecord(data) : null;
            if (record == null)
            {
                error = $"{asset.name} was not made by a BoneBurst bake (its data has no bake record).";
                return null;
            }

            string folder = AssetDatabase.GUIDToAssetPath(record.Source);
            if (string.IsNullOrEmpty(folder))
            {
                error = $"{asset.name}: the export folder it was baked from no longer exists.";
                return null;
            }

            return FindSource(folder, out error);
        }

        /// <summary>
        ///     The path of the data file an asset references, or null when it references none that exists.
        /// </summary>
        public static string DataPathOf(BoneBurstAsset asset)
        {
            return PathOf(asset.DataReference);
        }

        private static string PathOf(IndexGenericAsset reference)
        {
            if (!reference.IsValid) return null;
            string path = AssetDatabase.GUIDToAssetPath(reference.AssetGuid);
            return string.IsNullOrEmpty(path) ? null : path;
        }

        /// <summary>
        ///     An AssetSystem reference to the file at <paramref name="path" />: GUID and type, and — when the
        ///     SmartAddresser-backed mapping knows the file — the durable key baked into its ints (-1 otherwise).
        /// </summary>
        private static IndexGenericAsset ReferenceTo(string path, short assetType, ref int indexed,
            ref int notAddressable)
        {
            string guid = AssetDatabase.AssetPathToGUID(path);
            if (string.IsNullOrEmpty(guid)) return IndexGenericAsset.Empty;
            MappingMutationResult key = MappingMutationService.EnsureIndexed(guid, assetType);
            if (key.Success)
            {
                indexed++;
                return new IndexGenericAsset(guid, key.GroupIndex, key.AssetIndex, assetType, -1);
            }

            notAddressable++;
            return new IndexGenericAsset(guid, -1, -1, assetType, -1);
        }

        private static string AssetPath(BoneBurstBakeSettings s)
        {
            return $"{s.OutputFolder}/{s.Name}{AssetSuffix}";
        }

        private static string VariantPath(BoneBurstBakeSettings s, BoneBurstBakeSettings.Variant v)
        {
            return $"{s.OutputFolder}/{s.Name}{VariantInfix}{v.Suffix}.asset";
        }

        private static string DataPath(BoneBurstBakeSettings s)
        {
            return $"{s.OutputFolder}/{s.Name}{DataExtension}";
        }

        // ---- Bake ---------------------------------------------------------------------------------------------

        /// <summary>
        ///     Reads the export, checks every target, then writes the data, the textures and the asset. On any
        ///     problem before writing, nothing is written and <see cref="Result.Error" /> says why.
        /// </summary>
        public static Result Bake(Source source, BoneBurstBakeSettings settings)
        {
            string error = CheckSettings(source, settings);
            if (error != null) return new Result { Error = error };

            // 1. Read and bake in memory.
            byte[] export = File.ReadAllBytes(source.Export);
            byte[] atlasBytes = File.ReadAllBytes(source.Atlas);
            SkeletonDef skeleton;
            AtlasDef atlas;
            byte[] data;
            byte[] digest;
            try
            {
                skeleton = source.IsBinary
                    ? SkeletonBinaryReader.Read(export, settings.Scale)
                    : SkeletonJsonReader.Read(File.ReadAllText(source.Export), settings.Scale);
                atlas = AtlasReader.Read(File.ReadAllText(source.Atlas));
                error = CheckContent(skeleton, atlas, source, settings);
                if (error != null) return new Result { Error = error };

                using (SHA1 sha1 = SHA1.Create())
                {
                    digest = sha1.ComputeHash(export.Concat(atlasBytes).ToArray());
                }

                data = BoneBurstDataWriter.Write(skeleton, atlas, settings.Scale, digest);
                BoneBurstDataReader.Read(data);
            }
            catch (SkeletonFormatException e)
            {
                return new Result { Error = $"{source.Export}: {e.Message}" };
            }

            // 2. Every target is empty or ours, before anything is written.
            string dataPath = DataPath(settings);
            string assetPath = AssetPath(settings);
            string[] texturePaths =
                source.Pages.Select(p => $"{settings.OutputFolder}/{Path.GetFileName(p)}").ToArray();
            string[] rimSources = source.RimMasks;
            string[] rimPaths = rimSources
                .Select(p => p == null ? null : $"{settings.OutputFolder}/{Path.GetFileName(p)}").ToArray();
            string sourceGuid = source.Guid;
            List<string> refused = new();
            CheckOwnFile(dataPath, sourceGuid, refused);
            foreach (string path in texturePaths) CheckOwnFile(path, sourceGuid, refused);
            foreach (string path in rimPaths)
                if (path != null)
                    CheckOwnFile(path, sourceGuid, refused);
            CheckOwnAsset(assetPath, dataPath, refused);
            foreach (BoneBurstBakeSettings.Variant variant in settings.Variants)
                CheckOwnAsset(VariantPath(settings, variant), dataPath, refused);

            if (texturePaths.Distinct().Count() != texturePaths.Length)
                refused.Add("two atlas pages have the same file name");

            if (refused.Count > 0)
                return new Result { Error = "Nothing was written:\n- " + string.Join("\n- ", refused) };

            // 3. Write.
            string previousDigest = ReadRecord(dataPath)?.Digest;
            string digestHex = BitConverter.ToString(digest).Replace("-", "");
            EnsureFolder(settings.OutputFolder);
            Record record = new()
            {
                Marker = Marker, Source = sourceGuid, Digest = digestHex,
                MaxTextureSize = (int)settings.MaxTextureSize, CompressTextures = settings.CompressTextures
            };

            File.WriteAllBytes(dataPath, data);
            AssetDatabase.ImportAsset(dataPath, ImportAssetOptions.ForceUpdate);
            WriteRecord(dataPath, record);
            AssetDatabase.SetLabels(AssetDatabase.LoadAssetAtPath<Object>(dataPath), new[] { DataLabel });

            long textureBefore = 0, textureAfter = 0;
            for (int i = 0; i < texturePaths.Length; i++)
            {
                CopyTexture(source.Pages[i], texturePaths[i], atlas.Pages[i], settings, record);
                if (rimPaths[i] != null)
                {
                    CopyRimMask(rimSources[i], rimPaths[i], atlas.Pages[i], settings, record);
                    textureBefore += TextureBytes(AssetDatabase.LoadAssetAtPath<Texture2D>(rimSources[i]));
                    textureAfter += TextureBytes(AssetDatabase.LoadAssetAtPath<Texture2D>(rimPaths[i]));
                }

                textureBefore += TextureBytes(AssetDatabase.LoadAssetAtPath<Texture2D>(source.Pages[i]));
                textureAfter += TextureBytes(AssetDatabase.LoadAssetAtPath<Texture2D>(texturePaths[i]));
            }

            // Everything the asset points at is an AssetSystem reference: the data, every page, the shader.
            int indexed = 0, notAddressable = 0;
            IndexGenericAsset dataReference = ReferenceTo(dataPath, AssetTypeCodes.TextAsset, ref indexed,
                ref notAddressable);
            IndexGenericAsset[] pageReferences = new IndexGenericAsset[texturePaths.Length];
            for (int i = 0; i < texturePaths.Length; i++)
                pageReferences[i] = ReferenceTo(texturePaths[i], AssetTypeCodes.Texture, ref indexed,
                    ref notAddressable);

            IndexGenericAsset[] rimReferences = new IndexGenericAsset[texturePaths.Length];
            int rimMasks = 0;
            for (int i = 0; i < texturePaths.Length; i++)
            {
                if (rimPaths[i] == null) continue;
                rimReferences[i] = ReferenceTo(rimPaths[i], AssetTypeCodes.Texture, ref indexed, ref notAddressable);
                rimMasks++;
            }

            BoneBurstAsset asset = WriteAsset(assetPath, dataReference, pageReferences, rimReferences,
                settings.ShaderAsset, settings.TintBlack, settings, out bool created);
            List<string> variantLines = new();
            foreach (BoneBurstBakeSettings.Variant variant in settings.Variants)
            {
                string path = VariantPath(settings, variant);
                WriteAsset(path, dataReference, pageReferences, rimReferences,
                    BoneBurstBakeSettings.ShaderFor(variant.Shader), variant.TintBlack, settings,
                    out bool variantCreated);
                variantLines.Add($"\n  variant {(variantCreated ? "created" : "rebaked")} {path} " +
                                 $"({variant.Shader}{(variant.TintBlack ? ", tint black" : "")})");
            }

            AssetDatabase.SaveAssets();

            int keys = BoneBurstKeyTable.BuildEntries(skeleton).Length;
            long sourceSize = export.Length + atlasBytes.Length;
            string report =
                $"BoneBurst bake: {(created ? "created" : "rebaked")} {assetPath}\n" +
                $"  data {sourceSize:N0} B ({(source.IsBinary ? "skel" : "json")} + atlas) -> {data.Length:N0} B ({100.0 * data.Length / sourceSize:F0}%)\n" +
                $"  textures {textureBefore / 1024:N0} KB -> {textureAfter / 1024:N0} KB (GPU size of the imported format, all mips)\n" +
                $"  shader {(settings.ShaderAsset != null ? settings.ShaderAsset.name : "BoneBurst/Unlit")}\n" +
                $"  AssetSystem references: data, {pageReferences.Length} pages, {rimMasks} rim mask(s); " +
                $"keys {indexed} indexed, {notAddressable} not addressable" +
                (notAddressable > 0 ? " (ints stay -1 until those files join an Addressables group)" : "") + "\n" +
                $"  {skeleton.Bones.Length} bones, {skeleton.Slots.Length} slots, {skeleton.Skins.Length} skins, " +
                $"{skeleton.Animations.Length} animations, {keys} keys, scale {settings.Scale}" +
                string.Concat(variantLines) +
                (previousDigest == digestHex ? "\n  the export is unchanged since the last bake" : "");
            return new Result { Asset = asset, Report = report };
        }

        /// <summary>
        ///     Creates the asset at <paramref name="path" />, or updates the one there in place so its GUID survives
        ///     (already checked to be ours).
        /// </summary>
        private static BoneBurstAsset WriteAsset(string path, IndexGenericAsset data, IndexGenericAsset[] pages,
            IndexGenericAsset[] rimMasks, Shader shader, bool tintBlack, BoneBurstBakeSettings s,
            out bool created)
        {
            BoneBurstAsset asset = AssetDatabase.LoadAssetAtPath<BoneBurstAsset>(path);
            created = asset == null;
            if (created) asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            asset.SetData(data);
            asset.SetPages(pages);
            asset.SetShader(shader);
            asset.SetRimMasks(rimMasks);
            asset.TintBlack = tintBlack;
            asset.DefaultMix = s.DefaultMix;
            asset.Mixes = (BoneBurstAsset.MixPair[])s.Mixes.Clone();
            if (created) AssetDatabase.CreateAsset(asset, path);
            else EditorUtility.SetDirty(asset);
            return asset;
        }

        private static string CheckSettings(Source source, BoneBurstBakeSettings s)
        {
            if (source == null) return "no export folder.";
            if (string.IsNullOrWhiteSpace(s.Name) || s.Name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                s.Name != s.Name.Trim())
                return $"'{s.Name}' is not a usable file name.";

            string output = s.OutputFolder?.Replace('\\', '/').TrimEnd('/');
            s.OutputFolder = output;
            if (string.IsNullOrEmpty(output) || !(output == "Assets" || output.StartsWith("Assets/")))
                return $"the output folder '{output}' must be inside Assets/.";

            if (output == source.Folder) return "the output folder must not be the export folder.";
            if (!(s.Scale > 0) || float.IsInfinity(s.Scale)) return $"scale {s.Scale} must be greater than 0.";
            if (!(s.DefaultMix >= 0)) return $"default mix {s.DefaultMix} must be 0 or more.";
            s.Variants ??= Array.Empty<BoneBurstBakeSettings.Variant>();
            HashSet<string> suffixes = new(StringComparer.OrdinalIgnoreCase);
            foreach (BoneBurstBakeSettings.Variant variant in s.Variants)
            {
                if (string.IsNullOrWhiteSpace(variant.Suffix) || variant.Suffix != variant.Suffix.Trim() ||
                    variant.Suffix.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                    return $"variant suffix '{variant.Suffix}' is not usable in a file name.";

                if (!suffixes.Add(variant.Suffix)) return $"two variants have the suffix '{variant.Suffix}'.";
            }

            return null;
        }

        private static string CheckContent(SkeletonDef skeleton, AtlasDef atlas, Source source, BoneBurstBakeSettings s)
        {
            if (skeleton.Bones == null || skeleton.Bones.Length == 0) return $"{source.Export} has no bones.";
            if (atlas.Pages.Count != source.Pages.Length) return $"{source.Atlas} changed while baking.";
            HashSet<string> animations = new(skeleton.Animations.Select(a => a.Name));
            foreach (BoneBurstAsset.MixPair mix in s.Mixes)
            foreach (string name in new[] { mix.From, mix.To })
                if (!animations.Contains(name))
                    return $"mix '{mix.From}' -> '{mix.To}': '{name}' is not an animation. " +
                           $"Animations: {string.Join(", ", animations)}.";

            return null;
        }

        /// <summary>
        ///     A target file is free, or was written by a bake of this same export. Loaded as <c>Object</c> so a file
        ///     of another type is refused, not mistaken for nothing (<c>CLAUDE.md</c> §6).
        /// </summary>
        private static void CheckOwnFile(string path, string sourceGuid, List<string> refused)
        {
            if (AssetDatabase.LoadAssetAtPath<Object>(path) == null && !File.Exists(path)) return;
            Record record = ReadRecord(path);
            if (record == null)
                refused.Add($"{path} already exists and was not made by a BoneBurst bake");
            else if (record.Source != sourceGuid)
                refused.Add($"{path} was baked from another export ({AssetDatabase.GUIDToAssetPath(record.Source)})");
        }

        private static void CheckOwnAsset(string path, string dataPath, List<string> refused)
        {
            Object existing = AssetDatabase.LoadAssetAtPath<Object>(path);
            if (existing == null)
            {
                if (File.Exists(path)) refused.Add($"{path} exists but is not a loadable asset");
                return;
            }

            if (!(existing is BoneBurstAsset asset))
            {
                refused.Add($"{path} is a {existing.GetType().Name}, not a BoneBurstAsset");
                return;
            }

            string existingData = DataPathOf(asset);
            if (existingData != null && existingData != dataPath)
                refused.Add($"{path} uses other data ({existingData})");
        }

        private static Record ReadRecord(string path)
        {
            AssetImporter importer = AssetImporter.GetAtPath(path);
            if (importer == null || string.IsNullOrEmpty(importer.userData)) return null;
            try
            {
                Record record = JsonUtility.FromJson<Record>(importer.userData);
                return record != null && record.Marker == Marker ? record : null;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        private static void WriteRecord(string path, Record record)
        {
            AssetImporter importer = AssetImporter.GetAtPath(path);
            importer.userData = JsonUtility.ToJson(record);
            importer.SaveAndReimport();
        }

        private static void CopyTexture(string from, string to, AtlasPageDef page, BoneBurstBakeSettings s,
            Record record)
        {
            if (AssetDatabase.LoadAssetAtPath<Object>(to) == null)
            {
                if (!AssetDatabase.CopyAsset(from, to)) throw new IOException($"could not copy {from} to {to}");
            }
            else
            {
                // Ours (checked before writing): new pixels, same .meta, so the GUID and references survive.
                File.Copy(from, to, true);
                AssetDatabase.ImportAsset(to, ImportAssetOptions.ForceUpdate);
            }

            TextureImporter importer = (TextureImporter)AssetImporter.GetAtPath(to);
            importer.textureType = TextureImporterType.Default;
            importer.sRGBTexture = true;
            importer.alphaIsTransparency = !page.Pma;
            importer.mipmapEnabled = false;
            importer.isReadable = false;
            importer.npotScale = TextureImporterNPOTScale.None;
            importer.wrapMode = page.RepeatU || page.RepeatV ? TextureWrapMode.Repeat : TextureWrapMode.Clamp;
            importer.filterMode = page.MagFilter == "Nearest" ? FilterMode.Point : FilterMode.Bilinear;
            importer.maxTextureSize = s.MaxTextureSize != BoneBurstBakeSettings.TextureSize.Auto
                ? (int)s.MaxTextureSize
                : Mathf.Clamp(Mathf.NextPowerOfTwo(Mathf.Max(page.Width, page.Height)), 32, 16384);
            importer.textureCompression = s.CompressTextures
                ? TextureImporterCompression.Compressed
                : TextureImporterCompression.Uncompressed;
            importer.crunchedCompression = false;
            importer.userData = JsonUtility.ToJson(new Record { Marker = Marker, Source = record.Source });
            importer.SaveAndReimport();
        }

        /// <summary>
        ///     A page's painted rim mask: one linear channel (R, BC4 when compressed), imported at half the page's size
        ///     (a mask can be soft; the shader samples it with the page's UV, so any size lines up). Ownership is
        ///     checked before writing, like a page.
        /// </summary>
        private static void CopyRimMask(string from, string to, AtlasPageDef page, BoneBurstBakeSettings s,
            Record record)
        {
            if (AssetDatabase.LoadAssetAtPath<Object>(to) == null)
            {
                if (!AssetDatabase.CopyAsset(from, to)) throw new IOException($"could not copy {from} to {to}");
            }
            else
            {
                File.Copy(from, to, true);
                AssetDatabase.ImportAsset(to, ImportAssetOptions.ForceUpdate);
            }

            TextureImporter importer = (TextureImporter)AssetImporter.GetAtPath(to);
            importer.textureType = TextureImporterType.SingleChannel;
            TextureImporterSettings channel = new();
            importer.ReadTextureSettings(channel);
            channel.singleChannelComponent = TextureImporterSingleChannelComponent.Red;
            importer.SetTextureSettings(channel);
            importer.sRGBTexture = false;
            importer.alphaIsTransparency = false;
            importer.mipmapEnabled = false;
            importer.isReadable = false;
            importer.npotScale = TextureImporterNPOTScale.None;
            importer.wrapMode = TextureWrapMode.Clamp;
            importer.filterMode = FilterMode.Bilinear;
            int pageSize = s.MaxTextureSize != BoneBurstBakeSettings.TextureSize.Auto
                ? (int)s.MaxTextureSize
                : Mathf.Clamp(Mathf.NextPowerOfTwo(Mathf.Max(page.Width, page.Height)), 32, 16384);
            importer.maxTextureSize = Mathf.Max(32, pageSize / 2);
            importer.textureCompression = s.CompressTextures
                ? TextureImporterCompression.Compressed
                : TextureImporterCompression.Uncompressed;
            importer.crunchedCompression = false;
            importer.userData = JsonUtility.ToJson(new Record { Marker = Marker, Source = record.Source });
            importer.SaveAndReimport();
        }

        /// <summary>
        ///     The texture's size on the GPU as imported for this platform: every mip of its format. Computed, not
        ///     measured: the profiler's runtime size is not settled right after a reimport.
        /// </summary>
        private static long TextureBytes(Texture2D texture)
        {
            if (texture == null) return 0;
            long bytes = 0;
            for (int mip = 0; mip < texture.mipmapCount; mip++)
                bytes += GraphicsFormatUtility.ComputeMipmapSize(Mathf.Max(1, texture.width >> mip),
                    Mathf.Max(1, texture.height >> mip), texture.graphicsFormat);

            return bytes;
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            string parent = Path.GetDirectoryName(folder)?.Replace('\\', '/');
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(folder));
        }

        /// <summary>
        ///     A Spine export folder, checked: one skeleton export (a <c>.json</c>, or else a binary
        ///     <c>.skel.bytes</c>), one atlas, and every page the atlas names.
        /// </summary>
        public sealed class Source
        {
            public string Folder, Export, Atlas;

            /// <summary>
            ///     Page texture paths, in the atlas's page order.
            /// </summary>
            public string[] Pages;

            /// <summary>
            ///     The painted rim mask beside each page, <c>&lt;page&gt;_rim.png</c> (R channel), or null where there
            ///     is none; parallel to <see cref="Pages" />.
            /// </summary>
            public string[] RimMasks => Pages.Select(RimMaskOf).ToArray();

            public string Guid => AssetDatabase.AssetPathToGUID(Folder);

            /// <summary>
            ///     Whether <see cref="Export" /> is Spine's binary format.
            /// </summary>
            public bool IsBinary => Export.EndsWith(BinaryExtension, StringComparison.OrdinalIgnoreCase);

            public string BaseName => IsBinary
                ? Path.GetFileName(Export).Substring(0, Path.GetFileName(Export).Length - BinaryExtension.Length)
                : Path.GetFileNameWithoutExtension(Export);
        }

        /// <summary>
        ///     What a bake wrote, or why it wrote nothing.
        /// </summary>
        public sealed class Result
        {
            public BoneBurstAsset Asset;
            public string Error;
            public string Report;
            public bool Ok => Error == null;
        }

        /// <summary>
        ///     Kept in the importer <c>userData</c> of every file a bake writes, so a rebake can tell its own files
        ///     from anyone else's.
        /// </summary>
        [Serializable]
        private sealed class Record
        {
            public string Marker;
            public string Source;
            public string Digest;
            public int MaxTextureSize;
            public bool CompressTextures;
        }
    }
}