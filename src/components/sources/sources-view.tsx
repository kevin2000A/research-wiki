import { useState, useEffect, useCallback } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import { Plus, FileText, RefreshCw, BookOpen, Trash2, Folder, ChevronRight, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { copyFile, listDirectory, readFile, writeFile, deleteFile, findRelatedWikiPages, preprocessFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { enqueueIngest, enqueueBatch } from "@/lib/ingest-queue"
import { useTranslation } from "react-i18next"
import { normalizePath, getFileName } from "@/lib/path-utils"

export function SourcesView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [sources, setSources] = useState<FileNode[]>([])
  const [importing, setImporting] = useState(false)
  const [queueingPath, setQueueingPath] = useState<string | null>(null)
  const [batchQueueing, setBatchQueueing] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())

  const loadSources = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const tree = await listDirectory(`${pp}/raw/sources`)
      // Filter out hidden files/dirs and cache
      const filtered = filterTree(tree)
      setSources(filtered)
      const files = new Set(flattenSourceFiles(filtered).map((f) => f.path))
      setSelectedPaths((prev) => new Set([...prev].filter((path) => files.has(path))))
    } catch {
      setSources([])
      setSelectedPaths(new Set())
    }
  }, [project])

  useEffect(() => {
    loadSources()
  }, [loadSources, dataVersion])

  async function handleImport() {
    if (!project) return

    const selected = await open({
      multiple: true,
      title: "Import Source Files",
      filters: [
        {
          name: "Documents",
          extensions: [
            "md", "mdx", "txt", "rtf", "pdf",
            "html", "htm", "xml",
            "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "odt", "ods", "odp", "epub", "pages", "numbers", "key",
          ],
        },
        {
          name: "Data",
          extensions: ["json", "jsonl", "csv", "tsv", "yaml", "yml", "ndjson"],
        },
        {
          name: "Code",
          extensions: [
            "py", "js", "ts", "jsx", "tsx", "rs", "go", "java",
            "c", "cpp", "h", "rb", "php", "swift", "sql", "sh",
          ],
        },
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "avif", "heic"],
        },
        {
          name: "Media",
          extensions: ["mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a"],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    })

    if (!selected || selected.length === 0) return

    setImporting(true)
    const pp = normalizePath(project.path)
    const paths = Array.isArray(selected) ? selected : [selected]

    for (const sourcePath of paths) {
      const originalName = getFileName(sourcePath) || "unknown"
      const destPath = await getUniqueDestPath(`${pp}/raw/sources`, originalName)
      try {
        await copyFile(sourcePath, destPath)
        // Pre-process file (extract text from PDF, etc.) for instant preview later
        preprocessFile(destPath).catch(() => {})
      } catch (err) {
        console.error(`Failed to import ${originalName}:`, err)
      }
    }

    setImporting(false)
    await loadSources()
  }

  async function handleImportFolder() {
    if (!project) return

    const selected = await open({
      directory: true,
      title: "Import Source Folder",
    })

    if (!selected || typeof selected !== "string") return

    setImporting(true)
    const pp = normalizePath(project.path)
    const folderName = getFileName(selected) || "imported"
    const destDir = `${pp}/raw/sources/${folderName}`

    try {
      // Recursively copy the folder
      const copiedFiles: string[] = await invoke("copy_directory", {
        source: selected,
        destination: destDir,
      })

      console.log(`[Folder Import] Copied ${copiedFiles.length} files from ${folderName}`)

      // Preprocess all files
      for (const filePath of copiedFiles) {
        preprocessFile(filePath).catch(() => {})
      }

      setImporting(false)
      await loadSources()
    } catch (err) {
      console.error(`Failed to import folder:`, err)
      setImporting(false)
    }
  }

  async function handleOpenSource(node: FileNode) {
    setSelectedFile(node.path)
    try {
      const content = await readFile(node.path)
      setFileContent(content)
    } catch (err) {
      console.error("Failed to read source:", err)
    }
  }

  async function handleDelete(node: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    const fileName = node.name
    const confirmed = window.confirm(
      t("sources.deleteConfirm", { name: fileName })
    )
    if (!confirmed) return

    try {
      // Step 1: Find related wiki pages before deleting
      const relatedPages = await findRelatedWikiPages(pp, fileName)
      const deletedSlugs = relatedPages.map((p) => {
        const name = getFileName(p).replace(".md", "")
        return name
      }).filter(Boolean)

      // Step 2: Delete the source file
      await deleteFile(node.path)

      // Step 3: Delete preprocessed cache
      try {
        await deleteFile(`${pp}/raw/sources/.cache/${fileName}.txt`)
      } catch {
        // cache file may not exist
      }

      // Step 4: Delete or update related wiki pages
      // If a page has multiple sources, only remove this filename from sources[]; don't delete the page
      const actuallyDeleted: string[] = []
      for (const pagePath of relatedPages) {
        try {
          const content = await readFile(pagePath)
          // Parse sources from frontmatter
          const sourcesMatch = content.match(/^sources:\s*\[([^\]]*)\]/m)
          if (sourcesMatch) {
            const sourcesList = sourcesMatch[1]
              .split(",")
              .map((s) => s.trim().replace(/["']/g, ""))
              .filter((s) => s.length > 0)

            if (sourcesList.length > 1) {
              // Multiple sources — just remove this file from the list, keep the page
              const updatedSources = sourcesList.filter(
                (s) => s.toLowerCase() !== fileName.toLowerCase()
              )
              const updatedContent = content.replace(
                /^sources:\s*\[([^\]]*)\]/m,
                `sources: [${updatedSources.map((s) => `"${s}"`).join(", ")}]`
              )
              await writeFile(pagePath, updatedContent)
              continue // Don't delete this page
            }
          }

          // Single source or no sources field — delete the page
          await deleteFile(pagePath)
          actuallyDeleted.push(pagePath)
        } catch (err) {
          console.error(`Failed to process wiki page ${pagePath}:`, err)
        }
      }

      // Step 5: Clean index.md — remove entries for actually deleted pages only
      const deletedPageSlugs = actuallyDeleted.map((p) => {
        const name = getFileName(p).replace(".md", "")
        return name
      }).filter(Boolean)

      if (deletedPageSlugs.length > 0) {
        try {
          const indexPath = `${pp}/wiki/index.md`
          const indexContent = await readFile(indexPath)
          const updatedIndex = indexContent
            .split("\n")
            .filter((line) => !deletedPageSlugs.some((slug) => line.toLowerCase().includes(slug.toLowerCase())))
            .join("\n")
          await writeFile(indexPath, updatedIndex)
        } catch {
          // non-critical
        }
      }

      // Step 6: Clean [[wikilinks]] to deleted pages from remaining wiki files
      if (deletedPageSlugs.length > 0) {
        try {
          const wikiTree = await listDirectory(`${pp}/wiki`)
          const allMdFiles = flattenMdFiles(wikiTree)
          for (const file of allMdFiles) {
            try {
              const content = await readFile(file.path)
              let updated = content
              for (const slug of deletedPageSlugs) {
                const linkRegex = new RegExp(`\\[\\[${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\|([^\\]]+))?\\]\\]`, "gi")
                updated = updated.replace(linkRegex, (_match, displayText) => displayText || slug)
              }
              if (updated !== content) {
                await writeFile(file.path, updated)
              }
            } catch {
              // skip
            }
          }
        } catch {
          // non-critical
        }
      }

      // Step 7: Append deletion record to log.md
      try {
        const logPath = `${pp}/wiki/log.md`
        const logContent = await readFile(logPath).catch(() => "# Wiki Log\n")
        const date = new Date().toISOString().slice(0, 10)
        const keptCount = relatedPages.length - actuallyDeleted.length
        const logEntry = `\n## [${date}] delete | ${fileName}\n\nDeleted source file and ${actuallyDeleted.length} wiki pages.${keptCount > 0 ? ` ${keptCount} shared pages kept (have other sources).` : ""}\n`
        await writeFile(logPath, logContent.trimEnd() + logEntry)
      } catch {
        // non-critical
      }

      // Step 8: Refresh everything
      await loadSources()
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()

      // Clear selected file if it was the deleted one
      if (selectedFile === node.path || actuallyDeleted.includes(selectedFile ?? "")) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete source:", err)
      window.alert(`Failed to delete: ${err}`)
    }
  }

  async function handleIngest(node: FileNode) {
    if (!project || queueingPath) return
    setQueueingPath(node.path)
    try {
      const pp = normalizePath(project.path)
      await enqueueIngest(pp, node.path, getFolderContext(pp, node.path))
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        next.delete(node.path)
        return next
      })
    } catch (err) {
      console.error("Failed to enqueue ingest:", err)
    } finally {
      setQueueingPath(null)
    }
  }

  function handleToggleSelected(path: string, selected: boolean) {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (selected) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function handleSelectAllIngestable() {
    const paths = flattenSourceFiles(sources)
      .filter(isIngestableSource)
      .map((node) => node.path)
    setSelectedPaths(new Set(paths))
  }

  async function handleBatchIngest() {
    if (!project || batchQueueing) return
    const pp = normalizePath(project.path)
    const selected = flattenSourceFiles(sources)
      .filter((node) => selectedPaths.has(node.path) && isIngestableSource(node))
    if (selected.length === 0) return

    setBatchQueueing(true)
    try {
      await enqueueBatch(pp, selected.map((node) => ({
        sourcePath: node.path,
        folderContext: getFolderContext(pp, node.path),
      })))
      setSelectedPaths(new Set())
    } catch (err) {
      console.error("Failed to enqueue batch ingest:", err)
    } finally {
      setBatchQueueing(false)
    }
  }

  const selectedIngestableCount = flattenSourceFiles(sources)
    .filter((node) => selectedPaths.has(node.path) && isIngestableSource(node))
    .length
  const ingestableCount = flattenSourceFiles(sources).filter(isIngestableSource).length

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("sources.title")}</h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={loadSources} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleSelectAllIngestable} disabled={ingestableCount === 0}>
            {t("sources.selectAllIngestable")}
          </Button>
          <Button size="sm" onClick={handleBatchIngest} disabled={batchQueueing || selectedIngestableCount === 0}>
            <BookOpen className="mr-1 h-4 w-4" />
            {batchQueueing ? t("sources.queueing") : t("sources.ingestSelected", { count: selectedIngestableCount })}
          </Button>
          <Button size="sm" onClick={handleImport} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {importing ? t("sources.importing") : t("sources.import")}
          </Button>
          <Button size="sm" onClick={handleImportFolder} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {t("sources.importFolder", "Folder")}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <p>{t("sources.noSources")}</p>
            <p>{t("sources.importHint")}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleImport}>
                <Plus className="mr-1 h-4 w-4" />
                {t("sources.importFiles")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleImportFolder}>
                <Plus className="mr-1 h-4 w-4" />
                Folder
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-2">
            <SourceTree
              nodes={sources}
              onOpen={handleOpenSource}
              onIngest={handleIngest}
              onDelete={handleDelete}
              onToggleSelected={handleToggleSelected}
              selectedPaths={selectedPaths}
              queueingPath={queueingPath}
              depth={0}
            />
          </div>
        )}
      </ScrollArea>

      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        {t("sources.sourceCount", { count: countFiles(sources) })}
        {selectedIngestableCount > 0 && (
          <span className="ml-2">· {t("sources.selectedCount", { count: selectedIngestableCount })}</span>
        )}
      </div>
    </div>
  )
}

/**
 * Generate a unique destination path. If file already exists, adds date/counter suffix.
 * "file.pdf" → "file.pdf" (first time)
 * "file.pdf" → "file-20260406.pdf" (conflict)
 * "file.pdf" → "file-20260406-2.pdf" (second conflict same day)
 */
async function getUniqueDestPath(dir: string, fileName: string): Promise<string> {
  const basePath = `${dir}/${fileName}`

  // Check if file exists by trying to read it
  try {
    await readFile(basePath)
  } catch {
    // File doesn't exist — use original name
    return basePath
  }

  // File exists — add date suffix
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ""
  const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")

  const withDate = `${dir}/${nameWithoutExt}-${date}${ext}`
  try {
    await readFile(withDate)
  } catch {
    return withDate
  }

  // Date suffix also exists — add counter
  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${nameWithoutExt}-${date}-${i}${ext}`
    try {
      await readFile(withCounter)
    } catch {
      return withCounter
    }
  }

  // Shouldn't happen, but fallback
  return `${dir}/${nameWithoutExt}-${date}-${Date.now()}${ext}`
}

function filterTree(nodes: FileNode[]): FileNode[] {
  const names = new Set(nodes.map((n) => n.name.toLowerCase()))
  return nodes
    .filter((n) => !n.name.startsWith(".") && !isHiddenPaperArtifact(n, names))
    .map((n) => {
      if (n.is_dir && n.children) {
        return { ...n, children: filterTree(n.children) }
      }
      return n
    })
    .filter((n) => !n.is_dir || (n.children && n.children.length > 0))
}

function isHiddenPaperArtifact(node: FileNode, siblingNames: Set<string>): boolean {
  if (node.is_dir) return false
  const lower = node.name.toLowerCase()
  if (lower.endsWith("-source.tar.gz")) return true
  if (!lower.endsWith(".pdf")) return false
  const stem = lower.slice(0, -4)
  const looksLikeArxivId =
    /^\d{4}\.\d{4,5}(?:v\d+)?$/.test(stem) ||
    /^[a-z-]+(?:\.[a-z]+)?-\d{7}(?:v\d+)?$/i.test(stem)
  return looksLikeArxivId && siblingNames.has(`${stem}-paper.md`)
}

function countFiles(nodes: FileNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      count += countFiles(node.children)
    } else if (!node.is_dir) {
      count++
    }
  }
  return count
}

function SourceTree({
  nodes,
  onOpen,
  onIngest,
  onDelete,
  onToggleSelected,
  selectedPaths,
  queueingPath,
  depth,
}: {
  nodes: FileNode[]
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  onToggleSelected: (path: string, selected: boolean) => void
  selectedPaths: Set<string>
  queueingPath: string | null
  depth: number
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  // Sort: folders first, then files, alphabetical within each group
  const sorted = [...nodes].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1
    if (!a.is_dir && b.is_dir) return 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      {sorted.map((node) => {
        if (node.is_dir && node.children) {
          const isCollapsed = collapsed[node.path] ?? false
          return (
            <div key={node.path}>
              <button
                onClick={() => toggle(node.path)}
                className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                )}
                <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                <span className="truncate font-medium">{node.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">
                  {countFiles(node.children)}
                </span>
              </button>
              {!isCollapsed && (
                <SourceTree
                  nodes={node.children}
                  onOpen={onOpen}
                  onIngest={onIngest}
                  onDelete={onDelete}
                  onToggleSelected={onToggleSelected}
                  selectedPaths={selectedPaths}
                  queueingPath={queueingPath}
                  depth={depth + 1}
                />
              )}
            </div>
          )
        }

        const ingestable = isIngestableSource(node)

        return (
          <div
            key={node.path}
            className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
          >
            <input
              type="checkbox"
              className="ml-1 h-3.5 w-3.5 shrink-0 accent-primary"
              checked={selectedPaths.has(node.path)}
              disabled={!ingestable}
              title={ingestable ? "Select for batch ingest" : "Not ingestable"}
              onChange={(e) => onToggleSelected(node.path, e.currentTarget.checked)}
            />
            <button
              onClick={() => onOpen(node)}
              className="flex flex-1 items-center gap-2 truncate px-2 py-1 text-left"
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title={ingestable ? "Add to ingest queue" : "Not ingestable"}
              disabled={!ingestable || queueingPath === node.path}
              onClick={() => onIngest(node)}
            >
              <BookOpen className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
              title="Delete"
              onClick={() => onDelete(node)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )
      })}
    </>
  )
}

function flattenSourceFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenSourceFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}

function isIngestableSource(node: FileNode): boolean {
  const lower = node.name.toLowerCase()
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
  return [
    "md", "mdx", "txt", "pdf", "docx", "pptx", "xlsx", "xls",
    "csv", "json", "html", "htm", "rtf", "xml", "yaml", "yml", "tex",
  ].includes(ext)
}

function getFolderContext(projectPath: string, filePath: string): string {
  const root = `${normalizePath(projectPath)}/raw/sources/`
  const relPath = normalizePath(filePath).replace(root, "")
  const parts = relPath.split("/")
  parts.pop()
  return parts.join(" > ")
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
