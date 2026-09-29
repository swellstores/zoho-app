function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function renderCallbackPage(options: {
  ok: boolean;
  title: string;
  message: string;
  /** Where "Back to Swell" leads */
  dashboardUrl: string | null;
}): string {
  const back = options.dashboardUrl
    ? `<p><a href="${escapeHtml(options.dashboardUrl)}">Back to Swell</a></p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zoho connection</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2330; --muted: #5f6577; --bg: #f6f7f9; --card: #fff; --ok: #1a7f37; --bad: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8eaf0; --muted: #a0a6b5; --bg: #15171c; --card: #1e2128; --ok: #4ac26b; --bad: #f97066; } }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 480px; margin: 12vh auto; padding: 32px; background: var(--card); border-radius: 12px; }
  h1 { font-size: 20px; margin: 0 0 12px; color: ${options.ok ? "var(--ok)" : "var(--bad)"}; }
  p { color: var(--muted); margin: 8px 0; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(options.title)}</h1>
  <p>${escapeHtml(options.message)}</p>
  ${back}
</main>
</body>
</html>`;
}
