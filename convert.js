"use strict";
// Converters between PDF and Word / Excel / PowerPoint. All run in the browser.
// Helpers like openPdfJs, renderPage, readBuffer, pdfBlob come from app.js.

// ---------- shared: read text lines (with positions) from a PDF ----------

async function extractLines(file) {
  const pdf = await openPdfJs(file);
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => it.str && it.str.trim() !== "")
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], h: Math.abs(it.height) || 10, w: it.width }));
    // Group items that sit on (almost) the same height into one line.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) < Math.max(2, last.h * 0.4)) last.items.push(it);
      else lines.push({ y: it.y, h: it.h, items: [it] });
    }
    lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));
    pages.push(lines);
  }
  return pages;
}

function noTextError() {
  return new Error("This PDF has no selectable text. It may be a scan, so it cannot be converted to an editable file.");
}

// ---------- shared: small XML / zip helpers ----------

function xmlEscape(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colName(i) {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// ---------- PDF -> Word ----------

async function buildDocx(pages) {
  const body = [];
  pages.forEach((lines, pi) => {
    if (pi > 0) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    // Lines close together belong to one paragraph; a bigger gap starts a new one.
    let para = [];
    let size = 22;
    const flush = () => {
      if (!para.length) return;
      body.push('<w:p><w:r><w:rPr><w:sz w:val="' + size + '"/></w:rPr><w:t xml:space="preserve">' +
        xmlEscape(para.join(" ")) + "</w:t></w:r></w:p>");
      para = [];
    };
    lines.forEach((line, i) => {
      const prev = lines[i - 1];
      if (prev && prev.y - line.y > Math.max(prev.h, line.h) * 1.7) flush();
      if (!para.length) size = Math.min(72, Math.max(16, Math.round(line.h * 2)));
      para.push(line.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim());
    });
    flush();
  });
  const zip = new JSZip();
  zip.file("[Content_Types].xml", XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", XML_HEAD +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    body.join("") +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>");
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

// ---------- PDF -> Excel ----------

async function buildXlsx(pages) {
  const zip = new JSZip();
  const sheets = pages.map((_, i) => i + 1);
  zip.file("[Content_Types].xml", XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((n) => '<Override PartName="/xl/worksheets/sheet' + n + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") +
    "</Types>");
  zip.file("_rels/.rels", XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", XML_HEAD +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((n) => '<sheet name="Page ' + n + '" sheetId="' + n + '" r:id="rId' + n + '"/>').join("") +
    "</sheets></workbook>");
  zip.file("xl/_rels/workbook.xml.rels", XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((n) => '<Relationship Id="rId' + n + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + n + '.xml"/>').join("") +
    "</Relationships>");
  pages.forEach((lines, pi) => {
    const rows = lines.map((line, ri) => {
      // A wide gap between two pieces of text means a new column.
      const cells = [];
      let cur = null;
      line.items.forEach((it) => {
        if (cur && it.x - cur.end < line.h * 1.0) { cur.text += " " + it.str; cur.end = it.x + it.w; }
        else { cur = { text: it.str, end: it.x + it.w }; cells.push(cur); }
      });
      const xml = cells.map((c, ci) => {
        const ref = colName(ci) + (ri + 1);
        const t = c.text.trim();
        return /^-?\d+(\.\d+)?$/.test(t)
          ? '<c r="' + ref + '"><v>' + t + "</v></c>"
          : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(t) + "</t></is></c>";
      }).join("");
      return '<row r="' + (ri + 1) + '">' + xml + "</row>";
    }).join("");
    zip.file("xl/worksheets/sheet" + (pi + 1) + ".xml", XML_HEAD +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows + "</sheetData></worksheet>");
  });
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ---------- HTML -> PDF (used by Word and Excel) ----------

// Word and Excel files turn into HTML before they are drawn. A bad file could hide code in that HTML,
// so only plain document tags and a few safe attributes are kept (everything else is removed).
const SAFE_TAGS = new Set(["A", "B", "BLOCKQUOTE", "BR", "CAPTION", "CODE", "COL", "COLGROUP", "DEL", "DIV", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HR", "I", "IMG", "INS", "LI", "OL", "P", "PRE", "S", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP", "TABLE", "TBODY", "TD", "TFOOT", "TH",
  "THEAD", "TR", "U", "UL"]);
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "LINK", "META", "BASE", "FORM", "INPUT", "BUTTON",
  "TEXTAREA", "SELECT", "SVG", "MATH", "TEMPLATE", "NOSCRIPT", "AUDIO", "VIDEO", "SOURCE", "CANVAS", "APPLET"]);
const SAFE_ATTRS = new Set(["colspan", "rowspan", "align", "valign", "alt", "width", "height"]);

function cleanHtmlInto(parent, html) {
  const doc = new DOMParser().parseFromString("<!doctype html><body>" + html, "text/html");
  const walk = (src, dest) => {
    Array.from(src.childNodes).forEach((n) => {
      if (n.nodeType === 3) { dest.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      const tag = n.nodeName.toUpperCase();
      if (DROP_TAGS.has(tag)) return;
      if (!SAFE_TAGS.has(tag)) { walk(n, dest); return; } // unknown tag: keep its text, drop the tag
      const el = document.createElement(tag.toLowerCase());
      Array.from(n.attributes).forEach((at) => {
        const name = at.name.toLowerCase();
        const val = at.value;
        if (SAFE_ATTRS.has(name)) el.setAttribute(name, val);
        else if (tag === "IMG" && name === "src" && /^data:image\/(png|jpe?g|gif|bmp|webp);base64,/i.test(val)) el.setAttribute("src", val);
        else if (tag === "A" && name === "href" && /^(https?:|mailto:|#)/i.test(val)) el.setAttribute("href", val);
      });
      walk(n, el);
      dest.appendChild(el);
    });
  };
  walk(doc.body, parent);
}

function makeRenderBox(html, widthPx, cssClass) {
  const box = document.createElement("div");
  box.className = "render-box " + cssClass;
  box.style.width = widthPx + "px";
  cleanHtmlInto(box, html);
  const hold = document.createElement("div");
  hold.className = "render-hold";
  hold.appendChild(box);
  document.body.appendChild(hold);
  return box;
}

async function htmlToPdfBlob(box, orientation, ctx) {
  try {
    ctx.progress(0.3);
    const blob = await html2pdf().set({
      margin: 12,
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
      jsPDF: { unit: "mm", format: "a4", orientation },
      pagebreak: { mode: ["css", "legacy"], avoid: ["tr", "img", "h1", "h2", "h3"] },
    }).from(box).outputPdf("blob");
    return blob;
  } finally {
    box.parentElement.remove();
  }
}

// ---------- PowerPoint -> PDF ----------

const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function kids(el, name) {
  return Array.from(el.children).filter((c) => c.nodeName === name);
}
function firstDeep(el, name) {
  return el.getElementsByTagName(name)[0] || null;
}
function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}

async function pptxToSlideBoxes(file) {
  const zip = await JSZip.loadAsync(await readBuffer(file));
  const pres = zip.file("ppt/presentation.xml");
  if (!pres) throw new Error(file.name + " is not a valid .pptx file.");
  const sz = firstDeep(parseXml(await pres.async("string")), "p:sldSz");
  const slideW = +(sz && sz.getAttribute("cx")) || 9144000;
  const slideH = +(sz && sz.getAttribute("cy")) || 5143500;
  const W = 960;
  const k = W / slideW; // EMU -> px
  const H = Math.round(slideH * k);

  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  if (!slideNames.length) throw new Error("No slides were found in this file.");

  const boxes = [];
  for (const name of slideNames) {
    const doc = parseXml(await zip.file(name).async("string"));
    const relsFile = zip.file(name.replace("slides/", "slides/_rels/") + ".rels");
    const rels = {};
    if (relsFile) {
      const rd = parseXml(await relsFile.async("string"));
      Array.from(rd.getElementsByTagName("Relationship")).forEach((r) => (rels[r.getAttribute("Id")] = r.getAttribute("Target")));
    }
    const slide = document.createElement("div");
    slide.className = "slide";
    slide.style.cssText = "position:relative;overflow:hidden;background:#fff;color:#000;width:" + W + "px;height:" + H + "px;";
    const flow = document.createElement("div");
    flow.style.cssText = "position:absolute;left:" + W * 0.05 + "px;top:" + H * 0.05 + "px;width:" + W * 0.9 + "px;";
    slide.appendChild(flow);

    const tree = firstDeep(doc, "p:spTree");
    const shapes = tree ? Array.from(tree.getElementsByTagName("*")).filter((e) => ["p:sp", "p:pic", "p:graphicFrame"].includes(e.nodeName)) : [];
    for (const shape of shapes) {
      const xfrm = firstDeep(shape, "a:xfrm");
      const off = xfrm && firstDeep(xfrm, "a:off");
      const ext = xfrm && firstDeep(xfrm, "a:ext");
      const el = document.createElement("div");
      if (off && ext) {
        el.style.cssText = "position:absolute;left:" + off.getAttribute("x") * k + "px;top:" + off.getAttribute("y") * k +
          "px;width:" + ext.getAttribute("cx") * k + "px;height:" + ext.getAttribute("cy") * k + "px;overflow:hidden;";
        slide.appendChild(el);
      } else {
        el.style.cssText = "margin-bottom:10px;";
        flow.appendChild(el);
      }
      if (shape.nodeName === "p:pic") {
        const blip = firstDeep(shape, "a:blip");
        const target = blip && rels[blip.getAttributeNS(NS_REL, "embed") || blip.getAttribute("r:embed")];
        const path = target && "ppt/" + target.replace(/^\.\.\//, "");
        const ext2 = path && path.split(".").pop().toLowerCase();
        const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" }[ext2];
        if (path && mime && zip.file(path)) {
          const img = document.createElement("img");
          img.style.cssText = "width:100%;height:100%;object-fit:contain;";
          img.src = "data:" + mime + ";base64," + (await zip.file(path).async("base64"));
          el.appendChild(img);
        }
      } else if (shape.nodeName === "p:graphicFrame") {
        const tbl = firstDeep(shape, "a:tbl");
        if (tbl) el.appendChild(tableFromPptx(tbl, k));
      } else {
        const tx = firstDeep(shape, "p:txBody");
        if (tx) pptxParagraphs(tx, k, el);
      }
    }
    boxes.push(slide);
  }
  return { boxes, W, H };
}

function pptxParagraphs(txBody, k, into) {
  kids(txBody, "a:p").forEach((p) => {
    const para = document.createElement("div");
    const pPr = kids(p, "a:pPr")[0];
    const algn = pPr && pPr.getAttribute("algn");
    para.style.cssText = "text-align:" + ({ ctr: "center", r: "right", just: "justify" }[algn] || "left") + ";margin:0 0 4px;";
    let any = false;
    kids(p, "a:r").forEach((r) => {
      const t = kids(r, "a:t")[0];
      if (!t || !t.textContent) return;
      any = true;
      const rPr = kids(r, "a:rPr")[0];
      const span = document.createElement("span");
      span.textContent = t.textContent;
      const size = rPr && +rPr.getAttribute("sz");
      const pt = size ? size / 100 : 18;
      let css = "font-size:" + pt * 12700 * k + "px;line-height:1.2;white-space:pre-wrap;";
      if (rPr && rPr.getAttribute("b") === "1") css += "font-weight:bold;";
      if (rPr && rPr.getAttribute("i") === "1") css += "font-style:italic;";
      const clr = rPr && firstDeep(rPr, "a:srgbClr");
      if (clr) css += "color:#" + clr.getAttribute("val") + ";";
      span.style.cssText = css;
      para.appendChild(span);
    });
    if (!any) para.style.height = "0.6em";
    into.appendChild(para);
  });
}

function tableFromPptx(tbl, k) {
  const table = document.createElement("table");
  table.style.cssText = "border-collapse:collapse;width:100%;";
  kids(tbl, "a:tr").forEach((tr) => {
    const row = table.insertRow();
    kids(tr, "a:tc").forEach((tc) => {
      const cell = row.insertCell();
      cell.style.cssText = "border:1px solid #888;padding:3px 6px;vertical-align:top;";
      const tx = kids(tc, "a:txBody")[0];
      if (tx) pptxParagraphs(tx, k, cell);
    });
  });
  return table;
}

// ---------- the tools ----------

const PDF_ACCEPT = ".pdf,application/pdf";

const convertTools = [
  // --- from PDF ---
  {
    id: "pdf2word", group: "Convert from PDF", title: "PDF to Word", icon: "&#128221;", color: "blue", accept: PDF_ACCEPT,
    desc: "Make an editable Word file (.docx). Works for Google Docs too: upload the .docx there. Words are kept; layout and pictures may change.",
    async run(files, ctx) {
      const pages = await extractLines(files[0]);
      if (pages.every((p) => !p.length)) throw noTextError();
      ctx.progress(0.7);
      return [{ name: baseName(files[0].name) + ".docx", blob: await buildDocx(pages) }];
    },
  },
  {
    id: "pdf2excel", group: "Convert from PDF", title: "PDF to Excel", icon: "&#128202;", color: "teal", accept: PDF_ACCEPT,
    desc: "Make an Excel file (.xlsx). Works for Google Sheets too. Each page becomes a sheet and each line a row; tables work best.",
    async run(files, ctx) {
      const pages = await extractLines(files[0]);
      if (pages.every((p) => !p.length)) throw noTextError();
      ctx.progress(0.7);
      return [{ name: baseName(files[0].name) + ".xlsx", blob: await buildXlsx(pages) }];
    },
  },
  {
    id: "pdf2ppt", group: "Convert from PDF", title: "PDF to PowerPoint", icon: "&#127916;", color: "orange", accept: PDF_ACCEPT,
    desc: "Make a PowerPoint file (.pptx), one slide per page. Works for Google Slides too. Slides look like the pages but are pictures.",
    async run(files, ctx) {
      const pdf = await openPdfJs(files[0]);
      const first = await (await pdf.getPage(1)).getViewport({ scale: 1 });
      const pptx = new PptxGenJS();
      pptx.defineLayout({ name: "PDFPAGE", width: first.width / 72, height: first.height / 72 });
      pptx.layout = "PDFPAGE";
      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = await renderPage(pdf, i, 2);
        const slide = pptx.addSlide();
        slide.addImage({ data: canvas.toDataURL("image/jpeg", 0.85), x: 0, y: 0, w: "100%", h: "100%" });
        ctx.progress(i / pdf.numPages);
      }
      const blob = await pptx.write({ outputType: "blob" });
      return [{ name: baseName(files[0].name) + ".pptx", blob }];
    },
  },
  // --- to PDF ---
  {
    id: "word2pdf", group: "Convert to PDF", title: "Word to PDF", icon: "&#128196;", color: "blue", accept: ".docx",
    desc: "Turn a Word file (.docx) into a PDF. For Google Docs, download it as .docx first. Old .doc files: save as .docx in Word first.",
    async run(files, ctx) {
      let html;
      try {
        html = (await mammoth.convertToHtml({ arrayBuffer: await readBuffer(files[0]) })).value;
      } catch (e) {
        throw new Error(files[0].name + " could not be read. Is it a real .docx file?");
      }
      if (!html.trim()) throw new Error("This Word file is empty.");
      const box = makeRenderBox(html, 690, "doc-render");
      return [{ name: baseName(files[0].name) + ".pdf", blob: await htmlToPdfBlob(box, "portrait", ctx) }];
    },
  },
  {
    id: "excel2pdf", group: "Convert to PDF", title: "Excel to PDF", icon: "&#128200;", color: "teal", accept: ".xlsx,.xls,.csv",
    desc: "Turn an Excel file (.xlsx, .xls or .csv) into a PDF. For Google Sheets, download it as .xlsx first. Every sheet becomes a table.",
    async run(files, ctx) {
      let wb;
      try {
        wb = XLSX.read(await readBuffer(files[0]), { type: "array" });
      } catch (e) {
        throw new Error(files[0].name + " could not be read. Is it a real Excel file?");
      }
      const html = wb.SheetNames.map((n) =>
        "<h2>" + xmlEscape(n) + "</h2>" + XLSX.utils.sheet_to_html(wb.Sheets[n], { header: "", footer: "" })).join("");
      const box = makeRenderBox(html, 1000, "sheet-render");
      return [{ name: baseName(files[0].name) + ".pdf", blob: await htmlToPdfBlob(box, "landscape", ctx) }];
    },
  },
  {
    id: "ppt2pdf", group: "Convert to PDF", title: "PowerPoint to PDF", icon: "&#127902;&#65039;", color: "orange", accept: ".pptx",
    desc: "Turn a PowerPoint file (.pptx) into a PDF, one page per slide. For Google Slides, download it as .pptx first. Charts and animations are left out.",
    async run(files, ctx) {
      const { boxes, W, H } = await pptxToSlideBoxes(files[0]);
      const stage = document.createElement("div");
      stage.className = "render-hold";
      boxes.forEach((b) => stage.appendChild(b));
      document.body.appendChild(stage);
      try {
        const out = await PDFDocument.create();
        for (let i = 0; i < boxes.length; i++) {
          const canvas = await html2canvas(boxes[i], { scale: 2, backgroundColor: "#ffffff", useCORS: true });
          const jpg = await canvasToBlob(canvas, "image/jpeg", 0.9);
          const img = await out.embedJpg(await jpg.arrayBuffer());
          out.addPage([W * 0.75, H * 0.75]).drawImage(img, { x: 0, y: 0, width: W * 0.75, height: H * 0.75 });
          ctx.progress((i + 1) / boxes.length);
        }
        return [{ name: baseName(files[0].name) + ".pdf", blob: pdfBlob(await out.save()) }];
      } finally {
        stage.remove();
      }
    },
  },
];
