import assert from "node:assert"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { basename as posixBasename } from "node:path/posix"
import { describe, it } from "node:test"

import { isAudioFile } from "@storyteller-platform/audiobook"
import { Epub, type ParsedXml } from "@storyteller-platform/epub"
import { type RecognitionResult } from "@storyteller-platform/ghost-story"

import { createLogger } from "../../common/logging.ts"
import { getXhtmlSegmentation } from "../../markup/segmentation.ts"
import { Aligner } from "../align.ts"

function createTestLogger() {
  return createLogger(process.env["CI"] ? "silent" : "info")
}

function sanitizeFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, "-") // Windows illegal chars
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim() // Trim trailing whitespace
    .replace(/[.]+$/, "") // No trailing dots
}

function truncate(input: string, byteLimit: number, suffix = ""): string {
  const normalized = input.normalize("NFC")
  const encoder = new TextEncoder()

  let result = ""
  for (const char of normalized) {
    const withSuffix = result + char + suffix
    const byteLength = encoder.encode(withSuffix).length

    if (byteLength > byteLimit) break
    result += char
  }

  return result + suffix
}

function getSafeFilepathSegment(name: string, suffix: string = "") {
  return truncate(sanitizeFilename(name), 150, suffix)
}

async function assertAlignSnapshotWithIdFragments(
  context: it.TestContext,
  epub: Epub,
  transcriptionFilepaths: string[],
) {
  const snapshotFilename = getSafeFilepathSegment(
    `${context.fullName} [id-fragment]`,
    ".snapshot",
  )
  const snapshotFilepath = join(
    "src",
    "align",
    "__snapshots__",
    snapshotFilename,
  )

  let newSnapshot = ""

  const manifest = await epub.getManifest()
  const mediaOverlayItems = Object.values(manifest)
    .map((item) => item.mediaOverlay)
    .filter((mediaOverlayId): mediaOverlayId is string => !!mediaOverlayId)
    .map((id) => manifest[id]!)

  const mediaOverlays: ParsedXml[] = []
  for (const item of mediaOverlayItems) {
    const contents = await epub.readItemContents(item.id, "utf-8")
    const parsed = Epub.xmlParser.parse(contents) as ParsedXml
    mediaOverlays.push(parsed)
    const smil = Epub.findXmlChildByName("smil", parsed)
    if (!smil) continue
    const body = Epub.findXmlChildByName("body", Epub.getXmlChildren(smil))
    if (!body) continue
    const seq = Epub.findXmlChildByName("seq", Epub.getXmlChildren(body))
    if (!seq) continue
    const textref = seq[":@"]?.["@_epub:textref"]
    if (!textref) continue
    newSnapshot += `// ${posixBasename(textref)}\n\n`
    const chapterContents = await epub.readFileContents(
      textref,
      item.href,
      "utf-8",
    )
    const chapterXml = Epub.xhtmlParser.parse(chapterContents) as ParsedXml
    const { result: segmentation } = await getXhtmlSegmentation(
      Epub.getXhtmlBody(chapterXml),
      {
        primaryLocale: new Intl.Locale("en-US"),
      },
    )
    const chapterSentences = segmentation.filter((s) => s.text.match(/\S/))
    for (const par of Epub.getXmlChildren(seq)) {
      newSnapshot += `\n`
      const text = Epub.findXmlChildByName("text", Epub.getXmlChildren(par))
      if (!text) continue
      const audio = Epub.findXmlChildByName("audio", Epub.getXmlChildren(par))
      if (!audio) continue

      const textSrc = text[":@"]?.["@_src"]
      if (!textSrc) continue
      const sentenceId = textSrc.match(/[0-9]+$/)?.[0]
      if (sentenceId === undefined) continue

      const textSentence = chapterSentences[parseInt(sentenceId)]?.text
      if (!textSentence) continue
      newSnapshot += `Text:  ${textSentence.replace(/\n/, "")}\n`

      const audioSrc = audio[":@"]?.["@_src"]
      if (!audioSrc) continue

      const audioStart = audio[":@"]?.["@_clipBegin"]
      const audioEnd = audio[":@"]?.["@_clipEnd"]
      if (!audioStart || !audioEnd) continue

      const audioStartTime = parseFloat(audioStart.slice(0, -1))
      const audioEndTime = parseFloat(audioEnd.slice(0, -1))

      const audioFilename = posixBasename(audioSrc, extname(audioSrc))
      const transcriptionFilepath = transcriptionFilepaths.find(
        (f) => basename(f, extname(f)) === audioFilename,
      )
      if (!transcriptionFilepath) continue

      const transcription = JSON.parse(
        await readFile(transcriptionFilepath, { encoding: "utf-8" }),
      ) as Pick<RecognitionResult, "transcript" | "timeline">

      const transcriptionWords: string[] = []
      let started = false
      let i = 0
      let word = transcription.timeline[i]
      while (word && word.endTime <= audioEndTime) {
        if (word.startTime >= audioStartTime) {
          started = true
        }
        if (started) {
          transcriptionWords.push(word.text)
        }
        word = transcription.timeline[++i]
      }

      const transcriptionSentence = transcriptionWords.join(" ")
      newSnapshot += `Audio: ${transcriptionSentence}\n`
    }

    newSnapshot += `\n`
  }

  if (process.env["UPDATE_SNAPSHOTS"]) {
    await mkdir(dirname(snapshotFilepath), { recursive: true })
    await writeFile(snapshotFilepath, newSnapshot, { encoding: "utf-8" })
    return
  }

  try {
    const existingSnapshot = await readFile(snapshotFilepath, {
      encoding: "utf-8",
    })

    const existingLines = existingSnapshot.split("\n")
    const newLines = newSnapshot.split("\n")
    for (let i = 0; i < existingLines.length; i++) {
      const existingLine = existingLines[i]
      const newLine = newLines[i]
      if (existingLine !== newLine) {
        assert.strictEqual(
          newLines.slice(Math.max(0, i - 5), i + 5),
          existingLines.slice(Math.max(0, i - 5), i + 5),
        )
      }
    }
  } catch (e) {
    if (e instanceof assert.AssertionError) {
      throw e
    }
    throw new assert.AssertionError({
      actual: newSnapshot,
      expected: "",
      diff: "simple",
    })
  }
}

async function assertAlignSnapshotWithTextFragments(
  context: it.TestContext,
  epub: Epub,
  transcriptionFilepaths: string[],
) {
  const snapshotFilename = getSafeFilepathSegment(
    `${context.fullName} [text-fragment]`,
    ".snapshot",
  )
  const snapshotFilepath = join(
    "src",
    "align",
    "__snapshots__",
    snapshotFilename,
  )

  let newSnapshot = ""

  const manifest = await epub.getManifest()
  const mediaOverlayItems = Object.values(manifest)
    .map((item) => item.mediaOverlay)
    .filter((mediaOverlayId): mediaOverlayId is string => !!mediaOverlayId)
    .map((id) => manifest[id]!)

  const mediaOverlays: ParsedXml[] = []
  for (const item of mediaOverlayItems) {
    const contents = await epub.readItemContents(item.id, "utf-8")
    const parsed = Epub.xmlParser.parse(contents) as ParsedXml
    mediaOverlays.push(parsed)
    const smil = Epub.findXmlChildByName("smil", parsed)
    if (!smil) continue
    const body = Epub.findXmlChildByName("body", Epub.getXmlChildren(smil))
    if (!body) continue
    const seq = Epub.findXmlChildByName("seq", Epub.getXmlChildren(body))
    if (!seq) continue
    const textref = seq[":@"]?.["@_epub:textref"]
    if (!textref) continue
    newSnapshot += `// ${posixBasename(textref)}\n\n`
    const chapterContents = await epub.readFileContents(
      textref,
      item.href,
      "utf-8",
    )
    const chapterXml = Epub.xhtmlParser.parse(chapterContents) as ParsedXml
    const { result: segmentation } = await getXhtmlSegmentation(
      Epub.getXhtmlBody(chapterXml),
      {
        primaryLocale: new Intl.Locale("en-US"),
      },
    )
    let lastChapterSentence = -1
    const chapterSentences = segmentation.filter((s) => s.text.match(/\S/))
    for (const par of Epub.getXmlChildren(seq)) {
      newSnapshot += `\n`
      const text = Epub.findXmlChildByName("text", Epub.getXmlChildren(par))
      if (!text) continue
      const audio = Epub.findXmlChildByName("audio", Epub.getXmlChildren(par))
      if (!audio) continue

      const textSrc = text[":@"]?.["@_src"]
      if (!textSrc) continue
      const textSrcMatch = textSrc.match(/#:~:text=(.+)$/)
      const textFragment = textSrcMatch?.[1]
      if (textFragment === undefined) continue

      const textFragmentParts = textFragment.split(",")
      const textFragmentPrefix = textFragmentParts[0]?.endsWith("-")
        ? decodeURIComponent(textFragmentParts[0]).slice(0, -1)
        : ""
      const textFragmentStart = decodeURIComponent(
        textFragmentPrefix ? textFragmentParts[1]! : textFragmentParts[0]!,
      )

      const textSentenceIndex =
        chapterSentences.slice(lastChapterSentence + 1).findIndex((s, i) => {
          const prev = chapterSentences[lastChapterSentence + i]
          return (
            (!prev ||
              prev.text
                .replace("\n", " ")
                .toLowerCase()
                .endsWith(textFragmentPrefix)) &&
            s.text
              .replace("\n", " ")
              .toLowerCase()
              .startsWith(textFragmentStart)
          )
        }) +
        lastChapterSentence +
        1

      const textSentence = chapterSentences[textSentenceIndex]?.text
      if (!textSentence) continue

      lastChapterSentence = textSentenceIndex

      newSnapshot += `${textSrcMatch![0]}\nText:  ${textSentence.replace(/\n/, "")}\n`

      const audioSrc = audio[":@"]?.["@_src"]
      if (!audioSrc) continue

      const audioStart = audio[":@"]?.["@_clipBegin"]
      const audioEnd = audio[":@"]?.["@_clipEnd"]
      if (!audioStart || !audioEnd) continue

      const audioStartTime = parseFloat(audioStart.slice(0, -1))
      const audioEndTime = parseFloat(audioEnd.slice(0, -1))

      const audioFilename = posixBasename(audioSrc, extname(audioSrc))
      const transcriptionFilepath = transcriptionFilepaths.find(
        (f) => basename(f, extname(f)) === audioFilename,
      )
      if (!transcriptionFilepath) continue

      const transcription = JSON.parse(
        await readFile(transcriptionFilepath, { encoding: "utf-8" }),
      ) as Pick<RecognitionResult, "transcript" | "timeline">

      const transcriptionWords: string[] = []
      let started = false
      let i = 0
      let word = transcription.timeline[i]
      while (word && word.endTime <= audioEndTime) {
        if (word.startTime >= audioStartTime) {
          started = true
        }
        if (started) {
          transcriptionWords.push(word.text)
        }
        word = transcription.timeline[++i]
      }

      const transcriptionSentence = transcriptionWords.join(" ")
      newSnapshot += `Audio: ${transcriptionSentence}\n`
    }

    newSnapshot += `\n`
  }

  if (process.env["UPDATE_SNAPSHOTS"]) {
    await mkdir(dirname(snapshotFilepath), { recursive: true })
    await writeFile(snapshotFilepath, newSnapshot, { encoding: "utf-8" })
    return
  }

  try {
    const existingSnapshot = await readFile(snapshotFilepath, {
      encoding: "utf-8",
    })

    const existingLines = existingSnapshot.split("\n")
    const newLines = newSnapshot.split("\n")
    for (let i = 0; i < existingLines.length; i++) {
      const existingLine = existingLines[i]
      const newLine = newLines[i]
      if (existingLine !== newLine) {
        assert.strictEqual(
          newLines.slice(Math.max(0, i - 5), i + 5),
          existingLines.slice(Math.max(0, i - 5), i + 5),
        )
      }
    }
  } catch (e) {
    if (e instanceof assert.AssertionError) {
      throw e
    }
    throw new assert.AssertionError({
      actual: newSnapshot,
      expected: "",
      diff: "simple",
    })
  }
}

async function testAlignBook(
  context: it.TestContext,
  granularity: "sentence" | "word",
  epubPath: string,
  audiobookPath: string,
  transcriptionsPath: string,
) {
  using epub = await Epub.from(epubPath)

  const audiobookFiles = await readdir(audiobookPath).then((filenames) =>
    filenames.filter((f) => isAudioFile(f)).map((f) => join(audiobookPath, f)),
  )
  const transcriptionFilepaths = await readdir(transcriptionsPath).then(
    (filenames) =>
      filenames
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(transcriptionsPath, f)),
  )
  const transcriptions = await Promise.all(
    transcriptionFilepaths.map(async (p) => readFile(p, { encoding: "utf-8" })),
  ).then((contents) =>
    contents.map(
      (c) =>
        JSON.parse(c) as Pick<RecognitionResult, "transcript" | "timeline">,
    ),
  )

  const textFragmentEpub = await epub.copy()

  const aligner = new Aligner(
    epub,
    audiobookFiles,
    transcriptions,
    granularity,
    "id-fragment",
    undefined,
    createTestLogger(),
  )

  const timing = await aligner.alignBook()

  if (!process.env["CI"]) timing.print()

  await assertAlignSnapshotWithIdFragments(
    context,
    epub,
    transcriptionFilepaths,
  )

  aligner.epub = textFragmentEpub
  // @ts-expect-error internal property
  aligner.textRef = "text-fragment"

  // @ts-expect-error internal property
  for (const chapter of aligner.alignedChapters) {
    // @ts-expect-error internal property
    await aligner.writeAlignedChapter(chapter)
  }

  await assertAlignSnapshotWithTextFragments(
    context,
    textFragmentEpub,
    transcriptionFilepaths,
  )
}

void describe("align", () => {
  void it("should align Peter and Wendy", async (context) => {
    await testAlignBook(
      context,
      "sentence",
      join(
        "src",
        "align",
        "__fixtures__",
        "peter-and-wendy",
        "text",
        "Peter and Wendy.epub",
      ),
      join("src", "align", "__fixtures__", "peter-and-wendy", "audio"),
      join("src", "align", "__fixtures__", "peter-and-wendy", "transcriptions"),
    )
  })

  void it.skip("should align Peter and Wendy (word-level)", async (context) => {
    await testAlignBook(
      context,
      "word",
      join(
        "src",
        "align",
        "__fixtures__",
        "peter-and-wendy",
        "text",
        "Peter and Wendy.epub",
      ),
      join("src", "align", "__fixtures__", "peter-and-wendy", "audio"),
      join("src", "align", "__fixtures__", "peter-and-wendy", "transcriptions"),
    )
  })
})
