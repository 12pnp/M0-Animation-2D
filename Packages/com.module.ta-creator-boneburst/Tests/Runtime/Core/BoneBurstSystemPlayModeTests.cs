using System;
using System.Collections;
using NUnit.Framework;
using UnityEngine.LowLevel;
using UnityEngine.PlayerLoop;
using UnityEngine.TestTools;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     The PlayerLoop entries of <see cref="BoneBurstSystem" /> exist, sit where plan §4 puts them, and tick.
    /// </summary>
    public class BoneBurstSystemPlayModeTests
    {
        [Test]
        public void Installed_ScheduleAfterUpdateScripts_CompleteAtEndOfPreLateUpdate()
        {
            Assert.IsTrue(BoneBurstSystem.IsInstalled);
            PlayerLoopSystem root = PlayerLoop.GetCurrentPlayerLoop();

            PlayerLoopSystem[] update = Phase(root, typeof(Update));
            int scripts = Array.FindIndex(update, s => s.type == typeof(Update.ScriptRunBehaviourUpdate));
            Assert.That(scripts, Is.GreaterThanOrEqualTo(0));
            Assert.AreEqual(typeof(BoneBurstSystem.BoneBurstSchedule), update[scripts + 1].type);

            PlayerLoopSystem[] preLate = Phase(root, typeof(PreLateUpdate));
            Assert.AreEqual(typeof(BoneBurstSystem.BoneBurstComplete), preLate[preLate.Length - 1].type);
        }

        [Test]
        public void Install_Twice_LeavesOneCopyOfEachEntry()
        {
            BoneBurstSystem.Install();
            BoneBurstSystem.Install();

            PlayerLoopSystem root = PlayerLoop.GetCurrentPlayerLoop();
            Assert.AreEqual(1, Count(Phase(root, typeof(Update)), typeof(BoneBurstSystem.BoneBurstSchedule)));
            Assert.AreEqual(1, Count(Phase(root, typeof(PreLateUpdate)), typeof(BoneBurstSystem.BoneBurstComplete)));
        }

        [UnityTest]
        public IEnumerator EveryScheduledFrameCompletes()
        {
            int scheduled = BoneBurstSystem.FramesScheduled;
            int completed = BoneBurstSystem.FramesCompleted;

            for (int i = 0; i < 5; i++) yield return null;

            int ticks = BoneBurstSystem.FramesScheduled - scheduled;
            Assert.That(ticks, Is.GreaterThanOrEqualTo(4), "the Schedule entry did not run every frame");
            Assert.AreEqual(ticks, BoneBurstSystem.FramesCompleted - completed);
        }

        [UnityTest]
        public IEnumerator AddedInstance_JoinsAtNextFrame_RemovedLeavesAtNextFrame()
        {
            int before = BoneBurstSystem.InstanceCount;
            BoneBurstHandle handle = BoneBurstSystem.Add();
            Assert.AreEqual(before, BoneBurstSystem.InstanceCount, "adds must wait for the next schedule");

            yield return null;
            Assert.AreEqual(before + 1, BoneBurstSystem.InstanceCount);

            BoneBurstSystem.Remove(handle);
            Assert.IsFalse(BoneBurstSystem.IsAlive(handle));

            yield return null;
            Assert.AreEqual(before, BoneBurstSystem.InstanceCount);
        }

        private static PlayerLoopSystem[] Phase(PlayerLoopSystem root, Type phase)
        {
            foreach (PlayerLoopSystem system in root.subSystemList)
                if (system.type == phase)
                    return system.subSystemList;

            Assert.Fail($"PlayerLoop has no {phase.Name} phase");
            return null;
        }

        private static int Count(PlayerLoopSystem[] systems, Type type)
        {
            int count = 0;
            foreach (PlayerLoopSystem system in systems)
                if (system.type == type)
                    count++;

            return count;
        }
    }
}