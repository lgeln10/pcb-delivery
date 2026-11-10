// src/image-compress.ts — 上传前的客户端图片压缩(手机拍照场景的刚需)。
//
// 为什么必须有:手机原图是 4000×3000 / 4–8MB。直传的后果是三重的——
// 上传在弱网下要几十秒且经常超时;附件转给 agent 时又要再传一次;
// 而这些图的用途是「让 AI 看一眼合同/发票/现场」,长边 1600 完全够读。
//
// 两个必须自己处理的坑:
// ① **EXIF 方向**:手机横拿竖拿拍出来的 JPEG 像素是同一个方向,靠 EXIF Orientation 标记纠正。
//    一旦重新编码,EXIF 就没了 —— 不先摆正的话,压缩完的图会横躺。
//    `createImageBitmap(file, { imageOrientation: 'from-image' })` 会按 EXIF 摆正后再解码,
//    这是唯一不用手写 EXIF 解析的路子(Safari 16.4+ / Chrome 都支持)。
// ② **别把小图压大**:PNG 截图重编码成 JPEG 可能更大;压完比原图大就退回原文件。
//
// 非图片(pdf/docx/xlsx)原样返回,不碰。

/** 长边上限。1600 是「AI 看得清 + 体积可接受」的经验值,再高收益递减。 */
const MAX_EDGE = 1600
/** JPEG 质量。0.82 在文字类照片(合同/发票)上肉眼无损,再低会糊笔画。 */
const QUALITY = 0.82
/** 小于这个尺寸的图不值得折腾(压缩本身也要解码+编码的开销)。 */
const SKIP_BELOW_BYTES = 300 * 1024

/** 能安全重编码的位图类型。HEIC 不在列:浏览器解不了,交给系统在选择器里转 JPEG。 */
const COMPRESSIBLE = new Set(['image/jpeg', 'image/png', 'image/webp'])

export function shouldCompress(file: File): boolean {
  return COMPRESSIBLE.has(file.type) && file.size > SKIP_BELOW_BYTES
}

/** 按长边等比缩放后的目标尺寸;本来就小于上限则原尺寸(仍会重编码去掉冗余数据)。 */
export function targetSize(w: number, h: number, maxEdge = MAX_EDGE): { w: number; h: number } {
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { w, h }
  const scale = maxEdge / longest
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

/** 压缩后的文件名:扩展名要跟着真实类型走,否则后端按扩展名判类型会判错。 */
export function compressedName(name: string): string {
  return name.replace(/\.[^.]+$/, '') + '.jpg'
}

/**
 * 压缩单个文件。**任何失败都返回原文件** —— 压缩是优化不是功能,
 * 不能因为某台设备的 canvas/bitmap 行为不同就让用户传不上东西。
 */
export async function compressImage(file: File, maxEdge = MAX_EDGE): Promise<File> {
  if (!shouldCompress(file)) return file
  if (typeof createImageBitmap !== 'function') return file

  let bitmap: ImageBitmap
  try {
    // imageOrientation: 'from-image' → 按 EXIF 摆正;不摆正的话重编码后图会横躺
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }

  try {
    const { w, h } = targetSize(bitmap.width, bitmap.height, maxEdge)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', QUALITY)
    })
    // 压完反而更大(常见于纯色截图 PNG):退回原文件
    if (!blob || blob.size >= file.size) return file
    return new File([blob], compressedName(file.name), { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return file
  } finally {
    bitmap.close()
  }
}
