#ifndef BONEBURST_LEGACY_UNLIT_PASS_INCLUDED
#define BONEBURST_LEGACY_UNLIT_PASS_INCLUDED

#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
#include "Packages/com.module.ta-creator-boneburst/Tests/Editor/Render/LegacyShaders/Legacy-BoneBurstCommon.hlsl"

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
#if defined(_TINT_BLACK_ON)
    half3 dark : TEXCOORD1;
#endif
};

Varyings Vert(Attributes input)
{
    Varyings output;
    BONE_BURST_VERTEX_INPUTS(input, position, vertexColor, tint)
    output.positionCS = TransformObjectToHClip(position);
    output.color = BoneBurstVertexColor(vertexColor);
#if defined(_TINT_BLACK_ON)
    output.color *= _Color;
    output.dark = BoneBurstDarkColor(tint.xy, tint.zw, vertexColor.a);
#endif
    output.uv = input.uv;
    return output;
}

half4 Frag(Varyings input) : SV_Target
{
    half4 texel = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, input.uv);
#if defined(_TINT_BLACK_ON)
    return BoneBurstTinted(texel, input.dark, input.color);
#else
#if defined(_STRAIGHT_ALPHA_INPUT)
    texel.rgb *= texel.a;
#endif
    // Vertex colours are premultiplied, so texel × colour stays premultiplied.
    return texel * input.color;
#endif
}

#endif
