#!/usr/bin/env python3
"""Find the newest episode of every TV Facile programme and write data.json.

Sources, most reliable first:

1. YouTube Data API v3, when the YT_API_KEY secret is set. It gives original
   titles, exact dates, durations and live status.
2. The channels' public "En direct" and "Vidéos" tabs, read in French so that
   YouTube does not swap in auto-translated titles (it used to, and the
   French search patterns then silently stopped matching).

Every chosen video is re-checked through oEmbed on every run, so deleted,
private, renamed or non-embeddable videos are never handed to the player.

Usage:  python scripts/update_tv.py [--out data.json] [--no-api]
"""

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


CAMEROON = dt.timezone(dt.timedelta(hours=1))  # Africa/Douala, no DST
NOW = dt.datetime.now(dt.timezone.utc)
LOOKBACK = dt.timedelta(days=9)
HEARTBEAT = dt.timedelta(hours=6)
API_KEY = os.environ.get("YT_API_KEY", "").strip()

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


# ============================================================
# CHANNELS AND PROGRAMMES
#
# Patterns run on normalize(title): upper case, no accents, every
# non-alphanumeric character turned into a single space.
# minMinutes drops clips, trailers and broken stream starts.
# ============================================================

CHANNELS = {
    "equinoxe": {
        "section": "EQUINOXE TV",
        "name": "ÉQUINOXE TV",
        "handle": "@equinoxetv",
        "channelId": "UCXriNfPc0bkHIp0G9YTwYEw",
    },
    "canal2": {
        "section": "CANAL 2",
        "name": "Canal2 International",
        "handle": "@canal2internationalofficiel",
        "channelId": "UCli7mxfNrS0BBtlo5DwCt8Q",
    },
    "infotv": {
        "section": "INFO TV",
        "name": "Info TV Officiel",
        "handle": "@InfoTV_Cameroun",
        "channelId": "UCNngJARC3eIXpUwAXfCJO5A",
    },
    "vision4": {
        "section": "VISION 4",
        "name": "Vision 4",
        "handle": "@vision4_television_africaine",
        "channelId": "UCsn8TRCZtOQxfMlQKgH0biw",
    },
}

SHOWS = [
    {
        "id": "zenith1",
        "channel": "equinoxe",
        "label": "LE ZÉNITH 1",
        "spoken": "Le Zénith, première partie",
        "freq": "daily",
        "minMinutes": 10,
        "patterns": [r"\bZENITH\b.*\bPART(?:IE)?\s*1\b"],
        "exclude": [r"\bPART(?:IE)?\s*2\b"],
    },
    {
        "id": "zenith2",
        "channel": "equinoxe",
        "label": "LE ZÉNITH 2",
        "spoken": "Le Zénith, deuxième partie",
        "freq": "daily",
        "minMinutes": 5,
        "patterns": [r"\bZENITH\b.*\bPART(?:IE)?\s*2\b"],
        "exclude": [r"\bPART(?:IE)?\s*1\b"],
    },
    {
        "id": "grandesunes",
        "channel": "equinoxe",
        "label": "REVUE DES GRANDES UNES",
        "spoken": "La revue des grandes unes",
        "freq": "daily",
        "minMinutes": 10,
        "patterns": [r"\bGRANDES UNES\b"],
    },
    {
        "id": "journal20",
        "channel": "equinoxe",
        "label": "JOURNAL 20H",
        "spoken": "Le journal de 20 heures d'Équinoxe",
        "freq": "daily",
        "minMinutes": 15,
        # The real title is "JOURNAL 20H ET DÉBRIEF JOURNAL 20H DU ...",
        # so DEBRIEF must not be excluded here.
        "patterns": [r"\bJOURNAL\s+(?:DE\s+)?20H"],
        "exclude": [r"\bBILINGUE\b"],
    },
    {
        "id": "bilingue",
        "channel": "equinoxe",
        "label": "JOURNAL BILINGUE",
        "spoken": "Le journal bilingue",
        "freq": "daily",
        "minMinutes": 10,
        "patterns": [
            r"\bJTB\b",
            r"\bJOURNAL BILINGUE\b",
            r"\b20H BILINGUE\b",
        ],
    },
    {
        "id": "droitreponse",
        "channel": "equinoxe",
        "label": "DROIT DE RÉPONSE",
        "spoken": "Droit de réponse",
        "freq": "weekly",
        "minMinutes": 20,
        "patterns": [r"\bDROIT DE REPONSE\b"],
    },
    {
        "id": "equinoxsoir",
        "channel": "equinoxe",
        "label": "ÉQUINOXE SOIR",
        "spoken": "Équinoxe soir",
        "freq": "daily",
        "minMinutes": 15,
        "patterns": [r"\bEQUINOXE SOIR\b"],
    },
    {
        "id": "pidginnews",
        "channel": "equinoxe",
        "label": "PIDGIN NEWS",
        "spoken": "Pidgin News",
        "freq": "daily",
        "minMinutes": 10,
        "patterns": [r"\bPIDGIN NEWS\b"],
        "exclude": [r"\bDEBATE\b"],
    },
    {
        "id": "pidgindebate",
        "channel": "equinoxe",
        "label": "PIDGIN NEWS DEBATE",
        "spoken": "Pidgin News Debate",
        "freq": "weekly",
        "minMinutes": 15,
        "patterns": [r"\bPIDGIN\b.*\bDEBATE\b"],
    },
    {
        "id": "canal2journal",
        "channel": "canal2",
        "label": "JOURNAL CANAL 2",
        "spoken": "Le journal de Canal 2",
        # 19h50 on weekdays, 20h00 at the weekend.
        "freq": "daily",
        "minMinutes": 15,
        "patterns": [r"\bLE JOURNAL\s+(?:19H\s*50|20H(?:\s*00)?)\b"],
        "exclude": [r"\bBILINGUE\b", r"\bDEBRIEF\b"],
    },
    {
        "id": "canal2debrief",
        "channel": "canal2",
        "label": "DÉBRIEF CANAL 2",
        "spoken": "Le débrief de l'actu, Canal 2",
        "freq": "daily",
        "minMinutes": 20,
        "patterns": [r"\bDEBRIEF\b"],
    },
    {
        "id": "canalpress",
        "channel": "canal2",
        "label": "CANAL PRESSE",
        "spoken": "Canal Presse",
        "freq": "weekly",
        "minMinutes": 30,
        "patterns": [r"\bCANAL PRESSE\b"],
    },
    {
        "id": "infojournal",
        "channel": "infotv",
        "label": "LE JOURNAL",
        "spoken": "Le journal d'Info TV",
        # "LE 20H", "LE 20H BILINGUE", "LE 20H00 BILINGUE", "JT FR".
        "freq": "daily",
        "minMinutes": 15,
        "patterns": [r"^LE (?:19|20)H(?:00)?\b", r"^JT FR\b"],
    },
    {
        # Club d'Élites is a Vision 4 programme, not a Canal 2 one.
        "id": "clubelites",
        "channel": "vision4",
        "label": "CLUB D'ÉLITES",
        "spoken": "Club d'Élites, sur Vision 4",
        "freq": "weekly",
        "minMinutes": 30,
        "patterns": [r"\bCLUB D(?:ES)?\s*(?:L\s+)?ELITES?\b"],
    },
]


# ============================================================
# HELPERS
# ============================================================

def normalize(text):
    text = html.unescape(text or "")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^A-Z0-9]+", " ", text.upper())
    return text.strip()


def title_matches(show, title):
    value = normalize(title)
    if any(re.search(p, value) for p in show.get("exclude", [])):
        return False
    return any(re.search(p, value) for p in show["patterns"])


def iso(value):
    if not value:
        return ""
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value):
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def parse_clock(text):
    """'1:02:44' -> 3764 seconds."""
    match = re.fullmatch(r"\s*(\d+):(\d{2})(?::(\d{2}))?\s*", text or "")
    if not match:
        return None
    a, b, c = match.groups()
    if c is None:
        return int(a) * 60 + int(b)
    return int(a) * 3600 + int(b) * 60 + int(c)


def parse_iso_duration(text):
    """'PT1H2M44S' -> 3764 seconds."""
    match = re.fullmatch(
        r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", text or ""
    )
    if not match:
        return None
    d, h, m, s = (int(x or 0) for x in match.groups())
    return d * 86400 + h * 3600 + m * 60 + s


REL_UNITS = {
    "S": 1, "SEC": 1, "SECONDE": 1, "SECONDES": 1, "SECOND": 1, "SECONDS": 1,
    "MIN": 60, "MINUTE": 60, "MINUTES": 60,
    "H": 3600, "HEURE": 3600, "HEURES": 3600, "HOUR": 3600, "HOURS": 3600,
    "J": 86400, "JOUR": 86400, "JOURS": 86400,
    "D": 86400, "DAY": 86400, "DAYS": 86400,
    "SEM": 604800, "SEMAINE": 604800, "SEMAINES": 604800,
    "W": 604800, "WEEK": 604800, "WEEKS": 604800,
    "M": 2592000, "MOIS": 2592000, "MONTH": 2592000, "MONTHS": 2592000,
    "AN": 31536000, "ANS": 31536000, "Y": 31536000,
    "YEAR": 31536000, "YEARS": 31536000,
}


def relative_age(text):
    """'Diffusé il y a 5 h' / 'Streamed 5h ago' -> timedelta."""
    value = normalize(text)
    match = (
        re.search(r"\bIL Y A (\d+)\s*([A-Z]+)\b", value)
        or re.search(r"\b(\d+)\s*([A-Z]+) AGO\b", value)
    )
    if not match or match.group(2) not in REL_UNITS:
        return None
    return dt.timedelta(seconds=int(match.group(1)) * REL_UNITS[match.group(2)])


FR_MONTHS = {
    "JANVIER": 1, "FEVRIER": 2, "MARS": 3, "AVRIL": 4, "MAI": 5, "JUIN": 6,
    "JUILLET": 7, "AOUT": 8, "SEPTEMBRE": 9, "OCTOBRE": 10, "NOVEMBRE": 11,
    "DECEMBRE": 12,
}
EN_MONTHS = {
    "JANUARY": 1, "FEBRUARY": 2, "MARCH": 3, "APRIL": 4, "MAY": 5, "JUNE": 6,
    "JULY": 7, "AUGUST": 8, "SEPTEMBER": 9, "OCTOBER": 10, "NOVEMBER": 11,
    "DECEMBER": 12,
}
MONTHS = {**FR_MONTHS, **EN_MONTHS}
MONTH_RE = "|".join(MONTHS)
ORDINAL = r"(?:ER|ST|ND|RD|TH|RST)?"


def title_date(title, reference):
    """Episode date written in the title, e.g. 'DU LUNDI 05 OCTOBRE 2026',
    'OCTOBER 5TH 2026' or '05/10/2026'. Numeric dates are ambiguous
    (Canal 2 mixes dd/mm and mm/dd), so the reading closest to the
    upload date wins."""
    value = normalize(title)
    options = []

    def add(year, month, day):
        try:
            options.append(dt.date(int(year), int(month), int(day)))
        except ValueError:
            pass

    for d, m, y in re.findall(rf"\b(\d{{1,2}}){ORDINAL}\s+({MONTH_RE})\s+(20\d\d)\b", value):
        add(y, MONTHS[m], d)
    for m, d, y in re.findall(rf"\b({MONTH_RE})\s+(\d{{1,2}}){ORDINAL}\s+(20\d\d)\b", value):
        add(y, MONTHS[m], d)
    for a, b, y in re.findall(r"\b(\d{1,2})\s+(\d{1,2})\s+(20\d\d)\b", value):
        add(y, b, a)
        add(y, a, b)

    ref = (reference or NOW).astimezone(CAMEROON).date()
    options = [o for o in options if abs((o - ref).days) <= 10]
    if not options:
        return None
    return min(options, key=lambda o: (abs((o - ref).days), o > ref))


def walk(value, key):
    if isinstance(value, dict):
        if key in value:
            yield value[key]
        for child in value.values():
            yield from walk(child, key)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child, key)


def runs_text(value):
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("simpleText"), str):
        return value["simpleText"]
    return "".join(str(r.get("text") or "") for r in value.get("runs", []))


def valid_id(value):
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{11}", value or ""))


# ============================================================
# HTTP
# ============================================================

def http(url, data=None, headers=None, timeout=25):
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": UA,
            "Accept-Language": "fr-FR,fr;q=0.9",
            # Skips the EU cookie-consent interstitial.
            "Cookie": "SOCS=CAI; CONSENT=YES+1",
            **(headers or {}),
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def extract_json(page, marker):
    start = page.find(marker)
    if start < 0:
        return None
    start = page.find("{", start + len(marker))
    if start < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(page[start:])[0]
    except ValueError:
        return None


# ============================================================
# SOURCE 1: YOUTUBE DATA API
# ============================================================

def api_get(path, params):
    query = urllib.parse.urlencode({**params, "key": API_KEY})
    url = f"https://www.googleapis.com/youtube/v3/{path}?{query}"
    return json.loads(http(url, headers={"Accept": "application/json"}))


def api_channel(channel):
    uploads = "UU" + channel["channelId"][2:]
    ids = []
    token = None

    for _ in range(5):
        params = {"part": "contentDetails", "playlistId": uploads, "maxResults": 50}
        if token:
            params["pageToken"] = token
        page = api_get("playlistItems", params)
        oldest = None
        for item in page.get("items", []):
            details = item.get("contentDetails", {})
            if valid_id(details.get("videoId")):
                ids.append(details["videoId"])
            published = parse_iso(details.get("videoPublishedAt"))
            if published and (oldest is None or published < oldest):
                oldest = published
        token = page.get("nextPageToken")
        if not token or (oldest and oldest < NOW - LOOKBACK):
            break

    found = []
    for start in range(0, len(ids), 50):
        chunk = ids[start:start + 50]
        page = api_get(
            "videos",
            {
                "part": "snippet,contentDetails,status,liveStreamingDetails",
                "id": ",".join(chunk),
                "maxResults": 50,
            },
        )
        for video in page.get("items", []):
            snippet = video.get("snippet", {})
            status = video.get("status", {})
            live = video.get("liveStreamingDetails", {})
            found.append({
                "id": video["id"],
                "title": snippet.get("title", ""),
                "published": parse_iso(
                    live.get("actualStartTime") or snippet.get("publishedAt")
                ),
                "exact": True,
                "duration": parse_iso_duration(
                    video.get("contentDetails", {}).get("duration")
                ),
                "live": snippet.get("liveBroadcastContent", "none") == "live",
                "upcoming": snippet.get("liveBroadcastContent") == "upcoming",
                "embeddable": status.get("embeddable", True)
                and status.get("privacyStatus") in ("public", "unlisted"),
                "tab": "api",
                "order": 0,
            })
    return found


# ============================================================
# SOURCE 2: CHANNEL TABS (no key needed)
# ============================================================

def parse_lockup(item):
    video_id = item.get("contentId", "")
    if not valid_id(video_id):
        return None
    if item.get("contentType", "LOCKUP_CONTENT_TYPE_VIDEO") != "LOCKUP_CONTENT_TYPE_VIDEO":
        return None

    meta = item.get("metadata", {}).get("lockupMetadataViewModel", {})
    title = meta.get("title", {}).get("content", "")
    parts = [
        part.get("text", {}).get("content", "")
        for row in walk(meta, "metadataParts")
        for part in row
    ]

    duration = None
    live = False
    upcoming = False
    for badge in walk(item.get("contentImage", {}), "thumbnailBadgeViewModel"):
        text = badge.get("text", "")
        style = badge.get("badgeStyle", "")
        if "LIVE" in style or normalize(text) in ("EN DIRECT", "DIRECT", "LIVE"):
            live = True
        elif normalize(text) in ("A VENIR", "UPCOMING", "PREMIERE"):
            upcoming = True
        duration = parse_clock(text) or duration

    for part in parts:
        value = normalize(part)
        if re.search(r"\b(PREVU|PREVUE|PROGRAMME|SCHEDULED|PREMIERES?|EN ATTENTE)\b", value):
            upcoming = True
        if re.search(r"\b(EN DIRECT|REGARDE ACTUELLEMENT|WATCHING)\b", value):
            live = True

    age = next((a for a in map(relative_age, parts) if a is not None), None)
    return {
        "id": video_id,
        "title": title,
        "age": age,
        "duration": duration,
        "live": live,
        "upcoming": upcoming,
    }


def parse_video_renderer(item):
    video_id = item.get("videoId", "")
    if not valid_id(video_id):
        return None
    overlays = json.dumps(item.get("thumbnailOverlays", []))
    badges = json.dumps(item.get("badges", []))
    return {
        "id": video_id,
        "title": runs_text(item.get("title")),
        "age": relative_age(runs_text(item.get("publishedTimeText"))),
        "duration": parse_clock(runs_text(item.get("lengthText"))),
        "live": '"LIVE"' in overlays or "LIVE_NOW" in badges,
        "upcoming": "upcomingEventData" in item or '"UPCOMING"' in overlays,
    }


def collect_items(tree):
    """Video entries in page order, plus the continuation token."""
    items = []
    token = None

    def visit(value):
        nonlocal token
        if isinstance(value, dict):
            if "lockupViewModel" in value:
                entry = parse_lockup(value["lockupViewModel"])
                if entry:
                    items.append(entry)
                return
            if "videoRenderer" in value:
                entry = parse_video_renderer(value["videoRenderer"])
                if entry:
                    items.append(entry)
                return
            if "continuationItemRenderer" in value:
                for found in walk(value["continuationItemRenderer"], "token"):
                    token = found
                return
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(tree)
    return items, token


def selected_tab_content(data):
    for tab in walk(data, "tabRenderer"):
        if tab.get("selected"):
            return tab.get("content", {})
    return data.get("contents", {})


def scrape_tab(channel, tab, max_pages):
    url = f"https://www.youtube.com/{channel['handle']}/{tab}?hl=fr&gl=CM"
    page = http(url)

    data = extract_json(page, "var ytInitialData =") or extract_json(page, 'ytInitialData"] =')
    if not data:
        raise RuntimeError("no ytInitialData (bot check or consent page?)")

    channel_id = data.get("metadata", {}).get("channelMetadataRenderer", {}).get("externalId")
    if channel_id and channel_id != channel["channelId"]:
        raise RuntimeError(f"handle now points to {channel_id}, expected {channel['channelId']}")

    items, token = collect_items(selected_tab_content(data))

    # The page's own client context is what the browse endpoint accepts;
    # trimmed or edited contexts get "400 invalid argument".
    context = extract_json(page, '"INNERTUBE_CONTEXT":')

    for _ in range(max_pages - 1):
        ages = [i["age"] for i in items if i["age"] is not None]
        if not token or not context or (ages and max(ages) > LOOKBACK):
            break
        try:
            reply = json.loads(http(
                "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false",
                data=json.dumps({"context": context, "continuation": token}).encode(),
                headers={"Content-Type": "application/json"},
            ))
        except Exception as error:  # noqa: BLE001 - keep what we already have
            print(f"  continuation failed for {channel['handle']}/{tab}: {error}")
            break
        more, token = collect_items(reply.get("onResponseReceivedActions", reply))
        if not more:
            break
        items.extend(more)

    found = []
    for order, item in enumerate(items):
        found.append({
            **item,
            "published": NOW - item["age"] if item["age"] is not None else None,
            "exact": False,
            "embeddable": True,
            "tab": tab,
            "order": order,
        })
    return found


def scrape_channel(channel):
    found = []
    errors = []
    for tab, pages in (("streams", 4), ("videos", 2)):
        try:
            found.extend(scrape_tab(channel, tab, pages))
        except Exception as error:  # noqa: BLE001
            errors.append(f"{tab}: {error}")
    if errors:
        print(f"  {channel['name']} warnings: {'; '.join(errors)}")
    return found


# ============================================================
# VERIFICATION
# ============================================================

def oembed(video_id):
    """('ok', title) | ('gone', None) | ('blocked', None) | ('unknown', None)"""
    url = (
        "https://www.youtube.com/oembed?format=json&url="
        + urllib.parse.quote(f"https://www.youtube.com/watch?v={video_id}", safe="")
    )
    try:
        return "ok", json.loads(http(url, timeout=15)).get("title", "")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return "blocked", None
        if error.code in (400, 404):
            return "gone", None
        return "unknown", None
    except Exception:  # noqa: BLE001
        return "unknown", None


# ============================================================
# SELECTION
# ============================================================

def merge_candidates(candidates, known):
    """One entry per video id. Earlier sources win (API, then the live tab),
    and a date already stored in data.json beats a fresh approximation so
    that the file does not change on every run."""
    merged = {}
    for item in candidates:
        if item["id"] in merged:
            continue
        item = dict(item)
        old = known.get(item["id"])
        if old and not item["exact"]:
            old_date = parse_iso(old.get("publishedAt"))
            if old_date:
                item["published"] = old_date
        merged[item["id"]] = item
    return list(merged.values())


def episode_of(item):
    date = title_date(item["title"], item["published"])
    if date:
        return date
    if item["published"]:
        return item["published"].astimezone(CAMEROON).date()
    return None


def is_later(a, b):
    """True when segment a was broadcast after segment b."""
    if a["exact"] and b["exact"] and a["published"] and b["published"]:
        return a["published"] > b["published"]
    if a["tab"] == b["tab"]:
        return a["order"] < b["order"]  # tabs list newest first
    if a["published"] and b["published"]:
        return a["published"] > b["published"]
    return False


def chronological_key(item):
    if item["exact"] and item["published"]:
        return (0, item["published"].timestamp())
    return (1, -item["order"])


def episodes_for(show, candidates):
    """Newest episode first. Each episode is a list of parts: the longest
    upload plus any shorter segment broadcast after it (a stream that cut
    out and restarted). Shorter uploads made before it are false starts."""
    groups = {}
    for item in candidates:
        if item["live"] or item["upcoming"] or not item.get("embeddable", True):
            continue
        if not item["duration"] or item["duration"] < show["minMinutes"] * 60:
            continue
        if not title_matches(show, item["title"]):
            continue
        episode = episode_of(item)
        if episode and episode >= (NOW - LOOKBACK).astimezone(CAMEROON).date():
            groups.setdefault(episode, []).append(item)

    episodes = []
    for episode in sorted(groups, reverse=True):
        group = groups[episode]
        main = max(group, key=lambda i: (i["duration"], -i["order"]))
        parts = [main] + sorted(
            (
                i for i in group
                if i is not main
                and is_later(i, main)
                and 180 <= i["duration"] < main["duration"] * 0.9
            ),
            key=chronological_key,
        )
        episodes.append((episode, parts))
    return episodes


def show_entry(show, episode, parts, status):
    channel = CHANNELS[show["channel"]]
    first = parts[0]
    return {
        "id": show["id"],
        "section": channel["section"],
        "channel": show["channel"],
        "label": show["label"],
        "spoken": show["spoken"],
        "freq": show["freq"],
        "found": True,
        "status": status,
        "videoId": first["videoId"],
        "thumbnail": f"https://i.ytimg.com/vi/{first['videoId']}/hqdefault.jpg",
        "embedUrl": f"https://www.youtube-nocookie.com/embed/{first['videoId']}?rel=0&playsinline=1",
        "watchUrl": f"https://www.youtube.com/watch?v={first['videoId']}",
        "videoTitle": first["title"],
        "publishedAt": first["publishedAt"],
        "episodeDate": episode,
        "durationSec": sum(p["durationSec"] or 0 for p in parts),
        "parts": parts,
    }


def missing_entry(show):
    channel = CHANNELS[show["channel"]]
    return {
        "id": show["id"],
        "section": channel["section"],
        "channel": show["channel"],
        "label": show["label"],
        "spoken": show["spoken"],
        "freq": show["freq"],
        "found": False,
        "status": "missing",
        "videoId": "",
        "thumbnail": "",
        "embedUrl": "",
        "watchUrl": "",
        "videoTitle": "",
        "publishedAt": "",
        "episodeDate": "",
        "durationSec": 0,
        "parts": [],
    }


def verify_parts(show, parts, cache):
    """Drop parts YouTube no longer serves, or that were renamed into a
    different programme. Returns None when the main part is unusable."""
    kept = []
    for index, part in enumerate(parts):
        video_id = part["videoId"]
        if video_id not in cache:
            cache[video_id] = oembed(video_id)
        state, title = cache[video_id]
        if state == "ok" and not title_matches(show, title):
            state = "renamed"
        if state in ("gone", "blocked", "renamed"):
            print(f"  drop {video_id} ({state}) for {show['label']}")
            if index == 0:
                return None
            continue
        if title:
            part = {**part, "title": title}
        kept.append(part)
    return kept


# ============================================================
# MAIN
# ============================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="data.json")
    parser.add_argument("--no-api", action="store_true")
    args = parser.parse_args()

    try:
        with open(args.out, encoding="utf-8") as file:
            previous = json.load(file)
    except (OSError, ValueError):
        previous = {"shows": []}

    previous_by_id = {s.get("id"): s for s in previous.get("shows", [])}
    known = {
        part.get("videoId"): part
        for show in previous.get("shows", [])
        for part in show.get("parts") or []
    }

    use_api = bool(API_KEY) and not args.no_api
    candidates = {}
    for key, channel in CHANNELS.items():
        items = []
        if use_api:
            try:
                items = api_channel(channel)
            except Exception as error:  # noqa: BLE001
                print(f"  API failed for {channel['name']}: {error}; using the channel pages")
        if not items:
            items = scrape_channel(channel)
        candidates[key] = merge_candidates(items, known)
        print(f"{channel['name']}: {len(candidates[key])} videos")

    oembed_cache = {}
    shows = []
    for show in SHOWS:
        entry = None
        for episode, parts in episodes_for(show, candidates[show["channel"]]):
            parts = [
                {
                    "videoId": p["id"],
                    "title": p["title"],
                    "durationSec": p["duration"],
                    "publishedAt": iso(p["published"]),
                }
                for p in parts
            ]
            parts = verify_parts(show, parts, oembed_cache)
            if parts:
                entry = show_entry(show, episode.isoformat(), parts, "found")
                break

        if entry is None:
            old = previous_by_id.get(show["id"]) or {}
            old_parts = old.get("parts") or []
            if old.get("found") and old_parts:
                parts = verify_parts(show, old_parts, oembed_cache)
                if parts:
                    entry = show_entry(show, old.get("episodeDate", ""), parts, "preserved")

        shows.append(entry or missing_entry(show))

    print()
    for s in shows:
        ids = "+".join(p["videoId"] for p in s["parts"]) or "-"
        print(f"{s['status']:9} | {s['label']:24} | {s['episodeDate'] or '-':10} | {ids:24} | {s['videoTitle']}")

    found = sum(1 for s in shows if s["found"])
    print(f"\nTV FACILE: {found}/{len(shows)} programmes found")

    checked = parse_iso(previous.get("checkedAt") or previous.get("generatedAt"))
    if shows == previous.get("shows") and checked and NOW - checked < HEARTBEAT:
        print("No change; data.json left untouched.")
        return 0 if found >= len(shows) // 2 else 1

    output = {
        "version": 2,
        "generatedAt": iso(NOW) if shows != previous.get("shows") else previous.get("generatedAt", iso(NOW)),
        "checkedAt": iso(NOW),
        "source": "api" if use_api else "pages",
        "channels": {
            c["section"]: {"name": c["name"], "handle": c["handle"], "channelId": c["channelId"]}
            for c in CHANNELS.values()
        },
        "shows": shows,
    }
    with open(args.out, "w", encoding="utf-8") as file:
        json.dump(output, file, ensure_ascii=False, indent=2)
        file.write("\n")

    # Fail the run (GitHub then e-mails the owner) only when most programmes
    # are gone at once, which means YouTube changed something.
    return 0 if found >= len(shows) // 2 else 1


if __name__ == "__main__":
    sys.exit(main())
