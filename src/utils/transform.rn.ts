export function rotateStyle (deg: number): { transform: Array<{ rotate: string }> } {
  return { transform: [{ rotate: `${deg}deg` }] }
}
