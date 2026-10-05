using System;
using System.Collections.Generic;
using NUnit.Framework;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Batched add/remove and handle staleness of <see cref="InstanceTable" />.
    /// </summary>
    public class InstanceTableTests
    {
        [Test]
        public void Add_GetsRowOnlyAfterApply()
        {
            InstanceTable table = new();
            BoneBurstHandle handle = table.Add();

            Assert.IsTrue(table.IsAlive(handle));
            Assert.AreEqual(-1, table.RowOf(handle));
            Assert.AreEqual(0, table.RowCount);
            Assert.AreEqual(1, table.PendingCount);

            table.Apply();

            Assert.AreEqual(0, table.RowOf(handle));
            Assert.AreEqual(1, table.RowCount);
            Assert.AreEqual(0, table.PendingCount);
        }

        [Test]
        public void Remove_SwapsLastRowIntoHole_AndReportsTheMove()
        {
            InstanceTable table = new();
            BoneBurstHandle a = table.Add();
            BoneBurstHandle b = table.Add();
            BoneBurstHandle c = table.Add();
            table.Apply();

            table.Remove(a);
            List<(int from, int to)> moves = new();
            table.Apply((from, to) => moves.Add((from, to)));

            Assert.AreEqual(2, table.RowCount);
            Assert.AreEqual(1, moves.Count);
            Assert.AreEqual((2, 0), moves[0]);
            Assert.AreEqual(0, table.RowOf(c));
            Assert.AreEqual(1, table.RowOf(b));
        }

        [Test]
        public void Remove_LastRow_MovesNothing()
        {
            InstanceTable table = new();
            BoneBurstHandle a = table.Add();
            BoneBurstHandle b = table.Add();
            table.Apply();

            table.Remove(b);
            int moves = 0;
            table.Apply((from, to) => moves++);

            Assert.AreEqual(0, moves);
            Assert.AreEqual(1, table.RowCount);
            Assert.AreEqual(0, table.RowOf(a));
        }

        [Test]
        public void Remove_IsStaleAtOnce_EvenBeforeApply()
        {
            InstanceTable table = new();
            BoneBurstHandle handle = table.Add();
            table.Apply();

            table.Remove(handle);

            Assert.IsFalse(table.IsAlive(handle));
            Assert.Throws<InvalidOperationException>(() => table.RowOf(handle));
            Assert.Throws<InvalidOperationException>(() => table.Remove(handle));
        }

        [Test]
        public void RemoveBeforeApply_CancelsTheAdd()
        {
            InstanceTable table = new();
            BoneBurstHandle handle = table.Add();
            table.Remove(handle);

            Assert.AreEqual(0, table.PendingCount);
            table.Apply();
            Assert.AreEqual(0, table.RowCount);
        }

        [Test]
        public void ReusedSlot_DoesNotReviveOldHandle()
        {
            InstanceTable table = new();
            BoneBurstHandle old = table.Add();
            table.Apply();
            table.Remove(old);
            table.Apply();

            BoneBurstHandle reused = table.Add();

            Assert.AreEqual(old.Slot, reused.Slot, "the freed slot should be reused");
            Assert.AreNotEqual(old, reused);
            Assert.IsFalse(table.IsAlive(old));
            Assert.IsTrue(table.IsAlive(reused));
        }

        [Test]
        public void None_IsNeverAlive()
        {
            InstanceTable table = new();
            table.Add();
            table.Apply();

            Assert.IsTrue(BoneBurstHandle.None.IsNone);
            Assert.IsFalse(table.IsAlive(BoneBurstHandle.None));
            Assert.IsFalse(table.IsAlive(default));
        }

        [Test]
        public void Clear_StalesEveryHandle()
        {
            InstanceTable table = new();
            BoneBurstHandle live = table.Add();
            table.Apply();
            BoneBurstHandle pending = table.Add();

            table.Clear();

            Assert.AreEqual(0, table.RowCount);
            Assert.AreEqual(0, table.PendingCount);
            Assert.IsFalse(table.IsAlive(live));
            Assert.IsFalse(table.IsAlive(pending));
        }

        [Test]
        public void ManyRemoves_KeepRowsDenseAndConsistent()
        {
            InstanceTable table = new();
            List<BoneBurstHandle> handles = new();
            for (int i = 0; i < 64; i++) handles.Add(table.Add());

            table.Apply();

            List<BoneBurstHandle> kept = new();
            for (int i = 0; i < handles.Count; i++)
                if (i % 3 == 0)
                    table.Remove(handles[i]);
                else
                    kept.Add(handles[i]);

            table.Apply();

            Assert.AreEqual(kept.Count, table.RowCount);
            HashSet<int> rows = new();
            foreach (BoneBurstHandle handle in kept)
            {
                int row = table.RowOf(handle);
                Assert.That(row, Is.InRange(0, table.RowCount - 1));
                Assert.IsTrue(rows.Add(row), $"row {row} is held by two instances");
            }
        }
    }
}