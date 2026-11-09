/**
 * Fanstate wordmark that follows the surface mode: white logo on dark,
 * black logo on light. The swap is pure CSS (`.brand-logo-*` rules in
 * globals.css keyed on `html[data-mode]`), so there is no flash on load.
 */
export function BrandWordmark({ className = "h-6" }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/fanstate-logo-white.png"
        alt="Fanstate"
        className={`brand-logo-dark w-auto ${className}`}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/fanstate-logo-black.png"
        alt="Fanstate"
        className={`brand-logo-light w-auto ${className}`}
      />
    </>
  );
}
