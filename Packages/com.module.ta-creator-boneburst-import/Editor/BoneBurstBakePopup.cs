using System.IO;
using UnityEditor;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.UIElements;

namespace BoneBurst.Editor
{
    /// <summary>
    ///     The modal popup of Assets › BoneBurst › Bake Folder…: shows what was found in the export folder, lets the
    ///     name, output and settings be changed, and bakes on OK. A failed bake keeps the popup open with the reason.
    /// </summary>
    /// <remarks>
    ///     <c>CLAUDE.md</c> §8 puts a new window last. This one is the owner's requested flow for a recurring,
    ///     multi-field step (every new export), and it does nothing else. The work is in
    ///     <see cref="BoneBurstBake" />, so the rebake command and the tests bake without it.
    /// </remarks>
    public sealed class BoneBurstBakePopup : EditorWindow
    {
        private HelpBox m_Message;
        private BoneBurstBakeSettings m_Settings;
        private BoneBurstBake.Source m_Source;

        private void OnDestroy()
        {
            if (m_Settings != null) DestroyImmediate(m_Settings);
        }

        private void CreateGUI()
        {
            VisualElement root = rootVisualElement;
            root.style.paddingLeft = root.style.paddingRight = root.style.paddingTop = root.style.paddingBottom = 8;
            if (m_Source == null || m_Settings == null)
            {
                root.Add(new HelpBox("Open this from Assets › BoneBurst › Bake Folder… on an export folder.",
                    HelpBoxMessageType.Info));
                return;
            }

            Label found = new($"Export: {m_Source.Folder}\n" +
                              $"  {Path.GetFileName(m_Source.Export)} · {Path.GetFileName(m_Source.Atlas)} · " +
                              $"{m_Source.Pages.Length} page(s)");
            found.style.whiteSpace = WhiteSpace.Normal;
            found.style.marginBottom = 8;
            root.Add(found);

            ScrollView fields = new();
            fields.style.flexGrow = 1;
            SerializedObject serialized = new(m_Settings);
            foreach (string property in new[]
                     {
                         nameof(BoneBurstBakeSettings.Name), nameof(BoneBurstBakeSettings.OutputFolder),
                         nameof(BoneBurstBakeSettings.Scale), nameof(BoneBurstBakeSettings.Shader),
                         nameof(BoneBurstBakeSettings.TintBlack), nameof(BoneBurstBakeSettings.DefaultMix),
                         nameof(BoneBurstBakeSettings.Mixes), nameof(BoneBurstBakeSettings.MaxTextureSize),
                         nameof(BoneBurstBakeSettings.CompressTextures), nameof(BoneBurstBakeSettings.Variants)
                     })
            {
                fields.Add(new PropertyField(serialized.FindProperty(property)));
                if (property == nameof(BoneBurstBakeSettings.OutputFolder))
                    fields.Add(new Button(PickOutputFolder) { text = "Choose output folder…" });
            }

            fields.Bind(serialized);
            root.Add(fields);

            m_Message = new HelpBox(string.Empty, HelpBoxMessageType.Error);
            m_Message.style.display = DisplayStyle.None;
            root.Add(m_Message);

            VisualElement buttons = new();
            buttons.style.flexDirection = FlexDirection.Row;
            buttons.style.justifyContent = Justify.FlexEnd;
            buttons.style.marginTop = 8;
            buttons.Add(new Button(Close) { text = "Cancel" });
            buttons.Add(new Button(BakeAndClose) { text = "Bake" });
            root.Add(buttons);
        }

        /// <summary>
        ///     Shows the popup for <paramref name="source" /> and blocks until it closes. Takes ownership of
        ///     <paramref name="settings" />.
        /// </summary>
        public static void Open(BoneBurstBake.Source source, BoneBurstBakeSettings settings)
        {
            BoneBurstBakePopup popup = CreateInstance<BoneBurstBakePopup>();
            popup.m_Source = source;
            popup.m_Settings = settings;
            popup.titleContent = new GUIContent("BoneBurst Bake");
            popup.minSize = new Vector2(460, 420);
            popup.ShowModalUtility();
        }

        private void PickOutputFolder()
        {
            string projectRoot = Path.GetDirectoryName(Application.dataPath)?.Replace('\\', '/');
            string picked = EditorUtility.OpenFolderPanel("BoneBurst bake output", m_Settings.OutputFolder, "");
            if (string.IsNullOrEmpty(picked)) return;
            picked = picked.Replace('\\', '/');
            if (projectRoot == null || !(picked + "/").StartsWith(projectRoot + "/Assets/"))
            {
                ShowError($"{picked} is not inside this project's Assets folder.");
                return;
            }

            Undo.RecordObject(m_Settings, "Output folder");
            m_Settings.OutputFolder = picked.Substring(projectRoot.Length + 1);
        }

        private void BakeAndClose()
        {
            BoneBurstBake.Result result = BoneBurstBake.Bake(m_Source, m_Settings);
            if (!result.Ok)
            {
                ShowError(result.Error);
                return;
            }

            Debug.Log(result.Report, result.Asset);
            Selection.activeObject = result.Asset;
            EditorGUIUtility.PingObject(result.Asset);
            Close();
        }

        private void ShowError(string message)
        {
            m_Message.text = message;
            m_Message.style.display = DisplayStyle.Flex;
        }
    }
}