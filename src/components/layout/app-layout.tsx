import { useCallback, useEffect } from "react"
import { Group, Panel, Separator } from "react-resizable-panels"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import { IconSidebar } from "./icon-sidebar"
import { FileTree } from "./file-tree"
import { ContentArea } from "./content-area"

export function AppLayout() {
  const project = useWikiStore((s) => s.project)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const loadFileTree = useCallback(async () => {
    if (!project) return
    try {
      const tree = await listDirectory(project.path)
      setFileTree(tree)
    } catch (err) {
      console.error("Failed to load file tree:", err)
    }
  }, [project, setFileTree])

  useEffect(() => {
    loadFileTree()
  }, [loadFileTree])

  return (
    <div className="flex h-screen bg-background text-foreground">
      <IconSidebar />
      <Group orientation="horizontal" className="flex-1">
        <Panel defaultSize={25} minSize={15} maxSize={40}>
          <FileTree />
        </Panel>
        <Separator className="w-1.5 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30" />
        <Panel defaultSize={75}>
          <ContentArea />
        </Panel>
      </Group>
    </div>
  )
}
