using UnityEngine;
using UnityEngine.Playables;

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     Applies the track's flip clips to the bound <see cref="BoneBurstSkeleton" />: the clip with the greatest
    ///     weight wins, the flip the skeleton had when the track started shows when no clip dominates, and that
    ///     original flip is restored when the timeline stops. A port of spine-unity's
    ///     <c>SpineSkeletonFlipMixerBehaviour</c>, flipped through the component's <c>FlipX</c>/<c>FlipY</c>.
    /// </summary>
    /// <remarks>
    ///     The flip is only written when it changes, and in play mode a change is posed in the same evaluation
    ///     through <see cref="BoneBurstSystem.ReapplyNow" /> — a flip lands on the frame its clip starts, not the
    ///     next one. In Edit mode the property's own dirty marking reaches the preview driver.
    /// </remarks>
    public sealed class BoneBurstFlipMixer : PlayableBehaviour
    {
        private PlayableDirector director;
        private bool firstFrameHappened;
        private bool originalFlipX, originalFlipY;
        private BoneBurstSkeleton skeleton;

        public override void OnPlayableCreate(Playable playable)
        {
            director = playable.GetGraph().GetResolver() as PlayableDirector;
            if (director != null) director.stopped += OnDirectorStopped;
        }

        public override void OnPlayableDestroy(Playable playable)
        {
            if (director != null) director.stopped -= OnDirectorStopped;
        }

        private void OnDirectorStopped(PlayableDirector stopped)
        {
            OnStop();
        }

        public override void ProcessFrame(Playable playable, FrameData info, object playerData)
        {
            skeleton = playerData as BoneBurstSkeleton;
            if (skeleton == null || skeleton.Data == null) return;

            if (!firstFrameHappened)
            {
                originalFlipX = skeleton.FlipX;
                originalFlipY = skeleton.FlipY;
                firstFrameHappened = true;
            }

            int inputCount = playable.GetInputCount();

            float totalWeight = 0f;
            float greatestWeight = 0f;
            int currentInputs = 0;
            bool flipX = originalFlipX, flipY = originalFlipY;

            for (int i = 0; i < inputCount; i++)
            {
                float inputWeight = playable.GetInputWeight(i);
                ScriptPlayable<BoneBurstFlipBehaviour> inputPlayable =
                    (ScriptPlayable<BoneBurstFlipBehaviour>)playable.GetInput(i);
                BoneBurstFlipBehaviour input = inputPlayable.GetBehaviour();

                totalWeight += inputWeight;

                if (inputWeight > greatestWeight)
                {
                    flipX = input.flipX;
                    flipY = input.flipY;
                    greatestWeight = inputWeight;
                }

                if (!Mathf.Approximately(inputWeight, 0f)) currentInputs++;
            }

            // The empty space around the clips is heavier than any clip: show the flip the skeleton started with.
            if (currentInputs != 1 && 1f - totalWeight > greatestWeight)
            {
                flipX = originalFlipX;
                flipY = originalFlipY;
            }

            if (flipX != skeleton.FlipX || flipY != skeleton.FlipY)
            {
                skeleton.FlipX = flipX;
                skeleton.FlipY = flipY;
                if (Application.isPlaying) BoneBurstSystem.ReapplyNow(skeleton);
            }
        }

        /// <summary>
        ///     Restores the flip the skeleton had when the track started; the next evaluation captures it again.
        /// </summary>
        public void OnStop()
        {
            firstFrameHappened = false;

            if (skeleton == null) return;

            if (skeleton.FlipX != originalFlipX || skeleton.FlipY != originalFlipY)
            {
                skeleton.FlipX = originalFlipX;
                skeleton.FlipY = originalFlipY;
                if (Application.isPlaying) BoneBurstSystem.ReapplyNow(skeleton);
            }
        }
    }
}