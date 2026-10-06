using System;
using UnityEngine;

namespace BoneBurst
{
    /// <summary>
    ///     A name as an int: serializes the string, derives the id with <see cref="PropertyName" />, exactly as
    ///     M2-Creator-All's <c>ModuleP1.PropertyString</c> does, so the same name gives the same int in both.
    /// </summary>
    /// <remarks>
    ///     Only the string is serialized. The id is computed from it at run time, the way <c>PropertyString</c>
    ///     does; the empty string is id 0. <see cref="BoneBurstKeyTable" /> guarantees ids are unique per skeleton.
    /// </remarks>
    [Serializable]
    public struct BoneBurstKey : IEquatable<BoneBurstKey>
    {
        public const int EmptyId = 0;

        [SerializeField]
        private string m_String;

        public BoneBurstKey(string value)
        {
            m_String = value ?? string.Empty;
        }

        public string String => m_String ?? string.Empty;

        public bool IsEmpty => string.IsNullOrEmpty(m_String);

        public int Id => IdOf(m_String);

        /// <summary>
        ///     The id of <paramref name="value" />: <c>new PropertyName(value).GetHashCode()</c>, 0 when empty.
        /// </summary>
        public static int IdOf(string value)
        {
            return string.IsNullOrEmpty(value) ? EmptyId : new PropertyName(value).GetHashCode();
        }

        public static implicit operator BoneBurstKey(string value)
        {
            return new BoneBurstKey(value);
        }

        public bool Equals(BoneBurstKey other)
        {
            return Id == other.Id;
        }

        public override bool Equals(object obj)
        {
            return obj is BoneBurstKey other && Equals(other);
        }

        public override int GetHashCode()
        {
            return Id;
        }

        public static bool operator ==(BoneBurstKey lhs, BoneBurstKey rhs)
        {
            return lhs.Id == rhs.Id;
        }

        public static bool operator !=(BoneBurstKey lhs, BoneBurstKey rhs)
        {
            return lhs.Id != rhs.Id;
        }

        public override string ToString()
        {
            return String;
        }
    }
}