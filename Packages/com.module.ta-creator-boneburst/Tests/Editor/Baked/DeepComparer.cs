using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Compares two object graphs of the same types field by field (public instance fields), floats bit for bit.
    ///     Used to prove a baked round trip gives back exactly the model the reader built, without a hand-written
    ///     comparison per field that could silently miss a new one.
    /// </summary>
    /// <remarks>
    ///     Each pair of objects is visited once, so cycles (a mesh that is its own timeline attachment, a skin
    ///     pointing back at its blob) end. Fields named in <c>skip</c> as <c>Type.Field</c> are not compared.
    /// </remarks>
    internal sealed class DeepComparer
    {
        public readonly List<string> Failures = new();
        private readonly HashSet<string> m_Skip;
        private readonly HashSet<Pair> m_Visited = new();
        public int Checks;

        public DeepComparer(params string[] skip)
        {
            m_Skip = new HashSet<string>(skip);
        }

        public void Compare(string path, object a, object b)
        {
            if (Failures.Count >= 100) return;
            Checks++;
            if (a == null || b == null)
            {
                if (a != null || b != null) Fail(path, a == null ? "null" : "set", b == null ? "null" : "set");
                return;
            }

            Type type = a.GetType();
            if (type != b.GetType())
            {
                Fail(path, type.Name, b.GetType().Name);
                return;
            }

            if (type == typeof(float))
            {
                if (BitConverter.SingleToInt32Bits((float)a) != BitConverter.SingleToInt32Bits((float)b))
                    Fail(path, a, b);
                return;
            }

            if (type == typeof(double))
            {
                if (BitConverter.DoubleToInt64Bits((double)a) != BitConverter.DoubleToInt64Bits((double)b))
                    Fail(path, a, b);
                return;
            }

            if (type.IsPrimitive || type.IsEnum || type == typeof(string))
            {
                if (!a.Equals(b)) Fail(path, a, b);
                return;
            }

            if (!type.IsValueType && !m_Visited.Add(new Pair(a, b))) return;

            if (a is IDictionary)
                throw new NotSupportedException($"{path}: dictionaries are not compared; skip the field.");

            if (a is IList listA)
            {
                IList listB = (IList)b;
                if (listA.Count != listB.Count)
                {
                    Fail(path + ".Count", listA.Count, listB.Count);
                    return;
                }

                for (int i = 0; i < listA.Count; i++) Compare($"{path}[{i}]", listA[i], listB[i]);
                return;
            }

            foreach (FieldInfo field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m_Skip.Contains($"{type.Name}.{field.Name}")) continue;
                Compare($"{path}.{field.Name}", field.GetValue(a), field.GetValue(b));
            }
        }

        private void Fail(string path, object a, object b)
        {
            Failures.Add($"{path}: {Show(a)} != {Show(b)}");
        }

        private static string Show(object value)
        {
            return value is float f ? $"{f:R} (0x{BitConverter.SingleToInt32Bits(f):X8})" : value?.ToString() ?? "null";
        }

        private readonly struct Pair : IEquatable<Pair>
        {
            private readonly object m_A, m_B;

            public Pair(object a, object b)
            {
                m_A = a;
                m_B = b;
            }

            public bool Equals(Pair other)
            {
                return ReferenceEquals(m_A, other.m_A) && ReferenceEquals(m_B, other.m_B);
            }

            public override bool Equals(object obj)
            {
                return obj is Pair other && Equals(other);
            }

            public override int GetHashCode()
            {
                return RuntimeHelpers.GetHashCode(m_A) * 31 + RuntimeHelpers.GetHashCode(m_B);
            }
        }
    }
}