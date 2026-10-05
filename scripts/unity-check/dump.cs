// Evaluated in the M0-Animation2D Editor by `playtest.py eval @dump.cs`: every
// SkeletonDataAsset under Assets/AnimoTest/Spine, posed by spine-csharp at every
// frame of every animation, in each skin at the setup pose (and, for a rig
// with up to four skins, at every frame), written to
// Library/AnimoSpineCheck/dump.json for
// tests/unityParity.test.ts to compare with spine-core.
System.Func<float, string> N = (v) => float.IsNaN(v) ? "null" : v.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
string root = "Assets/AnimoTest/Spine";
System.Text.StringBuilder sb = new System.Text.StringBuilder();
// Each slot in draw order: its name, attachment, colour and where the attachment is.
System.Action<Spine.Skeleton> slots = (sk2) => {
  Spine.ExposedList<Spine.Slot> order = sk2.DrawOrder.AppliedPose;
  for (int i = 0; i < order.Count; i++) {
    Spine.Slot slot = order.Items[i];
    Spine.Attachment att = slot.AppliedPose.Attachment;
    UnityEngine.Color c = slot.AppliedPose.GetColor();
    if (i > 0) sb.Append(",");
    sb.Append("[\"").Append(slot.Data.Name).Append("\",").Append(att == null ? "null" : "\"" + att.Name + "\"")
      .Append(",").Append(N(c.r)).Append(",").Append(N(c.g)).Append(",").Append(N(c.b)).Append(",").Append(N(c.a)).Append(",[");
    // Where the attachment is: a region's corners, a mesh's, box's, path's or clip's
    // world vertices, a point's position and rotation.
    float[] v = null;
    if (att is Spine.RegionAttachment) {
      Spine.RegionAttachment region = (Spine.RegionAttachment)att;
      v = new float[8];
      region.ComputeWorldVertices(slot, region.GetOffsets(slot.AppliedPose), v, 0, 2);
    } else if (att is Spine.VertexAttachment) {
      Spine.VertexAttachment va = (Spine.VertexAttachment)att;
      v = new float[va.WorldVerticesLength];
      va.ComputeWorldVertices(sk2, slot, 0, va.WorldVerticesLength, v, 0, 2);
    } else if (att is Spine.PointAttachment) {
      Spine.PointAttachment pt = (Spine.PointAttachment)att;
      float px, py;
      pt.ComputeWorldPosition(slot.Bone.AppliedPose, out px, out py);
      v = new float[] { px, py, pt.ComputeWorldRotation(slot.Bone.AppliedPose) };
    }
    if (v != null) for (int k = 0; k < v.Length; k++) { if (k > 0) sb.Append(","); sb.Append(N(v[k])); }
    sb.Append("]]");
  }
};
// Every animation at every frame: each bone's world matrix and the slots.
System.Action<Spine.Skeleton, float> animations = (sk3, fps3) => {
  sb.Append("{");
  bool firstAnim = true;
  foreach (Spine.Animation anim in sk3.Data.Animations) {
    if (!firstAnim) sb.Append(",");
    firstAnim = false;
    sb.Append("\"").Append(anim.Name).Append("\":[");
    int frames = (int)System.Math.Round(anim.Duration * fps3);
    for (int f = 0; f <= frames; f++) {
      float t = f / fps3 + 0.00001f;
      sk3.SetupPose();
      anim.Apply(sk3, 0, t, false, null, 1, Spine.MixFrom.Setup, false, false, false);
      sk3.UpdateWorldTransform(Spine.Physics.Reset);
      if (f > 0) sb.Append(",");
      sb.Append("{\"b\":[");
      for (int i = 0; i < sk3.Bones.Count; i++) {
        Spine.BonePose p = sk3.Bones.Items[i].AppliedPose;
        if (i > 0) sb.Append(",");
        sb.Append(N(p.A)).Append(",").Append(N(p.B)).Append(",").Append(N(p.C)).Append(",").Append(N(p.D)).Append(",").Append(N(p.WorldX)).Append(",").Append(N(p.WorldY));
      }
      sb.Append("],\"s\":[");
      slots(sk3);
      sb.Append("]}");
    }
    sb.Append("]");
  }
  sb.Append("}");
};

sb.Append("{");
bool firstRig = true;
string[] guids = UnityEditor.AssetDatabase.FindAssets("t:SkeletonDataAsset", new string[] { root });
foreach (string guid in guids) {
  string path = UnityEditor.AssetDatabase.GUIDToAssetPath(guid);
  Spine.Unity.SkeletonDataAsset asset = UnityEditor.AssetDatabase.LoadAssetAtPath<Spine.Unity.SkeletonDataAsset>(path);
  Spine.SkeletonData data = asset.GetSkeletonData(false);
  string rig = System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(path));
  if (!firstRig) sb.Append(",");
  firstRig = false;
  sb.Append("\"").Append(rig).Append("\":");
  if (data == null) { sb.Append("null"); continue; }
  Spine.Skeleton sk = new Spine.Skeleton(data);
  bool draws = false;
  if (data.DefaultSkin != null) foreach (Spine.Skin.SkinEntry entry in data.DefaultSkin.Attachments) if (entry.Attachment is Spine.RegionAttachment || entry.Attachment is Spine.MeshAttachment) draws = true;
  // The stage's rule (stageSkinOf): a default skin that draws nothing shows the first other skin.
  if (!draws) {
    foreach (Spine.Skin skin in data.Skins) {
      if (skin.Name != "default") { sk.SetSkin(skin.Name); break; }
    }
  }
  float fps = data.Fps > 0 ? data.Fps : 30;
  // Positions come out in Unity units: the asset's import scale (0.01 by default) times the file's.
  sb.Append("{\"fps\":").Append(N(fps)).Append(",\"scale\":").Append(N(asset.scale)).Append(",\"animations\":");
  animations(sk, fps);
  // Every skin alone over the default one, at the setup pose.
  sb.Append(",\"skins\":{");
  bool firstSkin = true;
  foreach (Spine.Skin skin in data.Skins) {
    if (skin.Name == "default") continue;
    Spine.Skeleton one = new Spine.Skeleton(data);
    one.SetSkin(skin);
    one.SetupPose();
    one.UpdateWorldTransform(Spine.Physics.Reset);
    if (!firstSkin) sb.Append(",");
    firstSkin = false;
    sb.Append("\"").Append(skin.Name).Append("\":[");
    slots(one);
    sb.Append("]");
  }
  sb.Append("}");
  // A rig with a few skins plays every animation in each of them too.
  int skinCount = 0;
  foreach (Spine.Skin skin in data.Skins) if (skin.Name != "default") skinCount++;
  if (skinCount > 0 && skinCount <= 4) {
    sb.Append(",\"skinAnimations\":{");
    bool firstPlayed = true;
    foreach (Spine.Skin skin in data.Skins) {
      if (skin.Name == "default") continue;
      Spine.Skeleton one = new Spine.Skeleton(data);
      one.SetSkin(skin);
      if (!firstPlayed) sb.Append(",");
      firstPlayed = false;
      sb.Append("\"").Append(skin.Name).Append("\":");
      animations(one, fps);
    }
    sb.Append("}");
  }
  sb.Append("}");
}
sb.Append("}");
string outDir = System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "Library/AnimoSpineCheck");
System.IO.Directory.CreateDirectory(outDir);
System.IO.File.WriteAllText(System.IO.Path.Combine(outDir, "dump.json"), sb.ToString());
return guids.Length + " rigs, " + sb.Length + " chars";
