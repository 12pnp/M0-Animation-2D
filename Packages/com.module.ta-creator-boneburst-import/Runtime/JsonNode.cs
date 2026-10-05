using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace BoneBurst.Data
{
    /// <summary>
    ///     A parsed JSON value. Objects keep document order, which the Spine JSON format depends on: timeline,
    ///     event and animation order all follow it (<c>Doc/Format/Format-Json-Atlas.md</c> §2).
    /// </summary>
    /// <remarks>
    ///     Numbers are parsed straight to 32-bit floats, as the stock reader parses them, so values and baked
    ///     curves match bit for bit. A duplicate key replaces the value but keeps the first key's position.
    /// </remarks>
    public sealed class JsonNode
    {
        public enum Type : byte
        {
            Null,
            False,
            True,
            Number,
            String,
            Array,
            Object
        }

        private static readonly List<JsonNode> s_NoItems = new();

        /// <summary>
        ///     Array elements, or object values in document order.
        /// </summary>
        public List<JsonNode> Items = s_NoItems;

        /// <summary>
        ///     Object keys, parallel to <see cref="Items" />.
        /// </summary>
        public List<string> Keys;

        public Type Kind;
        public float Number;
        public string String;

        private Dictionary<string, int> m_Index;

        public int Count => Items.Count;
        public bool IsObject => Kind == Type.Object;
        public bool IsArray => Kind == Type.Array;

        /// <summary>
        ///     The value for <paramref name="key" />, or null when the key is absent (or this is not an object).
        /// </summary>
        public JsonNode this[string key] =>
            m_Index != null && m_Index.TryGetValue(key, out int i) ? Items[i] : null;

        public JsonNode this[int index] => Items[index];

        public bool Has(string key)
        {
            return m_Index != null && m_Index.ContainsKey(key);
        }

        /// <summary>
        ///     Parses a whole document.
        /// </summary>
        /// <exception cref="SkeletonFormatException">The text is not valid JSON.</exception>
        public static JsonNode Parse(string text)
        {
            Parser parser = new(text ?? throw new ArgumentNullException(nameof(text)));
            JsonNode root = parser.Value();
            parser.SkipSpace();
            if (!parser.AtEnd) throw parser.Error("unexpected text after the JSON value");

            return root;
        }

        private struct Parser
        {
            private readonly string m_Text;
            private int m_At;

            public Parser(string text)
            {
                m_Text = text;
                m_At = 0;
            }

            public bool AtEnd => m_At >= m_Text.Length;

            public JsonNode Value()
            {
                SkipSpace();
                if (AtEnd) throw Error("unexpected end of JSON");

                char c = m_Text[m_At];
                switch (c)
                {
                    case '{':
                        return Object();
                    case '[':
                        return Array();
                    case '"':
                        return new JsonNode { Kind = Type.String, String = StringToken() };
                    case 't':
                        Literal("true");
                        return new JsonNode { Kind = Type.True };
                    case 'f':
                        Literal("false");
                        return new JsonNode { Kind = Type.False };
                    case 'n':
                        Literal("null");
                        return new JsonNode { Kind = Type.Null };
                    default:
                        if (c == '-' || (c >= '0' && c <= '9'))
                            return new JsonNode { Kind = Type.Number, Number = NumberToken() };

                        throw Error($"unexpected character '{c}'");
                }
            }

            private JsonNode Object()
            {
                m_At++;
                JsonNode node = new()
                {
                    Kind = Type.Object, Items = new List<JsonNode>(), Keys = new List<string>(),
                    m_Index = new Dictionary<string, int>()
                };
                while (true)
                {
                    SkipSpace();
                    if (AtEnd) throw Error("unterminated object");

                    if (m_Text[m_At] == '}')
                    {
                        m_At++;
                        return node;
                    }

                    if (m_Text[m_At] != '"') throw Error("expected a string key");

                    string key = StringToken();
                    SkipSpace();
                    Expect(':');
                    JsonNode value = Value();
                    if (node.m_Index.TryGetValue(key, out int existing))
                    {
                        node.Items[existing] = value;
                    }
                    else
                    {
                        node.m_Index.Add(key, node.Items.Count);
                        node.Keys.Add(key);
                        node.Items.Add(value);
                    }

                    SkipSpace();
                    if (!AtEnd && m_Text[m_At] == ',') m_At++;
                }
            }

            private JsonNode Array()
            {
                m_At++;
                JsonNode node = new() { Kind = Type.Array, Items = new List<JsonNode>() };
                while (true)
                {
                    SkipSpace();
                    if (AtEnd) throw Error("unterminated array");

                    if (m_Text[m_At] == ']')
                    {
                        m_At++;
                        return node;
                    }

                    node.Items.Add(Value());
                    SkipSpace();
                    if (!AtEnd && m_Text[m_At] == ',') m_At++;
                }
            }

            private string StringToken()
            {
                m_At++;
                StringBuilder builder = null;
                int start = m_At;
                while (true)
                {
                    if (AtEnd) throw Error("unterminated string");

                    char c = m_Text[m_At];
                    if (c == '"')
                    {
                        string tail = m_Text.Substring(start, m_At - start);
                        m_At++;
                        return builder == null ? tail : builder.Append(tail).ToString();
                    }

                    if (c != '\\')
                    {
                        m_At++;
                        continue;
                    }

                    builder ??= new StringBuilder();
                    builder.Append(m_Text, start, m_At - start);
                    m_At++;
                    if (AtEnd) throw Error("unterminated escape");

                    char e = m_Text[m_At++];
                    switch (e)
                    {
                        case '"':
                        case '\\':
                        case '/':
                            builder.Append(e);
                            break;
                        case 'b':
                            builder.Append('\b');
                            break;
                        case 'f':
                            builder.Append('\f');
                            break;
                        case 'n':
                            builder.Append('\n');
                            break;
                        case 'r':
                            builder.Append('\r');
                            break;
                        case 't':
                            builder.Append('\t');
                            break;
                        case 'u':
                            if (m_At + 4 > m_Text.Length) throw Error("bad \\u escape");

                            builder.Append((char)int.Parse(m_Text.Substring(m_At, 4), NumberStyles.HexNumber,
                                CultureInfo.InvariantCulture));
                            m_At += 4;
                            break;
                        default:
                            throw Error($"bad escape \\{e}");
                    }

                    start = m_At;
                }
            }

            private float NumberToken()
            {
                int start = m_At;
                while (!AtEnd)
                {
                    char c = m_Text[m_At];
                    if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
                        m_At++;
                    else
                        break;
                }

                string token = m_Text.Substring(start, m_At - start);
                if (!float.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out float value))
                    throw Error($"bad number '{token}'");

                return value;
            }

            private void Literal(string word)
            {
                if (string.CompareOrdinal(m_Text, m_At, word, 0, word.Length) != 0) throw Error($"expected '{word}'");

                m_At += word.Length;
            }

            private void Expect(char c)
            {
                if (AtEnd || m_Text[m_At] != c) throw Error($"expected '{c}'");

                m_At++;
            }

            public void SkipSpace()
            {
                while (!AtEnd && char.IsWhiteSpace(m_Text[m_At])) m_At++;
            }

            public SkeletonFormatException Error(string message)
            {
                int line = 1;
                for (int i = 0; i < m_At && i < m_Text.Length; i++)
                    if (m_Text[i] == '\n')
                        line++;

                return new SkeletonFormatException($"JSON line {line}: {message}.");
            }
        }
    }
}