using System;
using BoneBurst.Blob;

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     Resolves a clip's baked animation key against an asset: the key's export name looked up in the asset's
    ///     animations. The mixer resolves against the bound skeleton's asset at play time; the clip asset uses its
    ///     own copy only for the clip's drawn duration.
    /// </summary>
    public static class BoneBurstAnimationLookup
    {
        /// <summary>
        ///     The animation index and duration the key names, or false when the asset is null or unreadable, the key
        ///     is empty, or it names no animation of this asset.
        /// </summary>
        public static bool TryGet(BoneBurstAsset asset, BoneBurstKey key, out int animation, out float duration)
        {
            animation = -1;
            duration = 0;
            if (asset == null || !asset.HasData || key.IsEmpty) return false;

            SkeletonBlob blob;
            BoneBurstKeyTable table;
            try
            {
                table = asset.Keys;
                blob = asset.Blob;
            }
            catch (Exception)
            {
                return false; // an unreadable bake; the caller warns on the miss
            }

            if (!table.TryGet(key.Id, out BoneBurstKeyTable.Entry entry) ||
                entry.Kind != BoneBurstKeyKind.Animation)
                return false;

            int index = Array.FindIndex(blob.Skeleton.Animations, a => a.Name == entry.Name);
            if (index < 0) return false;

            animation = index;
            duration = blob.Content.Animations[index].Duration;
            return true;
        }
    }
}