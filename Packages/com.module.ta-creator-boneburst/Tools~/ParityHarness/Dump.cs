using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst.ParityHarness
{
    /// <summary>
    ///     <c>run.sh --dump &lt;in&gt; &lt;out&gt;</c>: poses every Spine 4.3 export in <c>in</c> (<c>name.json</c> with
    ///     <c>name.atlas</c>) through BoneBurst's managed runtime and writes <c>out/name.poses.json</c>, for the
    ///     BoneBurst Editor to compare with its own engine (<c>Editor-BoneBurst-Src/scripts/unity-parity.ts</c>; the old
    ///     editor's <c>tests/boneburstUnity.test.ts</c> reads the same files; pipeline plan R2).
    ///     Files go across, never code.
    /// </summary>
    /// <remarks>
    ///     Each animation plays once from its start, stepped as the editor's Preview steps it: a first update of 0 s,
    ///     then 0.0337 s per frame through its duration, the track, then the physics clock, then the pose with physics
    ///     updating. Every frame records each bone's world matrix (y up, skeleton scale 1, <c>a b c d x y</c>), each
    ///     slot's colour and attachment, and the draw order. Unbaked only: the bake's name keys hash through
    ///     <c>UnityEngine.PropertyName</c>, an engine call .NET cannot make; the bake round trip runs in the Editor
    ///     (<c>BakedDataTests</c>).
    /// </remarks>
    internal static class Dump
    {
        /// <summary>
        ///     Not 1/30: keys sit on multiples of 1/30 (and 1/24, 1/60), and a frame landing on an attachment key is
        ///     a float32-against-float64 coin toss between the two runtimes, not a difference in them.
        /// </summary>
        private const float Step = 0.0337f;

        public static int Run(string inDir, string outDir)
        {
            Directory.CreateDirectory(outDir);
            string[] files = Directory.GetFiles(inDir, "*.json").OrderBy(f => f, StringComparer.Ordinal).ToArray();
            if (files.Length == 0)
            {
                Console.WriteLine($"DUMP: no .json in {inDir}");
                return 1;
            }

            int bad = 0;
            foreach (string json in files)
            {
                string name = Path.GetFileNameWithoutExtension(json);
                try
                {
                    SkeletonDef def = SkeletonJsonReader.Read(File.ReadAllText(json), 1f);
                    AtlasDef atlas = AtlasReader.Read(File.ReadAllText(Path.Combine(inDir, name + ".atlas")));
                    string poses = Poses(def, BlobBuilder.BuildContent(def, atlas));
                    File.WriteAllText(Path.Combine(outDir, name + ".poses.json"),
                        $"{{\"name\":{Quote(name)},\"animations\":{poses}}}");
                    Console.WriteLine($"DUMP {name}: {def.Animations.Length} animations");
                }
                catch (Exception e)
                {
                    Console.WriteLine($"DUMP {name}: FAILED {e}");
                    bad++;
                }
            }

            return bad == 0 ? 0 : 1;
        }

        /// <summary>
        ///     Every animation's frames, as a JSON object keyed by animation name.
        /// </summary>
        private static string Poses(SkeletonDef def, BlobContent content)
        {
            StringBuilder s = new("{");
            for (int a = 0; a < def.Animations.Length; a++)
            {
                if (a > 0) s.Append(',');
                s.Append(Quote(def.Animations[a].Name)).Append(":[");
                using ManagedPose pose = new(content, -1);
                BoneAnimationState track = new(new BoneAnimationStateData(content));
                CommandBuffer buffer = new();
                track.SetAnimation(0, a, false);
                int count = Math.Max(1, (int)Math.Round(def.Animations[a].Duration / Step) + 1);
                for (int f = 0; f < count; f++)
                {
                    float dt = f == 0 ? 0 : Step;
                    track.Update(dt);
                    pose.Time += dt;
                    track.Apply(buffer);
                    pose.Pose(buffer);
                    track.AfterApply(buffer, pose.FiredEvents(), pose.TotalAlpha, pose.Rotation);
                    if (f > 0) s.Append(',');
                    Frame(s, pose);
                }

                s.Append(']');
            }

            return s.Append('}').ToString();
        }

        private static void Frame(StringBuilder s, ManagedPose pose)
        {
            s.Append("{\"w\":[");
            for (int i = 0; i < pose.World.Length; i++)
            {
                BoneWorld w = pose.World[i];
                if (i > 0) s.Append(',');
                if (!pose.BoneActive[i])
                {
                    s.Append("null");
                    continue;
                }

                s.Append('[').Append(F(w.A)).Append(',').Append(F(w.B)).Append(',').Append(F(w.C)).Append(',')
                    .Append(F(w.D)).Append(',').Append(F(w.X)).Append(',').Append(F(w.Y)).Append(']');
            }

            s.Append("],\"c\":[");
            for (int i = 0; i < pose.Slots.Length; i++)
            {
                SlotState slot = pose.Slots[i];
                if (i > 0) s.Append(',');
                s.Append('[').Append(F(slot.Color.x)).Append(',').Append(F(slot.Color.y)).Append(',')
                    .Append(F(slot.Color.z)).Append(',').Append(F(slot.Color.w)).Append(']');
            }

            s.Append("],\"a\":[");
            for (int i = 0; i < pose.Slots.Length; i++)
            {
                int attachment = pose.Slots[i].Attachment;
                if (i > 0) s.Append(',');
                s.Append(attachment < 0 ? "null" : Quote(pose.Content.AttachmentDefs[attachment].Name));
            }

            s.Append("],\"o\":[").Append(string.Join(",", pose.DrawOrder)).Append("]}");
        }

        private static string F(float v)
        {
            return float.IsFinite(v) ? v.ToString("R", CultureInfo.InvariantCulture) : "null";
        }

        private static string Quote(string v)
        {
            StringBuilder s = new("\"");
            foreach (char ch in v)
                s.Append(ch switch
                {
                    '"' => "\\\"",
                    '\\' => "\\\\",
                    < ' ' => $"\\u{(int)ch:x4}",
                    _ => ch.ToString()
                });
            return s.Append('"').ToString();
        }
    }
}
