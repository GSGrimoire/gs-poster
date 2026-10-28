import type { Env } from "./env.ts";
import type { Post } from "./db.ts";
import { esc } from "./html.ts";
import { localToUtc, toLocalInput } from "./time.ts";

export function dayPlus(day: string, offset: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Calendar uses Sunday through Saturday, like the supplied Meta planner. */
export function weekStart(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid calendar date");
  const d = new Date(day + "T00:00:00Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== day) throw new Error("Invalid calendar date");
  return dayPlus(day, -d.getUTCDay());
}

export function weekRange(start: string, zone: string) {
  return {
    from: localToUtc(start + "T00:00", zone).toISOString(),
    to: localToUtc(dayPlus(start, 7) + "T00:00", zone).toISOString(),
  };
}

/**
 * Return side-by-side lanes for cards whose 66-minute visible spans intersect.
 * Inputs are minute-of-day values sorted in ascending order.
 */
export function assignCalendarLanes(minutes: number[]): Array<{lane: number; lanes: number}> {
  const result = minutes.map(() => ({ lane: 0, lanes: 1 }));
  let start = 0, groupEnd = -1;
  let endings: number[] = [];
  const finish = (last: number) => {
    for (let j = start; j < last; j++) result[j].lanes = endings.length;
  };
  for (let i = 0; i < minutes.length; i++) {
    if (minutes[i] >= groupEnd) {
      finish(i);
      start = i;
      groupEnd = -1;
      endings = [];
    }
    let lane = endings.findIndex(end => end <= minutes[i]);
    if (lane < 0) { lane = endings.length; endings.push(0); }
    endings[lane] = minutes[i] + 66;
    result[i].lane = lane;
    groupEnd = Math.max(groupEnd, minutes[i] + 66);
  }
  finish(minutes.length);
  return result;
}

export function postCalendarTime(post: Post): string | null {
  if (post.scheduled_at) return post.scheduled_at;
  if (post.status === "published") return post.approved_at || post.created_at;
  return null;
}

const STYLE = `
.calendar-toolbar,.calendar-nav,.calendar-legend{display:flex;gap:9px;align-items:center;flex-wrap:wrap;font:13px system-ui,sans-serif}
.calendar-toolbar{justify-content:space-between;margin:15px 0}
.calendar-nav a{padding:8px 12px;border:1px solid var(--line);border-radius:7px;text-decoration:none;color:var(--text)}
.calendar-legend{margin-bottom:10px;color:var(--muted)}
.calendar-swatch{width:10px;height:10px;display:inline-block;border-radius:3px;margin-right:3px}
.calendar-window{overflow:auto;max-height:690px;background:var(--panel);border:1px solid var(--line);border-radius:9px}
.calendar-inner{min-width:1110px}
.calendar-head,.calendar-days{display:grid;grid-template-columns:55px repeat(7,minmax(150px,1fr))}
.calendar-head{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--line)}
.calendar-head div{font:600 13px system-ui,sans-serif;text-align:center;padding:12px 4px;border-right:1px solid var(--line)}
.calendar-head .current{color:var(--accent2)}
.calendar-axis,.calendar-day{height:1440px;position:relative;border-right:1px solid var(--line)}
.calendar-hour{position:absolute;right:6px;font:11px system-ui,sans-serif;color:var(--muted);transform:translateY(-50%)}
.calendar-slot{height:30px;border-bottom:1px solid color-mix(in srgb,var(--line) 40%,transparent)}
.calendar-slot:nth-child(even){border-bottom-color:var(--line)}
.calendar-slot.disabled{background:color-mix(in srgb,var(--muted) 12%,transparent);cursor:not-allowed}
.calendar-slot.drop{background:color-mix(in srgb,var(--accent2) 35%,transparent)}
.calendar-post{position:absolute;top:0;left:4px;right:4px;z-index:3;height:66px;padding:5px;border:1px solid var(--line);border-left:4px solid var(--accent2);border-radius:7px;background:var(--bg);box-shadow:0 2px 5px #0003;font:12px/1.3 system-ui,sans-serif;color:var(--text);text-decoration:none;display:flex;gap:4px;overflow:visible}
.calendar-post[data-status="scheduled"]{border-left-color:#6099df}
.calendar-post[data-status="published"]{border-left-color:var(--ok);opacity:.85}
.calendar-post[data-status="rejected"]{border-left-color:var(--err)}
.calendar-post[draggable=true]{cursor:grab}
.calendar-post .cal-thumb{object-fit:cover;width:42px;flex:0 0 42px;height:50px;border-radius:4px}
.calendar-post[data-lanes="3"] .cal-thumb,.calendar-post[data-lanes="4"] .cal-thumb{display:none}
.calendar-post .cal-text{min-width:0;display:flex;flex-direction:column;gap:3px}
.calendar-post .cal-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}
.calendar-post .cal-time{font-variant-numeric:tabular-nums;font-weight:700}
.platform-icons{display:inline-flex;gap:3px}
.platform-icon{display:inline-grid;place-items:center;width:18px;height:18px;background:#2164a8;color:#fff;border-radius:4px;font:bold 12px system-ui,sans-serif}
.platform-icon.sky{background:#cfe8ff;color:#0861a3}
.cal-tooltip{position:absolute;top:calc(100% + 3px);left:0;z-index:40;display:none;min-width:230px;max-width:300px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:0 6px 18px #0007;white-space:normal;overflow-wrap:anywhere;font:12px/1.5 system-ui,sans-serif}
.calendar-post:hover,.calendar-post:focus{z-index:25}
.calendar-post:hover .cal-tooltip,.calendar-post:focus .cal-tooltip{display:block}
.calendar-info{font:13px system-ui,sans-serif;color:var(--muted);margin:12px 0}
.cal-modal{border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);width:min(440px,95%);padding:22px}
.cal-modal::backdrop{background:#0009}
.cal-modal form .row button{flex:1}
`;

export const CALENDAR_JS = `
(() => {
  const viewport = document.querySelector(".calendar-window");
  if (!viewport) return;
  viewport.scrollTop = 12 * 60;
  let moving = null;
  const dialog = document.getElementById("cal-dialog");
  const form = document.getElementById("cal-form");
  for (const card of document.querySelectorAll(".calendar-post[draggable=true]")) {
    card.addEventListener("dragstart", event => {
      moving = card;
      event.dataTransfer.setData("text/plain", card.dataset.id);
      event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => { moving = null; });
  }
  for (const slot of document.querySelectorAll(".calendar-slot")) {
    slot.addEventListener("dragover", event => {
      if (!moving || slot.classList.contains("disabled")) return;
      event.preventDefault();
      slot.classList.add("drop");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("drop"));
    slot.addEventListener("drop", event => {
      slot.classList.remove("drop");
      if (!moving || slot.classList.contains("disabled")) return;
      event.preventDefault();
      if (Date.parse(slot.dataset.utc) - Date.now() < 12 * 60000) return;
      const post = moving;
      moving = null;
      form.action = "/post/" + encodeURIComponent(post.dataset.id) + "/reschedule";
      form.elements.namedItem("when").value = slot.dataset.when;
      form.elements.namedItem("expected_updated_at").value = post.dataset.version;
      document.getElementById("cal-moving").textContent = post.dataset.label;
      dialog.showModal();
    });
  }
  document.getElementById("cal-dismiss").addEventListener("click", () => dialog.close());
})();
`;

export function renderCalendar(env: Env, posts: Post[], csrf: string, week: string, now = new Date()): string {
  const start = weekStart(week);
  const today = toLocalInput(now, env.TIMEZONE).slice(0, 10);
  const days = Array.from({ length: 7 }, (_, i) => dayPlus(start, i));
  const label = new Intl.DateTimeFormat("en-GB", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const header = '<div class="calendar-head"><div></div>' + days.map(day =>
    '<div class="' + (day === today ? "current" : "") + '">' +
    esc(label.format(new Date(day + "T12:00:00Z"))) + '</div>').join("") + '</div>';
  const timeAxis = '<div class="calendar-axis">' + Array.from({length:24},(_,h) =>
    '<span class="calendar-hour" style="top:' + h*60 + 'px">' + String(h).padStart(2,"0") + ':00</span>').join("") + '</div>';
  const cols = days.map(day => {
    const slots = Array.from({length:48},(_,i) => {
      const when = day + "T" + String(Math.floor(i/2)).padStart(2,"0") + ":" + (i%2?"30":"00");
      const utc = localToUtc(when, env.TIMEZONE).toISOString();
      const disabled = Date.parse(utc) - now.getTime() < 12*60000;
      return '<div class="calendar-slot' + (disabled?' disabled':'') +
        '" data-when="' + when + '" data-utc="' + utc + '"></div>';
    }).join("");
    const entries = posts.filter(p => {
      const t = postCalendarTime(p);
      return t && toLocalInput(new Date(t), env.TIMEZONE).slice(0,10) === day;
    }).map(p => {
      const local = toLocalInput(new Date(postCalendarTime(p)!), env.TIMEZONE);
      const minute = Number(local.slice(11,13))*60 + Number(local.slice(14,16));
      return { p, local, minute };
    }).sort((a,b) => a.minute - b.minute || a.p.id.localeCompare(b.p.id));
    const lanes = assignCalendarLanes(entries.map(x => x.minute));
    const cards = entries.map(({p,local,minute},i) => {
      const placement = lanes[i];
      const width = 100 / placement.lanes;
      const left = width * placement.lane;
      const movable = (p.status === "draft" || p.status === "rejected" || p.status === "scheduled") &&
        (!p.approved_at || (p.scheduled_at && Date.parse(p.scheduled_at) - now.getTime() >= 12*60000));
      const caption = p.facebook_enabled ? p.message : p.bluesky?.caption || p.message;
      const title = p.label || p.release || caption.slice(0,50) || "Untitled post";
      const platforms = (p.facebook_enabled ? '<span class="platform-icon" title="Facebook">f</span>' : '') +
        (p.bluesky ? '<span class="platform-icon sky" title="Bluesky">🦋</span>' : '');
      const url = p.images.length || p.bluesky?.images.length ? '/media/' + p.id + '/0' : null;
      const thumb = url ? '<img class="cal-thumb" src="' + esc(url) + '" alt="" loading="lazy">' : '';
      const tip = '<span class="cal-tooltip"><strong>' + esc(title) + '</strong><br>' + esc(p.status) +
        ' · ' + esc(local.replace('T',' ')) + '<br>Created by ' + esc(p.created_by || "unknown") +
        '<br>' + esc(caption.slice(0,200)) + '</span>';
      return '<a class="calendar-post" style="top:' + minute + 'px;left:calc(' + left +
        '% + 3px);width:calc(' + width + '% - 6px);right:auto" href="/post/' + esc(p.id) +
        '" data-lanes="' + placement.lanes + '" draggable="' + (movable?'true':'false') + '" data-id="' + esc(p.id) +
        '" data-label="' + esc(title) + '" data-version="' + esc(p.updated_at) +
        '" data-status="' + esc(p.status) + '">' + thumb + '<span class="cal-text">' +
        '<span class="cal-time">' + esc(local.slice(11,16)) + ' <span class="platform-icons">' + platforms + '</span></span>' +
        '<span class="cal-title">' + esc(title) + '</span></span>' + tip + '</a>';
    }).join("");
    return '<div class="calendar-day">' + slots + cards + '</div>';
  }).join("");

  return '<style>' + STYLE + '</style><div class="calendar-toolbar"><strong>' +
    esc(start) + ' to ' + esc(dayPlus(start,6)) + '</strong><div class="calendar-nav">' +
    '<a href="/calendar?week=' + dayPlus(start,-7) + '">Previous</a>' +
    '<a href="/calendar?week=' + today + '">Today</a>' +
    '<a href="/calendar?week=' + dayPlus(start,7) + '">Next</a></div></div>' +
    '<div class="calendar-legend"><span><i class="calendar-swatch" style="background:var(--accent2)"></i>Draft</span>' +
    '<span><i class="calendar-swatch" style="background:#6099df"></i>Scheduled</span>' +
    '<span><i class="calendar-swatch" style="background:var(--ok)"></i>Published</span></div>' +
    '<div class="calendar-window"><div class="calendar-inner">' + header + '<div class="calendar-days">' +
    timeAxis + cols + '</div></div></div>' +
    '<p class="calendar-info">Copenhagen time. Hover for details, click to open, or drag a pending post to a half-hour slot. ' +
    'Grey slots are past or less than 12 minutes away. Moving requires your approval PIN. Published posts remain visible.</p>' +
    '<dialog class="cal-modal" id="cal-dialog"><h2>Reschedule <span id="cal-moving"></span></h2>' +
    '<form method="post" id="cal-form"><input type="hidden" name="csrf" value="' + esc(csrf) + '">' +
    '<input type="hidden" name="expected_updated_at"><input type="hidden" name="return_to" value="/calendar?week=' + start + '">' +
    '<label for="cal-when">New time (Europe/Copenhagen)</label>' +
    '<input type="datetime-local" name="when" id="cal-when" required>' +
    '<label for="cal-pin">Approval PIN</label><input type="password" name="pin" id="cal-pin" required autocomplete="off">' +
    '<div class="row"><button type="button" id="cal-dismiss">Cancel</button><button class="primary" type="submit">Save time</button></div>' +
    '</form></dialog><script src="/calendar.js" defer></script>';
}
