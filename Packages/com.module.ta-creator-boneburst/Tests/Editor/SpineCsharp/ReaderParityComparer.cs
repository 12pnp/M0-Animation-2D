using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using BoneBurst.Data;
using Spine;
using Inherit = Spine.Inherit;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Compares a <see cref="SkeletonDef" /> (and <see cref="AtlasDef" />) field by field against what stock
    ///     spine-csharp reads from the same file, the parity oracle. Floats must match bit for bit.
    /// </summary>
    /// <remarks>
    ///     Stock members are read by reflection where its 4.3 API hides them behind setup-pose objects, so this file
    ///     never needs the stock runtime's internals at compile time. Only tests reference spine-csharp.
    /// </remarks>
    internal sealed class ReaderParityComparer
    {
        private static readonly Dictionary<TimelineKind, string> s_ClassOf = new()
        {
            [TimelineKind.SlotAttachment] = "AttachmentTimeline", [TimelineKind.SlotRgba] = "RGBATimeline",
            [TimelineKind.SlotRgb] = "RGBTimeline",
            [TimelineKind.SlotRgba2] = "RGBA2Timeline", [TimelineKind.SlotRgb2] = "RGB2Timeline",
            [TimelineKind.SlotAlpha] = "AlphaTimeline",
            [TimelineKind.BoneRotate] = "RotateTimeline", [TimelineKind.BoneTranslate] = "TranslateTimeline",
            [TimelineKind.BoneTranslateX] = "TranslateXTimeline",
            [TimelineKind.BoneTranslateY] = "TranslateYTimeline", [TimelineKind.BoneScale] = "ScaleTimeline",
            [TimelineKind.BoneScaleX] = "ScaleXTimeline",
            [TimelineKind.BoneScaleY] = "ScaleYTimeline", [TimelineKind.BoneShear] = "ShearTimeline",
            [TimelineKind.BoneShearX] = "ShearXTimeline",
            [TimelineKind.BoneShearY] = "ShearYTimeline", [TimelineKind.BoneInherit] = "InheritTimeline",
            [TimelineKind.Ik] = "IkConstraintTimeline",
            [TimelineKind.Transform] = "TransformConstraintTimeline",
            [TimelineKind.PathPosition] = "PathConstraintPositionTimeline",
            [TimelineKind.PathSpacing] = "PathConstraintSpacingTimeline",
            [TimelineKind.PathMix] = "PathConstraintMixTimeline",
            [TimelineKind.PhysicsInertia] = "PhysicsConstraintInertiaTimeline",
            [TimelineKind.PhysicsStrength] = "PhysicsConstraintStrengthTimeline",
            [TimelineKind.PhysicsDamping] = "PhysicsConstraintDampingTimeline",
            [TimelineKind.PhysicsMass] = "PhysicsConstraintMassTimeline",
            [TimelineKind.PhysicsWind] = "PhysicsConstraintWindTimeline",
            [TimelineKind.PhysicsGravity] = "PhysicsConstraintGravityTimeline",
            [TimelineKind.PhysicsMix] = "PhysicsConstraintMixTimeline",
            [TimelineKind.PhysicsReset] = "PhysicsConstraintResetTimeline",
            [TimelineKind.SliderTime] = "SliderTimeline", [TimelineKind.SliderMix] = "SliderMixTimeline",
            [TimelineKind.Deform] = "DeformTimeline",
            [TimelineKind.Sequence] = "SequenceTimeline", [TimelineKind.DrawOrder] = "DrawOrderTimeline",
            [TimelineKind.DrawOrderFolder] = "DrawOrderFolderTimeline",
            [TimelineKind.Event] = "EventTimeline"
        };

        public readonly List<string> Failures = new();
        public int Checks;

        private SkeletonData m_Current;

        // ---------------------------------------------------------------- comparison

        public void Compare(SkeletonData s, SkeletonDef m)
        {
            m_Current = s;
            Eq("hash", s.Hash, m.Hash);
            Eq("version", s.Version, m.Version);
            Eq("x", s.X, m.X);
            Eq("y", s.Y, m.Y);
            Eq("width", s.Width, m.Width);
            Eq("height", s.Height, m.Height);
            Eq("referenceScale", s.ReferenceScale, m.ReferenceScale);
            Eq("fps", s.Fps, m.Fps);

            Eq("bone count", s.Bones.Count, m.Bones.Length);
            for (int i = 0; i < Math.Min(s.Bones.Count, m.Bones.Length); i++)
            {
                BoneData b = s.Bones.Items[i];
                BoneDef mb = m.Bones[i];
                string at = $"bone {i} {b.Name}";
                Eq(at + " name", b.Name, mb.Name);
                Eq(at + " parent", b.Parent?.Index ?? -1, mb.Parent);
                Eq(at + " length", b.Length, mb.Length);
                Eq(at + " skinRequired", b.SkinRequired, mb.SkinRequired);
                object p = Setup(b);
                Eq(at + " x", P<float>(p, "X"), mb.X);
                Eq(at + " y", P<float>(p, "Y"), mb.Y);
                Eq(at + " rotation", P<float>(p, "Rotation"), mb.Rotation);
                Eq(at + " scaleX", P<float>(p, "ScaleX"), mb.ScaleX);
                Eq(at + " scaleY", P<float>(p, "ScaleY"), mb.ScaleY);
                Eq(at + " shearX", P<float>(p, "ShearX"), mb.ShearX);
                Eq(at + " shearY", P<float>(p, "ShearY"), mb.ShearY);
                Eq(at + " inherit", (int)P<Inherit>(p, "Inherit"), (int)mb.Inherit);
            }

            Eq("slot count", s.Slots.Count, m.Slots.Length);
            for (int i = 0; i < Math.Min(s.Slots.Count, m.Slots.Length); i++)
            {
                SlotData d = s.Slots.Items[i];
                SlotDef ms = m.Slots[i];
                string at = $"slot {i} {d.Name}";
                Eq(at + " name", d.Name, ms.Name);
                Eq(at + " bone", d.BoneData.Index, ms.Bone);
                Eq(at + " attachment", d.AttachmentName, ms.AttachmentName);
                Eq(at + " blend", (int)d.BlendMode, (int)ms.Blend);
                object pose = Setup(d);
                object color = Call(pose, "GetColor");
                Eq(at + " color", new[] { F(color, "r"), F(color, "g"), F(color, "b"), F(color, "a") },
                    new[] { ms.Color.x, ms.Color.y, ms.Color.z, ms.Color.w });
                object dark = Call(pose, "GetDarkColor");
                Eq(at + " hasDark", dark != null, ms.HasDarkColor);
                if (dark != null && ms.HasDarkColor)
                    Eq(at + " dark", new[] { F(dark, "r"), F(dark, "g"), F(dark, "b") },
                        new[] { ms.DarkColor.x, ms.DarkColor.y, ms.DarkColor.z });
            }

            Eq("constraint count", s.Constraints.Count, m.Constraints.Length);
            for (int i = 0; i < Math.Min(s.Constraints.Count, m.Constraints.Length); i++)
                CompareConstraint(i, s.Constraints.Items[i], m.Constraints[i]);

            Eq("skin count", s.Skins.Count, m.Skins.Length);
            Eq("default skin", s.DefaultSkin?.Name, m.DefaultSkin?.Name);
            for (int i = 0; i < Math.Min(s.Skins.Count, m.Skins.Length); i++)
                CompareSkin(i, s.Skins.Items[i], m.Skins[i]);

            Eq("event count", s.Events.Count, m.Events.Length);
            for (int i = 0; i < Math.Min(s.Events.Count, m.Events.Length); i++)
            {
                EventData e = s.Events.Items[i];
                EventDef me = m.Events[i];
                string at = $"event {e.Name}";
                Eq(at + " name", e.Name, me.Name);
                Eq(at + " audio", e.AudioPath, me.AudioPath);
                object sp = e.SetupPose;
                Eq(at + " int", P<int>(sp, "Int"), me.Int);
                Eq(at + " float", P<float>(sp, "Float"), me.Float);
                Eq(at + " string", P<string>(sp, "String"), me.String);
                Eq(at + " volume", P<float>(sp, "Volume"), me.Volume);
                Eq(at + " balance", P<float>(sp, "Balance"), me.Balance);
            }

            Eq("animation count", s.Animations.Count, m.Animations.Length);
            for (int i = 0; i < Math.Min(s.Animations.Count, m.Animations.Length); i++)
                CompareAnimation(s.Animations.Items[i], m.Animations[i], m);
        }

        private void CompareConstraint(int i, object s, ConstraintDef m)
        {
            string at = $"constraint {i} {P<string>(s, "Name")}";
            Eq(at + " name", P<string>(s, "Name"), m.Name);
            string expected = m.Kind switch
            {
                ConstraintKind.Ik => "IkConstraintData", ConstraintKind.Path => "PathConstraintData",
                ConstraintKind.Transform => "TransformConstraintData",
                ConstraintKind.Physics => "PhysicsConstraintData",
                _ => "SliderData"
            };
            Eq(at + " kind", s.GetType().Name, expected);
            if (s.GetType().Name != expected) return;
            Eq(at + " skinRequired", P<bool>(s, "SkinRequired"), m.SkinRequired);
            object pose = Setup(s);
            switch (m)
            {
                case IkDef ik:
                    Eq(at + " bones", BoneIndices(s, "Bones"), ik.Bones);
                    Eq(at + " target", P<object>(s, "Target") is BoneData tb ? tb.Index : -1, ik.Target);
                    Eq(at + " scaleYMode", Convert.ToInt32(P<object>(s, "ScaleY") ?? -1), (int)ik.ScaleYMode);
                    Eq(at + " mix", P<float>(pose, "Mix"), ik.Mix);
                    Eq(at + " softness", P<float>(pose, "Softness"), ik.Softness);
                    Eq(at + " bend", P<int>(pose, "BendDirection"), ik.BendDirection);
                    Eq(at + " compress", P<bool>(pose, "Compress"), ik.Compress);
                    Eq(at + " stretch", P<bool>(pose, "Stretch"), ik.Stretch);
                    break;
                case TransformDef t:
                    Eq(at + " bones", BoneIndices(s, "Bones"), t.Bones);
                    Eq(at + " source", P<object>(s, "Source") is BoneData src ? src.Index : -1, t.Source);
                    Eq(at + " flags",
                        new[]
                        {
                            P<bool>(s, "LocalSource"), P<bool>(s, "LocalTarget"), P<bool>(s, "Additive"),
                            P<bool>(s, "Clamp")
                        },
                        new[] { t.LocalSource, t.LocalTarget, t.Additive, t.Clamp });
                    Eq(at + " offsets",
                        new[]
                        {
                            P<float>(s, "OffsetRotation"), P<float>(s, "OffsetX"), P<float>(s, "OffsetY"),
                            P<float>(s, "OffsetScaleX"), P<float>(s, "OffsetScaleY"), P<float>(s, "OffsetShearY")
                        },
                        new[]
                        {
                            t.OffsetRotation, t.OffsetX, t.OffsetY, t.OffsetScaleX, t.OffsetScaleY, t.OffsetShearY
                        });
                    Eq(at + " mixes",
                        new[]
                        {
                            P<float>(pose, "MixRotate"), P<float>(pose, "MixX"), P<float>(pose, "MixY"),
                            P<float>(pose, "MixScaleX"), P<float>(pose, "MixScaleY"), P<float>(pose, "MixShearY")
                        },
                        new[] { t.MixRotate, t.MixX, t.MixY, t.MixScaleX, t.MixScaleY, t.MixShearY });
                    IList props = AsList(P<object>(s, "Properties"));
                    Eq(at + " from count", props?.Count ?? -1, t.From.Length);
                    for (int k = 0; props != null && k < Math.Min(props.Count, t.From.Length); k++)
                    {
                        object from = props[k];
                        Eq(at + $" from{k} offset", P<float>(from, "offset"), t.From[k].Offset);
                        IList to = AsList(P<object>(from, "to"));
                        Eq(at + $" from{k} to count", to?.Count ?? -1, t.From[k].To.Length);
                        for (int j = 0; to != null && j < Math.Min(to.Count, t.From[k].To.Length); j++)
                            Eq(at + $" from{k} to{j}",
                                new[] { P<float>(to[j], "offset"), P<float>(to[j], "max"), P<float>(to[j], "scale") },
                                new[] { t.From[k].To[j].Offset, t.From[k].To[j].Max, t.From[k].To[j].Scale });
                    }

                    break;
                case PathConstraintDef p:
                    Eq(at + " bones", BoneIndices(s, "Bones"), p.Bones);
                    Eq(at + " slot", P<object>(s, "Slot") is SlotData sl ? sl.Index : -1, p.Slot);
                    Eq(at + " modes",
                        new[]
                        {
                            Convert.ToInt32(P<object>(s, "PositionMode")), Convert.ToInt32(P<object>(s, "SpacingMode")),
                            Convert.ToInt32(P<object>(s, "RotateMode"))
                        },
                        new[] { (int)p.PositionMode, (int)p.SpacingMode, (int)p.RotateMode });
                    Eq(at + " offsetRotation", P<float>(s, "OffsetRotation"), p.OffsetRotation);
                    Eq(at + " pose",
                        new[]
                        {
                            P<float>(pose, "Position"), P<float>(pose, "Spacing"), P<float>(pose, "MixRotate"),
                            P<float>(pose, "MixX"), P<float>(pose, "MixY")
                        },
                        new[] { p.Position, p.Spacing, p.MixRotate, p.MixX, p.MixY });
                    break;
                case PhysicsDef ph:
                    Eq(at + " bone", P<object>(s, "Bone") is BoneData pb ? pb.Index : -1, ph.Bone);
                    Eq(at + " scaleYMode", Convert.ToInt32(P<object>(s, "ScaleYMode") ?? -1), (int)ph.ScaleYMode);
                    Eq(at + " data",
                        new[]
                        {
                            P<float>(s, "X"), P<float>(s, "Y"), P<float>(s, "Rotate"), P<float>(s, "ScaleX"),
                            P<float>(s, "ShearX"), P<float>(s, "Limit"), P<float>(s, "Step")
                        },
                        new[] { ph.X, ph.Y, ph.Rotate, ph.ScaleX, ph.ShearX, ph.Limit, ph.Step });
                    Eq(at + " pose",
                        new[]
                        {
                            P<float>(pose, "Inertia"), P<float>(pose, "Strength"), P<float>(pose, "Damping"),
                            P<float>(pose, "MassInverse"), P<float>(pose, "Wind"), P<float>(pose, "Gravity"),
                            P<float>(pose, "Mix")
                        },
                        new[] { ph.Inertia, ph.Strength, ph.Damping, ph.MassInverse, ph.Wind, ph.Gravity, ph.Mix });
                    Eq(at + " globals",
                        new[]
                        {
                            P<bool>(s, "InertiaGlobal"), P<bool>(s, "StrengthGlobal"), P<bool>(s, "DampingGlobal"),
                            P<bool>(s, "MassGlobal"), P<bool>(s, "WindGlobal"), P<bool>(s, "GravityGlobal"),
                            P<bool>(s, "MixGlobal")
                        },
                        new[]
                        {
                            ph.InertiaGlobal, ph.StrengthGlobal, ph.DampingGlobal, ph.MassGlobal, ph.WindGlobal,
                            ph.GravityGlobal, ph.MixGlobal
                        });
                    break;
                case SliderDef sd:
                    Eq(at + " loop/additive/local",
                        new[] { P<bool>(s, "Loop"), P<bool>(s, "Additive"), P<bool>(s, "Local") },
                        new[] { sd.Loop, sd.Additive, sd.Local });
                    Eq(at + " animation", P<object>(s, "Animation") is Animation an ? AnimIndex(an) : -1, sd.Animation);
                    Eq(at + " bone", P<object>(s, "Bone") is BoneData sb ? sb.Index : -1, sd.Bone);
                    Eq(at + " time/mix", new[] { P<float>(pose, "Time"), P<float>(pose, "Mix") },
                        new[] { sd.Time, sd.Mix });
                    Eq(at + " offset/scale", new[] { P<float>(s, "Offset"), P<float>(s, "Scale") },
                        new[] { sd.Offset, sd.Scale });
                    break;
            }
        }

        private int AnimIndex(Animation a)
        {
            return m_Current == null ? -2 : m_Current.Animations.IndexOf(a);
        }

        private void CompareSkin(int index, Skin s, SkinDef m)
        {
            string at = $"skin {s.Name}";
            Eq(at + " name", s.Name, m.Name);
            Eq(at + " bones", s.Bones.Items.Take(s.Bones.Count).Select(b => b.Index).ToArray(), m.Bones);
            Eq(at + " entry count", s.Attachments.Count, m.Entries.Count);
            foreach (SkinEntry e in m.Entries)
            {
                Attachment sa = s.GetAttachment(e.Slot, e.Placeholder);
                string where = $"{at} [{e.Slot}:{e.Placeholder}]";
                if (sa == null)
                {
                    Fail(where + " missing in stock");
                    continue;
                }

                CompareAttachment(where, sa, e.Attachment);
            }
        }

        private void CompareAttachment(string at, Attachment s, AttachmentDef m)
        {
            Checks++;
            Eq(at + " name", s.Name, m.Name);
            string expected = m switch
            {
                RegionDef => "RegionAttachment", MeshDef => "MeshAttachment", BoundingBoxDef => "BoundingBoxAttachment",
                PathAttachmentDef => "PathAttachment", PointDef => "PointAttachment",
                ClippingDef => "ClippingAttachment", _ => "?"
            };
            Eq(at + " type", s.GetType().Name, expected);
            switch (m)
            {
                case RegionDef r:
                    Eq(at + " path", P<string>(s, "Path"), r.Path);
                    Eq(at + " values",
                        new[]
                        {
                            P<float>(s, "X"), P<float>(s, "Y"), P<float>(s, "Rotation"), P<float>(s, "ScaleX"),
                            P<float>(s, "ScaleY"), P<float>(s, "Width"), P<float>(s, "Height")
                        },
                        new[] { r.X, r.Y, r.Rotation, r.ScaleX, r.ScaleY, r.Width, r.Height });
                    CompareSequence(at, P<object>(s, "Sequence"), r.Sequence);
                    break;
                case PointDef p:
                    Eq(at + " values", new[] { P<float>(s, "X"), P<float>(s, "Y"), P<float>(s, "Rotation") },
                        new[] { p.X, p.Y, p.Rotation });
                    break;
            }

            if (m is VertexAttachmentDef v && s is VertexAttachment sv)
            {
                Eq(at + " bones", sv.Bones, v.Bones);
                Eq(at + " vertices", sv.Vertices, v.Vertices);
                Eq(at + " worldVerticesLength", sv.WorldVerticesLength, v.WorldVerticesLength);
                Eq(at + " timelineAttachment is self", ReferenceEquals(sv.TimelineAttachment, sv),
                    ReferenceEquals(v.TimelineAttachment, v));
                if (m is MeshDef mesh && s is MeshAttachment sm)
                {
                    Eq(at + " path", sm.Path, mesh.Path);
                    Eq(at + " uvs", sm.RegionUVs, mesh.RegionUVs);
                    Eq(at + " triangles", sm.Triangles, mesh.Triangles);
                    Eq(at + " hull", sm.HullLength, mesh.HullLength);
                    Eq(at + " linked", (P<object>(sm, "ParentMesh") ?? P<object>(sm, "SourceMesh")) != null,
                        mesh.SourceMesh != null);
                    Eq(at + " color",
                        new[]
                        {
                            F(sm.GetColor(), "r"), F(sm.GetColor(), "g"), F(sm.GetColor(), "b"), F(sm.GetColor(), "a")
                        }, new[] { mesh.Color.x, mesh.Color.y, mesh.Color.z, mesh.Color.w });
                    CompareSequence(at, sm.Sequence, mesh.Sequence);
                }

                if (m is ClippingDef c)
                    Eq(at + " endSlot", ((ClippingAttachment)s).EndSlot?.Index ?? -1, c.EndSlot);
                if (m is PathAttachmentDef pa)
                {
                    Eq(at + " lengths", ((PathAttachment)s).Lengths, pa.Lengths);
                    Eq(at + " closed/cs", new[] { ((PathAttachment)s).Closed, ((PathAttachment)s).ConstantSpeed },
                        new[] { pa.Closed, pa.ConstantSpeed });
                }
            }
        }

        private void CompareSequence(string at, object s, SequenceDef m)
        {
            if (s == null)
            {
                Fail(at + " stock has no sequence");
                return;
            }

            Eq(at + " sequence",
                new[]
                {
                    P<int>(s, "Start"), P<int>(s, "Digits"), P<int>(s, "SetupIndex"),
                    AsList(P<object>(s, "Regions"))?.Count ?? -1
                },
                new[] { m.Start, m.Digits, m.SetupIndex, m.Count });
        }

        private void CompareAnimation(Animation s, AnimationDef m, SkeletonDef skeleton)
        {
            string at = $"anim {s.Name}";
            Eq(at + " name", s.Name, m.Name);
            Eq(at + " duration", s.Duration, m.Duration);
            Eq(at + " timeline count", s.Timelines.Count, m.Timelines.Count);
            for (int i = 0; i < Math.Min(s.Timelines.Count, m.Timelines.Count); i++)
            {
                Timeline st = s.Timelines.Items[i];
                TimelineDef mt = m.Timelines[i];
                string tat = $"{at} tl{i} {mt.Kind}";
                Eq(tat + " class", st.GetType().Name, s_ClassOf[mt.Kind]);
                if (st.GetType().Name != s_ClassOf[mt.Kind]) continue;
                Eq(tat + " frames", st.Frames, mt.Frames);
                object curves = Field(st, "curves");
                if (curves != null || mt.Curves != null) Eq(tat + " curves", (float[])curves, mt.Curves);
                object target = P<object>(st, "BoneIndex") ??
                                P<object>(st, "SlotIndex") ?? P<object>(st, "ConstraintIndex");
                if (target != null) Eq(tat + " target", Convert.ToInt32(target), mt.Target);
                switch (mt.Kind)
                {
                    case TimelineKind.SlotAttachment:
                        Eq(tat + " names", ((AttachmentTimeline)st).AttachmentNames, mt.AttachmentNames); break;
                    case TimelineKind.Deform:
                        float[][] sv = ((DeformTimeline)st).Vertices;
                        for (int f = 0; f < sv.Length; f++) Eq(tat + $" deform{f}", sv[f], mt.Deform[f]);
                        Eq(tat + " attachment", ((DeformTimeline)st).Attachment.Name, mt.Attachment.Name);
                        break;
                    case TimelineKind.DrawOrder:
                        int[][] so = ((DrawOrderTimeline)st).DrawOrders;
                        for (int f = 0; f < so.Length; f++) Eq(tat + $" order{f}", so[f], mt.DrawOrders[f]);
                        break;
                    case TimelineKind.DrawOrderFolder:
                        Eq(tat + " slots", P<int[]>(st, "Slots"), mt.FolderSlots);
                        int[][] fo = P<int[][]>(st, "DrawOrders");
                        for (int f = 0; f < fo.Length; f++) Eq(tat + $" order{f}", fo[f], mt.DrawOrders[f]);
                        break;
                    case TimelineKind.Event:
                        Event[] se = ((EventTimeline)st).Events;
                        for (int f = 0; f < se.Length; f++)
                        {
                            EventFrame me = mt.Events[f];
                            Eq(tat + $" event{f}",
                                new object[]
                                {
                                    se[f].Time, se[f].Data.Name, se[f].Int, se[f].Float, se[f].String, se[f].Volume,
                                    se[f].Balance
                                },
                                new object[]
                                {
                                    me.Time, skeleton.Events[me.Event].Name, me.Int, me.Float, me.String, me.Volume,
                                    me.Balance
                                });
                        }

                        break;
                }
            }
        }

        public void CompareAtlas(Atlas s, AtlasDef m)
        {
            IList pages = AsList(Member(s, "pages"));
            IList regions = AsList(Member(s, "regions"));
            Eq("atlas pages", pages.Count, m.Pages.Count);
            for (int i = 0; i < Math.Min(pages.Count, m.Pages.Count); i++)
            {
                object p = pages[i];
                AtlasPageDef mp = m.Pages[i];
                Eq($"page {i} name", P<string>(p, "name"), mp.Name);
                Eq($"page {i} size", new[] { P<int>(p, "width"), P<int>(p, "height") }, new[] { mp.Width, mp.Height });
                Eq($"page {i} pma", P<bool>(p, "pma"), mp.Pma);
            }

            Eq("atlas regions", regions.Count, m.Regions.Count);
            for (int i = 0; i < Math.Min(regions.Count, m.Regions.Count); i++)
            {
                object r = regions[i];
                AtlasRegionDef mr = m.Regions[i];
                string at = $"region {P<string>(r, "name")}";
                Eq(at + " name", P<string>(r, "name"), mr.Name);
                Eq(at + " page", pages.IndexOf(Member(r, "page")), mr.Page);
                Eq(at + " ints",
                    new[]
                    {
                        P<int>(r, "x"), P<int>(r, "y"), P<int>(r, P<int>(r, "degrees") == 90 ? "height" : "width"),
                        P<int>(r, P<int>(r, "degrees") == 90 ? "width" : "height"), P<int>(r, "originalWidth"),
                        P<int>(r, "originalHeight"), P<int>(r, "degrees"), P<int>(r, "index"), P<int>(r, "packedWidth"),
                        P<int>(r, "packedHeight")
                    },
                    new[]
                    {
                        mr.X, mr.Y, mr.Width, mr.Height, mr.OriginalWidth, mr.OriginalHeight, mr.Degrees, mr.Index,
                        mr.PackedWidth, mr.PackedHeight
                    });
                Eq(at + " floats",
                    new[]
                    {
                        P<float>(r, "offsetX"), P<float>(r, "offsetY"), P<float>(r, "u"), P<float>(r, "v"),
                        P<float>(r, "u2"), P<float>(r, "v2")
                    },
                    new[] { mr.OffsetX, mr.OffsetY, mr.U, mr.V, mr.U2, mr.V2 });
            }
        }

        // ---------------------------------------------------------------- helpers

        private static object Setup(object o)
        {
            return o.GetType().GetMethod("GetSetupPose")?.Invoke(o, null);
        }

        private static object Call(object o, string m)
        {
            return o?.GetType().GetMethod(m, Type.EmptyTypes)?.Invoke(o, null);
        }

        private static object Member(object o, string name)
        {
            if (o == null) return null;
            for (Type t = o.GetType(); t != null; t = t.BaseType)
            {
                const BindingFlags all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic |
                                         BindingFlags.DeclaredOnly;
                PropertyInfo p = t.GetProperty(name, all) ?? t.GetProperties(all).FirstOrDefault(x =>
                    string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase) &&
                    x.GetIndexParameters().Length == 0);
                if (p != null && p.GetIndexParameters().Length == 0) return p.GetValue(o);
                FieldInfo f = t.GetField(name, all) ?? t.GetFields(all)
                    .FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
                if (f != null) return f.GetValue(o);
            }

            return null;
        }

        private static T P<T>(object o, string name)
        {
            object v = Member(o, name);
            if (v == null) return default;
            if (v is T t) return t;
            try
            {
                return (T)Convert.ChangeType(v, typeof(T));
            }
            catch
            {
                return default;
            }
        }

        private static object Field(object o, string name)
        {
            return Member(o, name);
        }

        private static float F(object o, string name)
        {
            return P<float>(o, name);
        }

        private static IList AsList(object o)
        {
            if (o == null) return null;
            if (o is IList l) return l;
            object items = Member(o, "Items");
            int count = P<int>(o, "Count");
            if (items is Array a) return a.Cast<object>().Take(count).ToList();
            return null;
        }

        private static int[] BoneIndices(object o, string name)
        {
            IList l = AsList(P<object>(o, name));
            return l?.Cast<object>().Select(b => b is BoneData bd ? bd.Index : -1).ToArray();
        }

        private void Fail(string what)
        {
            Failures.Add(what);
        }

        private void Eq<T>(string what, T expected, T actual)
        {
            Checks++;
            if (!EqualityComparer<T>.Default.Equals(expected, actual) && !(expected is float fe && actual is float fa &&
                                                                           BitConverter.SingleToInt32Bits(fe) ==
                                                                           BitConverter.SingleToInt32Bits(fa)))
                Fail($"{what}: stock {Show(expected)} vs new {Show(actual)}");
        }

        private void Eq<T>(string what, T[] expected, T[] actual)
        {
            Checks++;
            if (expected == null || actual == null)
            {
                if (!(expected == null && actual == null) && !(IsEmpty(expected) && IsEmpty(actual)))
                    Fail(
                        $"{what}: stock {(expected == null ? "null" : "len " + expected.Length)} vs new {(actual == null ? "null" : "len " + actual.Length)}");
                return;
            }

            if (expected.Length != actual.Length)
            {
                Fail($"{what}: length stock {expected.Length} vs new {actual.Length}");
                return;
            }

            for (int i = 0; i < expected.Length; i++)
            {
                object e = expected[i], a = actual[i];
                bool same = Equals(e, a) || (e is float fe && a is float fa &&
                                             BitConverter.SingleToInt32Bits(fe) == BitConverter.SingleToInt32Bits(fa));
                if (!same)
                {
                    Fail($"{what}[{i}]: stock {Show(e)} vs new {Show(a)}");
                    return;
                }
            }
        }

        private static bool IsEmpty<T>(T[] a)
        {
            return a == null || a.Length == 0;
        }

        private static string Show(object o)
        {
            return o is float f ? f.ToString("R") : o?.ToString() ?? "null";
        }
    }
}