/** Tiny HTML helpers and the page shell for the approval site. */

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#141110;--panel:#1e1a17;--line:#3a322b;--text:#ece3d4;--muted:#a89b88;--accent:#b3261e;--accent2:#d8b25a;--ok:#5f8f5a;--warn:#c98b2b;--err:#d9534f}
@media (prefers-color-scheme: light){:root{--bg:#f4eee3;--panel:#fffaf1;--line:#ddd0bb;--text:#231c16;--muted:#6f6253;--accent:#9e1f18;--accent2:#8a6416;--warn:#8a5a0c;--ok:#3f6e3a}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Georgia,"Iowan Old Style","Palatino Linotype",serif}
a{color:var(--accent2)}
.wrap{max-width:720px;margin:0 auto;padding:16px}
.wrap.wide{max-width:1480px}
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

/* Editorial workspace: polished hierarchy without an external asset dependency. */
:root{--radius:14px;--shadow:0 12px 34px #0002;--surface2:color-mix(in srgb,var(--panel) 83%,var(--accent2) 17%)}
body{background:radial-gradient(ellipse 65% 430px at 15% -120px,color-mix(in srgb,var(--accent) 11%,transparent),transparent),var(--bg)}
.wrap{padding:20px clamp(14px,2vw,30px) 42px}
header{align-items:center;padding:0 0 15px;gap:18px}
header h1{font-size:22px;letter-spacing:.045em}
.app-nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 24px;font:600 13px system-ui,sans-serif}
.app-nav a{border:1px solid transparent;border-radius:9px;padding:9px 13px;color:var(--muted);text-decoration:none;transition:background .16s,border-color .16s}
.app-nav a:hover,.app-nav a:focus-visible{background:var(--panel);color:var(--text);border-color:var(--line)}
.app-nav a[aria-current="page"]{color:var(--text);background:var(--panel);border-color:var(--accent2)}
.app-nav a.nav-create{margin-left:auto;background:var(--accent);border-color:var(--accent);color:#fff}
h2{font-size:14px;letter-spacing:.11em;margin-top:25px}
h3{font:650 16px/1.3 system-ui,sans-serif;margin:5px 0 11px}
.card{border-radius:var(--radius);box-shadow:0 1px 0 #0002;padding:clamp(14px,2vw,22px)}
.card:focus-within{border-color:color-mix(in srgb,var(--line) 65%,var(--accent2))}
button,.btn{transition:background .16s,border-color .16s,transform .16s}
button:hover:not(:disabled),.btn:hover{background:color-mix(in srgb,var(--accent2) 12%,var(--panel));border-color:var(--accent2)}
button.primary:hover:not(:disabled){background:color-mix(in srgb,var(--accent) 85%,#000);border-color:var(--accent)}
button:disabled{opacity:.55;cursor:not-allowed}
:where(a,button,input,textarea,select,summary,[role="button"]):focus-visible{outline:3px solid var(--accent2);outline-offset:3px}
select{width:100%;font:16px/1.45 system-ui,sans-serif;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px}
label:has(> input[type="checkbox"]){display:flex;align-items:flex-start;gap:9px;line-height:1.45;color:var(--text);font-weight:500}
label:has(> input[type="checkbox"]) input{margin:3px 0 0;flex-shrink:0;accent-color:var(--accent2)}
.notice.ok{border-color:var(--ok)}
.hero{padding:24px 24px 21px;margin-bottom:22px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(120deg,var(--panel) 35%,color-mix(in srgb,var(--panel) 81%,var(--accent2)) 100%)}
.hero-kicker{font:750 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.16em;color:var(--accent2);margin:0 0 12px}
.hero h2{font:700 clamp(24px,4vw,32px)/1.17 Georgia,serif;letter-spacing:0;text-transform:none;color:var(--text);margin:0 0 9px}
.hero p{max-width:70ch;color:var(--muted);margin:0}
.workspace-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(235px,310px);gap:20px;align-items:start}
.workspace-rail{position:sticky;top:16px}
.step-card{border-radius:14px;background:var(--panel);border:1px solid var(--line);padding:18px;margin-bottom:16px}
.step-heading{display:flex;align-items:center;gap:12px;margin:0 0 13px}
.step-number{font:800 13px system-ui,sans-serif;color:var(--accent2);width:30px;height:30px;border:1px solid var(--accent2);border-radius:50%;display:grid;place-items:center;flex-shrink:0}
.step-heading h3{margin:0}
.step-heading p{margin:3px 0 0}
.choice-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:8px}
.choice-tile{margin:0!important;padding:12px 14px!important;align-items:center!important;border-radius:10px;border:1px solid var(--line);background:var(--bg);cursor:pointer}
.choice-tile:has(input:checked){border-color:var(--accent2);background:color-mix(in srgb,var(--accent2) 13%,var(--panel))}
.choice-tile input{accent-color:var(--accent2)}
.form-info{font:13px/1.5 system-ui,sans-serif;color:var(--muted);margin-top:10px}
.summary-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin:11px 0;font:14px system-ui,sans-serif}
.summary-row span:first-child{color:var(--muted)}
.summary-row strong{text-align:right}
.progress-track{height:7px;background:var(--line);border-radius:99px;overflow:hidden}
.progress-fill{display:block;height:100%;background:var(--accent2);border-radius:99px;width:0%;transition:width .2s}
.inline-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.eyebrow{font:750 11px system-ui,sans-serif;letter-spacing:.13em;text-transform:uppercase;color:var(--accent2)}
.rail-note{font:13px/1.55 system-ui,sans-serif;color:var(--muted);margin:10px 0 0}
.status-led{display:inline-block;width:9px;height:9px;background:var(--ok);border-radius:50%;margin-right:7px}
.status-led.warn{background:var(--warn)}
.status-led.err{background:var(--err)}
.field-meter{font:12px system-ui,sans-serif;color:var(--muted);text-align:right}
.media-count{font:13px system-ui,sans-serif;color:var(--muted);margin:7px 0}
.media-error{color:var(--err)!important}
.gallery-controls{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.gallery-controls button{font-size:12px;padding:6px 9px}
.gallery-number{font:750 12px system-ui,sans-serif;color:var(--accent2)}
.choice-advice{font:13px/1.55 system-ui,sans-serif;border-left:3px solid var(--accent2);background:var(--surface2);padding:9px 12px;margin-top:14px;border-radius:0 8px 8px 0}
@media(max-width:830px){.workspace-grid{grid-template-columns:1fr}.workspace-rail{position:static}.app-nav a.nav-create{margin-left:0}}
@media(max-width:600px){header{align-items:flex-start;flex-wrap:wrap}.app-nav{gap:4px}.app-nav a{padding:8px}.hero{padding:19px}.choice-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.row button,.row .btn{max-width:100%}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
`;

export function page(title: string, body: string, opts: { login?: string; wide?: boolean; public?: boolean } = {}): string {
  const who = opts.login
    ? `<span class="who">Signed in as ${esc(opts.login)} · <a href="/logout">sign out</a></span>`
    : "";
  const nav = opts.login ? `<nav class="app-nav" aria-label="Workspace navigation">
    <a href="/" ${title === "GS Poster" ? 'aria-current="page"' : ""}>Planner</a>
    <a href="/tiktok/settings" ${title === "TikTok settings" ? 'aria-current="page"' : ""}>TikTok connection</a>
    <a href="/new" class="nav-create" ${title === "New draft" ? 'aria-current="page"' : ""}>+ New draft</a>
    </nav>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${opts.public ? "" : '<meta name="robots" content="noindex,nofollow">'}<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap${opts.wide ? " wide" : ""}"><header><h1><a href="${opts.public ? "/about" : "/"}">GS Poster</a></h1>${who}</header>${nav}<main id="main-content">${body}</main><footer style="border-top:1px solid var(--line);margin-top:28px;padding-top:12px;font:13px system-ui,sans-serif;display:flex;gap:16px;flex-wrap:wrap"><a href="/about">About</a><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a></footer></div></body></html>`;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
