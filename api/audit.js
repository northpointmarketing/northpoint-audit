const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const { Resend } = require("resend");
const PDFDocument = require("pdfkit");

// ── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "rich@audit.northpointmktg.com";
const FROM_NAME = process.env.FROM_NAME || "Northpoint Marketing";

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior B2B digital marketing consultant at Northpoint Marketing. Your agency positioning is "Turning Search into Pipeline for B2B Companies."

You are analyzing a B2B company's homepage. Produce a structured website audit with specific, expert-level findings — not generic checklist items.

TARGET READER: Marketing leaders, CMOs, and revenue leaders at B2B companies. They care about pipeline and revenue, not vanity metrics.

TONE: Direct, analytical, confident. Sound like a consultant who has audited hundreds of B2B sites. No fluff, no buzzwords, no filler phrases like "it's important to" or "you should consider."

You will receive: PageSpeed data (mobile + desktop), scraped homepage content, robots.txt, and sitemap.xml. Some data may be missing — work with what you have.

Return ONLY valid JSON — no markdown, no preamble, no text outside the JSON object:

{
  "company_name": "inferred from the page",
  "url": "the URL audited",
  "executive_summary": "2-3 sentences. The most important thing they need to hear. Frame around pipeline impact. Be direct.",
  "service_recommendation": {
    "primary_service": "B2B Paid Search or SEO & Technical or Full Search-to-Pipeline Program",
    "rationale": "2-3 sentences. Why this service fits their biggest gap. Reference specific findings. Sound like a consultant, not a salesperson.",
    "secondary_service": "the complementary service, or null if not applicable",
    "secondary_rationale": "1-2 sentences on why it complements the primary, or null"
  },
  "sections": [
    {
      "section": "Technical Performance",
      "findings": [
        {
          "priority": "HIGH or MEDIUM or LOW",
          "title": "Specific title — include actual numbers where available",
          "what": "What you found. Use real numbers from the data. 2-3 sentences max.",
          "why": "Why this matters in business terms — rankings, paid CPCs, buyer trust, pipeline. 2 sentences.",
          "next_step": "One concrete action. Specific, not vague."
        }
      ]
    }
  ]
}

Sections to include in this order:
1. Technical Performance — PageSpeed scores, Core Web Vitals, specific issues flagged
2. SEO Fundamentals — title tag length, meta description, H1 structure, schema markup, sitemap/robots status
3. Conversion & UX — CTA quality, mid-funnel options, value prop placement, trust signals visible on homepage
4. Messaging & Positioning — quote their actual H1 and CTA text. Does it speak to a B2B buyer with a complex purchase decision?
5. Paid Search Readiness — could this homepage support a Google Ads campaign today? What is the biggest gap?

RULES:
- 2-3 findings per section max. Quality over quantity.
- In messaging findings, quote their actual headline and CTA text from the scraped content.
- Mobile PageSpeed score matters more than desktop for Google rankings — say so when the gap is significant.
- If a technical element looks good, note it briefly as LOW — do not skip it or invent a problem.
- Never score anything out of 100 except the raw PageSpeed numbers.
- If data is missing for a section, note it in one finding and move on — do not skip the section entirely.

SERVICE RECOMMENDATION LOGIC:
- Mobile PageSpeed below 50 OR Core Web Vitals failing → primary is "SEO & Technical" — paid search wastes budget until the foundation is fixed
- Mobile PageSpeed 50-75 AND weak CTAs or no landing pages → primary is "B2B Paid Search" — note landing pages need work before launch
- Mobile PageSpeed above 75 AND weak conversion paths → primary is "B2B Paid Search" — technically ready, funnel needs building
- Messaging is the dominant gap → primary is "SEO & Technical" — positioning and content before paid
- Multiple HIGH findings across technical AND paid readiness → primary is "Full Search-to-Pipeline Program"
- Always reference 1-2 specific audit findings in the rationale — never generic
- secondary_service is always the complementary one — if primary is paid search, secondary is SEO & Technical and vice versa
- If primary is Full Search-to-Pipeline Program, set secondary_service to null`;

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  let u = raw.trim();
  if (!u.startsWith("http")) u = "https://" + u;
  try {
    const parsed = new URL(u);
    let url = parsed.origin + parsed.pathname;
    if (url.endsWith("/") && parsed.pathname !== "/") {
      url = url.slice(0, -1);
    }
    return url;
  } catch (e) {
    return u;
  }
}

function getOrigin(url) {
  try { return new URL(url).origin; } catch (e) { return url; }
}

async function getPageSpeed(url, strategy) {
  try {
    const key = process.env.PAGESPEED_API_KEY ? `&key=${process.env.PAGESPEED_API_KEY}` : "";
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance${key}`;
    const { data } = await axios.get(api, { timeout: 35000 });
    const cats = data.lighthouseResult?.categories;
    const aud = data.lighthouseResult?.audits;
    if (!cats) return null;
    return {
      score: Math.round((cats.performance?.score || 0) * 100),
      lcp: aud?.["largest-contentful-paint"]?.displayValue || "N/A",
      cls: aud?.["cumulative-layout-shift"]?.displayValue || "N/A",
      tbt: aud?.["total-blocking-time"]?.displayValue || "N/A",
      fcp: aud?.["first-contentful-paint"]?.displayValue || "N/A",
      ttfb: aud?.["server-response-time"]?.displayValue || "N/A",
      opportunities: Object.values(aud || {})
        .filter((a) => a.details?.type === "opportunity" && a.score != null && a.score < 0.9)
        .slice(0, 5)
        .map((a) => ({ title: a.title, savings: a.displayValue || "" })),
    };
  } catch (e) { return null; }
}

async function scrapeHTML(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 12000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NorthpointAudit/1.0; +https://northpointmktg.com)" },
    });
    const $ = cheerio.load(html);
    const allText = (sel) => $(sel).map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const ctaRx = /contact|demo|consult|call us|get started|learn more|schedule|book|request|quote|free trial|talk to/i;
    const allAnchors = $("a").map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const imgs = $("img").get();
    const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 2500);
    return {
      title: $("title").text().trim(),
      meta_description: $('meta[name="description"]').attr("content") || "",
      h1s: allText("h1").slice(0, 3),
      h2s: allText("h2").slice(0, 6),
      h3s: allText("h3").slice(0, 5),
      cta_texts: [...new Set(allAnchors.filter((t) => ctaRx.test(t)))].slice(0, 8),
      nav_links: allText("nav a, header a").slice(0, 10),
      body_preview: bodyText,
      word_count: bodyText.split(/\s+/).length,
      images_missing_alt: imgs.filter((i) => !$(i).attr("alt")).length,
      total_images: imgs.length,
      has_schema: html.includes("application/ld+json") || html.includes("schema.org"),
      has_open_graph: !!$('meta[property="og:title"]').attr("content"),
      https: url.startsWith("https"),
    };
  } catch (e) { return null; }
}

async function fetchText(url) {
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    return typeof data === "string" ? data.slice(0, 1200) : JSON.stringify(data).slice(0, 1200);
  } catch (e) { return null; }
}

async function callClaude(rawData) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Audit this website and return findings as JSON:\n\n${JSON.stringify(rawData, null, 2)}` }],
  });
  const text = msg.content[0]?.text || "";
  const match = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude did not return valid JSON");
  return JSON.parse(match[0]);
}

// ── Section grade helper ──────────────────────────────────────────────────────
function sectionGrade(findings) {
  if (!findings || findings.length === 0) return "needs_work";
  const priorities = findings.map((f) => (f.priority || "LOW").toUpperCase());
  if (priorities.includes("HIGH")) return "critical";
  if (priorities.includes("MEDIUM")) return "needs_work";
  return "strong";
}

// ── PDF Generation ────────────────────────────────────────────────────────────
function generatePDF(auditData, rawData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 0, autoFirstPage: false });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PW = 612;
    const PH = 792;
    const ML = 54;
    const MR = 54;
    const W = PW - ML - MR;
    const CONTENT_TOP = 54;
    const CONTENT_BOTTOM = 738;

    // Colors
    const NAVY    = "#1F2A37";
    const SLATE   = "#1E3A5F";
    const ACCENT  = "#3B82C4";
    const MID     = "#8A9199";
    const LIGHT   = "#F5F5F5";
    const BORDER  = "#E2E8F0";
    const HIGH_C  = "#DC2626";
    const MED_C   = "#D97706";
    const LOW_C   = "#16A34A";
    const HIGH_BG = "#FFF1F1";
    const MED_BG  = "#FFFBEB";
    const LOW_BG  = "#F0FDF4";

    const mobile  = rawData.mobile_pagespeed;
    const desktop = rawData.desktop_pagespeed;

    // ── Page chrome ──
    let pageNum = 0;
    function addPageChrome() {
      pageNum++;
      // Header
      doc.rect(0, 0, PW, 36).fill(NAVY);
      doc.fillColor("white").font("Helvetica-Bold").fontSize(8)
        .text("NORTHPOINT MARKETING", ML, 14);
      doc.fillColor("#8A9199").font("Helvetica").fontSize(8)
        .text(`Website Audit — ${auditData.company_name || ""}`, ML, 14, { align: "right", width: W });
      // Footer
      doc.rect(0, PH - 30, PW, 30).fill("#F1F5F9");
      doc.fillColor(MID).font("Helvetica").fontSize(7.5)
        .text("Confidential | Northpoint Marketing | northpointmktg.com", ML, PH - 18);
      doc.fillColor(MID).font("Helvetica").fontSize(7.5)
        .text(`Page ${pageNum}`, ML, PH - 18, { align: "right", width: W });
    }

    function newInnerPage() {
      doc.addPage({ size: "letter", margin: 0 });
      addPageChrome();
      return CONTENT_TOP;
    }

    function checkPageBreak(y, neededHeight) {
      if (y + neededHeight > CONTENT_BOTTOM) {
        return newInnerPage();
      }
      return y;
    }

    // ── COVER PAGE ──
    doc.addPage({ size: "letter", margin: 0 });
    doc.rect(0, 0, PW, PH).fill(NAVY);
    doc.rect(0, 0, PW, 5).fill(ACCENT);
    doc.rect(0, PH - 5, PW, 5).fill(ACCENT);

    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(9)
      .text("NORTHPOINT MARKETING", ML, 130, { align: "center", width: W });
    doc.fillColor("white").font("Helvetica-Bold").fontSize(30)
      .text("Website Performance\nAudit Report", ML, 168, { align: "center", width: W, lineGap: 8 });
    doc.rect(ML, 252, W, 1).fill(ACCENT);
    doc.fillColor("#94A3B8").font("Helvetica").fontSize(10)
      .text("Prepared for:", ML, 272, { align: "center", width: W });
    doc.fillColor("white").font("Helvetica-Bold").fontSize(16)
      .text(auditData.company_name || "Your Company", ML, 292, { align: "center", width: W });
    doc.fillColor(ACCENT).font("Helvetica").fontSize(11)
      .text(auditData.url || "", ML, 316, { align: "center", width: W });
    const dateStr = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
    doc.fillColor("#8A9199").font("Helvetica").fontSize(9)
      .text(`${dateStr}  ·  Confidential`, ML, 690, { align: "center", width: W });
    doc.fillColor("#475569").font("Helvetica-Oblique").fontSize(10)
      .text("Turning Search into Pipeline for B2B Companies.", ML, 710, { align: "center", width: W });

    // ── EXECUTIVE SUMMARY PAGE ──
    let y = newInnerPage();

    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(8).text("OVERVIEW", ML, y);
    y += 16;
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(20).text("Executive Summary", ML, y);
    y += 26;
    doc.rect(ML, y, W, 2).fill(ACCENT);
    y += 14;

    // PageSpeed metric boxes
    const metrics = [
      { label: "Mobile Score", val: mobile ? mobile.score + "/100" : "N/A", color: mobile ? (mobile.score >= 90 ? LOW_C : mobile.score >= 50 ? MED_C : HIGH_C) : MID },
      { label: "Desktop Score", val: desktop ? desktop.score + "/100" : "N/A", color: desktop ? (desktop.score >= 90 ? LOW_C : desktop.score >= 50 ? MED_C : HIGH_C) : MID },
      { label: "Mobile LCP", val: mobile?.lcp || "N/A", color: NAVY },
      { label: "Mobile CLS", val: mobile?.cls || "N/A", color: NAVY },
    ];
    const boxW = (W - 12) / 4;
    metrics.forEach((m, i) => {
      const bx = ML + i * (boxW + 4);
      doc.rect(bx, y, boxW, 54).fill(LIGHT);
      doc.rect(bx, y, boxW, 54).stroke(BORDER);
      doc.fillColor(m.color).font("Helvetica-Bold").fontSize(17)
        .text(m.val, bx, y + 10, { width: boxW, align: "center" });
      doc.fillColor(MID).font("Helvetica").fontSize(8)
        .text(m.label, bx, y + 34, { width: boxW, align: "center" });
    });
    y += 66;

    // Section scorecard
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Audit Scorecard", ML, y);
    y += 14;

    const gradeConfig = {
      critical:   { label: "Critical",    bg: HIGH_BG, color: HIGH_C, bar: HIGH_C },
      needs_work: { label: "Needs Work",  bg: MED_BG,  color: MED_C,  bar: MED_C },
      strong:     { label: "Strong",      bg: LOW_BG,  color: LOW_C,  bar: LOW_C },
    };

    const sectionNames = [
      "Technical Performance",
      "SEO Fundamentals",
      "Conversion & UX",
      "Messaging & Positioning",
      "Paid Search Readiness",
    ];

    sectionNames.forEach((name) => {
      const sec = (auditData.sections || []).find((s) => s.section === name);
      const grade = sectionGrade(sec?.findings);
      const cfg = gradeConfig[grade];
      const rowH = 26;

      doc.rect(ML, y, W, rowH).fill(cfg.bg);
      doc.rect(ML, y, 3, rowH).fill(cfg.bar);
      doc.fillColor(NAVY).font("Helvetica").fontSize(10)
        .text(name, ML + 12, y + 8);
      // Badge
      const badgeW = 80;
      const badgeX = ML + W - badgeW;
      doc.rect(badgeX, y + 5, badgeW, 16).fill(cfg.color);
      doc.fillColor("white").font("Helvetica-Bold").fontSize(8)
        .text(cfg.label.toUpperCase(), badgeX, y + 9, { width: badgeW, align: "center" });
      y += rowH + 3;
    });
    y += 10;

    // Executive summary text
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Key Takeaway", ML, y);
    y += 12;
    doc.rect(ML, y, 3, 80).fill(ACCENT);
    const summaryH = doc.heightOfString(auditData.executive_summary || "", { width: W - 12, fontSize: 11 });
    doc.fillColor(SLATE).font("Helvetica").fontSize(11)
      .text(auditData.executive_summary || "", ML + 10, y, { width: W - 12, lineGap: 4 });
    y += summaryH + 20;

    // ── FINDINGS PAGES ──
    const priorityColors = { HIGH: HIGH_C, MEDIUM: MED_C, LOW: LOW_C };
    const priorityBg     = { HIGH: HIGH_BG, MEDIUM: MED_BG, LOW: LOW_BG };

    (auditData.sections || []).forEach((sec) => {
      // Section header — always starts on new page
      y = newInnerPage();

      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(8).text("SECTION", ML, y);
      y += 14;
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(18).text(sec.section, ML, y);
      y += 24;
      doc.rect(ML, y, W, 1.5).fill(ACCENT);
      y += 12;

      (sec.findings || []).forEach((f) => {
        const p = (f.priority || "LOW").toUpperCase();
        const pColor = priorityColors[p] || MID;
        const pBg    = priorityBg[p] || LIGHT;

        // Measure card height accurately
        doc.fontSize(10);
        const whatH = doc.heightOfString(f.what || "", { width: W - 24 });
        const whyH  = doc.heightOfString(f.why  || "", { width: W - 24 });
        const nextH = doc.heightOfString("→ " + (f.next_step || ""), { width: W - 24 });
        const titleH = doc.heightOfString(f.title || "", { width: W - 100, fontSize: 11 });
        const cardH = 16 + Math.max(titleH, 14) + 14 + 10 + whatH + 14 + whyH + 14 + nextH + 16;

        y = checkPageBreak(y, cardH + 10);

        // Card
        doc.rect(ML, y, W, cardH).fill(pBg);
        doc.rect(ML, y, 3, cardH).fill(pColor);

        // Badge + title row
        let cy = y + 12;
        doc.rect(ML + 8, cy, 72, 15).fill(pColor);
        doc.fillColor("white").font("Helvetica-Bold").fontSize(7.5)
          .text(p + " PRIORITY", ML + 8, cy + 4, { width: 72, align: "center" });
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11)
          .text(f.title || "", ML + 88, cy, { width: W - 96 });
        cy += Math.max(titleH, 16) + 10;

        // What
        doc.fillColor(MID).font("Helvetica-Bold").fontSize(7.5).text("WHAT WE FOUND", ML + 8, cy);
        cy += 11;
        doc.fillColor("#0F172A").font("Helvetica").fontSize(10)
          .text(f.what || "", ML + 8, cy, { width: W - 24, lineGap: 2 });
        cy += whatH + 10;

        // Why
        doc.rect(ML + 8, cy, W - 24, 0.5).fill(BORDER);
        cy += 7;
        doc.fillColor(MID).font("Helvetica-Bold").fontSize(7.5).text("WHY IT MATTERS", ML + 8, cy);
        cy += 11;
        doc.fillColor(MID).font("Helvetica").fontSize(10)
          .text(f.why || "", ML + 8, cy, { width: W - 24, lineGap: 2 });
        cy += whyH + 10;

        // Next step
        doc.rect(ML + 8, cy, W - 24, 0.5).fill(BORDER);
        cy += 7;
        doc.fillColor(MID).font("Helvetica-Bold").fontSize(7.5).text("RECOMMENDED NEXT STEP", ML + 8, cy);
        cy += 11;
        doc.fillColor(ACCENT).font("Helvetica-Oblique").fontSize(10)
          .text("→ " + (f.next_step || ""), ML + 8, cy, { width: W - 24, lineGap: 2 });

        y += cardH + 10;
      });
    });

    // ── WHERE NORTHPOINT CAN HELP ──
    const rec = auditData.service_recommendation;
    if (rec) {
      y = newInnerPage();

      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(8).text("YOUR NEXT MOVE", ML, y);
      y += 14;
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(18).text("Where Northpoint Can Help", ML, y);
      y += 24;
      doc.rect(ML, y, W, 1.5).fill(ACCENT);
      y += 16;

      doc.fillColor(SLATE).font("Helvetica").fontSize(11)
        .text("Based on this audit, here is where we would focus first:", ML, y, { width: W });
      y += 22;

      // Primary service card
      doc.rect(ML, y, W, 3).fill(ACCENT);
      y += 3;
      const primaryRatH = doc.heightOfString(rec.rationale || "", { width: W - 24, fontSize: 10 });
      const primaryCardH = 16 + 20 + 12 + primaryRatH + 16;
      doc.rect(ML, y, W, primaryCardH).fill(LIGHT);
      doc.rect(ML, y, 3, primaryCardH).fill(ACCENT);

      let cy = y + 12;
      doc.rect(ML + 8, cy, 120, 16).fill(ACCENT);
      doc.fillColor("white").font("Helvetica-Bold").fontSize(8)
        .text("PRIMARY RECOMMENDATION", ML + 8, cy + 4, { width: 120, align: "center" });
      cy += 20;
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13)
        .text(rec.primary_service || "", ML + 8, cy);
      cy += 18;
      doc.fillColor(SLATE).font("Helvetica").fontSize(10)
        .text(rec.rationale || "", ML + 8, cy, { width: W - 24, lineGap: 3 });
      y += primaryCardH + 12;

      // Secondary service card
      if (rec.secondary_service && rec.secondary_service !== "null") {
        const secRatH = doc.heightOfString(rec.secondary_rationale || "", { width: W - 24, fontSize: 10 });
        const secCardH = 16 + 20 + 12 + secRatH + 16;
        y = checkPageBreak(y, secCardH + 10);

        doc.rect(ML, y, W, secCardH).fill("#F5F5F5");
        doc.rect(ML, y, 3, secCardH).fill(SLATE);

        cy = y + 12;
        doc.rect(ML + 8, cy, 130, 16).fill(SLATE);
        doc.fillColor("white").font("Helvetica-Bold").fontSize(8)
          .text("COMPLEMENTARY SERVICE", ML + 8, cy + 4, { width: 130, align: "center" });
        cy += 20;
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13)
          .text(rec.secondary_service || "", ML + 8, cy);
        cy += 18;
        doc.fillColor(MID).font("Helvetica").fontSize(10)
          .text(rec.secondary_rationale || "", ML + 8, cy, { width: W - 24, lineGap: 3 });
        y += secCardH + 20;
      }

      // Services overview
      y = checkPageBreak(y, 100);
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Our Core Services", ML, y);
      y += 14;

      const services = [
        { name: "B2B Paid Search", desc: "Google Ads built around pipeline — not clicks. We build, manage, and optimize paid search programs that connect ad spend directly to revenue." },
        { name: "SEO & Technical", desc: "Rankings, site health, and content that converts. From Core Web Vitals to keyword strategy, we build organic programs designed for B2B buying cycles." },
        { name: "Full Search-to-Pipeline Program", desc: "Both channels working together — SEO building the foundation, paid search accelerating pipeline. Designed for B2B companies ready to make search their primary growth channel." },
      ];

      services.forEach((svc) => {
        const descH = doc.heightOfString(svc.desc, { width: W - 20, fontSize: 10 });
        const rowH = 12 + 16 + descH + 12;
        y = checkPageBreak(y, rowH + 6);

        doc.rect(ML, y, W, rowH).fill(LIGHT);
        doc.rect(ML, y, 3, rowH).fill(ACCENT);
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11)
          .text(svc.name, ML + 10, y + 10);
        doc.fillColor(MID).font("Helvetica").fontSize(10)
          .text(svc.desc, ML + 10, y + 26, { width: W - 20, lineGap: 2 });
        y += rowH + 6;
      });
    }

    // ── CTA PAGE ──
    doc.addPage({ size: "letter", margin: 0 });
    doc.rect(0, 0, PW, PH).fill(NAVY);
    doc.rect(0, 0, PW, 5).fill(ACCENT);
    doc.rect(0, PH - 5, PW, 5).fill(ACCENT);

    doc.fillColor("white").font("Helvetica-Bold").fontSize(24)
      .text("What to Do Next", ML, 190, { align: "center", width: W });
    doc.rect(ML, 234, W, 1).fill(ACCENT);

    doc.fillColor("#CBD5E1").font("Helvetica").fontSize(12)
      .text(
        "This audit identifies the highest-impact issues across five dimensions of your digital presence. Fixing the top findings in technical performance and conversion will measurably improve both organic rankings and pipeline.",
        ML, 254, { align: "center", width: W, lineGap: 5 }
      );

    doc.fillColor("white").font("Helvetica-Bold").fontSize(15)
      .text("Ready to go deeper?", ML, 360, { align: "center", width: W });
    doc.fillColor("#CBD5E1").font("Helvetica").fontSize(11)
      .text(
        "A 30-minute strategy call is the natural next step. No pitch, no pressure — just a focused conversation about which of these findings would have the most impact on your pipeline goals this year.",
        ML, 386, { align: "center", width: W, lineGap: 4 }
      );

    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(13)
      .text("northpointmktg.com/strategy-call", ML, 454, { align: "center", width: W });
    doc.fillColor("#8A9199").font("Helvetica").fontSize(10)
      .text("Or reach out directly: hello@northpointmktg.com", ML, 478, { align: "center", width: W });

    doc.end();
  });
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendEmail(toEmail, companyName, pdfBuffer, url) {
  const resend = new Resend(RESEND_KEY);
  const domain = new URL(getOrigin(url)).hostname.replace("www.", "");
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: toEmail,
    subject: `Your Website Audit Report — ${companyName}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#0F172A">
        <div style="background:#1F2A37;padding:24px 32px;border-radius:8px 8px 0 0">
          <p style="color:#3B82C4;font-size:11px;font-weight:700;letter-spacing:.08em;margin:0 0 8px">NORTHPOINT MARKETING</p>
          <p style="color:white;font-size:20px;font-weight:700;margin:0">Your Website Audit is Ready</p>
        </div>
        <div style="background:#F5F5F5;padding:28px 32px;border:1px solid #E2E8F0;border-top:none">
          <p style="margin:0 0 16px">Your audit report for <strong>${domain}</strong> is attached to this email as a PDF.</p>
          <p style="margin:0 0 16px;color:#8A9199">The report covers five areas of your digital presence — technical performance, SEO fundamentals, conversion and UX, messaging, and paid search readiness — with specific findings, a section-by-section scorecard, and a service recommendation tailored to your biggest gaps.</p>
          <p style="margin:0 0 24px;color:#8A9199">If any of the findings raise questions or you'd like to talk through priorities, a 30-minute strategy call is the fastest way to turn these insights into a plan.</p>
          <a href="https://northpointmktg.com/strategy-call" style="display:inline-block;background:#3B82C4;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Book a Strategy Call</a>
        </div>
        <div style="padding:16px 32px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 8px 8px">
          <p style="margin:0;font-size:12px;color:#94A3B8">Northpoint Marketing · Turning Search into Pipeline for B2B Companies · northpointmktg.com</p>
        </div>
      </div>
    `,
    attachments: [{
      filename: `Northpoint-Audit-${domain}.pdf`,
      content: pdfBuffer.toString("base64"),
    }],
  });
}

function getOrigin(url) {
  try { return new URL(url).origin; } catch (e) { return url; }
}

// ── Main Handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url: rawUrl, email } = req.body || {};
  if (!rawUrl || !email) return res.status(400).json({ error: "url and email are required" });

  const url = normalizeUrl(rawUrl);
  const origin = getOrigin(url);

  try {
    const [mobile, desktop, htmlData, robots, sitemap] = await Promise.all([
      getPageSpeed(url, "mobile"),
      getPageSpeed(url, "desktop"),
      scrapeHTML(url),
      fetchText(origin + "/robots.txt"),
      fetchText(origin + "/sitemap.xml"),
    ]);

    const rawData = {
      url,
      mobile_pagespeed: mobile,
      desktop_pagespeed: desktop,
      homepage: htmlData,
      robots_txt: robots,
      sitemap_xml: sitemap ? sitemap.slice(0, 600) : null,
    };

    const auditData = await callClaude(rawData);
    const pdfBuffer = await generatePDF(auditData, rawData);

    if (process.env.SKIP_EMAIL !== "true") {
      await sendEmail(email, auditData.company_name || url, pdfBuffer, url);
    }

    return res.status(200).json({
      success: true,
      message: "Audit complete — report sent to " + email,
      company: auditData.company_name,
    });
  } catch (err) {
    console.error("Audit error:", err);
    return res.status(500).json({ error: err.message || "Audit failed" });
  }
};
