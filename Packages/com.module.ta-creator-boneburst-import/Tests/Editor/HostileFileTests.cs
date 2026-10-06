using System.Linq;
using BoneBurst.Data;
using NUnit.Framework;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Hostile JSON the readers must refuse with a <see cref="SkeletonFormatException" /> and a reason, never
    ///     crash on: the BoneBurst Editor's E7 step 5 findings H1 and H2 (<c>Doc/Review/BoneBurstImport-HostileFiles-Plan.md</c>).
    /// </summary>
    /// <remarks>
    ///     On the old code the draw-order cases threw <c>IndexOutOfRangeException</c> and the deep document overflowed
    ///     the stack, which kills the Editor; the controls show valid files still read.
    /// </remarks>
    public class HostileFileTests
    {
        private const string Header =
            "\"skeleton\":{\"spine\":\"4.3.0\"},\"bones\":[{\"name\":\"root\"}]," +
            "\"slots\":[{\"name\":\"a\",\"bone\":\"root\"},{\"name\":\"b\",\"bone\":\"root\"},{\"name\":\"c\",\"bone\":\"root\"}]";

        private static string WithDrawOrder(string offsets)
        {
            return "{" + Header + ",\"animations\":{\"x\":{\"drawOrder\":[{\"offsets\":[" + offsets + "]}]}}}";
        }

        private static string WithFolder(string offsets)
        {
            return "{" + Header + ",\"animations\":{\"x\":{\"drawOrderFolder\":[{\"slots\":[\"a\",\"b\",\"c\"]," +
                   "\"keys\":[{\"offsets\":[" + offsets + "]}]}]}}}";
        }

        private static int[] OrderOf(string json)
        {
            SkeletonDef s = SkeletonJsonReader.Read(json);
            return s.Animations[0].Timelines.Single().DrawOrders[0];
        }

        private static void AssertRefused(string json, string reason)
        {
            SkeletonFormatException e = Assert.Throws<SkeletonFormatException>(() => SkeletonJsonReader.Read(json));
            StringAssert.Contains(reason, e.Message);
        }

        [Test]
        public void DrawOrder_MovingOneSlotTwice_IsRefusedNamingTheSlot()
        {
            AssertRefused(WithDrawOrder("{\"slot\":\"a\",\"offset\":1},{\"slot\":\"a\",\"offset\":2}"),
                "moves slot a twice");
        }

        [Test]
        public void DrawOrder_SlotsOutOfSlotOrder_IsRefused()
        {
            AssertRefused(WithDrawOrder("{\"slot\":\"c\",\"offset\":-2},{\"slot\":\"a\",\"offset\":1}"),
                "lists slot a after a slot that follows it");
        }

        [Test]
        public void DrawOrder_TwoSlotsToOnePlace_IsRefused()
        {
            AssertRefused(WithDrawOrder("{\"slot\":\"a\",\"offset\":2},{\"slot\":\"b\",\"offset\":1}"),
                "moves slot b to a place another slot takes");
        }

        [Test]
        public void DrawOrderFolder_MovingOneSlotTwice_IsRefused()
        {
            AssertRefused(WithFolder("{\"slot\":\"b\",\"offset\":1},{\"slot\":\"b\",\"offset\":-1}"),
                "moves slot b twice");
        }

        [Test]
        public void DrawOrder_Valid_StillReads()
        {
            // a to the end, then c one back: a takes place 2, c place 1, and b fills place 0.
            Assert.AreEqual(new[] { 1, 2, 0 },
                OrderOf(WithDrawOrder("{\"slot\":\"a\",\"offset\":2},{\"slot\":\"c\",\"offset\":-1}")));
            Assert.AreEqual(new[] { 1, 0, 2 }, OrderOf(WithDrawOrder("{\"slot\":\"a\",\"offset\":1}")));
        }

        [Test]
        public void Json_NestedPastTheLimit_IsRefused()
        {
            const int depth = 100000;
            string json = new string('[', depth) + new string(']', depth);
            SkeletonFormatException e = Assert.Throws<SkeletonFormatException>(() => JsonNode.Parse(json));
            StringAssert.Contains($"nested deeper than {JsonNode.MaxDepth} levels", e.Message);
            Assert.Throws<SkeletonFormatException>(() => SkeletonJsonReader.Read(json));

            string objects = string.Concat(Enumerable.Repeat("{\"k\":", JsonNode.MaxDepth + 1)) + "0" +
                             new string('}', JsonNode.MaxDepth + 1);
            Assert.Throws<SkeletonFormatException>(() => JsonNode.Parse(objects));
        }

        [Test]
        public void Json_NestedToTheLimit_StillParses()
        {
            string json = new string('[', JsonNode.MaxDepth) + new string(']', JsonNode.MaxDepth);
            JsonNode node = JsonNode.Parse(json);
            for (int i = 1; i < JsonNode.MaxDepth; i++) node = node[0];
            Assert.IsTrue(node.IsArray);
            Assert.AreEqual(0, node.Count);

            // Depth is nesting, not a running count: siblings each come back up.
            string wide = "[" + string.Join(",", Enumerable.Repeat(new string('[', 900) + new string(']', 900), 50)) +
                          "]";
            Assert.AreEqual(50, JsonNode.Parse(wide).Count);
        }
    }
}
