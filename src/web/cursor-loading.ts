const CURSOR_CUBE =
  'M924.213 422.328L806.122 354.147C802.329 351.956 797.653 351.956 793.861 354.147L675.775 422.328C672.588 424.17 670.617 427.572 670.617 431.257V568.738C670.617 572.423 672.583 575.829 675.775 577.667L793.866 645.847C797.659 648.038 802.335 648.038 806.127 645.847L924.218 577.667C927.405 575.824 929.376 572.423 929.376 568.738V431.257C929.376 427.572 927.41 424.165 924.218 422.328H924.213ZM916.799 436.768L802.801 634.219C802.029 635.547 799.994 635.006 799.994 633.463V504.178C799.994 501.596 798.612 499.207 796.373 497.906L684.41 433.265C683.081 432.494 683.622 430.459 685.165 430.459H913.162C916.398 430.459 918.422 433.967 916.805 436.774H916.799V436.768Z'

export function cursorLoadingHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting Cursor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid;
    place-items: center;
    background:
      radial-gradient(ellipse at 50% 38%, rgba(224, 161, 90, 0.16), transparent 42%),
      #10110f;
    color: #f3f0e7;
    font-family: "Source Sans 3", "Segoe UI", sans-serif;
  }
  .stage { position: relative; width: min(440px, calc(100vw - 48px)); text-align: center; }
  .mark {
    position: relative;
    width: 128px;
    height: 128px;
    margin: 0 auto 28px;
  }
  .orbit, .orbit-inner {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1.5px solid transparent;
  }
  .orbit {
    border-top-color: #e0a15a;
    border-right-color: rgba(224, 161, 90, 0.35);
    animation: spin 1.15s linear infinite;
  }
  .orbit-inner {
    inset: 10px;
    border-bottom-color: rgba(243, 240, 231, 0.7);
    border-left-color: rgba(243, 240, 231, 0.2);
    animation: spin 1.8s linear infinite reverse;
  }
  .logo {
    position: absolute;
    inset: 28px;
    width: 72px;
    height: 72px;
    filter: drop-shadow(0 12px 24px rgba(0, 0, 0, 0.45));
    animation: lift 2.6s ease-in-out infinite;
  }
  h1 {
    margin: 0 0 8px;
    font-family: "Source Serif 4", Georgia, serif;
    font-size: 32px;
    font-weight: 500;
    letter-spacing: -0.03em;
  }
  p { margin: 0; color: #9c968a; font-size: 16px; line-height: 1.5; }
  .work { margin-top: 8px; color: #706c63; font-size: 14px; }
  .dots { display: flex; gap: 7px; justify-content: center; margin-top: 22px; }
  .dots i {
    width: 7px;
    height: 7px;
    border-radius: 99px;
    background: #e0a15a;
    animation: blink 1.2s ease-in-out infinite;
  }
  .dots i:nth-child(2) { animation-delay: 0.15s; }
  .dots i:nth-child(3) { animation-delay: 0.3s; }
  @keyframes spin { to { transform: rotate(1turn); } }
  @keyframes lift { 50% { transform: translateY(-4px); } }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); } 40% { opacity: 1; transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) {
    .orbit, .orbit-inner, .logo, .dots i { animation: none; }
    .dots i { opacity: 0.8; }
  }
</style>
</head>
<body>
  <main class="stage">
    <div class="mark">
      <div class="orbit" aria-hidden="true"></div>
      <div class="orbit-inner" aria-hidden="true"></div>
      <svg class="logo" viewBox="590 290 420 420" role="img" aria-label="Cursor">
        <path fill="#F7F7F4" d="M1000 300H600V700H1000V300Z"></path>
        <path fill="#14120B" d="${CURSOR_CUBE}"></path>
      </svg>
    </div>
    <h1>Starting Cursor</h1>
    <p role="status">This tab will redirect when your agent is ready.</p>
    <p class="work">Cursor is resolving the merge conflict in the background.</p>
    <div class="dots" aria-hidden="true"><i></i><i></i><i></i></div>
  </main>
</body>
</html>`
}

export function paintCursorLoading(page: Window) {
  page.document.open()
  page.document.write(cursorLoadingHtml())
  page.document.close()
}
