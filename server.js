import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("."));

const PORT = process.env.PORT || 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  return cleaned ? Number(cleaned) : null;
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getStatus(diffPct) {
  if (diffPct >= 25) return "EXTREMELY HIGH";
  if (diffPct >= 15) return "TOO HIGH";
  if (diffPct > 5) return "HIGH";
  if (diffPct >= -5) return "AVERAGE";
  if (diffPct >= -10) return "LOW";
  if (diffPct >= -25) return "TOO LOW";
  return "EXTREMELY LOW";
}

function getAction(diffPct) {
  if (diffPct > -5 && diffPct < 5) return { action: "STAY", changePct: 0 };
  if (diffPct <= -5 && diffPct > -15) return { action: "RAISE", changePct: 5 };
  if (diffPct <= -15 && diffPct > -30) return { action: "RAISE", changePct: 12 };
  if (diffPct <= -30) return { action: "RAISE", changePct: 18 };
  if (diffPct >= 5 && diffPct < 15) return { action: "LOWER", changePct: 6 };
  if (diffPct >= 15 && diffPct < 30) return { action: "LOWER", changePct: 12 };
  return { action: "LOWER", changePct: 18 };
}

async function extractStructuredJson(page) {
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  for (const s of scripts) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        const lodging = parsed.find(
          x => x["@type"] === "LodgingBusiness" || x["@type"] === "Apartment"
        );
        if (lodging) return lodging;
      } else if (
        parsed &&
        (parsed["@type"] === "LodgingBusiness" || parsed["@type"] === "Apartment")
      ) {
        return parsed;
      }
    } catch {}
  }
  return null;
}

async function extractLatLng(page) {
  const content = await page.content();

  const patterns = [
    /"lat":([0-9.\-]+),"lng":([0-9.\-]+)/,
    /"latitude":([0-9.\-]+),"longitude":([0-9.\-]+)/,
    /latitude["']?\s*:\s*([0-9.\-]+)[^0-9\-]+longitude["']?\s*:\s*([0-9.\-]+)/i
  ];

  for (const p of patterns) {
    const m = content.match(p);
    if (m) {
      return { lat: Number(m[1]), lng: Number(m[2]) };
    }
  }
  return null;
}

async function extractListingBasics(page, listingUrl) {
  await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);

  const title =
    (await page.locator("h1").first().textContent().catch(() => null))?.trim() || "Listing";

  const bodyText = await page.locator("body").textContent().catch(() => "");
  const ldJson = await extractStructuredJson(page);
  const latLng = await extractLatLng(page);

  const image =
    (Array.isArray(ldJson?.image) ? ldJson.image[0] : ldJson?.image) ||
    (await page.locator("img").first().getAttribute("src").catch(() => ""));

  const compact = bodyText.replace(/\s+/g, " ");

  const bedMatch = compact.match(/([0-9]+)\s+bedrooms?/i);
  const bedsMatch = compact.match(/([0-9]+)\s+beds?/i);
  const bathMatch = compact.match(/([0-9]+(?:\.[0-9]+)?)\s+baths?/i);
  const guestMatch = compact.match(/([0-9]+)\s+guests?/i);

  const hasPool = /pool/i.test(compact);
  const selfCheckIn = /self check-?in/i.test(compact);
  const beachType = /oceanfront/i.test(compact)
    ? "Oceanfront"
    : /beach/i.test(compact)
    ? "Near beach"
    : "";

  return {
    title,
    listingUrl,
    image: image || "",
    lat: latLng?.lat || null,
    lng: latLng?.lng || null,
    bedrooms: bedMatch ? Number(bedMatch[1]) : null,
    beds: bedsMatch ? Number(bedsMatch[1]) : null,
    baths: bathMatch ? Number(bathMatch[1]) : null,
    guests: guestMatch ? Number(guestMatch[1]) : null,
    pool: hasPool,
    selfCheckIn,
    beachType
  };
}

async function searchAirbnbComps(page, subject, checkIn, checkOut, radiusMiles = 0.5) {
  if (!subject.lat || !subject.lng) return [];

  const neLat = subject.lat + 0.015;
  const neLng = subject.lng + 0.015;
  const swLat = subject.lat - 0.015;
  const swLng = subject.lng - 0.015;

  const searchUrl =
    `https://www.airbnb.com/s/homes?checkin=${checkIn}` +
    `&checkout=${checkOut}` +
    `&adults=1` +
    `&ne_lat=${neLat}` +
    `&ne_lng=${neLng}` +
    `&sw_lat=${swLat}` +
    `&sw_lng=${swLng}` +
    `&search_by_map=true`;

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(5000);

  const cards = await page.locator('a[href*="/rooms/"]').evaluateAll(els => {
    const seen = new Set();
    return els
      .map(a => {
        const href = a.href;
        if (!href || seen.has(href)) return null;
        seen.add(href);
        const text = (a.innerText || "").replace(/\s+/g, " ").trim();
        return { href, text };
      })
      .filter(Boolean)
      .slice(0, 30);
  });

  const comps = [];
  for (const card of cards) {
    const roomIdMatch = card.href.match(/\/rooms\/(\d+)/);
    if (!roomIdMatch) continue;

    const text = card.text || "";
    const priceMatch = text.match(/\$([0-9,]+)/);
    const ratingMatch = text.match(/([0-9]\.[0-9]{1,2})/);
    const reviewMatch = text.match(/\(([0-9,]+)\)/);

    comps.push({
      id: roomIdMatch[1],
      title: text.split("$")[0]?.trim() || "Comp Listing",
      listingUrl: card.href.split("?")[0],
      nightlyRate: toNumber(priceMatch?.[1]) || null,
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      reviews: reviewMatch ? Number(reviewMatch[1].replace(/,/g, "")) : null
    });
  }

  const detailed = [];
  for (const comp of comps.slice(0, 12)) {
    try {
      const p = await page.context().newPage();
      const details = await extractListingBasics(p, comp.listingUrl);
      await p.close();

      if (!details.lat || !details.lng) continue;

      const miles = distanceMiles(subject.lat, subject.lng, details.lat, details.lng);
      if (miles > radiusMiles) continue;

      const bedroomOk =
        !subject.bedrooms ||
        !details.bedrooms ||
        details.bedrooms === subject.bedrooms;

      if (!bedroomOk) continue;

      detailed.push({
        ...comp,
        ...details,
        distance: Number(miles.toFixed(2))
      });

      await sleep(1000);
    } catch {}
  }

  return detailed.sort((a, b) => a.distance - b.distance);
}

async function getNightlyCompSnapshot(listingUrl, month) {
  const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });

  const page = await context.newPage();

  try {
    const subject = await extractListingBasics(page, listingUrl);

    if (!subject.lat || !subject.lng) {
      throw new Error("Could not extract listing location");
    }

    const [year, mon] = month.split("-").map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();

    const compsSeed = await searchAirbnbComps(
      page,
      { ...subject, listingUrl },
      `${month}-01`,
      `${month}-02`,
      0.5
    );

    const comps = compsSeed.slice(0, 6);

    const dates = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const checkIn = `${month}-${String(day).padStart(2, "0")}`;
      const nextDate = new Date(year, mon - 1, day + 1);
      const checkOut = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`;

      const compRates = comps.map(c => c.nightlyRate).filter(Boolean);
      const yourRate = null;
      const compAvg = compRates.length ? average(compRates) : 0;
      const diffPct = yourRate && compAvg ? ((yourRate - compAvg) / compAvg) * 100 : 0;

      dates.push({
        date: checkIn,
        label: new Date(year, mon - 1, day).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric"
        }),
        event: "",
        yourRate,
        compRates,
        compLow: compRates.length ? Math.min(...compRates) : null,
        compAvg: compRates.length ? Math.round(compAvg) : null,
        compHigh: compRates.length ? Math.max(...compRates) : null,
        diffPct: Number(diffPct.toFixed(1)),
        status: getStatus(diffPct),
        action: getAction(diffPct)
      });

      void checkOut;
    }

    return {
      property: {
        ...subject,
        listingUrl
      },
      month,
      dates,
      comps: comps.map(c => ({
        id: c.id,
        title: c.title,
        listingUrl: c.listingUrl,
        image: c.image || "",
        lat: c.lat,
        lng: c.lng,
        bedrooms: c.bedrooms,
        baths: c.baths,
        guests: c.guests,
        pool: c.pool,
        selfCheckIn: c.selfCheckIn,
        beachType: c.beachType,
        rating: c.rating,
        reviews: c.reviews,
        distance: c.distance,
        nightlyRate: c.nightlyRate
      }))
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

app.get("/api/scan", async (req, res) => {
  try {
    const { url, month } = req.query;

    if (!url || !month) {
      return res.status(400).json({ error: "Missing url or month" });
    }

    const data = await getNightlyCompSnapshot(url, month);
    res.json(data);
  } catch (err) {
    res.status(500).json({
      error: err.message || "Scan failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
