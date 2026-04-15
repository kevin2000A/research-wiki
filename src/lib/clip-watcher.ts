import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"

const POLL_INTERVAL = 3000 // Check every 3 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Start polling the clip server for new web clips.
 * When a clip is detected, refreshes raw sources. Ingest is manually queued from Sources.
 */
export function startClipWatcher() {
  if (intervalId) return // Already running

  intervalId = setInterval(async () => {
    try {
      const res = await fetch("http://127.0.0.1:19827/clips/pending", { method: "GET" })
      const data = await res.json()

      if (!data.ok || !data.clips || data.clips.length === 0) return

      const store = useWikiStore.getState()
      const project = store.project

      for (const clip of data.clips) {
        const clipProjectPath: string = clip.projectPath

        // Refresh file tree if clip is for current project
        if (project && clipProjectPath === project.path) {
          try {
            const tree = await listDirectory(project.path)
            store.setFileTree(tree)
            store.bumpDataVersion()
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // Server not running or network error — silently ignore
    }
  }, POLL_INTERVAL)
}

export function stopClipWatcher() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
