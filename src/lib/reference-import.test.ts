import { describe, expect, it } from "vitest"
import { extractReferenceTitles } from "@/lib/reference-import"

describe("extractReferenceTitles", () => {
  it("extracts quoted and plain titles from a references section", () => {
    const content = [
      "# Paper",
      "",
      "## References",
      "",
      "[1] OpenAI. 2023. \"GPT-4 Technical Report.\" arXiv preprint arXiv:2303.08774.",
      "[2] Achiam, J., et al. 2023. GPT-4V(ision) system card. OpenAI.",
      "[3] Vaswani, A. et al. 2017. Attention Is All You Need. In Advances in Neural Information Processing Systems.",
    ].join("\n")

    expect(extractReferenceTitles(content).map((item) => item.title)).toEqual([
      "GPT-4 Technical Report",
      "GPT-4V(ision) system card",
      "Attention Is All You Need",
    ])
  })

  it("prefers the title line in arxiv2md-style multiline references", () => {
    const content = [
      "# Paper",
      "",
      "## References",
      "",
      "- Fan et al. [2024b]",
      "Zhiwen Fan, Jian Zhang, Wenyan Cong, Peihao Wang, Renjie Li, Kairun Wen, Shijie Zhou, Achuta Kadambi, Zhangyang Wang, Danfei Xu, et al.",
      "Large spatial model: End-to-end unposed images to semantic 3d.",
      "*Adv. Neural Inf. Process. Syst.*, 37, 2024b.",
      "",
      "- World Labs [2025]",
      "World Labs.",
      "Marble: A multimodal world model, 2025.",
      "URL [https://www.worldlabs.ai/blog/marble-world-model](https://www.worldlabs.ai/blog/marble-world-model).",
      "Blog post, November 2025.",
    ].join("\n")

    expect(extractReferenceTitles(content).map((item) => item.title)).toEqual([
      "Large spatial model: End-to-end unposed images to semantic 3d",
      "Marble: A multimodal world model",
    ])
  })
})
