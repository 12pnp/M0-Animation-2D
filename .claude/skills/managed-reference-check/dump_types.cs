// Writes every loaded type as "AssemblyName|FullName" to Temp/refcheck_types.txt, for refcheck.py --types.
// Run through `unity command eval_file`; refcheck.py does that for you. Nested types use '+', as reflection does.
var lines = new System.Collections.Generic.List<string>(200000);
foreach (var assembly in System.AppDomain.CurrentDomain.GetAssemblies())
{
    System.Type[] types;
    try { types = assembly.GetTypes(); }
    catch (System.Reflection.ReflectionTypeLoadException e) { types = e.Types; }
    catch (System.Exception) { continue; }

    string name = assembly.GetName().Name;
    foreach (var type in types)
        if (type != null && type.FullName != null) lines.Add(name + "|" + type.FullName);
}
string path = System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "Temp", "refcheck_types.txt");
System.IO.File.WriteAllLines(path, lines);
return lines.Count + " types written to " + path;
