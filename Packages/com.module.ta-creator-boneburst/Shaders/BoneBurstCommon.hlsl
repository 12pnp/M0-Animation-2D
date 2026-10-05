#ifndef BONEBURST_COMMON_INCLUDED
#define BONEBURST_COMMON_INCLUDED

// Shared by BoneBurst/Unlit and BoneBurst/Lit2D (Doc/Format/Skins-TintBlack-Culling.md §2.3, §3.2).
// Vertex colours are premultiplied gamma-space bytes (spine-unity's convention). Tint black arrives as
// uv2 = (dark.r·α, dark.g·α), uv3 = (dark.b·α, ·), written by the mesh builder when the asset enables it (with
// GPU skinning, read from the pose record instead).

// SRGBToLinear: URP's Core.hlsl does not include the core Color library.
#include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Color.hlsl"

TEXTURE2D(_MainTex);
SAMPLER(sampler_MainTex);

CBUFFER_START(UnityPerMaterial)
    float _StraightAlphaInput;
    float _SrcBlend;
    float _DstBlend;
    float _Cull;
    half4 _Color;
    half4 _Black;
    // Rim light (BoneBurst/Lit2D only; Doc/Review/BoneBurst-RimLight-Plan.md). Declared here so every variant of
    // both shaders keeps one UnityPerMaterial layout, as the SRP Batcher requires; Unlit never reads them.
    float4 _MainTex_TexelSize;
    half4 _RimColor;
    float _RimStrength;
    float _RimWidth;
    float4 _RimDirection;
CBUFFER_END

// Straight-alpha atlas pages: a material-uniform branch, not a keyword, so runtime materials need no variant.
bool BoneBurstStraightAlpha()
{
    return _StraightAlphaInput > 0.5;
}

// GPU skinning (Doc/Format/GpuSkinning.md): the static mesh carries local positions and, in TEXCOORD3,
// (first influence, influence count, bone, slot record); the renderer's shader user value is the base of this
// instance's pose record in _BoneBurstPose. The arithmetic matches MeshBuilder.Write term for term.
#if defined(BONE_BURST_GPU)
StructuredBuffer<float4> _BoneBurstPose;
StructuredBuffer<float4> _BoneBurstInfluences;

void BoneBurstSkin(float4 skin, inout float3 position, out half4 color, out float4 tint)
{
    uint poseBase = unity_RendererUserValue;
    uint count = (uint)skin.y;
    float2 world;
    if (count == 0)
    {
        uint bone = poseBase + 2 * (uint)skin.z;
        float4 m = _BoneBurstPose[bone];
        float4 t = _BoneBurstPose[bone + 1];
        world = float2(position.x * m.x + position.y * m.y + t.x, position.x * m.z + position.y * m.w + t.y);
    }
    else
    {
        world = float2(0, 0);
        uint first = (uint)skin.x;
        for (uint i = 0; i < count; i++)
        {
            float4 influence = _BoneBurstInfluences[first + i];
            uint bone = poseBase + 2 * (uint)influence.w;
            float4 m = _BoneBurstPose[bone];
            float4 t = _BoneBurstPose[bone + 1];
            world.x += (influence.x * m.x + influence.y * m.y + t.x) * influence.z;
            world.y += (influence.x * m.z + influence.y * m.w + t.y) * influence.z;
        }
    }

    position.xy = world;
    uint slot = poseBase + (uint)skin.w;
    color = half4(_BoneBurstPose[slot]);
#if defined(_TINT_BLACK_ON)
    tint = _BoneBurstPose[slot + 1];
#else
    tint = float4(0, 0, 0, 0);
#endif
}

#define BONE_BURST_EXTRA_ATTRIBUTES float4 skin : TEXCOORD3;
#define BONE_BURST_VERTEX_INPUTS(input, positionVar, colorVar, tintVar) \
    float3 positionVar = input.positionOS; half4 colorVar; float4 tintVar; \
    BoneBurstSkin(input.skin, positionVar, colorVar, tintVar);
#define BONE_BURST_UV(input) input.uv
#elif defined(BONE_BURST_FETCH)
// CPU skinning, GPU vertex fetch (Doc/Format/CpuVertexFetch.md): the CPU mesh's vertices, written by MeshJob
// into one shared buffer; this instance's first vertex is unity_RendererUserValue. The layout is SkeletonVertex:
// float3 position, Color32 (R in the low byte), float2 uv. The Mesh carries only the topology.
struct BoneBurstFetchVertex
{
    float3 position;
    uint color;
    float2 uv;
};

StructuredBuffer<BoneBurstFetchVertex> _BoneBurstFetchVertices;
#if defined(_TINT_BLACK_ON)
StructuredBuffer<float4> _BoneBurstFetchTint;
#define BONE_BURST_FETCH_TINT(index) _BoneBurstFetchTint[index]
#else
#define BONE_BURST_FETCH_TINT(index) float4(0, 0, 0, 0)
#endif

half4 BoneBurstUnpackColor(uint c)
{
    return half4(float4(c & 255u, (c >> 8) & 255u, (c >> 16) & 255u, c >> 24) / 255.0);
}

#define BONE_BURST_EXTRA_ATTRIBUTES uint vertexID : SV_VertexID;
#define BONE_BURST_VERTEX_INPUTS(input, positionVar, colorVar, tintVar) \
    uint boneBurstIndex = unity_RendererUserValue + input.vertexID; \
    BoneBurstFetchVertex boneBurstVertex = _BoneBurstFetchVertices[boneBurstIndex]; \
    float3 positionVar = boneBurstVertex.position; half4 colorVar = BoneBurstUnpackColor(boneBurstVertex.color); \
    float4 tintVar = BONE_BURST_FETCH_TINT(boneBurstIndex);
#define BONE_BURST_UV(input) boneBurstVertex.uv
#elif defined(_TINT_BLACK_ON)
#define BONE_BURST_EXTRA_ATTRIBUTES float2 uv2 : TEXCOORD1; float2 uv3 : TEXCOORD2;
#define BONE_BURST_VERTEX_INPUTS(input, positionVar, colorVar, tintVar) \
    float3 positionVar = input.positionOS; half4 colorVar = input.color; float4 tintVar = float4(input.uv2, input.uv3);
#define BONE_BURST_UV(input) input.uv
#else
#define BONE_BURST_EXTRA_ATTRIBUTES
#define BONE_BURST_VERTEX_INPUTS(input, positionVar, colorVar, tintVar) \
    float3 positionVar = input.positionOS; half4 colorVar = input.color; float4 tintVar = float4(0, 0, 0, 0);
#define BONE_BURST_UV(input) input.uv
#endif

// Premultiplied gamma vertex colour to the render target's space: un-premultiply, convert, premultiply again.
half4 BoneBurstVertexColor(half4 color)
{
#if !defined(UNITY_COLORSPACE_GAMMA)
    color.rgb = color.a > 0 ? SRGBToLinear(color.rgb / color.a) * color.a : SRGBToLinear(color.rgb);
#endif
    return color;
}

// The dark colour: converted as it arrives (already × α in gamma space; stock does not un-premultiply it).
half3 BoneBurstDarkColor(float2 uv2, float2 uv3, half vertexAlpha)
{
    half3 dark = half3(uv2.x, uv2.y, uv3.x);
#if !defined(UNITY_COLORSPACE_GAMMA)
    dark = SRGBToLinear(dark);
#endif
    return dark + _Black.rgb * vertexAlpha;
}

// Two-colour tint: black texels take the dark colour, white texels the light colour; premultiplied output.
half4 BoneBurstTinted(half4 texel, half3 dark, half4 light)
{
    half alpha = texel.a * light.a;
    bool straight = BoneBurstStraightAlpha();
    half3 texDark = (straight ? 1 : texel.a) - texel.rgb;
    half3 rgb = texDark * dark * _Color.a + texel.rgb * light.rgb;
    if (straight)
    {
        rgb *= texel.a;
    }
    return half4(rgb, alpha);
}

#endif
