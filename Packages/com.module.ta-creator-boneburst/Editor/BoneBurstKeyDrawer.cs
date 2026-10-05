using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace BoneBurst.Editor
{
    /// <summary>
    ///     Draws a <see cref="BoneBurstKey" /> marked <see cref="BoneBurstKeyOfAttribute" /> as a popup of the baked
    ///     keys of that kind, read from the <see cref="BoneBurstAsset" /> in the object's <c>Asset</c> field.
    /// </summary>
    /// <remarks>
    ///     Without a readable asset the key is a text field, labelled as unchecked. A stored key the skeleton does not
    ///     have stays selected and is marked missing, so a re-bake or an asset swap never clears it silently.
    /// </remarks>
    [CustomPropertyDrawer(typeof(BoneBurstKeyOfAttribute))]
    public sealed class BoneBurstKeyDrawer : PropertyDrawer
    {
        private const string AssetField = "Asset";
        private const string TemplateAssetField = "template.Asset";
        private const string StringField = "m_String";
        private const string None = "(none)";

        public override float GetPropertyHeight(SerializedProperty property, GUIContent label)
        {
            return EditorGUIUtility.singleLineHeight;
        }

        public override void OnGUI(Rect position, SerializedProperty property, GUIContent label)
        {
            SerializedProperty value = property.FindPropertyRelative(StringField);
            if (value == null)
            {
                EditorGUI.LabelField(position, label.text, $"{nameof(BoneBurstKeyOfAttribute)} needs a BoneBurstKey.");
                return;
            }

            BoneBurstKeyKind kind = ((BoneBurstKeyOfAttribute)attribute).Kind;
            List<string> keys = KeysOf(property.serializedObject, kind, out string problem);
            using EditorGUI.PropertyScope scope = new(position, label, property);
            if (keys == null)
            {
                GUIContent uncheckedLabel = new($"{scope.content.text} (unchecked)", problem);
                EditorGUI.PropertyField(position, value, uncheckedLabel);
                return;
            }

            string current = value.stringValue;
            List<string> options = new(keys.Count + 2) { None };
            options.AddRange(keys);
            int selected = string.IsNullOrEmpty(current) ? 0 : options.IndexOf(current, 1);
            if (selected < 0)
            {
                options.Add($"{current} (missing)");
                selected = options.Count - 1;
            }

            EditorGUI.showMixedValue = value.hasMultipleDifferentValues;
            EditorGUI.BeginChangeCheck();
            GUIContent[] contents = options.ConvertAll(o => new GUIContent(o)).ToArray();
            int picked = EditorGUI.Popup(position, scope.content, selected, contents);
            EditorGUI.showMixedValue = false;
            if (!EditorGUI.EndChangeCheck() || picked == selected) return;

            // The "(missing)" entry keeps the stored key as it is.
            if (picked == 0) value.stringValue = string.Empty;
            else if (picked <= keys.Count) value.stringValue = keys[picked - 1];
        }

        /// <summary>
        ///     The asset of a top-level <see cref="BoneBurstSkeleton" /> field, for a component that keys a skeleton
        ///     it references instead of holding the asset itself (so the asset is stored once, on the skeleton).
        /// </summary>
        private static bool TryAssetOfSkeletonField(SerializedObject serializedObject, out BoneBurstAsset asset,
            out string problem)
        {
            asset = null;
            SerializedProperty property = serializedObject.GetIterator();
            for (bool enter = true; property.NextVisible(enter); enter = false)
            {
                if (property.propertyType != SerializedPropertyType.ObjectReference ||
                    !typeof(BoneBurstSkeleton).IsAssignableFrom(FieldTypeOf(serializedObject, property)))
                    continue;

                if (property.hasMultipleDifferentValues)
                {
                    problem = "The selected objects use different skeletons.";
                    return false;
                }

                asset = property.objectReferenceValue is BoneBurstSkeleton skeleton ? skeleton.Asset : null;
                problem = null;
                return true;
            }

            problem = $"No '{AssetField}' or BoneBurstSkeleton field beside this key.";
            return false;
        }

        private static Type FieldTypeOf(SerializedObject serializedObject, SerializedProperty property)
        {
            Type type = serializedObject.targetObject.GetType();
            for (; type != null; type = type.BaseType)
            {
                FieldInfo field = type.GetField(property.name,
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
                if (field != null) return field.FieldType;
            }

            return null;
        }

        /// <summary>
        ///     The baked keys of <paramref name="kind" /> in export order, or null with the reason when there is no
        ///     single readable asset.
        /// </summary>
        private static List<string> KeysOf(SerializedObject serializedObject, BoneBurstKeyKind kind, out string problem)
        {
            // A PlayableAsset clip holds its behaviour as 'template', so the asset sits one level down.
            SerializedProperty assetProperty =
                serializedObject.FindProperty(AssetField) ?? serializedObject.FindProperty(TemplateAssetField);
            BoneBurstAsset asset;
            if (assetProperty != null)
            {
                if (assetProperty.hasMultipleDifferentValues)
                {
                    problem = "The selected objects use different assets.";
                    return null;
                }

                asset = assetProperty.objectReferenceValue as BoneBurstAsset;
            }
            else if (!TryAssetOfSkeletonField(serializedObject, out asset, out problem))
            {
                return null;
            }

            if (asset == null || !asset.HasData)
            {
                problem = "Assign a baked BoneBurst asset to pick from its keys.";
                return null;
            }

            BoneBurstKeyTable table;
            try
            {
                table = asset.Keys;
            }
            catch (Exception e)
            {
                problem = $"{asset.name}: {e.Message}";
                return null;
            }

            List<string> keys = new();
            foreach (BoneBurstKeyTable.Entry entry in table.Entries)
                if (entry.Kind == kind)
                    keys.Add(entry.Key.String);

            problem = null;
            return keys;
        }
    }
}