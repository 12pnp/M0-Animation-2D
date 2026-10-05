using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Runs every stock-parity suite with <see cref="ParityDrift" /> measuring and writes the table of error sizes
    ///     to <c>Logs/BoneBurstParityDrift.txt</c> (<c>Doc/Review/BoneBurst-ParityPlan.md</c>, F2). Explicit: it is a
    ///     measurement, not a check; run it by name.
    /// </summary>
    public class ParityDriftReport
    {
        /// <summary>
        ///     Resolved by name, so the strict-float harness, which has no spine-unity, skips the mesh suite.
        /// </summary>
        private static readonly string[] s_Suites =
        {
            "SetupPoseParityTests", "AnimationParityTests", "MixingParityTests", "ConstraintParityTests",
            "SkinParityTests", "MeshGeneratorParityTests"
        };

        [Test]
        [Explicit("A measurement for the parity plan (F2); run it by name.")]
        public void MeasureDrift()
        {
            List<string> errors = new();
            int cases = 0;
            ParityDrift.Start();
            try
            {
                foreach (string name in s_Suites)
                {
                    Type suite = typeof(ParityDriftReport).Assembly.GetType($"BoneBurst.Tests.{name}");
                    if (suite == null) continue;
                    foreach (MethodInfo method in suite.GetMethods()
                                 .Where(m => m.GetCustomAttribute<TestCaseSourceAttribute>() != null))
                    {
                        string source = method.GetCustomAttribute<TestCaseSourceAttribute>().SourceName;
                        const BindingFlags any = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
                        foreach (object c in (IEnumerable)suite.GetMethod(source, any).Invoke(null, null))
                        {
                            ParityDrift.Scope($"{name} {c}");
                            cases++;
                            try
                            {
                                method.Invoke(Activator.CreateInstance(suite), new[] { c });
                            }
                            catch (TargetInvocationException e) when (e.InnerException is AssertionException ||
                                                                      e.InnerException is SuccessException ||
                                                                      e.InnerException is IgnoreException)
                            {
                                // Measuring: the suites' own verdicts do not matter here, only the recorded values.
                            }
                            catch (TargetInvocationException e)
                            {
                                errors.Add(
                                    $"{name} {c}: {e.InnerException?.GetType().Name}: {e.InnerException?.Message}");
                            }
                        }
                    }
                }
            }
            finally
            {
                ParityDrift.Stop();
            }

            string report = ParityDrift.Report(
                                $"BoneBurst parity drift, {DateTime.Now.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)}, {cases} cases, {Environment.Version} " +
                                $"({(Type.GetType("Mono.Runtime") != null ? "Mono" : ".NET")})") +
                            (errors.Count > 0 ? "\nErrors:\n  " + string.Join("\n  ", errors) : "");
            Directory.CreateDirectory("Logs");
            File.WriteAllText("Logs/BoneBurstParityDrift.txt", report);
            Debug.Log(report);

            Assert.IsEmpty(errors, string.Join("\n", errors));
            Assert.That(ParityDrift.TotalValues, Is.GreaterThan(100000), "too few values measured to mean anything");
        }
    }
}