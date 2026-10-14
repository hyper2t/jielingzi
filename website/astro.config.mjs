import { defineConfig } from 'astro/config';

// 门户官网:纯静态输出,部署到站点根路径(页面内链接均为 / 开头)。
export default defineConfig({
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    // 输出 index.html / rules.html / 404.html(而不是 rules/index.html),与旧站 URL 保持一致
    format: 'file',
    // 构建出的 CSS / JS 放在 dist/assets/(带内容哈希,可长期缓存)
    assets: 'assets',
  },
  server: { host: true, port: 4321 },
  vite: {
    build: {
      // 不把脚本内联进 HTML:与旧站一致,保持外部 JS 文件(可缓存,也便于以后加 CSP)
      assetsInlineLimit: 0,
      // CSS 压缩按较老的内核(如部分安卓微信 WebView)的语法降级,避免 8 位十六进制颜色等新写法
      cssTarget: ['chrome61', 'safari11'],
    },
    css: {
      // 显式声明“不使用任何 PostCSS 插件”:否则 Vite 会向上查找到仓库根目录的
      // postcss.config.js(小程序/H5 用的 tailwind + autoprefixer),污染官网样式。
      postcss: { plugins: [] },
    },
  },
});
