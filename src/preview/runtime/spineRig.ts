/// <reference path="../../vendor/spine-pixi.d.ts" />
import type { PreviewRig, RigSource } from "./previewRig";

/**
 * The official runtime (spine-pixi-v8 4.3.13) behind `PreviewRig`: the
 * Preview's default until the BoneBurst runtime passes its parity gates
 * (docs/PREVIEW-RUNTIME-PLAN.md, P4).
 */
export function spineRig(src: RigSource): PreviewRig {
  const atlas = new spine.TextureAtlas(src.atlas);
  for (const page of atlas.pages) {
    const texture = src.textures.get(page.name);
    if (!texture) throw new Error(`The atlas names a page "${page.name}" that was not sent.`);
    page.setTexture(spine.SpineTexture.from(texture.source));
  }
  const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(src.skeleton);
  const view = new spine.Spine({ skeletonData: data, autoUpdate: false });
  view.state.addListener({
    event: (entry, e) => {
      if (!src.playing()) return;
      src.onEvent({
        animation: entry.animation.name, name: e.data.name, int: e.intValue, float: e.floatValue,
        string: e.stringValue, audio: e.data.audioPath, volume: e.volume, balance: e.balance,
      });
    },
  });
  // The stage's skins, combined as `spinePose.combineSkins` does.
  const skins = src.skins.map((n) => data.findSkin(n)).filter((s): s is spine.Skin => !!s);
  if (skins.length) {
    const combined = new spine.Skin(src.skins.join(" + "));
    for (const s of skins) combined.addSkin(s);
    view.skeleton.setSkin(combined);
  }
  view.debug = src.debug ? new spine.SpineDebugRenderer() : undefined;

  return {
    display: view,
    animations: data.animations.map((a) => a.name),
    fps: data.fps || 0,
    unsupported: [],
    durationOf: (name) => data.findAnimation(name)?.duration ?? 0,
    start(name, loop) {
      view.skeleton.setupPose();
      view.state.setAnimation(0, name, loop);
      view.update(0);
    },
    seek(name, time, loop) {
      // The setup pose first: a bone the animation does not key shows its
      // setup pose, not whatever the previous frame left.
      view.skeleton.setupPose();
      const entry = view.state.setAnimation(0, name, loop);
      entry.trackTime = time;
      view.update(0);
    },
    queue(steps) {
      view.skeleton.setupPose();
      view.state.setAnimation(0, steps[0]!.name, steps[0]!.loop);
      for (const step of steps.slice(1)) view.state.addAnimation(0, step.name, step.loop, 0).setMixDuration(step.mix, 0);
      view.update(0);
    },
    advance: (dt) => view.update(dt),
    track() {
      const e = view.state.getTrack(0);
      return e && { name: e.animation.name, time: e.getAnimationTime(), trackTime: e.trackTime, duration: e.animation.duration, loop: e.loop };
    },
    setLoop(on) {
      const e = view.state.getTrack(0);
      if (e) e.loop = on;
    },
    setDebug(on) { view.debug = on ? new spine.SpineDebugRenderer() : undefined; },
    matrices() {
      const bones: Record<string, number[]> = {};
      const attachments: Record<string, string | null> = {};
      for (const b of view.skeleton.bones) {
        const p = b.appliedPose;
        bones[b.data.name] = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
      }
      for (const s of view.skeleton.slots) attachments[s.data.name] = s.appliedPose.getAttachment()?.name ?? null;
      return { bones, attachments };
    },
    destroy: () => view.destroy({ children: true }),
  };
}
