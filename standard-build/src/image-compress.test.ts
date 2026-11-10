// @vitest-environment jsdom
// src/image-compress.test.ts — 压缩策略的纯逻辑部分。
// 真正的解码/编码(createImageBitmap + canvas.toBlob)jsdom 里没有,只能真机/浏览器验;
// 这里锁住「什么该压、缩到多大、叫什么名字」这三条判断,它们决定了会不会误伤非图片文件。
import { describe, expect, it } from 'vitest'
import { compressedName, shouldCompress, targetSize } from './image-compress'

function fakeFile(name: string, type: string, size: number): File {
  const f = new File([''], name, { type })
  // File.size 只读:用 defineProperty 伪造大小,免得真造 4MB 内容
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('shouldCompress', () => {
  it('大的 jpeg/png/webp 才压', () => {
    expect(shouldCompress(fakeFile('a.jpg', 'image/jpeg', 4_000_000))).toBe(true)
    expect(shouldCompress(fakeFile('a.png', 'image/png', 900_000))).toBe(true)
    expect(shouldCompress(fakeFile('a.webp', 'image/webp', 800_000))).toBe(true)
  })

  it('小图不折腾(解码+编码本身也有开销)', () => {
    expect(shouldCompress(fakeFile('a.jpg', 'image/jpeg', 120_000))).toBe(false)
  })

  it('★非图片一律不碰 —— 误压 pdf/docx/xlsx 会直接毁掉文件', () => {
    expect(shouldCompress(fakeFile('合同.pdf', 'application/pdf', 9_000_000))).toBe(false)
    expect(shouldCompress(fakeFile('报表.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 9_000_000))).toBe(false)
    expect(shouldCompress(fakeFile('说明.txt', 'text/plain', 9_000_000))).toBe(false)
  })

  it('HEIC 不碰:浏览器解不了,交给系统选择器转成 JPEG', () => {
    expect(shouldCompress(fakeFile('IMG_0001.HEIC', 'image/heic', 5_000_000))).toBe(false)
  })
})

describe('targetSize', () => {
  it('按长边等比缩放,横竖都对', () => {
    expect(targetSize(4032, 3024)).toEqual({ w: 1600, h: 1200 }) // 手机横拍
    expect(targetSize(3024, 4032)).toEqual({ w: 1200, h: 1600 }) // 手机竖拍
  })

  it('本来就小于上限的不放大', () => {
    expect(targetSize(800, 600)).toEqual({ w: 800, h: 600 })
  })

  it('极端长图不会缩到 0 像素', () => {
    expect(targetSize(20000, 5)).toEqual({ w: 1600, h: 1 })
  })
})

describe('compressedName', () => {
  it('扩展名跟着真实类型走(后端按扩展名判类型,不改会判错)', () => {
    expect(compressedName('IMG_0001.PNG')).toBe('IMG_0001.jpg')
    expect(compressedName('现场照片.jpeg')).toBe('现场照片.jpg')
  })

  it('没有扩展名的也能加上', () => {
    expect(compressedName('photo')).toBe('photo.jpg')
  })
})
