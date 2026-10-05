using System.IO;
using BoneBurst.Data;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Gives a test <see cref="BoneBurstAsset" /> its data the way the Editor bake does: read the export (JSON or
    ///     binary) and atlas at a scale, write <c>.sbdata</c> in memory, assign it.
    /// </summary>
    internal static class BakedTestData
    {
        /// <summary>
        ///     spine-unity's import default, which the assets used before the scale moved into the bake.
        /// </summary>
        public const float DefaultScale = 0.01f;

        public static void Assign(BoneBurstAsset asset, string skeletonPath, string atlasText, float scale)
        {
            SkeletonDef skeleton = skeletonPath.EndsWith(".json")
                ? SkeletonJsonReader.Read(File.ReadAllText(skeletonPath), scale)
                : SkeletonBinaryReader.Read(File.ReadAllBytes(skeletonPath), scale);
            byte[] bytes = BoneBurstDataWriter.Write(skeleton, AtlasReader.Read(atlasText), scale);
            asset.SetDataBytes(bytes);
        }
    }
}