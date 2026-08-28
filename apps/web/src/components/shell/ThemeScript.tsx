/**
 * Applies the stored theme BEFORE first paint.
 *
 * Without this, a user who chose light mode sees a dark flash on every page
 * load: the document renders with the default theme, then React hydrates and
 * corrects it. React cannot fix that, because hydration happens after paint.
 *
 * The script is tiny, synchronous and runs in <head>, so the correct theme is
 * on the root element before the browser paints anything. It is also wrapped
 * in try/catch: localStorage throws in some privacy modes, and a theme
 * preference must never be able to break the page.
 */
const script = `
(function () {
  try {
    var stored = localStorage.getItem('apihub-theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
`;

export function ThemeScript() {
  return (
    <script
      // The content is a fixed literal, never user input.
      dangerouslySetInnerHTML={{ __html: script }}
    />
  );
}
