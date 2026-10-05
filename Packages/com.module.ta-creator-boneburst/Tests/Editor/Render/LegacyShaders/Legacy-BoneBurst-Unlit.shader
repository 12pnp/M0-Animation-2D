// TEST FIXTURE: the BoneBurst shaders as they were before 2026-09-29 (_TINT_BLACK_ON and _STRAIGHT_ALPHA_INPUT as
// shader_feature_local), kept only for KeywordVariantComparisonTests. Not used at runtime; delete with that test.
// BoneBurst unlit skeleton shader: texture × vertex colour, one material per atlas page and blend mode.
// SRP Batcher compatible (all material properties in UnityPerMaterial). Blend factors come from the material,
// set by BoneBurstMaterials.Configure, so one shader serves Normal, Additive, Multiply and Screen.
// BONE_BURST_GPU (set on separate materials) skins in the vertex shader: Doc/Format/GpuSkinning.md.
Shader "Hidden/BoneBurstTests/LegacyUnlit"
{
    Properties
    {
        [NoScaleOffset] _MainTex ("Atlas Page", 2D) = "white" {}
        [Toggle(_STRAIGHT_ALPHA_INPUT)] _StraightAlphaInput ("Straight Alpha Texture", Float) = 0
        [HideInInspector] _SrcBlend ("Src Blend", Float) = 1
        [HideInInspector] _DstBlend ("Dst Blend", Float) = 10
        [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull", Float) = 0
        [Toggle(_TINT_BLACK_ON)] _TintBlack ("Tint Black (asset option writes the dark colour)", Float) = 0
        _Color ("Tint (with tint black)", Color) = (1, 1, 1, 1)
        _Black ("Dark Color (with tint black)", Color) = (0, 0, 0, 0)
    }

    SubShader
    {
        Tags
        {
            "Queue" = "Transparent" "RenderType" = "Transparent" "IgnoreProjector" = "True" "RenderPipeline" = "UniversalPipeline"
        }
        Cull [_Cull]
        ZWrite Off
        Blend [_SrcBlend] [_DstBlend]

        Pass
        {
            Name "BoneBurstUnlit"
            Tags
            {
                "LightMode" = "Universal2D"
            }
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            #pragma shader_feature_local _STRAIGHT_ALPHA_INPUT
            #pragma shader_feature_local _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_GPU
            #include "Packages/com.module.ta-creator-boneburst/Tests/Editor/Render/LegacyShaders/Legacy-BoneBurstUnlitPass.hlsl"
            ENDHLSL
        }

        Pass
        {
            Name "BoneBurstUnlitForward"
            Tags
            {
                "LightMode" = "UniversalForward"
            }
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            #pragma shader_feature_local _STRAIGHT_ALPHA_INPUT
            #pragma shader_feature_local _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_GPU
            #include "Packages/com.module.ta-creator-boneburst/Tests/Editor/Render/LegacyShaders/Legacy-BoneBurstUnlitPass.hlsl"
            ENDHLSL
        }
    }
}
