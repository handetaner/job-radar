/* Job Radar — serverless source adapters (Vercel Function)
   GET /api/jobs?source=stepstone|talent|djw
   Fetches job-board pages server-side (no CORS limits) and returns
   normalized JSON: { jobs: [{id,title,company,location,remote,url,postedAt,tags,desc,source}] }
   Personal-use tool. Results cached 30 min to keep requests polite. */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const get = async (url) => {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de,en;q=0.8" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
};

const stripTags = (s) =>
  (s || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&uuml;/g, "ü").replace(/&ouml;/g, "ö").replace(/&auml;/g, "ä").replace(/&szlig;/g, "ß")
    .replace(/\s+/g, " ")
    .trim();

// "vor 3 Tagen" / "16 hours ago" / "2 days ago" -> epoch ms (approx)
function agoToMs(txt) {
  if (!txt) return 0;
  const m = txt.match(/(\d+)\s*(minute|stunde|hour|tag|day|woche|week|monat|month)/i);
  if (!m) return /gerade|today|heute|just/i.test(txt) ? Date.now() : 0;
  const n = +m[1];
  const unit = m[2].toLowerCase();
  const ms =
    /minute/.test(unit) ? 6e4 :
    /stunde|hour/.test(unit) ? 36e5 :
    /tag|day/.test(unit) ? 864e5 :
    /woche|week/.test(unit) ? 6048e5 : 2592e6;
  return Date.now() - n * ms;
}

// First real text run inside messy nested markup (skips styles, svgs, CSS junk)
function firstText(s) {
  s = (s || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const re = />([^<>]{2,150})</g;
  let m;
  while ((m = re.exec(s))) {
    const t = stripTags(m[1]);
    if (t && /[A-Za-zÀ-ž]/.test(t) && !/currentColor|^[\d.#]|\{|;|^path/i.test(t)) return t;
  }
  return "";
}

// Content between two data-at markers within a job-item chunk
const between = (c, from, to) => {
  const m = c.match(new RegExp('data-at="' + from + '"([\\s\\S]*?)data-at="' + to + '"'));
  return m ? m[1] : "";
};

/* ---------- StepStone: parse <article data-at="job-item"> blocks ---------- */
async function stepstone() {
  const urls = [
    "https://www.stepstone.de/jobs/product-designer/in-berlin",
    "https://www.stepstone.de/jobs/ux-designer/in-berlin",
    "https://www.stepstone.de/jobs/product-owner/in-berlin",
  ];
  const pages = await Promise.allSettled(urls.map(get));
  const jobs = [];
  for (const p of pages) {
    if (p.status !== "fulfilled") continue;
    const chunks = p.value.split(/<article[^>]*data-at="job-item"[^>]*>/).slice(1);
    for (const c of chunks) {
      const a = c.match(/<a[^>]*data-at="job-item-title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
                c.match(/href="(\/stellenangebote--[^"]+)"[^>]*data-at="job-item-title"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const title = stripTags(a[2]);
      const company = firstText(between(c, "job-item-company-name", "job-item-location"));
      const location = firstText(between(c, "job-item-location", "job-item-timeago")) || "Berlin";
      const agoTxt = firstText((c.match(/data-at="job-item-timeago"([\s\S]{0,2000})/) || [])[1]);
      const url = "https://www.stepstone.de" + a[1].replace(/^https?:\/\/www\.stepstone\.de/, "");
      if (!title) continue;
      jobs.push({
        id: "ss-" + (a[1].match(/--(\d+)-inline/) || [0, url])[1],
        title,
        company: company || "—",
        location,
        remote: /remote|home\s*office|homeoffice/i.test(title + " " + location),
        url,
        postedAt: agoToMs(agoTxt),
        tags: [], desc: "", source: "StepStone",
      });
    }
  }
  return jobs;
}

/* ---------- talent.com: parse job cards via aria-label ---------- */
async function talent() {
  const urls = [
    "https://de.talent.com/jobs?k=product+designer&l=Berlin",
    "https://de.talent.com/jobs?k=ux+designer&l=Berlin",
  ];
  const pages = await Promise.allSettled(urls.map(get));
  const jobs = [];
  for (const p of pages) {
    if (p.status !== "fulfilled") continue;
    const re = /aria-label="[^"]*for ([^"]+?) at ([^"]+?)"\s+href="(\/view\?id=(\d+))"/g;
    let m;
    while ((m = re.exec(p.value))) {
      jobs.push({
        id: "tc-" + m[4],
        title: stripTags(m[1]),
        company: stripTags(m[2]),
        location: "Berlin",
        remote: /remote|home\s*office/i.test(m[1]),
        url: "https://de.talent.com" + m[3].replace(/&amp;/g, "&"),
        postedAt: 0, // talent.com cards don't expose a reliable date
        tags: [], desc: "", source: "talent.com",
      });
    }
  }
  return jobs;
}

/* ---------- designjobs.world: parse job cards ---------- */
async function djw() {
  const urls = [
    "https://designjobs.world/germany/berlin",
    "https://designjobs.world/jobs?cities=Berlin&countries=Germany",
  ];
  const pages = await Promise.allSettled(urls.map(get));
  const jobs = [];
  for (const p of pages) {
    if (p.status !== "fulfilled") continue;
    const re = /<a[^>]*href="(\/jobs\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(p.value))) {
      const inner = m[2];
      const title = stripTags((inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
      if (!title) continue;
      const company = stripTags((inner.match(/class="[^"]*font-semibold[^"]*truncate[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
      const location = stripTags((inner.match(/class="[^"]*text-gray-500[^"]*truncate[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1]) || "Berlin";
      const ago = stripTags((inner.match(/>(\s*\d+\s+(?:minutes?|hours?|days?|weeks?|months?)\s+ago\s*)</) || [])[1]);
      const type = (inner.match(/>(ON-SITE|REMOTE|HYBRID)</) || [])[1] || "";
      jobs.push({
        id: "djw-" + m[1].split("/").pop(),
        title, company: company || "—", location,
        remote: type === "REMOTE" || /remote/i.test(title),
        url: "https://designjobs.world" + m[1],
        postedAt: agoToMs(ago),
        tags: type ? [type.toLowerCase()] : [], desc: "", source: "DesignJobs.World",
      });
    }
  }
  return jobs;
}

const SOURCES = { stepstone, talent, djw };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  const fn = SOURCES[(req.query.source || "").toLowerCase()];
  if (!fn) return res.status(400).json({ error: "source must be one of: " + Object.keys(SOURCES).join(", ") });
  try {
    const jobs = await fn();
    const seen = new Set();
    res.status(200).json({ jobs: jobs.filter(j => !seen.has(j.id) && seen.add(j.id)) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
