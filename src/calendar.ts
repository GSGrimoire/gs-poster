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

/** Month inputs use YYYY-MM, and day calculations stay in UTC until zone conversion. */
export function monthStart(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid calendar month");
  const date = new Date(month + "-01T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,7) !== month || Number(month.slice(0,4))<1900 || Number(month.slice(0,4))>9998)
    throw new Error("Invalid calendar month");
  return month + "-01";
}

export function monthPlus(month: string, offset: number): string {
  const start = monthStart(month);
  const date = new Date(start + "T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

export function monthRange(month: string, zone: string) {
  const first = monthStart(month);
  const fromDay = weekStart(first);
  const last = dayPlus(monthPlus(month, 1) + "-01", -1);
  const toDay = dayPlus(weekStart(last), 7);
  return {
    from: localToUtc(fromDay + "T00:00", zone).toISOString(),
    to: localToUtc(toDay + "T00:00", zone).toISOString(),
    startDay: fromDay, endDay: toDay,
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
.calendar-slot:not(.disabled){cursor:pointer}
.calendar-slot:not(.disabled):hover,.calendar-slot:not(.disabled):focus{background:color-mix(in srgb,var(--accent2) 16%,transparent);outline:1px solid var(--accent2);outline-offset:-1px}
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
.platform-icon.tiktok{background:#141414;color:#fafafa;border:1px solid #4ad6d6;text-shadow:1px 1px #ee4769}
.calendar-post[data-status="draft"]{border-left-color:var(--accent2)}
.calendar-post:focus-visible{outline:3px solid var(--accent2);outline-offset:2px}
.calendar-now{position:absolute;left:0;right:0;height:2px;z-index:8;background:#ec5151;pointer-events:none}
.calendar-now[hidden]{display:none}
.calendar-now::before{content:"";position:absolute;left:-4px;top:-4px;width:9px;height:9px;border-radius:50%;background:#ec5151}
.calendar-now-label{position:absolute;right:3px;bottom:5px;background:#b92e2e;color:#fff;border-radius:4px;padding:2px 5px;font:700 11px system-ui,sans-serif;white-space:nowrap}
.calendar-view-toggle{display:flex;align-items:center;gap:3px;border:1px solid var(--line);border-radius:8px;padding:3px}
.calendar-view-toggle a{padding:6px 12px;border-radius:5px;color:var(--text);text-decoration:none}
.calendar-view-toggle a[aria-current="page"]{background:var(--accent);color:#fff;font-weight:700}

.cal-tooltip{position:absolute;top:calc(100% + 3px);left:0;z-index:40;display:none;pointer-events:none;min-width:230px;max-width:300px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:0 6px 18px #0007;white-space:normal;overflow-wrap:anywhere;font:12px/1.5 system-ui,sans-serif}
.calendar-post:hover,.calendar-post:focus{z-index:25}
.calendar-post:hover .cal-tooltip,.calendar-post:focus .cal-tooltip{display:block}
/* While dragging, cards and tooltips must not intercept the target timeslot. */
.calendar-window.is-dragging .calendar-post{pointer-events:none}
.calendar-window.is-dragging .cal-tooltip{display:none!important}
.calendar-info{font:13px system-ui,sans-serif;color:var(--muted);margin:12px 0}
.cal-modal{border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);width:min(440px,95%);padding:22px}
.cal-modal::backdrop{background:#0009}
.cal-modal form .row button{flex:1}
`;

export const CALENDAR_JS = `
(() => {
  const viewport = document.querySelector(".calendar-window");
  if (!viewport) return;
  // Follow the server-configured time zone, not the browser's own zone.
  // The line appears only in the day column that is currently "today".
  const clockZone = viewport.dataset.zone || "Europe/Copenhagen";
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: clockZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  function updateNowLine() {
    const parts = Object.fromEntries(clock.formatToParts(new Date())
      .filter(p => p.type !== "literal").map(p => [p.type,p.value]));
    const today = parts.year + "-" + parts.month + "-" + parts.day;
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    for (const heading of viewport.querySelectorAll(".calendar-head [data-day]"))
      heading.classList.toggle("current", heading.dataset.day === today);
    for (const column of viewport.querySelectorAll(".calendar-day[data-day]")) {
      const line = column.querySelector(".calendar-now");
      if (!line) continue;
      line.hidden = column.dataset.day !== today;
      if (!line.hidden) {
        line.style.top = minute + "px";
        line.querySelector(".calendar-now-label").textContent =
          "Now " + parts.hour + ":" + parts.minute;
      }
    }
  }
  updateNowLine();
  const visibleLine = viewport.querySelector(".calendar-now:not([hidden])");
  const minuteNow = visibleLine ? Number.parseFloat(visibleLine.style.top) : NaN;
  viewport.scrollTop = Number.isFinite(minuteNow)
    ? Math.max(0, minuteNow - viewport.clientHeight / 2) : 12 * 60;
  setInterval(updateNowLine, 60000);
  let moving = null;
  let ignoreSlotClicksUntil = 0;
  const dialog = document.getElementById("cal-dialog");
  const form = document.getElementById("cal-form");
  for (const card of document.querySelectorAll(".calendar-post[draggable=true]")) {
    card.addEventListener("dragstart", event => {
      moving = card;
      ignoreSlotClicksUntil = Date.now() + 450;
      viewport.classList.add("is-dragging");
      event.dataTransfer.setData("text/plain", card.dataset.id);
      event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      ignoreSlotClicksUntil = Date.now() + 450;
      moving = null;
      viewport.classList.remove("is-dragging");
      document.querySelectorAll(".calendar-slot.drop").forEach(s => s.classList.remove("drop"));
    });
  }
  for (const slot of document.querySelectorAll(".calendar-slot")) {
    function openDraft() {
      if (moving || Date.now() < ignoreSlotClicksUntil || slot.classList.contains("disabled")) return;
      if (Date.parse(slot.dataset.utc) - Date.now() < 12 * 60000) return;
      window.location.assign("/new?when=" + encodeURIComponent(slot.dataset.when));
    }
    slot.addEventListener("click", openDraft);
    slot.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {event.preventDefault();openDraft();}
    });
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
      ignoreSlotClicksUntil = Date.now() + 450;
      moving = null;
      viewport.classList.remove("is-dragging");
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
    '<div data-day="' + day + '" class="' + (day === today ? "current" : "") + '">' +
    esc(label.format(new Date(day + "T12:00:00Z"))) + '</div>').join("") + '</div>';
  const timeAxis = '<div class="calendar-axis">' + Array.from({length:24},(_,h) =>
    '<span class="calendar-hour" style="top:' + h*60 + 'px">' + String(h).padStart(2,"0") + ':00</span>').join("") + '</div>';
  const cols = days.map(day => {
    const slots = Array.from({length:48},(_,i) => {
      const when = day + "T" + String(Math.floor(i/2)).padStart(2,"0") + ":" + (i%2?"30":"00");
      const utc = localToUtc(when, env.TIMEZONE).toISOString();
      const lead = Date.parse(utc) - now.getTime();
      const disabled = lead < 12*60000 || lead > 30*24*60*60000;
      return '<div class="calendar-slot' + (disabled?' disabled':'') +
        '" data-when="' + when + '" data-utc="' + utc + '"' +
        (disabled ? ' aria-disabled="true"' : ' role="button" tabindex="0" title="Create draft for ' + when.replace('T',' ') + '" aria-label="Create draft for ' + when.replace('T',' ') + '"') + '></div>';
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
      const caption = p.facebook_enabled ? p.message : p.tiktok_enabled ? (p.tiktok_caption??p.message) : p.bluesky?.caption || p.message;
      const title = p.label || p.release || caption.slice(0,50) || "Untitled post";
      const platforms = (p.facebook_enabled ? '<span class="platform-icon" title="Facebook" aria-label="Facebook">f</span>' : '') +
        (p.bluesky ? '<span class="platform-icon sky" title="Bluesky" aria-label="Bluesky">🦋</span>' : '') +
        (p.tiktok_enabled ? '<span class="platform-icon tiktok" title="TikTok, manual transfer" aria-label="TikTok">♪</span>' : '');
      const imageTarget=p.facebook_enabled&&p.images.length?"facebook":
        p.tiktok_enabled&&(p.tiktok_images??p.images).length?"tiktok":
        p.bluesky?.images.length?"bluesky":null;
      const url = imageTarget?'/media/'+p.id+'/0?thumb=1&platform='+imageTarget:null;
      const thumb = url ? '<img class="cal-thumb" src="' + esc(url) + '" alt="" loading="lazy">' : '';
      const tip = '<span class="cal-tooltip"><strong>' + esc(title) + '</strong><br>' + esc(p.status) +
        ' | ' + esc(local.replace('T',' ')) + '<br>Created by ' + esc(p.created_by || "unknown") +
        (p.tiktok_enabled?'<br><strong>TikTok requires an explicit transfer</strong>':'') +
        '<br>' + esc(caption.slice(0,200)) + '</span>';
      return '<a class="calendar-post" style="top:' + minute + 'px;left:calc(' + left +
        '% + 3px);width:calc(' + width + '% - 6px);right:auto" href="/post/' + esc(p.id) +
        '" data-lanes="' + placement.lanes + '" draggable="' + (movable?'true':'false') + '" data-id="' + esc(p.id) +
        '" data-label="' + esc(title) + '" data-version="' + esc(p.updated_at) +
        '" data-status="' + esc(p.status) + '">' + thumb + '<span class="cal-text">' +
        '<span class="cal-time">' + esc(local.slice(11,16)) + ' <span class="platform-icons">' + platforms + '</span></span>' +
        '<span class="cal-title">' + esc(title) + '</span></span>' + tip + '</a>';
    }).join("");
    return '<div class="calendar-day" data-day="' + day + '">' + slots + cards +
      '<div class="calendar-now" hidden><span class="calendar-now-label"></span></div></div>';
  }).join("");

  return '<style>' + STYLE + '</style><div class="calendar-toolbar"><strong>' +
    esc(start) + ' to ' + esc(dayPlus(start,6)) + '</strong><div class="calendar-nav">' +
    '<a href="/calendar?view=week&week=' + dayPlus(start,-7) + '">Previous</a>' +
    '<a href="/calendar?view=week&week=' + today + '">Today</a>' +
    '<a href="/calendar?view=week&week=' + dayPlus(start,7) + '">Next</a></div>' +
    '<nav class="calendar-view-toggle" aria-label="Planner view">' +
    '<a href="/calendar?view=week&week=' + start + '" aria-current="page">Week</a>' +
    '<a href="/calendar?view=month&month=' + dayPlus(start,3).slice(0,7) + '">Month</a></nav></div>' +
    '<div class="calendar-legend"><span><i class="calendar-swatch" style="background:var(--accent2)"></i>Draft</span>' +
    '<span><i class="calendar-swatch" style="background:#6099df"></i>Scheduled</span>' +
    '<span><i class="calendar-swatch" style="background:var(--ok)"></i>Published</span></div>' +
    '<div class="calendar-window" data-zone="' + esc(env.TIMEZONE) + '"><div class="calendar-inner">' + header + '<div class="calendar-days">' +
    timeAxis + cols + '</div></div></div>' +
    '<p class="calendar-info">Copenhagen time. Click an available empty timeslot to create a draft, hover for details, or drag a pending post to reschedule. ' +
    'Grey slots are past, less than 12 minutes away, or beyond 30 days. Creating a draft never publishes; moving an approved post requires your PIN. Published posts remain visible.</p>' +
    '<dialog class="cal-modal" id="cal-dialog"><h2>Reschedule <span id="cal-moving"></span></h2>' +
    '<form method="post" id="cal-form"><input type="hidden" name="csrf" value="' + esc(csrf) + '">' +
    '<input type="hidden" name="expected_updated_at"><input type="hidden" name="return_to" value="/calendar?view=week&amp;week=' + start + '">' +
    '<label for="cal-when">New time (Europe/Copenhagen)</label>' +
    '<input type="datetime-local" name="when" id="cal-when" required>' +
    '<label for="cal-pin">Approval PIN</label><input type="password" name="pin" id="cal-pin" required autocomplete="off">' +
    '<div class="row"><button type="button" id="cal-dismiss">Cancel</button><button class="primary" type="submit">Save time</button></div>' +
    '</form></dialog><script src="/calendar.js" defer></script>';
}

const MONTH_STYLE = `
.calendar-month-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.calendar-month-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));min-width:980px}
.calendar-month-weekday{padding:11px 8px;text-align:center;font:700 12px system-ui,sans-serif;background:var(--panel);border-bottom:1px solid var(--line)}
.calendar-month-day{min-height:152px;padding:8px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px;min-width:0}
.calendar-month-day:nth-child(7n){border-right:none}
.calendar-month-day.outside{background:color-mix(in srgb,var(--muted) 7%,var(--panel))}
.calendar-month-day.today{background:color-mix(in srgb,var(--accent2) 9%,var(--panel))}
.calendar-month-date{align-self:flex-start;padding:3px 6px;border-radius:5px;text-decoration:none;font:700 13px system-ui,sans-serif;color:var(--text)}
.calendar-month-date:hover,.calendar-month-date:focus-visible{background:color-mix(in srgb,var(--accent2) 16%,var(--panel));outline-offset:1px}
.calendar-month-day.today .calendar-month-date{background:var(--accent);color:#fff}
.calendar-month-day.outside .calendar-month-date{color:var(--muted)}
.calendar-month-posts{display:flex;flex-direction:column;gap:5px}
.calendar-month-post{display:flex;gap:7px;align-items:flex-start;min-width:0;border:1px solid var(--line);border-left:3px solid var(--accent2);border-radius:6px;padding:5px;background:var(--bg);color:var(--text);text-decoration:none}
.calendar-month-post[data-status="scheduled"]{border-left-color:#6099df}
.calendar-month-post[data-status="published"]{border-left-color:var(--ok)}
.calendar-month-post[data-status="rejected"]{border-left-color:var(--err)}
.calendar-month-post:hover,.calendar-month-post:focus-visible{border-color:var(--accent2);outline-offset:1px}
.calendar-month-thumb{width:42px;height:48px;object-fit:cover;border-radius:4px;flex:0 0 42px;background:#0002}
.calendar-month-video{width:42px;height:48px;flex:0 0 42px;display:grid;place-items:center;background:color-mix(in srgb,var(--accent2) 14%,var(--panel));border-radius:4px;font:700 11px system-ui,sans-serif}
.calendar-month-text{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.calendar-month-title{font:650 12px/1.3 system-ui,sans-serif;overflow-wrap:anywhere}
.calendar-month-meta{font:11px/1.25 system-ui,sans-serif;color:var(--muted)}
.calendar-month-post .platform-icon{width:15px;height:15px;font-size:10px}
.calendar-month-info{font:13px system-ui,sans-serif;color:var(--muted);margin:12px 0}
.calendar-month-wrap .platform-icon.ig{background:#8943a8;color:white;font-size:8px}
`;

/** Read-only month overview. The day has no times or publishing controls. */
export function renderMonthCalendar(env: Env, posts: Post[], month: string, now = new Date()): string {
  const first = monthStart(month);
  const {startDay,endDay} = monthRange(month,env.TIMEZONE);
  const today = toLocalInput(now,env.TIMEZONE).slice(0,10);
  const displayMonth = new Intl.DateTimeFormat("en-GB", {month:"long",year:"numeric",timeZone:"UTC"})
    .format(new Date(first+"T12:00:00Z"));
  const dayLabel = new Intl.DateTimeFormat("en-GB", {weekday:"long",day:"numeric",month:"long",year:"numeric",timeZone:"UTC"});
  const postsByDay = new Map<string, Array<{p:Post;iso:string}>>();
  for (const p of posts) {
    // An unscheduled draft appears on its creation day, but is labelled unscheduled.
    const iso = postCalendarTime(p) ?? p.created_at;
    const day = toLocalInput(new Date(iso),env.TIMEZONE).slice(0,10);
    if (!postsByDay.has(day)) postsByDay.set(day,[]);
    postsByDay.get(day)!.push({p,iso});
  }
  for (const values of postsByDay.values())
    values.sort((a,b) => a.iso.localeCompare(b.iso) || a.p.id.localeCompare(b.p.id));
  const weekdays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
    .map(day => '<div class="calendar-month-weekday">'+day+'</div>').join("");
  const cells: string[] = [];
  for (let day=startDay; day<endDay; day=dayPlus(day,1)) {
    const outside = day.slice(0,7)!==month;
    const todayClass = day===today?" today":"";
    const entries = (postsByDay.get(day) ?? []).map(({p}) => {
      const caption = p.facebook_enabled ? p.message : p.tiktok_enabled ? (p.tiktok_caption??p.message) : p.bluesky?.caption || p.instagram?.caption || p.message;
      const title = p.label || p.release || caption.slice(0,50) || "Untitled post";
      const imageTarget = p.facebook_enabled&&p.images.length ? "facebook" :
        p.tiktok_enabled&&(p.tiktok_images??p.images).length ? "tiktok" :
        p.bluesky?.images.length ? "bluesky" :
        p.instagram?.items.length ? "instagram" : null;
      const thumb = imageTarget
        ? '<img class="calendar-month-thumb" loading="lazy" alt="" src="/media/'+esc(p.id)+'/0?thumb=1&amp;platform='+imageTarget+'">'
        : (p.video || p.tiktok_video || p.bluesky?.video || p.instagram?.video)
          ? '<span class="calendar-month-video" aria-hidden="true">Video</span>' : "";
      const platforms = (p.facebook_enabled ? '<span class="platform-icon" title="Facebook" aria-label="Facebook">f</span>' : '') +
        (p.bluesky ? '<span class="platform-icon sky" title="Bluesky" aria-label="Bluesky">🦋</span>' : '') +
        (p.tiktok_enabled ? '<span class="platform-icon tiktok" title="TikTok" aria-label="TikTok">♪</span>' : '') +
        (p.instagram ? '<span class="platform-icon ig" title="Instagram" aria-label="Instagram">IG</span>' : '');
      const unscheduled = !p.scheduled_at && p.status!=="published";
      const subtitle = p.status.charAt(0).toUpperCase()+p.status.slice(1) + (unscheduled?" · Unscheduled":"");
      return '<a class="calendar-month-post" href="/post/'+esc(p.id)+'" data-status="'+esc(p.status)+'" title="'+esc(title)+'">'+
        thumb+'<span class="calendar-month-text"><span class="calendar-month-title">'+esc(title)+'</span>'+
        '<span class="calendar-month-meta">'+esc(subtitle)+'</span>'+
        '<span class="platform-icons">'+platforms+'</span></span></a>';
    }).join("");
    const fullDay = dayLabel.format(new Date(day+"T12:00:00Z"));
    cells.push('<section class="calendar-month-day'+(outside?' outside':'')+todayClass+
      '" data-day="'+day+'" aria-label="'+esc(fullDay)+'">'+
      '<a class="calendar-month-date" href="/calendar?view=week&amp;week='+day+'" aria-label="View week of '+esc(fullDay)+'">'+
      String(Number(day.slice(8)))+'</a><div class="calendar-month-posts">'+entries+'</div></section>');
  }
  return '<style>'+STYLE+MONTH_STYLE+'</style>'+
    '<div class="calendar-toolbar"><strong>'+esc(displayMonth)+'</strong><div class="calendar-nav">'+
    '<a href="/calendar?view=month&amp;month='+monthPlus(month,-1)+'">Previous</a>'+
    '<a href="/calendar?view=month&amp;month='+today.slice(0,7)+'">Today</a>'+
    '<a href="/calendar?view=month&amp;month='+monthPlus(month,1)+'">Next</a></div>'+
    '<nav class="calendar-view-toggle" aria-label="Planner view">'+
    '<a href="/calendar?view=week&amp;week='+(month===today.slice(0,7)?today:first)+'">Week</a>'+
    '<a href="/calendar?view=month&amp;month='+month+'" aria-current="page">Month</a></nav></div>'+
    '<div class="calendar-legend"><span><i class="calendar-swatch" style="background:var(--accent2)"></i>Draft</span>'+
    '<span><i class="calendar-swatch" style="background:#6099df"></i>Scheduled</span>'+
    '<span><i class="calendar-swatch" style="background:var(--ok)"></i>Published</span></div>'+
    '<div class="calendar-month-wrap"><div class="calendar-month-grid">'+weekdays+cells.join("")+'</div></div>'+
    '<p class="calendar-month-info">Dates use '+esc(env.TIMEZONE)+'. All posts for each displayed day are listed without hours. '+
    'Unscheduled drafts are shown on their creation date and clearly marked. Select a post to edit or review it; '+
    'select a day number to see its week and the time-based scheduling tools.</p>';
}
