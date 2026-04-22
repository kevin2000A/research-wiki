import { useState, useEffect, useCallback, useMemo } from "react"
import type { MouseEvent } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import { Plus, FileText, RefreshCw, BookOpen, Trash2, Folder, ChevronRight, ChevronDown, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { copyFile, listDirectory, readFile, deleteFile, findRelatedWikiPages, preprocessFile, createDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { enqueueIngest, enqueueBatch } from "@/lib/ingest-queue"
import { useTranslation } from "react-i18next"
import { normalizePath, getFileName } from "@/lib/path-utils"
import { cn } from "@/lib/utils"

type SourceStatus = "dropped" | "ingested" | "unprocessed"

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
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null)
  const [sourceStatuses, setSourceStatuses] = useState<Record<string, SourceStatus>>({})
  const sourceFiles = useMemo(() => flattenSourceFiles(sources), [sources])

  const loadSources = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const tree = await listDirectory(`${pp}/raw/sources`)
      // Filter out hidden files/dirs and cache
      const filtered = filterTree(tree)
      setSources(filtered)
      const files = new Set(flattenSourceFiles(filtered).map((f) => f.path))
      const statuses = await buildSourceStatuses(pp, filtered)
      setSourceStatuses(statuses)
      setSelectedPaths((prev) => new Set([...prev].filter((path) => files.has(path))))
      setLastSelectedPath((prev) => (prev && files.has(prev) ? prev : null))
    } catch {
      setSources([])
      setSourceStatuses({})
      setSelectedPaths(new Set())
      setLastSelectedPath(null)
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

  async function refreshSourceState(pp: string) {
    await loadSources()
    const tree = await listDirectory(pp)
    setFileTree(tree)
    useWikiStore.getState().bumpDataVersion()
  }

  async function handleDelete(node: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    const fileName = node.name
    const status = sourceStatuses[node.path] ?? "unprocessed"
    if (status === "dropped") {
      await handleRestore(node)
      return
    }

    const confirmed = window.confirm(
      t("sources.deleteConfirm", { name: fileName })
    )
    if (!confirmed) return

    try {
      await dropSourceNode(pp, node)
      await refreshSourceState(pp)
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        next.delete(node.path)
        return next
      })
      if (lastSelectedPath === node.path) {
        setLastSelectedPath(null)
      }

      // Clear selected file if it was the deleted one
      if (selectedFile === node.path) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to drop source:", err)
      window.alert(`Failed to drop: ${err}`)
    }
  }

  async function handleDeleteSelected() {
    if (!project || batchDeleting) return
    const selected = sourceFiles.filter((node) => selectedPaths.has(node.path) && sourceStatuses[node.path] !== "dropped")
    if (selected.length === 0) return

    const confirmed = window.confirm(
      t("sources.deleteSelectedConfirm", { count: selected.length })
    )
    if (!confirmed) return

    setBatchDeleting(true)
    try {
      const pp = normalizePath(project.path)
      for (const node of selected) {
        await dropSourceNode(pp, node)
      }

      await refreshSourceState(pp)
      setSelectedPaths(new Set())
      setLastSelectedPath(null)

      if (selectedFile && selected.some((node) => node.path === selectedFile)) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to drop selected sources:", err)
      window.alert(`Failed to drop selected sources: ${err}`)
    } finally {
      setBatchDeleting(false)
    }
  }

  async function handleRestore(node: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    await restoreSourceNode(pp, node)
    await refreshSourceState(pp)
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      next.delete(node.path)
      return next
    })
    if (lastSelectedPath === node.path) {
      setLastSelectedPath(null)
    }
  }

  async function handleRestoreSelected() {
    if (!project) return
    const selected = sourceFiles.filter((node) => selectedPaths.has(node.path) && sourceStatuses[node.path] === "dropped")
    if (selected.length === 0) return
    const pp = normalizePath(project.path)
    for (const node of selected) {
      await restoreSourceNode(pp, node)
    }
    await refreshSourceState(pp)
    setSelectedPaths(new Set())
    setLastSelectedPath(null)
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

  function handleSelectSource(node: FileNode, event: MouseEvent<HTMLElement>, openFile: boolean) {
    const isRangeSelect = event.shiftKey && lastSelectedPath
    const isToggleSelect = event.metaKey || event.ctrlKey

    if (isRangeSelect) {
      const anchorIndex = sourceFiles.findIndex((file) => file.path === lastSelectedPath)
      const currentIndex = sourceFiles.findIndex((file) => file.path === node.path)
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex)
        const end = Math.max(anchorIndex, currentIndex)
        setSelectedPaths((prev) => {
          const next = new Set(prev)
          for (const file of sourceFiles.slice(start, end + 1)) {
            next.add(file.path)
          }
          return next
        })
      } else {
        setSelectedPaths(new Set([node.path]))
      }
    } else if (isToggleSelect) {
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
    } else {
      setSelectedPaths(new Set([node.path]))
    }

    setLastSelectedPath(node.path)

    if (openFile && !isRangeSelect && !isToggleSelect) {
      void handleOpenSource(node)
    }
  }

  function selectAllSources() {
    setSelectedPaths(new Set(sourceFiles.map((node) => node.path)))
    setLastSelectedPath(sourceFiles[0]?.path ?? null)
  }

  function clearSourceSelection() {
    setSelectedPaths(new Set())
    setLastSelectedPath(null)
  }

  function handleToggleSelectAll() {
    if (selectedCount === sourceFiles.length) {
      clearSourceSelection()
      return
    }
    selectAllSources()
  }

  async function handleBatchIngest() {
    if (!project || batchQueueing) return
    const pp = normalizePath(project.path)
    const selected = sourceFiles
      .filter((node) => selectedPaths.has(node.path) && sourceStatuses[node.path] !== "dropped" && isIngestableSource(node))
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

  const selectedCount = sourceFiles.filter((node) => selectedPaths.has(node.path)).length
  const selectedDroppableCount = sourceFiles
    .filter((node) => selectedPaths.has(node.path) && sourceStatuses[node.path] !== "dropped")
    .length
  const selectedDroppedCount = sourceFiles
    .filter((node) => selectedPaths.has(node.path) && sourceStatuses[node.path] === "dropped")
    .length
  const selectedIngestableCount = sourceFiles
    .filter((node) => selectedPaths.has(node.path) && sourceStatuses[node.path] !== "dropped" && isIngestableSource(node))
    .length
  const droppedCount = sourceFiles.filter((node) => sourceStatuses[node.path] === "dropped").length
  const ingestedCount = sourceFiles.filter((node) => sourceStatuses[node.path] === "ingested").length
  const unprocessedCount = sourceFiles.filter((node) => sourceStatuses[node.path] === "unprocessed").length
  const allSelected = sourceFiles.length > 0 && selectedCount === sourceFiles.length

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableShortcutTarget(event.target)) return

      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === "a") {
        event.preventDefault()
        selectAllSources()
        return
      }

      if (event.key === "Escape" && selectedCount > 0) {
        event.preventDefault()
        clearSourceSelection()
        return
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedCount > 0) {
        event.preventDefault()
        void handleDeleteSelected()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [sourceFiles, selectedPaths, selectedCount, batchDeleting, project])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("sources.title")}</h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={loadSources} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleToggleSelectAll} disabled={sourceFiles.length === 0}>
            {allSelected ? t("sources.clearSelection") : t("sources.selectAll")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDeleteSelected}
            disabled={batchDeleting || selectedDroppableCount === 0}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="mr-1 h-4 w-4" />
            {batchDeleting ? t("sources.deleting") : t("sources.deleteSelected", { count: selectedDroppableCount })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestoreSelected}
            disabled={selectedDroppedCount === 0}
          >
            <RotateCcw className="mr-1 h-4 w-4" />
            {t("sources.restoreSelected", { count: selectedDroppedCount })}
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

      <div
        className="min-h-0 flex-1 overflow-y-scroll overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ scrollbarGutter: "stable" }}
        tabIndex={0}
      >
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
              onSelect={handleSelectSource}
              onIngest={handleIngest}
              onDelete={handleDelete}
              onRestore={handleRestore}
              selectedPaths={selectedPaths}
              sourceStatuses={sourceStatuses}
              queueingPath={queueingPath}
              depth={0}
            />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground">
        {t("sources.sourceCount", { count: countFiles(sources) })}
        {selectedCount > 0 && (
          <span className="ml-2">· {t("sources.selectedCount", { count: selectedCount })}</span>
        )}
        {selectedIngestableCount > 0 && selectedIngestableCount !== selectedCount && (
          <span className="ml-2">· {t("sources.selectedIngestableCount", { count: selectedIngestableCount })}</span>
        )}
        <span className="ml-2">· {t("sources.statusCounts", { dropped: droppedCount, ingested: ingestedCount, unprocessed: unprocessedCount })}</span>
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

  if (!await pathExists(basePath)) {
    return basePath
  }

  // File exists — add date suffix
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ""
  const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")

  const withDate = `${dir}/${nameWithoutExt}-${date}${ext}`
  if (!await pathExists(withDate)) {
    return withDate
  }

  // Date suffix also exists — add counter
  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${nameWithoutExt}-${date}-${i}${ext}`
    if (!await pathExists(withCounter)) {
      return withCounter
    }
  }

  // Shouldn't happen, but fallback
  return `${dir}/${nameWithoutExt}-${date}-${Date.now()}${ext}`
}

async function pathExists(path: string): Promise<boolean> {
  const normalized = normalizePath(path)
  const slash = normalized.lastIndexOf("/")
  const dir = normalized.slice(0, slash)
  const name = normalized.slice(slash + 1)
  const siblings = await listDirectory(dir)
  return siblings.some((node) => node.name === name)
}

function filterTree(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter((n) => !shouldHideSourceNode(n))
    .map((n) => {
      if (n.is_dir && n.children) {
        return { ...n, children: filterTree(n.children) }
      }
      return n
    })
    .filter((n) => !n.is_dir || (n.children && n.children.length > 0))
}

function shouldHideSourceNode(node: FileNode): boolean {
  const lower = node.name.toLowerCase()
  return lower === ".cache" || lower === ".ds_store"
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

async function buildSourceStatuses(projectPath: string, nodes: FileNode[]): Promise<Record<string, SourceStatus>> {
  const files = flattenSourceFiles(nodes)
  const entries = await Promise.all(files.map(async (node) => {
    if (isDroppedSource(projectPath, node.path)) {
      return [node.path, "dropped"] as const
    }
    const relatedPages = await findRelatedWikiPages(projectPath, node.name)
    return [node.path, relatedPages.length > 0 ? "ingested" : "unprocessed"] as const
  }))
  return Object.fromEntries(entries)
}

async function dropSourceNode(projectPath: string, node: FileNode): Promise<string> {
  const relPath = getSourceRelativePath(projectPath, node.path)
  if (relPath === "drop" || relPath.startsWith("drop/")) return node.path

  const destRelPath = `drop/${relPath}`
  return moveSourceNodeToRelativePath(projectPath, node, destRelPath)
}

async function restoreSourceNode(projectPath: string, node: FileNode): Promise<string> {
  const relPath = getSourceRelativePath(projectPath, node.path)
  const prefix = "drop/"
  if (!relPath.startsWith(prefix)) return node.path

  const restoredRelPath = relPath.slice(prefix.length)
  return moveSourceNodeToRelativePath(projectPath, node, restoredRelPath)
}

async function moveSourceNodeToRelativePath(projectPath: string, node: FileNode, destRelPath: string): Promise<string> {
  const sourceRoot = `${normalizePath(projectPath)}/raw/sources`
  const destDirRel = parentRelativePath(destRelPath)
  const destDir = destDirRel ? `${sourceRoot}/${destDirRel}` : sourceRoot
  await createDirectory(destDir)
  const destPath = await getUniqueDestPath(destDir, node.name)
  await copyFile(node.path, destPath)
  await deleteFile(node.path)
  return destPath
}

function getSourceRelativePath(projectPath: string, filePath: string): string {
  const root = `${normalizePath(projectPath)}/raw/sources/`
  return normalizePath(filePath).replace(root, "")
}

function parentRelativePath(relPath: string): string {
  const parts = relPath.split("/")
  parts.pop()
  return parts.join("/")
}

function isDroppedSource(projectPath: string, filePath: string): boolean {
  const relPath = getSourceRelativePath(projectPath, filePath)
  return relPath === "drop" || relPath.startsWith("drop/")
}

function SourceTree({
  nodes,
  onSelect,
  onIngest,
  onDelete,
  onRestore,
  selectedPaths,
  sourceStatuses,
  queueingPath,
  depth,
}: {
  nodes: FileNode[]
  onSelect: (node: FileNode, event: MouseEvent<HTMLElement>, openFile: boolean) => void
  onIngest: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  onRestore: (node: FileNode) => void
  selectedPaths: Set<string>
  sourceStatuses: Record<string, SourceStatus>
  queueingPath: string | null
  depth: number
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  const sorted = sortSourceNodes(nodes)

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
                  onSelect={onSelect}
                  onIngest={onIngest}
                  onDelete={onDelete}
                  onRestore={onRestore}
                  selectedPaths={selectedPaths}
                  sourceStatuses={sourceStatuses}
                  queueingPath={queueingPath}
                  depth={depth + 1}
                />
              )}
            </div>
          )
        }

        const ingestable = isIngestableSource(node)
        const selected = selectedPaths.has(node.path)
        const status = sourceStatuses[node.path] ?? "unprocessed"
        const dropped = status === "dropped"

        return (
          <div
            key={node.path}
            className={cn(
              "flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
              selected && "bg-accent text-accent-foreground"
            )}
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
          >
            <input
              type="checkbox"
              className="ml-1 h-3.5 w-3.5 shrink-0 accent-primary"
              checked={selected}
              readOnly
              title="Select source"
              onClick={(e) => {
                e.stopPropagation()
                onSelect(node, e, false)
              }}
            />
            <button
              onClick={(e) => onSelect(node, e, true)}
              className="flex flex-1 items-center gap-2 truncate px-2 py-1 text-left"
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{node.name}</span>
              <StatusBadge status={status} />
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title={dropped ? "Dropped sources cannot be ingested" : ingestable ? status === "ingested" ? "Re-ingest source" : "Add to ingest queue" : "Not ingestable"}
              disabled={dropped || !ingestable || queueingPath === node.path}
              onClick={() => onIngest(node)}
            >
              <BookOpen className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
              title={dropped ? "Restore from Drop" : "Move to Drop"}
              onClick={() => dropped ? onRestore(node) : onDelete(node)}
            >
              {dropped ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )
      })}
    </>
  )
}

function StatusBadge({ status }: { status: SourceStatus }) {
  return (
    <span
      className={cn(
        "ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        status === "dropped" && "border-slate-300 bg-slate-100 text-slate-600",
        status === "ingested" && "border-emerald-300 bg-emerald-50 text-emerald-700",
        status === "unprocessed" && "border-amber-300 bg-amber-50 text-amber-700",
      )}
    >
      {status === "dropped" ? "Drop" : status === "ingested" ? "Ingested" : "Unprocessed"}
    </span>
  )
}

function flattenSourceFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of sortSourceNodes(nodes)) {
    if (node.is_dir && node.children) {
      files.push(...flattenSourceFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}

function sortSourceNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1
    if (!a.is_dir && b.is_dir) return 1
    return a.name.localeCompare(b.name)
  })
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
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
