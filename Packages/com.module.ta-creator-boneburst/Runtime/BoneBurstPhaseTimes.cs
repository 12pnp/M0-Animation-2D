namespace BoneBurst
{
    /// <summary>
    ///     One frame of <see cref="BoneBurstSystem" />, phase by phase, in milliseconds
    ///     (<see cref="BoneBurstSystem.TimePhases" />). Schedule = Advance + Headers + JobSetup plus the structure
    ///     changes before them; Complete = Wait + Apply + Events.
    /// </summary>
    public struct BoneBurstPhaseTimes
    {
        /// <summary>
        ///     The whole <c>BoneBurst.Schedule</c> step.
        /// </summary>
        public double Schedule;

        /// <summary>
        ///     Managed animation state: <c>Update</c> and <c>Apply</c> for every playing skeleton.
        /// </summary>
        public double Advance;

        /// <summary>
        ///     Per dirty skeleton: GPU and fetch attach, the instance header, the fetch ranges.
        /// </summary>
        public double Headers;

        /// <summary>
        ///     Row arrays and job scheduling.
        /// </summary>
        public double JobSetup;

        /// <summary>
        ///     The whole <c>BoneBurst.Complete</c> step.
        /// </summary>
        public double Complete;

        /// <summary>
        ///     The main thread waiting for the pose, mesh and copy jobs.
        /// </summary>
        public double Wait;

        /// <summary>
        ///     Mesh upload and bounds, the GPU path's completion, the fetch buffer's end of frame.
        /// </summary>
        public double Apply;

        /// <summary>
        ///     <c>AfterApply</c> for every applied skeleton: events, completions, mixing state.
        /// </summary>
        public double Events;
    }
}