using UnityEditor;
using UnityEngine;

namespace BoneBurst.Editor
{
    /// <summary>
    ///     Shows BoneBurst skeletons in the Scene view outside Play mode. <see cref="BoneBurstSkeleton" /> runs in Edit
    ///     mode (<c>ExecuteAlways</c>); this driver runs <see cref="BoneBurstSystem" />'s frame from
    ///     <c>EditorApplication.update</c>, only when something changed, with no time passing: each skeleton shows
    ///     its start animation's first frame (or the setup pose).
    /// </summary>
    /// <remarks>
    ///     <para>
    ///         In Play mode the PlayerLoop entries run the frame and this driver stays out. Before a script reload and
    ///         before entering Play mode it detaches every skeleton and frees everything (
    ///         <see cref="BoneBurstSystem.Uninstall" />), so no native
    ///         data outlives its domain; the skeletons rebuild in their <c>OnEnable</c>.
    ///     </para>
    ///     <para>
    ///         An idle scene costs nothing: no frame is scheduled while nothing is dirty.
    ///     </para>
    /// </remarks>
    [InitializeOnLoad]
    internal static class BoneBurstEditModePreview
    {
        static BoneBurstEditModePreview()
        {
            EditorApplication.update += Tick;
            AssemblyReloadEvents.beforeAssemblyReload += BeforeReload;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
        }

        private static void BeforeReload()
        {
            BoneBurstAsset.FreeDestroyed();
            BoneBurstSystem.Uninstall();
        }

        private static void OnPlayModeChanged(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.ExitingEditMode)
                BoneBurstSystem.Uninstall();
            else if (change == PlayModeStateChange.EnteredEditMode)
                // Entering Play can stop short (compile errors); skeletons it detached come back here.
                foreach (BoneBurstSkeleton skeleton in
                         Object.FindObjectsByType<BoneBurstSkeleton>(FindObjectsInactive.Exclude))
                    if (skeleton.Data == null)
                        skeleton.RestartPreview();
        }

        private static void Tick()
        {
            // Deleted assets never get OnDisable; free their blobs (detaching any skeleton still on them) now.
            BoneBurstAsset.FreeDestroyed();
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            BoneBurstSkeleton.RestartQueuedPreviews();
            if (!BoneBurstSystem.HasPendingWork) return;
            BoneBurstSystem.Schedule(0);
            BoneBurstSystem.Complete();
            SceneView.RepaintAll();
            EditorApplication.QueuePlayerLoopUpdate();
        }
    }
}