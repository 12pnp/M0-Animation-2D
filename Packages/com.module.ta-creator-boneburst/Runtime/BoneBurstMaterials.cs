using UnityEngine;
using BlendMode = BoneBurst.Data.BlendMode;

namespace BoneBurst
{
    /// <summary>
    ///     Material setup for the <c>BoneBurst/Unlit</c> and <c>BoneBurst/Lit2D</c> shaders, per blend mode,
    ///     texture alpha workflow and tint black.
    /// </summary>
    /// <remarks>
    ///     Output is always premultiplied (<c>Doc/Format/Pose-and-Mesh.md</c> §8): Normal and Additive share
    ///     <c>One, OneMinusSrcAlpha</c> (additive comes from vertex alpha 0), Multiply and Screen get their own
    ///     factors. A texture exported without premultiplied alpha sets <c>_StraightAlphaInput</c>, a material-uniform
    ///     branch that premultiplies in the shader. <c>_TINT_BLACK_ON</c> and <c>BONE_BURST_GPU</c> are
    ///     <c>multi_compile</c>: these materials are created at runtime, and a <c>shader_feature</c> variant no
    ///     material asset uses is stripped from player builds.
    /// </remarks>
    public static class BoneBurstMaterials
    {
        /// <summary>
        ///     The shader variant that skins on the GPU (<c>Doc/Format/GpuSkinning.md</c>).
        /// </summary>
        public const string GpuKeyword = "BONE_BURST_GPU";

        /// <summary>
        ///     The shader variant that reads CPU-skinned vertices from <c>_BoneBurstFetchVertices</c>
        ///     (<see cref="BoneBurstFetch" />).
        /// </summary>
        public const string FetchKeyword = "BONE_BURST_FETCH";

        private static readonly int s_SrcBlend = Shader.PropertyToID("_SrcBlend");
        private static readonly int s_DstBlend = Shader.PropertyToID("_DstBlend");
        private static readonly int s_StraightAlpha = Shader.PropertyToID("_StraightAlphaInput");
        private static readonly int s_TintBlack = Shader.PropertyToID("_TintBlack");

        public static void Configure(Material material, BlendMode blend, bool premultipliedTexture,
            bool tintBlack = false,
            bool gpuSkinning = false, bool vertexFetch = false)
        {
            if (gpuSkinning) material.EnableKeyword(GpuKeyword);
            else material.DisableKeyword(GpuKeyword);
            if (vertexFetch && !gpuSkinning) material.EnableKeyword(FetchKeyword);
            else material.DisableKeyword(FetchKeyword);
            material.SetFloat(s_TintBlack, tintBlack ? 1 : 0);
            if (tintBlack) material.EnableKeyword("_TINT_BLACK_ON");
            else material.DisableKeyword("_TINT_BLACK_ON");
            (UnityEngine.Rendering.BlendMode src, UnityEngine.Rendering.BlendMode dst) = blend switch
            {
                BlendMode.Multiply => (UnityEngine.Rendering.BlendMode.DstColor,
                    UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha),
                BlendMode.Screen => (UnityEngine.Rendering.BlendMode.One,
                    UnityEngine.Rendering.BlendMode.OneMinusSrcColor),
                _ => (UnityEngine.Rendering.BlendMode.One, UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha)
            };
            material.SetFloat(s_SrcBlend, (float)src);
            material.SetFloat(s_DstBlend, (float)dst);
            material.SetFloat(s_StraightAlpha, premultipliedTexture ? 0 : 1);
        }
    }
}