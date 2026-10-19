/** Tiny HTML helpers and the page shell for the approval site. */

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#141110;--panel:#1e1a17;--line:#3a322b;--text:#ece3d4;--muted:#a89b88;--accent:#b3261e;--accent2:#d8b25a;--ok:#5f8f5a;--warn:#c98b2b;--err:#d9534f}
@media (prefers-color-scheme: light){:root{--bg:#f4eee3;--panel:#fffaf1;--line:#ddd0bb;--text:#231c16;--muted:#6f6253;--accent:#9e1f18;--accent2:#8a6416}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Georgia,"Iowan Old Style","Palatino Linotype",serif}
a{color:var(--accent2)}
.wrap{max-width:720px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:18px}
header h1{font:600 20px/1.2 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;margin:0}
header h1 a{color:var(--text);text-decoration:none}
header .who{font:13px system-ui,sans-serif;color:var(--muted)}
h2{font:600 13px system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin:0 0 12px}
.card a.stretch{color:inherit;text-decoration:none;display:block}
.meta{font:13px system-ui,sans-serif;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.chip{font:600 11px system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}
.s-draft{background:var(--accent2);color:#1a1307;border-color:transparent}
.s-scheduled{background:#2f5d8a;color:#fff;border-color:transparent}
.s-published{background:var(--ok);color:#fff;border-color:transparent}
.s-failed,.s-rejected{background:var(--err);color:#fff;border-color:transparent}
.s-cancelled{opacity:.7}
.caption{white-space:pre-wrap;margin:10px 0 0}
.clip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px;margin-top:10px}
.thumbs img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;border:1px solid var(--line);background:#0003}
.checks{font:14px system-ui,sans-serif;margin:10px 0 0;padding-left:18px}
.checks .e{color:var(--err)} .checks .w{color:var(--warn)}
label{display:block;font:600 13px system-ui,sans-serif;color:var(--muted);margin:14px 0 6px}
textarea,input[type=text],input[type=password],input[type=datetime-local]{width:100%;font:16px/1.45 system-ui,sans-serif;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px}
textarea{min-height:200px;resize:vertical}
.hint{font:13px system-ui,sans-serif;color:var(--muted);margin:4px 0 0}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
button,.btn{font:600 15px system-ui,sans-serif;border-radius:8px;padding:12px 18px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;flex:1 1 200px}
button.danger{border-color:var(--err);color:var(--err)}
.notice{border-left:3px solid var(--accent2);padding:8px 12px;background:var(--panel);font:14px system-ui,sans-serif;margin:0 0 14px}
.notice.err{border-color:var(--err)}
table.log{width:100%;border-collapse:collapse;font:13px system-ui,sans-serif}
table.log td{padding:6px 4px;border-top:1px solid var(--line);vertical-align:top;color:var(--muted)}
table.log td:nth-child(3){color:var(--text);word-break:break-word}
table.log td.ts{white-space:nowrap}
details summary{cursor:pointer;font:14px system-ui,sans-serif;color:var(--muted)}
.empty{color:var(--muted);font:14px system-ui,sans-serif}
h3.day{font:600 14px system-ui,sans-serif;color:var(--text);margin:18px 0 8px}
.late{font:600 12px system-ui,sans-serif;color:var(--warn)}
.notice.warn{border-color:var(--warn)}
.prose h3{font:600 15px system-ui,sans-serif;margin:18px 0 6px}
.prose p,.prose ul{margin:0 0 10px}
.fb{--fb-bg:#242526;--fb-text:#e4e6eb;--fb-muted:#b0b3b8;--fb-line:#3e4042;background:var(--fb-bg);color:var(--fb-text);border-radius:10px;margin:0 0 12px;overflow:hidden;font:15px/1.34 system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;border:1px solid var(--line)}
@media (prefers-color-scheme: light){.fb{--fb-bg:#fff;--fb-text:#080809;--fb-muted:#65686c;--fb-line:#e4e6eb}}
.fb-head{display:flex;gap:10px;align-items:center;padding:12px 14px 0}
.fb-avatar{width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font:700 14px Georgia,serif;flex:none}
.fb-head strong{display:block;font-size:15px}
.fb-when{display:block;font-size:13px;color:var(--fb-muted)}
.fb-when::first-letter{text-transform:uppercase}
.fb-text{white-space:pre-wrap;word-break:break-word;margin:10px 14px 12px}
.fb-media{display:grid;gap:2px;grid-template-columns:repeat(6,1fr)}
.fb-media a{display:block;position:relative;grid-column:span 6;min-width:0}
.fb-media img{display:block;width:100%;height:100%;object-fit:cover;aspect-ratio:1;background:#0003}
.fb-media.n1 img{aspect-ratio:auto;max-height:560px;object-fit:contain;background:#000}
.fb-media.n2 a{grid-column:span 3}
.fb-media.n3 a:first-child img{aspect-ratio:2/1}
.fb-media.n3 a:not(:first-child),.fb-media.n4 a{grid-column:span 3}
.fb-media.n5 a{grid-column:span 2}
.fb-media.n5 a:nth-child(-n+2){grid-column:span 3}
.fb-more{position:absolute;inset:0;display:grid;place-items:center;background:#0008;color:#fff;font:700 28px system-ui,sans-serif}
.fb-link{margin:0 14px 12px;padding:10px 12px;border:1px solid var(--fb-line);border-radius:8px;color:var(--fb-muted);font-size:13px;word-break:break-all}
.fb-bar{display:flex;justify-content:space-around;border-top:1px solid var(--fb-line);margin:0 14px;padding:8px 0;color:var(--fb-muted);font-size:14px;font-weight:600}
.setup{list-style:none;margin:0;padding:0}
.setup li{display:grid;grid-template-columns:28px 1fr;gap:4px 8px;padding:10px 0;border-top:1px solid var(--line);font:15px system-ui,sans-serif}
.setup li:first-child{border-top:0}
.setup .mark{font-weight:700}
.setup .ok .mark{color:var(--ok)} .setup .bad .mark{color:var(--err)} .setup .opt .mark{color:var(--muted)}
.setup .hint{grid-column:2}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
`;

export function page(title: string, body: string, opts: { login?: string; indexable?: boolean } = {}): string {
  const who = opts.login
    ? `<span class="who">Signed in as ${esc(opts.login)} · <a href="/setup">setup</a> · <a href="/logout">sign out</a></span>`
    : "";
  const robots = opts.indexable ? "" : `<meta name="robots" content="noindex,nofollow">`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${robots}<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap"><header><h1><a href="/">GS Poster</a></h1>${who}</header>${body}</div></body></html>`;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  // Not "no-referrer": with that, browsers send `Origin: null` on our own form
  // posts and the same-origin check in web.ts refuses every approval.
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function html(body: string, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(SECURITY_HEADERS);
  new Headers(init.headers).forEach((v, k) => headers.append(k, v));
  return new Response(body, { status: init.status ?? 200, headers });
}
