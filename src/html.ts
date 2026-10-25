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
.preview .thumbs{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.preview .thumbs img{aspect-ratio:auto;max-height:420px;object-fit:contain}
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
`;

export function page(title: string, body: string, opts: { login?: string } = {}): string {
  const who = opts.login
    ? `<span class="who">Signed in as ${esc(opts.login)} · <a href="/logout">sign out</a></span>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap"><header><h1><a href="/">GS Poster</a></h1>${who}</header>${body}</div></body></html>`;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function html(body: string, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(SECURITY_HEADERS);
  new Headers(init.headers).forEach((v, k) => headers.append(k, v));
  return new Response(body, { status: init.status ?? 200, headers });
}
