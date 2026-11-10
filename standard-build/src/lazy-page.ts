import { defineAsyncComponent, type Component } from 'vue'
import AsyncPageError from './ui/AsyncPageError.vue'
import AsyncPageLoading from './ui/AsyncPageLoading.vue'
import { reloadIfStaleBuild } from './build-refresh'

type PageModule = Component | { default: Component }

export function lazyPage(loader: () => Promise<PageModule>) {
  return defineAsyncComponent({
    loader,
    loadingComponent: AsyncPageLoading,
    errorComponent: AsyncPageError,
    delay: 150,
    timeout: 15_000,
    onError(_error, retry, fail, attempts) {
      if (attempts <= 1) {
        retry()
        return
      }
      // 两次都没拿到。最常见的原因不是网络,是服务器发了新版、旧 chunk 已经删了 ——
      // 确认真发版就自动刷新(见 build-refresh.ts),没确认就照常显示错误页。
      // 刷新期间保持「加载中」:此时页面已经在走了,闪一下错误页反而莫名其妙。
      void reloadIfStaleBuild()
        .catch(() => false)
        .then((reloading) => {
          if (!reloading) fail()
        })
    },
  })
}
