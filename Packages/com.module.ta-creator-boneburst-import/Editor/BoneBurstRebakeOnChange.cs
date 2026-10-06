using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace BoneBurst.Editor
{
    /// <summary>
    ///     Rebakes an export folder when its export changes: a new export from the BoneBurst Editor
    ///     (<c>Editor-BoneBurst-Src/</c>, Export to Unity; or the old editor's File › Export to Unity) or files copied
    ///     in by hand. Only a folder that was
    ///     baked before (<see cref="BoneBurstBake.WasBaked" />), with that bake's settings, as the asset's Rebake
    ///     command does; the first bake stays the popup's (BoneBurstBakeMenu). Pipeline plan R4
    ///     (<c>Animation-BoneBurst-Src/docs/BONEBURST-PIPELINE-PLAN.md</c>).
    /// </summary>
    /// <remarks>
    ///     <para>
    ///         Every changed folder of one import is collected and baked once, after the import (an
    ///         <c>AssetDatabase</c> write inside <c>OnPostprocessAllAssets</c> would re-enter it). The bake's own output
    ///         folder is never a source, so its imports change nothing here.
    ///     </para>
    ///     <para>
    ///         Never destroys authored work (<c>CLAUDE.md</c> §6): <see cref="BoneBurstBake.Bake" /> rewrites only the
    ///         files it wrote and refuses anything else, and a refusal or a half-written export is logged, never silent
    ///         (§9).
    ///     </para>
    /// </remarks>
    internal sealed class BoneBurstRebakeOnChange : AssetPostprocessor
    {
        private static readonly SortedSet<string> s_Pending = new(StringComparer.Ordinal);

        private static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved,
            string[] movedFrom)
        {
            foreach (string path in imported)
            {
                if (!IsExportFile(path)) continue;
                string folder = Path.GetDirectoryName(path)?.Replace('\\', '/');
                if (string.IsNullOrEmpty(folder)) continue;
                if (s_Pending.Count == 0) EditorApplication.delayCall += RebakePending;
                s_Pending.Add(folder);
            }
        }

        /// <summary>
        ///     The files an export is made of: the skeleton, the atlas and its page images.
        /// </summary>
        private static bool IsExportFile(string path)
        {
            return path.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ||
                   path.EndsWith(".skel.bytes", StringComparison.OrdinalIgnoreCase) ||
                   path.EndsWith(".atlas.txt", StringComparison.OrdinalIgnoreCase) ||
                   path.EndsWith(".png", StringComparison.OrdinalIgnoreCase);
        }

        private static void RebakePending()
        {
            string[] folders = s_Pending.ToArray();
            s_Pending.Clear();
            foreach (string folder in folders)
            {
                if (!BoneBurstBake.WasBaked(folder)) continue;
                BoneBurstBake.Source source = BoneBurstBake.FindSource(folder, out string error);
                if (source == null)
                {
                    // Most often an export still being written: the next import of its last file bakes it.
                    Debug.LogWarning($"BoneBurst rebake on change: {error}",
                        AssetDatabase.LoadAssetAtPath<Object>(folder));
                    continue;
                }

                BoneBurstBakeSettings settings = BoneBurstBake.SettingsFor(source);
                try
                {
                    BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
                    if (result.Ok) Debug.Log($"BoneBurst rebake on change: {result.Report}", result.Asset);
                    else
                        Debug.LogError($"BoneBurst rebake on change: {result.Error}",
                            AssetDatabase.LoadAssetAtPath<Object>(folder));
                }
                finally
                {
                    Object.DestroyImmediate(settings);
                }
            }
        }
    }
}
