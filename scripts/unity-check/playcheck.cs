// Opens AnimoSpineCheck.unity as a preview scene (the open scenes stay, and its
// camera renders it alone: a camera in an ordinary scene renders every loaded
// scene), advances every SkeletonAnimation 1.5 s through its AnimationState,
// renders to Library/AnimoSpineCheck/scene.png and play_<rig>.png, and closes it.
string scenePath = "Assets/AnimoTest/Spine/AnimoSpineCheck.unity";
UnityEngine.SceneManagement.Scene scene = UnityEditor.SceneManagement.EditorSceneManager.OpenPreviewScene(scenePath);
System.Text.StringBuilder report = new System.Text.StringBuilder();
try {
  UnityEngine.Camera cam = null;
  foreach (UnityEngine.GameObject go in scene.GetRootGameObjects()) {
    if (cam == null) cam = go.GetComponent<UnityEngine.Camera>();
    Spine.Unity.SkeletonAnimation sa = go.GetComponent<Spine.Unity.SkeletonAnimation>();
    if (sa == null) continue;
    try {
    sa.Initialize(true);
    for (int i = 0; i < 90; i++) sa.Update(1f / 60f);
    go.GetComponent<Spine.Unity.SkeletonRenderer>().LateUpdate();
    Spine.TrackEntry e = sa.AnimationState.GetTrack(0);
    report.Append(go.name).Append(": ").Append(e == null ? "no track" : e.Animation.Name + " at " + e.AnimationTime.ToString("0.00") + "s")
      .Append(", ").Append(go.GetComponent<UnityEngine.MeshFilter>().sharedMesh.vertexCount).Append(" vertices; ");
    } catch (System.Exception ex) { report.Append(go.name).Append(" FAILED ").Append(ex.Message).Append(" @ ").Append(ex.StackTrace.Split('\n')[0]).Append("; "); }
  }
  if (cam == null) return report.Append("no camera").ToString();
  // Each rig on its own too, framed by its renderer's world bounds.
  UnityEngine.RenderTexture one = new UnityEngine.RenderTexture(400, 400, 24);
  UnityEngine.Vector3 camHome = cam.transform.position;
  float sizeHome = cam.orthographicSize;
  foreach (UnityEngine.GameObject go in scene.GetRootGameObjects()) {
    UnityEngine.MeshRenderer mr = go.GetComponent<UnityEngine.MeshRenderer>();
    if (mr == null) continue;
    UnityEngine.Bounds wb = mr.bounds;
    report.Append(go.name).Append(" bounds ").Append(wb.size.x.ToString("0.0")).Append("x").Append(wb.size.y.ToString("0.0")).Append("; ");
    cam.targetTexture = one;
    cam.aspect = 1;
    cam.scene = scene;
    cam.transform.position = new UnityEngine.Vector3(wb.center.x, wb.center.y, -10);
    cam.orthographicSize = UnityEngine.Mathf.Max(wb.extents.x, wb.extents.y) * 1.05f;
    cam.Render();
    UnityEngine.RenderTexture.active = one;
    UnityEngine.Texture2D t1 = new UnityEngine.Texture2D(400, 400, UnityEngine.TextureFormat.RGBA32, false);
    t1.ReadPixels(new UnityEngine.Rect(0, 0, 400, 400), 0, 0);
    t1.Apply();
    UnityEngine.RenderTexture.active = null;
    System.IO.File.WriteAllBytes(System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "Library/AnimoSpineCheck/play_" + go.name + ".png"), t1.EncodeToPNG());
    UnityEngine.Object.DestroyImmediate(t1);
  }
  cam.targetTexture = null;
  UnityEngine.Object.DestroyImmediate(one);
  cam.transform.position = camHome;
  cam.orthographicSize = sizeHome;
  UnityEngine.RenderTexture rt = new UnityEngine.RenderTexture(1600, 400, 24);
  cam.targetTexture = rt;
  cam.aspect = 4;
  cam.scene = scene;
  cam.Render();
  UnityEngine.RenderTexture.active = rt;
  UnityEngine.Texture2D tex = new UnityEngine.Texture2D(1600, 400, UnityEngine.TextureFormat.RGBA32, false);
  tex.ReadPixels(new UnityEngine.Rect(0, 0, 1600, 400), 0, 0);
  tex.Apply();
  UnityEngine.RenderTexture.active = null;
  cam.targetTexture = null;
  System.IO.File.WriteAllBytes(System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "Library/AnimoSpineCheck/scene.png"), tex.EncodeToPNG());
  UnityEngine.Object.DestroyImmediate(tex);
  UnityEngine.Object.DestroyImmediate(rt);
} finally {
  UnityEditor.SceneManagement.EditorSceneManager.ClosePreviewScene(scene);
}
return report.ToString();
