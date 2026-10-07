"use strict";
// Protect PDF (add a password) and Remove password. Everything runs in your browser.
// The password you type is only used on your device to lock or unlock the file. It is never sent anywhere.

const PW_ALL_ALLOWED = {
  printing: "highResolution", modifying: true, copying: true, annotating: true,
  fillingForms: true, contentAccessibility: true, documentAssembly: true,
};

function wirePasswordToggle() {
  const box = document.getElementById("o-show");
  if (!box) return;
  box.onchange = () => {
    document.querySelectorAll("#options input[data-pw]").forEach((i) => { i.type = box.checked ? "text" : "password"; });
  };
}

const securityTools = [
  {
    id: "protect", group: "Security", title: "Protect PDF", icon: "&#128274;", color: "orange", accept: ".pdf,application/pdf",
    desc: "Add a password so only people who know it can open the PDF. Locked with strong AES-256 encryption.",
    options: `
      <label>Password
        <input type="password" id="o-pw" data-pw autocomplete="new-password">
      </label>
      <label>Repeat password
        <input type="password" id="o-pw2" data-pw autocomplete="new-password">
      </label>
      <label class="check"><input type="checkbox" id="o-show"> Show password</label>
      <p class="hint">Write the password down. We cannot recover it for you, because it never leaves your device.</p>`,
    setup: wirePasswordToggle,
    async run(files, ctx) {
      const pw = document.getElementById("o-pw").value;
      const pw2 = document.getElementById("o-pw2").value;
      if (!pw) throw new Error("Please type a password.");
      if (pw !== pw2) throw new Error("The two passwords are not the same.");
      const bytes = await readBuffer(files[0]);
      let doc;
      try {
        doc = await PDFDocument.load(bytes);
      } catch (e) {
        if (/encrypt|password/i.test(String(e))) throw new Error(files[0].name + " already has a password. Use Remove password first.");
        throw new Error(files[0].name + " could not be read. Is it a valid PDF?");
      }
      ctx.progress(0.5);
      doc.encrypt({ userPassword: pw, ownerPassword: pw, permissions: PW_ALL_ALLOWED });
      const out = await doc.save();
      ctx.progress(1);
      ctx.note = "Your PDF now needs the password to open.";
      return [{ name: baseName(files[0].name) + "-protected.pdf", blob: pdfBlob(out) }];
    },
  },
  {
    id: "unlock", group: "Security", title: "Remove password", icon: "&#128275;", color: "orange", accept: ".pdf,application/pdf",
    desc: "Take the password off a PDF when you know it. Only unlock files you are allowed to open.",
    options: `
      <label>Password
        <input type="password" id="o-pw" data-pw autocomplete="off">
        <span class="hint">Leave empty if the PDF opens without a password but is limited (for example, printing is blocked).</span>
      </label>
      <label class="check"><input type="checkbox" id="o-show"> Show password</label>`,
    setup: wirePasswordToggle,
    async run(files, ctx) {
      const pw = document.getElementById("o-pw").value;
      const bytes = await readBuffer(files[0]);
      let probe;
      try {
        probe = await PDFDocument.load(bytes, { ignoreEncryption: true });
      } catch (e) {
        throw new Error(files[0].name + " could not be read. Is it a valid PDF?");
      }
      if (!probe.isEncrypted) throw new Error(files[0].name + " does not have a password.");
      ctx.progress(0.4);
      let doc;
      try {
        doc = await PDFDocument.load(bytes, { password: pw });
      } catch (e) {
        throw new Error(pw ? "That password is not correct." : "This PDF needs a password to open. Please type it above.");
      }
      const out = await doc.save();
      ctx.progress(1);
      ctx.note = "The password is removed.";
      return [{ name: baseName(files[0].name) + "-unlocked.pdf", blob: pdfBlob(out) }];
    },
  },
];
