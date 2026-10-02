// Images imported from the renderer resolve to their bundled address (vite).
declare module "*.jpg" {
  const src: string;
  export default src;
}
