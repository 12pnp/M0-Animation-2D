using System.Collections.Generic;
using UnityEngine;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     The CPU mesh's vertex positions for play-mode tests, from the <c>Mesh</c> or the shared vertex-fetch list,
    ///     whichever the last frame used (<see cref="BoneBurstSkeleton.GetCpuVertices" />).
    /// </summary>
    internal static class CpuMesh
    {
        public static Vector3[] Positions(BoneBurstSkeleton skeleton)
        {
            List<Vector3> positions = new();
            skeleton.GetCpuVertices(positions, new List<Color32>(), new List<Vector2>());
            return positions.ToArray();
        }
    }
}