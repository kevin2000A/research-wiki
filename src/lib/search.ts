import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath, getFileStem } from "@/lib/path-utils"

export interface SearchResult {
  path: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
}

const MAX_RESULTS = 20
const SNIPPET_CONTEXT = 80

// ── Scoring weights ────────────────────────────────────────────────────────
// Exact lexical matches dominate everything else. The rationale: when a
// user types "attention", the page literally named `attention.md` MUST
// rank first, regardless of how many other pages also mention the word.
//
//   filename == query (e.g. `attention.md` for query "attention")
//     → FILENAME_EXACT_BONUS — large enough that nothing short of an
//       equally-exact match can outrank it.
//
//   title or content contains the raw query as a substring
//     → PHRASE_IN_TITLE_BONUS / PHRASE_IN_CONTENT_PER_OCC — phrase
//       presence is worth far more than individual token presence, and
//       in content it rewards repetition (with a cap to avoid runaway).
//
//   per-token matches (existing behavior, but now smaller weight)
//     → TITLE_TOKEN_WEIGHT / CONTENT_TOKEN_WEIGHT. These used to
//       dominate via a flat +10 title bonus regardless of how many
//       tokens matched; now each matched token counts individually.
const FILENAME_EXACT_BONUS = 200
const PHRASE_IN_TITLE_BONUS = 50
const PHRASE_IN_CONTENT_PER_OCC = 20
const MAX_PHRASE_OCC_COUNTED = 10 // cap to avoid runaway on huge logs
const TITLE_TOKEN_WEIGHT = 5
const CONTENT_TOKEN_WEIGHT = 1

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

export function tokenizeQuery(query: string): string[] {
  // Split by whitespace and punctuation
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))

  const tokens: string[] = []

  for (const token of rawTokens) {
    // Check if token contains CJK characters
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)

    if (hasCJK && token.length > 2) {
      // For CJK text: split into individual characters AND overlapping bigrams
      // "默会知识" → ["默会", "会知", "知识", "默", "会", "知", "识"]
      const chars = [...token]
      // Add bigrams (most useful for Chinese)
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1])
      }
      // Also add individual chars (for single-char matches)
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) {
          tokens.push(ch)
        }
      }
      // Keep the original token too (for exact phrase match)
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }

  // Deduplicate
  return [...new Set(tokens)]
}

function tokenMatchScore(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lower.includes(token)) score += 1
  }
  return score
}

function countOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower || needleLower.length === 0) return 0
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystackLower.indexOf(needleLower, pos)
    if (idx === -1) break
    count++
    pos = idx + needleLower.length
  }
  return count
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractTitle(content: string, fileName: string): string {
  // Try YAML frontmatter title
  const frontmatterMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (frontmatterMatch) return frontmatterMatch[1].trim()

  // Try first heading
  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  // Fall back to filename
  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const idx = lower.indexOf(lowerQuery)
  if (idx === -1) return content.slice(0, SNIPPET_CONTEXT * 2).replace(/\n/g, " ")

  const start = Math.max(0, idx - SNIPPET_CONTEXT)
  const end = Math.min(content.length, idx + query.length + SNIPPET_CONTEXT)
  let snippet = content.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = "..." + snippet
  if (end < content.length) snippet = snippet + "..."
  return snippet
}

export async function searchWiki(
  projectPath: string,
  query: string,
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  const pp = normalizePath(projectPath)

  const tokens = tokenizeQuery(query)
  // Fallback: if all tokens were filtered out, use the trimmed query as a single token
  const effectiveTokens = tokens.length > 0 ? tokens : [query.trim().toLowerCase()]
  const results: SearchResult[] = []

  // Search wiki pages
  try {
    const wikiTree = await listDirectory(`${pp}/wiki`)
    const wikiFiles = flattenMdFiles(wikiTree)
    await searchFiles(wikiFiles, effectiveTokens, query, results)
  } catch {
    // no wiki directory
  }

  // Also search raw sources (extracted text)
  try {
    const rawTree = await listDirectory(`${pp}/raw/sources`)
    const rawFiles = flattenAllFiles(rawTree)
    await searchFiles(rawFiles, effectiveTokens, query, results)
  } catch {
    // no raw sources
  }

  // Vector search: merge semantic results if embedding enabled
  try {
    const { useWikiStore } = await import("@/stores/wiki-store")
    const embCfg = useWikiStore.getState().embeddingConfig
    console.log(`[Vector Search] Config: enabled=${embCfg.enabled}, model="${embCfg.model}"`)
    if (embCfg.enabled && embCfg.model) {
      const t0 = performance.now()
      const { searchByEmbedding } = await import("@/lib/embedding")
      const vectorResults = await searchByEmbedding(pp, query, embCfg, 10)
      const vectorMs = Math.round(performance.now() - t0)

      console.log(
        `[Vector Search] query="${query}" | ${vectorResults.length} results in ${vectorMs}ms | model=${embCfg.model}` +
        (vectorResults.length > 0
          ? ` | top: ${vectorResults.slice(0, 5).map((r) => `${r.id}(${r.score.toFixed(3)})`).join(", ")}`
          : "")
      )

      let boosted = 0
      let added = 0
      // Normalize existing paths to forward slashes so Windows backslash
      // paths from the filesystem match the forward-slash paths we
      // construct for tryPath below.
      const existingPaths = new Set(results.map((r) => normalizePath(r.path)))

      for (const vr of vectorResults) {
        // Check if already in results. getFileStem handles both / and \
        // separators so this works on Windows.
        const existing = results.find((r) => getFileStem(r.path) === vr.id)

        if (existing) {
          // Boost score of existing result
          existing.score += vr.score * 5
          boosted++
        } else {
          // Try to find the file and add it
          const dirs = ["entities", "concepts", "sources", "synthesis", "comparison", "queries"]
          for (const dir of dirs) {
            const tryPath = `${pp}/wiki/${dir}/${vr.id}.md`
            if (existingPaths.has(tryPath)) break
            try {
              const content = await readFile(tryPath)
              const title = extractTitle(content, `${vr.id}.md`)
              results.push({
                path: tryPath,
                title,
                snippet: buildSnippet(content, query),
                titleMatch: false,
                score: vr.score * 5,
              })
              existingPaths.add(tryPath)
              added++
              break
            } catch {
              // not in this directory
            }
          }
        }
      }

      if (boosted > 0 || added > 0) {
        console.log(`[Vector Search] Merged: ${boosted} boosted, ${added} new pages added`)
      }
    }
  } catch (err) {
    console.log(`[Vector Search] Skipped: ${err instanceof Error ? err.message : "not available"}`)
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score)

  const tokenCount = results.filter((r) => r.score > 0).length
  console.log(`[Search] query="${query}" | ${tokenCount} token matches | ${results.length} total results`)

  return results.slice(0, MAX_RESULTS)
}

async function searchFiles(
  files: FileNode[],
  tokens: readonly string[],
  query: string,
  results: SearchResult[],
): Promise<void> {
  const queryPhrase = query.trim().toLowerCase()

  for (const file of files) {
    let content = ""
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    const title = extractTitle(content, file.name)
    const titleText = `${title} ${file.name}`
    const titleLower = titleText.toLowerCase()
    const contentLower = content.toLowerCase()
    const fileStem = file.name.replace(/\.md$/, "").toLowerCase()

    // Exact-match signals (strongest)
    const filenameExact = fileStem === queryPhrase
    const titleHasPhrase =
      queryPhrase.length > 0 && titleLower.includes(queryPhrase)
    const contentPhraseOcc = Math.min(
      countOccurrences(contentLower, queryPhrase),
      MAX_PHRASE_OCC_COUNTED,
    )

    // Token-level signals (fallback / density)
    const titleTokenScore = tokenMatchScore(titleText, tokens)
    const contentTokenScore = tokenMatchScore(content, tokens)

    // Must have at least one signal to be included
    if (
      !filenameExact &&
      !titleHasPhrase &&
      contentPhraseOcc === 0 &&
      titleTokenScore === 0 &&
      contentTokenScore === 0
    ) {
      continue
    }

    const score =
      (filenameExact ? FILENAME_EXACT_BONUS : 0) +
      (titleHasPhrase ? PHRASE_IN_TITLE_BONUS : 0) +
      contentPhraseOcc * PHRASE_IN_CONTENT_PER_OCC +
      titleTokenScore * TITLE_TOKEN_WEIGHT +
      contentTokenScore * CONTENT_TOKEN_WEIGHT

    const isTitleMatch = titleTokenScore > 0 || titleHasPhrase

    // Prefer snipping around the full phrase when it exists; otherwise
    // pick the first matching token; otherwise the raw query.
    const snippetAnchor =
      contentPhraseOcc > 0
        ? queryPhrase
        : tokens.find((t) => contentLower.includes(t)) ?? query

    results.push({
      path: file.path,
      title,
      snippet: buildSnippet(content, snippetAnchor),
      titleMatch: isTitleMatch,
      score,
    })
  }
}

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
