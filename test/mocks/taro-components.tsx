/** 测试替身：把 Taro 组件渲染为同名宿主节点，便于快照 */
import { createElement } from 'react'

function host (name: string) {
  const C = (props: any) => createElement(name, props, props.children)
  C.displayName = name
  return C
}

export const View = host('View')
export const Text = host('Text')
export const Image = host('Image')
export const ScrollView = host('ScrollView')
export const Swiper = host('Swiper')
export const SwiperItem = host('SwiperItem')
export const Slider = host('Slider')
export const Input = host('Input')
export const Textarea = host('Textarea')
export const Button = host('Button')
export type ITouchEvent = any
