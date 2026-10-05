namespace BoneBurst.Anim
{
    /// <summary>
    ///     A keyed event as delivered to listeners.
    /// </summary>
    public readonly struct BoneBurstEvent
    {
        public readonly string Name;

        /// <summary>
        ///     The event's baked key id (<see cref="BoneBurstKey.Id" />), to compare against
        ///     <c>Asset.Keys.KeyOf(BoneBurstKeyKind.Event, name)</c>. It is the key's id, not <see cref="Name" />'s
        ///     hash: events bake after animations and skins, so their keys are often suffixed.
        ///     <see cref="BoneBurstKey.EmptyId" /> for Complete, and when the state data came without an asset.
        /// </summary>
        public readonly int KeyId;

        public readonly int Int;
        public readonly float Float;
        public readonly string String;
        public readonly float Volume, Balance, Time;

        /// <summary>
        ///     True for the Complete notification (end of the animation or of a loop), which has no event data.
        /// </summary>
        public readonly bool IsComplete;

        public BoneBurstEvent(string name, int keyId, int intValue, float floatValue, string stringValue, float volume,
            float balance, float time, bool isComplete)
        {
            Name = name;
            KeyId = keyId;
            Int = intValue;
            Float = floatValue;
            String = stringValue;
            Volume = volume;
            Balance = balance;
            Time = time;
            IsComplete = isComplete;
        }
    }
}