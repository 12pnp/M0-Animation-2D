// TEST FIXTURE: the BoneBurst shaders as they were before 2026-09-29 (_TINT_BLACK_ON and _STRAIGHT_ALPHA_INPUT as
// shader_feature_local), kept only for KeywordVariantComparisonTests. Not used at runtime; delete with that test.
// BoneBurst skeleton shader lit by the URP 2D Renderer's lights (Light 2D): texture × vertex colour × light.
// Same material setup as BoneBurst/Unlit (BoneBurstMaterials.Configure: blend factors, straight alpha, tint
// black, GPU skinning), so an asset switches by assigning this shader. Without the 2D Renderer it draws unlit.
Shader "Hidden/BoneBurstTests/LegacyLit2D"
{
    Properties
    {
        [NoScaleOffset] _MainTex ("Atlas Page", 2D) = "white" {}
        [NoScaleOffset] _MaskTex ("Light Mask", 2D) = "white" {}
        [Toggle(_STRAIGHT_ALPHA_INPUT)] _StraightAlphaInput ("Straight Alpha Texture", Float) = 0
        [Toggle(_LIGHT_AFFECTS_ADDITIVE)] _LightAffectsAdditive ("Light Affects Additive Slots", Float) = 0
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

        Pass
        {
            Name "BoneBurstLit2D"
            Tags
            {
                "LightMode" = "Universal2D"
            }
            Blend [_SrcBlend] [_DstBlend]
            HLSLPROGRAM
            #pragma vertex LitVert
            #pragma fragment LitFrag
            #include_with_pragmas "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/ShapeLightShared.hlsl"
            #pragma shader_feature_local _STRAIGHT_ALPHA_INPUT
            #pragma shader_feature_local _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_GPU
            #pragma shader_feature_local _LIGHT_AFFECTS_ADDITIVE
            #include "Packages/com.module.ta-creator-boneburst/Tests/Editor/Render/LegacyShaders/Legacy-BoneBurstLit2DPass.hlsl"
            ENDHLSL
        }

        Pass
        {
            Name "BoneBurstNormals"
            Tags
            {
                "LightMode" = "NormalsRendering"
            }
            Blend SrcAlpha OneMinusSrcAlpha
            HLSLPROGRAM
            #pragma vertex NormalsVert
            #pragma fragment NormalsFrag
            #pragma shader_feature_local _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_GPU
            #include "Packages/com.module.ta-creator-boneburst/Tests/Editor/Render/LegacyShaders/Legacy-BoneBurstLit2DPass.hlsl"
            ENDHLSL
        }

        Pass
        {
            Name "BoneBurstUnlitForward"
            Tags
            {
                "LightMode" = "UniversalForward"
            }
            Blend [_SrcBlend] [_DstBlend]
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
    Fallback Off
}
