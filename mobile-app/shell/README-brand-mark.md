# shell/brand-mark-*.svg —— 从哪来,改了什么

源:`SixAM-Tech/sixam` 母仓 `products/deck/assets/logos/`
  · `mark-graphite-light-bg.svg` → `brand-mark-light.svg`
  · `mark-white-dark-bg.svg`     → `brand-mark-dark.svg`

**是副本,不是新画的。** 壳与 deck 不同仓也不同源,只能拷;换 logo 时两处一起换
(母仓 `brand/README.md` §5 是品牌事实来源)。

## 相对源文件只改了一个属性:`viewBox`

`0 0 64 64` → `-2.2 -2.2 68.4 68.4`。

理由:源文件的画面**几乎顶满** viewBox —— 实测包围盒(含 `stroke-linecap="round"` 多出的
半个线宽)是 x[5.64, 58.36] / y[1.46, 62.54],上下各只剩 1.5 的余量,而左右余量不等,
星标看起来又挤又偏。deck 那张 png 是带余量渲的,所以在 deck 里看不出这个问题。

新 viewBox = 以包围盒中心取正方形 + 12% 余量。**图形本身一个字节没动** ——
下次从源文件重新拷贝时,把这一个属性再改一遍即可(或者把余量修回源文件去)。
