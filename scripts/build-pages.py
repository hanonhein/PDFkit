# Builds one search-friendly page per tool (merge-pdf.html, split-pdf.html ...) from index.html,
# and writes sitemap.xml. Run:  python scripts/build-pages.py   (from the website folder)
# The text of every page is in the PAGES list below. The scripts folder is NOT published (see .assetsignore).
import io, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://pdfeditorkit.app"

COMMON_Q = [
    ("Is it really free?", "Yes. There is no sign-up, no limit on how many files you use and no watermark added to your result."),
    ("Are my files uploaded to a server?", "No. This tool runs inside your browser, so your file never leaves your device. You can read the details on the privacy page."),
]

# slug, tool id (as in app.js), page title, meta description, title shown on the page (must match app.js), intro, steps, why, extra questions, related slugs
PAGES = [
    dict(slug="merge-pdf", id="merge", title="Merge PDF: combine PDF files free, no upload | PDF Editor Kit",
         desc="Merge PDF files into one document online for free. No sign-up, no watermark, and your files never leave your device.",
         h1="Merge PDF",
         intro="Put two or more PDF files together into one PDF. You choose the order, and the merged file is made on your own device.",
         steps=["Choose the PDF files you want to combine, or drop them on the page.", "Use the arrows to put them in the right order.", "Click Merge PDFs and download your new PDF."],
         why=["Combine as many files as you need.", "Set the order with simple arrows.", "Nothing is uploaded, so private documents stay private."],
         faq=[("How do I combine PDF files into one?", "Add your files, put them in order with the arrows and click Merge PDFs. The new file downloads right away."),
              ("Can I merge PDFs on my phone?", "Yes. The tool works in a phone browser. There is also a free Android app, and apps for Windows and Mac.")],
         related=["split-pdf", "organize-pdf", "compress-pdf"]),
    dict(slug="split-pdf", id="split", title="Split PDF: cut a PDF into parts free, no upload | PDF Editor Kit",
         desc="Split a PDF into equal parts, by page ranges, or one file per page. Free, no sign-up, and your file stays on your device.",
         h1="Split PDF",
         intro="Cut one PDF into smaller files. Split it into equal parts, pick your own page ranges, or save every page as its own PDF.",
         steps=["Choose the PDF you want to split.", "Pick a mode: equal parts, custom page ranges, or one file per page.", "Click Split and download the files."],
         why=["Three ways to split: equal parts, ranges, or one file per page.", "Several results are saved together so you can download them easily.", "Your PDF is never uploaded."],
         faq=[("How do I split a PDF into separate pages?", "Choose One file per page, then click Split. Each page becomes its own PDF."),
              ("How do I take only some pages out of a PDF?", "Choose Custom page ranges and type the pages you want, for example 1-3, 5, 8-10. Each range becomes its own file.")],
         related=["merge-pdf", "organize-pdf", "compress-pdf"]),
    dict(slug="organize-pdf", id="organize", title="Organize PDF pages: rotate, delete, reorder free | PDF Editor Kit",
         desc="Rotate, delete and reorder PDF pages online for free. See every page, fix it and save. No sign-up, and nothing is uploaded.",
         h1="Organize pages",
         intro="See every page of your PDF as a picture. Rotate pages, delete the ones you do not need and change their order.",
         steps=["Choose your PDF. Every page appears as a small picture.", "Use the buttons under each page to rotate, delete or move it.", "Save the new PDF."],
         why=["See what you are changing.", "Rotate, delete and reorder in one place.", "Everything happens on your device."],
         faq=[("How do I rotate one page in a PDF?", "Open the PDF here and click the rotate button under that page. Then save the new file."),
              ("How do I delete pages from a PDF?", "Click the delete button under each page you do not want, then save. Your original file is not changed.")],
         related=["split-pdf", "merge-pdf", "add-page-numbers-to-pdf"]),
    dict(slug="compress-pdf", id="compress", title="Compress PDF: make a PDF file smaller free | PDF Editor Kit",
         desc="Reduce the size of a PDF by shrinking the pictures inside it. Free, no sign-up, and your file never leaves your device.",
         h1="Compress PDF",
         intro="Make a PDF smaller by shrinking the pictures inside it. Text stays real text. If the file cannot get smaller, you keep your original.",
         steps=["Choose your PDF.", "Pick how strong the compression should be.", "Click Compress PDF and compare the sizes before you download."],
         why=["Text stays sharp and selectable.", "You keep your original if the result is not smaller.", "No upload, so private files stay private."],
         faq=[("How do I reduce the size of a PDF to send it by email?", "Compress it here, check the new size, and download it. PDFs with many photos or scans get the smallest."),
              ("Why did my PDF not get smaller?", "Some PDFs are already small, or have mostly text. In that case there is little to shrink and you simply keep your original file.")],
         related=["merge-pdf", "split-pdf", "pdf-to-jpg"]),
    dict(slug="add-page-numbers-to-pdf", id="numbers", title="Add page numbers to PDF free, no upload | PDF Editor Kit",
         desc="Add page numbers to a PDF online for free. Choose the position, the first number and the size. Nothing is uploaded.",
         h1="Page numbers",
         intro="Put a page number on every page of your PDF. Choose where it goes, which number to start from and how big it is.",
         steps=["Choose your PDF.", "Pick the position, the starting number and the size.", "Click the button and download your numbered PDF."],
         why=["Choose the position on the page.", "Start from any number.", "Your file stays on your device."],
         faq=[("How do I add page numbers to a PDF?", "Choose the PDF, pick where the numbers go, and click the button. The numbered PDF downloads to your device."),
              ("Can I start numbering from a number other than 1?", "Yes. Set the starting number before you create the file.")],
         related=["watermark-pdf", "organize-pdf", "merge-pdf"]),
    dict(slug="watermark-pdf", id="watermark", title="Add a watermark to PDF free, no upload | PDF Editor Kit",
         desc="Stamp text like DRAFT or CONFIDENTIAL across every page of a PDF. Free, no sign-up, and your file stays on your device.",
         h1="Watermark",
         intro="Stamp text diagonally across every page of your PDF, for example DRAFT or CONFIDENTIAL.",
         steps=["Choose your PDF.", "Type the watermark text and adjust how it looks.", "Click the button and download your watermarked PDF."],
         why=["Works on every page at once.", "You choose the text.", "Nothing is uploaded."],
         faq=[("How do I put a watermark on a PDF?", "Choose the PDF, type your text and click the button. The watermark is added to every page."),
              ("Does the watermark change my original file?", "No. You get a new file, and your original stays as it was.")],
         related=["add-page-numbers-to-pdf", "protect-pdf", "sign-pdf"]),
    dict(slug="images-to-pdf", id="img2pdf", title="Images to PDF: turn JPG and PNG into a PDF free | PDF Editor Kit",
         desc="Turn photos and pictures (JPG, PNG and more) into one PDF online for free. Set the order. Nothing is uploaded.",
         h1="Images to PDF",
         intro="Turn photos or pictures into one PDF. Add as many as you want and put them in the order you like.",
         steps=["Choose your pictures, or drop them on the page.", "Use the arrows to set the order and pick the page size.", "Click the button and download your PDF."],
         why=["Many pictures into one PDF.", "You set the order.", "Your photos never leave your device."],
         faq=[("How do I convert JPG to PDF?", "Add your JPG files, set the order and click the button. You get one PDF with a page for each picture."),
              ("Can I turn photos from my phone into a PDF?", "Yes. Open this page in your phone browser and choose your photos. There is also a free Android app with a document scanner.")],
         related=["pdf-to-jpg", "merge-pdf", "compress-pdf"]),
    dict(slug="pdf-to-jpg", id="pdf2img", title="PDF to JPG and PNG: save PDF pages as pictures free | PDF Editor Kit",
         desc="Convert PDF pages to JPG or PNG pictures online for free. No sign-up, and your PDF never leaves your device.",
         h1="PDF to images",
         intro="Save every page of a PDF as a picture. Choose PNG or JPG.",
         steps=["Choose your PDF.", "Choose PNG or JPG.", "Click the button and download the pictures."],
         why=["Every page becomes its own picture.", "PNG or JPG, your choice.", "Nothing is uploaded."],
         faq=[("How do I convert a PDF to a photo?", "Choose the PDF, pick JPG or PNG and click the button. Each page is saved as a picture."),
              ("Which is better, JPG or PNG?", "JPG files are smaller and good for photos. PNG is sharper for text and drawings.")],
         related=["images-to-pdf", "pdf-to-word", "compress-pdf"]),
    dict(slug="pdf-to-word", id="pdf2word", title="PDF to Word: convert PDF to an editable DOCX free | PDF Editor Kit",
         desc="Convert a PDF to an editable Word file (.docx) online for free. No sign-up, and your PDF never leaves your device.",
         h1="PDF to Word",
         intro="Make an editable Word file (.docx) from your PDF. The words are kept. The layout and pictures may change.",
         steps=["Choose your PDF.", "Click the button.", "Download the Word file and open it in Word or Google Docs."],
         why=["Get text you can edit.", "Works for Google Docs too: upload the .docx there.", "Your PDF is never uploaded."],
         faq=[("How do I convert a PDF to a Word document?", "Choose the PDF and click the button. You download a .docx file you can open in Word."),
              ("Will the layout look exactly the same?", "Not always. Words are kept, but layout and pictures may change, especially in complicated PDFs. A scanned PDF has no words to copy.")],
         related=["pdf-to-excel", "pdf-to-powerpoint", "word-to-pdf"]),
    dict(slug="pdf-to-excel", id="pdf2excel", title="PDF to Excel: convert PDF tables to XLSX free | PDF Editor Kit",
         desc="Convert a PDF to an Excel file (.xlsx) online for free. Each page becomes a sheet. Nothing is uploaded.",
         h1="PDF to Excel",
         intro="Make an Excel file (.xlsx) from your PDF. Each page becomes a sheet and each line a row. Tables work best.",
         steps=["Choose your PDF.", "Click the button.", "Download the Excel file and open it in Excel or Google Sheets."],
         why=["Each page becomes a sheet.", "Works for Google Sheets too.", "Your PDF is never uploaded."],
         faq=[("How do I get a table from a PDF into Excel?", "Convert the PDF here and open the .xlsx file. PDFs with clear tables give the best result."),
              ("Why are some columns not perfect?", "A PDF does not store tables as tables, so columns are guessed from the gaps between words. You may need to tidy a few cells.")],
         related=["pdf-to-word", "pdf-to-powerpoint", "excel-to-pdf"]),
    dict(slug="pdf-to-powerpoint", id="pdf2ppt", title="PDF to PowerPoint: convert PDF to PPTX free | PDF Editor Kit",
         desc="Convert a PDF to a PowerPoint file (.pptx) online for free, one slide per page. Nothing is uploaded.",
         h1="PDF to PowerPoint",
         intro="Make a PowerPoint file (.pptx) with one slide for each page of your PDF. The slides look like the pages but are pictures.",
         steps=["Choose your PDF.", "Click the button.", "Download the .pptx file and open it in PowerPoint or Google Slides."],
         why=["One slide per page.", "The slides look just like your pages.", "Your PDF is never uploaded."],
         faq=[("Can I edit the text on the slides?", "The slides are pictures of your pages, so the text is not editable. This keeps the look exactly the same."),
              ("How do I turn a PDF into slides?", "Choose the PDF and click the button. You download a .pptx file with one slide per page.")],
         related=["pdf-to-word", "pdf-to-excel", "powerpoint-to-pdf"]),
    dict(slug="word-to-pdf", id="word2pdf", title="Word to PDF: convert DOCX to PDF free, no upload | PDF Editor Kit",
         desc="Convert a Word document (.docx) to PDF online for free. No sign-up, and your file never leaves your device.",
         h1="Word to PDF",
         intro="Turn a Word file (.docx) into a PDF. For Google Docs, download the file as .docx first.",
         steps=["Choose your Word file (.docx).", "Click the button.", "Download the PDF."],
         why=["Fast, right in your browser.", "No Word needed.", "Your document is never uploaded."],
         faq=[("How do I convert a Word document to PDF?", "Choose the .docx file and click the button. The PDF downloads to your device."),
              ("What about old .doc files?", "Open the file in Word and save it as .docx first, then convert it here.")],
         related=["excel-to-pdf", "powerpoint-to-pdf", "pdf-to-word"]),
    dict(slug="excel-to-pdf", id="excel2pdf", title="Excel to PDF: convert XLSX to PDF free, no upload | PDF Editor Kit",
         desc="Convert an Excel file (.xlsx, .xls or .csv) to PDF online for free. Every sheet becomes a table. Nothing is uploaded.",
         h1="Excel to PDF",
         intro="Turn an Excel file (.xlsx, .xls or .csv) into a PDF. Every sheet becomes a table. For Google Sheets, download the file as .xlsx first.",
         steps=["Choose your Excel or CSV file.", "Click the button.", "Download the PDF."],
         why=["Works with .xlsx, .xls and .csv.", "Every sheet is included.", "Your spreadsheet is never uploaded."],
         faq=[("How do I save an Excel sheet as a PDF?", "Choose your file here and click the button. Each sheet becomes a table in the PDF."),
              ("Can I convert a CSV file to PDF?", "Yes. CSV files are accepted as well as Excel files.")],
         related=["word-to-pdf", "powerpoint-to-pdf", "pdf-to-excel"]),
    dict(slug="powerpoint-to-pdf", id="ppt2pdf", title="PowerPoint to PDF: convert PPTX to PDF free | PDF Editor Kit",
         desc="Convert a PowerPoint file (.pptx) to PDF online for free, one page per slide. Nothing is uploaded.",
         h1="PowerPoint to PDF",
         intro="Turn a PowerPoint file (.pptx) into a PDF with one page for each slide. For Google Slides, download the file as .pptx first. Charts and animations are left out.",
         steps=["Choose your .pptx file.", "Click the button.", "Download the PDF."],
         why=["One page per slide.", "No PowerPoint needed.", "Your presentation is never uploaded."],
         faq=[("How do I save a PowerPoint as a PDF?", "Choose the .pptx file and click the button. You get a PDF with one page per slide."),
              ("Are animations kept?", "No. A PDF cannot hold animations, and charts are left out.")],
         related=["word-to-pdf", "excel-to-pdf", "pdf-to-powerpoint"]),
    dict(slug="edit-pdf", id="edit", title="Edit PDF online free: draw, highlight, add text | PDF Editor Kit",
         desc="Edit a PDF online for free: draw, highlight, erase and add text. No sign-up, and your file stays on your device.",
         h1="Edit PDF",
         intro="Draw, highlight, sign and add text to a PDF. Everything happens in your browser, and your file stays on your device.",
         steps=["Choose your PDF.", "Pick a tool: pen, highlight, text or eraser, and a colour.", "Click Save PDF and download your edited file."],
         why=["Pen, highlighter, text, eraser and undo.", "Move or delete anything you added.", "Your PDF is never uploaded."],
         faq=[("How do I add text to a PDF?", "Open the PDF here, choose the text tool, click on the page and type. Then save the PDF."),
              ("Can I change the original words in a PDF?", "This tool adds drawings, highlights and text on top of the page. It does not rewrite the original text.")],
         related=["sign-pdf", "watermark-pdf", "organize-pdf"]),
    dict(slug="sign-pdf", id="sign", title="Sign PDF online free: draw your signature | PDF Editor Kit",
         desc="Sign a PDF online for free. Draw your signature, place it on the page and save. Your file and signature stay on your device.",
         h1="Sign PDF",
         intro="Draw your signature and place it on the page. Your file and your signature stay on your device.",
         steps=["Choose your PDF.", "Draw your signature with your mouse or finger.", "Place it on the page, resize it and save the PDF."],
         why=["Draw with mouse, finger or pen.", "Move and resize the signature.", "Your signature is never saved on a server."],
         faq=[("How do I sign a PDF without printing it?", "Open the PDF here, draw your signature, put it where you need it and save the new PDF."),
              ("Is my signature stored anywhere?", "No. It is kept only in your browser while the page is open and is gone when you close it.")],
         related=["edit-pdf", "protect-pdf", "watermark-pdf"]),
    dict(slug="protect-pdf", id="protect", title="Protect PDF with a password free, AES-256 | PDF Editor Kit",
         desc="Add a password to a PDF online for free. Strong AES-256 encryption, and your file never leaves your device.",
         h1="Protect PDF",
         intro="Add a password so only people who know it can open the PDF. It is locked with strong AES-256 encryption.",
         steps=["Choose your PDF.", "Type a password twice.", "Click the button and download your locked PDF."],
         why=["Strong AES-256 encryption.", "The password never leaves your device.", "No account needed."],
         faq=[("How do I put a password on a PDF?", "Choose the PDF, type a password twice and click the button. The new PDF asks for the password when it is opened."),
              ("What if I forget the password?", "We cannot recover it, because it never leaves your device. Write it down somewhere safe.")],
         related=["remove-pdf-password", "sign-pdf", "watermark-pdf"]),
    dict(slug="remove-pdf-password", id="unlock", title="Remove PDF password free (when you know it) | PDF Editor Kit",
         desc="Remove the password from a PDF when you know it. Free, no sign-up, and your file never leaves your device.",
         h1="Remove password",
         intro="Take the password off a PDF when you know it. Only unlock files you are allowed to open.",
         steps=["Choose your locked PDF.", "Type the password.", "Click the button and download the PDF without a password."],
         why=["Opens with the password you know.", "Works on your device.", "Your PDF is never uploaded."],
         faq=[("How do I remove the password from a PDF?", "Choose the PDF, type its password and click the button. You get a copy that opens without a password."),
              ("Can you open a PDF if I do not know the password?", "No. This tool only works with the correct password. It does not guess or crack passwords.")],
         related=["protect-pdf", "edit-pdf", "merge-pdf"]),
]

TITLES = {p["slug"]: p["h1"] for p in PAGES}


def read(path):
    return io.open(os.path.join(ROOT, path), encoding="utf-8", newline="").read().replace("\r\n", "\n")


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def build_page(base, p):
    s = base
    url = f"{SITE}/{p['slug']}"
    # head
    s = re.sub(r"<title>.*?</title>", f"<title>{esc(p['title'])}</title>", s, count=1)
    s = re.sub(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{esc(p["desc"])}">', s, count=1)
    s = re.sub(r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{url}">', s, count=1)
    s = s.replace("<body>", f'<body data-tool="{p["id"]}">', 1)
    ld = {
        "@context": "https://schema.org", "@type": "WebApplication", "name": f"{p['h1']} – PDF Editor Kit", "url": url,
        "applicationCategory": "UtilitiesApplication", "operatingSystem": "Any", "description": p["desc"],
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
    }
    faq = p["faq"] + COMMON_Q
    ld2 = {"@context": "https://schema.org", "@type": "FAQPage",
           "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq]}
    jsonld = ('<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False) + "</script>\n"
              '<script type="application/ld+json">' + json.dumps(ld2, ensure_ascii=False) + "</script>\n")
    s = s.replace("</head>", jsonld + "</head>", 1)
    # header links go to real pages
    s = s.replace('<a class="brand" href="#"', '<a class="brand" href="/"', 1)
    s = s.replace('<a href="#" class="nav-link">All tools</a>', '<a href="/" class="nav-link">All tools</a>', 1)
    # the home grid is not shown on a tool page (the script still needs the element)
    a = s.index('  <section id="home">')
    b = s.index("  <!-- TOOL view -->")
    s = s[:a] + '  <section id="home" hidden><div id="grid" class="grid"></div></section>\n\n' + s[b:]
    # the tool block: visible, with its title and text already in the HTML
    s = s.replace('<section id="tool" hidden>', '<section id="tool">', 1)
    s = s.replace('<a href="#" class="back">&larr; All tools</a>', '<a href="/" class="back">&larr; All tools</a>', 1)
    s = s.replace('<h1 id="tool-title"></h1>', f'<h1 id="tool-title">{esc(p["h1"])}</h1>', 1)
    s = s.replace('<p id="tool-desc" class="muted"></p>', '<p id="tool-desc" class="muted"></p>', 1)
    # the text under the tool
    steps = "".join(f"<li>{esc(x)}</li>" for x in p["steps"])
    why = "".join(f"<li>{esc(x)}</li>" for x in p["why"])
    faqs = "".join(f"<details><summary>{esc(q)}</summary><p>{esc(a)}</p></details>" for q, a in faq)
    rel = "".join(f'<li><a href="/{r}">{esc(TITLES[r])}</a></li>' for r in p["related"])
    seo = f'''
  <section class="seo">
    <h2>About {esc(p["h1"])}</h2>
    <p>{esc(p["intro"])}</p>
    <h2>How to use it</h2>
    <ol>{steps}</ol>
    <h2>Why use PDF Editor Kit</h2>
    <ul>{why}</ul>
    <h2>Questions</h2>
    {faqs}
    <h2>More PDF tools</h2>
    <ul class="related">{rel}<li><a href="/">All PDF tools</a></li></ul>
    <p class="muted">Also available as a free app for Android, Windows and Mac: <a href="/download">see downloads</a>.</p>
  </section>
'''
    s = s.replace("</main>", seo + "</main>", 1)
    return s


def main():
    base = read("index.html")
    for p in PAGES:
        html = build_page(base, p)
        io.open(os.path.join(ROOT, p["slug"] + ".html"), "w", encoding="utf-8", newline="\n").write(html)
    urls = [""] + ["download"] + [p["slug"] for p in PAGES] + ["privacy", "terms", "licenses"]
    sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    sm += "".join(f"  <url><loc>{SITE}/{u}</loc></url>\n" for u in urls) + "</urlset>\n"
    io.open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8", newline="\n").write(sm)
    print("built", len(PAGES), "pages")


if __name__ == "__main__":
    main()
