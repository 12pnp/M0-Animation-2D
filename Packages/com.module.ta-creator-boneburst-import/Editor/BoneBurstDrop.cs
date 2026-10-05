using System;
using System.IO;
using System.Linq;
using BoneBurst.Data;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace BoneBurst.Editor
{
    /// <summary>
    ///     Dragging a <see cref="BoneBurstAsset" /> into the Scene view or the Hierarchy creates a ready skeleton: a
    ///     GameObject with <see cref="BoneBurstSkeleton" /> (and its <c>MeshFilter</c> and <c>MeshRenderer</c>), the
    ///     asset assigned, a skin that shows something, and a looping start animation.
    /// </summary>
    /// <remarks>
    ///     Only drags made entirely of <see cref="BoneBurstAsset" />s are taken; anything else is left to Unity's
    ///     own handlers. Every created object is one Undo step. <see cref="Create" /> does the work, so tests run it
    ///     without a drag.
    /// </remarks>
    [InitializeOnLoad]
    public static class BoneBurstDrop
    {
        static BoneBurstDrop()
        {
            DragAndDrop.AddDropHandlerV2(OnSceneDrop);
            DragAndDrop.AddDropHandlerV2(OnHierarchyDrop);
        }

        private static DragAndDropVisualMode OnSceneDrop(Object dropUpon, Vector3 worldPosition,
            Vector2 viewportPosition,
            Transform parentForDraggedObjects, bool perform)
        {
            BoneBurstAsset[] assets = DraggedAssets();
            if (assets == null) return DragAndDropVisualMode.None;
            if (!perform) return DragAndDropVisualMode.Copy;

            // A 2D scene draws on z = 0; a drop there lands on the plane, not at the depth of whatever was under the cursor.
            SceneView view = SceneView.lastActiveSceneView;
            if (view != null && view.in2DMode) worldPosition.z = 0;
            Finish(assets.Select(a => Create(a, parentForDraggedObjects, worldPosition)).ToArray());
            return DragAndDropVisualMode.Copy;
        }

        private static DragAndDropVisualMode OnHierarchyDrop(EntityId dropTarget, HierarchyDropFlags dropMode,
            Transform parentForDraggedObjects, bool perform)
        {
            BoneBurstAsset[] assets = DraggedAssets();
            if (assets == null) return DragAndDropVisualMode.None;
            if (!perform) return DragAndDropVisualMode.Copy;

            Transform parent = parentForDraggedObjects;
            if ((dropMode & HierarchyDropFlags.DropUpon) != 0 &&
                EditorUtility.EntityIdToObject(dropTarget) is GameObject target) parent = target.transform;

            Vector3 position = parent != null ? parent.position : Vector3.zero;
            Finish(assets.Select(a => Create(a, parent, position)).ToArray());
            return DragAndDropVisualMode.Copy;
        }

        /// <summary>
        ///     The dragged assets when the drag holds only <see cref="BoneBurstAsset" />s, else null.
        /// </summary>
        private static BoneBurstAsset[] DraggedAssets()
        {
            Object[] dragged = DragAndDrop.objectReferences;
            if (dragged == null || dragged.Length == 0 || !dragged.All(o => o is BoneBurstAsset)) return null;
            return dragged.Cast<BoneBurstAsset>().ToArray();
        }

        private static void Finish(GameObject[] created)
        {
            DragAndDrop.AcceptDrag();
            Selection.objects = created.Cast<Object>().ToArray();
        }

        /// <summary>
        ///     Creates a skeleton for <paramref name="asset" /> under <paramref name="parent" /> (null: the scene root)
        ///     at <paramref name="worldPosition" />, as one Undo step.
        /// </summary>
        /// <remarks>
        ///     The skin is empty (the default skin) when the default skin draws something; otherwise the first skin
        ///     that does, so a skeleton like mix-and-match-pro does not come up invisible (<see cref="StartSkin" />). The
        ///     start animation is <c>idle</c>, else the first whose name contains "idle", else the first; looping.
        ///     Data that cannot be read still gives the object with its asset, and logs why no skin or animation was
        ///     chosen.
        /// </remarks>
        public static GameObject Create(BoneBurstAsset asset, Transform parent, Vector3 worldPosition)
        {
            string name = asset.name.EndsWith("_BoneBurst", StringComparison.Ordinal)
                ? asset.name.Substring(0, asset.name.Length - "_BoneBurst".Length)
                : asset.name;
            // Built inactive and activated last, so the skeleton's OnEnable (Edit-mode preview) sees every field set.
            GameObject go = new(name);
            go.SetActive(false);
            Undo.RegisterCreatedObjectUndo(go, $"Create {name}");
            if (parent != null) go.transform.SetParent(parent, false);
            go.transform.position = worldPosition;
            GameObjectUtility.EnsureUniqueNameForSibling(go);

            BoneBurstSkeleton skeleton = go.AddComponent<BoneBurstSkeleton>();
            skeleton.Asset = asset;
            string dataPath = BoneBurstBake.DataPathOf(asset);
            if (dataPath == null)
            {
                Debug.LogError($"BoneBurst: {asset.name} has no baked data; the skeleton was created without a skin " +
                               "or start animation.", go);
                go.SetActive(true);
                return go;
            }

            try
            {
                SkeletonDef def = BoneBurstDataReader.Read(File.ReadAllBytes(dataPath)).Skeleton;
                BoneBurstKeyTable keys = asset.Keys;
                string skin = StartSkin(def);
                if (skin != null) skeleton.Skin = keys.KeyOf(BoneBurstKeyKind.Skin, skin);
                string animation = StartAnimation(def);
                if (animation != null) skeleton.Animation = keys.KeyOf(BoneBurstKeyKind.Animation, animation);
            }
            catch (SkeletonFormatException e)
            {
                Debug.LogError($"BoneBurst: {asset.name}'s data cannot be read ({e.Message}); " +
                               "the skeleton was created without a skin or start animation.", go);
            }

            go.SetActive(true);
            return go;
        }

        /// <summary>
        ///     Null (the default skin) when the default skin draws something, else the name of the first skin that does
        ///     (null when none does).
        /// </summary>
        /// <remarks>
        ///     "Draws" means a region or mesh attachment: mix-and-match-pro's default skin holds only four path
        ///     attachments, so a skeleton left on it shows nothing.
        /// </remarks>
        public static string StartSkin(SkeletonDef def)
        {
            if (Draws(def.DefaultSkin)) return null;
            SkinDef first = def.Skins?.FirstOrDefault(s => s != def.DefaultSkin && s.Name != "default" && Draws(s));
            return first?.Name;
        }

        private static bool Draws(SkinDef skin)
        {
            return skin != null && skin.Entries.Any(e => e.Attachment is RegionDef || e.Attachment is MeshDef);
        }

        /// <summary>
        ///     <c>idle</c>, else the first animation whose name contains "idle", else the first; null without animations.
        /// </summary>
        public static string StartAnimation(SkeletonDef def)
        {
            if (def.Animations == null || def.Animations.Length == 0) return null;
            AnimationDef idle =
                def.Animations.FirstOrDefault(a => string.Equals(a.Name, "idle", StringComparison.OrdinalIgnoreCase)) ??
                def.Animations.FirstOrDefault(a => a.Name.IndexOf("idle", StringComparison.OrdinalIgnoreCase) >= 0);
            return (idle ?? def.Animations[0]).Name;
        }
    }
}