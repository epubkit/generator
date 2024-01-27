import JSZip from 'jszip'
import { v4 as uuid } from 'uuid'
import { JSDOM } from 'jsdom'
import { parseSrcset, stringifySrcset } from 'srcset';
import xmlserializer from 'xmlserializer'

export class EpubGenerator {

  private zip = new JSZip()

  private bookId = uuid()

  constructor(private config: {
    // book title
    title: string,
    author?: string
  }, private options?: {
    debugMode?: boolean,
    // should return the image base64 string
    processImage?: (info: {
      fileName: string,
      ext: string,
      fileId: string,
    }) => Promise<string>
  }) {
  }

  private CONSTANTS = {
    publisher: "EpubKit",
    cssPath: "Styles/publication.css",
    opfPath: "content.opf",
    tocPath: "toc.xhtml",
    ncxPath: "toc.ncx",
    navPath: "nav.xhtml"
  }

  private images: Array<{
    id: string,
    href: string,
    mediaType: string
  }> = []

  private chapters: {
    title: string,
    id: string,
    html: string,
    href: string,
    url: string
  }[] = []
  private cover: {
    href: string
  } | null = null

  getContainer() {
    return `<?xml version="1.0" encoding="UTF-8" ?>
  <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
      <rootfile full-path="${this.CONSTANTS.opfPath}" media-type="application/oebps-package+xml"/>
    </rootfiles>
  </container>`
  }

  getContent() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookID">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:identifier id="BookId">${this.bookId}</dc:identifier>
   <dc:title>${this.config.title}</dc:title>
   <dc:publisher>${this.CONSTANTS.publisher}</dc:publisher>
   <dc:creator>${this.config.author || this.CONSTANTS.publisher}</dc:creator>
   <dc:language>
      en-US
   </dc:language>
  </metadata>
  <manifest>
   <item id="toc" href="${this.CONSTANTS.tocPath}" media-type="application/xhtml+xml" properties="nav"/>
    ${this.chapters.map((chapter, index) => `
    <item id="chapter-${index}" href="${chapter.href}" media-type="application/xhtml+xml"/>`).join("\n")}
    ${this.images.map(image => `<item id="${image.id}" href="${image.href}" media-type="${image.mediaType}"/>`).join("\n")}
   <item id="css" href="${this.CONSTANTS.cssPath}" media-type="text/css"/>
  </manifest>
  <spine>
   <itemref idref="toc"/>
   ${this.chapters.map((chapter, index) => `
   <itemref idref="chapter-${index}"/>`).join("\n")}
  </spine>
</package>`
  }

  private getToc() {
    return `<?xml version='1.0' encoding='UTF-8'?>
    <html xmlns:epub="http://www.idpf.org/2007/ops" xmlns="http://www.w3.org/1999/xhtml">
    <head>
      <title>Table of Contents</title>
      <meta charset="UTF-8" />
    </head>
    <body>
      <h1>Table of Contents</h1>
      <nav id="toc" epub:type="toc">
        <ol>
          <li><a href="toc.xhtml">Table of Contents</a></li>
          ${this.chapters
        .map(
          (chapter) =>
            `<li id="chapter-${chapter.id}"><a epub:type="bodymatter" href="chapters/${chapter.id}.xhtml">${chapter.title}</a></li>`
        )
        .join("\n")}
        </ol>
      </nav>
    </body>
    </html>
  `
  }

  getChapter(title: string, url: string, content: string) {
    const dom = new JSDOM(content)
    const document = dom.window.document

    const html = `<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE html>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
      <head>
      <meta charset="UTF-8" />
      <title>${title}</title>
      </head>
    <body>
      <h1>${title}</h1>
    <section epub:type="chapter">
      ${document.body.innerHTML}
  </section>
    </body>
    </html>
  `

    return xmlserializer.serializeToString(new JSDOM(html).window.document)
  }

  async processImage(el: HTMLImageElement) {
    const id = uuid()

    el.removeAttribute("style")
    el.removeAttribute("width")
    el.removeAttribute("height")

    let src = el.src

    if (el.srcset) {
      const parsed = parseSrcset(el.srcset)
      let url = ""
      let largestWidth = 0
      for (const item of parsed) {
        if (!item.width) {
          continue
        }
        if (item.width > largestWidth) {
          url = item.url
          largestWidth = item.width
        }
      }

      if (!url) {
        url = parsed[0].url
      }

      src = url
      el.removeAttribute("srcset")
    }

    const ext = new URL(src).pathname.split(".").pop()!
    const fileName = `${id}.${ext}`

    let imageBase64 = ""

    if (this.options?.processImage) {
      try {
        imageBase64 = await this.options?.processImage({
          fileName,
          ext,
          fileId: id
        })
      } catch (e) {

      }
    }

    if (imageBase64) {
      await this.zip.file(`chapters/${id}.${ext}`, imageBase64, { base64: true })
      el.src = `${id}.${ext}`
    }

    try {
      return {
        id,
        href: `chapters/${id}.${ext}`,
        mediaType: `image/${ext || "*"}`
      }

    } catch (e) {
      console.log('fetch image error', el.src)
    }
  }

  async addChapter(title: string, url: string, htmlContent: string) {
    const id = uuid()

    // parse image src to base64
    const doc = new JSDOM(htmlContent, {
      url
    }).window.document

    for (let el of doc.querySelectorAll("img")) {
      if (el.src.startsWith("data:")) { continue }

      const info = await this.processImage(el)
      if (info) {
        this.images.push(info)
      }
    }

    this.chapters.push({
      id,
      title,
      html: doc.body.innerHTML,
      href: `chapters/${id}.xhtml`,
      url
    })
    return this
  }

  async makeV2() {
    if (!this.options?.debugMode) {
      this.zip.file("mimetype", "application/epub+zip")
    }

    this.zip.file("META-INF/container.xml", this.getContainer())
    this.zip.file(this.CONSTANTS.opfPath, this.getContent())
    this.zip.file(this.CONSTANTS.tocPath, this.getToc())

    this.chapters.forEach(chapter => {
      this.zip.file(`chapters/${chapter.id}.xhtml`, this.getChapter(chapter.title, chapter.url, chapter.html))
    })

    return await this.zip.generateAsync({
      type: "nodebuffer"
    })
  }

}