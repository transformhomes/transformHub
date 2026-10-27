// Reads the unread count and calendar from classic Outlook running on this PC (Windows only).
// It only talks to an Outlook that is already open, never starts one, and reads nothing but the unread
// count and each appointment's title and times. Nothing is written, sent or sent anywhere.
const OUTLOOK_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { $ol = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch { '{"state":"closed"}'; exit }
try {
  $ns = $ol.GetNamespace('MAPI')
  $unread = [int]$ns.GetDefaultFolder(6).UnreadItemCount
  $items = $ns.GetDefaultFolder(9).Items
  $items.IncludeRecurrences = $true
  $items.Sort('[Start]')
  $from = [datetime]::Today.AddDays(1 - [datetime]::Today.Day)
  $to = $from.AddDays(75)
  $f = "[Start] >= '" + $from.ToString('g') + "' AND [Start] < '" + $to.ToString('g') + "'"
  $out = New-Object System.Collections.ArrayList
  foreach ($i in $items.Restrict($f)) {
    if ($out.Count -ge 250) { break }
    $title = if ($i.Sensitivity -eq 2) { 'Private appointment' } else { [string]$i.Subject }
    [void]$out.Add([pscustomobject]@{ title = $title; start = $i.Start.ToString('yyyy-MM-ddTHH:mm'); end = $i.End.ToString('yyyy-MM-ddTHH:mm'); allDay = [bool]$i.AllDayEvent })
  }
  ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ state = 'ok'; unread = $unread; events = @($out) })
} catch { ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ state = 'error' }) }
`;

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// Check whatever the script printed and keep only the fields Home needs.
function parseOutlook(stdout) {
  const text = String(stdout || '');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) return { state: 'error' };
  let raw;
  try { raw = JSON.parse(text.slice(a, b + 1)); } catch { return { state: 'error' }; }
  if (!raw || typeof raw !== 'object') return { state: 'error' };
  if (raw.state === 'closed') return { state: 'closed' };
  if (raw.state !== 'ok') return { state: 'error' };
  const unread = Number.isFinite(raw.unread) && raw.unread >= 0 ? Math.floor(raw.unread) : 0;
  const list = Array.isArray(raw.events) ? raw.events : raw.events ? [raw.events] : [];
  const events = [];
  for (const e of list.slice(0, 250)) {
    if (!e || typeof e.start !== 'string' || !STAMP.test(e.start)) continue;
    const ev = { date: e.start.slice(0, 10), title: String(e.title || '(no title)').slice(0, 200), allDay: e.allDay === true, source: 'outlook' };
    if (!ev.allDay) {
      ev.start = e.start.slice(11);
      if (typeof e.end === 'string' && STAMP.test(e.end) && e.end.slice(0, 10) === ev.date) ev.end = e.end.slice(11);
    }
    events.push(ev);
  }
  return { state: 'ok', unread, events };
}

// run(script) -> Promise<stdout string>. Results are kept for ttl ms so Home can refresh freely.
function createOutlook({ run, ttl = 60000, now = () => Date.now() }) {
  let cache = null, at = 0, inflight = null;
  async function get(force) {
    if (!force && cache && now() - at < ttl) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      let result;
      try { result = parseOutlook(await run(OUTLOOK_SCRIPT)); } catch { result = { state: 'error' }; }
      result.updated = now();
      cache = result; at = now(); inflight = null;
      return result;
    })();
    return inflight;
  }
  return { get };
}

module.exports = { createOutlook, parseOutlook, OUTLOOK_SCRIPT };
