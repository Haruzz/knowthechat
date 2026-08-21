const PROVIDERS = [
  "https://recent-messages.robotty.de/api/v2/recent-messages/",
  "https://recent-messages.zneix.eu/api/v2/recent-messages/",
  "https://logs.zonian.dev/rm/",
] as const;
const MAX_MESSAGES = 1000;
const MIN_HISTORICAL_MESSAGES = 100;
const HISTORY_ORIGIN = "https://logs.zonian.dev";
const KNOWN_BOTS = new Set([
  "streamelements", "nightbot", "moobot", "fossabot", "streamlabs", "streamlabscloudbot",
  "wizebot", "botrixoficial", "serybot", "stayhydratedbot", "soundalerts", "commanderroot",
  "pokemoncommunitygame", "own3d", "kofistreambot", "pretzelrocks", "songlistbot",
]);

type HistoricalMessage = {
  text?: unknown;
  displayName?: unknown;
  timestamp?: unknown;
  id?: unknown;
  tags?: Record<string, unknown>;
};

type ArchiveDate = { year: string; month: string; day?: string };
type TwitchEmote = { id: string; start: number; end: number; url?: string };
type CachedRequestInit = RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } };

function unescapeTag(value: string) {
  return value.replace(/\\s/g, " ").replace(/\\:/g, ";").replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

function normalize(body: string) {
  return body.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, "").trim();
}

function withoutTwitchEmotes(body: string, emoteTag = "") {
  const ranges = [...emoteTag.matchAll(/(\d+)-(\d+)/g)].map(match => [Number(match[1]), Number(match[2])] as const).sort((a, b) => b[0] - a[0]);
  let text = body;
  for (const [start, end] of ranges) text = `${text.slice(0, start)} ${text.slice(end + 1)}`;
  return text;
}

function parseTwitchEmotes(emoteTag = "", bodyLength = Infinity): TwitchEmote[] {
  const emotes: TwitchEmote[] = [];
  for (const group of emoteTag.split("/")) {
    const [id, positions = ""] = group.split(":");
    if (!/^\d+$/.test(id)) continue;
    for (const position of positions.split(",")) {
      const match = /^(\d+)-(\d+)$/.exec(position);
      if (!match) continue;
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start >= 0 && end >= start && end < bodyLength) emotes.push({ id, start, end });
    }
  }
  return emotes.sort((a, b) => a.start - b.start);
}

function isLowQuality(body:string,normalized:string,emoteTag=""){
  const prose = normalize(withoutTwitchEmotes(body, emoteTag));
  const words=prose.split(" ").filter(Boolean);
  const generic=/^(lol|lmao|lmfao|yes|no|true|based|nice|what|why|wtf|hello|hi|hey|bye|good morning|good night|dont say that|do not say that)$/i;
  const command=/^\s*[!/$?.][a-z0-9_]+(?:\s|$)/i;
  const mention=/@[a-z0-9_]{2,25}/i.test(body);
  const pipes=(body.match(/\|/g)||[]).length;
  const rankCard=/\b(?:iron|bronze|silver|gold|platinum|emerald|diamond|master|grandmaster|challenger)\s+\d+\s*lp\b/i.test(body)||/\bpros?\s*\/\s*streamers?\s*:/i.test(body);
  const rosterEntries=(body.match(/\p{L}[\p{L}\p{N}_]{1,24}\s*\([^)]{2,30}\)/gu)||[]).length;
  const automated=/\b(points?|watch\s*time|uptime|has been following|now have \d+|ranked? #?\d+|game results?|now playing|current song|followage|account age|match history)\b/i.test(body)||pipes>=4||rankCard||(pipes>=2&&rosterEntries>=2)||/\b\d+(?:\.\d+)?\s*(?:%|k)?\s*(?:kp|dmg|cs\/min|gold\/min|vision\/min|cc\/min|self-mitigated\/min)\b/i.test(body);
  const repeated=/(.)\1{5,}/i.test(body);
  const meaningful=(body.match(/[\p{L}\p{N}]/gu)||[]).length/Math.max(body.length,1);
  return command.test(body)||generic.test(normalized)||mention||automated||words.length<4||repeated||meaningful<0.45;
}

function isKnownBot(name: string) {
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return KNOWN_BOTS.has(normalizedName) || /(?:bot|botat)$/.test(normalizedName);
}

function isTwitchEventNotice(body: string, tags: Record<string, unknown>) {
  const messageId = typeof tags["msg-id"] === "string" ? tags["msg-id"].toLowerCase() : "";
  const eventIds = new Set([
    "sub", "resub", "subgift", "anonsubgift", "submysterygift", "anonsubmysterygift",
    "giftpaidupgrade", "primepaidupgrade", "standardpayforward", "communitypayforward",
    "raid", "unraid", "ritual", "bitsbadgetier", "charitydonation",
  ]);
  const systemMessage = typeof tags["system-msg"] === "string" ? tags["system-msg"].trim() : "";
  const noticeText = /\b(?:gifted (?:an? |\d+ )?(?:tier \d+ )?subs?|is gifting \d+|shared (?:their|an?) resub|subscribed at tier|months? in a row|continuing the gift sub|raided with \d+ viewers?)\b/i;
  return eventIds.has(messageId) || Boolean(systemMessage) || noticeText.test(body);
}

function nearDuplicate(value:string,accepted:string[]){
  const a=new Set(value.split(" ").filter(word=>word.length>2));
  if(a.size<3)return true;
  return accepted.some(other=>{
    if(Math.abs(other.length-value.length)>Math.max(12,value.length*.3))return false;
    const b=new Set(other.split(" ").filter(word=>word.length>2));let overlap=0;for(const word of a)if(b.has(word))overlap++;
    return overlap/Math.max(a.size,b.size)>=.82;
  });
}

function recognizability(body: string) {
  const words = normalize(body).split(" ").filter(Boolean);
  const uniqueRatio = new Set(words).size / Math.max(words.length, 1);
  const averageWordLength = words.reduce((sum, word) => sum + word.length, 0) / Math.max(words.length, 1);
  let score = words.length >= 6 && words.length <= 28 ? 2 : 1;
  if (words.length >= 10 && words.length <= 35) score += 1;
  if (uniqueRatio >= .72) score += 1;
  if (/[?!]/u.test(body)) score += 1;
  if (/[,;:—–]/u.test(body)) score += 1;
  if (averageWordLength >= 4.5 || words.some(word => word.length >= 10)) score += 1;
  if (/\p{N}/u.test(body) || /["“”'‘’()]/u.test(body)) score += 1;
  if (uniqueRatio < .5) score -= 2;
  const difficulty = score >= 7 ? "easy" : score >= 5 ? "medium" : "hard";
  return { quality: score, difficulty } as const;
}

function parse(raw: string) {
  const priv = raw.indexOf(" PRIVMSG ");
  const bodyAt = raw.indexOf(" :", priv + 9);
  if (priv < 0 || bodyAt < 0) return null;
  const tagText = raw.startsWith("@") ? raw.slice(1, raw.indexOf(" ")) : "";
  const tags = Object.fromEntries(tagText.split(";").filter(Boolean).map((tag) => {
    const at = tag.indexOf("=");
    return at < 0 ? [tag, ""] : [tag.slice(0, at), unescapeTag(tag.slice(at + 1))];
  }));
  const login = raw.slice(raw.indexOf(":") + 1, raw.indexOf("!"));
  const name = tags["display-name"] || login;
  const body = raw.slice(bodyAt + 2).trim().slice(0, 500);
  const normalized = normalize(body);
  if (!tags.id || !tags["user-id"] || !name || body.length < 18 || normalized.length < 10 || isKnownBot(login) || isKnownBot(name) || isTwitchEventNotice(body, tags) || isLowQuality(body,normalized,tags.emotes) || /https?:\/\//i.test(body)) return null;
  const badges = tags.badges || "";
  return { id: tags.id, userId: tags["user-id"], roomId: tags["room-id"] || "", name, body, normalized, emotes: parseTwitchEmotes(tags.emotes, body.length), sentAt: Number(tags["tmi-sent-ts"] || Date.now()), sub: /(?:^|,)subscriber\//.test(badges), vip: /(?:^|,)vip\//.test(badges), mod: /(?:^|,)moderator\//.test(badges) };
}

function parseHistorical(raw: HistoricalMessage) {
  const tags = raw.tags ?? {};
  const body = typeof raw.text === "string" ? raw.text.trim().slice(0, 500) : "";
  const name = typeof raw.displayName === "string" ? raw.displayName : typeof tags["display-name"] === "string" ? tags["display-name"] : "";
  const id = typeof raw.id === "string" ? raw.id : typeof tags.id === "string" ? tags.id : "";
  const userId = typeof tags["user-id"] === "string" ? tags["user-id"] : "";
  const normalized = normalize(body);
  const sentAt = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : Number(tags["tmi-sent-ts"] || 0);
  const badges = typeof tags.badges === "string" ? tags.badges : "";
  if (!id || !userId || !name || !Number.isFinite(sentAt) || body.length < 18 || normalized.length < 10 || isKnownBot(name) || isTwitchEventNotice(body, tags) || isLowQuality(body, normalized, typeof tags.emotes === "string" ? tags.emotes : "") || /https?:\/\//i.test(body)) return null;
  return { id, userId, roomId: typeof tags["room-id"] === "string" ? tags["room-id"] : "", name, body, normalized, emotes: parseTwitchEmotes(typeof tags.emotes === "string" ? tags.emotes : "", body.length), sentAt, sub: /(?:^|,)subscriber\//.test(badges), vip: /(?:^|,)vip\//.test(badges), mod: /(?:^|,)moderator\//.test(badges) };
}

function sampleEvenDates(dates: ArchiveDate[], maximum: number) {
  const sorted = [...dates].sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
  if (sorted.length <= maximum) return sorted;
  const earlier = sorted.slice(0, -1);
  const picked: ArchiveDate[] = [];
  for (let index = 0; index < maximum - 1; index++) {
    const start = Math.floor(index * earlier.length / (maximum - 1));
    const end = Math.max(start + 1, Math.floor((index + 1) * earlier.length / (maximum - 1)));
    const bucket = earlier.slice(start, end);
    picked.push(bucket[Math.floor(Math.random() * bucket.length)]);
  }
  return [...picked, sorted[sorted.length - 1]];
}

function dateKey(date: ArchiveDate) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day ?? "1").padStart(2, "0")}`;
}

function sampleDates(dates: ArchiveDate[], maximum: number) {
  const byMonth = new Map<string, ArchiveDate[]>();
  for (const date of dates) {
    const key = `${date.year}-${String(date.month).padStart(2, "0")}`;
    byMonth.set(key, [...(byMonth.get(key) ?? []), date]);
  }
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  const selected = months.length <= maximum ? months : Array.from({ length: maximum }, (_, index) => months[Math.round(index * (months.length - 1) / (maximum - 1))]);
  const newest = dates.reduce((latest, date) => {
    const key = `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day ?? "1").padStart(2, "0")}`;
    const latestKey = `${latest.year}-${String(latest.month).padStart(2, "0")}-${String(latest.day ?? "1").padStart(2, "0")}`;
    return key > latestKey ? date : latest;
  });
  return selected.map(([month, choices], index) => index === selected.length - 1 || month === `${newest.year}-${String(newest.month).padStart(2, "0")}` ? newest : choices[Math.floor(Math.random() * choices.length)]);
}

async function fetchHistorical(channel: string, cutoff: number, rangeDays: number | null) {
  const listResponse = await fetch(`${HISTORY_ORIGIN}/list?channel=${encodeURIComponent(channel)}`, { headers: { Accept: "application/json", "User-Agent": "KnowTheChat/1.0" }, signal: AbortSignal.timeout(12000) }).catch(() => null);
  if (!listResponse?.ok) return [];
  const list = await listResponse.json().catch(() => null) as { availableLogs?: unknown } | null;
  const available = Array.isArray(list?.availableLogs) ? list.availableLogs.filter((value): value is ArchiveDate => {
    if (!value || typeof value !== "object") return false;
    const date = value as Record<string, unknown>;
    if (typeof date.year !== "string" || typeof date.month !== "string" || (date.day !== null && date.day !== undefined && typeof date.day !== "string")) return false;
    return Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day ?? 1), 23, 59, 59) >= cutoff;
  }) : [];
  if (!available.length) return [];
  const maximum = rangeDays === null ? 8 : rangeDays <= 30 ? 4 : rangeDays <= 90 ? 5 : 6;
  const chosen = rangeDays !== null && rangeDays <= 90 ? sampleEvenDates(available, maximum) : sampleDates(available, maximum);
  const days = await Promise.all(chosen.map(async date => {
    const url = `${HISTORY_ORIGIN}/channel/${encodeURIComponent(channel)}/${date.year}/${date.month}${date.day ? `/${date.day}` : ""}?jsonBasic=1`;
    const dateKey = `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day ?? "1").padStart(2, "0")}`;
    const today = new Date().toISOString().slice(0, 10);
    const options: CachedRequestInit = { headers: { Accept: "application/json", "User-Agent": "KnowTheChat/1.0" }, signal: AbortSignal.timeout(14000), cf: { cacheEverything: true, cacheTtl: dateKey === today ? 300 : 86400 } };
    const response = await fetch(url, options).catch(() => null);
    if (!response?.ok || Number(response.headers.get("content-length") || 0) > 30_000_000) return [];
    const payload = await response.json().catch(() => null) as { messages?: unknown } | null;
    return Array.isArray(payload?.messages) ? payload.messages.slice(0, 25000).map(value => parseHistorical(value as HistoricalMessage)).filter((value): value is NonNullable<ReturnType<typeof parseHistorical>> => Boolean(value)) : [];
  }));
  return days.flat();
}

function addCatalogEntries(catalog: Map<string, string>, entries: unknown, provider: "7tv" | "bttv" | "ffz") {
  if (!Array.isArray(entries)) return;
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name : typeof entry.code === "string" ? entry.code : "";
    const id = typeof entry.id === "string" ? entry.id : typeof entry.id === "number" ? String(entry.id) : "";
    let url = "";
    if (provider === "7tv") {
      const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : {};
      const host = data.host && typeof data.host === "object" ? data.host as Record<string, unknown> : {};
      if (typeof host.url === "string") url = `${host.url.startsWith("//") ? "https:" : ""}${host.url}/4x.webp`;
    } else if (provider === "bttv" && id) url = `https://cdn.betterttv.net/emote/${id}/3x`;
    else if (provider === "ffz") {
      const urls = entry.urls && typeof entry.urls === "object" ? entry.urls as Record<string, unknown> : {};
      const candidate = urls["4"] ?? urls["2"] ?? urls["1"];
      if (typeof candidate === "string") url = `${candidate.startsWith("//") ? "https:" : ""}${candidate}`;
    }
    if (name && url && !catalog.has(name)) catalog.set(name, url);
  }
}

async function fetchThirdPartyEmotes(roomId: string) {
  const catalog = new Map<string, string>();
  if (!/^\d+$/.test(roomId)) return catalog;
  const getJson = async (url: string) => {
    const options: CachedRequestInit = { headers: { Accept: "application/json", "User-Agent": "KnowTheChat/1.0" }, signal: AbortSignal.timeout(5000), cf: { cacheEverything: true, cacheTtl: 3600 } };
    const response = await fetch(url, options).catch(() => null);
    return response?.ok ? response.json().catch(() => null) : null;
  };
  const [sevenApp, sevenLegacy, bttvChannel, bttvGlobal, ffzRoom, ffzGlobal] = await Promise.all([
    getJson(`https://api.7tv.app/v3/users/twitch/${roomId}`),
    getJson(`https://7tv.io/v3/users/twitch/${roomId}`),
    getJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`),
    getJson("https://api.betterttv.net/3/cached/emotes/global"),
    getJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`),
    getJson("https://api.frankerfacez.com/v1/set/global"),
  ]) as Array<Record<string, unknown> | null>;
  for (const seven of [sevenApp, sevenLegacy]) {
    const sevenSet = seven?.emote_set && typeof seven.emote_set === "object" ? seven.emote_set as Record<string, unknown> : {};
    addCatalogEntries(catalog, sevenSet.emotes, "7tv");
  }
  addCatalogEntries(catalog, bttvChannel?.channelEmotes, "bttv");
  addCatalogEntries(catalog, bttvChannel?.sharedEmotes, "bttv");
  addCatalogEntries(catalog, bttvGlobal, "bttv");
  for (const payload of [ffzRoom, ffzGlobal]) {
    const sets = payload?.sets && typeof payload.sets === "object" ? payload.sets as Record<string, unknown> : {};
    for (const set of Object.values(sets)) if (set && typeof set === "object") addCatalogEntries(catalog, (set as Record<string, unknown>).emoticons, "ffz");
  }
  return catalog;
}

function addThirdPartySpans(body: string, native: TwitchEmote[], catalog: Map<string, string>) {
  const spans = [...native];
  for (const match of body.matchAll(/\S+/gu)) {
    const raw = match[0];
    const start = match.index;
    const url = catalog.get(raw);
    if (!url || spans.some(span => start <= span.end && start + raw.length - 1 >= span.start)) continue;
    spans.push({ id: `third-party:${raw}`, start, end: start + raw.length - 1, url });
  }
  return spans.sort((a, b) => a.start - b.start);
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => ({})) as { channel?: unknown; rangeDays?: unknown; chatterPool?: unknown };
  const channel = typeof input.channel === "string" ? input.channel.trim().toLowerCase().replace(/^@/, "") : "";
  if (!/^[a-z0-9_]{3,25}$/.test(channel)) return Response.json({ error: "Enter a valid Twitch channel name." }, { status: 400 });
  const rangeDays=input.rangeDays==="all"?null:Math.min(3650,Math.max(1,Number(input.rangeDays)||365));
  const chatterPool=[25,50,100].includes(Number(input.chatterPool))?Number(input.chatterPool):50;

  const cutoff=rangeDays?Date.now()-rangeDays*86_400_000:0;
  const historical = await fetchHistorical(channel, cutoff, rangeDays);
  // A provider can technically return a historical archive that is far too
  // sparse to build a game. Supplement small samples with recent messages
  // instead of treating any non-empty historical result as sufficient.
  const results=historical.length >= MIN_HISTORICAL_MESSAGES ? [] : await Promise.all(PROVIDERS.map(async provider=>{
    const response=await fetch(`${provider}${encodeURIComponent(channel)}?limit=${MAX_MESSAGES}`,{headers:{Accept:"application/json","User-Agent":"KnowTheChat/1.0 public archive game"},signal:AbortSignal.timeout(12000)}).catch(()=>null);
    if(!response?.ok||Number(response.headers.get("content-length")||0)>5_000_000)return [];
    const payload=await response.json().catch(()=>null) as {messages?:unknown}|null;
    return Array.isArray(payload?.messages)?payload.messages:[];
  }));
  const rawMessages=results.flat();
  if(!rawMessages.length && !historical.length)return Response.json({error:"No public archive was found for that channel."},{status:404});

  const seenIds = new Set<string>();
  const seenText = new Set<string>();
  const acceptedText:string[]=[];
  const recentMessages = rawMessages.filter((x): x is string => typeof x === "string" && x.length <= 2000).map(parse).filter((m): m is NonNullable<ReturnType<typeof parse>> => Boolean(m));
  const parsedMessages = [...historical, ...recentMessages];
  const messages = parsedMessages.filter((m): m is NonNullable<typeof m> => {
    if (!m || m.sentAt<cutoff || seenIds.has(m.id) || seenText.has(m.normalized) || nearDuplicate(m.normalized,acceptedText)) return false;
    seenIds.add(m.id); seenText.add(m.normalized);acceptedText.push(m.normalized); return true;
  }).sort((a,b)=>a.sentAt-b.sentAt);

  const roomId = messages.find(message => message.roomId)?.roomId ?? "";
  const thirdPartyEmotes = await fetchThirdPartyEmotes(roomId);
  const archiveDays = new Set(messages.map(m => new Date(m.sentAt).toISOString().slice(0, 10)));
  const byUser = new Map<string, { id: string; name: string; messages: number; sub: boolean; vip: boolean; mod: boolean; days: Set<string>; months: Set<string>; totalWords: number }>();
  for (const m of messages) {
    const day = new Date(m.sentAt).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const wordCount = m.normalized.split(" ").filter(Boolean).length;
    const old = byUser.get(m.userId);
    if (old) { old.messages++; old.sub ||= m.sub; old.vip ||= m.vip; old.mod ||= m.mod; old.days.add(day); old.months.add(month); old.totalWords += wordCount; }
    else byUser.set(m.userId, { id: m.userId, name: m.name, messages: 1, sub: m.sub, vip: m.vip, mod: m.mod, days: new Set([day]), months: new Set([month]), totalWords: wordCount });
  }
  const minimumDays = archiveDays.size >= 3 ? 2 : 1;
  const ranked = [...byUser.values()].map((x) => ({ id: x.id, name: x.name, messages: x.messages, sub: x.sub, vip: x.vip, mod: x.mod, activeDays: x.days.size, activeMonths: x.months.size, avgWords: Math.round(x.totalWords / x.messages), score: x.messages + x.days.size * 4 + x.months.size * 6 + (x.sub ? 1 : 0) + (x.vip ? 5 : 0) + (x.mod ? 3 : 0) })).filter((x) => x.messages >= 3 && x.activeDays >= minimumDays).sort((a, b) => b.score - a.score).slice(0, chatterPool);
  const eligible = new Set(ranked.map((x) => x.id));
  const chatters = ranked.map((x) => ({ ...x, avatar: x.name.slice(0, 2).toUpperCase() }));
  const quotes = messages.filter((m) => eligible.has(m.userId)).map((m) => ({ ...m, ...recognizability(m.body) })).filter(m => m.quality >= 4).map((m) => ({ id: m.id, author: m.name, text: m.body, emotes: addThirdPartySpans(m.body, m.emotes, thirdPartyEmotes), sentAt: m.sentAt, quality: m.quality, difficulty: m.difficulty }));
  const dates = messages.map((m) => m.sentAt).filter(Number.isFinite);
  return Response.json({ channel, roomId, chatters, quotes, total: messages.length, range: dates.length ? { oldest: Math.min(...dates), newest: Math.max(...dates) } : null }, { headers: { "Cache-Control": "no-store" } });
}
