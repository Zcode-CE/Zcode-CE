import { nativeImage, type NativeImage } from "electron";

const OVERLAY_SIZE = 16;
const DISC_RADIUS = 6.5;
const RING_RADIUS = 7.5;

/**
 * Windows 任务栏未读角标：16x16 的红色圆点（带白色描边），无数字排版。
 *
 * 为什么自己画：`setOverlayIcon` 只接受 NativeImage，仓库没有现成的角标位图；
 * 16px 里塞数字在不同 DPI 下不可读，数字放在 overlay description 里更可靠。
 * 像素格式按 Windows 的 BGRA 顺序写，`createFromBitmap` 读的就是这个布局。
 */
export function createUnreadOverlayIcon(): NativeImage {
  const pixels = Buffer.alloc(OVERLAY_SIZE * OVERLAY_SIZE * 4);
  const center = (OVERLAY_SIZE - 1) / 2;
  for (let y = 0; y < OVERLAY_SIZE; y += 1) {
    for (let x = 0; x < OVERLAY_SIZE; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      if (distance > RING_RADIUS) continue;
      const offset = (y * OVERLAY_SIZE + x) * 4;
      const isRing = distance > DISC_RADIUS;
      // BGRA：红点 / 白色描边，alpha 255。
      pixels[offset] = isRing ? 255 : 40;
      pixels[offset + 1] = isRing ? 255 : 40;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, {
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE,
    scaleFactor: 1,
  });
}
