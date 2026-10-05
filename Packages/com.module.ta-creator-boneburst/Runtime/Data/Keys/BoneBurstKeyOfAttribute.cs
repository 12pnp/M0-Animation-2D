using UnityEngine;

namespace BoneBurst
{
    /// <summary>
    ///     Marks a serialized <see cref="BoneBurstKey" /> as naming a <see cref="Kind" /> of the skeleton in the
    ///     same object's <c>Asset</c> field. The Editor draws it as a popup of that skeleton's baked keys.
    /// </summary>
    public sealed class BoneBurstKeyOfAttribute : PropertyAttribute
    {
        public BoneBurstKeyOfAttribute(BoneBurstKeyKind kind)
        {
            Kind = kind;
        }

        public BoneBurstKeyKind Kind { get; }
    }
}