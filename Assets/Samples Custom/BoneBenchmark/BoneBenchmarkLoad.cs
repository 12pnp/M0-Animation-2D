using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Spine.Unity;
using BoneBurst;
using BoneBurst.Blob;
using BoneBurst.Data;

/// <summary>
///     Load time of one skeleton: BoneBurst's baked data against its old JSON path and against stock spine-unity
///     (<c>Packages/com.module.ta-creator-boneburst/Doc/Review/BoneBurst-ImprovePlan.md</c>, I4). Run a player with
///     <c>-loadBench N</c>; it measures, writes <c>loadtime.csv</c> beside <c>summary.csv</c>, and quits.
/// </summary>
/// <remarks>
///     Each metric is timed N times after three warm-up runs, with a GC before every run (outside the timing), and
///     reported as median, p95 and minimum. The work timed is what a first use costs, with every cache cleared:
///     <list type="bullet">
///         <item><c>burst_first_use</c>: what <c>BoneBurstAsset.Blob</c> does: the data's bytes, the reader, the key
///         table, <c>BlobBuilder.Build</c>.</item>
///         <item><c>burst_data_read</c>, <c>burst_blob_build</c>: those two parts on their own.</item>
///         <item><c>json_first_use</c>: the path before the bake: BoneBurst's JSON and atlas readers, the key table,
///         <c>BlobBuilder.Build</c>, on the same export (the stock asset's JSON and atlas).</item>
///         <item><c>stock_load</c>: spine-unity's own load: its atlas and skeleton data, both cleared first.</item>
///     </list>
/// </remarks>
public static class BoneBenchmarkLoad
{
    public struct Row
    {
        public string Metric;
        public double MedianMs, P95Ms, MinMs;
    }

    public static List<Row> Measure(byte[] burstData, SkeletonDataAsset stock, int iterations)
    {
        string json = stock.skeletonJSON.text;
        SpineAtlasAsset atlasAsset = (SpineAtlasAsset)stock.atlasAssets[0];
        string atlasText = atlasAsset.atlasFile.text;
        float scale = stock.scale;
        BoneBurstData baked = BoneBurstDataReader.Read(burstData);

        List<Row> rows = new()
        {
            Time("burst_first_use", iterations, () =>
            {
                BoneBurstData data = BoneBurstDataReader.Read(burstData);
                _ = new BoneBurstKeyTable(data.Keys, data.KeyIds);
                return BlobBuilder.Build(data.Skeleton, data.Atlas);
            }),
            Time("burst_data_read", iterations, () =>
            {
                BoneBurstDataReader.Read(burstData);
                return null;
            }),
            Time("burst_blob_build", iterations, () => BlobBuilder.Build(baked.Skeleton, baked.Atlas)),
            Time("json_first_use", iterations, () =>
            {
                SkeletonDef skeleton = SkeletonJsonReader.Read(json, scale);
                AtlasDef atlas = AtlasReader.Read(atlasText);
                _ = new BoneBurstKeyTable(BoneBurstKeyTable.BuildEntries(skeleton));
                return BlobBuilder.Build(skeleton, atlas);
            }),
            Time("stock_load", iterations, () =>
            {
                atlasAsset.Clear();
                stock.Clear();
                stock.GetSkeletonData(true);
                return null;
            })
        };
        return rows;
    }

    /// <summary>
    ///     Times <paramref name="work" />; a returned blob is disposed outside the timing.
    /// </summary>
    static Row Time(string metric, int iterations, Func<SkeletonBlob> work)
    {
        for (int i = 0; i < 3; i++) work()?.Dispose();
        double[] ms = new double[iterations];
        for (int i = 0; i < iterations; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
            SkeletonBlob blob = work();
            watch.Stop();
            blob?.Dispose();
            ms[i] = watch.Elapsed.TotalMilliseconds;
        }

        Array.Sort(ms);
        return new Row
        {
            Metric = metric, MedianMs = ms[iterations / 2], P95Ms = ms[Math.Min(iterations - 1, (int)(iterations * 0.95))],
            MinMs = ms[0]
        };
    }

    public static string Write(string folder, string runId, string backend, int iterations, IReadOnlyList<Row> rows)
    {
        string path = Path.Combine(folder, "loadtime.csv");
        bool header = !File.Exists(path);
        StringBuilder csv = new();
        if (header) csv.AppendLine("run_id,backend,metric,iterations,median_ms,p95_ms,min_ms");
        foreach (Row row in rows)
        {
            csv.AppendLine(string.Join(",", runId, backend, row.Metric, iterations.ToString(CultureInfo.InvariantCulture),
                row.MedianMs.ToString("F4", CultureInfo.InvariantCulture), row.P95Ms.ToString("F4", CultureInfo.InvariantCulture),
                row.MinMs.ToString("F4", CultureInfo.InvariantCulture)));
        }

        File.AppendAllText(path, csv.ToString());
        return path;
    }
}
