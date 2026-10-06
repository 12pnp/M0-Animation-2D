using System.Collections.Generic;

namespace BoneBurst
{
    /// <summary>
    ///     First-fit ranges over a growing array: freed ranges merge with their neighbours and are reused.
    /// </summary>
    public sealed class RangeAllocator
    {
        private readonly List<(int start, int size)> m_Free = new();

        /// <summary>
        ///     The array length every allocation fits in.
        /// </summary>
        public int Capacity { get; private set; }

        public int Allocate(int size)
        {
            for (int i = 0; i < m_Free.Count; i++)
            {
                (int start, int free) = m_Free[i];
                if (free < size) continue;
                if (free == size) m_Free.RemoveAt(i);
                else m_Free[i] = (start + size, free - size);
                return start;
            }

            int end = Capacity;
            Capacity += size;
            return end;
        }

        public void Free(int start, int size)
        {
            int at = 0;
            while (at < m_Free.Count && m_Free[at].start < start) at++;
            m_Free.Insert(at, (start, size));
            if (at + 1 < m_Free.Count && start + size == m_Free[at + 1].start)
            {
                m_Free[at] = (start, size + m_Free[at + 1].size);
                m_Free.RemoveAt(at + 1);
            }

            if (at > 0 && m_Free[at - 1].start + m_Free[at - 1].size == start)
            {
                m_Free[at - 1] = (m_Free[at - 1].start, m_Free[at - 1].size + m_Free[at].size);
                m_Free.RemoveAt(at);
            }
        }

        public void Clear()
        {
            m_Free.Clear();
            Capacity = 0;
        }
    }
}
