# 知识图谱关联度计算与 Chat 智能检索

> 架构设计文档 | 2026-04-08

## 1. 背景

当前 Chat 检索的问题：
- 搜索用整句子字符串匹配（`includes`），不拆词，召回率低
- 只返回直接匹配的页面，不利用已有的 `[[wikilink]]` 关系网络
- 无总量控制，可能超出 LLM 上下文窗口
- 知识图谱数据完全没有参与检索

目标：利用图谱的关系数据做"关系扩展搜索"，并通过 token 预算控制发送给 LLM 的内容总量。

## 2. 关联度计算模型

### 2.1 设计原则

- 适配当前规模（几十到几百个 wiki 页面）
- 不引入外部依赖（不需要向量数据库或图数据库）
- 利用我们系统的独有信号（`sources[]` frontmatter）
- 计算在前端 TypeScript 中完成（不需要 Rust 侧参与）

### 2.2 四维信号模型

```
relevance(A, B) = w1 × directLink + w2 × sourceOverlap + w3 × commonNeighbors + w4 × typeAffinity
```

#### 信号 1: 直接链接（权重 3.0）

最强信号。A 的内容中出现 `[[B]]` 表示作者（LLM）认为它们直接相关。

```typescript
// A → B 方向的链接次数
const forwardLinks = countWikilinks(pageA.content, pageB.id) // 0, 1, 2, ...
// B → A 方向的链接次数
const backwardLinks = countWikilinks(pageB.content, pageA.id)
// 双向引用比单向更强
const directLink = forwardLinks * 3.0 + backwardLinks * 3.0
```

#### 信号 2: 来源重叠（权重 4.0）

**我们系统的独特优势**。每个 wiki 页面的 frontmatter 记录了 `sources: ["原始文件名"]`。两个页面来自同一篇上传文档，几乎一定高度相关。

```typescript
// A 和 B 的 sources 字段的交集
const sharedSources = intersection(pageA.sources, pageB.sources)
const sourceOverlap = sharedSources.length * 4.0
```

例如：`anthropic.md` 和 `distillation.md` 都有 `sources: ["2603.25723v1.pdf"]`，来源重叠 = 4.0。

#### 信号 3: 共同邻居（Adamic-Adar 变体，权重 1.5）

如果 A 和 B 都链接到同一个节点 C，它们可能相关。但如果 C 是一个"热门"节点（被很多页面链接），这个信号弱一些；如果 C 是"冷门"节点，信号更强。

```typescript
const commonNeighbors = getCommonNeighbors(A, B)
const adamicAdar = commonNeighbors.reduce((sum, neighbor) => {
  const degree = getNodeDegree(neighbor) // 邻居的总链接数
  return sum + 1 / Math.log(Math.max(degree, 2))
}, 0)
const commonNeighborScore = adamicAdar * 1.5
```

#### 信号 4: 类型亲和力（权重 1.0）

不同类型的页面之间有不同的默认亲和度：

```typescript
const TYPE_AFFINITY: Record<string, Record<string, number>> = {
  entity: { concept: 1.2, entity: 0.8, source: 1.0, synthesis: 1.0 },
  concept: { entity: 1.2, concept: 0.8, source: 1.0, synthesis: 1.2 },
  source: { entity: 1.0, concept: 1.0, source: 0.5, query: 0.8 },
  query: { concept: 1.0, entity: 0.8, synthesis: 1.0, source: 0.8 },
  synthesis: { concept: 1.2, entity: 1.0, source: 1.0, query: 1.0 },
}
```

### 2.3 综合分数

```typescript
function calculateRelevance(A: WikiPage, B: WikiPage, graph: GraphData): number {
  const directLink = countDirectLinks(A, B) * 3.0
  const sourceOverlap = countSourceOverlap(A, B) * 4.0
  const commonNeighborScore = adamicAdarScore(A, B, graph) * 1.5
  const typeAffinity = getTypeAffinity(A.type, B.type) * 1.0
  
  return directLink + sourceOverlap + commonNeighborScore + typeAffinity
}
```

## 3. Chat 智能检索流程

### 3.1 新流程（替代当前的简单搜索）

```
用户输入问题
    ↓
┌── Phase 1: 关键词搜索 ───────────────────────────┐
│  ① 拆词：把问题拆成关键词（空格 + 中文分词）      │
│  ② 搜索 wiki/ 和 raw/sources/                    │
│  ③ 匹配方式：任意关键词命中即算匹配               │
│  ④ 按命中关键词数排序                             │
│  ⑤ 返回 top 10 候选                              │
└──────────────────────────────────────────────────┘
    ↓
┌── Phase 2: 图谱关系扩展（1 级）─────────────────┐
│  对 Phase 1 命中的每个页面：                      │
│  ① 从图谱中获取直接邻居                          │
│  ② 计算每个邻居与命中页面的关联度分数             │
│  ③ 取 top 3 关联度最高的邻居作为扩展候选          │
│  ④ 去重（已在 Phase 1 中的不重复加入）            │
└──────────────────────────────────────────────────┘
    ↓
┌── Phase 3: Token 预算控制 ───────────────────────┐
│                                                   │
│  总预算：30,000 字符（约 10,000 tokens）          │
│                                                   │
│  优先级队列（按优先级逐个加入直到预算用完）：      │
│  P0: 搜索直接命中（标题匹配）                     │
│  P1: 搜索直接命中（内容匹配）                     │
│  P2: 图谱扩展（按关联度降序）                     │
│  P3: overview.md（fallback）                      │
│                                                   │
│  每个页面：                                       │
│  - 大文件截断到 8,000 字符                        │
│  - 累计字符数超预算 → 停止添加                    │
│                                                   │
└──────────────────────────────────────────────────┘
    ↓
┌── Phase 4: 组装 System Prompt ───────────────────┐
│  固定部分：                                       │
│  - 规则指令                  ~500 字符            │
│  - purpose.md               ~500 字符            │
│  - wiki/index.md            ~1000 字符           │
│                                                   │
│  动态部分（受预算控制）：                          │
│  - [1] 直接命中页面 A       ~3000 字符           │
│  - [2] 直接命中页面 B       ~2000 字符           │
│  - [3] 关联扩展页面 C       ~4000 字符           │
│  - [4] 关联扩展页面 D       ~2000 字符           │
│  - ...直到预算用完                                │
│                                                   │
│  对话历史预算：              ~5000 字符           │
│  - 最近 N 轮对话（从新到旧，超预算截断旧的）      │
│                                                   │
│  预留 LLM 回答空间：        ~4000 tokens          │
└──────────────────────────────────────────────────┘
```

### 3.2 关键词搜索改进

当前问题：整句匹配（`"什么是知识管理"` 不会匹配含 `"知识"` 的页面）

改进：拆词后逐词匹配

```typescript
function tokenizeQuery(query: string): string[] {
  // 英文：按空格拆
  // 中文：按字符 bigram 或简单的标点分割
  // 去掉停用词：的、是、什么、the、is、what 等
  const tokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）\(\)]+/)
    .filter(t => t.length > 1)  // 去掉单字符
    .filter(t => !STOP_WORDS.has(t))
  
  return tokens
}

function searchScore(content: string, tokens: string[]): number {
  const lower = content.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lower.includes(token)) score += 1
  }
  return score  // 命中越多词分越高
}
```

### 3.3 配置参数

```typescript
interface RetrievalConfig {
  // 搜索
  maxSearchResults: 10          // Phase 1 最大候选数
  
  // 图谱扩展
  graphExpansionDepth: 1        // 扩展级数（只看直接邻居）
  maxNeighborsPerNode: 3        // 每个节点最多扩展 3 个邻居
  minRelevanceScore: 2.0        // 关联度低于此值不扩展
  
  // Token 预算
  totalContentBudget: 30000     // 页面内容总预算（字符）
  maxPageSize: 8000             // 单页面最大字符数
  conversationBudget: 5000      // 对话历史预算（字符）
  
  // 信号权重
  weights: {
    directLink: 3.0
    sourceOverlap: 4.0
    commonNeighbor: 1.5
    typeAffinity: 1.0
  }
}
```

## 4. 数据结构

### 4.1 图谱缓存

```typescript
interface GraphCache {
  nodes: Map<string, {
    id: string
    title: string
    type: string
    path: string
    sources: string[]         // frontmatter sources 字段
    outLinks: Set<string>     // 出链目标 id
    inLinks: Set<string>      // 入链来源 id
  }>
  
  // 预计算的关联度矩阵（lazy，按需计算并缓存）
  relevanceCache: Map<string, Map<string, number>>
}
```

图谱缓存在内存中，`dataVersion` 变化时重建。

### 4.2 与现有 wiki-graph.ts 的关系

现有 `buildWikiGraph()` 返回 `{ nodes, edges }`，用于图谱可视化。新的检索系统需要更丰富的数据（sources 字段、入链/出链集合），因此需要一个增强版的图谱构建函数：

```typescript
// 现有：用于可视化
function buildWikiGraph(projectPath): { nodes: GraphNode[], edges: GraphEdge[] }

// 新增：用于检索
function buildRetrievalGraph(projectPath): GraphCache
```

## 5. 实现计划

### 阶段 1: 关联度计算引擎
- 创建 `src/lib/graph-relevance.ts`
- 实现四维信号模型
- 实现 `buildRetrievalGraph()`
- 关联度缓存机制

### 阶段 2: 搜索改进
- 改进 `src/lib/search.ts` 的搜索算法
- 拆词搜索替代整句匹配
- 按命中词数评分排序

### 阶段 3: Chat 检索整合
- 修改 `src/components/chat/chat-panel.tsx` 的 `handleSend`
- 实现 Phase 1-4 的完整检索流程
- Token 预算控制
- 图谱扩展搜索

### 阶段 4: 可视化增强
- Graph View 中边的粗细反映关联度
- 节点悬浮显示 "最相关的 5 个页面"
- Chat 引用的页面在图谱中高亮

## 6. 行业对标

| 系统 | 关联度算法 | 我们的对应 |
|------|-----------|-----------|
| Google Knowledge Graph | Personalized PageRank + 知识三元组 | 四维信号模型（更轻量） |
| Neo4j 推荐引擎 | Adamic-Adar + 路径距离 | 信号 3（共同邻居）|
| Wikipedia | 链接共现 + 分类层级 | 信号 1（直接链接）+ 信号 4（类型亲和） |
| RAG 系统 | 向量相似度 | 信号 2（来源重叠）替代向量搜索 |
| 我们的独有优势 | — | 信号 2（sources[] 字段）—— 精确的文档来源追溯 |
