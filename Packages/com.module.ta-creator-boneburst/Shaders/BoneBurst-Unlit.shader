// BoneBurst unlit skeleton shader: texture × vertex colour, one material per atlas page and blend mode.
// SRP Batcher compatible (all material properties in UnityPerMaterial). Blend factors come from the material,
// set by BoneBurstMaterials.Configure, so one shader serves Normal, Additive, Multiply and Screen.
// BONE_BURST_GPU (set on separate materials) skins in the vertex shader: Doc/Format/GpuSkinning.md.
// Keywords set from C# on runtime materials are multi_compile (a shader_feature variant no material asset uses is
// stripped from player builds); straight alpha is a material-uniform branch on _StraightAlphaInput, no variant.
Shader "BoneBurst/Unlit"
{
    Properties
    {
        [NoScaleOffset] _MainTex ("Atlas Page", 2D) = "white" {}
        [ToggleUI] _StraightAlphaInput ("Straight Alpha Texture", Float) = 0
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
            #pragma multi_compile_local _ _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU BONE_BURST_FETCH
            #pragma target 4.5 BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_FETCH
            #include "Packages/com.module.ta-creator-boneburst/Shaders/BoneBurstUnlitPass.hlsl"
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
            #pragma multi_compile_local _ _TINT_BLACK_ON
            #pragma multi_compile_local _ BONE_BURST_GPU BONE_BURST_FETCH
            #pragma target 4.5 BONE_BURST_GPU
            #pragma target 4.5 BONE_BURST_FETCH
            #include "Packages/com.module.ta-creator-boneburst/Shaders/BoneBurstUnlitPass.hlsl"
            ENDHLSL
        }
    }
}
