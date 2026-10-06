using BoneBurst.Data;

namespace BoneBurst.Blob
{
    /// <summary>
    ///     One animation: a range of <see cref="TimelineBlob" />s and its duration.
    /// </summary>
    public struct AnimationBlob
    {
        public float Duration;
        public int TimelineStart, TimelineCount;

        /// <summary>
        ///     Bones keyed by bone timelines, in <see cref="BlobView.AnimationBones" />.
        /// </summary>
        public int BonesStart, BonesCount;
    }

    /// <summary>
    ///     One timeline, flattened: offsets into the blob's shared animation arrays. Layout per kind matches
    ///     <see cref="TimelineDef" /> (frames of <see cref="Entries" /> floats, curves as baked by
    ///     <see cref="CurveBaker" />) so sampling reproduces the stock runtime exactly.
    /// </summary>
    public struct TimelineBlob
    {
        public TimelineKind Kind;

        /// <summary>
        ///     Bone, slot or constraint index; -1 for "every physics constraint", draw order and events.
        /// </summary>
        public int Target;

        public int FrameCount, Entries;

        /// <summary>
        ///     Start in <see cref="BlobView.Frames" />: <c>FrameCount × Entries</c> floats.
        /// </summary>
        public int FramesStart;

        /// <summary>
        ///     Start in <see cref="BlobView.Curves" />, or -1 for a timeline without curves.
        /// </summary>
        public int CurvesStart;

        /// <summary>
        ///     Kind-specific side data.
        ///     SlotAttachment: <c>FrameCount</c> attachment-key indices (-1 clears) in <see cref="BlobView.Ints" />.
        ///     Deform: <c>FrameCount × ExtraLength</c> floats in <see cref="BlobView.DeformFrames" />.
        ///     DrawOrder / DrawOrderFolder: per frame, a null flag then <c>ExtraLength</c> ints, in Ints.
        ///     DrawOrderFolder also has its <c>ExtraLength</c> folder slots first, at <see cref="FolderStart" />.
        ///     Event: <c>FrameCount</c> <see cref="EventBlob" />s from <see cref="BlobView.Events" />.
        /// </summary>
        public int ExtraStart;

        /// <summary>
        ///     Deform: floats per frame. DrawOrder: slot count. DrawOrderFolder: folder size.
        /// </summary>
        public int ExtraLength;

        /// <summary>
        ///     DrawOrderFolder: start of the folder's slot list in Ints.
        /// </summary>
        public int FolderStart;

        /// <summary>
        ///     Deform and Sequence: the blob attachment the timeline keys.
        /// </summary>
        public int Attachment;
    }

    /// <summary>
    ///     One keyed event. The string is an index into the blob's managed string table; events are dispatched on
    ///     the main thread, where strings live.
    /// </summary>
    public struct EventBlob
    {
        public float Time;
        public int Event, Int;
        public float Float;
        public int String;
        public float Volume, Balance;
    }

    /// <summary>
    ///     A (slot, placeholder name) pair an attachment timeline can switch to. Resolved to an attachment index per
    ///     instance whenever its skin changes, so jobs never look up names.
    /// </summary>
    public struct AttachmentKey
    {
        public int Slot;
        public string Name;
    }
}