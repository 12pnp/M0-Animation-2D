using System;

// UnityEngine members the parity tests and BoneBurst's managed code touch that are native calls in the real
// UnityEngine.CoreModule. Defined in source, they win over the referenced module (warning CS0436, suppressed).
// Everything else from CoreModule (NativeArray, attributes, Color32 …) is the real, managed Unity code.
namespace UnityEngine
{
    public static class QualitySettings
    {
        /// <summary>
        ///     Linear, as this project is set (ProjectSettings.asset: m_ActiveColorSpace: 1).
        /// </summary>
        public static ColorSpace activeColorSpace => ColorSpace.Linear;
    }

    public static class Debug
    {
        public static void Log(object message)
        {
            Console.WriteLine(message);
        }

        public static void Log(object message, Object context)
        {
            Console.WriteLine(message);
        }

        public static void LogWarning(object message)
        {
            Console.WriteLine("warning: " + message);
        }

        public static void LogWarning(object message, Object context)
        {
            Console.WriteLine("warning: " + message);
        }

        public static void LogError(object message)
        {
            Console.WriteLine("error: " + message);
        }

        public static void LogError(object message, Object context)
        {
            Console.WriteLine("error: " + message);
        }
    }
}
