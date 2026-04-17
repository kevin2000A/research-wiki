import type { SearchScenario } from "./types"

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`
}

export const searchScenarios: SearchScenario[] = [
  // 1. title-exact-match — a page whose title exactly contains the query
  //    should rank first and have titleMatch=true.
  {
    name: "title-exact-match",
    description:
      "Query 'attention'. attention.md has 'attention' in its title and in " +
      "content. Should rank first with titleMatch=true.",
    initialWiki: {
      "wiki/attention.md": page("Attention", "The attention mechanism weights sequence tokens."),
      "wiki/other.md": page("Other Page", "Discusses something unrelated entirely."),
      "wiki/transformer.md": page("Transformer", "Uses attention across many heads."),
    },
    query: "attention",
    expected: {
      topResultPaths: ["wiki/attention.md"],
      titleMatchPaths: ["wiki/attention.md"],
      excludedPaths: ["wiki/other.md"],
    },
  },

  // 2. content-match — query not in title, still found via body text
  {
    name: "content-match",
    description:
      "Query 'rotary' appears only in the body of embeddings.md, not in " +
      "any title. Should still be returned, but with titleMatch=false.",
    initialWiki: {
      "wiki/embeddings.md": page(
        "Embeddings",
        "Rotary position embeddings inject positional information via rotation.",
      ),
      "wiki/other.md": page("Other", "Unrelated content here."),
    },
    query: "rotary",
    expected: {
      topResultPaths: ["wiki/embeddings.md"],
      excludedPaths: ["wiki/other.md"],
    },
  },

  // 3. cjk-bigram — Chinese query via bigram tokenization
  {
    name: "cjk-bigram",
    description:
      "Query '注意力机制' is tokenized into bigrams ('注意', '意力', '力机', '机制'). " +
      "The page whose content contains '注意力机制' should rank top.",
    initialWiki: {
      "wiki/attention-zh.md": page(
        "注意力机制",
        "注意力机制是 Transformer 架构的核心组件之一。",
      ),
      "wiki/unrelated-zh.md": page(
        "无关页面",
        "这个页面讨论别的话题，比如天气和足球。",
      ),
    },
    query: "注意力机制",
    expected: {
      topResultPaths: ["wiki/attention-zh.md"],
      excludedPaths: ["wiki/unrelated-zh.md"],
    },
  },

  // 4. multi-token-ranking — more matches ranks higher
  {
    name: "multi-token-ranking",
    description:
      "Query 'attention transformer'. The page mentioning BOTH terms " +
      "should outrank pages mentioning only one.",
    initialWiki: {
      "wiki/combined.md": page(
        "Attention and Transformer",
        "The transformer architecture is built around attention. " +
          "Attention weights tokens; transformer stacks attention layers.",
      ),
      "wiki/only-attn.md": page("Attention", "Attention is a weighting mechanism."),
      "wiki/only-trans.md": page("Transformer", "Stacks of layers form the transformer."),
    },
    query: "attention transformer",
    expected: {
      topResultPaths: ["wiki/combined.md"],
    },
  },

  // 5. stop-word-filtered — 'the' filtered, only meaningful tokens used
  {
    name: "stop-word-filtered",
    description:
      "Query 'the attention' should be tokenized to ['attention'] since " +
      "'the' is a stop-word. The page about attention should still match.",
    initialWiki: {
      "wiki/attention.md": page("Attention", "Attention over keys and values."),
      "wiki/other.md": page("Other", "This page uses the word 'the' often but " +
        "otherwise covers cats, dogs, weather, and the sky."),
    },
    query: "the attention",
    expected: {
      topResultPaths: ["wiki/attention.md"],
      // 'other' uses "the" a lot but should be filtered out and not rank top
    },
  },
]
