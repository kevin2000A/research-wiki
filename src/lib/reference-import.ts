export interface ExtractedReference {
  id: string
  title: string
  raw: string
}

export interface ArxivCandidate {
  arxivId: string
  title: string
  paperUrl: string
  summary: string
  score: number
}

export interface ArxivSearchResult {
  queryTitle: string
  candidates: ArxivCandidate[]
}

export interface ImportedArxivPaper {
  path: string
  paperPath: string
  arxivId: string
  artifactKind: string
}

export function extractReferenceTitles(content: string): ExtractedReference[] {
  const section = extractReferencesSection(content)
  if (!section) return []

  const blocks = splitReferenceBlocks(section)
  const seen = new Set<string>()
  const extracted: ExtractedReference[] = []

  for (const block of blocks) {
    const title = extractTitleFromBlock(block)
    if (!title) continue
    const key = normalizeTitle(title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    extracted.push({
      id: key,
      title,
      raw: block,
    })
  }

  return extracted
}

export async function searchArxivByTitles(titles: string[]): Promise<ArxivSearchResult[]> {
  const response = await fetch("http://127.0.0.1:19827/arxiv/search-titles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ titles }),
  })

  const parsed = await response.json()
  if (!response.ok || !parsed.ok) {
    throw new Error(parsed.error || `arXiv search failed with HTTP ${response.status}`)
  }
  return parsed.results as ArxivSearchResult[]
}

export async function importArxivPaper(
  projectPath: string,
  candidate: ArxivCandidate,
): Promise<ImportedArxivPaper> {
  const response = await fetch("http://127.0.0.1:19827/arxiv/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectPath,
      arxivId: candidate.arxivId,
      paperTitle: candidate.title,
    }),
  })

  const parsed = await response.json()
  if (!response.ok || !parsed.ok) {
    throw new Error(parsed.error || `arXiv import failed with HTTP ${response.status}`)
  }

  return parsed as ImportedArxivPaper
}

function extractReferencesSection(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n")
  const headingMatches = [...normalized.matchAll(/(^|\n)#{1,6}\s*(references|bibliography)\b[^\n]*\n/gi)]
  if (headingMatches.length > 0) {
    const last = headingMatches[headingMatches.length - 1]
    return normalized.slice(last.index! + last[0].length).trim()
  }

  const plainMatches = [...normalized.matchAll(/(^|\n)(references|bibliography)\s*\n/gi)]
  if (plainMatches.length > 0) {
    const last = plainMatches[plainMatches.length - 1]
    return normalized.slice(last.index! + last[0].length).trim()
  }

  return ""
}

function splitReferenceBlocks(section: string): string[] {
  const blocks: string[] = []
  const lines = section
    .split("\n")
    .map((line) => line.trimEnd())

  let current: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const startsNew = /^\[?\d+\]?[\).]?\s+/.test(line)
      || /^-\s+/.test(line)
      || /^\*\s+/.test(line)

    if (startsNew && current.length > 0) {
      blocks.push(cleanReferenceBlock(current))
      current = [trimmed]
      continue
    }

    current.push(trimmed)
  }

  if (current.length > 0) {
    blocks.push(cleanReferenceBlock(current))
  }

  return blocks.filter((block) => block.replace(/\s+/g, " ").trim().length >= 24)
}

function cleanReferenceBlock(lines: string[]): string {
  const cleaned = [...lines]
  if (cleaned.length > 0) {
    cleaned[0] = cleaned[0]
      .replace(/^\[?\d+\]?[\).]?\s+/, "")
      .replace(/^[-*]\s+/, "")
      .trim()
  }

  if (cleaned[0] && /^\S.+\[\d{4}[a-z]?\]$/i.test(cleaned[0])) {
    cleaned.shift()
  }

  return cleaned
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

function extractTitleFromBlock(block: string): string | null {
  const lines = block
    .split("\n")
    .map((line) => tidyLine(line))
    .filter(Boolean)

  const lineCandidate = extractTitleFromLines(lines)
  if (lineCandidate) return lineCandidate

  const cleaned = block
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  for (const regex of [
    /["“](.{10,220}?)["”]/,
    /\*(.{10,220}?)\*/,
    /_(.{10,220}?)_/,
  ]) {
    const match = cleaned.match(regex)
    if (match) {
      return tidyTitle(match[1])
    }
  }

  const inlineCandidate = extractInlineTitle(cleaned)
  return inlineCandidate
}

function tidyTitle(value: string): string {
  return value
    .replace(/^\W+|\W+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function tidyLine(value: string): string {
  return tidyTitle(
    value
      .replace(/\[(https?:\/\/[^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*+/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  )
}

function extractTitleFromLines(lines: string[]): string | null {
  if (lines.length === 0) return null

  const candidates = lines
    .map((line) => cleanupTitleCandidate(stripInlineNoise(line)))
    .filter((line) => line.length >= 12 && line.length <= 220)
    .filter((line) => !isLikelyAuthorLine(line))
    .filter((line) => !isLikelyVenueLine(line))
    .filter((line) => !isLikelyMetadataLine(line))
    .filter((line) => looksLikePaperTitle(line))

  const best = candidates
    .map((line) => ({ line, score: scoreTitleCandidate(line) }))
    .sort((a, b) => b.score - a.score)[0]

  return best?.line ?? null
}

function extractInlineTitle(block: string): string | null {
  const trimmed = cleanupTitleCandidate(stripInlineNoise(block)).trim()

  const afterYear = trimmed.match(/\b(?:19|20)\d{2}[a-z]?[).]?\s+(.+)/i)
  const body = afterYear ? afterYear[1] : trimmed
  const sentenceCandidates = body
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((part) => cleanupTitleCandidate(tidyTitle(part.replace(/\.$/, ""))))
    .filter(Boolean)
    .filter((part) => !isLikelyAuthorLine(part))
    .filter((part) => !isLikelyVenueLine(part))
    .filter((part) => !isLikelyMetadataLine(part))
    .filter((part) => looksLikePaperTitle(part))

  if (sentenceCandidates.length === 0) return null

  const best = sentenceCandidates
    .map((line) => ({ line, score: scoreTitleCandidate(line) }))
    .sort((a, b) => b.score - a.score)[0]

  return best?.line ?? null
}

function stripInlineNoise(value: string): string {
  return tidyTitle(
    value
      .replace(/\barXiv:\d{4}\.\d{4,5}(v\d+)?\b/gi, " ")
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
      .replace(/\bdoi:\S+/gi, " ")
      .replace(/\bpages?\s+[A-Za-z0-9-–]+(?:\s*[-–]\s*[A-Za-z0-9-–]+)?/gi, " ")
      .replace(/\s+/g, " "),
  )
}

function cleanupTitleCandidate(value: string): string {
  return tidyTitle(
    value
      .replace(/\s+In\s+[*"]?[^".*]+(?:conference|conf\.|proceedings|journal|symposium|workshop)[\s\S]*$/i, "")
      .replace(/\s+[*"]?(?:adv\. neural inf\. process\. syst\.|ieee conf\. comput\. vis\. pattern recog\.|int\. conf\. comput\. vis\.|robot\. autom\. lett\.)[\s\S]*$/i, "")
      .replace(/\b(?:doi|retrieved|available at|url|blog post)\b[\s\S]*$/i, "")
      .replace(/,\s*(?:19|20)\d{2}[a-z]?\s*$/i, "")
      .replace(/\.\s*(?:19|20)\d{2}[a-z]?\s*$/i, "")
      .replace(/\s+\((?:19|20)\d{2}[a-z]?\)\s*$/i, "")
      .replace(/\s+/g, " "),
  )
}

function looksLikePaperTitle(value: string): boolean {
  const lower = value.toLowerCase()
  if (/(^| )(proceedings|journal|conference|workshop|volume|pages|pp|doi|arxiv|preprint|blog post|url)( |$)/.test(lower)) {
    return false
  }
  const words = lower.split(/\s+/).filter(Boolean)
  if (words.length < 3 || words.length > 28) return false
  if (!/[a-z]{4,}/.test(lower)) return false
  return true
}

function isLikelyAuthorLine(value: string): boolean {
  const cleaned = tidyTitle(value)
  const lower = cleaned.toLowerCase()
  if (/\bet al\b/.test(lower)) return true
  if (/\band\b/.test(lower) && /,/.test(cleaned) && !/:/.test(cleaned)) return true
  if ((cleaned.match(/,/g) || []).length >= 2 && !/:/.test(cleaned)) return true
  const tokens = cleaned.split(/\s+/).filter(Boolean)
  if (tokens.length >= 3) {
    const capitalized = tokens.filter((token) => /^[A-Z][a-z'’-]+$/.test(token) || /^[A-Z]\.?$/.test(token)).length
    const hasNameSeparators = /,/.test(cleaned) || /\band\b/i.test(cleaned) || /\b[A-Z]\./.test(cleaned)
    if (hasNameSeparators && capitalized / tokens.length >= 0.7 && !/\b(for|with|via|from|using|towards|through|into|of)\b/i.test(cleaned)) {
      return true
    }
  }
  return false
}

function isLikelyVenueLine(value: string): boolean {
  const lower = value.toLowerCase()
  return /\b(arxiv preprint|ieee|conf\.|conference|journal|proceedings|cvpr|neurips|iccv|iclr|eccv|aaai|icml|robot\. autom\. lett\.|adv\. neural inf\. process\. syst\.)\b/.test(lower)
}

function isLikelyMetadataLine(value: string): boolean {
  const lower = value.toLowerCase()
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(lower)
    || /^arxiv:\d{4}\.\d{4,5}(v\d+)?$/.test(lower)
    || /^url\b/.test(lower)
    || /^blog post\b/.test(lower)
}

function scoreTitleCandidate(value: string): number {
  const lower = value.toLowerCase()
  let score = 0
  const words = lower.split(/\s+/).filter(Boolean)
  if (value.length >= 18 && value.length <= 160) score += 4
  if (words.length >= 4 && words.length <= 20) score += 4
  if (/[a-z]{4,}/.test(lower)) score += 2
  if (/:|-/.test(value)) score += 1
  if (/\b(for|with|via|from|using|towards|through|into|without|beyond|learning|generation|model|models|scene|visual|reconstruction|understanding)\b/.test(lower)) score += 2
  if (isLikelyAuthorLine(value)) score -= 6
  if (isLikelyVenueLine(value)) score -= 6
  if (isLikelyMetadataLine(value)) score -= 6
  if (/\b(et al|pages?|vol\.|no\.|arxiv|doi|url)\b/.test(lower)) score -= 4
  return score
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}
