import { useCallback } from "react"
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
          a: ({ href, children, ...props }) => {
            if (href?.startsWith("wikilink:")) {
              const pageName = href.slice("wikilink:".length)
              return <WikiLink pageName={pageName}>{children}</WikiLink>
            }
            return <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>
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
 * Convert [[wikilink]] syntax to markdown links that our custom renderer can handle.
 * [[page-name]] → [page-name](wikilink:page-name)
 * [[page-name|display text]] → [display text](wikilink:page-name)
 */
function processWikiLinks(text: string): string {
  return text.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, pageName: string, displayText?: string) => {
      const display = displayText?.trim() || pageName.trim()
      return `[${display}](wikilink:${pageName.trim()})`
    }
  )
}

function WikiLink({ pageName, children }: { pageName: string; children: React.ReactNode }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)

  const handleClick = useCallback(async () => {
    if (!project) return
    // Try to find the file in common wiki directories
    const candidates = [
      `${project.path}/wiki/entities/${pageName}.md`,
      `${project.path}/wiki/concepts/${pageName}.md`,
      `${project.path}/wiki/sources/${pageName}.md`,
      `${project.path}/wiki/queries/${pageName}.md`,
      `${project.path}/wiki/comparisons/${pageName}.md`,
      `${project.path}/wiki/synthesis/${pageName}.md`,
      `${project.path}/wiki/${pageName}.md`,
    ]

    for (const path of candidates) {
      try {
        const content = await readFile(path)
        setSelectedFile(path)
        setFileContent(content)
        setActiveView("wiki")
        return
      } catch {
        // try next candidate
      }
    }
    // If not found, just set the name
    console.warn(`Wiki page not found: ${pageName}`)
  }, [project, pageName, setSelectedFile, setFileContent, setActiveView])

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
