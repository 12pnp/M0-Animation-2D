using System;
using BoneBurst.Anim;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     Applies the track's clips to the bound <see cref="BoneBurstSkeleton" />: when a clip's weight rises from
    ///     zero (or the timeline seeks), the mixer sets that animation on the track index, syncs it to the clip's
    ///     time, and lets <see cref="BoneBurstSystem" /> advance it. A port of spine-unity's
    ///     <c>SpineAnimationStateMixerBehaviour</c>.
    /// </summary>
    /// <remarks>
    ///     Between clip starts the animation state advances on the game clock, scaled by the clip and director
    ///     speeds; <see cref="BoneBurstSystem.ReapplyNow" /> after each start poses the new animation within the
    ///     same evaluation, as spine-unity's <c>Update(0)</c> + <c>LateUpdate()</c> does. Only an entry the timeline
    ///     itself started is paused or mixed out at clip ends, so other code's <c>SetAnimation</c> calls are never
    ///     fought.
    /// </remarks>
    public sealed class BoneBurstAnimationMixer : PlayableBehaviour
    {
        private readonly ScriptPlayable<BoneBurstAnimationBehaviour>[] startingClips =
            new ScriptPlayable<BoneBurstAnimationBehaviour>[2];

        private bool endAtClipEnd = true;
        private float endMixOutDuration = 0.1f;
        private bool isPaused;
        private bool lastAnyClipPlaying;
        private float[] lastInputWeights;
        private bool pauseWithDirector = true;
        private BoneTrackEntry pausedTrackEntry;
        private float previousTimeScale = 1;
        private float rootPlayableSpeed = 1;

        private BoneBurstSkeleton skeleton;

        private BoneTrackEntry timelineStartedTrackEntry;

        internal int trackIndex;
        internal bool unscaledTime;

        public override void OnBehaviourPause(Playable playable, FrameData info)
        {
            if (pauseWithDirector)
            {
                if (!isPaused) HandlePause();
                isPaused = true;
            }
        }

        public override void OnGraphStop(Playable playable)
        {
            bool isStoppedNotPaused = playable.GetGraph().IsPlaying(); // the track's end was reached, not a pause
            if (isStoppedNotPaused && endAtClipEnd) HandleClipEnd();
        }

        public override void OnBehaviourPlay(Playable playable, FrameData info)
        {
            if (isPaused) HandleResume();
            isPaused = false;
        }

        private void HandlePause()
        {
            if (skeleton == null) return;
            BoneTrackEntry current = skeleton.AnimationState.GetTrack(trackIndex);
            if (current != null && current == timelineStartedTrackEntry)
            {
                previousTimeScale = current.TimeScale;
                current.TimeScale = 0;
                pausedTrackEntry = current;
            }
        }

        private void HandleResume()
        {
            if (skeleton == null) return;
            BoneTrackEntry current = skeleton.AnimationState.GetTrack(trackIndex);
            if (current != null && current == pausedTrackEntry) current.TimeScale = previousTimeScale;
        }

        private void HandleClipEnd()
        {
            if (skeleton == null) return;
            BoneAnimationState state = skeleton.AnimationState;
            if (endAtClipEnd && timelineStartedTrackEntry != null &&
                timelineStartedTrackEntry == state.GetTrack(trackIndex))
            {
                if (endMixOutDuration >= 0) state.SetEmptyAnimation(trackIndex, endMixOutDuration);
                else timelineStartedTrackEntry.TimeScale = 0; // pause instead of mixing out
                timelineStartedTrackEntry = null;
            }
        }

        private void AdjustTrackEntryTimeScale(Playable playable, int input, BoneTrackEntry currentTrackEntry)
        {
            if (currentTrackEntry == null) return;
            ScriptPlayable<BoneBurstAnimationBehaviour> clipPlayable =
                (ScriptPlayable<BoneBurstAnimationBehaviour>)playable.GetInput(input);
            float clipSpeed = (float)clipPlayable.GetSpeed();
            BoneBurstAnimationBehaviour clipData = clipPlayable.GetBehaviour();
            if (clipData != null && BoneBurstAnimationLookup.TryGet(skeleton.Asset, clipData.animation,
                    out int animation, out float _))
                if (currentTrackEntry.Animation == animation)
                    currentTrackEntry.TimeScale = clipSpeed * rootPlayableSpeed;
        }

        // NOTE: called at runtime and edit time. Edit time scrubs through PreviewEditModePose, which pins the
        // playhead clip's time on the real state and leaves the instance dirty for the Editor's preview driver.
        public override void ProcessFrame(Playable playable, FrameData info, object playerData)
        {
            skeleton = playerData as BoneBurstSkeleton;
            if (skeleton == null || skeleton.AnimationState == null || skeleton.Data == null) return;

            if (!Application.isPlaying)
            {
                PreviewEditModePose(playable);
                return;
            }

            BoneAnimationState state = skeleton.AnimationState;

            int inputCount = playable.GetInputCount();
            float previousRootSpeed = rootPlayableSpeed;
            rootPlayableSpeed = GetRootPlayableSpeed(playable);
            bool rootSpeedChanged = previousRootSpeed != rootPlayableSpeed;

            if (lastInputWeights == null || lastInputWeights.Length < inputCount)
                lastInputWeights = new float[inputCount];

            float[] weights = lastInputWeights;
            int numStartingClips = 0;
            bool anyClipPlaying = false;

            // Check all clips. If a clip's weight turned from 0 to above 0, apply it with SetAnimation.
            for (int i = 0; i < inputCount; i++)
            {
                float lastInputWeight = weights[i];
                float inputWeight = playable.GetInputWeight(i);
                bool clipStarted = inputWeight > 0 && (lastInputWeight == 0 || info.seekOccurred || info.timeLooped);
                if (inputWeight > 0) anyClipPlaying = true;
                weights[i] = inputWeight;

                if (clipStarted)
                {
                    if (numStartingClips < 2)
                        startingClips[numStartingClips++] =
                            (ScriptPlayable<BoneBurstAnimationBehaviour>)playable.GetInput(i);
                }
                else if (rootSpeedChanged)
                {
                    AdjustTrackEntryTimeScale(playable, i, state.GetTrack(trackIndex));
                }
            }

            // Two clips starting in the same frame can arrive in either order; the one ending sooner must be
            // applied first, so it mixes out under the other.
            if (numStartingClips == 2)
            {
                ScriptPlayable<BoneBurstAnimationBehaviour> clip0 = startingClips[0];
                ScriptPlayable<BoneBurstAnimationBehaviour> clip1 = startingClips[1];
                if (clip0.GetDuration() > clip1.GetDuration())
                {
                    startingClips[0] = clip1;
                    startingClips[1] = clip0;
                }
            }

            for (int j = 0; j < numStartingClips; j++)
            {
                ScriptPlayable<BoneBurstAnimationBehaviour> clipPlayable = startingClips[j];
                BoneBurstAnimationBehaviour clipData = clipPlayable.GetBehaviour();
                pauseWithDirector = !clipData.dontPauseWithDirector;
                endAtClipEnd = !clipData.dontEndWithClip;
                endMixOutDuration = clipData.endMixOutDuration;

                if (clipData.animation.IsEmpty)
                {
                    float emptyMix = clipData.customDuration ? GetCustomMixDuration(clipData) : state.Data.DefaultMix;
                    state.SetEmptyAnimation(trackIndex, emptyMix);
                }
                else if (BoneBurstAnimationLookup.TryGet(skeleton.Asset, clipData.animation, out int animation,
                             out float _))
                {
                    skeleton.UnscaledTime = unscaledTime;

                    BoneTrackEntry currentEntry = state.GetTrack(trackIndex);
                    float customMixDuration = clipData.customDuration ? GetCustomMixDuration(clipData) : 0.0f;
                    BoneTrackEntry trackEntry;
                    if (currentEntry == null && customMixDuration > 0)
                    {
                        state.SetEmptyAnimation(trackIndex, 0); // easing in requires an empty animation first
                        trackEntry = state.AddAnimation(trackIndex, animation, clipData.loop, 0);
                    }
                    else
                    {
                        trackEntry = state.SetAnimation(trackIndex, animation, clipData.loop);
                    }

                    float clipSpeed = (float)clipPlayable.GetSpeed();
                    trackEntry.EventThreshold = clipData.eventThreshold;
                    trackEntry.MixDrawOrderThreshold = clipData.drawOrderThreshold;
                    trackEntry.TrackTime = (float)clipPlayable.GetTime(); // the clip's speed is inside its time
                    trackEntry.TimeScale = clipSpeed * rootPlayableSpeed;
                    trackEntry.MixAttachmentThreshold = clipData.attachmentThreshold;
                    trackEntry.Alpha = clipData.alpha;

                    if (clipData.customDuration) trackEntry.SetMixDuration(customMixDuration / rootPlayableSpeed, 0f);

                    timelineStartedTrackEntry = trackEntry;
                }
                else
                {
                    Debug.LogWarning(
                        $"BoneBurst timeline: {skeleton.name} has no animation '{clipData.animation}'; the previous animation keeps playing.",
                        skeleton);
                }
            }

            if (numStartingClips > 0)
            {
                BoneBurstSystem.SetPlaying(skeleton, true);
                BoneBurstSystem.ReapplyNow(skeleton);
            }

            startingClips[0] = startingClips[1] = ScriptPlayable<BoneBurstAnimationBehaviour>.Null;
            if (lastAnyClipPlaying && !anyClipPlaying) HandleClipEnd();
            lastAnyClipPlaying = anyClipPlaying;
        }

        /// <summary>
        ///     Edit-mode scrubbing: the clip under the playhead (the last input with weight) is set on the real
        ///     animation state with its track time pinned to the clip's time, and the instance is marked dirty so the
        ///     Editor's preview driver poses and meshes it with no time passing. No dummy animation state and no
        ///     crossfade approximation: the scrubbed clip shows as it is, and a rebuild (entering Play mode, an
        ///     Inspector change) drops it, because the instance is rebuilt from serialized fields.
        /// </summary>
        private void PreviewEditModePose(Playable playable)
        {
            BoneAnimationState state = skeleton.AnimationState;
            int inputCount = playable.GetInputCount();
            int lastNonZeroWeightInput = -1;
            for (int i = 0; i < inputCount; i++)
                if (playable.GetInputWeight(i) > 0)
                    lastNonZeroWeightInput = i;

            if (lastNonZeroWeightInput == -1) return;

            ScriptPlayable<BoneBurstAnimationBehaviour> clipPlayable =
                (ScriptPlayable<BoneBurstAnimationBehaviour>)playable.GetInput(lastNonZeroWeightInput);
            BoneBurstAnimationBehaviour clipData = clipPlayable.GetBehaviour();

            if (clipData.Asset != null && clipData.Asset != skeleton.Asset)
                Debug.LogWarning(
                    $"BoneBurst timeline: clip '{clipData.animation}' was picked from {clipData.Asset.name}, but {skeleton.name} plays {skeleton.Asset.name}.");

            if (trackIndex == 0) skeleton.SetupPose();

            if (clipData.animation.IsEmpty)
            {
                state.ClearTrack(trackIndex);
            }
            else if (BoneBurstAnimationLookup.TryGet(skeleton.Asset, clipData.animation, out int animation,
                         out float _))
            {
                BoneTrackEntry entry = state.GetTrack(trackIndex);
                if (entry == null || entry.Animation != animation)
                {
                    state.ClearTrack(trackIndex); // deterministic: no crossfade bookkeeping while scrubbing
                    entry = state.SetAnimation(trackIndex, animation, clipData.loop);
                }

                entry.TrackTime = (float)clipPlayable.GetTime();
            }
            else
            {
                Debug.LogWarning(
                    $"BoneBurst timeline: {skeleton.name} has no animation '{clipData.animation}'; the Scene view keeps the current pose.");
            }

            skeleton.MarkDirty();
        }

        private float GetRootPlayableSpeed(Playable playable)
        {
            PlayableGraph graph = playable.GetGraph();
            int rootPlayableCount = graph.GetRootPlayableCount();
            if (rootPlayableCount == 1) return (float)graph.GetRootPlayable(0).GetSpeed();

            for (int rootIndex = 0; rootIndex < rootPlayableCount; rootIndex++)
            {
                Playable rootPlayable = graph.GetRootPlayable(rootIndex);
                for (int i = 0, n = rootPlayable.GetInputCount(); i < n; i++)
                    if (rootPlayable.GetInput(i).Equals(playable))
                        return (float)rootPlayable.GetSpeed();
            }

            return 1.0f;
        }

        private float GetCustomMixDuration(BoneBurstAnimationBehaviour clipData)
        {
            if (clipData.useBlendDuration)
            {
                TimelineClip clip = clipData.timelineClip;
                return (float)Math.Max(clip.blendInDuration, clip.easeInDuration);
            }

            return clipData.mixDuration;
        }
    }
}