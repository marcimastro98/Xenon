using System.Text;
using System.Text.Json;

namespace XenonHelper;

// Minimal hand-rolled JSON writer for the payload shapes the helper emits
// (dictionaries, lists, primitives). Reflection-based JsonSerializer.Serialize
// is disabled in trimmed builds; this stays trim-safe by construction.
internal static class JsonOut
{
    public static string Serialize(object? value)
    {
        using var ms = new MemoryStream();
        using (var writer = new Utf8JsonWriter(ms))
        {
            WriteValue(writer, value);
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    private static void WriteValue(Utf8JsonWriter writer, object? value)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case string s:
                writer.WriteStringValue(s);
                break;
            case bool b:
                writer.WriteBooleanValue(b);
                break;
            case int i:
                writer.WriteNumberValue(i);
                break;
            case long l:
                writer.WriteNumberValue(l);
                break;
            case double d:
                writer.WriteNumberValue(d);
                break;
            case Dictionary<string, object?> dict:
                writer.WriteStartObject();
                foreach (var entry in dict)
                {
                    writer.WritePropertyName(entry.Key);
                    WriteValue(writer, entry.Value);
                }
                writer.WriteEndObject();
                break;
            case IEnumerable<object?> list:
                writer.WriteStartArray();
                foreach (var item in list) WriteValue(writer, item);
                writer.WriteEndArray();
                break;
            default:
                writer.WriteStringValue(value.ToString());
                break;
        }
    }
}
