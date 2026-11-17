import type { SkinViewer } from "skinview3d";
import type { Material, Mesh } from "three";

/**
 * Semi-transparent pixels on the skin's outer layer (soft shading) came out as light grey patches:
 * normal blending writes alpha a² + (1 - a) into the canvas, which the page then composites as
 * premultiplied and so brightens. Premultiplied blending keeps the canvas opaque and blends the
 * colour like Minecraft does (translucent outer layer over the inner one).
 */
export function fixSkinAlpha(v: SkinViewer) {
  v.scene.traverse((o) => {
    const m = (o as Mesh).material as Material | Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      if (mat.transparent && !mat.premultipliedAlpha) {
        mat.premultipliedAlpha = true;
        // Minecraft's entity shaders drop texels under 10 % alpha (skinview3d keeps everything above 0).
        mat.alphaTest = 0.1;
        mat.needsUpdate = true;
      }
    }
  });
}
