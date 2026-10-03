// Страницы пульта собираются как текст (esbuild loader '.html': 'text').
declare module '*.html' {
  const html: string;
  export default html;
}
