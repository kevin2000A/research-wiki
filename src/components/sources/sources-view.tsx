import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import type { MouseEvent, ReactNode } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import { Plus, FileText, RefreshCw, BookOpen, Trash2, Folder, ChevronRight, ChevronDown, RotateCcw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWikiStore } from "@/stores/wiki-store"
import { copyFile, listDirectory, readFile, deleteFile, findRelatedWikiPages, preprocessFile, createDirectory, revealPath } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { enqueueIngest, enqueueBatch } from "@/lib/ingest-queue"
import { useTranslation } from "react-i18next"
import { normalizePath, getFileName } from "@/lib/path-utils"
import { cn } from "@/lib/utils"

type SourceStatus = "dropped" | "ingested" | "unprocessed"
type SourceStatusFilter = "all" | SourceStatus
type SourceSortMode = "name" | "status" | "modified"
type SourceContextMenuState = {
  x: number
  y: number
  paths: string[]
}
type SourceMoveRecord = {
  fromPath: string
  fromRelPath: string
  toPath: string
}
type DropToastState = {
  id: number
  records: SourceMoveRecord[]
}

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
  const [contextMenu, setContextMenu] = useState<SourceContextMenuState | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<SourceStatusFilter>("all")
  const [sortMode, setSortMode] = useState<SourceSortMode>("name")
  const [dropToast, setDropToast] = useState<DropToastState | null>(null)
  const dropToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sourceFiles = useMemo(() => flattenSourceFiles(sources), [sources])
  const visibleSources = useMemo(() => (
    filterSourceTreeForView(sources, sourceStatuses, searchQuery, statusFilter)
  ), [sources, sourceStatuses, searchQuery, statusFilter])
  const visibleSourceFiles = useMemo(() => flattenSourceFiles(visibleSources, sortMode, sourceStatuses), [visibleSources, sortMode, sourceStatuses])
  const selectedSourceFiles = useMemo(() => sourceFiles.filter((node) => selectedPaths.has(node.path)), [sourceFiles, selectedPaths])
  const contextMenuFiles = useMemo(() => {
    if (!contextMenu) return []
    const paths = new Set(contextMenu.paths)
    return visibleSourceFiles.filter((node) => paths.has(node.path))
  }, [contextMenu, visibleSourceFiles])

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
    const status = sourceStatuses[node.path] ?? "unprocessed"
    if (status === "dropped") {
      await handleRestore(node)
      return
    }

    try {
      const record = await dropSourceNode(pp, node)
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
      showDropToast([record])
    } catch (err) {
      console.error("Failed to drop source:", err)
      window.alert(`Failed to drop: ${err}`)
    }
  }

  async function handleDeleteSelected() {
    if (!project || batchDeleting) return
    const selected = selectedSourceFiles.filter((node) => sourceStatuses[node.path] !== "dropped")
    if (selected.length === 0) return

    setBatchDeleting(true)
    try {
      const pp = normalizePath(project.path)
      const records: SourceMoveRecord[] = []
      for (const node of selected) {
        records.push(await dropSourceNode(pp, node))
      }

      await refreshSourceState(pp)
      setSelectedPaths(new Set())
      setLastSelectedPath(null)

      if (selectedFile && selected.some((node) => node.path === selectedFile)) {
        setSelectedFile(null)
      }
      showDropToast(records)
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
    const selected = selectedSourceFiles.filter((node) => sourceStatuses[node.path] === "dropped")
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
      const anchorIndex = visibleSourceFiles.findIndex((file) => file.path === lastSelectedPath)
      const currentIndex = visibleSourceFiles.findIndex((file) => file.path === node.path)
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex)
        const end = Math.max(anchorIndex, currentIndex)
        setSelectedPaths((prev) => {
          const next = new Set(prev)
          for (const file of visibleSourceFiles.slice(start, end + 1)) {
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

  function handleSourceContextMenu(node: FileNode, event: MouseEvent<HTMLElement>) {
    event.preventDefault()
    event.stopPropagation()

    const paths = selectedPaths.has(node.path)
      ? visibleSourceFiles.filter((file) => selectedPaths.has(file.path)).map((file) => file.path)
      : [node.path]

    if (!selectedPaths.has(node.path)) {
      setSelectedPaths(new Set([node.path]))
      setLastSelectedPath(node.path)
    }

    setContextMenu({
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - 240)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - 260)),
      paths,
    })
  }

  function closeContextMenu() {
    setContextMenu(null)
  }

  function selectAllSources() {
    setSelectedPaths(new Set(visibleSourceFiles.map((node) => node.path)))
    setLastSelectedPath(visibleSourceFiles[0]?.path ?? null)
  }

  function clearSourceSelection() {
    setSelectedPaths(new Set())
    setLastSelectedPath(null)
    closeContextMenu()
  }

  function handleToggleSelectAll() {
    if (allSelected) {
      clearSourceSelection()
      return
    }
    selectAllSources()
  }

  async function handleBatchIngest() {
    if (!project || batchQueueing) return
    const pp = normalizePath(project.path)
    const selected = selectedSourceFiles
      .filter((node) => sourceStatuses[node.path] !== "dropped" && isIngestableSource(node))
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

  async function handleCopySourcePaths(nodes: FileNode[]) {
    await navigator.clipboard.writeText(nodes.map((node) => node.path).join("\n"))
  }

  async function handleRevealSource(node: FileNode) {
    await revealPath(node.path)
  }

  function showDropToast(records: SourceMoveRecord[]) {
    if (records.length === 0) return
    if (dropToastTimer.current) clearTimeout(dropToastTimer.current)
    setDropToast({ id: Date.now(), records })
    dropToastTimer.current = setTimeout(() => setDropToast(null), 8000)
  }

  async function handleUndoDrop() {
    if (!project || !dropToast) return
    if (dropToastTimer.current) clearTimeout(dropToastTimer.current)
    const pp = normalizePath(project.path)
    const restoredPaths: string[] = []
    for (const record of dropToast.records) {
      restoredPaths.push(await undoDropMove(pp, record))
    }
    setDropToast(null)
    await refreshSourceState(pp)
    setSelectedPaths(new Set(restoredPaths))
    setLastSelectedPath(restoredPaths[0] ?? null)
  }

  const selectedCount = selectedSourceFiles.length
  const selectedDroppableCount = selectedSourceFiles
    .filter((node) => sourceStatuses[node.path] !== "dropped")
    .length
  const selectedDroppedCount = selectedSourceFiles
    .filter((node) => sourceStatuses[node.path] === "dropped")
    .length
  const selectedIngestableCount = selectedSourceFiles
    .filter((node) => sourceStatuses[node.path] !== "dropped" && isIngestableSource(node))
    .length
  const droppedCount = sourceFiles.filter((node) => sourceStatuses[node.path] === "dropped").length
  const ingestedCount = sourceFiles.filter((node) => sourceStatuses[node.path] === "ingested").length
  const unprocessedCount = sourceFiles.filter((node) => sourceStatuses[node.path] === "unprocessed").length
  const visibleCount = visibleSourceFiles.length
  const allSelected = visibleCount > 0 && visibleSourceFiles.every((node) => selectedPaths.has(node.path))

  useEffect(() => {
    const visiblePaths = new Set(visibleSourceFiles.map((node) => node.path))
    setSelectedPaths((prev) => new Set([...prev].filter((path) => visiblePaths.has(path))))
    setLastSelectedPath((prev) => (prev && visiblePaths.has(prev) ? prev : null))
  }, [visibleSourceFiles])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableShortcutTarget(event.target)) return

      if (contextMenu && event.key === "Escape") {
        event.preventDefault()
        closeContextMenu()
        return
      }

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
  }, [visibleSourceFiles, selectedPaths, selectedCount, batchDeleting, project, contextMenu])

  useEffect(() => {
    if (!contextMenu) return
    function handlePointerDown() {
      closeContextMenu()
    }
    window.addEventListener("pointerdown", handlePointerDown)
    return () => window.removeEventListener("pointerdown", handlePointerDown)
  }, [contextMenu])

  useEffect(() => () => {
    if (dropToastTimer.current) clearTimeout(dropToastTimer.current)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t("sources.title")}</h2>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={loadSources} title="Refresh">
              <RefreshCw className="h-4 w-4" />
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
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search raw sources"
              className="pl-7"
            />
          </div>
          <StatusFilterChips
            statusFilter={statusFilter}
            droppedCount={droppedCount}
            ingestedCount={ingestedCount}
            unprocessedCount={unprocessedCount}
            totalCount={sourceFiles.length}
            onChange={setStatusFilter}
          />
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SourceSortMode)}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            title="Sort sources"
          >
            <option value="name">Sort: Name</option>
            <option value="status">Sort: Status</option>
            <option value="modified">Sort: Modified</option>
          </select>
        </div>
      </div>

      {selectedCount > 0 && (
        <SourceSelectionBar
          selectedCount={selectedCount}
          selectedIngestableCount={selectedIngestableCount}
          selectedDroppableCount={selectedDroppableCount}
          selectedDroppedCount={selectedDroppedCount}
          batchQueueing={batchQueueing}
          batchDeleting={batchDeleting}
          allSelected={allSelected}
          onToggleSelectAll={handleToggleSelectAll}
          onBatchIngest={handleBatchIngest}
          onDropSelected={handleDeleteSelected}
          onRestoreSelected={handleRestoreSelected}
          onClearSelection={clearSourceSelection}
        />
      )}

      <div
        className="min-h-0 flex-1 overflow-y-scroll overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ scrollbarGutter: "stable" }}
        tabIndex={0}
      >
        {sourceFiles.length === 0 ? (
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
        ) : visibleSources.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <p>No matching sources</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearchQuery("")
                setStatusFilter("all")
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <div className="p-2">
            <SourceTree
              nodes={visibleSources}
              sortMode={sortMode}
              onSelect={handleSelectSource}
              onContextMenu={handleSourceContextMenu}
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

      {contextMenu && contextMenuFiles.length > 0 && (
        <SourceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodes={contextMenuFiles}
          sourceStatuses={sourceStatuses}
          queueingPath={queueingPath}
          batchQueueing={batchQueueing}
          batchDeleting={batchDeleting}
          onOpen={(node) => {
            closeContextMenu()
            void handleOpenSource(node)
          }}
          onIngest={(node) => {
            closeContextMenu()
            void handleIngest(node)
          }}
          onBatchIngest={() => {
            closeContextMenu()
            void handleBatchIngest()
          }}
          onDrop={(node) => {
            closeContextMenu()
            void handleDelete(node)
          }}
          onDropSelected={() => {
            closeContextMenu()
            void handleDeleteSelected()
          }}
          onRestore={(node) => {
            closeContextMenu()
            void handleRestore(node)
          }}
          onRestoreSelected={() => {
            closeContextMenu()
            void handleRestoreSelected()
          }}
          onReveal={(node) => {
            closeContextMenu()
            void handleRevealSource(node)
          }}
          onCopyPaths={(nodes) => {
            closeContextMenu()
            void handleCopySourcePaths(nodes)
          }}
          onClearSelection={clearSourceSelection}
        />
      )}

      {dropToast && (
        <DropUndoToast
          count={dropToast.records.length}
          onUndo={() => void handleUndoDrop()}
          onDismiss={() => setDropToast(null)}
        />
      )}

      <div className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground">
        {t("sources.sourceCount", { count: countFiles(sources) })}
        {visibleCount !== sourceFiles.length && (
          <span className="ml-2">· {visibleCount} visible</span>
        )}
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

async function dropSourceNode(projectPath: string, node: FileNode): Promise<SourceMoveRecord> {
  const relPath = getSourceRelativePath(projectPath, node.path)
  if (relPath === "drop" || relPath.startsWith("drop/")) {
    return { fromPath: node.path, fromRelPath: relPath, toPath: node.path }
  }

  const destRelPath = `drop/${relPath}`
  const toPath = await moveSourceNodeToRelativePath(projectPath, node, destRelPath)
  return { fromPath: node.path, fromRelPath: relPath, toPath }
}

async function restoreSourceNode(projectPath: string, node: FileNode): Promise<string> {
  const relPath = getSourceRelativePath(projectPath, node.path)
  const prefix = "drop/"
  if (!relPath.startsWith(prefix)) return node.path

  const restoredRelPath = relPath.slice(prefix.length)
  return moveSourceNodeToRelativePath(projectPath, node, restoredRelPath)
}

async function undoDropMove(projectPath: string, record: SourceMoveRecord): Promise<string> {
  const originalName = getFileName(record.fromRelPath) || getFileName(record.fromPath) || getFileName(record.toPath)
  const node = { name: originalName, path: record.toPath, is_dir: false }
  return moveSourceNodeToRelativePath(projectPath, node, record.fromRelPath)
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

function DropUndoToast({
  count,
  onUndo,
  onDismiss,
}: {
  count: number
  onUndo: () => void
  onDismiss: () => void
}) {
  return (
    <div className="fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background px-4 py-2 text-sm shadow-xl">
      <span>Moved {count} {count === 1 ? "file" : "files"} to Drop</span>
      <button type="button" className="font-medium text-primary hover:underline" onClick={onUndo}>
        Undo
      </button>
      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}

function StatusFilterChips({
  statusFilter,
  totalCount,
  unprocessedCount,
  ingestedCount,
  droppedCount,
  onChange,
}: {
  statusFilter: SourceStatusFilter
  totalCount: number
  unprocessedCount: number
  ingestedCount: number
  droppedCount: number
  onChange: (status: SourceStatusFilter) => void
}) {
  const items: Array<{ status: SourceStatusFilter; label: string; count: number }> = [
    { status: "all", label: "All", count: totalCount },
    { status: "unprocessed", label: "Unprocessed", count: unprocessedCount },
    { status: "ingested", label: "Ingested", count: ingestedCount },
    { status: "dropped", label: "Drop", count: droppedCount },
  ]

  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Button
          key={item.status}
          variant={statusFilter === item.status ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(item.status)}
        >
          {item.label} {item.count}
        </Button>
      ))}
    </div>
  )
}

function SourceSelectionBar({
  selectedCount,
  selectedIngestableCount,
  selectedDroppableCount,
  selectedDroppedCount,
  batchQueueing,
  batchDeleting,
  allSelected,
  onToggleSelectAll,
  onBatchIngest,
  onDropSelected,
  onRestoreSelected,
  onClearSelection,
}: {
  selectedCount: number
  selectedIngestableCount: number
  selectedDroppableCount: number
  selectedDroppedCount: number
  batchQueueing: boolean
  batchDeleting: boolean
  allSelected: boolean
  onToggleSelectAll: () => void
  onBatchIngest: () => void
  onDropSelected: () => void
  onRestoreSelected: () => void
  onClearSelection: () => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2 text-sm">
      <span className="font-medium">{selectedCount} selected</span>
      <Button variant="outline" size="sm" onClick={onToggleSelectAll}>
        {allSelected ? "Clear visible" : "Select visible"}
      </Button>
      <Button size="sm" onClick={onBatchIngest} disabled={batchQueueing || selectedIngestableCount === 0}>
        <BookOpen className="mr-1 h-4 w-4" />
        {batchQueueing ? "Queueing..." : `Ingest selected (${selectedIngestableCount})`}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onDropSelected}
        disabled={batchDeleting || selectedDroppableCount === 0}
        className="text-destructive hover:text-destructive"
      >
        <Trash2 className="mr-1 h-4 w-4" />
        {batchDeleting ? "Moving..." : `Move to Drop (${selectedDroppableCount})`}
      </Button>
      <Button variant="outline" size="sm" onClick={onRestoreSelected} disabled={selectedDroppedCount === 0}>
        <RotateCcw className="mr-1 h-4 w-4" />
        Restore ({selectedDroppedCount})
      </Button>
      <Button variant="ghost" size="sm" onClick={onClearSelection}>
        Clear
      </Button>
    </div>
  )
}

function SourceTree({
  nodes,
  sortMode,
  onSelect,
  onContextMenu,
  onIngest,
  onDelete,
  onRestore,
  selectedPaths,
  sourceStatuses,
  queueingPath,
  depth,
}: {
  nodes: FileNode[]
  sortMode: SourceSortMode
  onSelect: (node: FileNode, event: MouseEvent<HTMLElement>, openFile: boolean) => void
  onContextMenu: (node: FileNode, event: MouseEvent<HTMLElement>) => void
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

  const sorted = sortSourceNodes(nodes, sortMode, sourceStatuses)

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
                  sortMode={sortMode}
                  onSelect={onSelect}
                  onContextMenu={onContextMenu}
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
            onContextMenu={(e) => onContextMenu(node, e)}
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

function SourceContextMenu({
  x,
  y,
  nodes,
  sourceStatuses,
  queueingPath,
  batchQueueing,
  batchDeleting,
  onOpen,
  onIngest,
  onBatchIngest,
  onDrop,
  onDropSelected,
  onRestore,
  onRestoreSelected,
  onReveal,
  onCopyPaths,
  onClearSelection,
}: {
  x: number
  y: number
  nodes: FileNode[]
  sourceStatuses: Record<string, SourceStatus>
  queueingPath: string | null
  batchQueueing: boolean
  batchDeleting: boolean
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  onBatchIngest: () => void
  onDrop: (node: FileNode) => void
  onDropSelected: () => void
  onRestore: (node: FileNode) => void
  onRestoreSelected: () => void
  onReveal: (node: FileNode) => void
  onCopyPaths: (nodes: FileNode[]) => void
  onClearSelection: () => void
}) {
  const single = nodes.length === 1 ? nodes[0] : null
  const droppableCount = nodes.filter((node) => sourceStatuses[node.path] !== "dropped").length
  const droppedCount = nodes.filter((node) => sourceStatuses[node.path] === "dropped").length
  const ingestableCount = nodes.filter((node) => sourceStatuses[node.path] !== "dropped" && isIngestableSource(node)).length

  return (
    <div
      role="menu"
      className="fixed z-50 min-w-56 rounded-md border bg-background p-1 text-sm text-foreground shadow-xl"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {single ? (
        <SingleSourceContextMenuItems
          node={single}
          status={sourceStatuses[single.path] ?? "unprocessed"}
          queueingPath={queueingPath}
          onOpen={onOpen}
          onIngest={onIngest}
          onDrop={onDrop}
          onRestore={onRestore}
          onReveal={onReveal}
          onCopyPath={(node) => onCopyPaths([node])}
        />
      ) : (
        <>
          <ContextMenuItem
            disabled={batchQueueing || ingestableCount === 0}
            onClick={onBatchIngest}
          >
            Ingest selected ({ingestableCount})
          </ContextMenuItem>
          <ContextMenuItem
            disabled={batchDeleting || droppableCount === 0}
            destructive
            onClick={onDropSelected}
          >
            Move selected to Drop ({droppableCount})
          </ContextMenuItem>
          <ContextMenuItem
            disabled={droppedCount === 0}
            onClick={onRestoreSelected}
          >
            Restore selected from Drop ({droppedCount})
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopyPaths(nodes)}>
            Copy paths
          </ContextMenuItem>
          <ContextMenuItem onClick={onClearSelection}>
            Clear selection
          </ContextMenuItem>
        </>
      )}
    </div>
  )
}

function SingleSourceContextMenuItems({
  node,
  status,
  queueingPath,
  onOpen,
  onIngest,
  onDrop,
  onRestore,
  onReveal,
  onCopyPath,
}: {
  node: FileNode
  status: SourceStatus
  queueingPath: string | null
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  onDrop: (node: FileNode) => void
  onRestore: (node: FileNode) => void
  onReveal: (node: FileNode) => void
  onCopyPath: (node: FileNode) => void
}) {
  const dropped = status === "dropped"
  const ingestable = isIngestableSource(node)

  return (
    <>
      <ContextMenuItem onClick={() => onOpen(node)}>
        Open
      </ContextMenuItem>
      {!dropped && (
        <ContextMenuItem
          disabled={!ingestable || queueingPath === node.path}
          onClick={() => onIngest(node)}
        >
          {ingestable ? status === "ingested" ? "Re-ingest" : "Ingest" : "Not ingestable"}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => onReveal(node)}>
        Reveal in Folder
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyPath(node)}>
        Copy Path
      </ContextMenuItem>
      <ContextMenuSeparator />
      {dropped ? (
        <ContextMenuItem onClick={() => onRestore(node)}>
          Restore from Drop
        </ContextMenuItem>
      ) : (
        <ContextMenuItem destructive onClick={() => onDrop(node)}>
          Move to Drop
        </ContextMenuItem>
      )}
    </>
  )
}

function ContextMenuItem({
  children,
  disabled,
  destructive,
  onClick,
}: {
  children: ReactNode
  disabled?: boolean
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
        destructive && "text-destructive hover:text-destructive focus:text-destructive",
        disabled && "pointer-events-none opacity-50",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function ContextMenuSeparator() {
  return <div className="my-1 h-px bg-border" />
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

function filterSourceTreeForView(
  nodes: FileNode[],
  sourceStatuses: Record<string, SourceStatus>,
  searchQuery: string,
  statusFilter: SourceStatusFilter,
): FileNode[] {
  const query = searchQuery.trim().toLowerCase()
  return nodes.flatMap((node) => {
    if (node.is_dir && node.children) {
      const children = filterSourceTreeForView(node.children, sourceStatuses, query, statusFilter)
      return children.length > 0 ? [{ ...node, children }] : []
    }

    const status = sourceStatuses[node.path] ?? "unprocessed"
    const statusMatches = statusFilter === "all" || status === statusFilter
    const queryMatches = query.length === 0 || sourceSearchHaystack(node).includes(query)
    return statusMatches && queryMatches ? [node] : []
  })
}

function sourceSearchHaystack(node: FileNode): string {
  return `${node.name}\n${sourceRelativeDisplayPath(node.path)}`.toLowerCase()
}

function sourceRelativeDisplayPath(path: string): string {
  const normalized = normalizePath(path)
  const marker = "/raw/sources/"
  const index = normalized.indexOf(marker)
  return index >= 0 ? normalized.slice(index + marker.length) : normalized
}

function flattenSourceFiles(
  nodes: FileNode[],
  sortMode: SourceSortMode = "name",
  sourceStatuses: Record<string, SourceStatus> = {},
): FileNode[] {
  const files: FileNode[] = []
  for (const node of sortSourceNodes(nodes, sortMode, sourceStatuses)) {
    if (node.is_dir && node.children) {
      files.push(...flattenSourceFiles(node.children, sortMode, sourceStatuses))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}

function sortSourceNodes(
  nodes: FileNode[],
  sortMode: SourceSortMode = "name",
  sourceStatuses: Record<string, SourceStatus> = {},
): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1
    if (!a.is_dir && b.is_dir) return 1
    if (!a.is_dir && !b.is_dir && sortMode === "status") {
      const statusDiff = sourceStatusPriority(sourceStatuses[a.path] ?? "unprocessed") - sourceStatusPriority(sourceStatuses[b.path] ?? "unprocessed")
      if (statusDiff !== 0) return statusDiff
    }
    if (sortMode === "modified") {
      const modifiedDiff = (b.modified_ms ?? 0) - (a.modified_ms ?? 0)
      if (modifiedDiff !== 0) return modifiedDiff
    }
    return a.name.localeCompare(b.name)
  })
}

function sourceStatusPriority(status: SourceStatus): number {
  if (status === "unprocessed") return 0
  if (status === "ingested") return 1
  return 2
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
