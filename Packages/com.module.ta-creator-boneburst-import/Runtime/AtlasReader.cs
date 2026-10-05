using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace BoneBurst.Data
{
    /// <summary>
    ///     Reads the libGDX-style <c>.atlas</c> text format that Spine exports.
    /// </summary>
    /// <remarks>
    ///     Written from <c>Doc/Format/Format-Json-Atlas.md</c> §15. Blank lines separate pages; a line with a colon
    ///     is a field; any other line names a page (after a blank line) or a region.
    /// </remarks>
    public static class AtlasReader
    {
        /// <exception cref="SkeletonFormatException">A field is malformed.</exception>
        public static AtlasDef Read(string text)
        {
            if (text == null) throw new ArgumentNullException(nameof(text));

            AtlasDef atlas = new();
            using StringReader reader = new(text);
            int lineNumber = 0;
            string line = Next();

            // Leading blank lines, then an optional header of fields, which is ignored.
            while (line != null && line.Trim().Length == 0) line = Next();
            while (line != null && line.Trim().Length > 0 && IsEntry(line, out _, out _)) line = Next();

            AtlasPageDef page = null;
            while (line != null)
            {
                if (line.Trim().Length == 0)
                {
                    page = null;
                    line = Next();
                    continue;
                }

                if (page == null)
                {
                    page = new AtlasPageDef { Name = line.Trim() };
                    line = Next();
                    while (line != null && IsEntry(line, out string key, out string[] values))
                    {
                        ReadPageField(page, key, values, lineNumber);
                        line = Next();
                    }

                    atlas.Pages.Add(page);
                    continue;
                }

                AtlasRegionDef region = new() { Name = line, Page = atlas.Pages.Count - 1 };
                line = Next();
                while (line != null && IsEntry(line, out string key, out string[] values))
                {
                    ReadRegionField(region, key, values, lineNumber);
                    line = Next();
                }

                Finish(region, page);
                atlas.Regions.Add(region);
            }

            return atlas;

            string Next()
            {
                lineNumber++;
                return reader.ReadLine();
            }
        }

        private static void ReadPageField(AtlasPageDef page, string key, string[] values, int line)
        {
            switch (key)
            {
                case "size":
                    page.Width = Int(values, 0, line);
                    page.Height = Int(values, 1, line);
                    break;
                case "format":
                    page.Format = values[0];
                    break;
                case "filter":
                    page.MinFilter = values[0];
                    page.MagFilter = values.Length > 1 ? values[1] : values[0];
                    break;
                case "repeat":
                    page.RepeatU = values[0].IndexOf('x') >= 0;
                    page.RepeatV = values[0].IndexOf('y') >= 0;
                    break;
                case "pma":
                    page.Pma = values[0] == "true";
                    break;
            }
        }

        private static void ReadRegionField(AtlasRegionDef region, string key, string[] values, int line)
        {
            switch (key)
            {
                case "bounds":
                    region.X = Int(values, 0, line);
                    region.Y = Int(values, 1, line);
                    region.Width = Int(values, 2, line);
                    region.Height = Int(values, 3, line);
                    break;
                case "offsets":
                    region.OffsetX = Int(values, 0, line);
                    region.OffsetY = Int(values, 1, line);
                    region.OriginalWidth = Int(values, 2, line);
                    region.OriginalHeight = Int(values, 3, line);
                    break;
                case "rotate":
                    if (values[0] == "true") region.Degrees = 90;
                    else if (values[0] != "false") region.Degrees = Int(values, 0, line);
                    break;
                case "index":
                    region.Index = Int(values, 0, line);
                    break;
                case "xy":
                    region.X = Int(values, 0, line);
                    region.Y = Int(values, 1, line);
                    break;
                case "size":
                    region.Width = Int(values, 0, line);
                    region.Height = Int(values, 1, line);
                    break;
                case "offset":
                    region.OffsetX = Int(values, 0, line);
                    region.OffsetY = Int(values, 1, line);
                    break;
                case "orig":
                    region.OriginalWidth = Int(values, 0, line);
                    region.OriginalHeight = Int(values, 1, line);
                    break;
                default:
                    int[] ints = new int[values.Length];
                    for (int i = 0; i < ints.Length; i++)
                        int.TryParse(values[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out ints[i]);

                    region.Extra ??= new List<(string, int[])>();
                    region.Extra.Add((key, ints));
                    break;
            }
        }

        private static void Finish(AtlasRegionDef region, AtlasPageDef page)
        {
            if (region.OriginalWidth == 0 && region.OriginalHeight == 0)
            {
                region.OriginalWidth = region.Width;
                region.OriginalHeight = region.Height;
            }

            float pageWidth = page.Width, pageHeight = page.Height;
            region.U = region.X / pageWidth;
            region.V = region.Y / pageHeight;
            if (region.Degrees == 90)
            {
                region.U2 = (region.X + region.Height) / pageWidth;
                region.V2 = (region.Y + region.Width) / pageHeight;
                region.PackedWidth = region.Height;
                region.PackedHeight = region.Width;
            }
            else
            {
                region.U2 = (region.X + region.Width) / pageWidth;
                region.V2 = (region.Y + region.Height) / pageHeight;
                region.PackedWidth = region.Width;
                region.PackedHeight = region.Height;
            }
        }

        /// <summary>
        ///     A trimmed line holding a colon: key before the first colon, up to 4 comma-separated values after it.
        /// </summary>
        private static bool IsEntry(string line, out string key, out string[] values)
        {
            key = null;
            values = null;
            string trimmed = line.Trim();
            int colon = trimmed.IndexOf(':');
            if (colon < 0) return false;

            key = trimmed.Substring(0, colon).Trim();
            string[] parts = trimmed.Substring(colon + 1).Split(',');
            values = new string[Math.Min(parts.Length, 4)];
            for (int i = 0; i < values.Length; i++) values[i] = parts[i].Trim();

            return true;
        }

        private static int Int(string[] values, int index, int line)
        {
            if (index >= values.Length ||
                !int.TryParse(values[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out int value))
                throw new SkeletonFormatException($"Atlas line {line}: expected an integer at value {index + 1}.");

            return value;
        }
    }
}