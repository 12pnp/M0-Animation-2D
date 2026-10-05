using System;
using UnityEngine;

namespace BoneBurst.Editor
{
    /// <summary>
    ///     What one bake of a Spine export folder produces: the name, where it goes, and how it loads and renders.
    ///     A transient object the bake popup edits; never saved as an asset. A rebake rebuilds it from the previous
    ///     output (<see cref="BoneBurstBake.SettingsFor" />).
    /// </summary>
    public sealed class BoneBurstBakeSettings : ScriptableObject
    {
        public enum ShaderChoice
        {
            Unlit,
            Lit2D
        }

        /// <summary>
        ///     Largest texture size on import. Auto: the atlas page's own size, rounded up to a power of two.
        /// </summary>
        public enum TextureSize
        {
            Auto = 0,
            Size256 = 256,
            Size512 = 512,
            Size1024 = 1024,
            Size2048 = 2048,
            Size4096 = 4096,
            Size8192 = 8192
        }

        [Tooltip("Base name of every output file: <name>.sbdata.bytes, <name>_BoneBurst.asset.")]
        public string Name;

        [Tooltip("Folder under Assets/ that receives the output. Must not be the export folder.")]
        public string OutputFolder;

        [Tooltip("Multiplies every position. 0.01 turns Spine pixels into Unity units, as spine-unity does.")]
        public float Scale = 0.01f;

        [Tooltip("Unlit, or Lit2D (lit by URP 2D lights).")]
        public ShaderChoice Shader = ShaderChoice.Unlit;

        [Tooltip("Two-colour tinting: slots' dark colours reach the shader (spine-unity's Tint Black).")]
        public bool TintBlack;

        [Tooltip("Crossfade duration when switching animations. 0.2 matches spine-unity's import default.")]
        public float DefaultMix = 0.2f;

        [Tooltip("Crossfade durations for specific animation pairs.")]
        public BoneBurstAsset.MixPair[] Mixes = Array.Empty<BoneBurstAsset.MixPair>();

        [Tooltip("Largest size the page textures import at.")]
        public TextureSize MaxTextureSize = TextureSize.Auto;

        [Tooltip("Compress the page textures (the platform's default format). Off: RGBA32, four bytes per pixel.")]
        public bool CompressTextures = true;

        [Tooltip("More assets sharing this bake's data and textures, each with its own shader and tint black " +
                 "(for example a Lit2D one).")]
        public Variant[] Variants = Array.Empty<Variant>();

        /// <summary>
        ///     The shader asset for <see cref="Shader" />.
        /// </summary>
        public Shader ShaderAsset => ShaderFor(Shader);

        public static Shader ShaderFor(ShaderChoice choice)
        {
            return UnityEngine.Shader.Find(choice == ShaderChoice.Lit2D ? "BoneBurst/Lit2D" : "BoneBurst/Unlit");
        }

        public static ShaderChoice ChoiceOf(Shader shader)
        {
            return shader != null && shader.name == "BoneBurst/Lit2D" ? ShaderChoice.Lit2D : ShaderChoice.Unlit;
        }

        /// <summary>
        ///     One more <see cref="BoneBurstAsset" /> beside the main one, rendering the same data and textures
        ///     another way: <c>&lt;name&gt;_BoneBurst_&lt;suffix&gt;.asset</c>.
        /// </summary>
        [Serializable]
        public struct Variant
        {
            [Tooltip("File name suffix: <name>_BoneBurst_<suffix>.asset.")]
            public string Suffix;

            public ShaderChoice Shader;
            public bool TintBlack;
        }
    }
}