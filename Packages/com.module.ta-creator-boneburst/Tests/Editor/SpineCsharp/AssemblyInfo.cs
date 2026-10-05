using System.Runtime.CompilerServices;

// The spine-unity mesh-parity assembly drives this assembly's hooks (AnimationParityTests.StockMeshCompare,
// SetupPoseParityTests.StockMeshCompare, SameVertex, LoadStock) through its InitializeOnLoadMethod.
[assembly: InternalsVisibleTo("Module.TA.BoneBurst.Tests.SpineUnity")]
