using System.Collections.Generic;

namespace BoneBurst.Data
{
    /// <summary>
    ///     A parsed <c>.atlas</c> file: texture pages and the named regions packed into them.
    /// </summary>
    public sealed class AtlasDef
    {
        public readonly List<AtlasPageDef> Pages = new();
        public readonly List<AtlasRegionDef> Regions = new();

        /// <summary>
        ///     The first region with this exact name, across all pages, or null.
        /// </summary>
        public AtlasRegionDef FindRegion(string name)
        {
            foreach (AtlasRegionDef region in Regions)
                if (region.Name == name)
                    return region;

            return null;
        }
    }

    public sealed class AtlasPageDef
    {
        public string Format = "RGBA8888";
        public string MinFilter = "Nearest", MagFilter = "Nearest";

        /// <summary>
        ///     Texture file name, relative to the atlas file.
        /// </summary>
        public string Name;

        /// <summary>
        ///     Premultiplied alpha.
        /// </summary>
        public bool Pma;

        public bool RepeatU, RepeatV;

        public int Width, Height;
    }

    /// <summary>
    ///     One packed image. Pixel fields are as written in the file; U, V, U2, V2 and the packed size are derived
    ///     (<c>Doc/Format/Format-Json-Atlas.md</c> §15.5). V runs top-down, as in the file; no V flip is applied.
    /// </summary>
    public sealed class AtlasRegionDef
    {
        /// <summary>
        ///     Packing rotation in degrees: 0, or 90 (the only value that swaps the packed size), 180, 270.
        /// </summary>
        public int Degrees;

        /// <summary>
        ///     Unrecognised keys (<c>split</c>, <c>pad</c>, custom), with their integer values.
        /// </summary>
        public List<(string name, int[] values)> Extra;

        public int Index;
        public string Name;
        public float OffsetX, OffsetY;
        public int OriginalWidth, OriginalHeight;

        /// <summary>
        ///     Extent along U and along V on the page. Equal to the bounds size, except swapped when
        ///     <see cref="Degrees" /> is 90.
        /// </summary>
        public int PackedWidth, PackedHeight;

        public int Page;
        public float U, V, U2, V2;
        public int X, Y, Width, Height;
    }
}