using System;
using System.Collections.Generic;

namespace BoneBurst
{
    /// <summary>
    ///     Maps stable <see cref="BoneBurstHandle" /> slots to dense rows, with adds and removes queued and applied
    ///     in one batch.
    /// </summary>
    /// <remarks>
    ///     The 2D Animation pattern (<c>BaseDeformationSystem.BatchAddSpriteSkins / BatchRemoveSpriteSkins</c>):
    ///     structure changes only between frames, so jobs always see dense rows <c>[0, RowCount)</c> and no
    ///     per-instance bookkeeping runs inside the frame. Removal is swap-remove; <see cref="Apply" /> reports each
    ///     move so per-row native data can follow its instance.
    /// </remarks>
    internal sealed class InstanceTable
    {
        private const int Pending = -1;
        private const int Free = -2;
        private readonly Stack<int> m_FreeSlots = new();

        private readonly List<int> m_Generation = new();
        private readonly List<int> m_PendingAdds = new();
        private readonly List<int> m_PendingRemoves = new();
        private readonly List<int> m_RowOfSlot = new();
        private readonly List<int> m_SlotOfRow = new();

        /// <summary>
        ///     Live instances with a row, as of the last <see cref="Apply" />.
        /// </summary>
        public int RowCount => m_SlotOfRow.Count;

        /// <summary>
        ///     Adds and removes queued for the next <see cref="Apply" />.
        /// </summary>
        public int PendingCount => m_PendingAdds.Count + m_PendingRemoves.Count;

        /// <summary>
        ///     Reserves a slot now; the instance gets a row at the next <see cref="Apply" />.
        /// </summary>
        public BoneBurstHandle Add()
        {
            int slot;
            if (m_FreeSlots.Count > 0)
            {
                slot = m_FreeSlots.Pop();
            }
            else
            {
                slot = m_Generation.Count;
                m_Generation.Add(0);
                m_RowOfSlot.Add(Free);
            }

            int generation = m_Generation[slot] + 1;
            if (generation <= 0) generation = 1;

            m_Generation[slot] = generation;
            m_RowOfSlot[slot] = Pending;
            m_PendingAdds.Add(slot);
            return new BoneBurstHandle(slot, generation);
        }

        /// <summary>
        ///     Queues removal. The handle is stale immediately; the row is freed at the next <see cref="Apply" />.
        /// </summary>
        /// <exception cref="InvalidOperationException">The handle is None or already stale.</exception>
        public void Remove(BoneBurstHandle handle)
        {
            if (!IsAlive(handle))
                throw new InvalidOperationException($"BoneBurst: cannot remove {handle}, it is not alive.");

            if (m_RowOfSlot[handle.Slot] == Pending)
            {
                // Never got a row: cancel the add instead of queueing a remove.
                m_PendingAdds.Remove(handle.Slot);
                ReleaseSlot(handle.Slot);
                return;
            }

            m_PendingRemoves.Add(handle.Slot);
            BumpGeneration(handle.Slot);
        }

        /// <summary>
        ///     True while the handle names an instance that has not been removed.
        /// </summary>
        public bool IsAlive(BoneBurstHandle handle)
        {
            return !handle.IsNone
                   && handle.Slot < m_Generation.Count
                   && m_Generation[handle.Slot] == handle.Generation
                   && m_RowOfSlot[handle.Slot] != Free;
        }

        /// <summary>
        ///     The instance's row, or -1 while its add is still pending.
        /// </summary>
        /// <exception cref="InvalidOperationException">The handle is None or stale.</exception>
        public int RowOf(BoneBurstHandle handle)
        {
            if (!IsAlive(handle)) throw new InvalidOperationException($"BoneBurst: {handle} is not alive.");

            int row = m_RowOfSlot[handle.Slot];
            return row == Pending ? -1 : row;
        }

        /// <summary>
        ///     Applies queued removes (swap-remove), then queued adds (appended).
        /// </summary>
        /// <param name="onRowMoved">
        ///     Called as <c>(from, to)</c> each time a row's instance moves; the caller copies its per-row data. Rows at
        ///     or past the new <see cref="RowCount" /> are dead afterwards.
        /// </param>
        public void Apply(Action<int, int> onRowMoved = null)
        {
            foreach (int slot in m_PendingRemoves)
            {
                int row = m_RowOfSlot[slot];
                int last = m_SlotOfRow.Count - 1;
                if (row != last)
                {
                    int movedSlot = m_SlotOfRow[last];
                    m_SlotOfRow[row] = movedSlot;
                    m_RowOfSlot[movedSlot] = row;
                    onRowMoved?.Invoke(last, row);
                }

                m_SlotOfRow.RemoveAt(last);
                m_RowOfSlot[slot] = Free;
                m_FreeSlots.Push(slot);
            }

            m_PendingRemoves.Clear();

            foreach (int slot in m_PendingAdds)
            {
                m_RowOfSlot[slot] = m_SlotOfRow.Count;
                m_SlotOfRow.Add(slot);
            }

            m_PendingAdds.Clear();
        }

        /// <summary>
        ///     Drops every instance. All issued handles become stale.
        /// </summary>
        public void Clear()
        {
            for (int slot = 0; slot < m_Generation.Count; slot++)
                if (m_RowOfSlot[slot] != Free)
                {
                    BumpGeneration(slot);
                    m_RowOfSlot[slot] = Free;
                    m_FreeSlots.Push(slot);
                }

            m_SlotOfRow.Clear();
            m_PendingAdds.Clear();
            m_PendingRemoves.Clear();
        }

        private void ReleaseSlot(int slot)
        {
            BumpGeneration(slot);
            m_RowOfSlot[slot] = Free;
            m_FreeSlots.Push(slot);
        }

        private void BumpGeneration(int slot)
        {
            // A queued remove keeps its row until Apply, so staleness comes from the generation alone.
            int generation = m_Generation[slot] + 1;
            m_Generation[slot] = generation <= 0 ? 1 : generation;
        }
    }
}