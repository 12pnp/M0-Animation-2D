// Renders each rig under Assets/AnimoTest/Spine through spine-unity (SkeletonAnimation)
// in a preview scene, which leaves the Editor's open scenes alone, a quarter into
// its first animation. Writes Library/AnimoSpineCheck/<rig>.png.
string root = "Assets/AnimoTest/Spine";
string outDir = System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "Library/AnimoSpineCheck");
System.IO.Directory.CreateDirectory(outDir);
System.Text.StringBuilder report = new System.Text.StringBuilder();
UnityEngine.SceneManagement.Scene scene = UnityEditor.SceneManagement.EditorSceneManager.NewPreviewScene();
try {
  UnityEngine.GameObject camGo = new UnityEngine.GameObject("cam");
  UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(camGo, scene);
  UnityEngine.Camera cam = camGo.AddComponent<UnityEngine.Camera>();
  cam.scene = scene;
  cam.orthographic = true;
  cam.clearFlags = UnityEngine.CameraClearFlags.SolidColor;
  cam.backgroundColor = new UnityEngine.Color(0.21f, 0.21f, 0.21f, 1);
  cam.transform.position = new UnityEngine.Vector3(0, 0, -10);
  UnityEngine.RenderTexture rt = new UnityEngine.RenderTexture(512, 512, 24);
  cam.targetTexture = rt;
  foreach (string guid in UnityEditor.AssetDatabase.FindAssets("t:SkeletonDataAsset", new string[] { root })) {
    string path = UnityEditor.AssetDatabase.GUIDToAssetPath(guid);
    string rig = System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(path));
    try {
    Spine.Unity.SkeletonDataAsset asset = UnityEditor.AssetDatabase.LoadAssetAtPath<Spine.Unity.SkeletonDataAsset>(path);
    // The renderer alone, posed by hand as dump.cs poses: spine-unity's own
    // SkeletonAnimation helper fails to find its renderer in edit mode.
    UnityEngine.GameObject go = new UnityEngine.GameObject(rig);
    UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(go, scene);
    Spine.Unity.SkeletonRenderer sr = go.AddComponent<Spine.Unity.SkeletonRenderer>();
    sr.SkeletonDataAsset = asset;
    sr.Initialize(false);
    Spine.Skeleton sk = sr.Skeleton;
    Spine.SkeletonData data = sk.Data;
    bool draws = false;
  if (data.DefaultSkin != null) foreach (Spine.Skin.SkinEntry entry in data.DefaultSkin.Attachments) if (entry.Attachment is Spine.RegionAttachment || entry.Attachment is Spine.MeshAttachment) draws = true;
  // The stage's rule (stageSkinOf): a default skin that draws nothing shows the first other skin.
  if (!draws) {
      foreach (Spine.Skin skin in data.Skins) if (skin.Name != "default") { sk.SetSkin(skin.Name); break; }
    }
    Spine.Animation anim = data.Animations.Count > 0 ? data.Animations.Items[0] : null;
    sk.SetupPose();
    if (anim != null) anim.Apply(sk, 0, anim.Duration * 0.25f, false, null, 1, Spine.MixFrom.Setup, false, false, false);
    sk.UpdateWorldTransform(Spine.Physics.Reset);
    sr.LateUpdate();
    UnityEngine.Mesh mesh = go.GetComponent<UnityEngine.MeshFilter>().sharedMesh;
    UnityEngine.Bounds b = mesh.bounds;
    cam.transform.position = new UnityEngine.Vector3(b.center.x, b.center.y, -10);
    cam.orthographicSize = UnityEngine.Mathf.Max(b.extents.y, b.extents.x) * 1.1f + 0.01f;
    cam.Render();
    UnityEngine.RenderTexture.active = rt;
    UnityEngine.Texture2D tex = new UnityEngine.Texture2D(512, 512, UnityEngine.TextureFormat.RGBA32, false);
    tex.ReadPixels(new UnityEngine.Rect(0, 0, 512, 512), 0, 0);
    tex.Apply();
    UnityEngine.RenderTexture.active = null;
    System.IO.File.WriteAllBytes(System.IO.Path.Combine(outDir, rig + ".png"), tex.EncodeToPNG());
    UnityEngine.Object.DestroyImmediate(tex);
    report.Append(rig).Append(": ").Append(anim != null ? anim.Name : "-").Append(", ").Append(mesh.vertexCount).Append(" vertices, ")
      .Append(go.GetComponent<UnityEngine.MeshRenderer>().sharedMaterials.Length).Append(" materials; ");
    UnityEngine.Object.DestroyImmediate(go);
    } catch (System.Exception e) { report.Append(rig).Append(" FAILED ").Append(e.Message).Append(" @ ").Append(e.StackTrace.Split('\n')[0]).Append("; "); }
  }
  cam.targetTexture = null;
  UnityEngine.Object.DestroyImmediate(rt);
} finally {
  UnityEditor.SceneManagement.EditorSceneManager.ClosePreviewScene(scene);
}
string result = report.ToString();
return result;
