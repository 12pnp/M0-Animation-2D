using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace BoneBurst.Editor
{
    /// <summary>
    ///     The bake's two entry points: right-click an export folder › BoneBurst › Bake Folder… (with the popup), and
    ///     a baked asset's context menu › Rebake (the previous settings, no popup).
    /// </summary>
    /// <remarks>
    ///     Bake Folder… is always enabled, whatever is selected (the owner's choice: a greyed-out item gives no reason).
    ///     When there is nothing to bake, the click logs one error holding every reason and opens nothing; never a silent
    ///     no-op (<c>CLAUDE.md</c> §9).
    /// </remarks>
    public static class BoneBurstBakeMenu
    {
        private const string Menu = "Assets/BoneBurst/Bake Folder...";

        [MenuItem(Menu, false, 200)]
        private static void BakeSelectedFolder()
        {
            string[] folders = TargetFolders();
            if (folders.Length != 1)
            {
                Debug.LogError(folders.Length == 0
                    ? "BoneBurst bake: select a Spine export folder (or a file in it) in the Project window, then use Bake Folder…."
                    : $"BoneBurst bake: select one export folder; the selection spans {folders.Length}:\n- " +
                      string.Join("\n- ", folders));
                return;
            }

            BoneBurstBake.Source source = BoneBurstBake.FindSource(folders[0], out string error);
            if (source == null)
            {
                Debug.LogError($"BoneBurst bake: {error}", AssetDatabase.LoadAssetAtPath<Object>(folders[0]));
                return;
            }

            BoneBurstBakePopup.Open(source, BoneBurstBake.SettingsFor(source));
        }

        /// <summary>
        ///     The folders the click means: each selected asset's folder (a selected file stands for the folder it is
        ///     in), or, with nothing selected, the folder open in the Project window.
        /// </summary>
        /// <remarks>
        ///     <c>Selection.assetGUIDs</c>, not <c>Selection.activeObject</c>: a right-click in the Project window's
        ///     folder tree can leave <c>activeObject</c> null (measured 2026-10-01: the owner's click on
        ///     mix-and-match-pro logged "nothing is selected").
        /// </remarks>
        private static string[] TargetFolders()
        {
            SortedSet<string> folders = new(StringComparer.Ordinal);
            foreach (string guid in Selection.assetGUIDs)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path)) continue;
                folders.Add(AssetDatabase.IsValidFolder(path)
                    ? path
                    : Path.GetDirectoryName(path)?.Replace('\\', '/'));
            }

            if (folders.Count == 0)
            {
                // Unity has no public call for the folder the Project window shows; its internal one is optional here.
                MethodInfo active = typeof(ProjectWindowUtil).GetMethod("GetActiveFolderPath",
                    BindingFlags.NonPublic | BindingFlags.Static);
                if (active?.Invoke(null, null) is string path && path != "Assets" && AssetDatabase.IsValidFolder(path))
                    folders.Add(path);
            }

            folders.Remove(null);
            return folders.ToArray();
        }

        [MenuItem("CONTEXT/BoneBurstAsset/Rebake")]
        private static void Rebake(MenuCommand command)
        {
            BoneBurstAsset asset = (BoneBurstAsset)command.context;
            BoneBurstBake.Source source = BoneBurstBake.SourceOf(asset, out string error);
            if (source == null)
            {
                Debug.LogError($"BoneBurst rebake: {error}", asset);
                return;
            }

            BoneBurstBakeSettings settings = BoneBurstBake.SettingsFor(source, BoneBurstBake.DataPathOf(asset));
            try
            {
                BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
                if (result.Ok) Debug.Log(result.Report, result.Asset);
                else Debug.LogError($"BoneBurst rebake: {result.Error}", asset);
            }
            finally
            {
                Object.DestroyImmediate(settings);
            }
        }
    }
}