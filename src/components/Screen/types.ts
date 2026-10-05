/** Screen 暴露的滚动句柄（RN 端为自己的 ScrollView；小程序 / H5 页面本身可滚，句柄为空实现） */
export interface ScreenScrollHandle {
  /** 滚到内容区的 y（像素） */
  scrollTo (y: number, animated?: boolean): void
  /** 可视区高度（像素），未量到时为 0 */
  viewportHeight (): number
}
