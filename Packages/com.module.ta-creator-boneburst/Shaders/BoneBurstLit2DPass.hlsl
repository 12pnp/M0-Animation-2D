#ifndef BONEBURST_LIT2D_PASS_INCLUDED
#define BONEBURST_LIT2D_PASS_INCLUDED

// URP 2D Renderer lighting for BoneBurst meshes (Doc/Format/Skins-TintBlack-Culling.md §3.2): the colour is
// lit in straight alpha by URP's CombinedShapeLightShared, then premultiplied again for the One/OneMinusSrcAlpha
// blend. The 2D Renderer binds the light textures and turns the USE_SHAPE_LIGHT_TYPE_n keywords on.

#include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/Core2D.hlsl"
#include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/CombinedShapeLightShared.hlsl"
#include "Packages/com.module.ta-creator-boneburst/Shaders/BoneBurstCommon.hlsl"

TEXTURE2D(_MaskTex);
SAMPLER(sampler_MaskTex);
TEXTURE2D(_RimMaskTex);
SAMPLER(sampler_RimMaskTex);

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
    float2 positionWS : TEXCOORD3;
};

// Rim light (Doc/Review/BoneBurst-RimLight-Plan.md, option B): the pixel is near the outline on the side facing
// _RimDirection when the atlas alpha just past it, in that direction, is transparent. The world direction is mapped
// into atlas UV through the screen derivatives of UV and world position, so rotated atlas regions, bones and flips
// need nothing; the step is _RimWidth atlas texels whatever the zoom, which keeps it inside the atlas padding. Three
// samples along the step give how close the edge is (0 deep inside, 1 at the edge), times the painted mask.
// Straight colour, added after lighting, so the rim stays bright in shadow.
half3 BoneBurstRim(float2 uv, float2 positionWS)
{
    float2 uvX = ddx(uv), uvY = ddy(uv), wX = ddx(positionWS), wY = ddy(positionWS);
    if (_RimStrength <= 0) return 0;
    float det = wX.x * wY.y - wX.y * wY.x;
    float2 direction = _RimDirection.xy;
    if (abs(det) < 1e-12 || dot(direction, direction) < 1e-8) return 0;
    direction = normalize(direction);
    // Screen-pixel coordinates of one world step along the direction, then the UV that step covers.
    float2 screen = float2(wY.y * direction.x - wY.x * direction.y, -wX.y * direction.x + wX.x * direction.y) / det;
    float2 uvStep = uvX * screen.x + uvY * screen.y;
    float texels = length(uvStep * _MainTex_TexelSize.zw);
    if (texels < 1e-6) return 0;
    uvStep *= _RimWidth / texels;
    half outside = (1 - SAMPLE_TEXTURE2D_GRAD(_MainTex, sampler_MainTex, uv + uvStep * 0.34, uvX, uvY).a)
                 + (1 - SAMPLE_TEXTURE2D_GRAD(_MainTex, sampler_MainTex, uv + uvStep * 0.67, uvX, uvY).a)
                 + (1 - SAMPLE_TEXTURE2D_GRAD(_MainTex, sampler_MainTex, uv + uvStep, uvX, uvY).a);
    // The painted rim mask (R, the page's layout at any resolution): the artist keeps the silhouette and drops the
    // inner attachment edges the alpha test cannot tell apart (Doc/Review/BoneBurst-TextureSplit-Plan.md §5).
    half mask = SAMPLE_TEXTURE2D_GRAD(_RimMaskTex, sampler_RimMaskTex, uv, uvX, uvY).r;
    half edge = saturate(outside / 3) * mask;
    if (edge <= 0) return 0;
    return _RimColor.rgb * (_RimColor.a * _RimStrength * edge);
}

Varyings LitVert(Attributes input)
{
    Varyings output;
    BONE_BURST_VERTEX_INPUTS(input, position, vertexColor, tint)
    output.positionCS = TransformObjectToHClip(position);
    output.positionWS = TransformObjectToWorld(position).xy;
    output.uv = BONE_BURST_UV(input);
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
    if (!BoneBurstStraightAlpha())
    {
        texel.rgb = texel.a < 0.001 ? texel.rgb : texel.rgb / texel.a;
    }
    main = texel * input.color;
#endif
    half4 mask = SAMPLE_TEXTURE2D(_MaskTex, sampler_MaskTex, input.uv);
    SurfaceData2D surfaceData;
    InputData2D inputData;
    // Alpha 1 into the light combine: its discard on alpha 0 must not fire; alpha is applied below.
    InitializeSurfaceData(main.rgb, 1, mask, surfaceData);
    InitializeInputData(input.uv, input.lightingUV, inputData);
    half4 lit = CombinedShapeLightShared(surfaceData, inputData);
    lit.rgb += BoneBurstRim(input.uv, input.positionWS);
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
    output.uv = BONE_BURST_UV(input);
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
