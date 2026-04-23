const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const { Resend } = require("resend");
const PDFDocument = require("pdfkit");

// ── Config ──────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "audits@northpointmarketing.com";
const FROM_NAME = process.env.FROM_NAME || "Northpoint Marketing";

// ── System Prompt ────────────────────────────────────────────────────────────
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
- If data is missing for a section, note it in one finding and move on — do not skip the section entirely.`;

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  let u = raw.trim();
  if (!u.startsWith("http")) u = "https://" + u;
  try {
    return new URL(u).origin;
  } catch (e) {
    return u;
  }
}

async function getPageSpeed(url, strategy) {
  try {
    const key = process.env.PAGESPEED_API_KEY ? `&key=${process.env.PAGESPEED_API_KEY}` : '';
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
        .filter(
          (a) =>
            a.details?.type === "opportunity" &&
            a.score != null &&
            a.score < 0.9
        )
        .slice(0, 5)
        .map((a) => ({ title: a.title, savings: a.displayValue || "" })),
    };
  } catch (e) {
    return null;
  }
}

async function scrapeHTML(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; NorthpointAudit/1.0; +https://northpointmarketing.com)",
      },
    });
    const $ = cheerio.load(html);
    const allText = (sel) =>
      $(sel)
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
    const ctaRx =
      /contact|demo|consult|call us|get started|learn more|schedule|book|request|quote|free trial|talk to/i;
    const allAnchors = $("a")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
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
      has_schema:
        html.includes("application/ld+json") || html.includes("schema.org"),
      has_open_graph: !!$('meta[property="og:title"]').attr("content"),
      https: url.startsWith("https"),
    };
  } catch (e) {
    return null;
  }
}

async function fetchText(url) {
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    return typeof data === "string" ? data.slice(0, 1200) : JSON.stringify(data).slice(0, 1200);
  } catch (e) {
    return null;
  }
}

async function callClaude(rawData) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Audit this website and return findings as JSON:\n\n${JSON.stringify(rawData, null, 2)}`,
      },
    ],
  });
  const text = msg.content[0]?.text || "";
  const match = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude did not return valid JSON");
  return JSON.parse(match[0]);
}

// ── PDF Generation ───────────────────────────────────────────────────────────
function generatePDF(auditData, rawData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 54 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = 612 - 108;
    const NAVY = "#0D1F3C";
    const ACCENT = "#2563EB";
    const MID = "#64748B";
    const HIGH = "#DC2626";
    const MED = "#D97706";
    const LOW = "#16A34A";
    const LIGHT = "#F8FAFC";
    const BORDER = "#E2E8F0";

    const mobile = rawData.mobile_pagespeed;
    const desktop = rawData.desktop_pagespeed;

    // ── Cover Page ──
    doc.rect(0, 0, 612, 792).fill(NAVY);
    doc.rect(0, 0, 612, 5).fill(ACCENT);

    doc.fillColor("#2563EB").font("Helvetica-Bold").fontSize(9)
      .text("NORTHPOINT MARKETING", 54, 120, { align: "center", width: W });

    doc.fillColor("white").font("Helvetica-Bold").fontSize(28)
      .text("Website Performance\nAudit Report", 54, 160, { align: "center", width: W, lineGap: 6 });

    doc.rect(54, 240, W, 1).fill("#2563EB");

    doc.fillColor("#94A3B8").font("Helvetica").fontSize(10)
      .text("Prepared for:", 54, 260, { align: "center", width: W });

    doc.fillColor("white").font("Helvetica-Bold").fontSize(14)
      .text(auditData.company_name || "Your Company", 54, 278, { align: "center", width: W });

    doc.fillColor("#2563EB").font("Helvetica").fontSize(11)
      .text(auditData.url || "", 54, 298, { align: "center", width: W });

    const dateStr = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
    doc.fillColor("#64748B").font("Helvetica").fontSize(9)
      .text(`${dateStr}  ·  Confidential`, 54, 680, { align: "center", width: W });

    doc.fillColor("#475569").font("Helvetica-Oblique").fontSize(10)
      .text("Turning Search into Pipeline for B2B Companies.", 54, 700, { align: "center", width: W });

    // ── Inner page header/footer helper ──
    function addPageChrome() {
      doc.rect(0, 0, 612, 36).fill(NAVY);
      doc.fillColor("white").font("Helvetica-Bold").fontSize(8)
        .text("NORTHPOINT MARKETING", 54, 13);
      doc.fillColor("#64748B").font("Helvetica").fontSize(8)
        .text(`Website Audit — ${auditData.company_name || ""}`, 54, 13, { align: "right", width: W });
      doc.rect(0, 756, 612, 36).fill("#F1F5F9");
      doc.fillColor(MID).font("Helvetica").fontSize(7.5)
        .text("Confidential | Prepared by Northpoint Marketing | northpointmarketing.com", 54, 766);
      doc.fillColor(MID).font("Helvetica").fontSize(7.5)
        .text(`Page ${doc.bufferedPageRange().start + doc.bufferedPageRange().count}`, 54, 766, { align: "right", width: W });
    }

    // ── Executive Summary Page ──
    doc.addPage();
    addPageChrome();

    let y = 54;
    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(8)
      .text("OVERVIEW", 54, y);
    y += 16;
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(20)
      .text("Executive Summary", 54, y);
    y += 28;
    doc.rect(54, y, W, 1).fill(ACCENT);
    y += 14;

    // Metrics boxes
    const metrics = [
      { label: "Mobile Score", val: mobile ? mobile.score + "/100" : "N/A", color: mobile ? (mobile.score >= 90 ? LOW : mobile.score >= 50 ? MED : HIGH) : MID },
      { label: "Desktop Score", val: desktop ? desktop.score + "/100" : "N/A", color: desktop ? (desktop.score >= 90 ? LOW : desktop.score >= 50 ? MED : HIGH) : MID },
      { label: "Mobile LCP", val: mobile?.lcp || "N/A", color: NAVY },
      { label: "Mobile CLS", val: mobile?.cls || "N/A", color: NAVY },
    ];

    const boxW = (W - 12) / 4;
    metrics.forEach((m, i) => {
      const bx = 54 + i * (boxW + 4);
      doc.rect(bx, y, boxW, 56).fill(LIGHT).stroke(BORDER);
      doc.fillColor(m.color).font("Helvetica-Bold").fontSize(18)
        .text(m.val, bx, y + 10, { width: boxW, align: "center" });
      doc.fillColor(MID).font("Helvetica").fontSize(8)
        .text(m.label, bx, y + 34, { width: boxW, align: "center" });
    });
    y += 72;

    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(12).text("Key Takeaway", 54, y);
    y += 16;
    doc.rect(54, y, 3, 60).fill(ACCENT);
    doc.fillColor("#1E3A5F").font("Helvetica").fontSize(11)
      .text(auditData.executive_summary || "", 62, y, { width: W - 8, lineGap: 4 });
    y += 80;

    // ── Findings Pages ──
    const priorityColors = { HIGH: HIGH, MEDIUM: MED, LOW: LOW };
    const priorityBg = { HIGH: "#FFF1F1", MEDIUM: "#FFFBEB", LOW: "#F0FDF4" };

    (auditData.sections || []).forEach((sec) => {
      doc.addPage();
      addPageChrome();
      let y = 54;

      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(8).text("SECTION", 54, y);
      y += 14;
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(18).text(sec.section, 54, y);
      y += 26;
      doc.rect(54, y, W, 1.5).fill(ACCENT);
      y += 14;

      (sec.findings || []).forEach((f) => {
        const p = (f.priority || "LOW").toUpperCase();
        const pColor = priorityColors[p] || MID;

        // Estimate height
        const whatH = doc.heightOfString(f.what || "", { width: W - 20, fontSize: 10 });
        const whyH = doc.heightOfString(f.why || "", { width: W - 20, fontSize: 10 });
        const nextH = doc.heightOfString("→ " + (f.next_step || ""), { width: W - 20, fontSize: 10 });
        const cardH = 20 + 24 + whatH + 24 + whyH + 24 + nextH + 20;

        if (y + cardH > 720) {
          doc.addPage();
          addPageChrome();
          y = 54;
        }

        // Card background
        doc.rect(54, y, W, cardH).fill(priorityBg[p] || LIGHT);
        doc.rect(54, y, 3, cardH).fill(pColor);

        // Priority badge
        let by = y + 12;
        doc.rect(62, by, 68, 14).fill(pColor);
        doc.fillColor("white").font("Helvetica-Bold").fontSize(7.5)
          .text(p + " PRIORITY", 62, by + 3, { width: 68, align: "center" });

        // Title
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11)
          .text(f.title || "", 138, by, { width: W - 88 });

        by = y + 32;

        // What
        doc.fillColor(MID).font("Helvetica-Bold").fontSize(7.5).text("WHAT WE FOUND", 62, by);
        by += 12;
        doc.fillColor("#0F172A").font("Helvetica").fontSize(10)
          .text(f.what || "", 62, by, { width: W - 20, lineGap: 2 });
        by += whatH + 10;

        // Why
        doc.rect(62, by, W - 20, 0.5).fill(BORDER);
        by += 8;
        doc.fillColor(MID).font("Helvetica-Bold").fontSize(7.5).text("WHY IT MATTERS", 62, by);
        by += 12;
        doc.fillColor(MID).font("Helvetica").fontSize(10)
          .text(f.why || "", 62, by, { width: W - 20, lineGap: 2 });
        by += whyH + 10;

        // Next step
        doc.rect(62, by, W - 20, 0.5).fill(BORDER);
        by += 8;
        doc.fillColor(MID).font("Helvetica-Bold").fontSize(7.5).text("RECOMMENDED NEXT STEP", 62, by);
        by += 12;
        doc.fillColor(ACCENT).font("Helvetica-Oblique").fontSize(10)
          .text("→ " + (f.next_step || ""), 62, by, { width: W - 20, lineGap: 2 });

        y += cardH + 12;
      });
    });

    // ── CTA Page ──
    doc.addPage();
    doc.rect(0, 0, 612, 792).fill(NAVY);
    doc.rect(0, 0, 612, 5).fill(ACCENT);

    doc.fillColor("white").font("Helvetica-Bold").fontSize(24)
      .text("What to Do Next", 54, 180, { align: "center", width: W });

    doc.rect(54, 224, W, 1).fill(ACCENT);

    doc.fillColor("#CBD5E1").font("Helvetica").fontSize(12)
      .text(
        "This audit identifies the highest-impact issues across five dimensions of your digital presence. The three fastest wins are your mobile page speed, your homepage headline, and your CTA strategy — fixing those three alone will measurably improve both organic rankings and conversion rate.",
        54, 244, { align: "center", width: W, lineGap: 5 }
      );

    doc.fillColor("white").font("Helvetica-Bold").fontSize(14)
      .text("Ready to go deeper?", 54, 360, { align: "center", width: W });

    doc.fillColor("#CBD5E1").font("Helvetica").fontSize(11)
      .text(
        "A 30-minute strategy call is the natural next step. No pitch, no pressure — just a focused conversation about which of these findings would have the most impact on your pipeline goals this year.",
        54, 386, { align: "center", width: W, lineGap: 4 }
      );

    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(12)
      .text("northpointmarketing.com/strategy-call", 54, 450, { align: "center", width: W });

    doc.fillColor("#64748B").font("Helvetica").fontSize(10)
      .text("Or reach out directly: hello@northpointmarketing.com", 54, 472, { align: "center", width: W });

    doc.end();
  });
}

// ── Email ────────────────────────────────────────────────────────────────────
async function sendEmail(toEmail, companyName, pdfBuffer, url) {
  const resend = new Resend(RESEND_KEY);
  const domain = new URL(url).hostname.replace("www.", "");
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: toEmail,
    subject: `Your Website Audit Report — ${companyName}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#0F172A">
        <div style="background:#0D1F3C;padding:24px 32px;border-radius:8px 8px 0 0">
          <p style="color:#2563EB;font-size:11px;font-weight:700;letter-spacing:.08em;margin:0 0 8px">NORTHPOINT MARKETING</p>
          <p style="color:white;font-size:20px;font-weight:700;margin:0">Your Website Audit is Ready</p>
        </div>
        <div style="background:#F8FAFC;padding:28px 32px;border:1px solid #E2E8F0;border-top:none">
          <p style="margin:0 0 16px">Your audit report for <strong>${domain}</strong> is attached to this email as a PDF.</p>
          <p style="margin:0 0 16px;color:#64748B">The report covers five areas of your digital presence — technical performance, SEO fundamentals, conversion and UX, messaging, and paid search readiness — with specific findings and recommended next steps for each.</p>
          <p style="margin:0 0 24px;color:#64748B">If any of the findings raise questions or you'd like to talk through priorities, a 30-minute strategy call is the fastest way to turn these insights into a plan.</p>
          <a href="https://northpointmarketing.com/strategy-call" style="display:inline-block;background:#2563EB;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Book a Strategy Call</a>
        </div>
        <div style="padding:16px 32px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 8px 8px">
          <p style="margin:0;font-size:12px;color:#94A3B8">Northpoint Marketing · Turning Search into Pipeline for B2B Companies</p>
        </div>
      </div>
    `,
    attachments: [
      {
        filename: `Northpoint-Audit-${domain}.pdf`,
        content: pdfBuffer.toString("base64"),
      },
    ],
  });
}

// ── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url: rawUrl, email } = req.body || {};
  if (!rawUrl || !email) {
    return res.status(400).json({ error: "url and email are required" });
  }

  const url = normalizeUrl(rawUrl);

  try {
    // 1. Collect all data in parallel
    const [mobile, desktop, htmlData, robots, sitemap] = await Promise.all([
      getPageSpeed(url, "mobile"),
      getPageSpeed(url, "desktop"),
      scrapeHTML(url),
      fetchText(url + "/robots.txt"),
      fetchText(url + "/sitemap.xml"),
    ]);

    const rawData = {
      url,
      mobile_pagespeed: mobile,
      desktop_pagespeed: desktop,
      homepage: htmlData,
      robots_txt: robots,
      sitemap_xml: sitemap ? sitemap.slice(0, 600) : null,
    };

    // 2. Claude analysis
    const auditData = await callClaude(rawData);

    // 3. Generate PDF
    const pdfBuffer = await generatePDF(auditData, rawData);

    // 4. Send email
    if (!process.env.SKIP_EMAIL || process.env.SKIP_EMAIL !== 'true') {
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
