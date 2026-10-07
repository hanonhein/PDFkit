"use strict";
// PDF Editor Kit: the Edit PDF tool. Everything happens in your browser, nothing is uploaded.
//
// How it works:
// - pdf.js draws each page; a see-through canvas on top of it shows the marks (pen, highlight, text).
// - Marks are kept in "page points": 1 unit = 1 point, y goes DOWN, origin = top-left of the page
//   as you see it (already turned if the page is rotated). Zoom never changes them.
// - On save, pdf-lib writes the marks into a copy of the original PDF.

const editorTools = [
  {
    id: "edit", group: "Edit & organize", title: "Edit PDF", icon: "&#9999;&#65039;", color: "orange", custom: true, mode: "edit",
    accept: ".pdf,application/pdf",
    desc: "Draw, highlight, sign and add text to a PDF. Your file stays on your device.",
  },
  {
    id: "sign", group: "Edit & organize", title: "Sign PDF", icon: "&#9997;&#65039;", color: "orange", custom: true, mode: "sign",
    accept: ".pdf,application/pdf",
    desc: "Draw your signature and place it on the page. Your file and your signature stay on your device.",
  },
];

const ED_COLORS = ["#000000", "#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5", "#8e24aa"];
const ED_TOOLS = [
  { id: "select", label: "Select", modes: ["edit", "sign"], hint: "Click a mark to select it. Drag to move it. Drag the blue square to resize a signature. Press Delete to remove it." },
  { id: "pen", label: "Pen", modes: ["edit"], hint: "Draw with your finger or mouse." },
  { id: "highlight", label: "Highlight", modes: ["edit"], hint: "Drag over text to highlight it." },
  { id: "text", label: "Text", modes: ["edit", "sign"], hint: "Click on the page and type. Click a text again to change it." },
  { id: "eraser", label: "Eraser", modes: ["edit", "sign"], hint: "Drag over a mark to remove it." },
];
const ED_PEN_WIDTHS = [1.5, 3, 6];
const ED_HIGHLIGHT_WIDTHS = [10, 16, 26];
const ED_TEXT_SIZES = [12, 18, 28];

let ED = null; // the editor that is open now (null = none)

function edEl(id) { return document.getElementById(id); }

function edHexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Closes the editor and shows the normal file chooser again
function editorReset() {
  if (ED && ED.cleanup) ED.cleanup();
  ED = null;
  const root = edEl("editor");
  if (!root) return;
  root.innerHTML = "";
  root.hidden = true;
  edEl("drop").hidden = false;
  edEl("file-list").hidden = false;
}

// ---------- measuring and hit testing ----------

const edMeasureCtx = document.createElement("canvas").getContext("2d");

function edTextLines(m) { return String(m.text).split("\n"); }

function edMarkBounds(m) {
  if (m.t === "ink") {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    m.pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
    const r = m.w / 2;
    return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
  }
  if (m.t === "image") return { x0: m.x, y0: m.y, x1: m.x + m.w, y1: m.y + m.h };
  // text
  edMeasureCtx.font = m.size + "px Helvetica, Arial, sans-serif";
  const lines = edTextLines(m);
  const w = Math.max(...lines.map((l) => edMeasureCtx.measureText(l).width), m.size * 0.5);
  return { x0: m.x, y0: m.y, x1: m.x + w, y1: m.y + lines.length * m.size * 1.2 };
}

function edDistToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function edHit(m, x, y, tol) {
  if (m.t === "ink") {
    const r = m.w / 2 + tol;
    if (m.pts.length === 1) return Math.hypot(x - m.pts[0][0], y - m.pts[0][1]) <= r;
    for (let i = 1; i < m.pts.length; i++) {
      if (edDistToSegment(x, y, m.pts[i - 1][0], m.pts[i - 1][1], m.pts[i][0], m.pts[i][1]) <= r) return true;
    }
    return false;
  }
  const b = edMarkBounds(m);
  return x >= b.x0 - tol && x <= b.x1 + tol && y >= b.y0 - tol && y <= b.y1 + tol;
}

// ---------- drawing marks on the see-through canvas ----------

function edDrawMark(g, m) {
  if (m.t === "ink") {
    g.save();
    g.globalAlpha = m.alpha;
    g.strokeStyle = m.color;
    g.fillStyle = m.color;
    g.lineWidth = m.w;
    g.lineCap = "round";
    g.lineJoin = "round";
    if (m.pts.length === 1) {
      g.beginPath();
      g.arc(m.pts[0][0], m.pts[0][1], m.w / 2, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.moveTo(m.pts[0][0], m.pts[0][1]);
      for (let i = 1; i < m.pts.length; i++) g.lineTo(m.pts[i][0], m.pts[i][1]);
      g.stroke();
    }
    g.restore();
  } else if (m.t === "image") {
    if (m.img && m.img.complete) g.drawImage(m.img, m.x, m.y, m.w, m.h);
  } else {
    g.save();
    g.fillStyle = m.color;
    g.font = m.size + "px Helvetica, Arial, sans-serif";
    g.textBaseline = "alphabetic";
    edTextLines(m).forEach((ln, k) => g.fillText(ln, m.x, m.y + m.size * 0.8 + k * m.size * 1.2));
    g.restore();
  }
}

function edRedraw(pv) {
  if (!pv.overlay) return;
  const g = pv.overlay.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, pv.overlay.width, pv.overlay.height);
  const k = pv.scale * pv.dpr;
  g.setTransform(k, 0, 0, k, 0, 0);
  ED.marks[pv.index].forEach((m) => edDrawMark(g, m));
  if (pv.live) edDrawMark(g, pv.live);
  if (ED.selected && ED.selectedPage === pv.index) {
    const b = edMarkBounds(ED.selected);
    g.save();
    g.strokeStyle = "#1e88e5";
    g.lineWidth = 1.5 / pv.scale;
    g.setLineDash([5 / pv.scale, 4 / pv.scale]);
    g.strokeRect(b.x0 - 3, b.y0 - 3, b.x1 - b.x0 + 6, b.y1 - b.y0 + 6);
    if (ED.selected.t === "image") {
      g.setLineDash([]);
      g.fillStyle = "#1e88e5";
      const hs = 9 / pv.scale;
      g.fillRect(b.x1 - hs / 2, b.y1 - hs / 2, hs, hs);
    }
    g.restore();
  }
}

// ---------- building the editor ----------

async function startEditor(tool, file) {
  editorReset();
  const root = edEl("editor");
  let bytes;
  let pdf;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  } catch (e) {
    const locked = e && e.name === "PasswordException";
    setStatus(locked ? file.name + " is password protected. Use Remove password first, then edit the unlocked file." : file.name + " could not be read. Is it a valid PDF?", true);
    return;
  }

  ED = {
    file, bytes, pdf, marks: [], pageViews: [], undo: [],
    mode: tool.mode || "edit", lastSignature: null,
    tool: "pen", color: ED_COLORS[1], sizeIndex: 1,
    selected: null, selectedPage: -1, dirty: false, textBox: null,
  };
  for (let i = 0; i < pdf.numPages; i++) ED.marks.push([]);

  edEl("drop").hidden = true;
  edEl("file-list").hidden = true;
  root.hidden = false;
  root.innerHTML =
    '<div class="ed-bar">' +
    '<div class="ed-group" id="ed-tools"></div>' +
    '<div class="ed-group" id="ed-colors"></div>' +
    '<div class="ed-group"><label class="ed-size">Size <select id="ed-size"><option value="0">Small</option><option value="1" selected>Medium</option><option value="2">Large</option></select></label></div>' +
    '<div class="ed-group"><button type="button" class="btn small ghost" id="ed-undo" disabled>Undo</button> <button type="button" class="btn small" id="ed-save">Save PDF</button></div>' +
    "</div>" +
    '<p class="ed-hint muted" id="ed-hint"></p>' +
    '<div class="ed-pages" id="ed-pages"></div>';

  const signBtn = document.createElement("button");
  signBtn.type = "button"; signBtn.className = "ed-tool ed-sign"; signBtn.textContent = "Sign";
  signBtn.onclick = () => edStartSign();
  edEl("ed-tools").appendChild(signBtn);
  ED_TOOLS.filter((t) => t.modes.includes(ED.mode)).forEach((t) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ed-tool"; b.dataset.tool = t.id; b.textContent = t.label;
    b.onclick = () => edSetTool(t.id);
    edEl("ed-tools").appendChild(b);
  });
  ED_COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ed-swatch"; b.dataset.color = c; b.style.background = c;
    b.setAttribute("aria-label", "Colour " + c);
    b.onclick = () => edSetColor(c);
    edEl("ed-colors").appendChild(b);
  });
  edEl("ed-size").onchange = (e) => { ED.sizeIndex = Number(e.target.value); };
  edEl("ed-undo").onclick = edUndo;
  edEl("ed-save").onclick = edSave;

  const onKey = (e) => {
    if (!ED || edEl("editor").hidden) return;
    if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); edUndo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && ED.selected) { e.preventDefault(); edDeleteSelected(); }
    else if (e.key === "Escape" && ED.selected) { ED.selected = null; edRedrawAll(); }
  };
  const onBeforeUnload = (e) => { if (ED && ED.dirty) { e.preventDefault(); e.returnValue = ""; } };
  let resizeTimer = null;
  let lastWidth = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!ED) return;
      const w = edEl("ed-pages").clientWidth;
      if (Math.abs(w - lastWidth) > 24) { lastWidth = w; edLayout(); }
    }, 250);
  };
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("resize", onResize);
  ED.cleanup = () => {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("resize", onResize);
    edRemoveDownload();
    if (ED && ED.observer) ED.observer.disconnect();
    if (ED && ED.pdf) ED.pdf.destroy();
  };

  edSetTool(ED.mode === "sign" ? "select" : "pen");
  edSetColor(ED.color);
  setStatus("");
  lastWidth = edEl("ed-pages").clientWidth;
  await edLayout();
  if (ED.mode === "sign") edStartSign();
}

function edSetTool(id) {
  ED.tool = id;
  ED.selected = null;
  edCloseTextBox(true);
  document.querySelectorAll(".ed-tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === id));
  edEl("ed-hint").textContent = ED_TOOLS.find((t) => t.id === id).hint;
  edEl("ed-pages").classList.toggle("ed-draw", id === "pen" || id === "highlight" || id === "eraser");
  edRedrawAll();
}

function edSetColor(c) {
  ED.color = c;
  document.querySelectorAll(".ed-swatch").forEach((b) => b.classList.toggle("on", b.dataset.color === c));
  if (ED.selected && ED.selected.t === "text") {
    const old = ED.selected.color;
    if (old !== c) {
      ED.selected.color = c;
      ED.undo.push({ k: "recolor", m: ED.selected, old });
      edChanged();
      edRedrawAll();
    }
  }
}

function edRemoveDownload() {
  const old = edEl("ed-download");
  if (old) { URL.revokeObjectURL(old.dataset.url); old.remove(); }
}

function edChanged() {
  ED.dirty = true;
  edRemoveDownload();
  edEl("ed-undo").disabled = ED.undo.length === 0;
}

function edRedrawAll() { ED.pageViews.forEach(edRedraw); }

async function edLayout() {
  if (ED.observer) ED.observer.disconnect();
  const box = edEl("ed-pages");
  box.innerHTML = "";
  ED.pageViews = [];
  const avail = Math.max(280, Math.min(box.clientWidth || 800, 900));
  ED.observer = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) edRenderPage(ED.pageViews[Number(en.target.dataset.index)]); });
  }, { rootMargin: "600px 0px" });

  for (let i = 0; i < ED.pdf.numPages; i++) {
    const page = await ED.pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = avail / vp1.width;
    const vp = page.getViewport({ scale });
    const wrap = document.createElement("div");
    wrap.className = "ed-page";
    wrap.dataset.index = String(i);
    wrap.style.width = Math.floor(vp.width) + "px";
    wrap.style.height = Math.floor(vp.height) + "px";
    box.appendChild(wrap);
    const pv = { index: i, page, scale, w1: vp1.width, h1: vp1.height, vp, wrap, rendered: false, overlay: null, live: null, dpr: 1 };
    ED.pageViews.push(pv);
    ED.observer.observe(wrap);
  }
}

async function edRenderPage(pv) {
  if (!pv || pv.rendered) return;
  pv.rendered = true;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  pv.dpr = dpr;
  const w = Math.floor(pv.vp.width), h = Math.floor(pv.vp.height);
  const c = document.createElement("canvas");
  c.width = Math.floor(pv.vp.width * dpr); c.height = Math.floor(pv.vp.height * dpr);
  c.style.width = w + "px"; c.style.height = h + "px";
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  const o = document.createElement("canvas");
  o.className = "ed-overlay";
  o.width = c.width; o.height = c.height;
  o.style.width = w + "px"; o.style.height = h + "px";
  pv.wrap.append(c, o);
  pv.overlay = o;
  edBindPointer(pv);
  edRedraw(pv);
  try {
    await pv.page.render({ canvasContext: g, viewport: pv.page.getViewport({ scale: pv.scale * dpr }) }).promise;
  } catch (e) { console.error(e); }
}

// ---------- mouse, pen and finger ----------

function edPoint(pv, e) {
  const r = pv.overlay.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * pv.w1, ((e.clientY - r.top) / r.height) * pv.h1];
}

function edBindPointer(pv) {
  const o = pv.overlay;
  let drag = null;

  o.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button > 0) return;
    const [x, y] = edPoint(pv, e);
    const tol = 6 / pv.scale;
    const tool = ED.tool;
    if (tool === "pen" || tool === "highlight") {
      const wList = tool === "pen" ? ED_PEN_WIDTHS : ED_HIGHLIGHT_WIDTHS;
      pv.live = { t: "ink", pts: [[x, y]], color: ED.color, w: wList[ED.sizeIndex], alpha: tool === "pen" ? 1 : 0.35 };
      o.setPointerCapture(e.pointerId);
      e.preventDefault();
      edRedraw(pv);
    } else if (tool === "eraser") {
      drag = { erasing: true };
      o.setPointerCapture(e.pointerId);
      edErase(pv, x, y, tol);
    } else if (tool === "text") {
      const list = ED.marks[pv.index];
      let hit = null;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].t === "text" && edHit(list[i], x, y, tol)) { hit = list[i]; break; }
      edOpenTextBox(pv, hit ? hit.x : x, hit ? hit.y : y, hit);
      e.preventDefault();
    } else if (tool === "select") {
      if (ED.selected && ED.selected.t === "image" && ED.selectedPage === pv.index) {
        const sb = edMarkBounds(ED.selected);
        if (Math.hypot(x - sb.x1, y - sb.y1) <= 12 / pv.scale) {
          const sm = ED.selected;
          drag = { resize: sm, old: { x: sm.x, y: sm.y, w: sm.w, h: sm.h }, ratio: sm.w / sm.h };
          o.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
      }
      const list = ED.marks[pv.index];
      let hit = null;
      for (let i = list.length - 1; i >= 0; i--) if (edHit(list[i], x, y, tol)) { hit = list[i]; break; }
      ED.selected = hit;
      ED.selectedPage = hit ? pv.index : -1;
      edRedrawAll();
      if (hit) {
        drag = { mark: hit, last: [x, y], total: [0, 0] };
        o.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    }
  });

  o.addEventListener("pointermove", (e) => {
    if (pv.live) {
      const [x, y] = edPoint(pv, e);
      const last = pv.live.pts[pv.live.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) * pv.scale >= 1.5) {
        pv.live.pts.push([x, y]);
        edRedraw(pv);
      }
    } else if (drag && drag.erasing) {
      const [x, y] = edPoint(pv, e);
      edErase(pv, x, y, 6 / pv.scale);
    } else if (drag && drag.resize) {
      const [x] = edPoint(pv, e);
      const m = drag.resize;
      m.w = Math.max(24, x - m.x);
      m.h = m.w / drag.ratio;
      edRedraw(pv);
    } else if (drag && drag.mark) {
      const [x, y] = edPoint(pv, e);
      const dx = x - drag.last[0], dy = y - drag.last[1];
      edMoveMark(drag.mark, dx, dy);
      drag.last = [x, y];
      drag.total[0] += dx; drag.total[1] += dy;
      edRedraw(pv);
    }
  });

  const finish = () => {
    if (pv.live) {
      const m = pv.live;
      pv.live = null;
      ED.marks[pv.index].push(m);
      ED.undo.push({ k: "add", pi: pv.index, m });
      edChanged();
      edRedraw(pv);
    }
    if (drag && drag.mark && (drag.total[0] || drag.total[1])) {
      ED.undo.push({ k: "move", m: drag.mark, dx: drag.total[0], dy: drag.total[1] });
      edChanged();
    }
    if (drag && drag.resize && (drag.resize.w !== drag.old.w)) {
      ED.undo.push({ k: "resize", m: drag.resize, old: drag.old });
      edChanged();
    }
    drag = null;
  };
  o.addEventListener("pointerup", finish);
  o.addEventListener("pointercancel", finish);
}

function edMoveMark(m, dx, dy) {
  if (m.t === "ink") m.pts.forEach((p) => { p[0] += dx; p[1] += dy; });
  else { m.x += dx; m.y += dy; }
}

function edErase(pv, x, y, tol) {
  const list = ED.marks[pv.index];
  for (let i = list.length - 1; i >= 0; i--) {
    if (edHit(list[i], x, y, tol)) {
      const m = list.splice(i, 1)[0];
      if (ED.selected === m) ED.selected = null;
      ED.undo.push({ k: "remove", pi: pv.index, m, index: i });
      edChanged();
      edRedraw(pv);
      return;
    }
  }
}

function edDeleteSelected() {
  const m = ED.selected;
  const pi = ED.selectedPage;
  if (!m || pi < 0) return;
  const list = ED.marks[pi];
  const i = list.indexOf(m);
  if (i < 0) return;
  list.splice(i, 1);
  ED.undo.push({ k: "remove", pi, m, index: i });
  ED.selected = null;
  edChanged();
  edRedrawAll();
}

function edUndo() {
  const a = ED.undo.pop();
  if (!a) return;
  if (a.k === "add") {
    const list = ED.marks[a.pi];
    const i = list.indexOf(a.m);
    if (i >= 0) list.splice(i, 1);
    if (ED.selected === a.m) ED.selected = null;
  } else if (a.k === "remove") {
    ED.marks[a.pi].splice(Math.min(a.index, ED.marks[a.pi].length), 0, a.m);
  } else if (a.k === "move") {
    edMoveMark(a.m, -a.dx, -a.dy);
  } else if (a.k === "edit") {
    a.m.text = a.old;
  } else if (a.k === "recolor") {
    a.m.color = a.old;
  } else if (a.k === "resize") {
    Object.assign(a.m, a.old);
  }
  edEl("ed-undo").disabled = ED.undo.length === 0;
  ED.dirty = true;
  edRemoveDownload();
  edRedrawAll();
}

// ---------- typing text on the page ----------

function edCloseTextBox(commit) {
  const tb = ED && ED.textBox;
  if (!tb) return;
  ED.textBox = null;
  const value = tb.input.value.replace(/\s+$/, "");
  tb.input.remove();
  if (!commit) return;
  const pi = tb.pv.index;
  if (tb.mark) {
    if (!value) {
      const list = ED.marks[pi];
      const i = list.indexOf(tb.mark);
      if (i >= 0) { list.splice(i, 1); ED.undo.push({ k: "remove", pi, m: tb.mark, index: i }); edChanged(); }
    } else if (value !== tb.mark.text) {
      ED.undo.push({ k: "edit", m: tb.mark, old: tb.mark.text });
      tb.mark.text = value;
      edChanged();
    }
  } else if (value) {
    const m = { t: "text", x: tb.x, y: tb.y, text: value, size: ED_TEXT_SIZES[ED.sizeIndex], color: ED.color };
    ED.marks[pi].push(m);
    ED.undo.push({ k: "add", pi, m });
    edChanged();
  }
  edRedraw(tb.pv);
}

function edOpenTextBox(pv, x, y, mark) {
  edCloseTextBox(true);
  const size = mark ? mark.size : ED_TEXT_SIZES[ED.sizeIndex];
  const color = mark ? mark.color : ED.color;
  const ta = document.createElement("textarea");
  ta.className = "ed-textbox";
  ta.value = mark ? mark.text : "";
  ta.rows = 1;
  ta.style.left = x * pv.scale + "px";
  ta.style.top = y * pv.scale + "px";
  ta.style.fontSize = size * pv.scale + "px";
  ta.style.lineHeight = "1.2";
  ta.style.color = color;
  ta.style.minWidth = Math.max(60, size * pv.scale * 4) + "px";
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    ta.style.width = Math.max(ta.scrollWidth, parseFloat(ta.style.minWidth)) + "px";
  };
  ta.addEventListener("input", fit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); edCloseTextBox(false); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); edCloseTextBox(true); }
  });
  ta.addEventListener("blur", () => { if (ED && ED.textBox && ED.textBox.input === ta) edCloseTextBox(true); });
  pv.wrap.appendChild(ta);
  ED.textBox = { input: ta, pv, x, y, mark };
  fit();
  setTimeout(() => ta.focus(), 0);
}

// ---------- saving ----------

async function edPlaceCanvas(doc, page, vp1, rot, canvas, b) {
  // draws a canvas picture on the page so it sits exactly where the box b is on screen
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const img = await doc.embedPng(await blob.arrayBuffer());
  const p = vp1.convertToPdfPoint(b.x0, b.y1);
  page.drawImage(img, { x: p[0], y: p[1], width: b.x1 - b.x0, height: b.y1 - b.y0, rotate: PDFLib.degrees(rot) });
}

async function edRasterMark(doc, page, vp1, rot, m) {
  const b = edMarkBounds(m);
  const pad = 2;
  const box = { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
  const k = 3;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil((box.x1 - box.x0) * k));
  c.height = Math.max(1, Math.ceil((box.y1 - box.y0) * k));
  const g = c.getContext("2d");
  g.scale(k, k);
  g.translate(-box.x0, -box.y0);
  edDrawMark(g, m);
  await edPlaceCanvas(doc, page, vp1, rot, c, box);
}

async function edExport() {
  let doc;
  try {
    doc = await PDFLib.PDFDocument.load(ED.bytes);
  } catch (e) {
    throw new Error("This PDF is password protected, so it cannot be saved with changes.");
  }
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 0; i < ED.marks.length; i++) {
    const list = ED.marks[i];
    if (!list.length) continue;
    const vp1 = ED.pageViews[i] ? ED.pageViews[i].page.getViewport({ scale: 1 }) : (await ED.pdf.getPage(i + 1)).getViewport({ scale: 1 });
    const rot = ((vp1.rotation % 360) + 360) % 360;
    const page = doc.getPage(i);
    const toUser = (x, y) => { const p = vp1.convertToPdfPoint(x, y); return { x: p[0], y: p[1] }; };
    for (const m of list) {
      if (m.t === "ink" && m.alpha >= 1) {
        const color = edHexToRgb(m.color);
        if (m.pts.length === 1) {
          const c = toUser(m.pts[0][0], m.pts[0][1]);
          page.drawCircle({ x: c.x, y: c.y, size: m.w / 2, color });
        } else {
          for (let j = 1; j < m.pts.length; j++) {
            page.drawLine({
              start: toUser(m.pts[j - 1][0], m.pts[j - 1][1]), end: toUser(m.pts[j][0], m.pts[j][1]),
              thickness: m.w, color, lineCap: PDFLib.LineCapStyle.Round,
            });
          }
        }
      } else if (m.t === "ink") {
        await edRasterMark(doc, page, vp1, rot, m); // see-through highlight is saved as a small picture
      } else if (m.t === "image") {
        const bin = atob(m.src.split(",")[1]);
        const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
        const img = await doc.embedPng(bytes);
        const p = vp1.convertToPdfPoint(m.x, m.y + m.h);
        page.drawImage(img, { x: p[0], y: p[1], width: m.w, height: m.h, rotate: PDFLib.degrees(rot) });
      } else if (m.t === "text") {
        const lines = edTextLines(m);
        let ok = true;
        try { lines.forEach((ln) => font.encodeText(ln)); } catch (e) { ok = false; }
        if (ok) {
          lines.forEach((ln, k) => {
            if (!ln) return;
            const p = toUser(m.x, m.y + m.size * 0.8 + k * m.size * 1.2);
            page.drawText(ln, { x: p.x, y: p.y, size: m.size, font, color: edHexToRgb(m.color), rotate: PDFLib.degrees(rot) });
          });
        } else {
          await edRasterMark(doc, page, vp1, rot, m); // letters Helvetica does not have (for example Myanmar) are saved as a picture
        }
      }
    }
  }
  return new Blob([await doc.save()], { type: "application/pdf" });
}

async function edSave() {
  if (!ED) return;
  edCloseTextBox(true);
  const btn = edEl("ed-save");
  btn.disabled = true;
  edEl("results").innerHTML = "";
  setStatus("Saving…");
  try {
    const blob = await edExport();
    const name = baseName(ED.file.name) + "-edited.pdf";
    edRemoveDownload();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.id = "ed-download";
    a.className = "btn small ok";
    a.href = url;
    a.dataset.url = url;
    a.download = name;
    a.textContent = "Download your edited PDF (" + fmtSize(blob.size) + ")";
    const bar = document.querySelector(".ed-bar");
    bar.insertBefore(a, bar.firstChild);
    bar.scrollLeft = 0;
    setStatus("Saved! Use the green button at the top to download your edited PDF.");
    ED.dirty = false;
  } catch (e) {
    console.error(e);
    setStatus(e && e.message ? e.message : "Something went wrong. Please try again.", true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- signing ----------

// Cuts the empty edges off the drawn signature
function edTrimCanvas(src) {
  const w = src.width, h = src.height;
  const d = src.getContext("2d").getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function edStartSign() {
  if (!ED) return;
  edCloseTextBox(true);
  edOpenSignPad((dataUrl, w, h) => edAddSignature(dataUrl, w, h));
}

// The window where you draw your signature. It is only kept in memory while this page is open.
function edOpenSignPad(onDone) {
  const back = document.createElement("div");
  back.className = "ed-modal";
  back.innerHTML =
    '<div class="ed-dialog" role="dialog" aria-modal="true" aria-label="Draw your signature">' +
    "<h2>Draw your signature</h2>" +
    '<p class="muted">Use your finger, a pen or the mouse.</p>' +
    '<canvas class="ed-pad" width="900" height="360"></canvas>' +
    '<div class="ed-pad-row"><span>Ink</span><span class="ed-pad-inks"></span><button type="button" class="btn small ghost" data-act="clear">Clear</button>' +
    (ED.lastSignature ? '<button type="button" class="btn small ghost" data-act="last">Use last signature</button>' : "") +
    "</div>" +
    '<p class="ed-pad-msg" role="alert"></p>' +
    '<div class="ed-actions"><button type="button" class="btn ghost" data-act="cancel">Cancel</button><button type="button" class="btn" data-act="use">Use signature</button></div>' +
    "</div>";
  document.body.appendChild(back);
  const pad = back.querySelector(".ed-pad");
  const g = pad.getContext("2d");
  g.lineCap = "round";
  g.lineJoin = "round";
  g.lineWidth = 6;
  let ink = "#111111";
  let drawing = false;
  let last = null;
  let any = false;
  const pos = (e) => {
    const r = pad.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * pad.width, ((e.clientY - r.top) / r.height) * pad.height];
  };
  pad.addEventListener("pointerdown", (e) => {
    drawing = true;
    last = pos(e);
    any = true;
    g.fillStyle = ink;
    g.beginPath();
    g.arc(last[0], last[1], 3, 0, Math.PI * 2);
    g.fill();
    pad.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    g.strokeStyle = ink;
    g.beginPath();
    g.moveTo(last[0], last[1]);
    g.lineTo(p[0], p[1]);
    g.stroke();
    last = p;
  });
  const stop = () => { drawing = false; };
  pad.addEventListener("pointerup", stop);
  pad.addEventListener("pointercancel", stop);
  [["#111111", "Black"], ["#1e3a9a", "Blue"], ["#c62828", "Red"]].forEach(([c, name]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ed-swatch" + (c === ink ? " on" : "");
    b.style.background = c;
    b.setAttribute("aria-label", name + " ink");
    b.onclick = () => {
      ink = c;
      back.querySelectorAll(".ed-pad-inks .ed-swatch").forEach((x) => x.classList.toggle("on", x === b));
    };
    back.querySelector(".ed-pad-inks").appendChild(b);
  });
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { document.removeEventListener("keydown", onKey); back.remove(); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("click", (e) => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (act === "clear") {
      g.clearRect(0, 0, pad.width, pad.height);
      any = false;
      back.querySelector(".ed-pad-msg").textContent = "";
    } else if (act === "cancel") {
      close();
    } else if (act === "last") {
      close();
      onDone(ED.lastSignature.dataUrl, ED.lastSignature.w, ED.lastSignature.h);
    } else if (act === "use") {
      const trimmed = any ? edTrimCanvas(pad) : null;
      if (!trimmed) { back.querySelector(".ed-pad-msg").textContent = "Please draw your signature first."; return; }
      const dataUrl = trimmed.toDataURL("image/png");
      ED.lastSignature = { dataUrl, w: trimmed.width, h: trimmed.height };
      close();
      onDone(dataUrl, trimmed.width, trimmed.height);
    }
  });
}

// Puts the signature on the page you are looking at, then lets you move and resize it
function edAddSignature(dataUrl, pxW, pxH) {
  let best = ED.pageViews[0];
  let bestVisible = -1;
  ED.pageViews.forEach((pv) => {
    const r = pv.wrap.getBoundingClientRect();
    const visible = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (visible > bestVisible) { bestVisible = visible; best = pv; }
  });
  const pv = best;
  const r = pv.wrap.getBoundingClientRect();
  const w = Math.min(180, pv.w1 * 0.5);
  const h = (w * pxH) / pxW;
  const centerY = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
  const y = Math.max(8, Math.min(pv.h1 - h - 8, ((centerY - r.top) / r.height) * pv.h1 - h / 2));
  const img = new Image();
  const m = { t: "image", x: (pv.w1 - w) / 2, y, w, h, src: dataUrl, img };
  img.onload = () => edRedrawAll();
  img.src = dataUrl;
  ED.marks[pv.index].push(m);
  ED.undo.push({ k: "add", pi: pv.index, m });
  edChanged();
  edSetTool("select");
  ED.selected = m;
  ED.selectedPage = pv.index;
  edRedrawAll();
}
