#ifndef BONEBURST_LEGACY_LIT2D_PASS_INCLUDED
#define BONEBURST_LEGACY_LIT2D_PASS_INCLUDED

// URP 2D Renderer lighting for BoneBurst meshes (Doc/Format/Skins-TintBlack-Culling.md §3.2): the colour is
// lit in straight alpha by URP's CombinedShapeLightShared, then premultiplied again for the One/OneMinusSrcAlpha
// blend. The 2D Renderer binds the light textures and turns the USE_SHAPE_LIGHT_TYPE_n keywords on.

#include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/Core2D.hlsl"
#include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/CombinedShapeLightShared.hlsl"
#include "Packages/com.module.ta-creator-boneburst/Tests/Editor/Render/LegacyShaders/Legacy-BoneBurstCommon.hlsl"

TEXTURE2D(_MaskTex);
SAMPLER(sampler_MaskTex);

struct Attributes
{
    float3 positionOS : POSITION;
    half4 color : COLOR;
    float2 uv : TEXCOORD0;
    BONE_BURST_EXTRA_ATTRIBUTES
};

struct Varyings
{
    float4 positionCS : SV_POSITION;
    half4 color : COLOR;
    float2 uv : TEXCOORD0;
    half2 lightingUV : TEXCOORD1;
#if defined(_TINT_BLACK_ON)
    half3 dark : TEXCOORD2;
#endif
};

Varyings LitVert(Attributes input)
{
    Varyings output;
    BONE_BURST_VERTEX_INPUTS(input, position, vertexColor, tint)
    output.positionCS = TransformObjectToHClip(position);
    output.uv = input.uv;
    output.lightingUV = half2(ComputeScreenPos(output.positionCS / output.positionCS.w).xy);
    half4 color = BoneBurstVertexColor(vertexColor);
#if defined(_TINT_BLACK_ON)
    output.color = color * _Color;
    output.dark = BoneBurstDarkColor(tint.xy, tint.zw, vertexColor.a);
#else
    // Lighting works on straight colour.
    color.rgb = color.a == 0 ? color.rgb : color.rgb / color.a;
    output.color = color;
#endif
    return output;
}

half4 LitFrag(Varyings input) : SV_Target
{
    half4 texel = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, input.uv);
    half4 main;
#if defined(_TINT_BLACK_ON)
    main = BoneBurstTinted(texel, input.dark, input.color);
#if !defined(_LIGHT_AFFECTS_ADDITIVE)
    if (input.color.a == 0) return main; // additive slots stay unlit
#endif
    main.rgb = main.a < 0.001 ? main.rgb : main.rgb / main.a;
#else
#if !defined(_LIGHT_AFFECTS_ADDITIVE)
    if (input.color.a == 0) return texel * input.color;
#endif
#if !defined(_STRAIGHT_ALPHA_INPUT)
    texel.rgb = texel.a < 0.001 ? texel.rgb : texel.rgb / texel.a;
#endif
    main = texel * input.color;
#endif
    half4 mask = SAMPLE_TEXTURE2D(_MaskTex, sampler_MaskTex, input.uv);
    SurfaceData2D surfaceData;
    InputData2D inputData;
    // Alpha 1 into the light combine: its discard on alpha 0 must not fire; alpha is applied below.
    InitializeSurfaceData(main.rgb, 1, mask, surfaceData);
    InitializeInputData(input.uv, input.lightingUV, inputData);
    half4 lit = CombinedShapeLightShared(surfaceData, inputData);
    return half4(lit.rgb * main.a, main.a);
}

// NormalsRendering: a flat normal facing the camera, weighted by coverage (only matters with normal-map lights).
struct NormalsVaryings
{
    float4 positionCS : SV_POSITION;
    half4 color : COLOR;
    float2 uv : TEXCOORD0;
    half3 normalWS : TEXCOORD1;
};

NormalsVaryings NormalsVert(Attributes input)
{
    NormalsVaryings output;
    BONE_BURST_VERTEX_INPUTS(input, position, vertexColor, tint)
    output.positionCS = TransformObjectToHClip(position);
    output.uv = input.uv;
    output.color = vertexColor;
    output.normalWS = normalize(TransformObjectToWorldDir(float3(0, 0, -1)));
    return output;
}

half4 NormalsFrag(NormalsVaryings input) : SV_Target
{
    half4 c = input.color * SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, input.uv);
    return half4(0.5 * (input.normalWS + 1), c.a);
}

#endif
