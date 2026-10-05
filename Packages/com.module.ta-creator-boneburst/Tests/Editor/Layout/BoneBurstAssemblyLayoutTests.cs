using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using UnityEditor.Compilation;
using Assembly = System.Reflection.Assembly;
using CompiledAssembly = UnityEditor.Compilation.Assembly;
using Object = UnityEngine.Object;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     The three runtime assemblies of BoneBurst (Doc/Review/BoneBurst-AssemblySplit-Plan.md):
    ///     <c>Module.PA.BoneBurst.Data</c> reads and writes the format, <c>Module.PA.BoneBurst.Core</c> runs the pose
    ///     and mesh logic, <c>Module.PB.BoneBurst.Unity</c> is the Unity front. References point only downward, and the
    ///     two lower ones stay free of the front's dependencies, so the strict-float harness can compile them alone.
    ///     <c>Module.PA.BoneBurst.Import</c> (package <c>com.module.ta-creator-boneburst-import</c>) reads Spine
    ///     exports into Data's model for the bake; it sits on Data, and no runtime assembly may reach it.
    /// </summary>
    /// <remarks>
    ///     The compiler already stops a lower assembly from naming a front type. These tests stop the other way around
    ///     it: a reference added to an asmdef "to make an error go away", or a Unity type used in Core.
    /// </remarks>
    public class BoneBurstAssemblyLayoutTests
    {
        private const string Data = "Module.PA.BoneBurst.Data";
        private const string Core = "Module.PA.BoneBurst.Core";
        private const string Unity = "Module.PB.BoneBurst.Unity";
        private const string Import = "Module.PA.BoneBurst.Import";
        private const string Runtime = "Packages/com.module.ta-creator-boneburst/Runtime/";
        private const string ImportRuntime = "Packages/com.module.ta-creator-boneburst-import/Runtime/";

        // The BoneBurst assemblies each one may reference: only those below it.
        private static readonly Dictionary<string, string[]> s_Allowed = new()
        {
            { Data, new string[0] },
            { Core, new[] { Data } },
            { Unity, new[] { Data, Core } },
            { Import, new[] { Data } }
        };

        // What only the front may use: the AssetSystem, UniTask, Burst jobs.
        private static readonly string[] s_FrontOnly =
            { "Module.PA.Base", "Module.PB.AssetSystem", "UniTask", "Unity.Burst" };

        private static IEnumerable<TestCaseData> LayerCases()
        {
            foreach (string assembly in s_Allowed.Keys)
                yield return new TestCaseData(assembly).SetName($"Assembly_ReferencesOnlyLowerLayers_{assembly}");
        }

        [TestCaseSource(nameof(LayerCases))]
        public void Assembly_ReferencesOnlyLowerLayers(string assembly)
        {
            List<string> upward = Compiled(assembly).assemblyReferences
                .Select(a => a.name)
                .Where(n => n.Contains("BoneBurst") && !s_Allowed[assembly].Contains(n))
                .ToList();
            Assert.That(upward, Is.Empty, $"{assembly} may reference only the BoneBurst assemblies below it");
        }

        [TestCase(Data)]
        [TestCase(Core)]
        [TestCase(Import)]
        public void LowerAssembly_ReferencesNoFrontDependency(string assembly)
        {
            List<string> hits = Compiled(assembly).assemblyReferences
                .Select(a => a.name)
                .Where(n => s_FrontOnly.Contains(n))
                .ToList();
            Assert.That(hits, Is.Empty, $"{assembly} is part of the managed pose path; this belongs in {Unity}");
        }

        [TestCase(Data, Runtime + "Data/")]
        [TestCase(Core, Runtime + "Core/")]
        [TestCase(Import, ImportRuntime)]
        public void Assembly_OwnsItsFolder(string assembly, string folder)
        {
            string[] files = Compiled(assembly).sourceFiles;
            Assert.That(files, Is.Not.Empty, $"control: {assembly} has no source");
            List<string> outside = files.Where(f => !f.StartsWith(folder, StringComparison.Ordinal)).ToList();
            Assert.That(outside, Is.Empty, $"{assembly} compiles exactly {folder}");
        }

        [Test]
        public void Core_UsesNoUnityEngineNamespace()
        {
            // Core takes NativeArray and Allocator from UnityEngine.CoreModule (namespace Unity.Collections), so the
            // asmdef cannot set noEngineReferences; the source is the guard instead.
            Regex comment = new(@"//.*|/\*.*?\*/", RegexOptions.Singleline);
            Regex engine = new(@"\bUnityEngine\b");
            string[] files = Compiled(Core).sourceFiles;
            Assert.That(files, Has.Length.GreaterThan(20), "control: Core's sources were not found");
            List<string> hits = files.Where(f => engine.IsMatch(comment.Replace(File.ReadAllText(f), ""))).ToList();
            Assert.That(hits, Is.Empty, "Core is the managed pose path; Unity objects belong in the front");
        }

        [TestCase(Data)]
        [TestCase(Core)]
        [TestCase(Import)]
        public void LowerAssembly_HoldsNoUnityObject(string assembly)
        {
            List<string> objects = Loaded(assembly).GetTypes()
                .Where(t => typeof(Object).IsAssignableFrom(t))
                .Select(t => t.FullName)
                .ToList();
            Assert.That(objects, Is.Empty, $"components and assets belong in {Unity}");
        }

        [TestCase(typeof(SkeletonDef), Data)]
        [TestCase(typeof(BoneBurstKey), Data)]
        [TestCase(typeof(BoneBurstDataWriter), Data)]
        [TestCase(typeof(AtlasDef), Data)]
        [TestCase(typeof(SkeletonJsonReader), Import)]
        [TestCase(typeof(SkeletonBinaryReader), Import)]
        [TestCase(typeof(AtlasReader), Import)]
        [TestCase(typeof(SkeletonBlob), Core)]
        [TestCase(typeof(InstanceData), Core)]
        [TestCase(typeof(GpuSkin), Core)]
        [TestCase(typeof(BoneBurstSkin), Core)]
        [TestCase(typeof(BoneBurstAsset), Unity)]
        [TestCase(typeof(BoneBurstSkeleton), Unity)]
        [TestCase(typeof(BoneBurstSystem), Unity)]
        public void Type_LivesInItsAssembly(Type type, string assembly)
        {
            Assert.That(type.Assembly.GetName().Name, Is.EqualTo(assembly), $"{type.Name} belongs in {assembly}");
        }

        [Test]
        public void OldAssembly_IsGone()
        {
            Assert.That(Compiled(Data), Is.Not.Null, "control");
            Assert.That(CompilationPipeline.GetAssemblies().Any(a => a.name == "Module.TA.BoneBurst"), Is.False,
                "the single assembly is back; it became Data, Core and Unity");
        }

        private static CompiledAssembly Compiled(string name)
        {
            CompiledAssembly found = CompilationPipeline.GetAssemblies().FirstOrDefault(a => a.name == name);
            Assert.That(found, Is.Not.Null, $"{name} is not compiled");
            return found;
        }

        private static Assembly Loaded(string name)
        {
            Assembly found = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == name);
            Assert.That(found, Is.Not.Null, $"{name} is not loaded");
            return found;
        }
    }
}