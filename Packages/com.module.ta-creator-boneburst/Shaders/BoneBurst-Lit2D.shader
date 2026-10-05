// BoneBurst skeleton shader lit by the URP 2D Renderer's lights (Light 2D): texture × vertex colour × light.
// Same material setup as BoneBurst/Unlit (BoneBurstMaterials.Configure: blend factors, straight alpha, tint
// black, GPU skinning), so an asset switches by assigning this shader. Without the 2D Renderer it draws unlit.
Shader "BoneBurst/Lit2D"
{
    Properties
    {
        [NoScaleOffset] _MainTex ("Atlas Page", 2D) = "white" {}
        [NoScaleOffset] _MaskTex ("Light Mask", 2D) = "white" {}
        [NoScaleOffset] _RimMaskTex ("Rim Mask (R, page-aligned, any size; white = everywhere)", 2D) = "white" {}
        _RimColor ("Rim Color", Color) = (1, 1, 1, 1)
        _RimStrength ("Rim Strength (0 = off)", Range(0, 4)) = 0
        _RimWidth ("Rim Width (atlas texels)", Range(0.5, 4)) = 1.5
        _RimDirection ("Rim Light Direction (world XY)", Vector) = (-0.7, 0.7, 0, 0)
        [ToggleUI] _StraightAlphaInput ("Straight Alpha Texture", Float) = 0
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
            #pragma multi_compile_local _ _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU BONE_BURST_FETCH
            #pragma target 4.5 BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_FETCH
            // shader_feature: set only on a material asset (the inspector toggle); runtime materials never turn it on.
            #pragma shader_feature_local _LIGHT_AFFECTS_ADDITIVE
            #include "Packages/com.module.ta-creator-boneburst/Shaders/BoneBurstLit2DPass.hlsl"
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
            #pragma multi_compile_local _ _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU BONE_BURST_FETCH
            #pragma target 4.5 BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_FETCH
            #include "Packages/com.module.ta-creator-boneburst/Shaders/BoneBurstLit2DPass.hlsl"
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
            #pragma multi_compile_local _ _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU BONE_BURST_FETCH
            #pragma target 4.5 BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_FETCH
            #include "Packages/com.module.ta-creator-boneburst/Shaders/BoneBurstUnlitPass.hlsl"
            ENDHLSL
        }
    }
    Fallback "BoneBurst/Unlit"
}
