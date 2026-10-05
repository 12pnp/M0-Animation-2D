using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using NUnit.Framework;

namespace BoneBurst.ParityHarness
{
    /// <summary>
    ///     Runs the Editor parity tests' own code on .NET, where float arithmetic is strict float32 (RyuJIT rounds
    ///     every float operation), to tell BoneBurst bugs from Mono's JIT-dependent rounding
    ///     (<c>Doc/Review/BoneBurst-ParityPlan.md</c>, F1). Must run with the Unity project root as the working
    ///     directory: the tests read <c>Packages/…</c> paths. <c>run.sh</c> does that.
    /// </summary>
    /// <remarks>
    ///     Arguments: optional test class names to run (default: every class with tests). Exit code 0 only when every
    ///     test passed and at least one ran; a run of nothing is a failure. <c>--dump in out</c> instead poses the
    ///     exports in <c>in</c> (<see cref="Dump" />).
    /// </remarks>
    static class Program
    {
        sealed class Outcome
        {
            public int Passed, Failed, Ignored, Errors;
            public readonly List<string> Messages = new();
        }

        static HashSet<string> s_Named = new();

        static int Main(string[] args)
        {
            // `--dump <in> <out>`: pose the editor's exports for its own comparison (Dump.cs), not a test run.
            if (args.Length == 3 && args[0] == "--dump") return Dump.Run(args[1], args[2]);

            Console.WriteLine($".NET {Environment.Version} ({System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture}), " +
                              $"working directory {Directory.GetCurrentDirectory()}");
            float big = 16777216f, one = float.Parse("1");
            Console.WriteLine($"float check: 16777216 + 1 - 16777216 = {big + one - big} (0 = strict float32)");

            HashSet<string> only = new(args);
            s_Named = only;
            List<Type> classes = typeof(Program).Assembly.GetTypes()
                .Where(t => t.IsClass && !t.IsAbstract && t.GetMethods().Any(m => IsTest(m, only.Contains(t.Name))))
                .Where(t => only.Count == 0 || only.Contains(t.Name))
                .OrderBy(t => t.Name).ToList();

            int total = 0, bad = 0;
            Stopwatch watch = Stopwatch.StartNew();
            foreach (Type type in classes)
            {
                Outcome outcome = RunClass(type);
                total += outcome.Passed + outcome.Failed + outcome.Errors;
                bad += outcome.Failed + outcome.Errors;
                Console.WriteLine($"{type.Name}: {outcome.Passed} passed, {outcome.Failed} failed, {outcome.Errors} errors" +
                                  (outcome.Ignored > 0 ? $", {outcome.Ignored} ignored" : ""));
                foreach (string message in outcome.Messages) Console.WriteLine("    " + message);
            }

            Console.WriteLine($"TOTAL: {total - bad} of {total} passed in {watch.Elapsed.TotalSeconds:F1} s");
            return total > 0 && bad == 0 ? 0 : 1;
        }

        /// <summary>
        ///     A test method. [Explicit] ones run only when their class is named, as in NUnit.
        /// </summary>
        static bool IsTest(MethodInfo m, bool named)
        {
            return (m.GetCustomAttribute<TestAttribute>() != null || m.GetCustomAttribute<TestCaseSourceAttribute>() != null ||
                    m.GetCustomAttributes<TestCaseAttribute>().Any()) &&
                   (named || m.GetCustomAttribute<ExplicitAttribute>() == null);
        }

        static Outcome RunClass(Type type)
        {
            Outcome outcome = new();
            MethodInfo setUp = type.GetMethods().FirstOrDefault(m => m.GetCustomAttribute<SetUpAttribute>() != null);
            MethodInfo tearDown = type.GetMethods().FirstOrDefault(m => m.GetCustomAttribute<TearDownAttribute>() != null);
            bool named = s_Named.Contains(type.Name);
            foreach (MethodInfo method in type.GetMethods().Where(m => IsTest(m, named)).OrderBy(m => m.Name))
            {
                foreach ((string name, object[] arguments) in Cases(type, method))
                {
                    object instance = Activator.CreateInstance(type);
                    string label = $"{method.Name}({name})";
                    try
                    {
                        setUp?.Invoke(instance, null);
                        method.Invoke(instance, arguments);
                        outcome.Passed++;
                    }
                    catch (TargetInvocationException e) when (e.InnerException is SuccessException)
                    {
                        outcome.Passed++;
                    }
                    catch (TargetInvocationException e) when (e.InnerException is IgnoreException)
                    {
                        outcome.Ignored++;
                    }
                    catch (TargetInvocationException e) when (e.InnerException is AssertionException)
                    {
                        outcome.Failed++;
                        outcome.Messages.Add($"FAIL {label}: {FirstLine(e.InnerException.Message)}");
                    }
                    catch (TargetInvocationException e)
                    {
                        outcome.Errors++;
                        outcome.Messages.Add($"ERROR {label}: {e.InnerException?.GetType().Name}: " +
                                             $"{FirstLine(e.InnerException?.Message)} at {FirstLine(e.InnerException?.StackTrace)}");
                    }
                    finally
                    {
                        try
                        {
                            tearDown?.Invoke(instance, null);
                        }
                        catch (TargetInvocationException)
                        {
                            // A teardown failure would hide the test's own result; the test result stands.
                        }
                    }
                }
            }

            return outcome;
        }

        static IEnumerable<(string, object[])> Cases(Type type, MethodInfo method)
        {
            TestCaseSourceAttribute source = method.GetCustomAttribute<TestCaseSourceAttribute>();
            if (source != null)
            {
                const BindingFlags any = BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public |
                                         BindingFlags.NonPublic;
                object provider = type.GetMethod(source.SourceName, any)?.Invoke(null, null) ??
                                  type.GetProperty(source.SourceName, any)?.GetValue(null) ??
                                  type.GetField(source.SourceName, any)?.GetValue(null);
                foreach (object item in (IEnumerable)provider)
                {
                    yield return (item.ToString(), item is object[] array ? array : new[] { item });
                }

                yield break;
            }

            TestCaseAttribute[] cases = method.GetCustomAttributes<TestCaseAttribute>().ToArray();
            if (cases.Length > 0)
            {
                foreach (TestCaseAttribute c in cases) yield return (string.Join(", ", c.Arguments), c.Arguments);
                yield break;
            }

            yield return ("", null);
        }

        static string FirstLine(string text)
        {
            if (text == null) return "";
            int end = text.IndexOf('\n');
            string line = end < 0 ? text : text.Substring(0, end);
            return line.Length > 300 ? line.Substring(0, 300) + "…" : line;
        }
    }
}
