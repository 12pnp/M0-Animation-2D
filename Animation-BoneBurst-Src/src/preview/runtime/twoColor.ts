/// <reference path="../../vendor/spine-pixi.d.ts" />

/**
 * Spine's two-colour tint for a Pixi mesh: the light colour multiplies the
 * texture, the dark colour fills where the texture is dark, as Spine's
 * premultiplied two-colour shader: rgb = (a − rgb) · dark + rgb · light, both
 * colours premultiplied by the light's alpha. Used only for slots with a dark
 * colour; the others draw with Pixi's own tint.
 */

const VERTEX = `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;

const FRAGMENT = `
in vec2 vUV;
uniform sampler2D uTexture;
uniform vec4 uLight;
uniform vec3 uDark;
out vec4 finalColor;
void main() {
  vec4 t = texture(uTexture, vUV);
  finalColor.a = t.a * uLight.a;
  finalColor.rgb = ((t.a - t.rgb) * uDark + t.rgb * uLight.rgb) * uLight.a;
}`;

export interface TwoColor {
  shader: PIXI.Shader;
  /** Set the texture and the colours: light r g b a, dark r g b, 0..1. */
  set(texture: PIXI.Texture, light: ArrayLike<number>, dark: ArrayLike<number>): void;
}

export function twoColorShader(texture: PIXI.Texture): TwoColor {
  const tint = new PIXI.UniformGroup({
    uLight: { value: new Float32Array([1, 1, 1, 1]), type: "vec4<f32>" },
    uDark: { value: new Float32Array([0, 0, 0]), type: "vec3<f32>" },
  });
  const shader = PIXI.Shader.from({ gl: { vertex: VERTEX, fragment: FRAGMENT }, resources: { uTexture: texture.source, tint } });
  return {
    shader,
    set(t, light, dark) {
      shader.resources.uTexture = t.source;
      tint.uniforms.uLight!.set([light[0]!, light[1]!, light[2]!, light[3]!]);
      tint.uniforms.uDark!.set([dark[0]!, dark[1]!, dark[2]!]);
      tint.update();
    },
  };
}
