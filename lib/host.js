/**
 * dsh-model-quota — 宿主半薄入口。
 *
 * 真正的实现放在 `lib/impl.js`，这里只做一件事：以**带缓存击穿的动态导入**
 * 加载它，然后把 `install` 委托出去。
 *
 * 为什么要这么做：本机 DSH 的 HMR 默认 `root: []`（只监听 profile 的配置文件，
 * 不监听模块源码），所以源码改动不会自动生效；而带 `?v=<stamp>` 的动态导入
 * 每次 profile 重组（改 cordis.patch.yml / package.json / 插件开关）都会重新
 * 求值一次，于是「改代码 → 触发一次重组」即可生效，无需重启 DSH。
 * 生产环境里这个代价只是每次重组多求值一遍模块，可以忽略。
 *
 * @module dsh-model-quota
 */

/** 稳定的插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'dsh-model-quota'

/**
 * 插件主体：加载当前版本实现并安装。
 * @param {object} ctx - cordis 上下文。
 * @param {object} [rawConfig] - 插件配置。
 * @returns {Promise<void>} 安装完成。
 */
export async function apply(ctx, rawConfig = {}) {
  const stamp = `${Date.now()}`
  const impl = await import(`./impl.js?v=${stamp}`)
  return impl.install(ctx, rawConfig)
}
