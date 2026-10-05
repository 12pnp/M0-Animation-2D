using System;
using System.IO;
using System.Text;

namespace BoneBurst.Data
{
    /// <summary>
    ///     What a baked <c>.sbdata</c> file holds: the skeleton and atlas as the readers produce them, the name keys,
    ///     and where it came from. Written by <see cref="BoneBurstDataWriter" />, read by
    ///     <see cref="BoneBurstDataReader" />. Layout: <c>Doc/Format/BakedData.md</c>.
    /// </summary>
    public sealed class BoneBurstData
    {
        /// <summary>
        ///     The layout version this code writes and reads. A file of any other version is refused: rebake it.
        /// </summary>
        public const int FormatVersion = 1;

        /// <summary>
        ///     Magic (4), format version (u16), scale (f32), payload checksum (u64).
        /// </summary>
        internal const int HeaderSize = 18;

        internal static readonly byte[] Magic = { (byte)'S', (byte)'B', (byte)'D', (byte)'F' };
        public AtlasDef Atlas;

        /// <summary>
        ///     Each key's id as computed at bake time, parallel to <see cref="Keys" />.
        /// </summary>
        public int[] KeyIds;

        /// <summary>
        ///     The name keys, as <see cref="BoneBurstKeyTable.BuildEntries" /> made them at bake time.
        /// </summary>
        public BoneBurstKeyTable.Entry[] Keys;

        /// <summary>
        ///     The scale the skeleton was read at; every position in <see cref="Skeleton" /> already includes it.
        /// </summary>
        public float Scale;

        public SkeletonDef Skeleton;

        /// <summary>
        ///     A digest of the source export the bake was made from (empty when the writer was given none).
        /// </summary>
        public byte[] SourceDigest = Array.Empty<byte>();

        /// <summary>
        ///     FNV-1a, 64 bit: the payload checksum. Catches a truncated or damaged file, not tampering.
        /// </summary>
        internal static ulong Checksum(byte[] bytes, int start)
        {
            ulong hash = 14695981039346656037UL;
            for (int i = start; i < bytes.Length; i++)
            {
                hash ^= bytes[i];
                hash *= 1099511628211UL;
            }

            return hash;
        }
    }

    /// <summary>
    ///     Little-endian primitives and LEB128 varints into a growing buffer.
    /// </summary>
    internal sealed class ByteWriter
    {
        private readonly byte[] m_Scratch = new byte[8];
        private readonly MemoryStream m_Stream = new();

        public long Length => m_Stream.Length;

        public void U8(byte value)
        {
            m_Stream.WriteByte(value);
        }

        public void Bool(bool value)
        {
            m_Stream.WriteByte(value ? (byte)1 : (byte)0);
        }

        public void U16(ushort value)
        {
            m_Scratch[0] = (byte)value;
            m_Scratch[1] = (byte)(value >> 8);
            m_Stream.Write(m_Scratch, 0, 2);
        }

        public void I32(int value)
        {
            for (int i = 0; i < 4; i++) m_Scratch[i] = (byte)(value >> (i * 8));
            m_Stream.Write(m_Scratch, 0, 4);
        }

        public void U64(ulong value)
        {
            for (int i = 0; i < 8; i++) m_Scratch[i] = (byte)(value >> (i * 8));
            m_Stream.Write(m_Scratch, 0, 8);
        }

        public void F32(float value)
        {
            I32(BitConverter.SingleToInt32Bits(value));
        }

        /// <summary>
        ///     Raw floats, 4 bytes each, little-endian (every Unity target is).
        /// </summary>
        public void F32s(float[] values, int start, int count)
        {
            byte[] bytes = new byte[count * 4];
            Buffer.BlockCopy(values, start * 4, bytes, 0, bytes.Length);
            m_Stream.Write(bytes, 0, bytes.Length);
        }

        public void VarUInt(uint value)
        {
            while (value >= 0x80)
            {
                m_Stream.WriteByte((byte)(value | 0x80));
                value >>= 7;
            }

            m_Stream.WriteByte((byte)value);
        }

        /// <summary>
        ///     Signed, zigzag-encoded: -1 takes one byte.
        /// </summary>
        public void VarInt(int value)
        {
            VarUInt((uint)((value << 1) ^ (value >> 31)));
        }

        public void Bytes(byte[] bytes)
        {
            VarUInt((uint)bytes.Length);
            m_Stream.Write(bytes, 0, bytes.Length);
        }

        public void Raw(byte[] bytes)
        {
            m_Stream.Write(bytes, 0, bytes.Length);
        }

        public void Utf8(string value)
        {
            Bytes(Encoding.UTF8.GetBytes(value));
        }

        public byte[] ToArray()
        {
            return m_Stream.ToArray();
        }
    }

    /// <summary>
    ///     Reads what <see cref="ByteWriter" /> writes. Every read is bounds-checked: a short file is a
    ///     <see cref="SkeletonFormatException" />, never an index exception or a half-read skeleton.
    /// </summary>
    internal sealed class ByteReader
    {
        private readonly byte[] m_Bytes;
        private int m_Position;

        public ByteReader(byte[] bytes, int position)
        {
            m_Bytes = bytes;
            m_Position = position;
        }

        public bool AtEnd => m_Position == m_Bytes.Length;

        private void Need(int count)
        {
            if (count < 0 || m_Position + count > m_Bytes.Length)
                throw new SkeletonFormatException($"baked data is truncated at byte {m_Position}.");
        }

        public byte U8()
        {
            Need(1);
            return m_Bytes[m_Position++];
        }

        public bool Bool()
        {
            return U8() != 0;
        }

        public ushort U16()
        {
            Need(2);
            ushort value = (ushort)(m_Bytes[m_Position] | (m_Bytes[m_Position + 1] << 8));
            m_Position += 2;
            return value;
        }

        public int I32()
        {
            Need(4);
            int value = m_Bytes[m_Position] | (m_Bytes[m_Position + 1] << 8) | (m_Bytes[m_Position + 2] << 16) |
                        (m_Bytes[m_Position + 3] << 24);
            m_Position += 4;
            return value;
        }

        public ulong U64()
        {
            Need(8);
            ulong value = 0;
            for (int i = 0; i < 8; i++) value |= (ulong)m_Bytes[m_Position + i] << (i * 8);
            m_Position += 8;
            return value;
        }

        public float F32()
        {
            return BitConverter.Int32BitsToSingle(I32());
        }

        public void F32s(float[] into, int start, int count)
        {
            Need(count * 4);
            Buffer.BlockCopy(m_Bytes, m_Position, into, start * 4, count * 4);
            m_Position += count * 4;
        }

        public uint VarUInt()
        {
            uint value = 0;
            for (int shift = 0; shift < 35; shift += 7)
            {
                byte b = U8();
                value |= (uint)(b & 0x7F) << shift;
                if ((b & 0x80) == 0) return value;
            }

            throw new SkeletonFormatException($"baked data has a malformed varint before byte {m_Position}.");
        }

        public int VarInt()
        {
            uint value = VarUInt();
            return (int)(value >> 1) ^ -(int)(value & 1);
        }

        /// <summary>
        ///     A count or length, checked against what is left of the file so a damaged value cannot allocate
        ///     gigabytes. <paramref name="minBytesEach" />: the fewest bytes one element can take.
        /// </summary>
        public int Count(int minBytesEach = 1)
        {
            uint value = VarUInt();
            if (value > int.MaxValue || (long)value * minBytesEach > m_Bytes.Length - m_Position)
                throw new SkeletonFormatException($"baked data has an impossible count {value} at byte {m_Position}.");

            return (int)value;
        }

        public byte[] Bytes()
        {
            int length = Count();
            byte[] bytes = new byte[length];
            Buffer.BlockCopy(m_Bytes, m_Position, bytes, 0, length);
            m_Position += length;
            return bytes;
        }

        public string Utf8()
        {
            int length = Count();
            string value = Encoding.UTF8.GetString(m_Bytes, m_Position, length);
            m_Position += length;
            return value;
        }
    }
}