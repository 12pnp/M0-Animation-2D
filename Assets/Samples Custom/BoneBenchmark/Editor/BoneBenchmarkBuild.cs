using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Profile;
using UnityEditor.Build.Reporting;
using UnityEngine;

/// <summary>
///     Builds a player that holds only <c>Assets/Scenes/BoneBenchmark.unity</c>, into a new folder under
///     <c>Build/</c> named after the active Build Profile (<c>CLAUDE.md</c> §7: never an existing folder).
/// </summary>
/// <remarks>
///     The benchmark uses no EOS, so the build sets <c>EOS_SKIP_BUILD_VALIDATION=1</c> in this process for its own
///     duration (the EOS fork's validator otherwise fails every build without a platform EOS config).
///     IL2CPP by default: the build switches the Standalone scripting backend for its own duration and restores it
///     (the project stays on its own setting). Mono stays available for comparison.
///     Release for the numbers; Development for a Profiler capture and the per-marker columns (worker-thread job
///     time is visible only in a Profiler capture). Run the player with <c>-boneBench</c> for the full suite.
/// </remarks>
public static class BoneBenchmarkBuild
{
    const string Scene = "Assets/Scenes/BoneBenchmark.unity";

    [MenuItem("Tools/BoneBenchmark/Build Player (Release, IL2CPP)", false, 0)]
    static void BuildRelease()
    {
        Build(false, ScriptingImplementation.IL2CPP);
    }

    [MenuItem("Tools/BoneBenchmark/Build Player (Development + Profiler, IL2CPP)", false, 1)]
    static void BuildDevelopment()
    {
        Build(true, ScriptingImplementation.IL2CPP);
    }

    [MenuItem("Tools/BoneBenchmark/Build Player (Release, Mono)", false, 20)]
    static void BuildReleaseMono()
    {
        Build(false, ScriptingImplementation.Mono2x);
    }

    static void Build(bool development, ScriptingImplementation backend)
    {
        if (AssetDatabase.LoadAssetAtPath<SceneAsset>(Scene) == null)
        {
            Debug.LogError($"[BoneBenchmark] {Scene} not found; nothing built.");
            return;
        }

        BuildProfile profile = BuildProfile.GetActiveBuildProfile();
        string profileName = profile != null ? profile.name : EditorUserBuildSettings.activeBuildTarget.ToString();
        string backendName = backend == ScriptingImplementation.IL2CPP ? "IL2CPP" : "Mono";
        string baseName = $"{profileName}_BoneBenchmark_{backendName}{(development ? "_Dev" : "")}";
        string folder = Path.Combine("Build", baseName);
        for (int n = 2; Directory.Exists(folder); n++)
        {
            folder = Path.Combine("Build", $"{baseName}_{n}");
        }

        string product = EditorUserBuildSettings.activeBuildTarget switch
        {
            BuildTarget.StandaloneOSX => "BoneBenchmark.app",
            BuildTarget.StandaloneWindows or BuildTarget.StandaloneWindows64 => "BoneBenchmark.exe",
            _ => "BoneBenchmark"
        };

        BuildPlayerOptions options = new()
        {
            scenes = new[] { Scene },
            locationPathName = Path.Combine(folder, product),
            target = EditorUserBuildSettings.activeBuildTarget,
            options = development ? BuildOptions.Development | BuildOptions.ConnectWithProfiler : BuildOptions.None
        };
        string previous = Environment.GetEnvironmentVariable("EOS_SKIP_BUILD_VALIDATION");
        ScriptingImplementation previousBackend = PlayerSettings.GetScriptingBackend(NamedBuildTarget.Standalone);
        BuildReport report;
        try
        {
            Environment.SetEnvironmentVariable("EOS_SKIP_BUILD_VALIDATION", "1");
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Standalone, backend);
            report = BuildPipeline.BuildPlayer(options);
        }
        finally
        {
            Environment.SetEnvironmentVariable("EOS_SKIP_BUILD_VALIDATION", previous);
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Standalone, previousBackend);
            // BuildPlayer saved the project settings with the build's backend; write the restored one back, or a
            // crash before the next save would leave the project on it. The build already saved every other asset.
            AssetDatabase.SaveAssets();
        }

        BuildSummary summary = report.summary;
        if (summary.result == BuildResult.Succeeded)
        {
            Debug.Log($"[BoneBenchmark] built {backendName} {options.locationPathName} ({summary.totalSize / (1024 * 1024)} MB). " +
                      "Run it with -boneBench for the full suite.");
        }
        else
        {
            Debug.LogError($"[BoneBenchmark] build {summary.result}: {summary.totalErrors} error(s); see the build report.");
        }
    }
}
