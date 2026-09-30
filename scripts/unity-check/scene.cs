// Creates Assets/AnimoTest/Spine/AnimoSpineCheck.unity: every rig under
// Assets/AnimoTest/Spine as a looping SkeletonAnimation in a row, and a camera,
// for pressing Play. Built in an additive scene so the open scenes are left
// alone; refuses when the scene already exists (never overwrite authored work).
string root = "Assets/AnimoTest/Spine";
string scenePath = root + "/AnimoSpineCheck.unity";
if (UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(scenePath) != null) return "exists, left alone: " + scenePath;
UnityEngine.SceneManagement.Scene scene = UnityEditor.SceneManagement.EditorSceneManager.NewScene(
  UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Additive);
System.Text.StringBuilder report = new System.Text.StringBuilder();
float x = 0, height = 0;
foreach (string guid in UnityEditor.AssetDatabase.FindAssets("t:SkeletonDataAsset", new string[] { root })) {
  string path = UnityEditor.AssetDatabase.GUIDToAssetPath(guid);
  string rig = System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(path));
  Spine.Unity.SkeletonDataAsset asset = UnityEditor.AssetDatabase.LoadAssetAtPath<Spine.Unity.SkeletonDataAsset>(path);
  Spine.SkeletonData data = asset.GetSkeletonData(false);
  UnityEngine.GameObject go = new UnityEngine.GameObject(rig);
  UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(go, scene);
  Spine.Unity.SkeletonRenderer sr = go.AddComponent<Spine.Unity.SkeletonRenderer>();
  bool draws = false;
  if (data.DefaultSkin != null) foreach (Spine.Skin.SkinEntry entry in data.DefaultSkin.Attachments) if (entry.Attachment is Spine.RegionAttachment || entry.Attachment is Spine.MeshAttachment) draws = true;
  Spine.Unity.SkeletonAnimation sa = go.AddComponent<Spine.Unity.SkeletonAnimation>();
  // The renderer's fields after the animation component: in the Editor its
  // Awake (`UpgradeTo43`, AUTO_UPGRADE_TO_43_COMPONENTS) takes a new component
  // for a pre-4.3 one and copies its empty deprecated fields (asset, skin, mesh
  // settings) onto the renderer. It marks itself done, so this sticks.
  sr.SkeletonDataAsset = asset;
  if (!draws) foreach (Spine.Skin skin in data.Skins) if (skin.Name != "default") { sr.initialSkinName = skin.Name; break; }
  sa.Initialize(true);
  UnityEditor.SerializedObject so = new UnityEditor.SerializedObject(sa);
  // A walk or idle when there is one, else the longest: something that visibly moves.
  string longest = "";
  float duration = -1;
  foreach (Spine.Animation a in data.Animations) if (a.Duration > duration) { duration = a.Duration; longest = a.Name; }
  foreach (string wanted in new string[] { "idle", "dance", "walk", "run", "wind-idle" }) {
    if (data.FindAnimation(wanted) != null) { longest = wanted; break; }
  }
  so.FindProperty("animationName").stringValue = longest;
  so.FindProperty("loop").boolValue = true;
  so.ApplyModifiedPropertiesWithoutUndo();
  // Side by side, each 6 units tall by its setup pose, measured by the runtime
  // (in Unity units: the file's times the asset's import scale).
  Spine.Skeleton measure = new Spine.Skeleton(data);
  if (!string.IsNullOrEmpty(sr.initialSkinName)) measure.SetSkin(sr.initialSkinName);
  measure.SetupPose();
  measure.UpdateWorldTransform(Spine.Physics.Reset);
  float bx, by, bw, bh;
  float[] buffer = null;
  measure.GetBounds(out bx, out by, out bw, out bh, ref buffer);
  float k = 6f / UnityEngine.Mathf.Max(0.01f, bh);
  go.transform.localScale = new UnityEngine.Vector3(k, k, 1);
  go.transform.position = new UnityEngine.Vector3(x - bx * k, -3 - by * k, 0);
  x += bw * k + 1.5f;
  height = 6;
  report.Append(rig).Append(" plays \"").Append(longest).Append("\"").Append(sr.initialSkinName != "" && sr.initialSkinName != null ? " in skin " + sr.initialSkinName : "").Append("; ");
}
UnityEngine.GameObject camGo = new UnityEngine.GameObject("Main Camera");
UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(camGo, scene);
camGo.tag = "MainCamera";
UnityEngine.Camera cam = camGo.AddComponent<UnityEngine.Camera>();
cam.orthographic = true;
// Everything in a 4:1 frame, the play check's.
cam.orthographicSize = UnityEngine.Mathf.Max(height, (x - 1.5f) / 4f) * 0.55f;
cam.clearFlags = UnityEngine.CameraClearFlags.SolidColor;
cam.backgroundColor = new UnityEngine.Color(0.21f, 0.21f, 0.21f, 1);
camGo.transform.position = new UnityEngine.Vector3((x - 1.5f) / 2, 0, -10);
bool saved = UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene, scenePath);
UnityEditor.SceneManagement.EditorSceneManager.CloseScene(scene, true);
string result = (saved ? "saved " : "NOT saved ") + scenePath + ": " + report;
return result;
