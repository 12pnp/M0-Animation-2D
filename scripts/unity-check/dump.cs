// Evaluated in the M0-Animation2D Editor by `playtest.py eval @dump.cs`: every
// SkeletonDataAsset under Assets/AnimoTest/Spine, posed by spine-csharp at every
// frame of every animation, written to Library/AnimoSpineCheck/dump.json for
// tests/unityParity.test.ts to compare with spine-core.
System.Func<float, string> N = (v) => float.IsNaN(v) ? "null" : v.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
string root = "Assets/AnimoTest/Spine";
System.Text.StringBuilder sb = new System.Text.StringBuilder();
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
  sb.Append("{\"fps\":").Append(N(fps)).Append(",\"scale\":").Append(N(asset.scale)).Append(",\"animations\":{");
  bool firstAnim = true;
  foreach (Spine.Animation anim in data.Animations) {
    if (!firstAnim) sb.Append(",");
    firstAnim = false;
    sb.Append("\"").Append(anim.Name).Append("\":[");
    int frames = (int)System.Math.Round(anim.Duration * fps);
    for (int f = 0; f <= frames; f++) {
      float t = f / fps + 0.00001f;
      sk.SetupPose();
      anim.Apply(sk, 0, t, false, null, 1, Spine.MixFrom.Setup, false, false, false);
      sk.UpdateWorldTransform(Spine.Physics.Reset);
      if (f > 0) sb.Append(",");
      sb.Append("{\"b\":[");
      for (int i = 0; i < sk.Bones.Count; i++) {
        Spine.BonePose p = sk.Bones.Items[i].AppliedPose;
        if (i > 0) sb.Append(",");
        sb.Append(N(p.A)).Append(",").Append(N(p.B)).Append(",").Append(N(p.C)).Append(",").Append(N(p.D)).Append(",").Append(N(p.WorldX)).Append(",").Append(N(p.WorldY));
      }
      sb.Append("],\"s\":[");
      Spine.ExposedList<Spine.Slot> order = sk.DrawOrder.AppliedPose;
      for (int i = 0; i < order.Count; i++) {
        Spine.Slot slot = order.Items[i];
        Spine.Attachment att = slot.AppliedPose.Attachment;
        UnityEngine.Color c = slot.AppliedPose.GetColor();
        if (i > 0) sb.Append(",");
        sb.Append("[\"").Append(slot.Data.Name).Append("\",").Append(att == null ? "null" : "\"" + att.Name + "\"")
          .Append(",").Append(N(c.r)).Append(",").Append(N(c.g)).Append(",").Append(N(c.b)).Append(",").Append(N(c.a)).Append("]");
      }
      sb.Append("]}");
    }
    sb.Append("]");
  }
  sb.Append("}}");
}
sb.Append("}");
string outDir = System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "Library/AnimoSpineCheck");
System.IO.Directory.CreateDirectory(outDir);
System.IO.File.WriteAllText(System.IO.Path.Combine(outDir, "dump.json"), sb.ToString());
return guids.Length + " rigs, " + sb.Length + " chars";
