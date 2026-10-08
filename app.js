"use strict";
// PDF Editor Kit: every tool runs in the browser. Nothing is uploaded.

const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "vendor/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);

// ---------- small helpers ----------

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, "");
}

function readBuffer(file) {
  return file.arrayBuffer();
}

async function openPdfLib(file) {
  try {
    return await PDFDocument.load(await readBuffer(file));
  } catch (e) {
    if (/encrypt/i.test(String(e))) {
      throw new Error(file.name + " is password protected. Unlock it first.");
    }
    throw new Error(file.name + " could not be read. Is it a valid PDF?");
  }
}

async function openPdfJs(file) {
  const data = new Uint8Array(await readBuffer(file));
  return pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
}

async function renderPage(pdf, pageNumber, scale) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// "1-3, 5, 8-10" -> [[1,3],[5,5],[8,10]]; throws on bad text
function parseRanges(text, pageCount) {
  const out = [];
  for (const part of text.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error('"' + p + '" is not a valid page range. Example: 1-3, 5');
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || b > pageCount) {
      throw new Error("Pages must be between 1 and " + pageCount + ' (you wrote "' + p + '").');
    }
    out.push([a, b]);
  }
  if (!out.length) throw new Error("Type at least one page range.");
  return out;
}

async function zipBlobs(items) {
  const zip = new JSZip();
  items.forEach((it) => zip.file(it.name, it.blob));
  return zip.generateAsync({ type: "blob" });
}

function pdfBlob(bytes) {
  return new Blob([bytes], { type: "application/pdf" });
}

// ---------- compress helpers ----------

// Reads the settings of a picture inside the PDF. Returns null for kinds we do not handle.
function imageInfo(obj, pdfCtx) {
  const { PDFName, PDFRawStream, PDFArray, PDFDict } = PDFLib;
  if (!(obj instanceof PDFRawStream)) return null;
  const d = obj.dict;
  const sub = d.get(PDFName.of("Subtype"));
  if (!sub || sub.toString() !== "/Image") return null;
  if (d.get(PDFName.of("Decode")) || d.get(PDFName.of("ImageMask"))) return null;
  let filter = d.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.lookup(0) : null;
  const f = filter && filter.toString();
  if (f !== "/DCTDecode" && f !== "/FlateDecode") return null;
  const num = (key) => { const v = d.lookup(PDFName.of(key)); return v && v.asNumber ? v.asNumber() : null; };
  const width = num("Width"), height = num("Height");
  if (!width || !height) return null;
  // How many colour values per pixel? (3 = RGB, 1 = grey)
  let comps = null;
  const cs = d.lookup(PDFName.of("ColorSpace"));
  if (cs && cs.toString() === "/DeviceRGB") comps = 3;
  else if (cs && cs.toString() === "/DeviceGray") comps = 1;
  else if (cs instanceof PDFArray && cs.lookup(0).toString() === "/ICCBased") {
    const icc = cs.lookup(1);
    const n = icc && icc.dict && icc.dict.lookup(PDFName.of("N"));
    comps = n && n.asNumber ? n.asNumber() : null;
  }
  if (comps !== 1 && comps !== 3) return null; // skip CMYK, indexed, etc.
  if (f === "/DCTDecode") return { kind: "jpeg", width, height, comps };
  if ((num("BitsPerComponent") || 8) !== 8) return null;
  let predictor = 1, columns = width;
  const parms = d.lookup(PDFName.of("DecodeParms"));
  if (parms instanceof PDFDict) {
    const p = parms.lookup(PDFName.of("Predictor")), c = parms.lookup(PDFName.of("Columns"));
    if (p && p.asNumber) predictor = p.asNumber();
    if (c && c.asNumber) columns = c.asNumber();
  } else if (parms) return null;
  if (predictor !== 1 && predictor < 10) return null; // TIFF predictor: not handled
  return { kind: "flate", width, height, comps, predictor, columns };
}

async function inflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function pictureToCanvas(obj, info) {
  if (info.kind === "jpeg") {
    const bmp = await createImageBitmap(new Blob([obj.getContents()], { type: "image/jpeg" }));
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    return c;
  }
  const { width, height, comps } = info;
  let raw = await inflateBytes(obj.getContents());
  if (info.predictor >= 10) {
    const rowBytes = info.columns * comps;
    const stride = rowBytes + 1;
    if (raw.length < stride * height) throw new Error("short picture data");
    const out = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
      const type = raw[y * stride];
      const src = y * stride + 1, dst = y * rowBytes;
      for (let x = 0; x < rowBytes; x++) {
        const v = raw[src + x];
        const a = x >= comps ? out[dst + x - comps] : 0;
        const b = y > 0 ? out[dst - rowBytes + x] : 0;
        const c = x >= comps && y > 0 ? out[dst - rowBytes + x - comps] : 0;
        let r;
        if (type === 0) r = v;
        else if (type === 1) r = v + a;
        else if (type === 2) r = v + b;
        else if (type === 3) r = v + ((a + b) >> 1);
        else {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        out[dst + x] = r & 255;
      }
    }
    raw = out;
  }
  if (raw.length < width * height * comps) throw new Error("short picture data");
  const img = new ImageData(width, height);
  const px = img.data;
  for (let i = 0, j = 0, n = width * height; i < n; i++, j += 4) {
    if (comps === 3) { px[j] = raw[i * 3]; px[j + 1] = raw[i * 3 + 1]; px[j + 2] = raw[i * 3 + 2]; }
    else { px[j] = px[j + 1] = px[j + 2] = raw[i]; }
    px[j + 3] = 255;
  }
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  c.getContext("2d").putImageData(img, 0, 0);
  return c;
}

// Shrinks the pictures inside the PDF (JPEG and lossless ones). Text and everything else stay as they are.
async function compressImages(file, maxDim, quality, ctx) {
  const doc = await openPdfLib(file);
  const { PDFName, PDFRawStream } = PDFLib;
  const pdfCtx = doc.context;
  const found = [];
  for (const [ref, obj] of pdfCtx.enumerateIndirectObjects()) {
    const info = imageInfo(obj, pdfCtx);
    if (info) found.push([ref, obj, info]);
  }
  for (let i = 0; i < found.length; i++) {
    const [ref, obj, info] = found[i];
    try {
      const src = await pictureToCanvas(obj, info);
      const s = Math.min(1, maxDim / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
      g.drawImage(src, 0, 0, w, h);
      const small = new Uint8Array(await (await canvasToBlob(c, "image/jpeg", quality)).arrayBuffer());
      if (small.length < obj.getContents().length) {
        const dict = pdfCtx.obj({ Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" });
        const mask = obj.dict.get(PDFName.of("SMask"));
        if (mask) dict.set(PDFName.of("SMask"), mask);
        pdfCtx.assign(ref, PDFRawStream.of(dict, small));
      }
    } catch (e) { /* a picture we cannot read stays as it was */ }
    ctx.progress((i + 1) / found.length * 0.9);
  }
  return doc.save({ useObjectStreams: true });
}

// Last resort: every page becomes a picture.
async function compressByPictures(file, quality, ctx) {
  const pdf = await openPdfJs(file);
  const out = await PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    const canvas = await renderPage(pdf, i, 1.25);
    const jpg = await canvasToBlob(canvas, "image/jpeg", quality);
    const img = await out.embedJpg(await jpg.arrayBuffer());
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
    out.addPage([vp.width, vp.height]).drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
    ctx.progress(i / pdf.numPages);
  }
  return out.save();
}

// ---------- tools ----------
// Each tool: id, title, desc, icon, color, multi, accept, options (html), run(files, ctx)
// run returns [{name, blob}] and may call ctx.progress(0..1).

const tools = [
  {
    id: "merge", group: "Edit & organize", title: "Merge PDF", icon: "&#128279;", color: "blue", multi: true, accept: ".pdf,application/pdf",
    desc: "Combine several PDFs into one. Use the arrows to set the order.",
    minFiles: 2,
    async run(files, ctx) {
      const out = await PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        const src = await openPdfLib(files[i]);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
        ctx.progress((i + 1) / files.length);
      }
      return [{ name: "merged.pdf", blob: pdfBlob(await out.save()) }];
    },
  },
  {
    id: "split", group: "Edit & organize", title: "Split PDF", icon: "&#9986;&#65039;", color: "blue", accept: ".pdf,application/pdf",
    desc: "Cut a PDF into equal parts, by page range, or one file per page.",
    options: `
      <label>Mode
        <select id="o-mode">
          <option value="parts">Split into equal parts</option>
          <option value="ranges">Custom page ranges</option>
          <option value="each">One file per page</option>
        </select>
      </label>
      <label id="o-parts-wrap">How many parts?
        <input id="o-parts" type="number" value="2" min="2">
        <span class="hint">Example: 2 parts of a 6-page PDF gives pages 1-3 and pages 4-6.</span>
      </label>
      <label id="o-ranges-wrap">Page ranges
        <input id="o-ranges" type="text" placeholder="1-3, 5, 8-10">
        <span class="hint">Each range becomes its own PDF.</span>
      </label>`,
    setup() {
      const sync = () => {
        const m = $("o-mode").value;
        $("o-parts-wrap").hidden = m !== "parts";
        $("o-ranges-wrap").hidden = m !== "ranges";
      };
      $("o-mode").onchange = sync;
      sync();
    },
    async run(files, ctx) {
      const src = await openPdfLib(files[0]);
      const n = src.getPageCount();
      const mode = $("o-mode").value;
      let ranges;
      if (mode === "each") {
        ranges = Array.from({ length: n }, (_, i) => [i + 1, i + 1]);
      } else if (mode === "parts") {
        const parts = parseInt($("o-parts").value, 10);
        if (!parts || parts < 2) throw new Error("Type 2 or more parts.");
        if (parts > n) throw new Error("This PDF has only " + n + " pages, so it cannot be split into " + parts + " parts.");
        // Spread pages as evenly as possible; the first parts get the extra pages.
        ranges = [];
        let start = 1;
        for (let i = 0; i < parts; i++) {
          const size = Math.floor(n / parts) + (i < n % parts ? 1 : 0);
          ranges.push([start, start + size - 1]);
          start += size;
        }
      } else {
        ranges = parseRanges($("o-ranges").value, n);
      }
      const base = baseName(files[0].name);
      const out = [];
      for (let i = 0; i < ranges.length; i++) {
        const [a, b] = ranges[i];
        const doc = await PDFDocument.create();
        const idx = Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k);
        (await doc.copyPages(src, idx)).forEach((p) => doc.addPage(p));
        const label = a === b ? "page-" + a : "pages-" + a + "-" + b;
        out.push({ name: base + "-" + label + ".pdf", blob: pdfBlob(await doc.save()) });
        ctx.progress((i + 1) / ranges.length);
      }
      if (out.length === 1) return out;
      return [{ name: base + "-split.zip", blob: await zipBlobs(out) }];
    },
  },
  {
    id: "organize", group: "Edit & organize", title: "Organize pages", icon: "&#128209;", color: "orange", accept: ".pdf,application/pdf",
    desc: "Rotate, delete and reorder pages. Click the buttons under each page.",
    organize: true,
    async run(files, ctx) {
      const src = await openPdfLib(files[0]);
      const keep = ctx.pages.filter((p) => !p.deleted);
      if (!keep.length) throw new Error("You deleted every page. Keep at least one.");
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, keep.map((p) => p.index));
      copied.forEach((page, i) => {
        const base = page.getRotation().angle;
        page.setRotation(degrees((base + keep[i].rot) % 360));
        out.addPage(page);
      });
      return [{ name: baseName(files[0].name) + "-organized.pdf", blob: pdfBlob(await out.save()) }];
    },
  },
  {
    id: "compress", group: "Edit & organize", title: "Compress PDF", icon: "&#128476;&#65039;", color: "teal", accept: ".pdf,application/pdf",
    desc: "Make a PDF smaller by shrinking the pictures inside it. Text stays text. If it cannot get smaller, you keep your original.",
    options: `
      <label>How small?
        <select id="o-quality">
          <option value="1600|0.75">Good quality</option>
          <option value="1200|0.6" selected>Balanced</option>
          <option value="800|0.45">Smallest</option>
          <option value="page|0.5">Last resort: turn pages into pictures</option>
        </select>
        <span class="hint">The last option makes text impossible to select, but can shrink scans that the others cannot.</span>
      </label>`,
    async run(files, ctx) {
      const [mode, q] = $("o-quality").value.split("|");
      const before = files[0].size;
      let bytes;
      if (mode === "page") bytes = await compressByPictures(files[0], parseFloat(q), ctx);
      else bytes = await compressImages(files[0], parseInt(mode, 10), parseFloat(q), ctx);
      if (bytes.length > before * 0.97) { // saving under 3% is not worth a new file
        ctx.note = "This PDF cannot get smaller this way (" + fmtSize(before) + "). It is already well compressed" +
          (mode === "page" ? "." : ", or it has little in it but text. Try the last-resort option if it is a scan.");
        return [];
      }
      ctx.note = "Smaller: " + fmtSize(before) + " → " + fmtSize(bytes.length);
      return [{ name: baseName(files[0].name) + "-compressed.pdf", blob: pdfBlob(bytes) }];
    },
  },
  {
    id: "numbers", group: "Edit & organize", title: "Page numbers", icon: "&#128290;", color: "orange", accept: ".pdf,application/pdf",
    desc: "Add page numbers to every page.",
    options: `
      <label>Position
        <select id="o-pos">
          <option value="bc">Bottom center</option>
          <option value="br">Bottom right</option>
          <option value="bl">Bottom left</option>
          <option value="tc">Top center</option>
          <option value="tr">Top right</option>
          <option value="tl">Top left</option>
        </select>
      </label>
      <label>Start at <input id="o-start" type="number" value="1" min="0"></label>
      <label>Size <input id="o-size" type="number" value="12" min="6" max="48"></label>`,
    async run(files, ctx) {
      const doc = await openPdfLib(files[0]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pos = $("o-pos").value;
      const start = parseInt($("o-start").value, 10) || 1;
      const size = parseInt($("o-size").value, 10) || 12;
      const pages = doc.getPages();
      pages.forEach((page, i) => {
        const { width, height } = page.getSize();
        const text = String(start + i);
        const w = font.widthOfTextAtSize(text, size);
        const margin = 28;
        const x = pos[1] === "l" ? margin : pos[1] === "r" ? width - margin - w : (width - w) / 2;
        const y = pos[0] === "b" ? margin : height - margin - size;
        page.drawText(text, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
        ctx.progress((i + 1) / pages.length);
      });
      return [{ name: baseName(files[0].name) + "-numbered.pdf", blob: pdfBlob(await doc.save()) }];
    },
  },
  {
    id: "watermark", group: "Edit & organize", title: "Watermark", icon: "&#128167;", color: "orange", accept: ".pdf,application/pdf",
    desc: "Stamp text diagonally across every page, like DRAFT or CONFIDENTIAL.",
    options: `
      <label>Text <input id="o-text" type="text" value="CONFIDENTIAL" maxlength="40"></label>
      <label>Size <input id="o-size" type="number" value="60" min="10" max="200"></label>
      <label>Strength
        <select id="o-opacity">
          <option value="0.15">Light</option>
          <option value="0.3" selected>Medium</option>
          <option value="0.5">Strong</option>
        </select>
      </label>`,
    async run(files, ctx) {
      const text = $("o-text").value.trim();
      if (!text) throw new Error("Type the watermark text first.");
      const doc = await openPdfLib(files[0]);
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const size = parseInt($("o-size").value, 10) || 60;
      const opacity = parseFloat($("o-opacity").value);
      const angle = 45 * Math.PI / 180;
      const pages = doc.getPages();
      pages.forEach((page, i) => {
        const { width, height } = page.getSize();
        const w = font.widthOfTextAtSize(text, size);
        // Move the start so the rotated text is centered on the page.
        const x = width / 2 - (w / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle);
        const y = height / 2 - (w / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle);
        page.drawText(text, { x, y, size, font, rotate: degrees(45), color: rgb(0.5, 0.5, 0.5), opacity });
        ctx.progress((i + 1) / pages.length);
      });
      return [{ name: baseName(files[0].name) + "-watermarked.pdf", blob: pdfBlob(await doc.save()) }];
    },
  },
  {
    id: "img2pdf", group: "Convert to PDF", title: "Images to PDF", icon: "&#128444;&#65039;", color: "teal", multi: true, accept: "image/*",
    desc: "Turn photos or pictures into one PDF. Use the arrows to set the order.",
    options: `
      <label>Page size
        <select id="o-fit">
          <option value="image">Same as the picture</option>
          <option value="a4">A4 page (picture fitted)</option>
        </select>
      </label>`,
    async run(files, ctx) {
      const doc = await PDFDocument.create();
      const fit = $("o-fit").value;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let img;
        if (f.type === "image/jpeg") img = await doc.embedJpg(await readBuffer(f));
        else if (f.type === "image/png") img = await doc.embedPng(await readBuffer(f));
        else {
          // Other formats (webp, gif...) are redrawn as PNG first.
          const bmp = await createImageBitmap(f);
          const c = document.createElement("canvas");
          c.width = bmp.width; c.height = bmp.height;
          c.getContext("2d").drawImage(bmp, 0, 0);
          img = await doc.embedPng(await (await canvasToBlob(c, "image/png")).arrayBuffer());
        }
        if (fit === "a4") {
          const [pw, ph] = [595, 842];
          const s = Math.min((pw - 40) / img.width, (ph - 40) / img.height, 1);
          const w = img.width * s, h = img.height * s;
          doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        } else {
          doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }
        ctx.progress((i + 1) / files.length);
      }
      return [{ name: "images.pdf", blob: pdfBlob(await doc.save()) }];
    },
  },
  {
    id: "pdf2img", group: "Convert from PDF", title: "PDF to images", icon: "&#127912;", color: "teal", accept: ".pdf,application/pdf",
    desc: "Save every page as a picture. Choose PNG or JPG.",
    options: `
      <label>Picture type
        <select id="o-format">
          <option value="png">PNG (best quality, bigger files)</option>
          <option value="jpg">JPG (smaller files)</option>
        </select>
      </label>
      <label>Sharpness
        <select id="o-scale">
          <option value="1.5">Normal</option>
          <option value="2.5">Sharp (bigger files)</option>
        </select>
      </label>`,
    async run(files, ctx) {
      const pdf = await openPdfJs(files[0]);
      const scale = parseFloat($("o-scale").value);
      const jpg = $("o-format").value === "jpg";
      const base = baseName(files[0].name);
      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = await renderPage(pdf, i, scale);
        out.push({
          name: base + "-page-" + i + (jpg ? ".jpg" : ".png"),
          blob: jpg ? await canvasToBlob(canvas, "image/jpeg", 0.92) : await canvasToBlob(canvas, "image/png"),
        });
        ctx.progress(i / pdf.numPages);
      }
      if (out.length === 1) return out;
      return [{ name: base + "-images.zip", blob: await zipBlobs(out) }];
    },
  },
];

tools.push(...convertTools);
tools.push(...securityTools);
tools.unshift(...editorTools);
const GROUP_ORDER = ["Edit & organize", "Security", "Convert from PDF", "Convert to PDF"];

// ---------- screen: home grid ----------

// Simple line icons (24x24), the same idea as the icons in the Mac and Android apps
const ICONS = {
  sign: '<path d="M3 17c2-5 4-9 6-9 2 0 .5 6 2.5 6s2-4 4-4 1 4 3 4"/><path d="M3 21h18"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>',
  pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  merge: '<path d="M12 3v8"/><path d="M9 6l3-3 3 3"/><path d="M12 11l-6 10"/><path d="M12 11l6 10"/>',
  split: '<path d="M12 21v-8"/><path d="M12 13L6 4"/><path d="M12 13l6-9"/><path d="M6 8V4h4"/><path d="M18 8V4h-4"/>',
  organize: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  compress: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M10 14l-7 7"/><path d="M14 10l7-7"/>',
  numbers: '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 5.5l1.5-1v5"/><path d="M4 14h3l-3 3h3"/>',
  watermark: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-9 9"/>',
  word: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6"/><path d="M10 17h6"/>',
  excel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18"/><path d="M3 15h18"/><path d="M9 4v16"/>',
  ppt: '<rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M12 16v4"/><path d="M8 20h8"/>'
};
const TOOL_LOOK = {
  sign:     { icon: "sign",      color: "orange", sub: "Add your signature" },
  protect:  { icon: "lock",      color: "orange", sub: "Add a password" },
  unlock:   { icon: "unlock",    color: "orange", sub: "When you know it" },
  edit:     { icon: "pencil",    color: "orange", sub: "Draw, highlight, text" },
  merge:    { icon: "merge",     color: "teal",   sub: "Combine into one" },
  split:    { icon: "split",     color: "orange", sub: "Cut into parts" },
  organize: { icon: "organize",  color: "blue",   sub: "Rotate, sort, delete" },
  compress: { icon: "compress",  color: "teal",   sub: "Make the file smaller" },
  numbers:  { icon: "numbers",   color: "teal",   sub: "Number every page" },
  watermark:{ icon: "watermark", color: "blue",   sub: "Text on every page" },
  img2pdf:  { icon: "image",     color: "teal",   sub: "Pictures into one PDF" },
  pdf2img:  { icon: "image",     color: "orange", sub: "Save pages as pictures" },
  pdf2word: { icon: "word",      color: "blue",   sub: "Editable .docx file" },
  pdf2excel:{ icon: "excel",     color: "teal",   sub: "Tables into .xlsx" },
  pdf2ppt:  { icon: "ppt",       color: "orange", sub: "One slide per page" },
  word2pdf: { icon: "word",      color: "blue",   sub: ".docx to PDF" },
  excel2pdf:{ icon: "excel",     color: "teal",   sub: ".xlsx to PDF" },
  ppt2pdf:  { icon: "ppt",       color: "orange", sub: ".pptx to PDF" }
};

function lookOf(t) {
  const l = TOOL_LOOK[t.id] || {};
  return {
    color: l.color || t.color,
    sub: l.sub || t.desc.split(/\.\s/)[0].replace(/\.$/, ""),
    svg: l.icon && ICONS[l.icon]
      ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[l.icon] + "</svg>"
      : t.icon
  };
}

// Each tool has its own page (so search engines can find it). The page address of every tool:
const TOOL_PAGES = {
  merge: "merge-pdf", split: "split-pdf", organize: "organize-pdf", compress: "compress-pdf",
  numbers: "add-page-numbers-to-pdf", watermark: "watermark-pdf", img2pdf: "images-to-pdf", pdf2img: "pdf-to-jpg",
  pdf2word: "pdf-to-word", pdf2excel: "pdf-to-excel", pdf2ppt: "pdf-to-powerpoint", word2pdf: "word-to-pdf",
  excel2pdf: "excel-to-pdf", ppt2pdf: "powerpoint-to-pdf", edit: "edit-pdf", sign: "sign-pdf",
  protect: "protect-pdf", unlock: "remove-pdf-password",
};
// On a tool page (like /merge-pdf) the body says which tool it is
const PAGE_TOOL = document.body.dataset.tool || "";

function buildGrid() {
  const grid = $("grid");
  // Every tool is a big tile (like the Mac app home screen), grouped under a small heading
  GROUP_ORDER.forEach((group) => {
    const groupTools = tools.filter((t) => t.group === group);
    if (!groupTools.length) return;
    const h = document.createElement("h2");
    h.className = "group-title";
    h.textContent = group;
    grid.appendChild(h);
    const tiles = document.createElement("div");
    tiles.className = "tiles";
    groupTools.forEach((t) => {
      const look = lookOf(t);
      const a = document.createElement("a");
      a.className = "card";
      a.href = TOOL_PAGES[t.id] ? "/" + TOOL_PAGES[t.id] : "#" + t.id;
      a.innerHTML = '<div class="ico ' + look.color + '">' + look.svg + "</div><div><h3></h3><p></p></div>";
      a.querySelector("h3").textContent = t.title;
      a.querySelector("p").textContent = look.sub;
      tiles.appendChild(a);
    });
    grid.appendChild(tiles);
  });
}

// ---------- screen: tool ----------

let current = null;
let files = [];
let pages = []; // organize tool only
let busy = false;

function setStatus(text, isError) {
  const s = $("status");
  s.className = "status" + (isError ? " error" : "");
  s.textContent = text || "";
}

function setProgress(fraction) {
  let bar = $("status").querySelector(".bar");
  if (!bar) {
    $("status").innerHTML = '<span></span><div class="bar"><div></div></div>';
    bar = $("status").querySelector(".bar");
  }
  $("status").querySelector("span").textContent = "Working… " + Math.round(fraction * 100) + "%";
  bar.firstChild.style.width = fraction * 100 + "%";
}

function renderFileList() {
  const ul = $("file-list");
  ul.innerHTML = "";
  files.forEach((f, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name"; name.textContent = f.name;
    const size = document.createElement("span");
    size.className = "size"; size.textContent = fmtSize(f.size);
    li.append(name, size);
    if (current.multi) {
      li.append(
        iconBtn("↑", "Move up", () => moveFile(i, -1), i === 0),
        iconBtn("↓", "Move down", () => moveFile(i, 1), i === files.length - 1)
      );
    }
    li.append(iconBtn("✕", "Remove", () => { files.splice(i, 1); afterFilesChanged(); }));
    ul.appendChild(li);
  });
  const need = current.minFiles || 1;
  $("run").disabled = busy || files.length < need;
  $("drop-text").textContent = files.length ? (current.multi ? "Add more files" : "Choose a different file") : (current.multi ? "Choose files" : "Choose a file");
}

function iconBtn(label, title, onClick, disabled) {
  const b = document.createElement("button");
  b.className = "icon-btn"; b.type = "button";
  b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
  b.disabled = !!disabled;
  b.onclick = onClick;
  return b;
}

function moveFile(i, dir) {
  const j = i + dir;
  [files[i], files[j]] = [files[j], files[i]];
  renderFileList();
}

async function afterFilesChanged() {
  $("results").innerHTML = "";
  setStatus("");
  renderFileList();
  if (current.custom) { await startEditor(current, files[0]); return; }
  if (current.organize) await buildPageGrid();
}

async function buildPageGrid() {
  const box = $("pages");
  box.innerHTML = "";
  pages = [];
  if (!files.length) return;
  try {
    setStatus("Loading pages…");
    const pdf = await openPdfJs(files[0]);
    for (let i = 1; i <= pdf.numPages; i++) {
      pages.push({ index: i - 1, rot: 0, deleted: false, canvas: await renderPage(pdf, i, 0.3) });
    }
    setStatus("");
    drawPageGrid();
  } catch (e) {
    files = [];
    renderFileList();
    setStatus("That file could not be opened. Is it a valid PDF? It may be password protected.", true);
  }
}

function drawPageGrid() {
  const box = $("pages");
  box.innerHTML = "";
  pages.forEach((p, pos) => {
    const card = document.createElement("div");
    card.className = "page";
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    p.canvas.style.transform = "rotate(" + p.rot + "deg)";
    p.canvas.style.opacity = p.deleted ? "0.25" : "1";
    thumb.appendChild(p.canvas);
    const num = document.createElement("div");
    num.className = "num";
    num.textContent = "Page " + (p.index + 1) + (p.deleted ? " (deleted)" : "");
    const row = document.createElement("div");
    row.className = "row";
    row.append(
      iconBtn("←", "Move earlier", () => swapPage(pos, -1), pos === 0),
      iconBtn("↺", "Rotate left", () => { p.rot = (p.rot + 270) % 360; drawPageGrid(); }),
      iconBtn("↻", "Rotate right", () => { p.rot = (p.rot + 90) % 360; drawPageGrid(); }),
      iconBtn(p.deleted ? "↩" : "✕", p.deleted ? "Restore" : "Delete", () => { p.deleted = !p.deleted; drawPageGrid(); }),
      iconBtn("→", "Move later", () => swapPage(pos, 1), pos === pages.length - 1)
    );
    card.append(thumb, num, row);
    box.appendChild(card);
  });
}

function swapPage(i, dir) {
  const j = i + dir;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  drawPageGrid();
}

function fileMatches(f) {
  return current.accept.split(",").some((t) =>
    t === "image/*" ? f.type.startsWith("image/") : t.startsWith(".") ? f.name.toLowerCase().endsWith(t) : f.type === t);
}

function addFiles(list) {
  const incoming = Array.from(list);
  if (!incoming.length) return;
  const good = incoming.filter(fileMatches);
  if (good.length < incoming.length) {
    setStatus("That kind of file cannot be used here. Please choose: " + current.accept.split(",").filter((x) => x.startsWith(".")).join(", ") + (current.accept.includes("image/") ? " or a picture" : "") + ".", true);
    if (!good.length) return;
  }
  files = current.multi ? files.concat(good) : [good[0]];
  afterFilesChanged();
}

async function runTool() {
  if (busy) return;
  busy = true;
  $("run").disabled = true;
  $("results").innerHTML = "";
  setProgress(0);
  const ctx = { progress: setProgress, pages, note: "" };
  try {
    const outputs = await current.run(files, ctx);
    if (!outputs.length) setStatus(ctx.note);
    else { setStatus(""); showResults(outputs, ctx.note); }
  } catch (e) {
    console.error(e);
    setStatus(e && e.message ? e.message : "Something went wrong. Please try again.", true);
  } finally {
    busy = false;
    renderFileList();
  }
}

function showResults(outputs, note) {
  const box = $("results");
  box.innerHTML = "";
  const done = document.createElement("div");
  done.className = "done";
  done.textContent = "Done! " + (note || "Your file is ready.");
  box.appendChild(done);
  outputs.forEach((o) => {
    const url = URL.createObjectURL(o.blob);
    const a = document.createElement("a");
    a.className = "btn";
    a.href = url;
    a.download = o.name;
    a.textContent = "Download " + o.name + " (" + fmtSize(o.blob.size) + ")";
    box.appendChild(a);
  });
}

function openTool(id) {
  editorReset();
  current = tools.find((t) => t.id === id);
  files = []; pages = []; busy = false;
  $("run").hidden = !!current.custom;
  $("home").hidden = true;
  $("tool").hidden = false;
  $("tool-title").textContent = current.title;
  $("tool-desc").textContent = current.desc;
  $("file-input").accept = current.accept;
  $("file-input").multiple = !!current.multi;
  $("file-input").value = "";
  $("options").innerHTML = current.options || "";
  $("pages").innerHTML = "";
  $("results").innerHTML = "";
  $("run").textContent = current.title.split(" ")[0] === "Merge" ? "Merge PDFs" : current.title;
  setStatus("");
  renderFileList();
  if (current.setup) current.setup();
  if (!PAGE_TOOL) document.title = current.title + " – PDF Editor Kit";
}

function showHome() {
  editorReset();
  current = null;
  $("tool").hidden = true;
  $("home").hidden = false;
  document.title = "PDF Editor Kit – Free PDF tools, private in your browser";
}

function route() {
  if (PAGE_TOOL) { if (!current) openTool(PAGE_TOOL); return; } // a tool page always shows its own tool
  const id = location.hash.replace("#", "");
  if (tools.some((t) => t.id === id)) openTool(id);
  else showHome();
  if (id !== "app") window.scrollTo(0, 0);
}

// ---------- start ----------

buildGrid();
$("file-input").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("run").onclick = runTool;
const drop = $("drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); } });
window.addEventListener("hashchange", route);
route();
