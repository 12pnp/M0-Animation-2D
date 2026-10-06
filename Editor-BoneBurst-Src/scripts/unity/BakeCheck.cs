using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using BoneBurst;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Editor;
using BoneBurst.Instance;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

/// <summary>
///     The bake check (E8-PLAN step 3): v2's export baked by the real bake, read back by reading. Copied to
///     Temp/AgentScripts/ and run with the unity CLI's run_script (Unity clears Temp/ on restart, so it lives here).
/// </summary>
public static class BakeCheck
{
    private const string Check = "Assets/E8BakeCheck";
    private const string Export = Check + "/figure";
    private const string Out = "Temp/E8Bake";
    private const float Step = 0.0337f;

    /// <summary>
    ///     Copy the export (the folder given in args) into the scratch folder and import it.
    /// </summary>
    public static string Prepare(string from)
    {
        if (AssetDatabase.IsValidFolder(Check)) return $"refused: {Check} already exists";
        Directory.CreateDirectory(Export);
        foreach (string f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(Export, Path.GetFileName(f)));
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        return string.Join(", ", Directory.GetFiles(Export).Select(Path.GetFileName));
    }

    /// <summary>
    ///     The first bake, as the popup makes it: FindSource, SettingsFor, Bake. Then what it wrote, read back.
    /// </summary>
    public static string Bake(string unused)
    {
        BoneBurstBake.Source source = BoneBurstBake.FindSource(Export, out string error);
        if (source == null) return $"{{\"ok\":false,\"error\":{Quote("FindSource: " + error)}}}";
        BoneBurstBakeSettings settings = BoneBurstBake.SettingsFor(source);
        BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
        if (!result.Ok) return $"{{\"ok\":false,\"error\":{Quote(result.Error)}}}";
        return Read(AssetDatabase.GetAssetPath(result.Asset));
    }

    /// <summary>
    ///     The baked asset at <paramref name="assetPath" />: its references, its data's names, and its poses (to Out).
    /// </summary>
    public static string Read(string assetPath)
    {
        Object loaded = AssetDatabase.LoadAssetAtPath<Object>(assetPath);
        if (!(loaded is BoneBurstAsset asset)) return $"{{\"ok\":false,\"error\":{Quote($"no BoneBurstAsset at {assetPath} ({loaded?.GetType().Name ?? "nothing"})")}}}";
        string dataPath = BoneBurstBake.DataPathOf(asset);
        if (dataPath == null) return $"{{\"ok\":false,\"error\":\"the asset's data reference is not valid\"}}";
        BoneBurstData data = BoneBurstDataReader.Read(File.ReadAllBytes(dataPath));
        SkeletonDef def = data.Skeleton;
        Directory.CreateDirectory(Out);
        File.WriteAllText(Path.Combine(Out, "figure.poses.json"),
            $"{{\"name\":\"figure\",\"scale\":{F(data.Scale)},\"animations\":{Poses(def, BlobBuilder.BuildContent(def, data.Atlas))}}}");
        StringBuilder s = new("{\"ok\":true");
        s.Append(",\"asset\":").Append(Quote(assetPath));
        s.Append(",\"assetGuid\":").Append(Quote(AssetDatabase.AssetPathToGUID(assetPath)));
        s.Append(",\"data\":").Append(Quote(dataPath));
        s.Append(",\"dataGuid\":").Append(Quote(AssetDatabase.AssetPathToGUID(dataPath)));
        s.Append(",\"dataBytes\":").Append(new FileInfo(dataPath).Length);
        s.Append(",\"dataDigest\":").Append(Quote(Hash128.Compute(File.ReadAllBytes(dataPath)).ToString()));
        s.Append(",\"dataIndexed\":").Append(asset.DataReference.IsValid ? "true" : "false");
        s.Append(",\"pages\":[").Append(string.Join(",", asset.PageReferences.Select(p =>
            Quote(p.IsValid ? AssetDatabase.GUIDToAssetPath(p.AssetGuid) : "(invalid)")))).Append(']');
        s.Append(",\"shader\":").Append(Quote(asset.Shader != null ? asset.Shader.name : "(none)"));
        s.Append(",\"scale\":").Append(F(data.Scale));
        s.Append(",\"bones\":").Append(Names(def.Bones.Select(b => b.Name)));
        s.Append(",\"slots\":").Append(Names(def.Slots.Select(b => b.Name)));
        s.Append(",\"skins\":").Append(Names(def.Skins.Select(b => b.Name)));
        s.Append(",\"constraints\":").Append(Names(def.Constraints.Select(b => b.Name)));
        s.Append(",\"animations\":").Append(Names(def.Animations.Select(b => b.Name)));
        s.Append(",\"durations\":[").Append(string.Join(",", def.Animations.Select(a => F(a.Duration)))).Append(']');
        return s.Append('}').ToString();
    }

    /// <summary>
    ///     Delete the scratch folder: this check's own output, made in this step (not a create path).
    /// </summary>
    public static string Cleanup(string unused)
    {
        if (!AssetDatabase.IsValidFolder(Check)) return "nothing to delete";
        bool ok = AssetDatabase.DeleteAsset(Check);
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        return ok && !Directory.Exists(Check) ? $"deleted {Check}" : $"FAILED to delete {Check}";
    }

    // As Tools~/ParityHarness/Dump.cs poses an export, so scripts/oracle/csharp.ts reads it the same way.
    private static string Poses(SkeletonDef def, BlobContent content)
    {
        StringBuilder s = new("{");
        for (int a = 0; a < def.Animations.Length; a++)
        {
            if (a > 0) s.Append(',');
            s.Append(Quote(def.Animations[a].Name)).Append(":[");
            using ManagedPose pose = new(content, -1);
            BoneAnimationState track = new(new BoneAnimationStateData(content));
            CommandBuffer buffer = new();
            track.SetAnimation(0, a, false);
            int count = Math.Max(1, (int)Math.Round(def.Animations[a].Duration / Step) + 1);
            for (int f = 0; f < count; f++)
            {
                float dt = f == 0 ? 0 : Step;
                track.Update(dt);
                pose.Time += dt;
                track.Apply(buffer);
                pose.Pose(buffer);
                track.AfterApply(buffer, pose.FiredEvents(), pose.TotalAlpha, pose.Rotation);
                if (f > 0) s.Append(',');
                s.Append("{\"w\":[");
                for (int i = 0; i < pose.World.Length; i++)
                {
                    BoneWorld w = pose.World[i];
                    if (i > 0) s.Append(',');
                    if (!pose.BoneActive[i]) { s.Append("null"); continue; }
                    s.Append('[').Append(F(w.A)).Append(',').Append(F(w.B)).Append(',').Append(F(w.C)).Append(',')
                        .Append(F(w.D)).Append(',').Append(F(w.X)).Append(',').Append(F(w.Y)).Append(']');
                }

                s.Append("]}");
            }

            s.Append(']');
        }

        return s.Append('}').ToString();
    }

    private static string Names(System.Collections.Generic.IEnumerable<string> names)
    {
        return "[" + string.Join(",", names.Select(Quote)) + "]";
    }

    private static string F(float v)
    {
        return float.IsFinite(v) ? v.ToString("R", CultureInfo.InvariantCulture) : "null";
    }

    private static string Quote(string v)
    {
        StringBuilder s = new("\"");
        foreach (char ch in v ?? "")
            s.Append(ch switch { '"' => "\\\"", '\\' => "\\\\", < ' ' => $"\\u{(int)ch:x4}", _ => ch.ToString() });
        return s.Append('"').ToString();
    }
}
