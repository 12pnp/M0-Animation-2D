using System;
using System.Collections;
using System.Linq;

// The subset of NUnit the parity tests use, so their sources compile and run unchanged outside Unity. Program.cs
// discovers [Test] / [TestCaseSource] methods and runs them; a failed Assert throws AssertionException.
namespace NUnit.Framework
{
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TestAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    public sealed class TestCaseAttribute : Attribute
    {
        public readonly object[] Arguments;

        public TestCaseAttribute(params object[] arguments)
        {
            Arguments = arguments;
        }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TestCaseSourceAttribute : Attribute
    {
        public readonly string SourceName;

        public TestCaseSourceAttribute(string sourceName)
        {
            SourceName = sourceName;
        }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class SetUpAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TearDownAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
    public sealed class ExplicitAttribute : Attribute
    {
        public ExplicitAttribute(string reason = null)
        {
        }
    }

    public class AssertionException : Exception
    {
        public AssertionException(string message) : base(message)
        {
        }
    }

    public sealed class IgnoreException : Exception
    {
        public IgnoreException(string message) : base(message)
        {
        }
    }

    public sealed class SuccessException : Exception
    {
        public SuccessException(string message) : base(message)
        {
        }
    }

    public sealed class Constraint
    {
        public readonly Func<object, bool> Test;
        public readonly string Description;

        public Constraint(Func<object, bool> test, string description)
        {
            Test = test;
            Description = description;
        }
    }

    public static class Is
    {
        public static Constraint GreaterThan(double value)
        {
            return new Constraint(x => Convert.ToDouble(x) > value, $"greater than {value}");
        }

        public static Constraint GreaterThanOrEqualTo(double value)
        {
            return new Constraint(x => Convert.ToDouble(x) >= value, $"at least {value}");
        }

        public static Constraint EqualTo(object value)
        {
            return new Constraint(x => Equals(x, value), $"equal to {value}");
        }
    }

    public static class Assert
    {
        static void Fail(string message, string detail)
        {
            throw new AssertionException(string.IsNullOrEmpty(message) ? detail : $"{message} ({detail})");
        }

        public static void That(object actual, Constraint constraint, string message = null)
        {
            if (!constraint.Test(actual)) Fail(message, $"expected {constraint.Description}, was {actual}");
        }

        public static void That(bool condition, string message = null)
        {
            if (!condition) Fail(message, "condition false");
        }

        public static void IsEmpty(IEnumerable collection, string message = null)
        {
            if (collection.Cast<object>().Any()) Fail(message, "expected empty");
        }

        public static void IsTrue(bool condition, string message = null)
        {
            if (!condition) Fail(message, "expected true");
        }

        public static void IsFalse(bool condition, string message = null)
        {
            if (condition) Fail(message, "expected false");
        }

        public static void IsNull(object value, string message = null)
        {
            if (value != null) Fail(message, $"expected null, was {value}");
        }

        public static void IsNotNull(object value, string message = null)
        {
            if (value == null) Fail(message, "expected not null");
        }

        public static void AreEqual(object expected, object actual, string message = null)
        {
            bool equal = expected is IConvertible && actual is IConvertible && !(expected is string) &&
                         !(expected is Enum)
                ? Convert.ToDouble(expected).Equals(Convert.ToDouble(actual))
                : Equals(expected, actual);
            if (!equal) Fail(message, $"expected {expected}, was {actual}");
        }

        public static void AreNotEqual(object expected, object actual, string message = null)
        {
            if (Equals(expected, actual)) Fail(message, $"expected not {expected}");
        }

        public static void Greater(double a, double b, string message = null)
        {
            if (!(a > b)) Fail(message, $"expected {a} > {b}");
        }

        public static void Less(double a, double b, string message = null)
        {
            if (!(a < b)) Fail(message, $"expected {a} < {b}");
        }

        public static T Throws<T>(Action action, string message = null) where T : Exception
        {
            try
            {
                action();
            }
            catch (T e)
            {
                return e;
            }
            catch (Exception e)
            {
                Fail(message, $"expected {typeof(T).Name}, threw {e.GetType().Name}: {e.Message}");
            }

            Fail(message, $"expected {typeof(T).Name}, nothing thrown");
            return null;
        }

        public static void Ignore(string message)
        {
            throw new IgnoreException(message);
        }

        public static void Pass(string message = null)
        {
            throw new SuccessException(message);
        }
    }

    /// <summary>
    ///     Test output; the harness prints only failures, so this is dropped.
    /// </summary>
    public static class TestContext
    {
        public static void WriteLine(string message)
        {
        }
    }

    public static class StringAssert
    {
        public static void Contains(string expected, string actual, string message = null)
        {
            if (actual == null || !actual.Contains(expected))
            {
                throw new AssertionException($"{message} (expected to contain '{expected}', was '{actual}')");
            }
        }
    }

    public static class CollectionAssert
    {
        public static void AreEqual(IEnumerable expected, IEnumerable actual, string message = null)
        {
            if (!expected.Cast<object>().SequenceEqual(actual.Cast<object>()))
            {
                throw new AssertionException($"{message} (collections differ)");
            }
        }
    }
}
