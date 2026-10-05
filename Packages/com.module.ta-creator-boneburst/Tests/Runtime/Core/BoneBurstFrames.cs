using System.Collections;
using NUnit.Framework;
using UnityEngine;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Frame stepping for play-mode tests that read what <see cref="BoneBurstSystem" /> produced.
    /// </summary>
    /// <remarks>
    ///     A test coroutine resumes from <c>yield return null</c> in <c>Update.ScriptRunDelayedDynamicFrameRate</c>,
    ///     which runs after the <c>BoneBurstSchedule</c> entry and before <c>BoneBurstComplete</c> (end of
    ///     <c>PreLateUpdate</c>): the jobs are in flight, the meshes are not applied and <c>FramesCompleted</c> is one
    ///     behind <c>FramesScheduled</c> (measured 2026-09-29). Reading a mesh, a GPU state or the pose buffer there
    ///     sees last frame's output, or races the jobs.
    /// </remarks>
    internal static class BoneBurstFrames
    {
        /// <summary>
        ///     Advances one frame and resumes after its Complete: <c>yield return BoneBurstFrames.Next();</c>.
        ///     Changes made after it are picked up by the next frame's Schedule, as they were after
        ///     <c>yield return null</c>.
        /// </summary>
        public static IEnumerator Next()
        {
            yield return null;
            yield return new WaitForEndOfFrame();
            Assert.AreEqual(BoneBurstSystem.FramesScheduled, BoneBurstSystem.FramesCompleted,
                "resumed before BoneBurstSystem.Complete; the frame's output is not applied yet");
        }
    }
}