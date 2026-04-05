import { useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { Bot, User, FileText } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import type { DisplayMessage } from "@/stores/chat-store"

interface ChatMessageProps {
  message: DisplayMessage
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user"
  const isSystem = message.role === "system"

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isSystem
            ? "bg-accent text-accent-foreground"
            : isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  )
}

interface StreamingMessageProps {
  content: string
}

export function StreamingMessage({ content }: StreamingMessageProps) {
  return (
    <div className="flex gap-2 flex-row">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="h-4 w-4" />
      </div>
      <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
        <MarkdownContent content={content} />
        <span className="animate-pulse">▊</span>
      </div>
    </div>
  )
}

function MarkdownContent({ content }: { content: string }) {
  // Extract [[wikilinks]] and render them as clickable
  const processed = processWikiLinks(content)

  return (
    <div className="chat-markdown prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        components={{
          // Render wiki links embedded as special markers
          a: ({ href, children }) => {
            if (href?.startsWith("wikilink:")) {
              const pageName = href.slice("wikilink:".length)
              return <WikiLink pageName={pageName}>{children}</WikiLink>
            }
            if (href?.startsWith("sourceref:")) {
              const fileName = href.slice("sourceref:".length)
              return <SourceRef fileName={fileName} />
            }
            // All other links: render as non-navigating styled text
            return (
              <span className="text-primary underline cursor-default" title={href}>
                {children}
              </span>
            )
          },
          // Compact code blocks
          pre: ({ children, ...props }) => (
            <pre className="rounded bg-background/50 p-2 text-xs overflow-x-auto" {...props}>{children}</pre>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Process special link syntax in LLM responses:
 * - [[page-name]] → [page-name](wikilink:page-name)
 * - @filename.pdf → [@filename.pdf](sourceref:filename.pdf)
 */
function processWikiLinks(text: string): string {
  // Process [[wikilinks]]
  let result = text.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, pageName: string, displayText?: string) => {
      const display = displayText?.trim() || pageName.trim()
      return `[${display}](wikilink:${pageName.trim()})`
    }
  )

  // Process @filename references (but not inside markdown links or code blocks)
  // Match @filename at word boundary, supporting extensions like .pdf, .md, .txt
  result = result.replace(
    /(?<!\[)@([\w.-]+\.[\w]+)/g,
    (_match, fileName: string) => {
      return `[@${fileName}](sourceref:${fileName})`
    }
  )

  return result
}

function SourceRef({ fileName }: { fileName: string }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!project) return
    const path = `${project.path}/raw/sources/${fileName}`
    // Switch to wiki view first, then set file and content
    setActiveView("wiki")
    // Small delay to ensure view has switched before setting file
    await new Promise((r) => setTimeout(r, 50))
    setSelectedFile(path)
    try {
      const content = await readFile(path)
      setFileContent(content)
    } catch {
      setFileContent(`Unable to load: ${fileName}`)
    }
  }, [project, fileName, setSelectedFile, setFileContent, setActiveView])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-0.5 rounded bg-accent/50 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent"
      title={`Open source: ${fileName}`}
    >
      <span className="text-muted-foreground">@</span>
      {fileName}
    </button>
  )
}

function WikiLink({ pageName, children }: { pageName: string; children: React.ReactNode }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [exists, setExists] = useState<boolean | null>(null)
  const resolvedPath = useRef<string | null>(null)

  // Check if the page exists on mount
  useEffect(() => {
    if (!project) return
    const candidates = [
      `${project.path}/wiki/entities/${pageName}.md`,
      `${project.path}/wiki/concepts/${pageName}.md`,
      `${project.path}/wiki/sources/${pageName}.md`,
      `${project.path}/wiki/queries/${pageName}.md`,
      `${project.path}/wiki/comparisons/${pageName}.md`,
      `${project.path}/wiki/synthesis/${pageName}.md`,
      `${project.path}/wiki/${pageName}.md`,
    ]

    let cancelled = false
    async function check() {
      for (const path of candidates) {
        try {
          await readFile(path)
          if (!cancelled) {
            resolvedPath.current = path
            setExists(true)
          }
          return
        } catch {
          // try next
        }
      }
      if (!cancelled) setExists(false)
    }
    check()
    return () => { cancelled = true }
  }, [project, pageName])

  const handleClick = useCallback(async () => {
    if (!resolvedPath.current) return
    try {
      const content = await readFile(resolvedPath.current)
      setSelectedFile(resolvedPath.current)
      setFileContent(content)
      setActiveView("wiki")
    } catch {
      // ignore
    }
  }, [setSelectedFile, setFileContent, setActiveView])

  // Page doesn't exist — render as plain text (not clickable)
  if (exists === false) {
    return (
      <span className="inline text-muted-foreground" title={`Page not found: ${pageName}`}>
        {children}
      </span>
    )
  }

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-primary underline decoration-primary/30 hover:bg-primary/10 hover:decoration-primary"
      title={`Open wiki page: ${pageName}`}
    >
      <FileText className="inline h-3 w-3" />
      {children}
    </button>
  )
}
