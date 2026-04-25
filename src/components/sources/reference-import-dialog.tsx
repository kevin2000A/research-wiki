import { useEffect, useMemo, useState } from "react"
import { Loader2, Search, Download } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { FileNode } from "@/types/wiki"
import {
  extractReferenceTitles,
  importArxivPaper,
  searchArxivByTitles,
  type ArxivCandidate,
  type ArxivSearchResult,
  type ExtractedReference,
} from "@/lib/reference-import"

interface ReferenceImportDialogProps {
  open: boolean
  projectPath: string
  node: FileNode | null
  sourceContent: string
  onOpenChange: (open: boolean) => void
  onImported: () => void
}

export function ReferenceImportDialog({
  open,
  projectPath,
  node,
  sourceContent,
  onOpenChange,
  onImported,
}: ReferenceImportDialogProps) {
  const extracted = useMemo(() => extractReferenceTitles(sourceContent), [sourceContent])
  const [query, setQuery] = useState("")
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<Set<string>>(new Set())
  const [searching, setSearching] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState("")
  const [results, setResults] = useState<ArxivSearchResult[]>([])
  const [selectedArxivIds, setSelectedArxivIds] = useState<Set<string>>(new Set())
  const [importedCount, setImportedCount] = useState(0)

  useEffect(() => {
    if (!open) return
    setQuery("")
    setError("")
    setResults([])
    setImportedCount(0)
    setSelectedReferenceIds(new Set(extracted.map((item) => item.id)))
    setSelectedArxivIds(new Set())
  }, [open, extracted])

  const filtered = useMemo(() => {
    const lowered = query.trim().toLowerCase()
    if (!lowered) return extracted
    return extracted.filter((item) => item.title.toLowerCase().includes(lowered))
  }, [extracted, query])

  async function handleSearch() {
    const selectedTitles = extracted
      .filter((item) => selectedReferenceIds.has(item.id))
      .map((item) => item.title)
    if (selectedTitles.length === 0) return

    setSearching(true)
    setError("")
    setImportedCount(0)
    try {
      const nextResults = await searchArxivByTitles(selectedTitles)
      setResults(nextResults)
      setSelectedArxivIds(new Set(
        nextResults
          .map((result) => result.candidates[0]?.arxivId)
          .filter((value): value is string => Boolean(value)),
      ))
    } catch (err) {
      setError(String(err))
    } finally {
      setSearching(false)
    }
  }

  async function handleImport() {
    const selectedCandidates = results
      .map((result) => result.candidates[0])
      .filter((candidate): candidate is ArxivCandidate => Boolean(candidate) && selectedArxivIds.has(candidate.arxivId))

    if (selectedCandidates.length === 0) return

    setImporting(true)
    setError("")
    try {
      let imported = 0
      for (const candidate of selectedCandidates) {
        await importArxivPaper(projectPath, candidate)
        imported += 1
      }
      setImportedCount(imported)
      onImported()
    } catch (err) {
      setError(String(err))
    } finally {
      setImporting(false)
    }
  }

  function toggleReference(item: ExtractedReference) {
    setSelectedReferenceIds((prev) => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }

  function toggleCandidate(arxivId: string) {
    setSelectedArxivIds((prev) => {
      const next = new Set(prev)
      if (next.has(arxivId)) next.delete(arxivId)
      else next.add(arxivId)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import Referenced Papers{node ? ` · ${node.name}` : ""}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter extracted reference titles"
            />
            <Button
              variant="outline"
              onClick={handleSearch}
              disabled={searching || selectedReferenceIds.size === 0}
            >
              {searching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              Find arXiv Matches
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="min-h-0 rounded-lg border">
              <div className="border-b px-4 py-3 text-sm font-medium">
                Extracted Titles ({filtered.length})
              </div>
              <div className="max-h-96 overflow-y-auto p-2">
                {filtered.length === 0 ? (
                  <div className="px-3 py-8 text-sm text-muted-foreground">
                    {extracted.length === 0 ? "No reference titles found in this source." : "No titles match your filter."}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {filtered.map((item) => (
                      <label
                        key={item.id}
                        className="flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-primary"
                          checked={selectedReferenceIds.has(item.id)}
                          onChange={() => toggleReference(item)}
                        />
                        <span className="leading-5">{item.title}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="min-h-0 rounded-lg border">
              <div className="border-b px-4 py-3 text-sm font-medium">
                arXiv Matches ({results.length})
              </div>
              <div className="max-h-96 overflow-y-auto p-2">
                {results.length === 0 ? (
                  <div className="px-3 py-8 text-sm text-muted-foreground">
                    Search after selecting the reference titles you want.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {results.map((result) => {
                      const candidate = result.candidates[0]
                      return (
                        <div key={result.queryTitle} className="rounded-md border p-3">
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {result.queryTitle}
                          </div>
                          {!candidate ? (
                            <div className="text-sm text-muted-foreground">No arXiv match found.</div>
                          ) : (
                            <label className="flex cursor-pointer items-start gap-3 text-sm">
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 accent-primary"
                                checked={selectedArxivIds.has(candidate.arxivId)}
                                onChange={() => toggleCandidate(candidate.arxivId)}
                              />
                              <div className="min-w-0">
                                <div className="font-medium leading-5">{candidate.title}</div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {candidate.arxivId} · score {candidate.score.toFixed(2)}
                                </div>
                              </div>
                            </label>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
          {importedCount > 0 && (
            <div className="text-sm text-emerald-600">
              Imported {importedCount} paper{importedCount === 1 ? "" : "s"} into raw sources.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={handleImport} disabled={importing || selectedArxivIds.size === 0}>
            {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Import Matched Papers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
