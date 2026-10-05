using System;
using System.Collections.Generic;
using BoneBurst.Blob;
using BoneBurst.Data;

namespace BoneBurst.Anim
{
    /// <summary>
    ///     Default and per-pair mix durations (AnimationState.md §3.1). Animations are indices into the blob;
    ///     <see cref="BoneAnimationState.EmptyAnimation" /> never matches a pair, as in stock.
    /// </summary>
    public sealed class BoneAnimationStateData
    {
        private readonly BlobContent m_Content;
        private readonly Dictionary<(int from, int to), float> m_Mixes = new();

        /// <summary>
        ///     Mix duration for pairs without their own. 0 by default (spine-unity's importer uses 0.2).
        /// </summary>
        public float DefaultMix;

        /// <summary>
        ///     Each event's baked key id, by event index; <c>BoneBurstAsset</c> sets it from its keys. Null:
        ///     events are delivered with <see cref="BoneBurstKey.EmptyId" />.
        /// </summary>
        internal int[] EventKeyIds;

        public BoneAnimationStateData(BlobContent content)
        {
            m_Content = content ?? throw new ArgumentNullException(nameof(content));
        }

        public BlobContent Content => m_Content;

        /// <exception cref="ArgumentException">Either animation does not exist.</exception>
        public void SetMix(string from, string to, float duration)
        {
            SetMix(Find(from), Find(to), duration);
        }

        public void SetMix(int from, int to, float duration)
        {
            m_Mixes[(from, to)] = duration;
        }

        public float GetMix(int from, int to)
        {
            return from >= 0 && to >= 0 && m_Mixes.TryGetValue((from, to), out float duration) ? duration : DefaultMix;
        }

        private int Find(string name)
        {
            int index = Array.FindIndex(m_Content.Skeleton.Animations, a => a.Name == name);
            return index >= 0 ? index : throw new ArgumentException($"Animation not found: {name}", nameof(name));
        }
    }

    /// <summary>
    ///     One animation on a track, with the settings of the stock <c>TrackEntry</c> (AnimationState.md §2.2–2.4).
    /// </summary>
    public sealed class BoneTrackEntry
    {
        public bool Additive, Reverse, ShortestRotation;
        internal float AnimationLastValue = -1, NextAnimationLast = -1, TrackLast = -1, NextTrackLast = -1;
        public float AnimationStart, AnimationEnd;
        internal float DelayValue;
        public float EventThreshold, AlphaAttachmentThreshold, MixAttachmentThreshold, MixDrawOrderThreshold;
        internal bool KeepHold;

        public bool Loop;
        public float MixTime, MixDuration;
        internal BoneTrackEntry Previous, NextEntry, MixingFromEntry, MixingToEntry;
        internal float[] Rotation = Array.Empty<float>();
        internal int RotationCount;
        internal BoneAnimationState State;
        public float TimeScale = 1, Alpha = 1;
        internal BoneTrackEntry[] TimelineHoldMix = Array.Empty<BoneTrackEntry>();
        internal byte[] TimelineModes = Array.Empty<byte>();
        public float TrackTime, TrackEnd = float.MaxValue;

        public int TrackIndex { get; internal set; }

        /// <summary>
        ///     Animation index in the blob, or <see cref="BoneAnimationState.EmptyAnimation" />.
        /// </summary>
        public int Animation { get; internal set; }

        /// <summary>
        ///     Sum of the alphas used in the last mixing-out apply; 0 lets the entry be removed early.
        /// </summary>
        public float TotalAlpha { get; internal set; }

        public string Name => Animation < 0 ? "<empty>" : State.Data.Content.Skeleton.Animations[Animation].Name;
        public bool IsEmptyAnimation => Animation == BoneAnimationState.EmptyAnimation;
        public BoneTrackEntry Next => NextEntry;
        public BoneTrackEntry MixingFrom => MixingFromEntry;
        public BoneTrackEntry MixingTo => MixingToEntry;
        public bool WasApplied => NextTrackLast != -1;

        public float Delay
        {
            get => DelayValue;
            set => DelayValue = value >= 0 ? value : throw new ArgumentOutOfRangeException(nameof(value));
        }

        /// <summary>
        ///     Writes both the last and the next "last" animation time (§2.3).
        /// </summary>
        public float AnimationLast
        {
            get => AnimationLastValue;
            set
            {
                AnimationLastValue = value;
                NextAnimationLast = value;
            }
        }

        internal float Duration => Animation < 0 ? 0 : State.Data.Content.Animations[Animation].Duration;

        internal int TimelineCount => Animation < 0 ? 0 : State.Data.Content.Animations[Animation].TimelineCount;

        public float AnimationTime => AnimationTimeAt(TrackTime);

        public float TrackComplete
        {
            get
            {
                float duration = AnimationEnd - AnimationStart;
                if (duration != 0)
                {
                    if (Loop) return duration * (1 + (int)(TrackTime / duration));
                    if (TrackTime < duration) return duration;
                }

                return TrackTime;
            }
        }

        public bool IsComplete => TrackTime >= AnimationEnd - AnimationStart;

        public event Action<BoneTrackEntry> Start, Interrupt, End, Dispose, Complete;
        public event Action<BoneTrackEntry, BoneBurstEvent> Event;

        /// <summary>
        ///     <see cref="AnimationTime" /> at a given track time; the steady step computes it before committing.
        /// </summary>
        internal float AnimationTimeAt(float trackTime)
        {
            if (!Loop) return Math.Min(trackTime + AnimationStart, AnimationEnd);
            float duration = AnimationEnd - AnimationStart;
            if (duration == 0) return AnimationStart;
            return trackTime % duration + AnimationStart;
        }

        /// <summary>
        ///     Mix progress, linear (non-linear mix interpolation is not supported).
        /// </summary>
        public float Mix()
        {
            if (MixDuration == 0) return 1;
            float m = MixTime / MixDuration;
            return m >= 1 ? 1 : m;
        }

        /// <summary>
        ///     Sets the mix duration and recomputes the delay the way <c>AddAnimation</c> does (§2.3).
        /// </summary>
        public void SetMixDuration(float mixDuration, float delay)
        {
            MixDuration = mixDuration;
            if (delay <= 0) delay = Previous == null ? 0 : Math.Max(delay + Previous.TrackComplete - mixDuration, 0);
            DelayValue = delay;
        }

        public void ResetRotationDirections()
        {
            ClearRotation();
        }

        public void AllowImmediateQueue()
        {
            if (NextTrackLast < 0) NextTrackLast = 0;
        }

        internal void ClearRotation()
        {
            Array.Clear(Rotation, 0, Rotation.Length);
            RotationCount = 0;
        }

        internal void Raise(EventKind kind, BoneBurstEvent e = default)
        {
            switch (kind)
            {
                case EventKind.Start: Start?.Invoke(this); break;
                case EventKind.Interrupt: Interrupt?.Invoke(this); break;
                case EventKind.End: End?.Invoke(this); break;
                case EventKind.Dispose: Dispose?.Invoke(this); break;
                case EventKind.Complete: Complete?.Invoke(this); break;
                case EventKind.Event: Event?.Invoke(this, e); break;
            }
        }
    }

    internal enum EventKind : byte
    {
        Start,
        Interrupt,
        End,
        Dispose,
        Complete,
        Event
    }

    /// <summary>
    ///     A managed port of the stock 4.3 <c>AnimationState</c> orchestration (<c>Doc/Format/AnimationState.md</c>):
    ///     tracks, queueing, mixing bookkeeping, hold computation and the listener queue. Timelines themselves are
    ///     applied by the pose job from the commands <see cref="Apply" /> emits.
    /// </summary>
    /// <remarks>
    ///     Per frame: <see cref="Update" />, then <see cref="Apply" /> (fills a <see cref="CommandBuffer" />), then
    ///     the job, then <see cref="AfterApply" /> (total alphas, rotation memory, events, drain). Listener timing
    ///     matches stock: Start/Interrupt/End/Dispose at the end of Update, Event/Complete at the end of Apply.
    ///     Only linear mix interpolation is supported.
    /// </remarks>
    public sealed class BoneAnimationState
    {
        /// <summary>
        ///     The animation index of the empty animation (no timelines, duration 0).
        /// </summary>
        public const int EmptyAnimation = -1;

        private readonly HashSet<ulong>[] m_AnimationIds;
        private readonly List<int> m_EventScratch = new();
        private readonly Dictionary<ulong, BoneTrackEntry> m_PropertyIds = new();
        private readonly List<(EventKind kind, BoneTrackEntry entry, BoneBurstEvent e)> m_Queue = new();
        private readonly List<Step> m_Steps = new();

        private readonly List<BoneTrackEntry> m_Tracks = new();
        private bool m_AnimationsChanged, m_DrainDisabled;
        private float m_SteadyAnimationTime;

        // The entry and animation time of the last steady step, for its after-job step (AfterSteady).
        private BoneTrackEntry m_SteadyEntry;
        private float m_TimeScale = 1;

        public BoneAnimationState(BoneAnimationStateData data)
        {
            Data = data ?? throw new ArgumentNullException(nameof(data));
            m_AnimationIds = new HashSet<ulong>[data.Content.Animations.Length];
        }

        public BoneAnimationStateData Data { get; }

        /// <summary>
        ///     Attachment-state epoch (Timelines.md §5.5); advanced by 2 per <see cref="Apply" />.
        /// </summary>
        public int UnkeyedState { get; private set; }

        public float TimeScale
        {
            get => m_TimeScale;
            set => m_TimeScale = value;
        }

        public IReadOnlyList<BoneTrackEntry> Tracks => m_Tracks;

        /// <summary>
        ///     True while any track has an entry.
        /// </summary>
        public bool HasEntries
        {
            get
            {
                foreach (BoneTrackEntry e in m_Tracks)
                    if (e != null)
                        return true;

                return false;
            }
        }

        public event Action<BoneTrackEntry> Start, Interrupt, End, Dispose, Complete;
        public event Action<BoneTrackEntry, BoneBurstEvent> Event;

        public BoneTrackEntry GetTrack(int trackIndex)
        {
            if (trackIndex < 0) throw new ArgumentOutOfRangeException(nameof(trackIndex));
            return trackIndex < m_Tracks.Count ? m_Tracks[trackIndex] : null;
        }

        // ---------------------------------------------------------------- §4 track API

        public BoneTrackEntry SetAnimation(int trackIndex, string animationName, bool loop)
        {
            return SetAnimation(trackIndex, FindAnimation(animationName), loop);
        }

        public BoneTrackEntry SetAnimation(int trackIndex, int animation, bool loop)
        {
            if (trackIndex < 0) throw new ArgumentOutOfRangeException(nameof(trackIndex));
            bool interrupt = true;
            BoneTrackEntry current = ExpandToIndex(trackIndex);
            if (current != null)
            {
                if (current.NextTrackLast == -1 && current.Animation == animation)
                {
                    m_Tracks[trackIndex] = current.MixingFromEntry;
                    Enqueue(EventKind.Interrupt, current);
                    Enqueue(EventKind.End, current);
                    ClearNext(current);
                    current = current.MixingFromEntry;
                    interrupt = false;
                }
                else
                {
                    ClearNext(current);
                }
            }

            BoneTrackEntry entry = NewEntry(trackIndex, animation, loop, current);
            SetTrack(trackIndex, entry, interrupt);
            Drain();
            return entry;
        }

        public BoneTrackEntry AddAnimation(int trackIndex, string animationName, bool loop, float delay)
        {
            return AddAnimation(trackIndex, FindAnimation(animationName), loop, delay);
        }

        public BoneTrackEntry AddAnimation(int trackIndex, int animation, bool loop, float delay)
        {
            if (trackIndex < 0) throw new ArgumentOutOfRangeException(nameof(trackIndex));
            BoneTrackEntry last = ExpandToIndex(trackIndex);
            if (last != null)
                while (last.NextEntry != null)
                    last = last.NextEntry;

            BoneTrackEntry entry = NewEntry(trackIndex, animation, loop, last);
            if (last == null)
            {
                SetTrack(trackIndex, entry, true);
                Drain();
                if (delay < 0) delay = 0;
            }
            else
            {
                last.NextEntry = entry;
                entry.Previous = last;
                if (delay <= 0) delay = Math.Max(delay + last.TrackComplete - entry.MixDuration, 0);
            }

            entry.DelayValue = delay;
            return entry;
        }

        public BoneTrackEntry SetEmptyAnimation(int trackIndex, float mixDuration)
        {
            BoneTrackEntry entry = SetAnimation(trackIndex, EmptyAnimation, false);
            entry.MixDuration = mixDuration;
            entry.TrackEnd = mixDuration;
            return entry;
        }

        public BoneTrackEntry AddEmptyAnimation(int trackIndex, float mixDuration, float delay)
        {
            BoneTrackEntry entry = AddAnimation(trackIndex, EmptyAnimation, false, delay);
            if (delay <= 0) entry.DelayValue = Math.Max(entry.DelayValue + entry.MixDuration - mixDuration, 0);
            entry.MixDuration = mixDuration;
            entry.TrackEnd = mixDuration;
            return entry;
        }

        public void SetEmptyAnimations(float mixDuration)
        {
            bool old = m_DrainDisabled;
            m_DrainDisabled = true;
            for (int i = 0, n = m_Tracks.Count; i < n; i++)
            {
                BoneTrackEntry current = m_Tracks[i];
                if (current != null) SetEmptyAnimation(current.TrackIndex, mixDuration);
            }

            m_DrainDisabled = old;
            Drain();
        }

        public void ClearTrack(int trackIndex)
        {
            if (trackIndex < 0) throw new ArgumentOutOfRangeException(nameof(trackIndex));
            if (trackIndex >= m_Tracks.Count) return;
            BoneTrackEntry current = m_Tracks[trackIndex];
            if (current == null) return;
            Enqueue(EventKind.End, current);
            ClearNext(current);
            BoneTrackEntry entry = current;
            while (entry.MixingFromEntry != null)
            {
                BoneTrackEntry from = entry.MixingFromEntry;
                Enqueue(EventKind.End, from);
                entry.MixingFromEntry = null;
                entry.MixingToEntry = null;
                entry = from;
            }

            m_Tracks[current.TrackIndex] = null;
            Drain();
        }

        public void ClearTracks()
        {
            bool old = m_DrainDisabled;
            m_DrainDisabled = true;
            for (int i = 0, n = m_Tracks.Count; i < n; i++) ClearTrack(i);
            m_Tracks.Clear();
            m_DrainDisabled = old;
            Drain();
        }

        public void ClearNext(BoneTrackEntry entry)
        {
            for (BoneTrackEntry next = entry.NextEntry; next != null; next = next.NextEntry)
                Enqueue(EventKind.Dispose, next);

            entry.NextEntry = null;
        }

        private BoneTrackEntry ExpandToIndex(int index)
        {
            if (index < m_Tracks.Count) return m_Tracks[index];
            while (m_Tracks.Count <= index) m_Tracks.Add(null);
            return null;
        }

        private BoneTrackEntry NewEntry(int trackIndex, int animation, bool loop, BoneTrackEntry last)
        {
            BoneTrackEntry entry = new()
            {
                State = this, TrackIndex = trackIndex, Animation = animation, Loop = loop
            };
            entry.AnimationEnd = entry.Duration;
            entry.MixDuration = last == null ? 0 : Data.GetMix(last.Animation, animation);
            return entry;
        }

        private void SetTrack(int index, BoneTrackEntry entry, bool interrupt)
        {
            BoneTrackEntry from = ExpandToIndex(index);
            m_Tracks[index] = entry;
            entry.Previous = null;
            if (from != null)
            {
                from.NextEntry = null;
                if (interrupt) Enqueue(EventKind.Interrupt, from);
                entry.MixingFromEntry = from;
                from.MixingToEntry = entry;
                entry.MixTime = 0;
                from.ClearRotation();
            }

            Enqueue(EventKind.Start, entry);
        }

        private int FindAnimation(string name)
        {
            int index = Array.FindIndex(Data.Content.Skeleton.Animations, a => a.Name == name);
            return index >= 0 ? index : throw new ArgumentException($"Animation not found: {name}", nameof(name));
        }

        // ---------------------------------------------------------------- §5 Update

        public void Update(float delta)
        {
            delta *= m_TimeScale;
            for (int i = 0, n = m_Tracks.Count; i < n; i++)
            {
                BoneTrackEntry current = m_Tracks[i];
                if (current == null) continue;
                current.AnimationLastValue = current.NextAnimationLast;
                current.TrackLast = current.NextTrackLast;
                float currentDelta = delta * current.TimeScale;

                if (current.DelayValue > 0)
                {
                    current.DelayValue -= currentDelta;
                    if (current.DelayValue > 0) continue;
                    currentDelta = -current.DelayValue;
                    current.DelayValue = 0;
                }

                BoneTrackEntry next = current.NextEntry;
                if (next != null)
                {
                    float nextTime = current.TrackLast - next.DelayValue;
                    if (nextTime >= 0)
                    {
                        next.DelayValue = 0;
                        next.TrackTime += current.TimeScale == 0
                            ? 0
                            : (nextTime / current.TimeScale + delta) * next.TimeScale;
                        current.TrackTime += currentDelta;
                        SetTrack(i, next, true);
                        while (next.MixingFromEntry != null)
                        {
                            next.MixTime += delta;
                            next = next.MixingFromEntry;
                        }

                        continue;
                    }
                }
                else if (current.TrackLast >= current.TrackEnd && current.MixingFromEntry == null)
                {
                    m_Tracks[i] = null;
                    Enqueue(EventKind.End, current);
                    ClearNext(current);
                    continue;
                }

                if (current.MixingFromEntry != null && UpdateMixingFrom(current, delta))
                {
                    BoneTrackEntry from = current.MixingFromEntry;
                    current.MixingFromEntry = null;
                    if (from != null) from.MixingToEntry = null;
                    while (from != null)
                    {
                        Enqueue(EventKind.End, from);
                        from = from.MixingFromEntry;
                    }
                }

                current.TrackTime += currentDelta;
            }

            Drain();
        }

        private bool UpdateMixingFrom(BoneTrackEntry to, float delta)
        {
            BoneTrackEntry from = to.MixingFromEntry;
            if (from == null) return true;
            bool finished = UpdateMixingFrom(from, delta);
            from.AnimationLastValue = from.NextAnimationLast;
            from.TrackLast = from.NextTrackLast;
            if (to.NextTrackLast != -1 && to.MixTime >= to.MixDuration)
            {
                if (from.TotalAlpha == 0 || to.MixDuration == 0)
                {
                    to.MixingFromEntry = from.MixingFromEntry;
                    if (from.MixingFromEntry != null) from.MixingFromEntry.MixingToEntry = to;
                    if (from.TotalAlpha == 0)
                        for (BoneTrackEntry e = to; e.MixingToEntry != null; e = e.MixingToEntry)
                            e.KeepHold = true;

                    Enqueue(EventKind.End, from);
                }

                return finished;
            }

            from.TrackTime += delta * from.TimeScale;
            to.MixTime += delta;
            return false;
        }

        // ---------------------------------------------------------------- steady step (Perf2 plan P6)

        /// <summary>
        ///     <see cref="Update" /> then <see cref="Apply" /> in one step, for the common steady state: one track
        ///     holding one entry, playing, with no delay, no next entry, no mix, not reversed, at alpha 1, and nothing
        ///     queued. Then Update only advances the times and Apply emits one <see cref="CommandKind.Fast" /> command,
        ///     so this does exactly those operations, statement for statement (the same float results), without the
        ///     <see cref="CommandBuffer" /> and the post-job steps. Returns false and changes nothing otherwise,
        ///     or when this frame would end the track or apply it at alpha 0; the caller then runs
        ///     <see cref="Update" /> and <see cref="Apply" />. After the job: <see cref="SteadyNeedsAfter" /> and
        ///     <see cref="AfterSteady" />.
        /// </summary>
        public bool TryAdvanceSteady(float delta, out ApplyCommand command, out int unkeyedState)
        {
            command = default;
            unkeyedState = 0;
            if (m_Tracks.Count != 1 || m_Queue.Count != 0) return false;
            BoneTrackEntry current = m_Tracks[0];
            if (current == null || current.DelayValue > 0 || current.NextEntry != null ||
                current.MixingFromEntry != null || current.Animation < 0 || current.Reverse || current.Alpha != 1)
                return false;

            // Update (§5), on locals until every check has passed.
            delta *= m_TimeScale;
            float animationLast = current.NextAnimationLast, trackLast = current.NextTrackLast;
            if (trackLast >= current.TrackEnd) return false; // Update would end the track
            float currentDelta = delta * current.TimeScale;
            float trackTime = current.TrackTime;
            trackTime += currentDelta;
            if (trackTime >= current.TrackEnd) return false; // Apply would use alpha 0

            // Apply (§6) of a lone track 0 entry at alpha 1: one Fast command.
            float animationTime = current.AnimationTimeAt(trackTime);
            current.AnimationLastValue = animationLast;
            current.TrackLast = trackLast;
            current.TrackTime = trackTime;
            command = new ApplyCommand
            {
                Animation = current.Animation, LastTime = animationLast, Time = animationTime, Alpha = current.Alpha,
                FireEvents = true, ModesStart = -1, HoldFactorsStart = -1, RotationStart = -1, Kind = CommandKind.Fast
            };
            current.NextAnimationLast = animationTime;
            current.NextTrackLast = current.TrackTime;
            unkeyedState = UnkeyedState;
            UnkeyedState += 2;
            m_SteadyEntry = current;
            m_SteadyAnimationTime = animationTime;
            return true;
        }

        /// <summary>
        ///     After a steady step's job: whether <see cref="AfterApply" /> would have anything to do, an event fired
        ///     or a Complete to queue, judged on the entry as it is now, as <see cref="AfterApply" /> judges it.
        /// </summary>
        public bool SteadyNeedsAfter(int firedCount)
        {
            if (m_SteadyEntry == null) return false;
            if (firedCount > 0) return true;
            BoneTrackEntry e = m_SteadyEntry;
            if (Completes(e, m_SteadyAnimationTime)) return true;
            m_SteadyEntry = null;
            return false;
        }

        /// <summary>
        ///     <see cref="AfterApply" /> for a steady step: its events and Complete queued as the step's own, then the
        ///     queue drained. A Fast command has no rotation memory and no total alpha to copy back.
        /// </summary>
        public void AfterSteady(ReadOnlySpan<FiredEvent> fired)
        {
            BoneTrackEntry e = m_SteadyEntry;
            m_SteadyEntry = null;
            if (e == null) return;
            List<int> events = m_EventScratch;
            events.Clear();
            foreach (FiredEvent f in fired)
                if (f.Command == 0)
                    events.Add(f.Event);

            QueueEvents(e, m_SteadyAnimationTime, events);
            Drain();
        }

        /// <summary>
        ///     Emits this frame's commands. Returns true if any track was applied. The pose job must run them
        ///     before <see cref="AfterApply" />.
        /// </summary>
        public bool Apply(CommandBuffer buffer)
        {
            buffer.Clear();
            m_Steps.Clear();
            m_SteadyEntry = null;
            if (m_AnimationsChanged) AnimationsChanged();
            bool applied = false;
            for (int i = 0, n = m_Tracks.Count; i < n; i++)
            {
                BoneTrackEntry current = m_Tracks[i];
                if (current == null || current.DelayValue > 0) continue;
                applied = true;
                float alpha = current.Alpha;
                if (current.MixingFromEntry != null)
                    alpha *= ApplyMixingFrom(current, buffer);
                else if (current.TrackTime >= current.TrackEnd && current.NextEntry == null) alpha = 0;

                float lastTime = current.AnimationLastValue,
                    animationTime = current.AnimationTime,
                    applyTime = animationTime;
                bool fireEvents = true;
                if (current.Reverse)
                {
                    applyTime = current.Duration - applyTime;
                    fireEvents = false;
                }

                if (current.Animation >= 0)
                {
                    ApplyCommand command = new()
                    {
                        Animation = current.Animation, LastTime = lastTime, Time = applyTime, Alpha = alpha,
                        FireEvents = fireEvents, ModesStart = -1, HoldFactorsStart = -1, RotationStart = -1
                    };
                    if (i == 0 && alpha == 1)
                    {
                        command.Kind = CommandKind.Fast;
                    }
                    else
                    {
                        command.Kind = CommandKind.Current;
                        command.Retain = alpha >= current.AlphaAttachmentThreshold;
                        command.Add = current.Additive;
                        bool shortest = current.Additive || current.ShortestRotation;
                        command.RotateMixing = !shortest;
                        command.ModesStart = buffer.AddModes(current.TimelineModes, current.TimelineCount);
                        if (!shortest)
                        {
                            command.FirstFrame = EnsureRotation(current);
                            command.RotationStart = buffer.AddRotation(current.Rotation, current.TimelineCount);
                        }
                    }

                    m_Steps.Add(new Step(current, buffer.Add(command, current), animationTime, lastTime, true, false,
                        current.Reverse));
                }
                else
                {
                    m_Steps.Add(new Step(current, -1, animationTime, lastTime, true, false, current.Reverse));
                }

                current.NextAnimationLast = animationTime;
                current.NextTrackLast = current.TrackTime;
            }

            buffer.UnkeyedState = UnkeyedState;
            UnkeyedState += 2;
            return applied;
        }

        private float ApplyMixingFrom(BoneTrackEntry to, CommandBuffer buffer)
        {
            BoneTrackEntry from = to.MixingFromEntry;
            float fromMix = from.MixingFromEntry != null ? ApplyMixingFrom(from, buffer) : 1;
            float mix = to.Mix();
            float a = from.Alpha * fromMix, keep = 1 - mix * to.Alpha;
            float alphaMix = a * (1 - mix), alphaHold = keep > 0 ? alphaMix / keep : a;

            bool retainAttachments = mix < from.MixAttachmentThreshold, drawOrder = mix < from.MixDrawOrderThreshold;
            bool add = from.Additive, shortest = add || from.ShortestRotation;
            bool firstFrame = !shortest && EnsureRotation(from);

            float lastTime = from.AnimationLastValue, animationTime = from.AnimationTime, applyTime = animationTime;
            bool fireEvents = false;
            if (from.Reverse) applyTime = from.Duration - applyTime;
            else if (mix < from.EventThreshold) fireEvents = true;

            int commandIndex = -1;
            if (from.Animation >= 0)
            {
                ApplyCommand command = new()
                {
                    Kind = CommandKind.MixingFrom, Animation = from.Animation, LastTime = lastTime, Time = applyTime,
                    Alpha = alphaMix, AlphaHold = alphaHold, Add = add, FireEvents = fireEvents,
                    Retain = retainAttachments, DrawOrder = drawOrder,
                    AlphaAttachmentThreshold = from.AlphaAttachmentThreshold, RotateMixing = !shortest,
                    FirstFrame = firstFrame, HoldFactorsStart = -1, RotationStart = -1
                };
                command.ModesStart = buffer.AddModes(from.TimelineModes, from.TimelineCount);
                command.HoldFactorsStart = buffer.AddHoldFactors(from.TimelineHoldMix, from.TimelineCount);
                if (!shortest) command.RotationStart = buffer.AddRotation(from.Rotation, from.TimelineCount);
                commandIndex = buffer.Add(command, from);
            }
            else
            {
                from.TotalAlpha = 0;
            }

            m_Steps.Add(new Step(from, commandIndex, animationTime, lastTime, to.MixDuration > 0, true,
                from.Reverse && mix < from.EventThreshold));
            from.NextAnimationLast = animationTime;
            from.NextTrackLast = from.TrackTime;
            return mix;
        }

        /// <summary>
        ///     Sizes the entry's rotation memory; true on the first frame (memory count was not 2 × timelines).
        /// </summary>
        private static bool EnsureRotation(BoneTrackEntry entry)
        {
            int size = entry.TimelineCount * 2;
            if (entry.RotationCount == size) return false;
            if (entry.Rotation.Length < size) Array.Resize(ref entry.Rotation, size);
            entry.RotationCount = size;
            return true;
        }

        /// <summary>
        ///     After the pose job: total alphas and rotation memory back into the entries, events queued in apply
        ///     order around each entry's Complete, then the listener queue drained.
        /// </summary>
        public void AfterApply(CommandBuffer buffer, ReadOnlySpan<FiredEvent> fired, ReadOnlySpan<float> totalAlpha,
            ReadOnlySpan<float> rotation)
        {
            buffer.CopyBack(rotation);
            List<int> events = m_EventScratch;
            foreach (Step step in m_Steps)
            {
                BoneTrackEntry e = step.Entry;
                if (step.IsMixingFrom && step.Command >= 0) e.TotalAlpha = totalAlpha[step.Command];
                events.Clear();
                if (step.Command >= 0 && fired.Length > 0)
                    foreach (FiredEvent f in fired)
                        if (f.Command == step.Command)
                            events.Add(f.Event);

                if (step.ReverseEvents && e.Animation >= 0) EventsReverse(e, step.LastTime, step.AnimationTime, events);
                if (step.QueueEvents) QueueEvents(e, step.AnimationTime, events);
            }

            m_Steps.Clear();
            Drain();
        }

        // §8.1
        private void QueueEvents(BoneTrackEntry e, float animationTime, List<int> events)
        {
            BlobContent content = Data.Content;
            float duration = e.AnimationEnd - e.AnimationStart;
            float split = e.TrackLast % duration;
            if (e.Reverse) split = duration - split;
            int k = 0, n = events.Count;
            for (; k < n; k++)
            {
                EventBlob ev = content.Events[events[k]];
                if ((ev.Time < split) ^ e.Reverse) break;
                if (e.AnimationStart <= ev.Time && ev.Time <= e.AnimationEnd) Enqueue(EventKind.Event, e, Deliver(ev));
            }

            if (Completes(e, animationTime)) Enqueue(EventKind.Complete, e);
            for (; k < n; k++)
            {
                EventBlob ev = content.Events[events[k]];
                if (e.AnimationStart <= ev.Time && ev.Time <= e.AnimationEnd) Enqueue(EventKind.Event, e, Deliver(ev));
            }
        }

        private static bool Completes(BoneTrackEntry e, float animationTime)
        {
            float duration = e.AnimationEnd - e.AnimationStart;
            if (e.Loop)
                return duration == 0 || ((int)(e.TrackTime / duration) > 0 &&
                                         (int)(e.TrackTime / duration) > (int)(e.TrackLast / duration));

            return animationTime >= e.AnimationEnd && e.AnimationLastValue < e.AnimationEnd;
        }

        // §8.2
        private void EventsReverse(BoneTrackEntry e, float lastTime, float animationTime, List<int> events)
        {
            BlobContent content = Data.Content;
            float duration = e.Duration;
            float from = duration - lastTime, to = duration - animationTime;
            AnimationBlob animation = content.Animations[e.Animation];
            for (int i = 0; i < animation.TimelineCount; i++)
            {
                TimelineBlob t = content.Timelines[animation.TimelineStart + i];
                if (t.Kind != TimelineKind.Event) continue;
                for (int k = 0; k < t.FrameCount; k++)
                {
                    float time = content.Frames[t.FramesStart + k];
                    bool inWindow = from >= to ? to <= time && time < from : time < from;
                    if (inWindow) events.Add(t.ExtraStart + k);
                }

                if (from < to)
                    for (int k = 0; k < t.FrameCount; k++)
                        if (content.Frames[t.FramesStart + k] >= to)
                            events.Add(t.ExtraStart + k);
            }
        }

        private BoneBurstEvent Deliver(EventBlob ev)
        {
            BlobContent c = Data.Content;
            int keyId = Data.EventKeyIds != null ? Data.EventKeyIds[ev.Event] : BoneBurstKey.EmptyId;
            return new BoneBurstEvent(c.Skeleton.Events[ev.Event].Name, keyId, ev.Int, ev.Float,
                ev.String < 0 ? null : c.EventStrings[ev.String], ev.Volume, ev.Balance, ev.Time, false);
        }

        // ---------------------------------------------------------------- §7 hold

        private void AnimationsChanged()
        {
            m_AnimationsChanged = false;
            for (int i = 0, n = m_Tracks.Count; i < n; i++)
            {
                BoneTrackEntry track = m_Tracks[i];
                if (track == null) continue;
                BoneTrackEntry entry = track;
                while (entry.MixingFromEntry != null) entry = entry.MixingFromEntry;
                do
                {
                    ComputeHold(entry, track);
                    entry = entry.MixingToEntry;
                } while (entry != null);
            }

            m_PropertyIds.Clear();
        }

        private void ComputeHold(BoneTrackEntry entry, BoneTrackEntry track)
        {
            BlobContent content = Data.Content;
            int count = entry.TimelineCount;
            if (entry.TimelineModes.Length < count) Array.Resize(ref entry.TimelineModes, count);
            if (entry.TimelineHoldMix.Length < count) entry.TimelineHoldMix = new BoneTrackEntry[count];
            else Array.Clear(entry.TimelineHoldMix, 0, entry.TimelineHoldMix.Length);
            if (count == 0) return;

            AnimationBlob animation = content.Animations[entry.Animation];
            bool add = entry.Additive, keepHold = entry.KeepHold;
            BoneTrackEntry to = entry.MixingToEntry;
            for (int k = 0; k < count; k++)
            {
                int timeline = animation.TimelineStart + k;
                ulong[] ids = content.TimelineIds[timeline];
                bool timelineAdditive = IsAdditive(content.Timelines[timeline].Kind);
                MixFrom from = From(track, content.Timelines[timeline].Kind, ids);
                if (add && timelineAdditive)
                {
                    entry.TimelineModes[k] = (byte)from;
                    continue;
                }

                byte mode;
                if (to == null || content.TimelineInstant[timeline] || (to.Additive && timelineAdditive) ||
                    !HasTimeline(to, ids))
                {
                    mode = (byte)from;
                }
                else
                {
                    mode = (byte)((byte)from | TimelineMode.Hold);
                    for (BoneTrackEntry next = to.MixingToEntry; next != null; next = next.MixingToEntry)
                        if ((next.Additive && timelineAdditive) || !HasTimeline(next, ids))
                        {
                            if (next.MixDuration > 0) entry.TimelineHoldMix[k] = next;
                            break;
                        }
                }

                if (keepHold) mode = (byte)((mode & ~TimelineMode.Hold) | (entry.TimelineModes[k] & TimelineMode.Hold));

                entry.TimelineModes[k] = mode;
            }
        }

        private MixFrom From(BoneTrackEntry track, TimelineKind kind, ulong[] ids)
        {
            MixFrom result = MixFrom.Setup;
            for (int j = 0; j < ids.Length; j++)
                if (m_PropertyIds.TryGetValue(ids[j], out BoneTrackEntry owner))
                {
                    if (owner != track)
                    {
                        for (int r = j + 1; r < ids.Length; r++)
                            if (!m_PropertyIds.ContainsKey(ids[r]))
                                m_PropertyIds.Add(ids[r], track);

                        return MixFrom.Current;
                    }

                    result = MixFrom.First;
                }
                else
                {
                    m_PropertyIds.Add(ids[j], track);
                }

            const ulong drawOrderId = 14UL << 53;
            if (kind == TimelineKind.DrawOrderFolder &&
                m_PropertyIds.TryGetValue(drawOrderId, out BoneTrackEntry first))
                return first != track ? MixFrom.Current : MixFrom.First;

            return result;
        }

        private bool HasTimeline(BoneTrackEntry entry, ulong[] ids)
        {
            if (entry.Animation < 0) return false;
            HashSet<ulong> set = m_AnimationIds[entry.Animation];
            if (set == null)
            {
                set = new HashSet<ulong>();
                AnimationBlob animation = Data.Content.Animations[entry.Animation];
                for (int i = 0; i < animation.TimelineCount; i++)
                    foreach (ulong id in Data.Content.TimelineIds[animation.TimelineStart + i])
                        set.Add(id);

                m_AnimationIds[entry.Animation] = set;
            }

            foreach (ulong id in ids)
                if (set.Contains(id))
                    return true;

            return false;
        }

        /// <summary>
        ///     The timeline's own "additive" property (Timelines.md §3.1): what may be added on an additive track.
        /// </summary>
        private static bool IsAdditive(TimelineKind kind)
        {
            switch (kind)
            {
                case TimelineKind.BoneRotate:
                case TimelineKind.BoneTranslate:
                case TimelineKind.BoneTranslateX:
                case TimelineKind.BoneTranslateY:
                case TimelineKind.BoneScale:
                case TimelineKind.BoneScaleX:
                case TimelineKind.BoneScaleY:
                case TimelineKind.BoneShear:
                case TimelineKind.BoneShearX:
                case TimelineKind.BoneShearY:
                case TimelineKind.Deform:
                case TimelineKind.Transform:
                case TimelineKind.PathPosition:
                case TimelineKind.PhysicsWind:
                case TimelineKind.PhysicsGravity:
                case TimelineKind.SliderMix:
                    return true;
                default:
                    return false;
            }
        }

        // ---------------------------------------------------------------- §8.3 queue

        private void Enqueue(EventKind kind, BoneTrackEntry entry, BoneBurstEvent e = default)
        {
            if (kind == EventKind.Start || kind == EventKind.End) m_AnimationsChanged = true;
            m_Queue.Add((kind, entry, e));
        }

        private void Drain()
        {
            if (m_DrainDisabled) return;
            m_DrainDisabled = true;
            for (int i = 0; i < m_Queue.Count; i++)
            {
                (EventKind kind, BoneTrackEntry entry, BoneBurstEvent e) = m_Queue[i];
                Deliver(kind, entry, e);
                if (kind == EventKind.End) Deliver(EventKind.Dispose, entry, e);
            }

            m_Queue.Clear();
            m_DrainDisabled = false;
        }

        private void Deliver(EventKind kind, BoneTrackEntry entry, BoneBurstEvent e)
        {
            entry.Raise(kind, e);
            switch (kind)
            {
                case EventKind.Start: Start?.Invoke(entry); break;
                case EventKind.Interrupt: Interrupt?.Invoke(entry); break;
                case EventKind.End: End?.Invoke(entry); break;
                case EventKind.Dispose: Dispose?.Invoke(entry); break;
                case EventKind.Complete: Complete?.Invoke(entry); break;
                case EventKind.Event: Event?.Invoke(entry, e); break;
            }
        }

        public void DelayListenerNotifications()
        {
            m_DrainDisabled = true;
        }

        public void IssueDelayedListenerNotifications()
        {
            m_DrainDisabled = false;
            Drain();
        }

        // ---------------------------------------------------------------- §6 Apply

        /// <summary>
        ///     A post-job step: queue this entry's events (and Complete) with the commands it produced.
        /// </summary>
        private readonly struct Step
        {
            public readonly BoneTrackEntry Entry;
            public readonly int Command;
            public readonly float AnimationTime, LastTime;
            public readonly bool QueueEvents, IsMixingFrom, ReverseEvents;

            public Step(BoneTrackEntry entry, int command, float animationTime, float lastTime, bool queueEvents,
                bool isMixingFrom, bool reverseEvents)
            {
                Entry = entry;
                Command = command;
                AnimationTime = animationTime;
                LastTime = lastTime;
                QueueEvents = queueEvents;
                IsMixingFrom = isMixingFrom;
                ReverseEvents = reverseEvents;
            }
        }
    }

    /// <summary>
    ///     One frame's commands and their per-timeline data, built by <see cref="BoneAnimationState.Apply" />.
    ///     The system copies it into the instance's native lists; <see cref="ManagedPose" /> pins it.
    /// </summary>
    public sealed class CommandBuffer
    {
        public readonly List<ApplyCommand> Commands = new();
        public readonly List<float> HoldFactors = new();
        public readonly List<byte> Modes = new();
        public readonly List<float> Rotation = new();
        private readonly List<BoneTrackEntry> m_Entries = new();

        /// <summary>
        ///     The attachment-state epoch this frame's apply uses.
        /// </summary>
        public int UnkeyedState;

        public void Clear()
        {
            Commands.Clear();
            Modes.Clear();
            HoldFactors.Clear();
            Rotation.Clear();
            m_Entries.Clear();
        }

        internal int Add(ApplyCommand command, BoneTrackEntry entry)
        {
            Commands.Add(command);
            m_Entries.Add(entry);
            return Commands.Count - 1;
        }

        internal int AddModes(byte[] modes, int count)
        {
            int start = Modes.Count;
            for (int i = 0; i < count; i++) Modes.Add(modes[i]);
            return start;
        }

        /// <summary>
        ///     Per-timeline hold fade factors <c>1 − holdMix.Mix()</c>, or -1 when no timeline has a holdMix.
        /// </summary>
        internal int AddHoldFactors(BoneTrackEntry[] holdMix, int count)
        {
            bool any = false;
            for (int i = 0; i < count; i++) any |= holdMix[i] != null;
            if (!any) return -1;
            int start = HoldFactors.Count;
            for (int i = 0; i < count; i++) HoldFactors.Add(holdMix[i] == null ? 1 : 1 - holdMix[i].Mix());
            return start;
        }

        internal int AddRotation(float[] rotation, int timelineCount)
        {
            int start = Rotation.Count, size = timelineCount * 2;
            for (int i = 0; i < size; i++) Rotation.Add(rotation[i]);
            return start;
        }

        /// <summary>
        ///     Rotation memory written by the job, back into each entry.
        /// </summary>
        internal void CopyBack(ReadOnlySpan<float> rotation)
        {
            for (int c = 0; c < Commands.Count; c++)
            {
                ApplyCommand command = Commands[c];
                if (command.RotationStart < 0) continue;
                BoneTrackEntry entry = m_Entries[c];
                for (int i = 0; i < entry.RotationCount; i++) entry.Rotation[i] = rotation[command.RotationStart + i];
            }
        }
    }
}