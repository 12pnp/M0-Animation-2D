using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Constraints;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using Spine;
using AnimationState = Spine.AnimationState;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P6 skin parity: random scripts of skin combining (<c>new Skin</c> + <c>AddSkin</c>, M2's <c>SpineLook</c>
    ///     pattern), skin swaps, the null skin, <c>SetupPoseSlots</c>, <c>SetAttachment</c> and in-place edits of the
    ///     current skin, while an animation plays (<c>Doc/Format/Skins-TintBlack-Culling.md</c> §1).
    /// </summary>
    /// <remarks>
    ///     Compared after every frame: each slot's attachment (by identity), sequence index, deform and colour,
    ///     bone and constraint activation, and every active bone's world transform. Files with fewer than two
    ///     skins are skipped.
    /// </remarks>
    public class SkinParityTests
    {
        private static readonly float[] s_Deltas = { 0.016666668f, 0.033333335f, 0.007f, 0.1f };

        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            return SampleCorpus.Corpus().Where(c => c.Scale != 0.37f);
        }

        [TestCaseSource(nameof(Corpus))]
        public void SkinScripts_MatchStock(SampleCorpus.Case c)
        {
            SkeletonDef def = SampleCorpus.Read(c);
            ParityDrift.BeginCase(ParityDrift.SizeOf(def, c.Scale));
            if (def.Skins.Length < 2 || def.Animations.Length == 0) Assert.Pass("fewer than two skins");

            BlobContent content = BlobBuilder.BuildContent(def, AtlasReader.Read(File.ReadAllText(c.Atlas)));
            List<string> failures = new();
            int frames = 0;
            for (int seed = 0; seed < 6 && failures.Count == 0; seed++) frames += Run(c, def, content, seed, failures);

            Assert.That(frames, Is.GreaterThan(0));
            ParityDrift.CheckFrames(failures);
            ParityDrift.WriteCaseSummary();
            Assert.IsEmpty(failures, string.Join("\n", failures.Take(20)));
        }

        private static int Run(SampleCorpus.Case c, SkeletonDef def, BlobContent content, int seed,
            List<string> failures)
        {
            SkeletonData data = AnimationParityTests.LoadStock(c, true);
            Random random = new(seed * 7919 + def.Skins.Length);
            int initial = random.Next(-1, def.Skins.Length);
            Skeleton skeleton = new(data);
            if (initial >= 0) skeleton.SetSkin(def.Skins[initial].Name);
            AnimationState state = new(new AnimationStateData(data));
            using ManagedPose mine = new(content, initial);
            BoneAnimationState track = new(new BoneAnimationStateData(content));
            CommandBuffer buffer = new();
            skeleton.UpdateWorldTransform(Physics.Update);
            mine.UpdateWorldTransform(PhysicsMode.Update);
            int animation = random.Next(def.Animations.Length);
            state.SetAnimation(0, data.Animations.Items[animation], true);
            track.SetAnimation(0, animation, true);
            int frame = 0;
            for (; frame < 120 && failures.Count == 0; frame++)
            {
                if (random.NextDouble() < 0.12) Act(random, data, content, def, skeleton, mine);
                float dt = s_Deltas[frame % s_Deltas.Length];
                state.Update(dt);
                skeleton.Update(dt);
                track.Update(dt);
                mine.Time += dt;
                state.Apply(skeleton);
                skeleton.UpdateWorldTransform(Physics.Update);
                track.Apply(buffer);
                mine.Pose(buffer);
                track.AfterApply(buffer, mine.FiredEvents(), mine.TotalAlpha, mine.Rotation);
                Compare($"seed {seed} frame {frame}", skeleton, mine, def, failures);
                ParityLockstep.CompareAndSync($"seed {seed} frame {frame}", skeleton, mine, failures);
            }

            return frame;
        }

        private static void Act(Random random, SkeletonData data, BlobContent content, SkeletonDef def,
            Skeleton skeleton, ManagedPose mine)
        {
            int skins = def.Skins.Length;
            switch (random.Next(7))
            {
                case 0:
                case 1:
                {
                    Skin combined = new("look");
                    BoneBurstSkin mineCombined = new("look", content);
                    for (int p = 1 + random.Next(4); p > 0; p--)
                    {
                        int s = random.Next(skins);
                        combined.AddSkin(data.Skins.Items[s]);
                        mineCombined.AddSkin(content.Skins[s]);
                    }

                    skeleton.SetSkin(combined);
                    mine.SetSkin(mineCombined);
                    if (random.NextDouble() < 0.6)
                    {
                        skeleton.SetupPoseSlots();
                        mine.SetupPoseSlots();
                    }

                    break;
                }
                case 2:
                {
                    int s = random.Next(-1, skins);
                    skeleton.SetSkin(s < 0 ? null : data.Skins.Items[s]);
                    mine.SetSkin(s < 0 ? null : content.Skins[s]);
                    break;
                }
                case 3:
                    skeleton.SetupPoseSlots();
                    mine.SetupPoseSlots();
                    break;
                case 4:
                {
                    int slot = random.Next(def.Slots.Length);
                    if (random.NextDouble() < 0.2)
                    {
                        skeleton.SetAttachment(def.Slots[slot].Name, null);
                        mine.SetAttachment(slot, -1);
                        break;
                    }

                    BoneBurstSkin source = mine.Skin ?? content.DefaultSkin;
                    if (source == null) break;
                    (int slot, string placeholder, int attachment)[] entries = source.Entries().ToArray();
                    if (entries.Length == 0) break;
                    (int entrySlot, string placeholder, int _) = entries[random.Next(entries.Length)];
                    int resolved = content.ResolveAttachment(mine.Skin, entrySlot, placeholder);
                    if (resolved < 0) break;
                    skeleton.SetAttachment(def.Slots[entrySlot].Name, placeholder);
                    mine.SetAttachment(entrySlot, resolved);
                    break;
                }
                case 5:
                {
                    // Edit the skin already shown: lookups follow at once, activation only after UpdateCache.
                    if (skeleton.Skin == null || mine.Skin == null || mine.Skin.Name != "look") break;
                    int s = random.Next(skins);
                    skeleton.Skin.AddSkin(data.Skins.Items[s]);
                    mine.Skin.AddSkin(content.Skins[s]);
                    if (random.NextDouble() < 0.5)
                    {
                        skeleton.UpdateCache();
                        mine.UpdateCache();
                    }

                    break;
                }
                default:
                    skeleton.SetupPose();
                    mine.SetupPose();
                    break;
            }
        }

        private static void Compare(string at, Skeleton skeleton, ManagedPose m, SkeletonDef def, List<string> failures)
        {
            ParityConditioning.Mark(skeleton, m.Content.Skeleton);
            for (int i = 0; i < def.Slots.Length; i++)
            {
                SlotPose p = skeleton.Slots.Items[i].Pose;
                SlotState s = m.Slots[i];
                if (!ParityDrift.Same("discrete.attachment", at, Identity(skeleton, p.Attachment, m) == s.Attachment &&
                                                                 p.SequenceIndex == s.SequenceIndex &&
                                                                 p.Deform.Count == s.DeformCount))
                {
                    failures.Add($"{at}: slot {def.Slots[i].Name} attachment/sequence/deform count differs");
                    return;
                }

                if (p.Deform.Count != s.DeformCount) continue; // measuring: the deform arrays do not line up
                int start = m.Content.SlotDeformStart[i];
                for (int k = 0; k < s.DeformCount; k++)
                    if (!ParityDrift.Same("deform", at, p.Deform.Items[k], m.Deform[start + k]))
                    {
                        failures.Add($"{at}: slot {def.Slots[i].Name} deform differs");
                        return;
                    }
            }

            for (int b = 0; b < def.Bones.Length; b++)
            {
                Bone bone = skeleton.Bones.Items[b];
                if (!ParityDrift.Same("discrete.active", at, bone.Active == m.BoneActive[b]))
                {
                    failures.Add($"{at}: bone {def.Bones[b].Name} activation differs");
                    return;
                }

                if (!bone.Active || !m.BoneActive[b]) continue;
                BonePose w = bone.AppliedPose;
                BoneWorld mw = m.World[b];
                if (!AnimationParityTests.SameWorld(at, def.Bones[b].Name, w, mw))
                {
                    failures.Add($"{at}: bone {def.Bones[b].Name} world differs");
                    return;
                }
            }

            for (int i = 0; i < def.Constraints.Length; i++)
                if (!ParityDrift.Same("discrete.active", at,
                        (bool)AnimationParityTests.Member(skeleton.Constraints.Items[i], "Active") ==
                        m.ConstraintActive[i]))
                {
                    failures.Add($"{at}: constraint {def.Constraints[i].Name} activation differs");
                    return;
                }
        }

        /// <summary>
        ///     A stock attachment object as BoneBurst's blob index: where a file skin stores it.
        /// </summary>
        private static int Identity(Skeleton skeleton, Attachment attachment, ManagedPose m)
        {
            if (attachment == null) return -1;
            ExposedList<Skin> skins = skeleton.Data.Skins;
            for (int s = 0; s < skins.Count; s++)
                foreach (Skin.SkinEntry e in skins.Items[s].Attachments)
                    if (ReferenceEquals(e.Attachment, attachment))
                        return m.Content.Skins[s].GetAttachment(e.SlotIndex, e.Placeholder);

            return -2;
        }
    }
}